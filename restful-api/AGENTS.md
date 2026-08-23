# REST API — OpenCode Instructions

These instructions apply inside `restful-api/` and supplement the root `AGENTS.md`.

Read root `PROMPT.md` and `API-CONTRACT.md` before changing REST code.

## Purpose

Implement the official public anonymous **Meshat.se REST API**.

Public API base:

```text
/v1
```

Swagger UI:

```text
/docs
```

OpenAPI JSON:

```text
/openapi.json
```

Documentation content API:

```text
/v1/docs
```

## Domain API only

Do not expose generic DB endpoints.

Forbidden public route concepts include:

```text
/tables
/schema
/query
/sql
/rows
```

Do not accept table names, column names, SQL fragments or arbitrary sort columns from clients.

REST may use detailed SQL internally to build finished domain objects.

## Database

- Use `meshcore_http` only.
- Read only `meshcore_public`.
- Never access `meshcore_private`.
- Use bound query values.
- Validate all filters and sort enums.
- Use indexed/keyset pagination.
- Keep DB pool small; default max around 4.
- Close the pool on graceful shutdown.

## Public resource priorities

Implement polished resources for:

- source discovery
- MeshCore overview
- nodes
- node neighbors
- observers
- MeshCore regions
- IATA areas
- packets
- messages
- telemetry
- traces
- stats
- activity
- Meshat documentation

Normalize DB fields to stable domain fields and ISO 8601 timestamps.

## IATA vs region

Never conflate them:

- IATA = geographic MQTT ingress code (`JKG`, etc.)
- region = MeshCore logical neighbor scope

Internal `scope` can be mapped to public `region`.

## Observer geography

Observer geographic search/location should use the node with the same public key when a verified node location exists.

## Neighbors

The primary public neighbor operation is:

```text
GET /v1/meshcore/nodes/{public_key}/neighbors
```

Build an aggregated, useful relationship view from observer neighbor reports. Do not make raw snapshot tables the public abstraction.

## Packets

Packet detail may expose raw MeshCore bytes as:

```json
{ "raw": "0x..." }
```

Do not expose raw MQTT/private ingest metadata.

## Docs repository

At service startup, clone or refresh:

```text
https://codeberg.org/meshat/hemsidan.git
```

using deployment-configurable repository/ref/cache settings.

Serve only `<checkout>/docs` through `/v1/docs` routes.

Requirements:

- persistent cache volume
- shallow clone/update
- no user-supplied repository URL
- no command execution from checkout
- path traversal protection
- symlink escape protection
- max file size
- stale-cache fallback when refresh fails
- core DB API may remain available when docs are degraded

MCP must use this REST docs API rather than cloning independently.

## Swagger

Every public endpoint must have proper schemas/descriptions/examples.

No OpenAPI auth/security scheme.

Make the distinction clear:

```text
/docs     Swagger UI
/v1/docs  Meshat.se documentation content
```

## Security

This service is public and anonymous but must have:

- rate limiting
- body limits
- query limits
- read-only DB role
- statement timeout
- deterministic cursors
- safe error mapping
- request IDs
- structured logging

No authentication/API keys.
