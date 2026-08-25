#!/usr/bin/env bun
// Performance profiling harness for the heavy public REST queries.
//
// Starts the disposable PostgreSQL database, provisions the canonical
// MeshCore schema, generates a deterministic set-based dataset at a
// configurable scale, runs representative repository queries with median
// timings plus EXPLAIN (ANALYZE, FORMAT JSON), and prints an index
// before/after comparison for the v10 timeline indexes. Cleans up always.
//
// Env:
//   PERF_SCALE_OBSERVATIONS (default 100000)
//   PERF_SCALE_MESSAGES     (default 20000 logical messages -> ~60k message rows)
//   PERF_SCALE_TELEMETRY    (default 100000)
//   PERF_SCALE_OBSERVERS    (default 120)
import path from "node:path";
import fs from "node:fs";
import { SQL } from "bun";

const here = import.meta.dirname;
const brokerRepo = path.resolve(
  process.env.MESHCORE_BROKER_REPO ?? path.join(here, "..", "..", "..", "meshcore-mqtt-broker"),
);
if (!fs.existsSync(path.join(brokerRepo, "compose.test.yaml"))) {
  console.error(`[perf] broker repo not found at ${brokerRepo}. Set MESHCORE_BROKER_REPO.`);
  process.exit(2);
}

const OBS = Number(process.env.PERF_SCALE_OBSERVATIONS ?? 100_000);
const LOGICAL = Number(process.env.PERF_SCALE_MESSAGES ?? 20_000);
const TELEMETRY = Number(process.env.PERF_SCALE_TELEMETRY ?? 100_000);
const OBSERVERS = Number(process.env.PERF_SCALE_OBSERVERS ?? 120);
const VARIANTS_PER_LOGICAL = 3;

function run(command: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync({
    cmd: command,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
  return result.exitCode ?? 1;
}

type ExplainPlan = Record<string, unknown>;

async function medianMs(
  sql: SQL,
  query: string,
): Promise<{ median: number; plan: ExplainPlan | undefined }> {
  const runs: number[] = [];
  let plan: ExplainPlan | undefined;
  for (let index = 0; index < 7; index += 1) {
    const started = performance.now();
    const explained = (await sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
    )) as unknown as Array<{ "QUERY PLAN": any }>;
    runs.push(performance.now() - started);
    if (index === 0)
      plan = (explained as unknown as Array<{ "QUERY PLAN": ExplainPlan }>)[0]?.["QUERY PLAN"];
  }
  runs.sort((a, b) => a - b);
  return { median: Math.round(runs[3]), plan };
}

function planNodes(plan: unknown): string[] {
  const collected: string[] = [];
  try {
    const parsed = JSON.parse(JSON.stringify(plan));
    const root = Array.isArray(parsed) ? parsed[0]?.Plan : null;
    const walk = (node: Record<string, unknown>) => {
      if (!node || typeof node !== "object") return;
      if (typeof node["Node Type"] === "string")
        collected.push(node["Node Type"] as string);
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>)
        walk(child);
    };
    if (root) walk(root);
  } catch {
    // ignore
  }
  return collected;
}

