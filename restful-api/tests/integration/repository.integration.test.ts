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
import type { PublicMessage } from "../../src/contracts.js";

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

async function integrationApp() {
  return buildServer({
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
}

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

describe.skipIf(!INTEGRATION_ENABLED)("message cursor pagination over real pages (Q)", () => {
  // Explicit multi-page fixture: four additional distinct logical messages
  // with deterministic, realistic 13-digit epoch timestamps. This guarantees
  // enough logical messages for second-page cursor walks (page 2 is where the
  // production bug fired) regardless of the base fixture composition.
  const T0 = 1_810_000_000_000;
  const CURSOR_MESSAGES = [
    { id: `lp_${"a".repeat(64)}`, base: T0, iata: ["JKG", "GOT"] },
    { id: `lp_${"b".repeat(64)}`, base: T0 + 10_000, iata: ["JKG", "GSE"] },
    { id: `lp_${"c".repeat(64)}`, base: T0 + 20_000, iata: ["JKG", "JKG"] },
    { id: `lp_${"d".repeat(64)}`, base: T0 + 30_000, iata: ["GOT", "GSE"] },
  ];
  const variantSha = (row: number) => `${"f".repeat(28)}${String(9600 + row).padStart(36, "0")}`;

  beforeAll(async () => {
    let row = 0;
    for (const message of CURSOR_MESSAGES) {
      for (const [offset, iata] of message.iata.entries()) {
        const sha = variantSha(row);
        const at = message.base + offset * 500;
        await admin`INSERT INTO meshcore_public.packets
          (private_id, packet_sha256, raw_packet_blob, logical_packet_id,
           decode_status, first_seen_at_ms, last_seen_at_ms)
          VALUES (${970_001 + row}, ${sha},
            ${"\\x01"}::bytea, ${message.id}, 'decoded',
            ${at}::text::bigint, ${at}::text::bigint)
          ON CONFLICT (packet_sha256) DO NOTHING`;
        const inserted = await admin<
          { id: number }[]
        >`INSERT INTO meshcore_public.packet_observations
          (private_id, packet_sha256, observer_public_key, iata, received_at_ms,
           suspected_mqtt_duplicate, suspected_rf_retransmission)
          VALUES (${971_001 + row}, ${sha},
            ${"A".repeat(64)}, ${iata}, ${at}::text::bigint,
            false, false)
          ON CONFLICT (private_id) DO UPDATE SET iata = EXCLUDED.iata
          RETURNING id`;
        const observationId = inserted[0]!.id;
        await admin`INSERT INTO meshcore_public.messages
          (private_id, packet_sha256, packet_observation_id, message_type,
           encrypted, reported_at_ms, received_at_ms)
          VALUES (${972_001 + row}, ${sha},
            ${observationId}, 'TXT_MSG', false,
            ${at - 10}::text::bigint, ${at}::text::bigint)
          ON CONFLICT (packet_observation_id) DO NOTHING`;
        row += 1;
      }
    }
  });

  const tupleKey = (message: PublicMessage): [number, string] => [
    Date.parse(message.last_received_at ?? ""),
    message.id,
  ];

  function assertStrictTupleOrder(items: PublicMessage[], order: "asc" | "desc") {
    for (let index = 1; index < items.length; index += 1) {
      const previous = tupleKey(items[index - 1]!);
      const current = tupleKey(items[index]!);
      if (order === "desc") expect(previous > current).toBe(true);
      else expect(previous < current).toBe(true);
    }
  }

  async function walkMessages(
    order: "asc" | "desc",
    filters: import("../../src/domain.js").MessageFilters,
  ) {
    const pages: Array<Array<PublicMessage>> = [];
    const seen: Array<PublicMessage> = [];
    let cursor: import("../../src/domain.js").CursorKey | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const result = await repository.listMessages({
        filters,
        limit: 2,
        order,
        sort: "received_at",
        after: cursor,
      });
      pages.push(result.items);
      seen.push(...result.items);
      if (!result.hasMore) break;
      cursor = result.nextKey!;
    }
    return { pages, seen };
  }

  it("walks every logical message via desc cursors without duplicates or gaps", async () => {
    const groundTruth = await repository.listMessages({
      filters: {},
      limit: 100,
      order: "desc",
      sort: "received_at",
    });
    expect(groundTruth.items.length).toBeGreaterThanOrEqual(6); // fixture guarantee
    const { pages, seen } = await walkMessages("desc", {});
    expect(pages.length).toBeGreaterThanOrEqual(Math.ceil(seen.length / 2));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen.map((message) => message.id)).size).toBe(seen.length);
    assertStrictTupleOrder(seen, "desc");
    // Exact global-order equality proves no gaps AND that the final query
    // ordering matches the page_keys keyset ordering.
    expect(seen.map((message) => message.id)).toEqual(
      groundTruth.items.map((message) => message.id),
    );
    expect(pages[0]!.map((message) => message.id)).toEqual(
      groundTruth.items.slice(0, 2).map((message) => message.id),
    );
  });

  it("walks every logical message via asc cursors without duplicates or gaps", async () => {
    const groundTruth = await repository.listMessages({
      filters: {},
      limit: 100,
      order: "asc",
      sort: "received_at",
    });
    const { pages, seen } = await walkMessages("asc", {});
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen.map((message) => message.id)).size).toBe(seen.length);
    assertStrictTupleOrder(seen, "asc");
    expect(seen.map((message) => message.id)).toEqual(
      groundTruth.items.map((message) => message.id),
    );
  });

  it("paginates an iata-filtered message query without duplicates or gaps", async () => {
    const groundTruth = await repository.listMessages({
      filters: { iata: "JKG" },
      limit: 100,
      order: "desc",
      sort: "received_at",
    });
    const expectedIds = groundTruth.items.map((message) => message.id);
    expect(expectedIds.length).toBeGreaterThanOrEqual(3); // three JKG fixture messages
    const { pages, seen } = await walkMessages("desc", { iata: "JKG" });
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(seen.map((message) => message.id)).toEqual(expectedIds);
    expect(new Set(seen.map((message) => message.id)).size).toBe(seen.length);
    assertStrictTupleOrder(seen, "desc");
  });

  it("returns a working second page over HTTP (reproduces production flow)", async () => {
    const app = await integrationApp();
    try {
      const first = await app.inject("/v1/meshcore/messages?limit=2&order=desc");
      expect(first.statusCode).toBe(200);
      const page1 = JSON.parse(first.body) as {
        data: Array<PublicMessage>;
        pagination?: { has_more?: boolean; next_cursor?: string | null };
      };
      expect(page1.data).toHaveLength(2);
      expect(page1.pagination?.has_more).toBe(true);
      expect(page1.pagination?.next_cursor).toBeTruthy();
      const second = await app.inject(
        `/v1/meshcore/messages?limit=2&order=desc&cursor=${encodeURIComponent(page1.pagination!.next_cursor!)}`,
      );
      expect(second.statusCode).toBe(200);
      const page2 = JSON.parse(second.body) as { data: Array<PublicMessage> };
      expect(Array.isArray(page2.data)).toBe(true);
      const ids1 = new Set(page1.data.map((message) => message.id));
      const overlap = page2.data.filter((message) => ids1.has(message.id));
      expect(overlap).toHaveLength(0);
      // Tuple ordering must hold across the page boundary (last_received, id)
      // descending from end of page 1 into start of page 2.
      const boundaryEnd = tupleKey(page1.data.at(-1)!);
      const boundaryStart = tupleKey(page2.data[0]!);
      expect(boundaryEnd > boundaryStart).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("walks messages to the final empty-cursor page over HTTP without duplicates", async () => {
    const app = await integrationApp();
    try {
      const groundTruth = await repository.listMessages({
        filters: {},
        limit: 100,
        order: "desc",
        sort: "received_at",
      });
      const expectedIds = new Set(groundTruth.items.map((message) => message.id));
      const seen: string[] = [];
      let path = "/v1/meshcore/messages?limit=2&order=desc";
      for (let guard = 0; guard < 20; guard += 1) {
        const response = await app.inject(path);
        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body) as {
          data: Array<PublicMessage>;
          pagination?: { next_cursor?: string | null };
        };
        seen.push(...body.data.map((message) => message.id));
        if (!body.pagination?.next_cursor) break;
        path = `/v1/meshcore/messages?limit=2&order=desc&cursor=${encodeURIComponent(body.pagination.next_cursor)}`;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(expectedIds.size);
      for (const id of seen) expect(expectedIds.has(id)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("paginates a filtered HTTP query across pages with consistent matched totals", async () => {
    const app = await integrationApp();
    try {
      const groundTruth = await repository.listMessages({
        filters: { iata: "JKG" },
        limit: 100,
        order: "desc",
        sort: "received_at",
      });
      const expectedIds = new Set(groundTruth.items.map((message) => message.id));
      const seen: string[] = [];
      let path = "/v1/meshcore/messages?limit=2&order=desc&iata=JKG";
      for (let guard = 0; guard < 20; guard += 1) {
        const response = await app.inject(path);
        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body) as {
          data: Array<PublicMessage>;
          pagination?: { next_cursor?: string | null };
        };
        seen.push(...body.data.map((message) => message.id));
        if (!body.pagination?.next_cursor) break;
        path = `/v1/meshcore/messages?limit=2&order=desc&iata=JKG&cursor=${encodeURIComponent(body.pagination.next_cursor)}`;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(new Set(seen)).toEqual(expectedIds);
      // Matched evidence stays bound to the filter while canonical totals
      // remain full for each walked message.
      const jkgPage = JSON.parse(
        (await app.inject("/v1/meshcore/messages?limit=5&order=desc&iata=JKG")).body,
      ) as { data: Array<PublicMessage> };
      for (const message of jkgPage.data) {
        expect(message.matched.iata).toEqual(["JKG"]);
        expect(message.observation_count).toBeGreaterThanOrEqual(message.matched.observation_count);
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a message cursor reused with different filters over HTTP", async () => {
    const app = await integrationApp();
    try {
      const first = await app.inject("/v1/meshcore/messages?limit=2&order=desc");
      expect(first.statusCode).toBe(200);
      const page1 = JSON.parse(first.body) as {
        pagination?: { next_cursor?: string | null };
      };
      expect(page1.pagination?.next_cursor).toBeTruthy();
      const mismatched = await app.inject(
        `/v1/meshcore/messages?limit=2&order=desc&encrypted=true&cursor=${encodeURIComponent(page1.pagination!.next_cursor!)}`,
      );
      expect(mismatched.statusCode).toBe(422);
      const mismatchBody = JSON.parse(mismatched.body) as { error?: { code?: string } };
      expect(mismatchBody.error?.code).toBe("INVALID_CURSOR");
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!INTEGRATION_ENABLED)("literal LIKE name search semantics (R)", () => {
  // Names that exercise every LIKE metacharacter as literal caller text plus
  // wildcard-lookalike controls. The controls prove that `_` and `%` in the
  // query are treated literally, not as SQL wildcards.
  const T0 = 1_820_000_000_000;
  const UNDERSCORE_NODE_KEY = "1".repeat(64);
  const NODES = [
    { key: UNDERSCORE_NODE_KEY, name: "Literal_Test_Node" },
    { key: "2".repeat(64), name: "LiteralXTestNode" },
    { key: "3".repeat(64), name: "Value%Node" },
    { key: "4".repeat(64), name: "ValueABCNode" },
    { key: "5".repeat(64), name: "Back\\Slash" }, // actual string contains one backslash
    { key: "6".repeat(64), name: "Solar_Test_Fixture" },
  ];
  const OBSERVER_UNDERSCORE_KEY = "7".repeat(64);
  const OBSERVERS = [
    { key: OBSERVER_UNDERSCORE_KEY, label: "Literal_Test_Observer", iata: "JKG" },
    { key: "8".repeat(64), label: "LiteralXTestObserver", iata: null },
    { key: "9".repeat(64), label: "Observer%Label", iata: null },
  ];

  beforeAll(async () => {
    let index = 0;
    for (const node of NODES) {
      await admin`INSERT INTO meshcore_public.nodes
        (private_id, public_key, first_seen_at_ms, last_seen_at_ms, latest_name,
         latest_role, created_at_ms, updated_at_ms)
        VALUES (${983_001 + index}, ${node.key}, ${T0 + index}::text::bigint,
          ${T0 + index}::text::bigint, ${node.name}, 'chip',
          ${T0}::text::bigint, ${T0}::text::bigint)
        ON CONFLICT (public_key) DO UPDATE SET latest_name = EXCLUDED.latest_name`;
      index += 1;
    }
    index = 0;
    for (const observer of OBSERVERS) {
      await admin`INSERT INTO meshcore_public.observers
        (private_id, public_key, first_seen_at_ms, last_seen_at_ms, iata, label,
         active, updated_at_ms)
        VALUES (${984_001 + index}, ${observer.key},
          ${T0 + index}::text::bigint, ${T0 + index}::text::bigint,
          ${observer.iata}, ${observer.label}, true, ${T0}::text::bigint)
        ON CONFLICT (public_key) DO UPDATE SET label = EXCLUDED.label`;
      index += 1;
    }
  });

  const nodeNameKeys = async (name: string) => {
    const page = await repository.listNodes({
      filters: { name },
      limit: 20,
      order: "desc",
      sort: "last_seen",
    });
    return page.items.map((node) => node.public_key);
  };

  it("treats underscore as literal text when searching nodes", async () => {
    // Broader substring proves both the underscore node and its wildcard-
    // lookalike control exist in the fixture set.
    const broadKeys = await nodeNameKeys("Literal");
    expect(broadKeys).toContain(UNDERSCORE_NODE_KEY);
    expect(broadKeys).toContain("2".repeat(64));
    expect(broadKeys).toHaveLength(2);
    expect(await nodeNameKeys("Literal_Test")).toEqual([UNDERSCORE_NODE_KEY]);
    // Case-insensitive substring semantics are retained.
    expect(await nodeNameKeys("LITERAL_TEST")).toEqual([UNDERSCORE_NODE_KEY]);
  });

  it("does not activate the underscore wildcard when searching nodes", async () => {
    expect(await nodeNameKeys("LiteralXTest")).toEqual(["2".repeat(64)]);
    expect(await nodeNameKeys("LiteralX_Test")).toEqual([]);
  });

  it("treats percent as literal text and does not widen node matches", async () => {
    const exact = await repository.listNodes({
      filters: { name: "Value%Node" },
      limit: 10,
      order: "desc",
      sort: "last_seen",
    });
    expect(exact.items.map((node) => node.public_key)).toEqual(["3".repeat(64)]);
    const prefix = await repository.listNodes({
      filters: { name: "Value%" },
      limit: 10,
      order: "desc",
      sort: "last_seen",
    });
    expect(prefix.items.map((node) => node.public_key)).toEqual(["3".repeat(64)]);
    expect(await nodeNameKeys("ValueABCNode")).toEqual(["4".repeat(64)]);
  });

  it("treats backslash as literal text when searching nodes", async () => {
    const page = await repository.listNodes({
      filters: { name: "Back\\Slash" }, // caller provides one literal backslash
      limit: 10,
      order: "desc",
      sort: "last_seen",
    });
    expect(page.items.map((node) => node.public_key)).toEqual(["5".repeat(64)]);
  });

  it("treats underscore and percent as literal text when searching observers", async () => {
    const broad = await repository.listObservers({
      filters: { name: "Literal" },
      limit: 10,
      order: "asc",
      sort: "name",
    });
    const broadKeys = broad.items.map((observer) => observer.public_key);
    expect(broadKeys).toContain(OBSERVER_UNDERSCORE_KEY);
    expect(broadKeys).toContain("8".repeat(64));
    expect(broad.items).toHaveLength(2);
    const narrow = await repository.listObservers({
      filters: { name: "Literal_Test" },
      limit: 10,
      order: "asc",
      sort: "name",
    });
    expect(narrow.items.map((observer) => observer.public_key)).toEqual([OBSERVER_UNDERSCORE_KEY]);
    const percent = await repository.listObservers({
      filters: { name: "Observer%Label" },
      limit: 10,
      order: "asc",
      sort: "name",
    });
    expect(percent.items.map((observer) => observer.public_key)).toEqual(["9".repeat(64)]);
  });

  it("searches literal names end to end over HTTP", async () => {
    const app = await integrationApp();
    try {
      const nodes = await app.inject("/v1/meshcore/nodes?name=Literal_Test&limit=10");
      expect(nodes.statusCode).toBe(200);
      const nodeBody = JSON.parse(nodes.body) as {
        data: Array<{ public_key: string }>;
        pagination?: { has_more?: boolean };
      };
      expect(nodeBody.data.map((node) => node.public_key)).toEqual([UNDERSCORE_NODE_KEY]);
      expect(nodeBody.pagination?.has_more).toBe(false);

      const wildcards = await app.inject("/v1/meshcore/nodes?name=LiteralXTest&limit=10");
      expect(wildcards.statusCode).toBe(200);
      const wildcardBody = JSON.parse(wildcards.body) as {
        data: Array<{ public_key: string }>;
      };
      expect(wildcardBody.data.map((node) => node.public_key)).not.toContain(UNDERSCORE_NODE_KEY);

      const observers = await app.inject("/v1/meshcore/observers?name=Literal_Test&limit=10");
      expect(observers.statusCode).toBe(200);
      const observerBody = JSON.parse(observers.body) as {
        data: Array<{ public_key: string }>;
      };
      expect(observerBody.data.map((observer) => observer.public_key)).toEqual([
        OBSERVER_UNDERSCORE_KEY,
      ]);
    } finally {
      await app.close();
    }
  });
});
