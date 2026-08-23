import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { decodeCursor, encodeCursor, queryFingerprint } from "../src/cursor.js";
import {
  aggregateNeighbors,
  mapAdvert,
  mapMessage,
  mapNode,
  mapPacket,
  mapPacketObservation,
  mapTelemetry,
} from "../src/mappers.js";

describe("configuration", () => {
  it("enforces the read-only role and bounded pool", () => {
    expect(() => loadConfig({ DATABASE_USER: "postgres" })).toThrow();
    expect(() => loadConfig({ DATABASE_POOL_MAX: "6" })).toThrow();
    expect(loadConfig({}).database.user).toBe("meshcore_http");
    expect(loadConfig({}).observerActiveWindowMs).toBe(300_000);
    expect(() => loadConfig({ OBSERVER_ACTIVE_WINDOW_MS: "86400001" })).toThrow();
  });
  it("rejects malformed numeric and boolean settings", () => {
    expect(() => loadConfig({ REST_PORT: "not-a-number" })).toThrow();
    expect(() => loadConfig({ TRUST_PROXY: "yes" })).toThrow();
    expect(loadConfig({ TRUST_PROXY: "10.0.2.0/24" }).trustProxy).toBe("10.0.2.0/24");
    expect(() => loadConfig({ API_DEFAULT_LIMIT: "200", API_MAX_LIMIT: "100" })).toThrow();
  });
  it("rejects credential-bearing documentation URLs and validates message limits", () => {
    expect(() =>
      loadConfig({
        DOCS_GIT_REPOSITORY: "https://user:secret@example.test/docs.git",
      }),
    ).toThrow(/must not contain/i);
    expect(() =>
      loadConfig({
        MESSAGE_DEFAULT_LIMIT: "20",
        MESSAGE_MAX_LIMIT: "10",
      }),
    ).toThrow(/message_default/i);
    expect(
      loadConfig({
        MESSAGE_DEFAULT_LIMIT: "7",
        MESSAGE_MAX_LIMIT: "9",
      }),
    ).toMatchObject({
      messageDefaultLimit: 7,
      messageMaxLimit: 9,
    });
    expect(loadConfig({}).docs.maxFileBytes).toBe(65_536);
    expect(() => loadConfig({ DOCS_MAX_FILE_BYTES: "65537" })).toThrow();
  });
});

describe("opaque stateless cursors", () => {
  it("round-trips versioned keysets and rejects query mismatch", () => {
    const cursor = encodeCursor(
      "messages",
      { filters: { iata: "JKG" }, sort: "received_at", order: "desc" },
      ["100", `lp_${"a".repeat(64)}`],
    );
    expect(
      decodeCursor(cursor, "messages", {
        filters: { iata: "JKG" },
        sort: "received_at",
        order: "desc",
      }),
    ).toEqual(["100", `lp_${"a".repeat(64)}`]);
    expect(() =>
      decodeCursor(cursor, "messages", {
        filters: { iata: "GOT" },
        sort: "received_at",
        order: "desc",
      }),
    ).toThrowError(/invalid/i);
    expect(() => decodeCursor("garbage", "messages", {})).toThrowError(/invalid/i);
  });
  it("rejects forged non-integer keysets before they reach PostgreSQL", () => {
    const query = { filters: {}, sort: "received_at", order: "desc" };
    for (const key of [
      ["1e3", "9"],
      ["100", "9.5"],
      ["NaN", "9"],
    ]) {
      const cursor = Buffer.from(
        JSON.stringify({
          v: 1,
          resource: "messages",
          query: queryFingerprint(query),
          key,
        }),
      ).toString("base64url");
      expect(() => decodeCursor(cursor, "messages", query)).toThrowError(/invalid/i);
    }
  });
});

describe("domain mappers", () => {
  it("encodes only MeshCore packet bytes as lowercase 0x hex", () => {
    const packet = mapPacket({
      packet_sha256: "hash",
      raw_packet_blob: Buffer.from([0xa1, 0xb2]),
      decode_status: "decoded",
      first_seen_at_ms: "0",
      last_seen_at_ms: "1",
    });
    expect(packet.raw).toBe("0xa1b2");
    expect(packet).not.toHaveProperty("mqtt_event_id");
  });
  it("normalizes bigint IDs, timestamps, and typed telemetry values", () => {
    const telemetry = mapTelemetry({
      id: 9n,
      packet_sha256: "hash",
      node_public_key: null,
      metric_name: "battery",
      numeric_value: 4.2,
      text_value: null,
      boolean_value: null,
      received_at_ms: "1000",
      reported_at_ms: null,
      iata: "JKG",
    });
    expect(telemetry).toMatchObject({
      id: "9",
      value: { type: "number", value: 4.2 },
      received_at: "1970-01-01T00:00:01.000Z",
    });
  });
  it("maps logical messages with canonical counts and query-scope matched evidence", () => {
    const message = mapMessage({
      logical_id: `lp_${"a".repeat(64)}`,
      packet_sha256: "b".repeat(64),
      message_type: "GRP_TXT",
      encrypted: false,
      total_observation_count: "4",
      all_iata: ["MMX", "RNB"],
      matched_observation_count: "1",
      matched_iata: ["RNB"],
      first_received_at_ms: "1000",
      last_received_at_ms: "2000",
    });
    expect(message).toMatchObject({
      id: `lp_${"a".repeat(64)}`,
      representative_packet_sha256: "b".repeat(64),
      observation_count: 4,
      iata: ["MMX", "RNB"],
      matched: { iata: ["RNB"], observation_count: 1 },
      first_received_at: "1970-01-01T00:00:01.000Z",
      last_received_at: "1970-01-01T00:00:02.000Z",
    });
    expect(message).not.toHaveProperty("packet_sha256");
  });
  it("normalizes public node, advert, and neighbor roles to lowercase", () => {
    expect(mapNode({ latest_role: "REPEATER" }).role).toBe("repeater");
    expect(mapAdvert({ id: 1, role: "ROOM", verified: true }).role).toBe("room");
    expect(
      aggregateNeighbors([
        {
          counterpart_public_key: "B".repeat(64),
          reporting_observer: "A".repeat(64),
          direction: "outbound",
          latest_role: "SENSOR",
          regions: [],
          received_at_ms: "1000",
        },
      ])[0]?.node.role,
    ).toBe("sensor");
  });
  it("preserves unresolved packet path topology as structured hops", () => {
    const observation = mapPacketObservation({
      id: "1",
      packet_sha256: "hash",
      observer: "observer",
      iata: "JKG",
      received_at_ms: "1000",
      reported_at_ms: null,
      rssi: null,
      snr: null,
      score: null,
      path: [
        {
          index: 0,
          prefix_hex: "a1",
          prefix_length_bytes: 1,
          resolved_node: null,
          resolution_status: "unresolved",
          resolution_confidence: null,
        },
      ],
    });
    expect(observation.path).toEqual([
      expect.objectContaining({
        index: 0,
        prefix_hex: "a1",
        resolved_node: null,
        resolution_status: "unresolved",
      }),
    ]);
  });
});
