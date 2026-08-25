import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { createDatabase } from "../../src/database.js";

// Pins the Bun.SQL driver semantics the REST mappers rely on, verified
// against the canonical test PostgreSQL. These mirror the documented `pg`
// baseline: int8 as string, bytea as Buffer, float8/integer as numbers,
// native boolean/text/text[] and NULL.

let db: SQL;

beforeAll(async () => {
  const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  db = createDatabase({
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    database: parsed.pathname.slice(1),
    user: parsed.username,
    password: decodeURIComponent(parsed.password),
    ssl: false,
    max: 2,
    statement_timeout: 30_000,
    application_name: "rest-integration-types",
  });
});

afterAll(async () => {
  if (db) await db.close({ timeout: 1 });
});

const INTEGRATION_ENABLED = Boolean(process.env.INTEGRATION_DATABASE_URL);

type Row = Record<string, unknown>;
const first = (rows: Row[]): Row => rows[0]!;

describe.skipIf(!INTEGRATION_ENABLED)(
  "Bun.SQL value semantics at the driver boundary (§12)",
  () => {
    it("returns int8/bigint as strings", async () => {
      const rows = await db<
        Row[]
      >`SELECT first_seen_at_ms AS value FROM meshcore_public.nodes LIMIT 1`;
      expect(typeof first(rows).value).toBe("string");
      expect(() => Number(first(rows).value)).not.toThrow();
    });

    it("returns count(*)::text as string and plain integer as number", async () => {
      const rows = await db<
        Row[]
      >`SELECT count(*)::text AS text_count, count(*)::int AS int_count FROM meshcore_public.packets`;
      expect(typeof first(rows).text_count).toBe("string");
      expect(typeof first(rows).int_count).toBe("number");
    });

    it("returns boolean, text and NULL natively", async () => {
      const rows = await db<
        Row[]
      >`SELECT true AS flag, 'meshat'::text AS label, NULL::text AS missing`;
      expect(first(rows).flag).toBe(true);
      expect(first(rows).label).toBe("meshat");
      expect(first(rows).missing).toBeNull();
    });

    it("returns bytea as Buffer whose hex feeds the public raw field", async () => {
      const rows = await db<
        Row[]
      >`SELECT raw_packet_blob AS blob FROM meshcore_public.packets WHERE decode_status = 'decoded' LIMIT 1`;
      const blob = first(rows).blob;
      expect(Buffer.isBuffer(blob)).toBe(true);
      const hex = `0x${(blob as Buffer).toString("hex")}`;
      expect(hex.startsWith("0x")).toBe(true);
    });

    it("returns double precision as numbers including PostGIS derivations", async () => {
      const rows = await db<
        Row[]
      >`SELECT -12.5::double precision AS snr, public.ST_X(n.location::public.geometry) AS x, public.ST_Y(n.location::public.geometry) AS y FROM meshcore_public.nodes n WHERE n.location IS NOT NULL LIMIT 1`;
      expect(first(rows).snr).toBe(-12.5);
      expect(typeof first(rows).x).toBe("number");
      expect(typeof first(rows).y).toBe("number");
    });

    it("returns text[] arrays", async () => {
      const rows = await db<Row[]>`SELECT ARRAY['JKG','GOT']::text[] AS tags`;
      expect(first(rows).tags).toEqual(["JKG", "GOT"]);
    });

    it("applies connection startup parameters (§15)", async () => {
      const applicationName = await db<Row[]>`SHOW application_name`;
      expect(applicationName[0]!.application_name).toBe("rest-integration-types");
      const statementTimeout = await db<Row[]>`SHOW statement_timeout`;
      const shown = statementTimeout[0]!.statement_timeout as string;
      expect(["30000ms", "30s"]).toContain(shown);
    });

    it("supports reserved connections with session-scoped settings (§19)", async () => {
      const reserved = await db.reserve();
      try {
        await reserved`SET search_path = pg_catalog`;
        const shown = await reserved<Row[]>`SHOW search_path`;
        expect(shown[0]!.search_path).toBe("pg_catalog");
        await reserved`RESET search_path`;
      } finally {
        reserved.release();
      }
    });
  },
);