async function main() {
  if (run(["bun", [path.join(brokerRepo, "scripts/test-db-up.mjs")]]) !== 0) {
    process.exitCode = 1;
    return;
  }

  const provision = Bun.spawnSync({
    cmd: ["bun", path.join(here, "integration-provision.mjs")],
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, MESHCORE_BROKER_REPO: brokerRepo },
  });
  if (provision.exitCode !== 0) {
    process.exitCode = 1;
    return;
  }

  const adminUrl =
    process.env.INTEGRATION_DATABASE_URL ??
    "postgresql://meshcore_http:integration_http@127.0.0.1:55432/meshcore";
  const parsed = new URL(adminUrl);
  const admin = new SQL({
    hostname: parsed.hostname,
    port: Number(parsed.port || 5432),
    database: parsed.pathname.slice(1),
    username: "meshcore_test",
    password: "meshcore_test",
    max: 2,
  });

  console.log("[perf] generating deterministic dataset...");
  await admin`SELECT setval('meshcore_public.observers_id_seq', 1000)`.catch(() => undefined);
  // Set-based generation with inlined internal constants (no user input);
  // sql.unsafe avoids bind-parameter type inference issues in bulk DDL.
  const unsafe = (text: string) => admin.unsafe(text);

  await admin.unsafe(`INSERT INTO meshcore_public.observers(private_id, public_key,
      active, iata, first_seen_at_ms, last_seen_at_ms, updated_at_ms)
    SELECT g + 1000000, repeat('a', 62) || lpad(to_hex(g), 2, '0'), true,
      (ARRAY['JKG','GOT','GSE','STO'])[1 + (g % 4)],
      1800000000000, 1800100000000 + g, 1800100000000 + g
    FROM generate_series(1, ${OBSERVERS}) g`);
  await admin.unsafe(`INSERT INTO meshcore_private.meshcore_io_stats(singleton)
    VALUES (1) ON CONFLICT DO NOTHING`);

  await admin.unsafe(`INSERT INTO meshcore_public.packets(private_id, packet_sha256,
      raw_packet_blob, logical_packet_id, packet_type, payload_type,
      route_type, decode_status, first_seen_at_ms, last_seen_at_ms)
    SELECT g + 2000000, lpad(to_hex(g), 63, '0'), '\\x00'::bytea,
      'lp_' || lpad(to_hex((g / ${VARIANTS_PER_LOGICAL})::int), 61, '0'),
      'TXT_MSG', 'GROUPTEXT', 'FLOOD', 'decoded',
      1800000000000 + g, 1800000000000 + g
    FROM generate_series(1, ${LOGICAL * VARIANTS_PER_LOGICAL}) g`);

  await admin.unsafe(`INSERT INTO meshcore_public.packet_observations(private_id,
      packet_sha256, observer_public_key, iata, received_at_ms,
      suspected_mqtt_duplicate, suspected_rf_retransmission)
    SELECT g + 3000000,
      lpad(to_hex(((g - 1) % (${LOGICAL * VARIANTS_PER_LOGICAL})) + 1), 63, '0'),
      repeat('a', 62) || lpad(to_hex(1 + (g % ${OBSERVERS})), 2, '0'),
      (ARRAY['JKG','GOT','GSE','STO'])[1 + (g % 4)],
      1800000000000 + (g % 86400000), false, false
    FROM generate_series(1, ${OBS}) g`);

  await admin.unsafe(`INSERT INTO meshcore_public.messages(private_id, packet_sha256,
      packet_observation_id, message_type, encrypted, text, reported_at_ms,
      received_at_ms)
    SELECT po.id + 4000000, po.packet_sha256, po.id, 'TXT_MSG', false,
      'msg ' || po.id::text, po.received_at_ms - 10, po.received_at_ms
    FROM meshcore_public.packet_observations po
    WHERE po.id > 100
    LIMIT ${LOGICAL * VARIANTS_PER_LOGICAL}`);

  // Telemetry requires a packet observation FK; create one per row first.
  await admin.unsafe(`INSERT INTO meshcore_public.packets(private_id, packet_sha256,
      raw_packet_blob, packet_type, decode_status, first_seen_at_ms,
      last_seen_at_ms)
    SELECT g + 7000000, lpad(to_hex(g + 6000000), 63, '0'), '\\x00'::bytea,
      'RESPONSE', 'decoded', 1800000000000 + g, 1800000000000 + g
    FROM generate_series(1, ${TELEMETRY}) g`);
  await admin.unsafe(`INSERT INTO meshcore_public.packet_observations(private_id,
      packet_sha256, observer_public_key, iata, received_at_ms,
      suspected_mqtt_duplicate, suspected_rf_retransmission)
    SELECT g + 6000000, lpad(to_hex(g + 6000000), 63, '0'),
      repeat('a', 62) || lpad(to_hex(1 + (g % ${OBSERVERS})), 2, '0'),
      (ARRAY['JKG','GOT','GSE','STO'])[1 + (g % 4)],
      1800000000000 + g, false, false
    FROM generate_series(1, ${TELEMETRY}) g`);
  await admin.unsafe(`INSERT INTO meshcore_public.telemetry(private_id, packet_sha256,
      packet_observation_id, node_public_key, metric_name, numeric_value,
      unit, received_at_ms)
    SELECT po.private_id - 1000000, po.packet_sha256, po.id,
      NULL, 'battery', 3.5 + (po.private_id % 100)::float8 / 10,
      'V', po.received_at_ms
    FROM meshcore_public.packet_observations po
    WHERE po.private_id BETWEEN 6000001 AND ${6000000 + String(TELEMETRY)}`);

  console.log("[perf] ANALYZE public tables...");
  for (const table of ["messages", "telemetry", "packet_observations", "packets", "observers"])
    await admin.unsafe('ANALYZE meshcore_public.' + table);

  const queries: Array<[string, string]> = [
    [
      "stats",
      `SELECT
      (SELECT count(*)::text FROM meshcore_public.nodes) AS known_nodes,
      (SELECT count(*)::text FROM meshcore_public.nodes WHERE last_seen_at_ms >= 1799136000000) AS active_nodes,
      (SELECT count(*)::text FROM meshcore_public.observers) AS known_observers,
      (SELECT count(*)::text FROM meshcore_public.observers WHERE last_seen_at_ms >= 1800097000000) AS active_observers,
      (SELECT count(*)::text FROM meshcore_public.region_scopes) AS configured_regions,
      (SELECT count(*)::text FROM meshcore_public.region_scopes WHERE observation_count > 0) AS observed_regions,
      (SELECT count(DISTINCT iata)::text FROM meshcore_public.packet_observations WHERE received_at_ms >= 1799136000000) AS active_iata,
      (SELECT count(DISTINCT packet_sha256)::text FROM meshcore_public.packet_observations WHERE received_at_ms >= 1799136000000) AS packets_24h,
      (SELECT count(DISTINCT COALESCE(packet.logical_packet_id, message.packet_sha256))::text
        FROM meshcore_public.messages message
        JOIN meshcore_public.packets packet ON packet.packet_sha256 = message.packet_sha256
        WHERE message.received_at_ms >= 1799136000000) AS messages_24h,
      (SELECT max(received_at_ms)::text FROM meshcore_public.packet_observations) AS last_seen_at_ms`,
    ],
    [
      "telemetry-keyset-desc",
      `SELECT id, received_at_ms FROM meshcore_public.telemetry ORDER BY received_at_ms DESC, id DESC LIMIT 50`,
    ],
    [
      "activity-24h-1h",
      `SELECT
      (floor(observation.received_at_ms / 3600000::numeric) * 3600000::numeric)::bigint AS bucket,
      count(*)::text AS observations,
      count(DISTINCT observation.packet_sha256)::text AS packets,
      count(DISTINCT COALESCE(packet.logical_packet_id, message.packet_sha256))::text AS messages
      FROM meshcore_public.packet_observations observation
      LEFT JOIN meshcore_public.messages message ON message.packet_observation_id = observation.id
      LEFT JOIN meshcore_public.packets packet ON packet.packet_sha256 = message.packet_sha256
      WHERE observation.received_at_ms >= 1799961600000 AND observation.received_at_ms <= 1800048000000
      GROUP BY bucket ORDER BY bucket`,
    ],
    // Narrow-first messages pipeline (current implementation shape)
    [
      "messages-narrow",
      `WITH matches AS (
        SELECT COALESCE(p.logical_packet_id, m.packet_sha256) AS logical_id,
          m.packet_observation_id, o.iata AS oiata, o.received_at_ms AS oms
        FROM meshcore_public.messages m
        JOIN meshcore_public.packet_observations o ON o.id = m.packet_observation_id
        JOIN meshcore_public.packets p ON p.packet_sha256 = m.packet_sha256
      ), matched_summary AS (
        SELECT logical_id, count(DISTINCT packet_observation_id)::text AS c, array_agg(DISTINCT oiata) AS mi
        FROM matches GROUP BY logical_id
      ), canonical_narrow AS (
        SELECT COALESCE(p.logical_packet_id, m.packet_sha256) AS logical_id,
          m.packet_observation_id, o.iata AS oiata, o.received_at_ms AS oms
        FROM meshcore_public.messages m
        JOIN meshcore_public.packet_observations o ON o.id = m.packet_observation_id
        JOIN meshcore_public.packets p ON p.packet_sha256 = m.packet_sha256
        WHERE COALESCE(p.logical_packet_id, m.packet_sha256) IN (SELECT logical_id FROM matched_summary)
      ), summary AS (
        SELECT logical_id, min(oms)::text AS fr, max(oms)::text AS lr,
          count(DISTINCT packet_observation_id)::text AS tc,
          array_agg(DISTINCT oiata) AS ai
        FROM canonical_narrow GROUP BY logical_id
      ), rep_key AS (
        SELECT DISTINCT ON (logical_id) logical_id, packet_observation_id
        FROM canonical_narrow ORDER BY logical_id, oms DESC, packet_observation_id DESC
      ), page_keys AS (
        SELECT s.*, r.packet_observation_id AS rep_po
        FROM summary s JOIN rep_key r USING (logical_id)
        ORDER BY s.lr DESC, s.logical_id DESC LIMIT 50
      )
      SELECT pk.logical_id, m.* FROM page_keys pk
      JOIN meshcore_public.messages m ON m.packet_observation_id = pk.rep_po`,
    ],
    // Wide baseline: previous broad-shape equivalent for comparison
    [
      "messages-wide-baseline",
      `WITH matches AS (
        SELECT ${"m.*, o.iata AS oiata, o.received_at_ms AS orms,"} p.logical_packet_id AS logical_id
        FROM meshcore_public.messages m
        JOIN meshcore_public.packet_observations o ON o.id = m.packet_observation_id
        JOIN meshcore_public.packets p ON p.packet_sha256 = m.packet_sha256
      ), summary AS (
        SELECT logical_id, min(orms)::text AS fr, max(orms)::text AS lr,
          count(DISTINCT packet_observation_id)::text AS tc, array_agg(DISTINCT oiata) AS ai
        FROM matches GROUP BY logical_id
      )
      SELECT count(*)::int AS n FROM summary`,
    ],
  ];

  async function measure(label: string, query: string) {
    const { median, plan } = await medianMs(admin, query);
    console.log(`median ${label.padEnd(24)} ${median}ms`);
    return { label, median, plan };
  }

  // BEFORE: drop v10 timeline indexes to capture legacy plans.
  await admin`DROP INDEX IF EXISTS meshcore_public.public_telemetry_received`;
  await admin`DROP INDEX IF EXISTS meshcore_public.public_messages_received`;
  await admin`DROP INDEX IF EXISTS meshcore_public.public_observers_last_seen`;

  const before: Record<string, { median: number; nodes: string[] }> = {};
  for (const [label, query] of queries) {
    const { median, plan } = await measure(label, query);
    before[label] = { median, nodes: planNodes(plan) };
  }
  const telemetryBeforePlan = JSON.stringify(before["telemetry-keyset-desc"].plan);

  // AFTER: create the v10 timeline indexes.
  await admin`CREATE INDEX IF NOT EXISTS public_telemetry_received ON meshcore_public.telemetry (received_at_ms DESC, id DESC)`;
  await admin`CREATE INDEX IF NOT EXISTS public_messages_received ON meshcore_public.messages (received_at_ms DESC, id DESC)`;
  await admin`CREATE INDEX IF NOT EXISTS public_observers_last_seen ON meshcore_public.observers (last_seen_at_ms DESC, public_key)`;
  await admin`ANALYZE meshcore_public.telemetry`;
  await admin`ANALYZE meshcore_public.messages`;
  await admin`ANALYZE meshcore_public.observers`;
  await admin`ANALYZE meshcore_public.packet_observations`;

  const after: Record<string, { median: number; nodes: string[] }> = {};
  for (const [label, query] of queries) {
    const { median, plan } = await measure(label, query);
    after[label] = { median, nodes: planNodes(plan) };
  }
  const telemetryAfterPlan = JSON.stringify(after["telemetry-keyset-desc"].plan);

  console.log("\\n=== summary (medians, ms) ===");
  for (const [label] of queries) {
    const b = before[label]?.median ?? -1;
    const a = after[label]?.median ?? -1;
    const delta = b > 0 ? Math.round(((a - b) / b) * 100) : 0;
    console.log(
      `${label.padEnd(24)} before=${String(b).padStart(6)}  after=${String(a).padStart(6)}  (${delta > 0 ? "+" : ""}${delta}%)`,
    );
  }
  console.log(
    "\\ntelemetry keyset uses timeline index after:",
    telemetryAfterPlan.includes("public_telemetry_received"),
  );
  console.log("index sizes:");
  for (const name of [
    "public_telemetry_received",
    "public_messages_received",
    "public_observers_last_seen",
  ]) {
    const size = await admin`SELECT pg_size_pretty(pg_relation_size(c.oid)) AS size, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='meshcore_public' AND c.relname = ${name}`;
    console.log(" ", size[0]?.relname, size[0]?.size);
  }
  await admin.close({ timeout: 1 });

  run(["bun", path.join(brokerRepo, "scripts/test-db-down.mjs")]);
}

await main();
