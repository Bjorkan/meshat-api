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
import { PostgresMeshcoreRepository } from "../src/repository.ts";

const here = import.meta.dirname;
const brokerRepo = path.resolve(
  process.env.MESHCORE_BROKER_REPO ?? path.join(here, "..", "..", "..", "meshcore-mqtt-broker"),
);
if (!fs.existsSync(path.join(brokerRepo, "compose.test.yaml"))) {
  console.error(`[perf] broker repo not found at ${brokerRepo}. Set MESHCORE_BROKER_REPO.`);
  process.exit(2);
}

const VARIANTS_PER_LOGICAL = 3;

// Strictly bounded integer scales: free text must never reach SQL (§ perf-env
// contract). Values stay internal to this disposable-database admin script.
const SCALE_LIMITS = {
  PERF_SCALE_OBSERVATIONS: { fallback: 100_000, max: 2_000_000 },
  PERF_SCALE_MESSAGES: { fallback: 20_000, max: 400_000 },
  PERF_SCALE_TELEMETRY: { fallback: 100_000, max: 2_000_000 },
  PERF_SCALE_OBSERVERS: { fallback: 120, max: 5_000 },
} as const;

function resolveScale(name: keyof typeof SCALE_LIMITS): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return SCALE_LIMITS[name].fallback;
  const value = Number(raw);
  const { max } = SCALE_LIMITS[name];
  if (!Number.isInteger(value) || !Number.isFinite(value) || value <= 0 || value > max) {
    console.error(`[perf] ${name} must be an integer in [1, ${max}], got "${raw}".`);
    process.exit(2);
  }
  return value;
}

const OBS = resolveScale("PERF_SCALE_OBSERVATIONS");
const LOGICAL = resolveScale("PERF_SCALE_MESSAGES");
const TELEMETRY = resolveScale("PERF_SCALE_TELEMETRY");
const OBSERVERS = resolveScale("PERF_SCALE_OBSERVERS");

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
      if (typeof node["Node Type"] === "string") collected.push(node["Node Type"] as string);
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walk(child);
    };
    if (root) walk(root);
  } catch {
    // ignore
  }
  return collected;
}

/**
 * Statelessness-proof cursor walk over telemetry using the real repository
 * keyset implementation: bounded window, both directions, no duplicates,
 * no gaps, deterministic termination. Values are internal constants only.
 */
async function verifyTelemetryCursorPaging(admin: SQL): Promise<void> {
  const url = new URL(
    process.env.INTEGRATION_DATABASE_URL ??
      "postgresql://meshcore_http:integration_http@127.0.0.1:55432/meshcore",
  );
  const repoDb = new SQL({
    hostname: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.slice(1),
    username: decodeURIComponent(url.username || "meshcore_http"),
    password: decodeURIComponent(url.password || "integration_http"),
    max: 2,
  });
  try {
    const repository = new PostgresMeshcoreRepository(repoDb);
    const base = 1_800_000_000_000;
    const from = base + 1;
    const to = base + Math.min(TELEMETRY, 800);
    const counted = (await admin`
      SELECT count(*)::int AS n FROM meshcore_public.telemetry
      WHERE received_at_ms BETWEEN ${from} AND ${to}`) as Array<{ n: number }>;
    const expected = Number(counted[0]?.n);
    for (const order of ["desc", "asc"] as const) {
      let after: [string, string] | undefined = undefined;
      const seen = new Set<string>();
      let pages = 0;
      let previousMs = order === "desc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      for (;;) {
        const page = await repository.listTelemetry({
          filters: { receivedFrom: from, receivedTo: to },
          sort: "received_at",
          order,
          limit: 100,
          ...(after === undefined ? {} : { after }),
        });
        pages += 1;
        if (!Array.isArray(page.items)) throw new Error(`page items missing (${order})`);
        for (const item of page.items as Array<{ id: string; received_at: string }>) {
          if (seen.has(item.id)) throw new Error(`duplicate telemetry id ${item.id} (${order})`);
          seen.add(item.id);
          const ms = Date.parse(item.received_at);
          if (order === "desc" ? ms > previousMs : ms < previousMs)
            throw new Error(`cursor ordering violation at ${order} page ${pages}`);
          previousMs = ms;
        }
        if (!page.hasMore) break;
        after = page.nextKey ?? undefined;
        if (!after) throw new Error(`hasMore without nextKey (${order})`);
        if (pages > 5000) throw new Error(`pagination did not terminate (${order})`);
      }
      if (seen.size !== expected)
        throw new Error(`gap detected: walked ${seen.size}, expected ${expected} (${order})`);
      console.log(
        `[perf] telemetry cursor paging ${order}: ${pages} page(s), ${seen.size}/${expected} rows, no gaps/duplicates`,
      );
    }
  } finally {
    await repoDb.close({ timeout: 1 });
  }
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

  console.log(
    `[perf] bun ${Bun.version}; scale observations=${OBS} logical_messages=${LOGICAL} telemetry=${TELEMETRY} observers=${OBSERVERS}`,
  );
  const pgVersion = await admin`SHOW server_version`;
  console.log("[perf] postgresql", pgVersion[0]?.server_version);

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
    await admin.unsafe("ANALYZE meshcore_public." + table);

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

  // AFTER: create the v10 timeline indexes.
  await admin`CREATE INDEX IF NOT EXISTS public_telemetry_received ON meshcore_public.telemetry (received_at_ms DESC, id DESC)`;
  await admin`CREATE INDEX IF NOT EXISTS public_messages_received ON meshcore_public.messages (received_at_ms DESC, id DESC)`;
  await admin`CREATE INDEX IF NOT EXISTS public_observers_last_seen ON meshcore_public.observers (last_seen_at_ms DESC, public_key)`;
  await admin`ANALYZE meshcore_public.telemetry`;
  await admin`ANALYZE meshcore_public.messages`;
  await admin`ANALYZE meshcore_public.observers`;
  await admin`ANALYZE meshcore_public.packet_observations`;

  const after: Record<string, { median: number; nodes: string[]; plan?: unknown }> = {};
  for (const [label, query] of queries) {
    const { median, plan } = await measure(label, query);
    after[label] = { median, nodes: planNodes(plan), plan };
  }
  const telemetryAfterPlan = JSON.stringify(after["telemetry-keyset-desc"]?.plan ?? "");

  console.log("[perf] verifying telemetry cursor pagination (asc+desc)...");
  await verifyTelemetryCursorPaging(admin);

  console.log("\\n=== summary (medians, ms) ===");
  for (const [label] of queries) {
    const b = before[label]?.median ?? -1;
    const a = after[label]?.median ?? -1;
    const delta = b > 0 ? Math.round(((a - b) / b) * 100) : 0;
    console.log(
      `${label.padEnd(24)} before=${String(b).padStart(6)}  after=${String(a).padStart(6)}  (${delta > 0 ? "+" : ""}${delta}%)`,
    );
    const nodes = after[label]?.nodes ?? [];
    console.log(`  plan: ${nodes.length ? nodes.join(" -> ") : "(unavailable)"}`);
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
