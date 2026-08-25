import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { PROTOCOL_GENERATION } from "../src/server.js";
import { toolSchemaFingerprint, TOOL_NAMES } from "../src/tools.js";
import { createRestClient } from "../src/rest.js";

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

type MockHandler = (request: RecordedRequest) => { status?: number; body?: unknown };

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
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body ?? { data: {} }));
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

async function startApp(restUrl: string): Promise<{ app: FastifyInstance; origin: string }> {
  const app = buildServer({
    restClient: createRestClient({ baseUrl: restUrl, timeoutMs: 1000 }),
    logger: false,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const close = async () => app.close().catch(() => undefined);
  cleanups.push(close);
  return { app, origin: `http://127.0.0.1:${port}` };
}

/** One fresh official-client session over real Streamable HTTP. */
async function rawToolsList(origin: string): Promise<{
  tools: Array<Record<string, unknown>>;
  capabilities: Record<string, unknown> | undefined;
  serverVersion: string | undefined;
}> {
  const client = new Client(
    { name: "meshat-manifest-probe", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: PROTOCOL_GENERATION } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));
  await client.connect(transport);
  try {
    const result = await client.listTools();
    return {
      tools: result.tools as unknown as Array<Record<string, unknown>>,
      capabilities: client.getServerCapabilities() as Record<string, unknown> | undefined,
      serverVersion: client.getServerVersion()?.version,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic full-manifest normalization: sorted names + stable JSON. */
function normalizeManifest(tools: Array<Record<string, unknown>>): {
  names: string[];
  entries: string[];
} {
  const sorted = [...tools].sort((left, right) =>
    String(left.name) < String(right.name) ? -1 : String(left.name) > String(right.name) ? 1 : 0,
  );
  return {
    names: sorted.map((tool) => String(tool.name)),
    entries: sorted.map((tool) => canonicalJson(tool)),
  };
}

const key = "a".repeat(64);
const hash = "b".repeat(64);
const messageId = `lp_${"d".repeat(64)}`;
const stamp = "2026-08-24T00:00:00.000Z";

function domainFixture(urlText: string): { body: unknown } {
  const url = new URL(urlText, "http://rest.test");
  const path = url.pathname;
  if (path === "/v1/meshcore/messages")
    return { body: { data: [], pagination: { limit: 50, has_more: false, next_cursor: null } } };
  if (path === `/v1/meshcore/messages/${messageId}`)
    return {
      body: {
        data: {
          id: messageId,
          representative_packet_sha256: hash,
          type: "text",
          channel: "1",
          channel_index: 1,
          channel_name: "Public",
          sender: key,
          destination: null,
          encrypted: false,
          text: "hello",
          signature_valid: true,
          iata: ["GOT"],
          observation_count: 3,
          matched: { iata: ["GOT"], observation_count: 2 },
          reported_at: stamp,
          first_received_at: stamp,
          last_received_at: stamp,
        },
      },
    };
  if (path === "/v1/meshcore/regions")
    return {
      body: {
        data: [
          {
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
          },
        ],
        pagination: { next_cursor: null },
      },
    };
  throw new Error(`No fixture for ${path}`);
}

function inputProperties(tool: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const schema = tool.inputSchema as { properties?: Record<string, Record<string, unknown>> };
  return schema.properties ?? {};
}

describe("raw MCP tool manifest", () => {
  it("is byte-identical across ten fresh official-client sessions", async () => {
    const rest = await startMockRest(() => ({ body: { data: [] } }));
    const { origin } = await startApp(rest.url);

    const seen = new Map<string, number>();
    let referenceNames: string[] | undefined;
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const { tools } = await rawToolsList(origin);
      const manifest = normalizeManifest(tools);
      referenceNames ??= manifest.names;
      expect(manifest.names, `iteration ${iteration}`).toEqual(referenceNames);
      for (const entry of manifest.entries) seen.set(entry, (seen.get(entry) ?? 0) + 1);
    }
    // Every normalized per-tool entry appeared exactly once per session.
    for (const [entry, count] of seen) expect(count, entry.slice(0, 80)).toBe(10);
    expect(seen.size).toBe(TOOL_NAMES.length);
  });

  it("keeps the exact intended static tool set with no database tools", async () => {
    const rest = await startMockRest(() => ({ body: { data: [] } }));
    const { origin } = await startApp(rest.url);
    const { tools } = await rawToolsList(origin);

    expect(tools.map((tool) => tool.name)).toHaveLength(23);
    expect(normalizeManifest(tools).names).toEqual([...TOOL_NAMES].sort());
    const forbidden = ["list_tables", "describe_table", "query_table", "run_sql", "execute_sql"];
    for (const name of forbidden) expect(tools.map((tool) => tool.name)).not.toContain(name);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
  });

  it("advertises the critical current tool schemas and never the retired ones", async () => {
    const rest = await startMockRest(() => ({ body: { data: [] } }));
    const { origin } = await startApp(rest.url);
    const { tools, capabilities, serverVersion } = await rawToolsList(origin);
    const byName = new Map(tools.map((tool) => [String(tool.name), tool]));

    expect(serverVersion).toBe("2.0.0");
    expect((capabilities?.tools as { listChanged?: boolean } | undefined)?.listChanged).toBe(false);

    const getMessage = byName.get("get_message")!;
    const messageInput = inputProperties(getMessage);
    expect((getMessage.inputSchema as { required?: string[] }).required).toContain("id");
    expect(messageInput.id?.pattern).toBe("^lp_[0-9a-fA-F]{64}$");
    expect(new RegExp(String(messageInput.id?.pattern)).test(`lp_${"D".repeat(64)}`)).toBe(true);
    expect(new RegExp(String(messageInput.id?.pattern)).test(messageId.toUpperCase())).toBe(false);
    expect(String(messageInput.id?.pattern)).not.toBe("^\\d+$");
    expect(new RegExp(String(messageInput.id?.pattern)).test("12345")).toBe(false);
    const messageOutputId = (
      getMessage.outputSchema as { properties?: Record<string, { pattern?: string }> }
    ).properties?.id;
    expect(messageOutputId?.pattern).toBe("^lp_[0-9a-f]{64}$");

    const searchPackets = byName.get("search_packets")!;
    expect(inputProperties(searchPackets).logical_id?.pattern).toBe("^lp_[0-9a-fA-F]{64}$");

    const listRegions = byName.get("list_regions")!;
    const regionArgs = Object.keys(inputProperties(listRegions));
    for (const expected of ["observed_only", "manually_added", "prefix", "limit", "cursor"]) {
      expect(regionArgs, `list_regions.${expected}`).toContain(expected);
    }

    const activity = byName.get("get_meshcore_activity")!;
    const activityArgs = Object.keys(inputProperties(activity));
    expect(activityArgs).not.toContain("region");
    for (const expected of ["window", "interval", "iata"]) {
      expect(activityArgs).toContain(expected);
    }
    expect(String(activity.description)).toContain("no region filter");

    const searchNodes = byName.get("search_nodes")!;
    const nodeArgs = Object.keys(inputProperties(searchNodes));
    for (const expected of ["region", "seen_from", "seen_to"]) {
      expect(nodeArgs, `search_nodes.${expected}`).toContain(expected);
    }

    const searchObservers = byName.get("search_observers")!;
    expect(Object.keys(inputProperties(searchObservers))).toContain("region");
    expect(String(searchObservers.description)).toContain("own public key");

    expect(toolSchemaFingerprint()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not vary after tool calls within or across sessions", async () => {
    const rest = await startMockRest((request) => domainFixture(request.url));
    const { origin } = await startApp(rest.url);

    const client = new Client(
      { name: "meshat-manifest-probe", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: PROTOCOL_GENERATION } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`));
    await client.connect(transport);

    const before = normalizeManifest((await client.listTools()).tools as never);
    await client.callTool({ name: "search_messages", arguments: { limit: 5 } });
    const afterMessages = normalizeManifest((await client.listTools()).tools as never);
    await client.callTool({ name: "list_regions", arguments: { observed_only: true } });
    const afterRegions = normalizeManifest((await client.listTools()).tools as never);
    await client.callTool({ name: "get_message", arguments: { id: messageId.toUpperCase() } });
    const afterDetail = normalizeManifest((await client.listTools()).tools as never);

    expect(afterMessages.entries).toEqual(before.entries);
    expect(afterRegions.entries).toEqual(before.entries);
    expect(afterDetail.entries).toEqual(before.entries);

    const freshSession = await rawToolsList(origin);
    expect(normalizeManifest(freshSession.tools).entries).toEqual(before.entries);

    await client.close().catch(() => undefined);
  });

  it("exposes build identity from package version plus injected SHA", async () => {
    const rest = await startMockRest(() => ({ body: { data: [] } }));
    const { app } = await startApp(rest.url);
    const health = await app.inject("/healthz");
    expect(health.json()).toEqual({
      status: "ok",
      release_id: "2.0.0",
      build_sha: null,
    });
  });
});
