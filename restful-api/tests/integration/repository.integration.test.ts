import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  PostgresMeshcoreRepository,
  EXPECTED_SCHEMA_ID,
  EXPECTED_SCHEMA_VERSION,
} from "../../src/repository.js";
import { createDatabase } from "../../src/database.js";
import type { SQL } from "bun";
import { getIata } from "../../src/iata.js";
import { buildServer } from "../../src/server.js";
import { FakeDocs } from "../fakes.js";
import { loadConfig } from "../../src/config.js";

const OBSERVER_A = "A".repeat(64);
const OBSERVER_B = "B".repeat(64);
const LOCATED_NODE = "7E7662676F7F0850A8A355BAAFBFC1EB7B4174C340442D7D7161C9474A2C9400";
const NODE_LAT = 47.543968;
const NODE_LON = -122.108616;
const MESSAGE_PACKET_SHA = "61271d6d3085f96ac79ba61421e30bf424e808220438d8266c61863ab0a18897";

let db: SQL;
let admin: SQL;
let repository: PostgresMeshcoreRepository;

beforeAll(async () => {
  const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  const make = (user: string, password: string) =>
    createDatabase({
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      database: parsed.pathname.slice(1),
      user,
      password,
      ssl: false,
      max: 4,
      statement_timeout: 30_000,
      application_name: "rest-integration-test",
    });
  db = make(parsed.username, decodeURIComponent(parsed.password));
  admin = make("meshcore_test", "meshcore_test");
  repository = new PostgresMeshcoreRepository(db);
});

afterAll(async () => {
  if (db) await db.close({ timeout: 1 });
  if (admin) await admin.close({ timeout: 1 });
});

async function snapshotWindow() {
  const rows: Array<{ min: string; max: string }> =
    await admin`SELECT min(received_at_ms)::text AS min, max(received_at_ms)::text AS max FROM meshcore_public.neighbor_snapshots`;
  const row = rows[0]!;
  return { min: Number(row.min), max: Number(row.max) };
}

const INTEGRATION_ENABLED = Boolean(process.env.INTEGRATION_DATABASE_URL);

describe.skipIf(!INTEGRATION_ENABLED)("schema health/fingerprint (A)", () => {
  it("reports the canonical broker schema identity", async () => {
    const metadata = await repository.health();
    expect(metadata.schema_id).toBe(EXPECTED_SCHEMA_ID);
    expect(metadata.schema_version).toBe(EXPECTED_SCHEMA_VERSION);
    expect(metadata.schema_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.schema_hash).not.toBe("pending");
  });
});

describe.skipIf(!INTEGRATION_ENABLED)("list nodes (B) and region membership (C)", () => {
  it("lists the located advert node with typed fields", async () => {
    const page = await repository.listNodes({
      filters: {},
      limit: 10,
      order: "desc",
      sort: "last_seen",
    });
    const node = page.items.find((entry) => entry.public_key === LOCATED_NODE);
    expect(node).toBeDefined();
    expect(node!.location).toEqual({ latitude: NODE_LAT, longitude: NODE_LON });
    expect(typeof node!.last_seen).toBe("string");
    expect(Array.isArray(node!.iata)).toBe(true);
    expect(Array.isArray(node!.regions)).toBe(true);
  });

  it("derives node region membership only from the entity's own evidence", async () => {
    const sePage = await repository.listNodes({
      filters: { region: "se" },
      limit: 10,
      order: "asc",
      sort: "name",
    });
    const located = (sePage.items as Array<{ public_key: string; regions?: string[] }>).find(
      (node) => node.public_key === LOCATED_NODE,
    );
    expect(located).toBeDefined();
    // Node C carries `se` entry scope from BOTH observers.
    expect(located!.regions).toContain("se");
    // se01 evidence exists on a neighbor entry whose node row does not exist,
    // so no public node may appear for it.
    const se01 = await repository.listNodes({
      filters: { region: "se01" },
      limit: 10,
      order: "asc",
      sort: "name",
    });
    expect(se01.items).toHaveLength(0);
  });

  it("correlates region evidence time with seen_from/seen_to (D)", async () => {
    const window = await snapshotWindow();
    const inside = await repository.listNodes({
      filters: { region: "se", seenFrom: window.min - 1, seenTo: window.max + 10_000 },
      limit: 10,
      order: "asc",
      sort: "name",
    });
    expect(inside.items.map((node) => node.public_key)).toContain(LOCATED_NODE);
    const afterEvidence = await repository.listNodes({
      filters: { region: "se", seenFrom: window.max + 1_000, seenTo: window.max + 2_000 },
      limit: 10,
      order: "asc",
      sort: "name",
    });
    expect(afterEvidence.items).toHaveLength(0);
  });
});

