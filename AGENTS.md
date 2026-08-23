# Meshat.se API Workspace — OpenCode Instructions

This workspace contains the official public Meshat.se REST API and MCP-V2 server.

## Read first, in this order

Before implementation work:

1. Read `PROMPT.md`.
2. Read `API-CONTRACT.md`.
3. Read `TASKS.md`.
4. Inspect relevant files in `reference/meshcore-mqtt-broker/` before writing database queries.

`PROMPT.md` defines product/architecture requirements.

`API-CONTRACT.md` defines the public URL/resource contract.

`TASKS.md` tracks implementation and verification.

If reference-project conventions conflict with these root requirements, the root requirements win.

## Critical product correction

This is a **domain API**, not a database browsing API.

Public URLs begin with:

```text
/v1
```

not `/api/v1`.

The intended shape is:

```text
/v1/sources
/v1/docs
/v1/meshcore
/v1/meshcore/nodes
/v1/meshcore/observers
/v1/meshcore/regions
/v1/meshcore/iata
/v1/meshcore/packets
/v1/meshcore/messages
...
```

Never create public generic endpoints/tools for:

- tables
- schemas
- columns
- arbitrary queries
- SQL

If a useful piece of `meshcore_public` data is not exposed, design a domain endpoint or enrich an existing domain response.

## Terminology

Keep these concepts separate:

- **IATA**: geographic three-letter MQTT/observer ingress area, e.g. `JKG`, `GOT`, `STO`.
- **MeshCore region**: logical MeshCore neighbor scope/region. Internal DB may call it `scope`; public API calls it `region`.

Do not expose a public `/scopes` resource.

## Writable areas

You may create/modify:

- `restful-api/`
- `mcp-server-v2/`
- root `compose.yaml`
- root `.env.example`
- root `.gitignore`
- root/project README files
- `TASKS.md`
- implementation-generated `DECISIONS.md` if useful

Do not edit `PROMPT.md`, `API-CONTRACT.md`, or AGENTS files unless the human explicitly changes requirements.

## Read-only reference

`reference/meshcore-mqtt-broker/` is read-only reference material.

Do not modify, format, install into, build, or migrate it.

Use it to understand:

- `meshcore_public`
- joins and semantics
- indexes
- PostgreSQL roles
- PostGIS locations
- observer/node relationship
- neighbor snapshots/scopes
- IATA region data
- packet/message/trace/telemetry semantics
- existing DB network aliases

## Non-negotiable architecture

- REST is the only service that directly accesses PostgreSQL.
- REST uses `meshcore_http`.
- REST reads only `meshcore_public`.
- MCP accesses all data/docs through REST HTTP.
- MCP has no PostgreSQL credentials.
- Both REST and MCP are public/anonymous.
- No API keys, JWT, OAuth or login.
- No write operations.
- No raw SQL endpoint/tool.
- Swagger UI is public at `/docs`.
- Meshat documentation content API is `/v1/docs`.
- REST clones/refreshes the configured `https://codeberg.org/meshat/hemsidan.git` repository at startup and serves only its `/docs` subtree.
- Use `.env` for sensitive runtime values.
- Docker images are built locally.
- Never push source/images/releases remotely.

## MCP

Use the official MCP TypeScript SDK and the stable 2026-07-28 protocol generation/current corresponding SDK.

Keep the protocol and pagination behavior stateless.

MCP tools are domain tools such as `search_nodes`, `get_node`, `search_messages`, `get_doc`.

Never add `list_tables`, `describe_table`, `query_table` or SQL tools.

## Work discipline

- Implement code, do not only propose it.
- Work approximately in `TASKS.md` phase order.
- Mark `[x]` only after implementation and verification.
- Never mark a test complete unless it actually ran.
- If blocked, leave it unchecked and add `BLOCKED: <reason>`.
- Run focused tests after meaningful changes.
- Run typecheck/lint/build when configured.
- Before ending a work session, update `TASKS.md` to reflect reality.
- Do not silently redesign public URLs or response semantics.
