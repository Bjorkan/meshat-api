// Live smoke test for a deployed Meshat.se MCP-V2 instance.
//
// Usage: MCP_LIVE_BASE_URL=https://mcp.meshat.se bun run test:live
//
// Skipped unless MCP_LIVE_BASE_URL is set. Strictly read-only: it runs
// initialize, tools/list, and three representative domain calls through the
// official MCP client over Streamable HTTP and never mutates anything.

const baseUrl = process.env.MCP_LIVE_BASE_URL;

if (!baseUrl) {
  console.log("SKIP: set MCP_LIVE_BASE_URL to run the live MCP smoke test.");
  process.exit(0);
}

const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");

const PINNED_GENERATION = "2026-07-28";

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) fail(message);
  return condition;
}

const client = new Client(
  { name: "meshat-live-smoke", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: PINNED_GENERATION } } },
);
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl.replace(/\/+$/, "")}/mcp`));

try {
  await client.connect(transport);
  const serverInfo = client.getServerVersion();
  const capabilities = client.getServerCapabilities();
  console.log(
    `connected: server=${serverInfo?.name} version=${serverInfo?.version} protocol=${client.getNegotiatedProtocolVersion()}`,
  );
  assert(
    capabilities?.tools?.listChanged === false,
    "capabilities.tools.listChanged should be false for a static tool set",
  );

  const discovered = await client.listTools();
  const names = discovered.tools.map((tool) => tool.name);
  assert(names.length === 23, `expected 23 tools, found ${names.length}`);
  assert(names.includes("get_message"), "get_message missing");
  assert(names.includes("list_regions"), "list_regions missing");
  assert(!names.some((name) => /table|sql/i.test(name)), "database-style tool advertised");

  const schemaOf = (name) => discovered.tools.find((tool) => tool.name === name)?.inputSchema ?? {};
  const messageIdPattern =
    schemaOf("get_message").properties?.id?.pattern ??
    schemaOf("get_message").properties?.id?.anyOf?.[0]?.pattern;
  assert(
    messageIdPattern === "^lp_[0-9a-fA-F]{64}$",
    `get_message id pattern is stale: ${String(messageIdPattern)}`,
  );
  assert(
    "logical_id" in schemaOf("search_packets").properties,
    "search_packets.logical_id missing",
  );
  const regionArgs = Object.keys(schemaOf("list_regions").properties);
  for (const argument of ["observed_only", "manually_added", "prefix", "limit", "cursor"]) {
    assert(regionArgs.includes(argument), `list_regions.${argument} missing`);
  }
  assert(
    !("region" in schemaOf("get_meshcore_activity").properties),
    "activity still advertises region",
  );

  const messages = await client.callTool({ name: "search_messages", arguments: { limit: 3 } });
  assert(!messages.isError, `search_messages failed: ${JSON.stringify(messages.content)}`);
  const messageItems = messages.structuredContent?.items ?? [];
  console.log(`search_messages ok: ${messageItems.length} items`);

  // Follow the returned next_cursor through the MCP tool itself (stateless
  // pass-through to REST). This is the exact flow that exposed the production
  // REST cursor bug on page 2.
  const messagesNextCursor = messages.structuredContent?.next_cursor;
  if (typeof messagesNextCursor === "string" && messagesNextCursor.length > 0) {
    const messagesPage2 = await client.callTool({
      name: "search_messages",
      arguments: { limit: 3, cursor: messagesNextCursor },
    });
    assert(
      !messagesPage2.isError,
      `search_messages with cursor failed: ${JSON.stringify(messagesPage2.content)}`,
    );
    assert(
      messagesPage2.structuredContent && Array.isArray(messagesPage2.structuredContent.items),
      "search_messages with cursor: missing structured content",
    );
    const seen = new Set(messageItems.map((message) => message.id));
    for (const message of messagesPage2.structuredContent.items ?? []) {
      assert(!seen.has(message.id), `second message page repeated id ${message.id}`);
      seen.add(message.id);
    }
    console.log(
      `search_messages page 2 ok: ${(messagesPage2.structuredContent.items ?? []).length} items`,
    );
  } else {
    console.log("search_messages: no next_cursor on page 1, skipping second-page smoke");
  }

  const regions = await client.callTool({
    name: "list_regions",
    arguments: { observed_only: true, limit: 5 },
  });
  assert(!regions.isError, `list_regions failed: ${JSON.stringify(regions.content)}`);
  console.log(`list_regions ok: ${(regions.structuredContent?.items ?? []).length} items`);

  const stats = await client.callTool({ name: "get_meshcore_stats", arguments: {} });
  assert(!stats.isError, `get_meshcore_stats failed: ${JSON.stringify(stats.content)}`);
  console.log("get_meshcore_stats ok");

  console.log(process.exitCode === 1 ? "LIVE SMOKE FAILED" : "LIVE SMOKE PASSED");
} catch (error) {
  fail(String(error));
} finally {
  await client.close().catch(() => undefined);
}
