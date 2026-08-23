import { describe, expect, it } from "vitest";
import {
  EXPECTED_SCHEMA_ID,
  EXPECTED_SCHEMA_VERSION,
  PostgresMeshcoreRepository,
  type DatabasePool,
} from "../src/repository.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { FakeDocs } from "./fakes.js";

class RecordingPool implements DatabasePool {
  calls: Array<{ sql: string; values: unknown[] }> = [];
  closed = false;
  rows: unknown[] = [];
  async query<T>(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: this.rows as T[] };
  }
  async end() {
    this.closed = true;
  }
}

describe("fixed PostgreSQL repository", () => {
  it("keeps injection strings in bound values and only references the public schema", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresMeshcoreRepository(pool);
    const injection = "x%_' OR 1=1 --";
    await repository.listNodes({
      filters: { name: injection, iata: "JKG", region: "public" },
      sort: "last_seen",
      order: "desc",
      limit: 10,
    });
    const call = pool.calls[0]!;
    expect(call.values).toContain("%x\\%\\_' OR 1=1 --%");
    expect(call.sql).not.toContain(injection);
    expect(call.sql).toContain("ESCAPE '\\'");
    expect(call.sql).toContain("meshcore_public.nodes");
    expect(call.sql).not.toContain("information_schema");
    expect(call.sql).not.toContain("meshcore_private");
  });

  it("uses qualified PostGIS geography filtering and fixed sort expressions", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresMeshcoreRepository(pool);
    await repository.listObservers({
      filters: { nearLat: 57, nearLon: 14, radiusKm: 25 },
      sort: "name",
      order: "asc",
      limit: 20,
    });
    const call = pool.calls[0]!;
    expect(call.sql).toContain("public.ST_DWithin");
    expect(call.sql).toContain("public.ST_SetSRID(public.ST_MakePoint");
    expect(call.sql).toContain("n.location");
    expect(call.values).toContain(25_000);
    expect(call.sql).not.toContain("ST_AsGeoJSON");
    expect(call.sql).toContain("LOWER(COALESCE(o.label, n.latest_name, ''))");
  });

  it("matches observer regions through scopes reported by that observer", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresMeshcoreRepository(pool);
    await repository.listObservers({
      filters: { region: "public" },
      sort: "last_seen",
      order: "desc",
      limit: 20,
    });
    const call = pool.calls[0]!;
    expect(call.sql).toContain("snapshot.observer_public_key = o.public_key");
    expect(call.sql).toContain("entry.snapshot_id = snapshot.id");
    expect(call.sql).toContain("neighbor_entry_scopes");
    expect(call.sql).toContain("neighbor_snapshot_scopes");
  });

  it("derives observer active state from the configured recent-ingest window", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresMeshcoreRepository(
      pool,
      300_000,
      () => 1_000_000,
    );
    await repository.listObservers({
      filters: { active: true },
      sort: "last_seen",
      order: "desc",
      limit: 20,
    });
    expect(pool.calls[0]!.sql).toContain("o.last_seen_at_ms >= $1");
    expect(pool.calls[0]!.sql).toContain("(o.last_seen_at_ms >= $1) AS active");
    expect(pool.calls[0]!.values[0]).toBe(700_000);
  });

  it("lists regions from the public registry with known-node counts", async () => {
    const pool = new RecordingPool();
    pool.rows = [
      {
        region: "se1380",
        name: "Halmstads kommun",
        first_seen_at_ms: "1000",
        last_seen_at_ms: "2000",
        manually_added: true,
        observation_count: "3",
        node_count: "2",
        observer_count: "1",
        last_activity_at_ms: "2000",
      },
    ];
    const regions = await new PostgresMeshcoreRepository(pool).listRegions();
    expect(pool.calls[0]!.sql).toContain("meshcore_public.region_scopes");
    expect(pool.calls[0]!.sql).toContain("ORDER BY registry.region");
    expect(pool.calls[0]!.sql).toContain(
      "LEFT JOIN meshcore_public.nodes node ON node.public_key = membership.node_public_key",
    );
    expect(pool.calls[0]!.sql).toContain(
      "count(DISTINCT membership.observer_public_key)",
    );
    expect(regions).toEqual([
      {
        region: "se1380",
        name: "Halmstads kommun",
        first_seen: "1970-01-01T00:00:01.000Z",
        last_seen: "1970-01-01T00:00:02.000Z",
        manually_added: true,
        observation_count: 3,
        node_count: 2,
        observer_count: 1,
        last_activity: "1970-01-01T00:00:02.000Z",
        links: { nodes: "/v1/meshcore/regions/se1380/nodes" },
      },
    ]);
  });

  it("returns a registered region with zero counts when no evidence exists yet", async () => {
    const pool = new RecordingPool();
    pool.rows = [
      {
        region: "se01",
        name: "Stockholms län",
        first_seen_at_ms: null,
        last_seen_at_ms: null,
        manually_added: true,
        observation_count: "0",
        node_count: "0",
        observer_count: "0",
        last_activity_at_ms: null,
      },
    ];
    const region = await new PostgresMeshcoreRepository(pool).getRegion("se01");
    expect(pool.calls[0]!.values).toEqual(["se01"]);
    expect(region).toMatchObject({
      region: "se01",
      name: "Stockholms län",
      first_seen: null,
      last_seen: null,
      manually_added: true,
      observation_count: 0,
      node_count: 0,
      observer_count: 0,
      last_activity: null,
    });
  });

  it("matches role filters case-insensitively", async () => {
    const pool = new RecordingPool();
    await new PostgresMeshcoreRepository(pool).listNodes({
      filters: { role: "RePeAtEr" },
      sort: "role",
      order: "asc",
      limit: 20,
    });
    expect(pool.calls[0]!.sql).toContain(
      "LOWER(COALESCE(n.latest_role, '')) = $1",
    );
    expect(pool.calls[0]!.values[0]).toBe("repeater");
  });

  it("uses latest-per-observer snapshots for neighbor evidence", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresMeshcoreRepository(pool);
    await repository.getNeighborEvidence("A".repeat(64));
    expect(pool.calls[0]!.sql).toContain(
      "DISTINCT ON (snapshot.observer_public_key)",
    );
    expect(pool.calls[0]!.sql).toContain(
      "ORDER BY snapshot.observer_public_key, snapshot.received_at_ms DESC, snapshot.id DESC",
    );
  });

  it("binds a logical packet identity to the packet filter", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresMeshcoreRepository(pool);
    const logicalId = `lp_${"a".repeat(64)}`;
    await repository.listPackets({
      filters: { logicalId },
      sort: "received_at",
      order: "desc",
      limit: 10,
    });
    expect(pool.calls[0]!.sql).toContain("packet.logical_packet_id = $1");
    expect(pool.calls[0]!.values[0]).toBe(logicalId);
  });

  it("binds observer, IATA, and time to one packet observation", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresMeshcoreRepository(pool);
    await repository.listPackets({
      filters: {
        observer: "A".repeat(64),
        node: "B".repeat(64),
        iata: "JKG",
        receivedFrom: 100,
        receivedTo: 200,
      },
      sort: "received_at",
      order: "desc",
      limit: 10,
    });
    const call = pool.calls[0]!;
    expect(call.sql).toContain("observation.observer_public_key");
    expect(call.sql).toContain("observation.iata");
    expect(call.sql).toContain("observation.received_at_ms >=");
    expect(call.sql).toContain("observation.received_at_ms <=");
    expect(call.sql).not.toContain("packet.last_seen_at_ms >=");
    expect(call.sql).toContain(
      "sighting.packet_observation_id = observation.id",
    );
    expect(call.sql).toContain("SELECT max(observation.received_at_ms)");
  });

  it("deduplicates messages by logical identity and retains trace keysets", async () => {
    const pool = new RecordingPool();
    const repository = new PostgresMeshcoreRepository(pool);
    await repository.listMessages({
      filters: {},
      sort: "received_at",
      order: "desc",
      limit: 10,
    });
    await repository.listTraces({
      filters: {},
      sort: "received_at",
      order: "desc",
      limit: 10,
    });
    expect(pool.calls[0]!.sql).toContain(
      "COALESCE(packet.logical_packet_id, message.packet_sha256) AS logical_id",
    );
    expect(pool.calls[0]!.sql).toContain("GROUP BY logical_id");
    expect(pool.calls[0]!.sql).toContain(
      "array_agg(DISTINCT observation_iata ORDER BY observation_iata)",
    );
    expect(pool.calls[1]!.sql).toContain(
      "ORDER BY observation.received_at_ms desc, observation.id desc",
    );
  });

  it("validates the expected public schema identity and version", async () => {
    const pool = new RecordingPool();
    pool.rows = [
      {
        schema_id: EXPECTED_SCHEMA_ID,
        schema_version: EXPECTED_SCHEMA_VERSION,
      },
    ];
    const repository = new PostgresMeshcoreRepository(pool);
    await expect(repository.health()).resolves.toBeUndefined();
    expect(pool.calls[0]).toMatchObject({ values: [1] });
    pool.rows = [{ schema_id: EXPECTED_SCHEMA_ID, schema_version: 999 }];
    await expect(repository.health()).rejects.toMatchObject({
      code: "SCHEMA_MISMATCH",
    });
  });

  it("counts distinct packet hashes as packets_24h", async () => {
    const pool = new RecordingPool();
    pool.rows = [
      {
        known_nodes: "0",
        active_nodes: "0",
        known_observers: "0",
        active_observers: "0",
        regions: "0",
        active_iata: "0",
        packets_24h: "3",
        messages_24h: "1",
        last_seen_at_ms: null,
      },
    ];
    const stats = (await new PostgresMeshcoreRepository(pool).getStats()) as {
      activity: Record<string, unknown>;
    };
    expect(pool.calls[0]!.sql).toContain("count(DISTINCT packet_sha256)");
    expect(pool.calls[0]!.sql).toContain(
      "count(DISTINCT COALESCE(packet.logical_packet_id, message.packet_sha256))",
    );
    expect(stats.activity).toMatchObject({
      packets_24h: 3,
      messages_24h: 1,
    });
    expect(stats.activity).not.toHaveProperty("packet_observations_24h");
  });

  it("selects structured packet path hops including unresolved topology", async () => {
    const pool = new RecordingPool();
    await new PostgresMeshcoreRepository(pool).listPacketObservations(
      "c".repeat(64),
      { filters: {}, sort: "received_at", order: "desc", limit: 10 },
    );
    expect(pool.calls[0]!.sql).toContain("'prefix_hex', hop.prefix_hex");
    expect(pool.calls[0]!.sql).toContain(
      "'resolution_status', hop.resolution_status",
    );
    expect(pool.calls[0]!.sql).toContain("ORDER BY hop.hop_index");
  });

  it("closes an injected production pool with the Fastify lifecycle", async () => {
    const pool = new RecordingPool();
    pool.rows = [
      {
        schema_id: EXPECTED_SCHEMA_ID,
        schema_version: EXPECTED_SCHEMA_VERSION,
      },
    ];
    const app = await buildServer({
      config: loadConfig({
        DATABASE_PASSWORD: "test-only",
        DOCS_CACHE_DIR: "/tmp/unused-meshat-docs",
      }),
      pool,
      docs: new FakeDocs(),
      refreshDocs: false,
      logger: false,
    });
    expect((await app.inject("/readyz")).statusCode).toBe(200);
    pool.rows = [{ schema_id: EXPECTED_SCHEMA_ID, schema_version: 999 }];
    const mismatch = await app.inject("/readyz");
    expect(mismatch.statusCode).toBe(503);
    expect(mismatch.json().error.code).toBe("DATABASE_UNAVAILABLE");
    await app.close();
    expect(pool.closed).toBe(true);
  });
});