describe.skipIf(!INTEGRATION_ENABLED)(
  "observer region uses the observer's own public key (E)",
  () => {
    it("returns each observer only for its self-reported scopes", async () => {
      const se = await repository.listObservers({
        filters: { region: "se" },
        limit: 10,
        order: "asc",
        sort: "name",
      });
      expect(se.items.map((observer) => observer.public_key)).toEqual([OBSERVER_A]);

      const se02 = await repository.listObservers({
        filters: { region: "se02" },
        limit: 10,
        order: "asc",
        sort: "name",
      });
      expect(se02.items.map((observer) => observer.public_key)).toEqual([OBSERVER_B]);
    });
  },
);

describe.skipIf(!INTEGRATION_ENABLED)("IATA alias/primary semantics (F/N)", () => {
  it("maps GSE to primary GOT in the public IATA catalog", async () => {
    const entry = getIata("GSE");
    expect(entry?.type).toBe("secondary");
    expect(entry?.primary_code).toBe("GOT");
  });

  it("reports live secondary-code counts from stored sightings", async () => {
    const summary = await repository.getIataSummary("GSE");
    expect(summary?.node_count).toBeGreaterThan(0);
    expect(summary?.observation_count).toBeGreaterThan(0);
  });

  it("filters nodes by the exact stored sighting code including secondaries", async () => {
    const viaSecondary = await repository.listNodes({
      filters: { iata: "GSE" },
      limit: 10,
      order: "desc",
      sort: "last_seen",
    });
    expect(viaSecondary.items.map((node) => node.public_key)).toContain(LOCATED_NODE);

    const viaPrimary = await repository.listNodes({
      filters: { iata: "JKG" },
      limit: 10,
      order: "desc",
      sort: "last_seen",
    });
    expect(viaPrimary.items.map((node) => node.public_key)).toContain(LOCATED_NODE);
  });

  it("keeps unknown IATA codes out of entity results and summaries empty (N)", async () => {
    const none = await repository.listNodes({
      filters: { iata: "XYZ" },
      limit: 10,
      order: "desc",
      sort: "last_seen",
    });
    expect(none.items).toHaveLength(0);
    const summary = await repository.getIataSummary("XYZ");
    expect(summary?.observation_count ?? 0).toBe(0);
  });
});

describe.skipIf(!INTEGRATION_ENABLED)("geographic PostGIS radius (G)", () => {
  it("finds the located node within a small radius and not far away", async () => {
    const near = await repository.listNodes({
      filters: { nearLat: NODE_LAT, nearLon: NODE_LON, radiusKm: 5 },
      limit: 10,
      order: "desc",
      sort: "last_seen",
    });
    expect(near.items.map((node) => node.public_key)).toContain(LOCATED_NODE);

    const far = await repository.listNodes({
      filters: { nearLat: 57.7, nearLon: 14.16, radiusKm: 50 },
      limit: 10,
      order: "desc",
      sort: "last_seen",
    });
    expect(far.items).toHaveLength(0);
  });
});

