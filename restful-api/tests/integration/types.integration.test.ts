import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";

// Documents the exact client-level type semantics the REST mappers rely on.
// These assertions pin `pg` behaviour today; after the Bun.SQL migration the
// same expectations must hold for whatever reaches the mapper boundary
// (bigint-as-string in particular), or mappers must normalize explicitly.

let pool: Pool;

beforeAll(async () => {
  const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
  if (!databaseUrl) throw new Error("INTEGRATION_DATABASE_URL is required");
  pool = new Pool({ connectionString: databaseUrl, max: 2 });
});

afterAll(async () => {
  await pool.end();
});

describe("PostgreSQL value semantics at the driver boundary (§12)", () => {
  it("returns int8/bigint as strings", async () => {
    const result = await pool.query<{ value: unknown }>(
      "SELECT last_seen_at_ms AS value FROM meshcore_public.nodes LIMIT 1",
    );
    expect(typeof result.rows[0]!.value).toBe("string");
    expect(() => Number(result.rows[0]!.value)).not.toThrow();
  });

  it("returns count(*)::text as string and plain integer as number", async () => {
    const counted = await pool.query<{ text_count: unknown; int_count: unknown }>(
      "SELECT count(*)::text AS text_count, count(*)::int AS int_count FROM meshcore_public.packets",
    );
    expect(typeof counted.rows[0]!.text_count).toBe("string");
    expect(typeof counted.rows[0]!.int_count).toBe("number");
  });

  it("returns boolean, text and NULL natively", async () => {
    const result = await pool.query<{
      flag: unknown;
      label: unknown;
      missing: unknown;
    }>("SELECT true AS flag, 'meshat'::text AS label, NULL::text AS missing");
    expect(result.rows[0]!.flag).toBe(true);
    expect(result.rows[0]!.label).toBe("meshat");
    expect(result.rows[0]!.missing).toBeNull();
  });

  it("returns bytea as Buffer with identical bytes to packet raw hex output", async () => {
    const result = await pool.query<{ blob: unknown }>(
      "SELECT raw_packet_blob AS blob FROM meshcore_public.packets WHERE decode_status = 'decoded' LIMIT 1",
    );
    const blob = result.rows[0]!.blob;
    expect(Buffer.isBuffer(blob)).toBe(true);
    const hex = `0x${(blob as Buffer).toString("hex")}`;
    expect(hex).toStartWith("0x");
  });

  it("returns double precision as numbers including PostGIS derivations", async () => {
    const result = await pool.query<{ snr: unknown; x: unknown; y: unknown }>(
      "SELECT -12.5::double precision AS snr, public.ST_X(n.location::public.geometry) AS x, public.ST_Y(n.location::public.geometry) AS y FROM meshcore_public.nodes n WHERE n.location IS NOT NULL LIMIT 1",
    );
    expect(result.rows[0]!.snr).toBe(-12.5);
    expect(typeof result.rows[0]!.x).toBe("number");
    expect(typeof result.rows[0]!.y).toBe("number");
  });

  it("returns text[] arrays", async () => {
    const result = await pool.query<{ tags: unknown }>("SELECT ARRAY['JKG','GOT']::text[] AS tags");
    expect(result.rows[0]!.tags).toEqual(["JKG", "GOT"]);
  });
});
