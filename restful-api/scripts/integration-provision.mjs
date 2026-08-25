#!/usr/bin/env bun
// Provisions the disposable MeshCore test database used by REST integration
// tests. Reuses the sibling broker repository's canonical schema
// implementation (openTestDatabase) so no DDL is duplicated here.
//
// Steps:
//   1. resolve the broker repo (MESHCORE_BROKER_REPO override supported)
//   2. recreate the `meshcore` database inside the test PostgreSQL container
//   3. initialize the canonical private/public schemas + stored fingerprint
//      through the broker's own ApplicationDatabase test bootstrap
//   4. grant the production-like read-only `meshcore_http` role access
//   5. load the deterministic REST fixture through the broker's real
//      MqttHistoryService ingest pipeline
import path from "node:path";
import fs from "node:fs";
import pg from "pg";

const SUPERUSER_URL =
  process.env.INTEGRATION_SUPERUSER_URL ??
  "postgresql://meshcore_test:meshcore_test@127.0.0.1:55432/postgres";
const HTTP_URL =
  process.env.INTEGRATION_DATABASE_URL ??
  "postgresql://meshcore_http:integration_http@127.0.0.1:55432/meshcore";
const FIXTURE_FILE = path.resolve(
  import.meta.dirname,
  "../tests/integration/rest-fixture.json",
);

function resolveBrokerRepo() {
  const candidate = path.resolve(
    process.env.MESHCORE_BROKER_REPO ??
      path.join(import.meta.dirname, "..", "..", "..", "meshcore-mqtt-broker"),
  );
  const manifest = path.join(candidate, "package.json");
  if (!fs.existsSync(manifest)) {
    console.error(
      `[integration] broker repo not found at ${candidate}. Set MESHCORE_BROKER_REPO to the meshcore-mqtt-broker checkout.`,
    );
    process.exit(2);
  }
  return candidate;
}

async function recreateDatabase(superuser) {
  await superuser.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'meshcore' AND pid <> pg_backend_pid()",
  );
  await superuser.query("DROP DATABASE IF EXISTS meshcore");
  await superuser.query("CREATE DATABASE meshcore");
  // Same extension prerequisites the broker's initdb asset verifies.
  const inMeshcore = new pg.Pool({
    connectionString: SUPERUSER_URL.replace(/\/postgres$/, "/meshcore"),
    max: 1,
  });
  try {
    await inMeshcore.query("CREATE EXTENSION IF NOT EXISTS postgis");
    await inMeshcore.query("CREATE EXTENSION IF NOT EXISTS timescaledb");
  } finally {
    await inMeshcore.end();
  }
}

async function provisionRoles(superuser) {
  // Mirrors production role policy from the broker's initdb asset without
  // duplicating schema DDL: read-only HTTP role with bounded timeouts.
  await superuser.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meshcore_http') THEN
        CREATE ROLE meshcore_http;
      END IF;
    END $$;
  `);
  await superuser.query(
    "ALTER ROLE meshcore_http LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'integration_http'",
  );
  await superuser.query(
    "ALTER ROLE meshcore_http SET default_transaction_read_only = on",
  );
  await superuser.query("ALTER ROLE meshcore_http SET statement_timeout = '5s'");
}

async function grantHttpReadAccess(admin) {
  await admin.query("GRANT USAGE ON SCHEMA meshcore_public TO meshcore_http");
  await admin.query(
    "GRANT SELECT ON ALL TABLES IN SCHEMA meshcore_public TO meshcore_http",
  );
}

async function main() {
  const brokerRepo = resolveBrokerRepo();
  const superuser = new pg.Pool({ connectionString: SUPERUSER_URL, max: 2 });
  try {
    await recreateDatabase(superuser);
    await provisionRoles(superuser);
  } finally {
    await superuser.end();
  }

  const brokerUrl = (relative) =>
    `file://${path.join(brokerRepo, relative.split("/").join(path.sep))}`;
  const { openTestDatabase } = await import(brokerUrl("src/database.ts"));
  const { MqttHistoryService } = await import(brokerUrl("src/mqtt-history.ts"));
  const { DefaultMeshCorePacketDecoder } = await import(
    brokerUrl("src/meshcore-packet-decoder.ts")
  );

  const database = await openTestDatabase({
    connectionString: HTTP_URL.replace(/\/\/[^@]*@/, "//meshcore_test:meshcore_test@"),
    schema: "meshcore_private",
  });

  const admin = new pg.Pool({
    connectionString: HTTP_URL.replace(/\/\/[^@]*@/, "//meshcore_test:meshcore_test@"),
    max: 2,
    options: "-c search_path=meshcore_private,meshcore_public",
  });

  let clock = 1_800_000_000_000;
  const service = new MqttHistoryService(database, {
    retentionDays: 30,
    cleanupIntervalMinutes: 60,
    cleanupBatchSize: 100,
    storeInternal: false,
    storeSerial: false,
  }, "rest-integration-fixture", {
    decoder: new DefaultMeshCorePacketDecoder(),
    now: () => clock,
    startLoops: false,
  });
  await service.start();

  const fixture = JSON.parse(fs.readFileSync(FIXTURE_FILE, "utf8"));
  try {
    for (const entry of fixture.cases) {
      const payload = entry.payload_text ?? {
        origin_id: entry.observer,
        ...(entry.payload ?? {}),
      };
      await service.capturePublish({
        topic: `meshcore/${entry.iata}/${entry.observer}/${entry.subtopic}`,
        payload: Buffer.from(
          typeof payload === "string" ? payload : JSON.stringify(payload),
          "utf8",
        ),
        qos: 0,
        retain: Boolean(entry.retain),
        dup: false,
      });
      clock += Number(entry.tick ?? 1);
    }
    await service.drain();

    await grantHttpReadAccess(admin);
    const counts = await admin.query(`
      SELECT
        (SELECT count(*) FROM meshcore_private.mqtt_events) AS events,
        (SELECT count(*) FROM meshcore_public.nodes) AS nodes,
        (SELECT count(*) FROM meshcore_public.observers) AS observers,
        (SELECT count(*) FROM meshcore_public.messages) AS messages,
        (SELECT count(*) FROM meshcore_public.packets) AS packets,
        (SELECT count(*) FROM meshcore_public.packet_observations) AS observations,
        (SELECT count(*) FROM meshcore_public.traces) AS traces,
        (SELECT count(*) FROM meshcore_public.telemetry) AS telemetry
    `);
    console.log("[integration] fixture counts:", counts.rows[0]);
  } finally {
    await service.stop().catch(() => undefined);
    await admin.end();
    await database.close();
  }
}

await main();