describe.skipIf(!INTEGRATION_ENABLED)("cursor pagination without duplicates or gaps (H/I)", () => {
  it("walks packets with limit 2 collecting every sha exactly once (H)", async () => {
    const seen: string[] = [];
    let cursor: import("../../src/domain.js").CursorKey | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await repository.listPackets({
        filters: {},
        limit: 2,
        order: "desc",
        sort: "received_at",
        after: cursor,
      });
      seen.push(...(page.items as Array<{ sha256: string }>).map((packet) => packet.sha256));
      if (!page.hasMore) break;
      cursor = page.nextKey!;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(5);
  });

  it("rejects a cursor reused with an incompatible query over HTTP (I)", async () => {
    const app = await buildServer({
      config: loadConfig({
        DOCS_CACHE_DIR: "/tmp/unused-meshat-docs",
        DATABASE_HOST: process.env.DATABASE_HOST ?? "127.0.0.1",
        DATABASE_PORT: process.env.DATABASE_PORT ?? "55432",
        DATABASE_NAME: process.env.DATABASE_NAME ?? "meshcore",
        DATABASE_USER: process.env.DATABASE_USER ?? "meshcore_http",
        DATABASE_PASSWORD: process.env.DATABASE_PASSWORD ?? "integration_http",
        DATABASE_SSL: "false",
        DATABASE_POOL_MAX: "2",
      }),
      docs: new FakeDocs(),
      refreshDocs: false,
      logger: false,
    });
    try {
      const first = await app.inject("/v1/meshcore/packets?limit=2");
      expect(first.statusCode).toBe(200);
      const parsedBody = JSON.parse(first.body) as { pagination?: { next_cursor?: string } };
      const nextCursor = parsedBody.pagination?.next_cursor;
      expect(typeof nextCursor).toBe("string");
      expect(nextCursor).toBeTruthy();
      const mismatched = await app.inject(
        `/v1/meshcore/packets?limit=2&cursor=${encodeURIComponent(nextCursor!)}&received_from=9000-01-01T00:00:00Z&received_to=9500-01-01T00:00:00Z`,
      );
      expect(mismatched.statusCode).toBe(422);
      const mismatchBody = JSON.parse(mismatched.body) as { error?: { code?: string } };
      expect(mismatchBody.error?.code).toBe("INVALID_CURSOR");
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!INTEGRATION_ENABLED)(
  "logical message canonical fields + matched evidence (J/K/L)",
  () => {
    it("aggregates three observations into one canonical message (J)", async () => {
      const page = await repository.listMessages({
        filters: {},
        limit: 10,
        order: "desc",
        sort: "reported_at",
      });
      const canonical = page.items.filter(
        (message) => message.representative_packet_sha256 === MESSAGE_PACKET_SHA,
      );
      expect(canonical).toHaveLength(1);
      const message = canonical[0] as {
        id: string;
        representative_packet_sha256: string;
        observation_count: number;
        iata: string[];
        matched: { observation_count: number };
      };
      expect(message.id).toStartWith("lp_");
      expect(message.observation_count).toBe(3);
      expect([...message.iata].sort()).toEqual(["GOT", "GSE", "JKG"]);
      expect(message.matched.observation_count).toBe(3);
    });

    it("resolves logical_id to physical packets with bytea-derived raw hex (K/L)", async () => {
      const messagePage = await repository.listMessages({
        filters: {},
        limit: 10,
        order: "desc",
        sort: "reported_at",
      });
      const message = messagePage.items.find(
        (entry) => entry.representative_packet_sha256 === MESSAGE_PACKET_SHA,
      )!;

      const physical = await repository.listPackets({
        filters: { logicalId: message.id },
        limit: 5,
        order: "desc",
        sort: "received_at",
      });
      expect(physical.items).toHaveLength(1);
      const packet = physical.items[0]!;
      expect(packet.sha256).toBe(MESSAGE_PACKET_SHA);
      expect(packet.raw).toStartWith("0x");
      expect(packet.logical_id ?? message.id).toBe(message.id);

      const detail = await repository.getPacket(MESSAGE_PACKET_SHA);
      expect(detail?.raw).toBe(packet.raw);
      expect(detail?.logical_id).toBe(message.id);
    });

    it("keeps representative_packet_sha256 valid for every canonical message (L)", async () => {
      const page = await repository.listMessages({
        filters: {},
        limit: 20,
        order: "desc",
        sort: "reported_at",
      });
      expect(page.items.length).toBeGreaterThanOrEqual(1);
      for (const message of page.items as Array<{ representative_packet_sha256: string }>) {
        const packet = await repository.getPacket(message.representative_packet_sha256);
        expect(packet?.sha256).toBe(message.representative_packet_sha256);
      }
    });
  },
);

describe.skipIf(!INTEGRATION_ENABLED)("trace observation identity (M)", () => {
  it("binds hops to exactly one trace id", async () => {
    const traces = await repository.listTraces({
      filters: {},
      limit: 10,
      order: "desc",
      sort: "received_at",
    });
    expect(traces.items.length).toBeGreaterThanOrEqual(1);
    const typed = traces.items as Array<{ id: string }>;
    for (const trace of typed) {
      const hops = await repository.listTraceHops(trace.id);
      expect(hops.length).toBeGreaterThanOrEqual(1);
    }
    const otherId = String(Number(typed[0]!.id) + 999_999);
    const absent = await repository.listTraceHops(otherId);
    expect(absent).toHaveLength(0);
  });
});

describe.skipIf(!INTEGRATION_ENABLED)("reversed date range stays empty (O)", () => {
  it("never returns rows when seenFrom exceeds seenTo", async () => {
    const reversed = await repository.listNodes({
      filters: { seenFrom: 9_000_000_000_000, seenTo: 1_000_000_000 },
      limit: 10,
      order: "desc",
      sort: "last_seen",
    });
    expect(reversed.items).toHaveLength(0);
  });
});

describe.skipIf(!INTEGRATION_ENABLED)("injection-like text remains data (P)", () => {
  it("treats hostile filter values as literals and leaves data intact", async () => {
    const before = await repository.listNodes({
      filters: {},
      limit: 100,
      order: "desc",
      sort: "last_seen",
    });
    const hostile = await repository.listNodes({
      filters: { name: "'; DROP TABLE meshcore_public.nodes; --" },
      limit: 10,
      order: "desc",
      sort: "last_seen",
    });
    expect(hostile.items).toHaveLength(0);
    const after = await repository.listNodes({
      filters: {},
      limit: 100,
      order: "desc",
      sort: "last_seen",
    });
    expect(after.items.length).toBe(before.items.length);
  });
});

describe.skipIf(!INTEGRATION_ENABLED)("multi-variant logical message semantics (§39)", () => {
  const LOGICAL_ID = `lp_${"e".repeat(64)}`;
  // Five physical variants across three IATA codes. The LATEST observation
  // (GOT) is deliberately outside the JKG/GSE subsets used in filters.
  const VARIANTS = [
    { sha: "1".repeat(64), iata: "JKG", at: 1_800_000_000_500 },
    { sha: "2".repeat(64), iata: "JKG", at: 1_800_000_001_000 },
    { sha: "3".repeat(64), iata: "GSE", at: 1_800_000_002_000 },
    { sha: "4".repeat(64), iata: "GSE", at: 1_800_000_003_000 },
    { sha: "5".repeat(64), iata: "GOT", at: 1_800_000_004_000 },
  ].map((variant, index) => ({
    ...variant,
    privateId: 930_001 + index,
    observationPrivateId: 940_001 + index,
    messagePrivateId: 950_001 + index,
  }));

  beforeAll(async () => {
    for (const variant of VARIANTS) {
      await admin`INSERT INTO meshcore_public.packets
        (private_id, packet_sha256, raw_packet_blob, logical_packet_id,
         decode_status, first_seen_at_ms, last_seen_at_ms)
        VALUES (${variant.privateId}, ${variant.sha},
          ${"\\x01"}::bytea, ${LOGICAL_ID}, 'decoded',
          ${variant.at}::text::bigint, ${variant.at}::text::bigint)
        ON CONFLICT (packet_sha256) DO NOTHING`;
      const inserted = await admin<{ id: number }[]>`INSERT INTO meshcore_public.packet_observations
        (private_id, packet_sha256, observer_public_key, iata, received_at_ms,
         suspected_mqtt_duplicate, suspected_rf_retransmission)
        VALUES (${variant.observationPrivateId}, ${variant.sha},
          ${"A".repeat(64)}, ${variant.iata}, ${variant.at}::text::bigint,
          false, false)
        ON CONFLICT (private_id) DO UPDATE SET iata = EXCLUDED.iata
        RETURNING id`;
      const observationId = inserted[0]!.id;
      await admin`INSERT INTO meshcore_public.messages
        (private_id, packet_sha256, packet_observation_id, message_type,
         encrypted, reported_at_ms, received_at_ms)
        VALUES (${variant.messagePrivateId}, ${variant.sha},
          ${observationId}, 'TXT_MSG', false,
          ${variant.at - 10}::text::bigint, ${variant.at}::text::bigint)
        ON CONFLICT (packet_observation_id) DO NOTHING`;
    }
  });

  it("returns one canonical message with full totals over five variants", async () => {
    const page = await repository.listMessages({
      filters: {},
      limit: 50,
      order: "desc",
      sort: "reported_at",
    });
    const entries = page.items as unknown as Array<{
      id: string;
      representative_packet_sha256: string;
      observation_count: number;
      iata: string[];
      matched: { observation_count: number; iata: string[] };
    }>;
    const target = entries.filter((entry) =>
      VARIANTS.some((variant) => variant.sha === entry.representative_packet_sha256),
    );
    expect(target).toHaveLength(1);
    const message = target[0]!;
    expect(message.id).toBe(LOGICAL_ID);
    expect(message.observation_count).toBe(5);
    expect([...message.iata].sort()).toEqual(["GOT", "GSE", "JKG"]);
    expect(message.matched).toEqual({
      iata: ["GOT", "GSE", "JKG"],
      observation_count: 5,
    });
    // Representative is the deterministic latest observation.
    expect(message.representative_packet_sha256).toBe(VARIANTS[4]!.sha);
  });

  it("keeps canonical totals full while matched shrinks to the IATA subset", async () => {
    const page = await repository.listMessages({
      filters: { iata: "JKG" },
      limit: 50,
      order: "desc",
      sort: "reported_at",
    });
    const entries = page.items as unknown as Array<{
      id: string;
      representative_packet_sha256: string;
      observation_count: number;
      matched: { observation_count: number; iata: string[] };
    }>;
    const target = entries.find((entry) => entry.id === LOGICAL_ID);
    expect(target).toBeDefined();
    expect(target!.observation_count).toBe(5); // canonical stays full
    expect(target!.matched.observation_count).toBe(2); // JKG subset only
    void target!.matched.iata;
    expect(JSON.stringify(target!.matched).includes("GOT")).toBe(false);
  });

  it("keeps the global representative even when it lies outside a narrow time window", async () => {
    const page = await repository.listMessages({
      filters: {
        receivedFrom: 1_800_000_000_400,
        receivedTo: 1_800_000_000_600, // covers ONLY the oldest JKG variant
      },
      limit: 50,
      order: "desc",
      sort: "reported_at",
    });
    const entries = page.items as unknown as Array<{
      id: string;
      representative_packet_sha256: string;
      observation_count: number;
      matched: { observation_count: number };
    }>;
    const target = entries.find((entry) => entry.id === LOGICAL_ID);
    expect(target).toBeDefined();
    // Representative stays the globally-latest observation even though the
    // query subset only saw the oldest one.
    expect(target!.representative_packet_sha256).toBe("5".repeat(64));
    expect(target!.matched.observation_count).toBe(1);
  });
});
