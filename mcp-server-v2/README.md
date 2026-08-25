# Meshat.se MCP-V2

Meshat.se MCP-V2 is the public, anonymous, read-only MCP interface for Meshat.se. It serves stateless Streamable HTTP only at `POST /mcp` and exposes process health at `GET /healthz` and REST-backed readiness at `GET /readyz`. `/healthz` reports `release_id` (`MCP_RELEASE_ID` if set, otherwise the package version) and `build_sha` (`MCP_BUILD_SHA`, the git commit injected at deploy time; `null` when not provided). `/readyz` reports this service's release id plus the REST release id, schema version, and schema fingerprint so REST/MCP deployment drift is observable from a fresh session. At startup the service logs one observability line with service name, version, release id, build SHA, protocol generation (`2026-07-28`), tool count, and a deterministic `tool_schema_sha256` fingerprint over the full tool manifest, making manifest drift between deployments visible from a single log line. Other `/mcp` methods receive a JSON-RPC-compatible `405` with `Allow: POST`, and malformed JSON receives a sanitized JSON-RPC parse error.

## Architecture

The service has one backend setting:

```dotenv
REST_API_BASE_URL=http://restful-api:8080
```

Every tool reads data or documentation through the Meshat.se REST API under `/v1`. This service has no PostgreSQL client or credentials, does not clone documentation, does not implement authentication, and has no write operations. REST remains the sole data and domain authority.

Optional process settings:

```dotenv
MCP_HOST=0.0.0.0
MCP_PORT=3001
REST_API_TIMEOUT_MS=8000
MCP_ALLOWED_HOSTS=mcp.meshat.se,mcp-v2,localhost,127.0.0.1,[::1]
MCP_ALLOWED_ORIGINS=mcp.meshat.se,localhost,127.0.0.1,[::1]
MCP_TRUST_PROXY=false
MCP_RATE_LIMIT_ENABLED=true
MCP_RATE_LIMIT_MAX=120
MCP_RATE_LIMIT_WINDOW_MS=60000
```

`REST_API_TIMEOUT_MS` must be an integer from 100 through 120000. `MCP_TRUST_PROXY` accepts only `false`, `true`, or one IPv4/IPv6 CIDR and defaults to `false`; configure it only for a known reverse proxy so rate-limit client addresses cannot be forged. Rate-limit maximum and window are validated bounded integers. Rate limiting applies to `/mcp` but not `/healthz` or `/readyz`. Host and Origin allowlists contain hostnames only, without schemes, ports, paths, or wildcards. Requests without an `Origin` header remain valid for non-browser MCP clients; a supplied Origin must be allowed. Production deployments must include the public reverse-proxy hostname in both configured lists where applicable. No API key, bearer token, login, or database variables are accepted.

## Protocol Support

This service is native MCP TypeScript SDK V2 and serves only protocol `2026-07-28`. Runtime packages are pinned to:

- `@modelcontextprotocol/server@2.0.0`
- `@modelcontextprotocol/fastify@2.0.0`
- `@modelcontextprotocol/node@2.0.0`
- `@fastify/rate-limit@11.2.0`
- `zod@4.2.0`

Tests use `@modelcontextprotocol/client@2.0.0` with negotiation pinned to `2026-07-28`. The old monolithic V1 SDK is not installed. `createMcpHandler` runs with `legacy: 'reject'`: 2025-era initialize requests receive protocol error `-32022`, no legacy server is constructed, and there is no fallback or dual-era serving.

The official `createMcpHandler` factory creates a fresh `McpServer` for every modern HTTP request and is adapted to Fastify through `toNodeHandler`. The tool set is static per deployment, so the server advertises `capabilities.tools.listChanged: false` through the public capabilities API and emits no list-changed notifications. The `/mcp` endpoint is stateless: it emits no session ID and keeps no pagination or client session state. Paginated collection-tool cursors are opaque REST cursors passed through unchanged, so continuation works across fresh clients and service instances. `get_node_neighbors` reflects its non-paginated REST endpoint and accepts no `limit` or `cursor`.

Raw tool discovery is pinned by tests: `tests/manifest.test.ts` connects fresh official-SDK clients over real Streamable HTTP and requires byte-identical normalized manifests across repeated sessions, an unchanged manifest after tool calls, the exact 23-domain-tool set with no table/SQL tools, and the critical current schemas (logical `lp_` message IDs, `search_packets.logical_id`, the `list_regions` catalog arguments, no activity region filter). A deployed instance can be smoke-tested read-only with `MCP_LIVE_BASE_URL=https://… bun run test:live`, which asserts the same discovery invariants and three representative calls.

The `/mcp` route uses the official Fastify Host and Origin validation integrations. It is public and anonymous after those request-origin protections; no authorization or legacy compatibility middleware exists.

