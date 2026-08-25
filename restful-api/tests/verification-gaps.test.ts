import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { loadConfig } from "../src/config.js";
import { GitDocumentationService } from "../src/docs.js";
import { aggregateNeighbors } from "../src/mappers.js";
import { PostgresMeshcoreRepository, type DatabasePool } from "../src/repository.js";
import { buildServer } from "../src/server.js";
import { FakeRepository } from "./fakes.js";
import { errorCode } from "./support.js";

class RecordingPool implements DatabasePool {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  rows: QueryResultRow[] = [];
  async query<T extends QueryResultRow>(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: this.rows as T[] };
  }
  async connect() {
    return {
      query: async <T extends QueryResultRow>(sql: string, values: unknown[] = []) =>
        this.query<T>(sql, values),
      release: () => undefined,
    };
  }
  async end() {}
}

const temporaryRoots: string[] = [];
afterEach(async () =>
  Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("remaining REST verification gaps", () => {
  it("composes the complete node PostGIS radius query with bound values", async () => {
    const pool = new RecordingPool();
    await new PostgresMeshcoreRepository(pool).listNodes({
      filters: { nearLat: 40, nearLon: -74, radiusKm: 12.5 },
      sort: "last_seen",
      order: "desc",
      limit: 25,
    });
    const call = pool.calls[0]!;
    expect(call.sql).toContain("SELECT n.public_key");
    expect(call.sql).toContain("FROM meshcore_public.nodes n");
    expect(call.sql).toContain("WHERE n.location IS NOT NULL AND public.ST_DWithin(");
    expect(call.sql).toContain(
      "public.ST_SetSRID(public.ST_MakePoint($1, $2), 4326)::public.geography",
    );
    expect(call.sql).toContain("ORDER BY n.last_seen_at_ms desc, n.public_key desc");
    expect(call.sql).toContain("LIMIT $4");
    expect(call.values).toEqual([-74, 40, 12_500, 26]);
  });

  it("filters node logical regions through self and external evidence and maps results", async () => {
    const pool = new RecordingPool();
    pool.rows = [
      {
        public_key: "A".repeat(64),
        owner_public_key: null,
        latest_name: "Region node",
        latest_role: "REPEATER",
        latest_latitude: null,
        latest_longitude: null,
        first_seen_at_ms: "1000",
        last_seen_at_ms: "2000",
        iata: ["JKG"],
        regions: ["public"],
        __sort_value: "2000",
        __cursor_id: "A".repeat(64),
      },
    ];
    const result = await new PostgresMeshcoreRepository(pool).listNodes({
      filters: { region: "public" },
      sort: "last_seen",
      order: "desc",
      limit: 10,
    });
    const call = pool.calls[0]!;
    expect(call.sql).toContain("evidence.entity_public_key = n.public_key");
    expect(call.sql).toContain("entry.neighbor_public_key AS entity_public_key");
    expect(call.sql).toContain("snapshot.observer_public_key AS entity_public_key");
    expect(call.values).toContain("public");
    expect(result.items).toMatchObject([
      {
        public_key: "A".repeat(64),
        role: "repeater",
        regions: ["public"],
      },
    ]);
  });

  it("correlates node region and IATA evidence to the same seen time window", async () => {
    const pool = new RecordingPool();
    await new PostgresMeshcoreRepository(pool).listNodes({
      filters: { region: "se13", iata: "JKG", seenFrom: 100, seenTo: 200 },
      sort: "last_seen",
      order: "desc",
      limit: 10,
    });
    const call = pool.calls[0]!;
    expect(call.sql).toContain("sighting.received_at_ms >= $");
    expect(call.sql).toContain("sighting.received_at_ms <= $");
    expect(call.sql).toContain("evidence.evidence_received_at_ms >= $");
    expect(call.sql).toContain("evidence.evidence_received_at_ms <= $");
    expect(call.sql).toContain("n.last_seen_at_ms >= $");
    expect(call.values).toContain(100);
    expect(call.values).toContain(200);
    expect(call.values).toContain("se13");
    expect(call.values).toContain("JKG");
  });

  it("classifies trace hops with at most one current candidate as unresolved", async () => {
    const pool = new RecordingPool();
    await new PostgresMeshcoreRepository(pool).listTraceHops("1");
    const call = pool.calls[0]!;
    expect(call.sql).toContain("WHEN hop.resolved_node_public_key IS NOT NULL THEN 'resolved'");
    expect(call.sql).toContain(") > 1 THEN 'ambiguous'");
    expect(call.sql).toContain("ELSE 'unresolved'");
    expect(call.sql).not.toContain("EXISTS (SELECT 1 FROM meshcore_public.node_prefix_candidates");
  });

  it("distinguishes one-way outbound, one-way inbound, and reciprocal neighbors", () => {
    const base = {
      counterpart_public_key: "B".repeat(64),
      reporting_observer: "A".repeat(64),
      received_at_ms: "1000",
      regions: ["public"],
      latest_role: "REPEATER",
    };
    expect(aggregateNeighbors([{ ...base, direction: "outbound" }])[0]).toMatchObject({
      relationship: "reported",
      direction: "outbound",
      node: { role: "repeater" },
    });
    expect(aggregateNeighbors([{ ...base, direction: "inbound" }])[0]).toMatchObject({
      relationship: "reported",
      direction: "inbound",
    });
    expect(
      aggregateNeighbors([
        { ...base, direction: "outbound" },
        {
          ...base,
          direction: "inbound",
          reporting_observer: "B".repeat(64),
        },
      ])[0],
    ).toMatchObject({
      relationship: "reciprocal",
      direction: "both",
      evidence: { report_count: 2, observer_count: 2 },
    });
  });

  it("rejects nonsensical and excessive activity window/interval combinations", async () => {
    const app = await buildServer({
      config: loadConfig({ DOCS_CACHE_DIR: "/tmp/unused-meshat-docs" }),
      repository: new FakeRepository(),
      refreshDocs: false,
      logger: false,
    });
    for (const query of ["window=1h&interval=6h", "window=30d&interval=5m"]) {
      const response = await app.inject(`/v1/meshcore/activity?${query}`);
      expect(response.statusCode, query).toBe(422);
      expect(errorCode(response)).toBe("INVALID_ARGUMENT");
    }
    await app.close();
  });

  it("keeps injection-like strings bound across every free-text SQL filter family", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresMeshcoreRepository(pool);
    const injection = "X%_' OR 1=1 --";
    await repository.listNodes({
      filters: { name: injection, role: injection, region: injection },
      sort: "last_seen",
      order: "desc",
      limit: 5,
    });
    await repository.listObservers({
      filters: { name: injection, region: injection },
      sort: "last_seen",
      order: "desc",
      limit: 5,
    });
    await repository.listPackets({
      filters: {
        packetType: injection,
        payloadType: injection,
        routeType: injection,
        decodeStatus: injection,
      },
      sort: "received_at",
      order: "desc",
      limit: 5,
    });
    await repository.listMessages({
      filters: {
        channel: injection,
        channelName: injection,
        messageType: injection,
      },
      sort: "received_at",
      order: "desc",
      limit: 5,
    });
    await repository.listTelemetry({
      filters: { metric: injection },
      sort: "received_at",
      order: "desc",
      limit: 5,
    });
    await repository.listTraces({
      filters: { tag: injection },
      sort: "received_at",
      order: "desc",
      limit: 5,
    });
    await repository.getActivity({
      fromMs: 0,
      toMs: 10_000,
      intervalMs: 3_600_000,
      iata: injection,
    });

    expect(pool.calls).toHaveLength(7);
    for (const call of pool.calls) {
      expect(call.sql).not.toContain(injection);
      expect(call.values.some((value) => String(value).includes("OR 1=1"))).toBe(true);
    }
  });

  it("contains no meshcore_private reference in any production TypeScript source", async () => {
    const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
    const files = (await readdir(sourceDirectory)).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(join(sourceDirectory, file), "utf8");
      expect(source, file).not.toContain("meshcore_private");
    }
  });

  it("keeps core routes available when initial docs refresh fails", async () => {
    const root = join(tmpdir(), `meshat-docs-app-${randomUUID()}`);
    temporaryRoots.push(root);
    await mkdir(root, { recursive: true });
    const config = loadConfig({ DOCS_CACHE_DIR: join(root, "repo") });
    const docs = new GitDocumentationService(config.docs, async () => {
      throw new Error("documentation remote unavailable");
    });
    const app = await buildServer({
      config,
      repository: new FakeRepository(),
      docs,
      logger: false,
    });
    expect((await app.inject("/v1/sources")).statusCode).toBe(200);
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    const unavailable = await app.inject("/v1/docs");
    expect(unavailable.statusCode).toBe(503);
    expect(errorCode(unavailable)).toBe("DOCS_UNAVAILABLE");
    await app.close();
  });
});
