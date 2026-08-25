import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createRestClient, RestError } from "../src/rest.js";
import { buildServer, type BuildServerOptions } from "../src/server.js";
import { TOOL_NAMES } from "../src/tools.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

interface MockResponse {
  status?: number;
  body?: unknown;
  delayMs?: number;
}

type MockHandler = (request: RecordedRequest) => MockResponse;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startMockRest(handler: MockHandler) {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const recorded = {
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers: request.headers,
    };
    requests.push(recorded);
    const result = handler(recorded);
    const send = () => {
      response.writeHead(result.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(result.body ?? { data: { ok: true } }));
    };
    if (result.delayMs !== undefined) setTimeout(send, result.delayMs);
    else send();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const close = async () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  cleanups.push(close);
  return { url: `http://127.0.0.1:${port}`, requests, close };
}

async function startMcp(
  restUrl: string,
  timeoutMs = 1000,
  serverOptions: Omit<BuildServerOptions, "restClient"> = {},
) {
  const app = buildServer({
    ...serverOptions,
    restClient: createRestClient({ baseUrl: restUrl, timeoutMs }),
    logger: false,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const responseHeaders: Headers[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      responseHeaders.push(response.headers);
      return response;
    },
  });
  const client = new Client(
    { name: "meshat-mcp-v2-test", version: "2.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(transport);
  const close = async () => {
    await client.close().catch(() => undefined);
    await app.close().catch(() => undefined);
  };
  cleanups.push(close);
  return { app, client, transport, responseHeaders, close };
}

function lastRestUrl(requests: RecordedRequest[]): URL {
  const value = requests.at(-1)?.url;
  if (value === undefined) throw new Error("Expected a REST request");
  return new URL(value, "http://rest.test");
}

function expectQuery(url: URL, expected: Record<string, string>): void {
  expect(Object.fromEntries(url.searchParams)).toEqual(expected);
}

function docsResponse(requestUrl: string): { body: unknown } | undefined {
  const url = new URL(requestUrl, "http://rest.test");
  const source = {
    repository: "https://example.test/docs.git",
    ref: "main",
    commit: "abc",
  };
  if (url.pathname === "/v1/docs") {
    return {
      body: {
        data: { ...source, status: "fresh", files: [] },
      },
    };
  }
  if (url.pathname === "/v1/docs/search") {
    return {
      body: {
        data: {
          query: url.searchParams.get("q") ?? "docs",
          limit: Number(url.searchParams.get("limit") ?? 20),
          returned: 0,
          total_matches: 0,
          scan_complete: true,
          truncated: false,
          results: [],
        },
      },
    };
  }
  if (url.pathname.startsWith("/v1/docs/")) {
    const path = decodeURIComponent(url.pathname.slice("/v1/docs/".length));
    return {
      body: {
        data: {
          path,
          media_type: path === "meshtastic/example.yaml" ? "application/yaml" : "text/markdown",
          content: "# Documentation",
          encoding: "utf-8",
          source,
        },
      },
    };
  }
  return undefined;
}

function toolError(result: { content: unknown[] }): {
  error: { code: string; message: string; request_id?: string };
} {
  const first = result.content[0];
  if (
    first === null ||
    typeof first !== "object" ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error("Expected a text tool error");
  }
  return JSON.parse(first.text) as {
    error: { code: string; message: string; request_id?: string };
  };
}

const key = "a".repeat(64);
const hash = "b".repeat(64);
const messageId = `lp_${"d".repeat(64)}`;
const stamp = "2026-08-23T08:00:00.000Z";

const nodeFixture = {
  public_key: key,
  owner_public_key: null,
  name: "Node",
  role: "repeater",
  location: { latitude: 57.7, longitude: 14.1 },
  first_seen: stamp,
  last_seen: stamp,
  iata: ["JKG"],
  regions: ["se13"],
};
const observerFixture = {
  public_key: key,
  name: "Observer",
  active: true,
  iata: "JKG",
  regions: ["se13"],
  location: { latitude: 57.7, longitude: 14.1 },
  first_seen: stamp,
  last_seen: stamp,
};
const regionFixture = {
  region: "se13",
  name: "Hallands län",
  first_seen: stamp,
  last_seen: stamp,
  manually_added: true,
  observation_count: 2,
  node_count: 1,
  observer_count: 1,
  last_activity: stamp,
  links: {
    nodes: "/v1/meshcore/regions/se13/nodes",
    observers: "/v1/meshcore/observers?region=se13",
  },
};
const iataFixture = {
  code: "JKG",
  name: "Jönköping och södra Vätternområdet",
  type: "primary",
  primary_code: "JKG",
};
const packetFixture = {
  sha256: hash,
  logical_id: messageId,
  packet_type: "advert",
  payload_type: "node",
  route_type: "flood",
  decode_status: "decoded",
  raw: "0xa1b2c3",
  first_seen: stamp,
  last_seen: stamp,
};
const messageFixture = {
  id: messageId,
  representative_packet_sha256: hash,
  type: "text",
  channel: "1",
  channel_index: 1,
  channel_name: "Public",
  sender: key,
  destination: key,
  encrypted: false,
  text: "hello",
  signature_valid: true,
  iata: ["JKG"],
  observation_count: 2,
  matched: { iata: ["JKG"], observation_count: 1 },
  reported_at: stamp,
  first_received_at: stamp,
  last_received_at: stamp,
};
const telemetryFixture = {
  id: "1",
  packet_sha256: hash,
  node: key,
  metric: "battery",
  value: { type: "number", value: 3.7 },
  unit: "V",
  channel: "1",
  iata: "JKG",
  reported_at: stamp,
  received_at: stamp,
};
const traceFixture = {
  id: "1",
  packet_sha256: hash,
  logical_id: messageId,
  source_node: key,
  observer: key,
  tag: "route",
  iata: "JKG",
  reported_at: stamp,
  received_at: stamp,
};
const neighborFixture = {
  public_key: key,
  node: { name: "Peer", role: "repeater" },
  relationship: "reported",
  direction: "outbound",
  last_heard: stamp,
  signal: { snr: 8.5, rssi: -91 },
  regions: ["se13"],
  evidence: { report_count: 1, observer_count: 1 },
};
const statsFixture = {
  nodes: { known: 10, active_24h: 3 },
  observers: { known: 2, active: 1, active_window_seconds: 300 },
  regions: { configured: 312, observed: 9 },
  active_iata: 2,
  activity: { packets_24h: 100, messages_24h: 20, last_seen: stamp },
};
const activityFixture = {
  bucket_at: stamp,
  observations: 10,
  packets: 8,
  messages: 2,
};
const sourceFixture = {
  id: "meshcore",
  name: "MeshCore",
  description: "Information om MeshCore-nätverket i Sverige",
  status: "available",
  api_version: "v1",
  url: "/v1/meshcore",
  documentation_url: "/v1/docs",
  capabilities: ["nodes", "messages"],
};
const overviewFixture = {
  ...sourceFixture,
  resources: { nodes: "/v1/meshcore/nodes" },
};

function domainFixture(requestUrl: string): { body: unknown } {
  const url = new URL(requestUrl, "http://rest.test");
  const path = url.pathname;
  const list = (items: unknown[]) => ({
    body: { data: items, pagination: { next_cursor: null } },
  });
  const detail = (data: unknown) => ({ body: { data } });
  if (path === "/v1/sources") return list([sourceFixture]);
  if (path === "/v1/meshcore") return detail(overviewFixture);
  if (path === "/v1/meshcore/nodes") return list([nodeFixture]);
  if (path === "/v1/meshcore/observers") return list([observerFixture]);
  if (path === "/v1/meshcore/regions") return list([regionFixture]);
  if (path === "/v1/meshcore/iata") return list([iataFixture]);
  if (path === "/v1/meshcore/packets") return list([packetFixture]);
  if (path === "/v1/meshcore/messages") return list([messageFixture]);
  if (path === "/v1/meshcore/telemetry") return list([telemetryFixture]);
  if (path === "/v1/meshcore/traces") return list([traceFixture]);
  if (path === "/v1/meshcore/stats") return detail(statsFixture);
  if (path === "/v1/meshcore/activity") return list([activityFixture]);
  const segments = path.split("/").filter(Boolean);
  if (
    segments[0] === "v1" &&
    segments[1] === "meshcore" &&
    segments[2] === "nodes" &&
    segments.length === 4
  )
    return detail(nodeFixture);
  if (
    segments[0] === "v1" &&
    segments[1] === "meshcore" &&
    segments[2] === "nodes" &&
    segments.length === 5 &&
    segments[4] === "neighbors"
  )
    return list([neighborFixture]);
  if (
    segments[0] === "v1" &&
    segments[1] === "meshcore" &&
    segments[2] === "observers" &&
    segments.length === 4
  )
    return detail(observerFixture);
  if (
    segments[0] === "v1" &&
    segments[1] === "meshcore" &&
    segments[2] === "regions" &&
    segments.length === 4
  )
    return detail(regionFixture);
  if (
    segments[0] === "v1" &&
    segments[1] === "meshcore" &&
    segments[2] === "iata" &&
    segments.length === 4
  )
    return detail({
      ...iataFixture,
      summary: {
        node_count: 1,
        observer_count: 1,
        observation_count: 2,
        last_activity: stamp,
      },
      links: {
        nodes: "/v1/meshcore/nodes?iata=JKG",
        observers: "/v1/meshcore/observers?iata=JKG",
        activity: "/v1/meshcore/activity?iata=JKG",
      },
    });
  if (
    segments[0] === "v1" &&
    segments[1] === "meshcore" &&
    segments[2] === "packets" &&
    segments.length === 4
  )
    return detail(packetFixture);
  if (
    segments[0] === "v1" &&
    segments[1] === "meshcore" &&
    segments[2] === "messages" &&
    segments.length === 4
  )
    return detail(messageFixture);
  throw new Error(`No fixture for ${path}`);
}

function modernRequest(version: string) {
  return {
    jsonrpc: "2.0",
    id: 99,
    method: "tools/list",
    params: {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: version,
        [CLIENT_INFO_META_KEY]: { name: "raw-v2-test", version: "2.0.0" },
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  };
}

describe("official SDK integration", () => {
  it("is anonymous, healthy, and ready only when REST is ready", async () => {
    const rest = await startMockRest((request) =>
      request.url === "/readyz"
        ? {
            body: {
              data: {
                release_id: "1.0.0",
                schema_version: 9,
                schema_hash: "f".repeat(64),
              },
            },
          }
        : { body: { status: "ready" } },
    );
    const { app } = await startMcp(rest.url, 100);

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const ready = await app.inject({ method: "GET", url: "/readyz" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok", release_id: "2.0.0", build_sha: null });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: "ready",
      release_id: "2.0.0",
      rest: {
        release_id: "1.0.0",
        schema_version: 9,
        schema_hash: "f".repeat(64),
      },
    });
    expect(rest.requests.every(({ headers }) => headers.authorization === undefined)).toBe(true);

    await rest.close();
    const degraded = await app.inject({ method: "GET", url: "/readyz" });
    expect(degraded.statusCode).toBe(503);
    expect(degraded.json()).toMatchObject({
      error: { code: "NOT_READY" },
    });
  });

  it("allows only POST on /mcp and normalizes malformed JSON", async () => {
    const rest = await startMockRest(() => ({}));
    const { app } = await startMcp(rest.url);

    for (const method of ["GET", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/mcp" });
      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
      expect(response.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. Use POST." },
        id: null,
      });
    }

    const malformed = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: '{"jsonrpc":"2.0",',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
    expect(malformed.body).not.toContain("Unexpected");
    expect(malformed.body).not.toContain("Fastify");

    const empty = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: "",
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });

    const invalidMedia = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "text/plain" },
      payload: "not-json",
    });
    expect(invalidMedia.statusCode).toBe(415);
    expect(invalidMedia.json()).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message: "Content-Type must be application/json.",
      },
      id: null,
    });

    const tooLarge = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ value: "x".repeat(70 * 1024) }),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Request body exceeds the allowed size.",
      },
      id: null,
    });

    const rejectedHost = await app.inject({
      method: "GET",
      url: "/mcp",
      headers: { host: "attacker.invalid" },
    });
    expect(rejectedHost.statusCode).toBe(403);

    const rejectedOrigin = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "localhost",
        origin: "https://attacker.invalid",
        "content-type": "application/json",
      },
      payload: modernRequest("2026-07-28"),
    });
    expect(rejectedOrigin.statusCode).toBe(403);
  });

  it("rejects legacy initialize and modern version/header mismatches", async () => {
    const rest = await startMockRest(() => ({}));
    const { app } = await startMcp(rest.url);

    const legacyInitialize = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "1.0.0" },
        },
      },
    });
    expect(legacyInitialize.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32022 },
      id: 1,
    });
    expect(legacyInitialize.headers["mcp-session-id"]).toBeUndefined();

    const mismatch = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2099-01-01",
        "mcp-method": "tools/list",
      },
      payload: modernRequest("2026-07-28"),
    });
    expect(mismatch.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32020 },
      id: 99,
    });

    const unsupportedModern = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2099-01-01",
        "mcp-method": "tools/list",
      },
      payload: modernRequest("2099-01-01"),
    });
    expect(unsupportedModern.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32022 },
      id: 99,
    });
  });

  it("discovers exactly the domain tools with no generic query tools", async () => {
    const rest = await startMockRest(() => ({}));
    const consoleWarnings: unknown[][] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...values) => {
      consoleWarnings.push(values);
    });
    cleanups.push(() => warnSpy.mockRestore());
    const { client, transport, responseHeaders } = await startMcp(rest.url);

    const discovered = await client.listTools();
    const names = discovered.tools.map(({ name }) => name);

    expect(names).toEqual(TOOL_NAMES);
    expect(names).toHaveLength(23);
    expect(names).not.toContain("list_tables");
    expect(names).not.toContain("describe_table");
    expect(names).not.toContain("query_table");
    expect(names).not.toContain("run_sql");
    expect(names).not.toContain("execute_sql");
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect(transport.protocolVersion).toBe("2026-07-28");
    expect(transport.sessionId).toBeUndefined();
    expect(responseHeaders.every((headers) => !headers.has("mcp-session-id"))).toBe(true);
    for (const tool of discovered.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(tool.outputSchema).toMatchObject({ type: "object" });
    }
    const collection = discovered.tools.find(({ name }) => name === "search_nodes");
    expect(collection?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        items: { type: "array" },
        next_cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["items", "next_cursor"],
    });
    const detail = discovered.tools.find(({ name }) => name === "get_node");
    expect(detail?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        public_key: expect.any(Object),
        name: expect.any(Object),
        location: expect.any(Object),
        regions: { type: "array" },
      },
      required: expect.arrayContaining(["public_key", "name", "regions"]),
    });
    expect(detail?.outputSchema).not.toHaveProperty("data");
    const packet = discovered.tools.find(({ name }) => name === "get_packet");
    expect(packet?.outputSchema).toMatchObject({
      type: "object",
      properties: { sha256: expect.any(Object), raw: expect.any(Object) },
    });
    const stats = discovered.tools.find(({ name }) => name === "get_meshcore_stats");
    expect(stats?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        nodes: { type: "object" },
        observers: { type: "object" },
        regions: { type: "object" },
        activity: { type: "object" },
      },
    });
    const activity = discovered.tools.find(({ name }) => name === "get_meshcore_activity");
    expect(activity?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        items: { type: "array" },
        next_cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["items", "next_cursor"],
    });
    expect(
      (
        activity?.inputSchema as {
          properties?: Record<string, unknown>;
        }
      ).properties,
    ).not.toHaveProperty("region");
    const listDocs = discovered.tools.find(({ name }) => name === "list_docs");
    expect(listDocs?.outputSchema).toMatchObject({
      type: "object",
      properties: { files: { type: "array" }, status: expect.any(Object) },
      required: ["repository", "ref", "commit", "status", "files"],
    });
    const searchDocs = discovered.tools.find(({ name }) => name === "search_docs");
    expect(searchDocs?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        query: { type: "string" },
        results: { type: "array" },
        scan_complete: { type: "boolean" },
        truncated: { type: "boolean" },
      },
    });
    expect(
      (searchDocs?.outputSchema as { properties?: Record<string, unknown> }).properties,
    ).not.toHaveProperty("next_cursor");
    const getDoc = discovered.tools.find(({ name }) => name === "get_doc");
    expect(getDoc?.outputSchema).toMatchObject({
      type: "object",
      properties: {
        content: { type: "string" },
        encoding: { type: "string", const: "utf-8" },
      },
    });
    expect(consoleWarnings).toEqual([]);
    const getMessage = discovered.tools.find(({ name }) => name === "get_message");
    expect(
      (
        getMessage?.inputSchema as {
          properties?: Record<string, { pattern?: string }>;
        }
      ).properties?.id?.pattern,
    ).toBe("^lp_[0-9a-fA-F]{64}$");
    const searchPackets = discovered.tools.find(({ name }) => name === "search_packets");
    expect(
      (
        searchPackets?.inputSchema as {
          properties?: Record<string, { pattern?: string }>;
        }
      ).properties?.logical_id?.pattern,
    ).toBe("^lp_[0-9a-fA-F]{64}$");
    const neighbor = discovered.tools.find(({ name }) => name === "get_node_neighbors");
    const neighborProperties = (neighbor?.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(neighborProperties).toHaveProperty("public_key");
    expect(neighborProperties).not.toHaveProperty("limit");
    expect(neighborProperties).not.toHaveProperty("cursor");
  });

  it("advertises identical tool schemas across fresh client sessions", async () => {
    const rest = await startMockRest(
      (request) => docsResponse(request.url) ?? domainFixture(request.url),
    );
    const first = await startMcp(rest.url);
    const second = await startMcp(rest.url);
    const firstTools = await first.client.listTools();
    const secondTools = await second.client.listTools();
    const pick = (tools: typeof firstTools.tools, name: string) =>
      tools.find((tool) => tool.name === name);
    for (const name of ["get_message", "search_packets", "get_node"]) {
      const left = pick(firstTools.tools, name);
      const right = pick(secondTools.tools, name);
      expect(left, name).toBeDefined();
      expect(JSON.stringify(left?.outputSchema), name).toBe(JSON.stringify(right?.outputSchema));
      expect(JSON.stringify(left?.inputSchema), name).toBe(JSON.stringify(right?.inputSchema));
    }
    const getMessage = pick(firstTools.tools, "get_message");
    expect(
      (
        getMessage?.outputSchema as {
          properties?: Record<string, { pattern?: string }>;
        }
      ).properties?.id?.pattern,
    ).toBe("^lp_[0-9a-f]{64}$");
    const searchPackets = pick(firstTools.tools, "search_packets");
    expect(
      (
        searchPackets?.inputSchema as {
          properties?: Record<string, { pattern?: string }>;
        }
      ).properties?.logical_id?.pattern,
    ).toBe("^lp_[0-9a-fA-F]{64}$");
    const activity = pick(firstTools.tools, "get_meshcore_activity");
    expect(
      (activity?.inputSchema as { properties?: Record<string, unknown> }).properties,
    ).not.toHaveProperty("region");
  });

  it("maps every tool to the documented REST v1 domain endpoint", async () => {
    const rest = await startMockRest(
      (request) => docsResponse(request.url) ?? domainFixture(request.url),
    );
    const { client } = await startMcp(rest.url);
    const cases: Array<{
      name: string;
      args: Record<string, unknown>;
      path: string;
      query?: Record<string, string>;
    }> = [
      { name: "list_sources", args: {}, path: "/v1/sources" },
      { name: "get_source", args: {}, path: "/v1/meshcore" },
      { name: "get_meshcore_overview", args: {}, path: "/v1/meshcore" },
      {
        name: "search_nodes",
        args: {
          name: "Repeater",
          role: "repeater",
          region: "public",
          iata: "jkg",
          seen_from: "2026-08-20T12:00:00Z",
          near_lat: 57.7,
          near_lon: 14.1,
          radius_km: 25,
          sort: "last_seen",
          order: "desc",
          limit: 12,
          cursor: "node-cursor",
        },
        path: "/v1/meshcore/nodes",
        query: {
          name: "Repeater",
          role: "repeater",
          region: "public",
          iata: "JKG",
          seen_from: "2026-08-20T12:00:00Z",
          near_lat: "57.7",
          near_lon: "14.1",
          radius_km: "25",
          sort: "last_seen",
          order: "desc",
          limit: "12",
          cursor: "node-cursor",
        },
      },
      {
        name: "get_node",
        args: { public_key: key.toUpperCase() },
        path: `/v1/meshcore/nodes/${key}`,
      },
      {
        name: "get_node_neighbors",
        args: { public_key: key },
        path: `/v1/meshcore/nodes/${key}/neighbors`,
      },
      {
        name: "search_observers",
        args: {
          active: true,
          name: "Observer",
          iata: "got",
          region: "west",
          seen_to: "2026-08-23T08:00:00Z",
          near_lat: 57,
          near_lon: 12,
          radius_km: 10,
          sort: "name",
          order: "asc",
          limit: 8,
          cursor: "observer-cursor",
        },
        path: "/v1/meshcore/observers",
        query: {
          active: "true",
          name: "Observer",
          iata: "GOT",
          region: "west",
          seen_to: "2026-08-23T08:00:00Z",
          near_lat: "57",
          near_lon: "12",
          radius_km: "10",
          sort: "name",
          order: "asc",
          limit: "8",
          cursor: "observer-cursor",
        },
      },
      {
        name: "get_observer",
        args: { public_key: key },
        path: `/v1/meshcore/observers/${key}`,
      },
      {
        name: "list_regions",
        args: {
          observed_only: true,
          manually_added: false,
          prefix: "se13",
          limit: 7,
          cursor: "region-cursor",
        },
        path: "/v1/meshcore/regions",
        query: {
          observed_only: "true",
          manually_added: "false",
          prefix: "se13",
          limit: "7",
          cursor: "region-cursor",
        },
      },
      {
        name: "get_region",
        args: { region: "Europe/UK" },
        path: "/v1/meshcore/regions/Europe%2FUK",
      },
      { name: "list_iata", args: {}, path: "/v1/meshcore/iata" },
      {
        name: "get_iata",
        args: { code: "sto" },
        path: "/v1/meshcore/iata/STO",
      },
      {
        name: "search_packets",
        args: {
          hash: hash.toUpperCase(),
          logical_id: `lp_${"D".repeat(64)}`,
          packet_type: "advert",
          payload_type: "node",
          route_type: "flood",
          decode_status: "decoded",
          node: key,
          observer: key,
          iata: "jkg",
          received_from: "2026-08-20T12:00:00Z",
          sort: "first_seen",
          order: "desc",
          limit: 7,
          cursor: "packet-cursor",
        },
        path: "/v1/meshcore/packets",
        query: {
          hash,
          logical_id: messageId,
          packet_type: "advert",
          payload_type: "node",
          route_type: "flood",
          decode_status: "decoded",
          node: key,
          observer: key,
          iata: "JKG",
          received_from: "2026-08-20T12:00:00Z",
          sort: "first_seen",
          order: "desc",
          limit: "7",
          cursor: "packet-cursor",
        },
      },
      {
        name: "get_packet",
        args: { sha256: hash.toUpperCase() },
        path: `/v1/meshcore/packets/${hash}`,
      },
      {
        name: "search_messages",
        args: {
          sender: key,
          destination: key,
          channel: "1",
          channel_name: "Public",
          message_type: "text",
          encrypted: false,
          signature_valid: true,
          iata: "arn",
          received_to: "2026-08-23T08:00:00Z",
          sort: "received_at",
          order: "desc",
          limit: 17,
          cursor: "opaque+/= cursor",
        },
        path: "/v1/meshcore/messages",
        query: {
          sender: key,
          destination: key,
          channel: "1",
          channel_name: "Public",
          message_type: "text",
          encrypted: "false",
          signature_valid: "true",
          iata: "ARN",
          received_to: "2026-08-23T08:00:00Z",
          sort: "received_at",
          order: "desc",
          limit: "17",
          cursor: "opaque+/= cursor",
        },
      },
      {
        name: "get_message",
        args: { id: `lp_${"D".repeat(64)}` },
        path: `/v1/meshcore/messages/${messageId}`,
      },
      {
        name: "search_telemetry",
        args: {
          node: key,
          metric: "battery",
          iata: "jkg",
          received_from: "2026-08-20T12:00:00Z",
          sort: "received_at",
          order: "asc",
          limit: 6,
          cursor: "telemetry-cursor",
        },
        path: "/v1/meshcore/telemetry",
        query: {
          node: key,
          metric: "battery",
          iata: "JKG",
          received_from: "2026-08-20T12:00:00Z",
          sort: "received_at",
          order: "asc",
          limit: "6",
          cursor: "telemetry-cursor",
        },
      },
      {
        name: "search_traces",
        args: {
          source_node: key,
          tag: "route",
          iata: "got",
          received_to: "2026-08-23T08:00:00Z",
          sort: "received_at",
          order: "desc",
          limit: 5,
          cursor: "trace-cursor",
        },
        path: "/v1/meshcore/traces",
        query: {
          source_node: key,
          tag: "route",
          iata: "GOT",
          received_to: "2026-08-23T08:00:00Z",
          sort: "received_at",
          order: "desc",
          limit: "5",
          cursor: "trace-cursor",
        },
      },
      { name: "get_meshcore_stats", args: {}, path: "/v1/meshcore/stats" },
      {
        name: "get_meshcore_activity",
        args: { window: "24h", interval: "1h", iata: "jkg" },
        path: "/v1/meshcore/activity",
        query: { window: "24h", interval: "1h", iata: "JKG" },
      },
      { name: "list_docs", args: {}, path: "/v1/docs" },
      {
        name: "search_docs",
        args: { q: "getting started", limit: 13 },
        path: "/v1/docs/search",
        query: { q: "getting started", limit: "13" },
      },
      {
        name: "get_doc",
        args: { path: "mesh core/getting-started.md" },
        path: "/v1/docs/mesh%20core/getting-started.md",
      },
    ];

    for (const testCase of cases) {
      const result = await client.callTool({
        name: testCase.name,
        arguments: testCase.args,
      });
      expect(result.isError, testCase.name).not.toBe(true);
      expect(result.structuredContent, testCase.name).toBeDefined();
      const url = lastRestUrl(rest.requests);
      expect(url.pathname, testCase.name).toBe(testCase.path);
      expectQuery(url, testCase.query ?? {});
    }
  });

  it("passes opaque cursors unchanged to a fresh MCP instance", async () => {
    const opaqueCursor = "eyJ2IjoxLCJrIjoiKy89ID8ifQ==";
    const rest = await startMockRest((request) => {
      const url = new URL(request.url, "http://rest.test");
      return {
        body: {
          data: [],
          pagination: {
            has_more: !url.searchParams.has("cursor"),
            next_cursor: url.searchParams.has("cursor") ? null : opaqueCursor,
          },
        },
      };
    });
    const first = await startMcp(rest.url);
    const firstResult = await first.client.callTool({
      name: "search_messages",
      arguments: { limit: 2 },
    });
    expect(firstResult.structuredContent).toEqual({
      items: [],
      next_cursor: opaqueCursor,
    });
    await first.close();

    const second = await startMcp(rest.url);
    await second.client.callTool({
      name: "search_messages",
      arguments: { limit: 2, cursor: opaqueCursor },
    });
    expect(lastRestUrl(rest.requests).searchParams.get("cursor")).toBe(opaqueCursor);
  });

  it("returns safe text REST errors after output schemas are compiled", async () => {
    const rest = await startMockRest((request) => {
      const url = new URL(request.url, "http://rest.test");
      if (url.pathname === "/v1/sources") {
        return {
          status: 429,
          body: {
            error: {
              code: "RATE_LIMIT_EXCEEDED",
              message: "Slow down.",
              request_id: "req-rate",
            },
          },
        };
      }
      if (url.pathname === "/v1/docs/search") {
        return {
          status: 503,
          body: {
            error: {
              code: "DOCS_UNAVAILABLE",
              message: "Documentation cache is unavailable.",
              request_id: "req-docs",
            },
          },
        };
      }
      if (url.pathname === `/v1/meshcore/messages/${messageId}`) {
        return {
          status: 404,
          body: {
            error: {
              code: "NOT_FOUND",
              message: "Message not found.",
              request_id: "req-missing",
            },
          },
        };
      }
      return {
        status: 400,
        body: {
          error: {
            code: "INVALID_CURSOR",
            message: "The cursor is invalid for this query.",
            request_id: "req-cursor",
          },
        },
      };
    });
    const warningLogs: Array<{
      fields: Record<string, unknown>;
      message: string;
    }> = [];
    const { client } = await startMcp(rest.url, 1000, {
      operationalLogger: {
        info: () => undefined,
        warn: (fields, message) => warningLogs.push({ fields, message }),
      },
    });
    await client.listTools();
    const cases = [
      {
        name: "list_sources",
        arguments: {},
        code: "RATE_LIMIT_EXCEEDED",
        requestId: "req-rate",
      },
      {
        name: "search_docs",
        arguments: { q: "mesh" },
        code: "DOCS_UNAVAILABLE",
        requestId: "req-docs",
      },
      {
        name: "get_message",
        arguments: { id: messageId },
        code: "NOT_FOUND",
        requestId: "req-missing",
      },
      {
        name: "search_messages",
        arguments: { cursor: "bad" },
        code: "INVALID_CURSOR",
        requestId: "req-cursor",
      },
    ];

    for (const testCase of cases) {
      const result = await client.callTool(testCase);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(toolError(result)).toMatchObject({
        error: { code: testCase.code, request_id: testCase.requestId },
      });
    }
    expect(warningLogs).toContainEqual({
      fields: {
        tool: "list_sources",
        code: "RATE_LIMIT_EXCEEDED",
        status: 429,
        request_id: "req-rate",
      },
      message: "Meshat.se REST tool request failed",
    });
    expect(JSON.stringify(warningLogs)).not.toContain("Slow down");
  });

  it("reports timeout and unavailable REST without crashing", async () => {
    const slowRest = await startMockRest(() => ({ delayMs: 250 }));
    const slowMcp = await startMcp(slowRest.url, 100);
    const timeout = await slowMcp.client.callTool({
      name: "get_meshcore_stats",
      arguments: {},
    });
    expect(timeout.isError).toBe(true);
    expect(toolError(timeout)).toMatchObject({
      error: { code: "REST_TIMEOUT" },
    });

    const unavailableRest = await startMockRest(() => ({}));
    const deadUrl = unavailableRest.url;
    await unavailableRest.close();
    const unavailableMcp = await startMcp(deadUrl);
    const unavailable = await unavailableMcp.client.callTool({
      name: "get_meshcore_stats",
      arguments: {},
    });
    expect(unavailable.isError).toBe(true);
    expect(toolError(unavailable)).toMatchObject({
      error: { code: "REST_UNAVAILABLE" },
    });
  });

  it("rejects unsafe paths and over-limit message requests before REST", async () => {
    const rest = await startMockRest(() => ({}));
    const { client } = await startMcp(rest.url);
    const before = rest.requests.length;

    const unsafe = await client.callTool({
      name: "get_doc",
      arguments: { path: "../private.txt" },
    });
    expect(unsafe.isError).toBe(true);
    expect(toolError(unsafe)).toMatchObject({
      error: { code: "INVALID_ARGUMENT" },
    });
    const encodedTraversal = await client.callTool({
      name: "get_doc",
      arguments: { path: "%2e%2e/private.txt" },
    });
    expect(encodedTraversal.isError).toBe(true);
    expect(toolError(encodedTraversal)).toMatchObject({
      error: { code: "INVALID_ARGUMENT" },
    });
    const overLimit = await client.callTool({
      name: "search_messages",
      arguments: { limit: 201 },
    });
    expect(overLimit.isError).toBe(true);
    expect(overLimit.content[0]).toMatchObject({ type: "text" });
    expect(rest.requests).toHaveLength(before);
  });

  it("validates semantic resource schemas for collections and details", async () => {
    const rest = await startMockRest((request) => {
      const url = new URL(request.url, "http://rest.test");
      if (url.pathname === "/v1/sources") return { body: { data: [sourceFixture] } };
      if (url.pathname === "/v1/meshcore/nodes" && url.searchParams.get("name") === "badnode")
        return {
          body: {
            data: [{ public_key: key }],
            pagination: { next_cursor: null },
          },
        };
      if (url.pathname === "/v1/meshcore/nodes" && url.searchParams.get("cursor") === "paged")
        return {
          body: {
            data: [nodeFixture],
            pagination: {
              limit: 1,
              has_more: true,
              next_cursor: "next-page",
            },
          },
        };
      if (url.pathname.startsWith("/v1/meshcore/nodes/")) return { body: { data: nodeFixture } };
      return { body: { data: [] } };
    });
    const { client } = await startMcp(rest.url);

    const unpaginated = await client.callTool({
      name: "list_sources",
      arguments: {},
    });
    expect(unpaginated.structuredContent).toEqual({
      items: [sourceFixture],
      next_cursor: null,
    });

    const collection = await client.callTool({
      name: "search_nodes",
      arguments: { cursor: "paged" },
    });
    expect(collection.structuredContent).toEqual({
      items: [nodeFixture],
      next_cursor: "next-page",
    });
    expect(JSON.parse(String(collection.content[0]?.text))).toEqual(collection.structuredContent);

    const detail = await client.callTool({
      name: "get_node",
      arguments: { public_key: key },
    });
    expect(detail.structuredContent).toEqual(nodeFixture);
    expect(detail.structuredContent).not.toHaveProperty("data");

    const drift = await client.callTool({
      name: "search_nodes",
      arguments: { name: "badnode" },
    });
    expect(drift.isError).toBe(true);
    expect(toolError(drift)).toMatchObject({
      error: { code: "UPSTREAM_CONTRACT_ERROR" },
    });
  });

  it("normalizes documentation tools without inventing cursors", async () => {
    const rest = await startMockRest((request) => docsResponse(request.url) ?? {});
    const { client } = await startMcp(rest.url);

    const listed = await client.callTool({ name: "list_docs", arguments: {} });
    expect(listed.structuredContent).toMatchObject({
      repository: "https://example.test/docs.git",
      status: "fresh",
      files: [],
    });
    expect(listed.structuredContent).not.toHaveProperty("data");

    const searched = await client.callTool({
      name: "search_docs",
      arguments: { q: "mesh", limit: 7 },
    });
    expect(searched.structuredContent).toEqual({
      query: "mesh",
      limit: 7,
      returned: 0,
      total_matches: 0,
      scan_complete: true,
      truncated: false,
      results: [],
    });
    expect(searched.structuredContent).not.toHaveProperty("next_cursor");

    const document = await client.callTool({
      name: "get_doc",
      arguments: { path: "guide.md" },
    });
    expect(document.structuredContent).toMatchObject({
      path: "guide.md",
      media_type: "text/markdown",
      encoding: "utf-8",
      content: "# Documentation",
    });
    expect(document.structuredContent).not.toHaveProperty("data");
  });

  it("rejects malformed binary, base64, oversized, and cursor-like REST docs responses", async () => {
    const source = {
      repository: "https://example.test/docs.git",
      ref: "main",
      commit: "abc",
    };
    const rest = await startMockRest((request) => {
      const url = new URL(request.url, "http://rest.test");
      if (url.pathname === "/v1/docs/search") {
        return {
          body: {
            data: {
              query: "mesh",
              limit: 20,
              returned: 0,
              total_matches: 0,
              scan_complete: true,
              truncated: false,
              results: [],
              next_cursor: "must-not-exist",
            },
          },
        };
      }
      const path = decodeURIComponent(url.pathname.slice("/v1/docs/".length));
      if (path === "binary.md") {
        return {
          body: {
            data: {
              path,
              media_type: "image/png",
              content: "iVBORw0KGgo=",
              encoding: "utf-8",
              source,
            },
          },
        };
      }
      if (path === "base64.md") {
        return {
          body: {
            data: {
              path,
              media_type: "text/markdown",
              content: "IyBEb2N1bWVudA==",
              encoding: "base64",
              source,
            },
          },
        };
      }
      return {
        body: {
          data: {
            path,
            media_type: "text/markdown",
            content: "å".repeat(32_769),
            encoding: "utf-8",
            source,
          },
        },
      };
    });
    const { client } = await startMcp(rest.url);

    for (const call of [
      { name: "search_docs", arguments: { q: "mesh" } },
      { name: "get_doc", arguments: { path: "binary.md" } },
      { name: "get_doc", arguments: { path: "base64.md" } },
      { name: "get_doc", arguments: { path: "oversized.md" } },
    ]) {
      const result = await client.callTool(call);
      expect(result.isError, call.name).toBe(true);
      expect(toolError(result), call.name).toMatchObject({
        error: { code: "INVALID_REST_RESPONSE" },
      });
    }
  });

  it("accepts exact REST input boundaries", async () => {
    const rest = await startMockRest(
      (request) => docsResponse(request.url) ?? domainFixture(request.url),
    );
    const { client } = await startMcp(rest.url);
    const validCases: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }> = [
      {
        name: "search_nodes",
        arguments: {
          name: "n".repeat(100),
          role: "r".repeat(50),
          region: "r".repeat(100),
          near_lat: 57,
          near_lon: 14,
          radius_km: 1,
        },
      },
      {
        name: "search_observers",
        arguments: {
          name: "n".repeat(100),
          region: "r".repeat(100),
          near_lat: 57,
          near_lon: 14,
          radius_km: 1,
        },
      },
      {
        name: "search_packets",
        arguments: {
          packet_type: "p".repeat(50),
          payload_type: "p".repeat(50),
          route_type: "r".repeat(50),
          decode_status: "d".repeat(50),
          sort: "first_seen",
        },
      },
      {
        name: "search_messages",
        arguments: {
          destination: key,
          channel: "c".repeat(100),
          channel_name: "c".repeat(100),
          message_type: "m".repeat(50),
        },
      },
      { name: "get_message", arguments: { id: messageId } },
      {
        name: "search_packets",
        arguments: { logical_id: messageId, sort: "first_seen" },
      },
      {
        name: "search_telemetry",
        arguments: { metric: "m".repeat(100) },
      },
      { name: "search_traces", arguments: { tag: "t".repeat(100) } },
      { name: "search_docs", arguments: { q: "q".repeat(200) } },
      {
        name: "get_meshcore_activity",
        arguments: { iata: "JKG" },
      },
      { name: "get_region", arguments: { region: "r".repeat(100) } },
    ];

    for (const testCase of validCases) {
      const result = await client.callTool(testCase);
      expect(result.isError, testCase.name).not.toBe(true);
    }
    expect(rest.requests).toHaveLength(validCases.length);
  });

  it("enforces REST-aligned input formats and maxima before REST", async () => {
    const rest = await startMockRest(() => ({}));
    const { client } = await startMcp(rest.url);
    const before = rest.requests.length;
    const invalidCases: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }> = [
      { name: "search_nodes", arguments: { name: "n".repeat(101) } },
      { name: "search_nodes", arguments: { role: "r".repeat(51) } },
      { name: "search_nodes", arguments: { region: "r".repeat(101) } },
      { name: "search_observers", arguments: { name: "n".repeat(101) } },
      { name: "search_observers", arguments: { region: "r".repeat(101) } },
      { name: "search_packets", arguments: { packet_type: "p".repeat(51) } },
      { name: "search_packets", arguments: { payload_type: "p".repeat(51) } },
      { name: "search_packets", arguments: { route_type: "r".repeat(51) } },
      { name: "search_packets", arguments: { decode_status: "d".repeat(51) } },
      { name: "search_messages", arguments: { destination: "not-a-key" } },
      { name: "search_messages", arguments: { channel: "c".repeat(101) } },
      { name: "search_messages", arguments: { channel_name: "c".repeat(101) } },
      { name: "search_messages", arguments: { message_type: "m".repeat(51) } },
      { name: "get_message", arguments: { id: "message-42" } },
      { name: "get_message", arguments: { id: "a".repeat(64) } },
      { name: "search_packets", arguments: { logical_id: "a".repeat(64) } },
      { name: "search_packets", arguments: { logical_id: "message-42" } },
      { name: "search_telemetry", arguments: { metric: "m".repeat(101) } },
      { name: "search_traces", arguments: { tag: "t".repeat(101) } },
      { name: "search_docs", arguments: { q: "q".repeat(201) } },
      { name: "get_meshcore_activity", arguments: { region: "r".repeat(101) } },
      { name: "get_region", arguments: { region: "." } },
      { name: "get_region", arguments: { region: ".." } },
      { name: "search_nodes", arguments: { near_lat: 57 } },
      {
        name: "search_nodes",
        arguments: {
          seen_from: "2026-08-24T00:00:00Z",
          seen_to: "2026-08-23T00:00:00Z",
        },
      },
      {
        name: "search_messages",
        arguments: {
          received_from: "2026-08-24T00:00:00Z",
          received_to: "2026-08-23T00:00:00Z",
        },
      },
      {
        name: "search_observers",
        arguments: { near_lat: 57, near_lon: 14 },
      },
    ];

    for (const testCase of invalidCases) {
      const result = await client.callTool(testCase);
      expect(result.isError, testCase.name).toBe(true);
      if ("near_lat" in testCase.arguments) {
        expect(toolError(result), testCase.name).toMatchObject({
          error: { code: "INVALID_ARGUMENT" },
        });
      }
    }
    expect(rest.requests).toHaveLength(before);
  });

  it("rate limits MCP only and validates proxy/rate environment", async () => {
    const previous = {
      trust: process.env.MCP_TRUST_PROXY,
      enabled: process.env.MCP_RATE_LIMIT_ENABLED,
      max: process.env.MCP_RATE_LIMIT_MAX,
      window: process.env.MCP_RATE_LIMIT_WINDOW_MS,
    };
    const restore = () => {
      const values = {
        MCP_TRUST_PROXY: previous.trust,
        MCP_RATE_LIMIT_ENABLED: previous.enabled,
        MCP_RATE_LIMIT_MAX: previous.max,
        MCP_RATE_LIMIT_WINDOW_MS: previous.window,
      };
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };

    let app: ReturnType<typeof buildServer> | undefined;
    try {
      process.env.MCP_TRUST_PROXY = "127.0.0.1/32";
      process.env.MCP_RATE_LIMIT_ENABLED = "true";
      process.env.MCP_RATE_LIMIT_MAX = "1";
      process.env.MCP_RATE_LIMIT_WINDOW_MS = "1000";
      app = buildServer({
        logger: false,
        restClient: { get: async () => ({ status: "ready" }) },
      });
      cleanups.push(async () => app?.close());
      restore();

      const first = await app.inject({ method: "GET", url: "/mcp" });
      const limited = await app.inject({ method: "GET", url: "/mcp" });
      expect(first.statusCode).toBe(405);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32029 },
      });
      expect((await app.inject("/healthz")).statusCode).toBe(200);
      expect((await app.inject("/healthz")).statusCode).toBe(200);
      expect((await app.inject("/readyz")).statusCode).toBe(200);
      expect((await app.inject("/readyz")).statusCode).toBe(200);

      process.env.MCP_TRUST_PROXY = "not-a-cidr";
      expect(() =>
        buildServer({
          logger: false,
          restClient: { get: async () => ({}) },
        }),
      ).toThrow(/MCP_TRUST_PROXY/);
    } finally {
      restore();
    }
  });

  it("correlates Fastify request IDs to REST and combines cancellation", async () => {
    const rest = await startMockRest(() => ({ body: { data: [] } }));
    const { client } = await startMcp(rest.url);
    await client.callTool({ name: "list_sources", arguments: {} });
    expect(rest.requests.at(-1)?.headers["x-request-id"]).toMatch(/^req-\d+$/);

    const slowRest = await startMockRest(() => ({ delayMs: 250 }));
    const restClient = createRestClient({
      baseUrl: slowRest.url,
      timeoutMs: 1000,
    });
    const controller = new AbortController();
    const pending = restClient.get("/v1/sources", {
      requestId: "cancel-test",
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
    } satisfies Partial<RestError>);
    expect(slowRest.requests.at(-1)?.headers["x-request-id"]).toBe("cancel-test");
  });
});
