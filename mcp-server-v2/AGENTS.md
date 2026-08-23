# MCP-V2 — OpenCode Instructions

These instructions apply inside `mcp-server-v2/` and supplement the root `AGENTS.md`.

Read root `PROMPT.md` and `API-CONTRACT.md` first.

## Purpose

Implement the official public anonymous:

```text
Meshat.se MCP-V2
```

Use the official Model Context Protocol TypeScript SDK and the stable 2026-07-28 protocol generation/current corresponding SDK.

Expose MCP over:

```text
/mcp
```

Also expose process health/readiness routes as specified by the root requirements.

## REST-only backend

MCP must use:

```text
REST_API_BASE_URL
```

for all Meshat.se data and documentation.

MCP must not:

- connect to PostgreSQL
- receive DB credentials
- clone the docs repository
- implement SQL
- duplicate domain query logic

REST is the authoritative backend.

## Domain tools only

Good tools include:

```text
list_sources
get_source
get_meshcore_overview
search_nodes
get_node
get_node_neighbors
search_observers
get_observer
list_regions
get_region
list_iata
get_iata
search_packets
get_packet
search_messages
get_message
search_telemetry
search_traces
get_meshcore_stats
get_meshcore_activity
list_docs
search_docs
get_doc
```

Forbidden tools include:

```text
list_tables
describe_table
query_table
run_sql
execute_sql
```

Tool descriptions must explain Meshat.se concepts clearly, especially the distinction between IATA and MeshCore regions.

## Stateless behavior

Do not depend on sticky sessions or server-side pagination state.

For large list tools:

- accept `limit`
- accept optional opaque `cursor`
- pass the cursor through to REST
- return REST's `next_cursor`

A subsequent request must be able to land on another MCP instance and still work.

## Docs tools

Implement:

```text
list_docs
search_docs
get_doc
```

by calling the REST `/v1/docs` API.

Do not expose repository filesystem paths or clone metadata beyond what REST intentionally returns.

## Error handling

Translate REST errors into useful MCP tool errors without exposing internal implementation details.

Handle:

- REST unavailable
- timeout
- rate limit
- invalid cursor
- not found
- docs unavailable

without crashing the MCP process.

## Security

The MCP server is public and anonymous.

Do not add API keys, JWT, OAuth or login.

All tools are read-only.