Successful tool calls return both JSON text content and `structuredContent`. Every tool advertises and validates an explicit semantic `outputSchema`: Node, Observer, Region, IATA, Packet, LogicalMessage, Telemetry, Trace, Stats, ActivityBucket, Source/Overview, and Neighbor resources each have their own schema. Paginated domain collections backed by REST `{data,pagination}` responses normalize to `{items,next_cursor}` with per-item validation; detail tools unwrap and validate the REST `data` envelope into the plain resource object; activity buckets normalize to `{items,next_cursor:null}` because the bounded series is not paginated. If a REST response violates a resource schema, the tool returns `isError` with code `UPSTREAM_CONTRACT_ERROR` instead of passing invalid data through. Documentation tools instead use tool-specific response validation and direct outputs: `list_docs` returns source metadata and `files`, `search_docs` returns explicit scan/result metadata and `results` without `next_cursor`, and `get_doc` returns one UTF-8 document.

MCP independently rejects malformed REST documentation responses containing non-public paths, binary or mismatched media types, base64 encoding, content over 65536 UTF-8 bytes, invalid index ordering, cursor-like search fields, or inconsistent search metadata. This is defense in depth; REST remains the documentation authority. Error results omit `structuredContent` and return `isError: true` with a safe JSON text envelope containing REST `code`, `message`, and `request_id` when supplied. Fastify request IDs are propagated through the V2 request into REST, client cancellation is combined with the REST timeout, and operational REST failures log only tool name, code, status, and request ID. Timeouts, cancellation, unavailable REST, rate limiting, invalid cursors, missing resources, and unavailable documentation have distinct error codes.

## Domain Tools

| Tool                    | REST operation                                  |
| ----------------------- | ----------------------------------------------- |
| `list_sources`          | `GET /v1/sources`                               |
| `get_source`            | `GET /v1/meshcore`                              |
| `get_meshcore_overview` | `GET /v1/meshcore`                              |
| `search_nodes`          | `GET /v1/meshcore/nodes`                        |
| `get_node`              | `GET /v1/meshcore/nodes/{public_key}`           |
| `get_node_neighbors`    | `GET /v1/meshcore/nodes/{public_key}/neighbors` |
| `search_observers`      | `GET /v1/meshcore/observers`                    |
| `get_observer`          | `GET /v1/meshcore/observers/{public_key}`       |
| `list_regions`          | `GET /v1/meshcore/regions`                      |
| `get_region`            | `GET /v1/meshcore/regions/{region}`             |
| `list_iata`             | `GET /v1/meshcore/iata`                         |
| `get_iata`              | `GET /v1/meshcore/iata/{code}`                  |
| `search_packets`        | `GET /v1/meshcore/packets`                      |
| `get_packet`            | `GET /v1/meshcore/packets/{sha256}`             |
| `search_messages`       | `GET /v1/meshcore/messages`                     |
| `get_message`           | `GET /v1/meshcore/messages/{id}`                |
| `search_telemetry`      | `GET /v1/meshcore/telemetry`                    |
| `search_traces`         | `GET /v1/meshcore/traces`                       |
| `get_meshcore_stats`    | `GET /v1/meshcore/stats`                        |
| `get_meshcore_activity` | `GET /v1/meshcore/activity`                     |
| `list_docs`             | `GET /v1/docs`                                  |
| `search_docs`           | `GET /v1/docs/search`                           |
| `get_doc`               | `GET /v1/docs/{path...}`                        |

Tools expose only endpoint-specific documented filters. Public keys and packet hashes require 64 hexadecimal characters, logical IDs use the required `lp_` prefix followed by 64 hexadecimal characters accepted in either case and normalized to lowercase (advertised and runtime patterns are identical), `search_packets` accepts `logical_id` to list all packet variants of one logical message, IATA codes require three letters and normalize to uppercase, sort values are allowlisted, path segments reject `.` and `..` before encoding, timestamps require ISO 8601 with an offset, and collection limits are bounded. `list_regions` is a bounded catalog with `limit`/`cursor`, `observed_only`, `manually_added`, and `prefix`. `get_meshcore_activity` accepts only `window`, `interval`, and geographic `iata`; there is no region argument because per-observation region attribution does not exist in the data model. Geographic node/observer searches require `near_lat`, `near_lon`, and `radius_km` together. Text maxima mirror REST: node/observer names 100, roles and packet filter strings 50, regions 100, message channels and channel names 100, message types 50, telemetry metrics and trace tags 100, and documentation queries 200. `search_messages` defaults to 50 and has a hard maximum of 200. Documentation search defaults to 20 and has a hard maximum of 50, reports scan completeness/truncation explicitly, and has no cursor.

IATA and MeshCore regions are deliberately separate concepts. IATA identifies three-letter geographic MQTT ingress areas such as `JKG`, while a MeshCore region is a logical neighbor-reporting region. Tool names and descriptions preserve that distinction.

## Development

Requires Bun 1.4.0 (pinned via `packageManager`).

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun start
```

Production executes the TypeScript sources directly with Bun (`bun src/main.ts`); there is no compiled `dist` artifact. Tests use the modular V2 client pinned to protocol `2026-07-28` over real Streamable HTTP and a mock REST server.

Build the non-root production container locally with:

```bash
docker build -t meshat-mcp-v2 .
```
