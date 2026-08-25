import { describe, expect, it } from "bun:test";
import {
  errorEnvelopeSchema,
  messageSchema,
  nodeSchema,
  paginationSchema,
  telemetryValueSchema,
  traceHopSchema,
} from "../src/contracts.js";

const validNode = {
  public_key: "A".repeat(64),
  owner_public_key: null,
  name: "Node",
  role: "repeater",
  location: { latitude: 57.7, longitude: 14.1 },
  first_seen: "2026-01-01T00:00:00.000Z",
  last_seen: "2026-01-02T00:00:00.000Z",
  iata: ["JKG"],
  regions: ["public"],
};

describe("node contract", () => {
  it("accepts a fully populated node", () => {
    const parsed = nodeSchema.parse(validNode);
    expect(parsed.name).toBe("Node");
    expect(parsed.location).toEqual({ latitude: 57.7, longitude: 14.1 });
  });

  it("strips undeclared internal fields (whitelist guarantee)", () => {
    const parsed = nodeSchema.parse({
      ...validNode,
      password: "secret",
      private_metadata: { nested: true },
    });
    expect(Object.keys(parsed)).not.toContain("password");
    expect(Object.keys(parsed)).not.toContain("private_metadata");
  });

  it("rejects a missing required public field", () => {
    const { public_key: _dropped, ...incomplete } = validNode;
    expect(() => nodeSchema.parse(incomplete)).toThrow();
  });

  it("treats nullable fields as present-but-null, not optional", () => {
    const parsed = nodeSchema.parse({ ...validNode, name: null, role: null });
    expect(parsed.name).toBeNull();
    expect("name" in parsed).toBe(true);
  });
});

describe("logical message contract", () => {
  const validMessage = {
    id: `lp_${"a".repeat(64)}`,
    representative_packet_sha256: "b".repeat(64),
    type: "TXT_MSG",
    channel: 0,
    channel_index: null,
    channel_name: "#meshat",
    sender: null,
    destination: null,
    encrypted: false,
    text: "hello",
    signature_valid: null,
    iata: ["JKG"],
    observation_count: 3,
    matched: { iata: ["JKG"], observation_count: 2 },
    reported_at: "2026-01-01T00:00:01.000Z",
    first_received_at: "2026-01-01T00:00:00.000Z",
    last_received_at: "2026-01-01T00:00:02.000Z",
  };

  it("accepts canonical fields with the matched object", () => {
    expect(messageSchema.parse(validMessage).matched.observation_count).toBe(2);
  });

  it("allows null sender/destination/text/signature", () => {
    const parsed = messageSchema.parse({
      ...validMessage,
      sender: null,
      destination: null,
      text: null,
      signature_valid: null,
    });
    expect(parsed.sender).toBeNull();
    expect(parsed.text).toBeNull();
  });

  it("enforces the logical id pattern", () => {
    expect(() => messageSchema.parse({ ...validMessage, id: "nope" })).toThrow();
  });
});

describe("telemetry typed value contract", () => {
  it("accepts number, boolean and string variants", () => {
    expect(telemetryValueSchema.parse({ type: "number", value: 4.1 }).type).toBe("number");
    expect(telemetryValueSchema.parse({ type: "boolean", value: true }).type).toBe("boolean");
    expect(telemetryValueSchema.parse({ type: "string", value: null }).value).toBeNull();
  });

  it("rejects mismatched variant payloads", () => {
    expect(() => telemetryValueSchema.parse({ type: "number", value: "4" })).toThrow();
  });
});

describe("trace hop contract", () => {
  it("keeps observer-facing ambiguity data", () => {
    const hop = traceHopSchema.parse({
      id: "1",
      index: 0,
      prefix_hex: "aabb",
      prefix_length_bytes: 2,
      snr: null,
      resolved_node: null,
      resolution_confidence: null,
      resolution_status: "ambiguous",
      candidates: [{ public_key: "A".repeat(64), confidence: 0.5 }],
    });
    expect(hop.candidates).toHaveLength(1);
  });
});

describe("error envelope contract", () => {
  it("requires request_id", () => {
    expect(() => errorEnvelopeSchema.parse({ error: { code: "X", message: "m" } })).toThrow();
    const parsed = errorEnvelopeSchema.parse({
      error: { code: "INVALID_ARGUMENT", message: "m", request_id: "r1" },
    });
    expect(parsed.error.request_id).toBe("r1");
  });
});

describe("pagination contract", () => {
  it("allows null next_cursor but requires limit and has_more", () => {
    expect(paginationSchema.parse({ limit: 50, has_more: false, next_cursor: null })).toBeDefined();
    expect(() => paginationSchema.parse({ has_more: false, next_cursor: null })).toThrow();
  });
});
