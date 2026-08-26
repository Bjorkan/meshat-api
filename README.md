# Meshat API

This repository contains the public REST API and MCP server for Meshat.se.

Related repository: [`Bjorkan/meshcore-mqtt-broker`](https://github.com/Bjorkan/meshcore-mqtt-broker)

The broker is maintained separately and owns MQTT ingestion, the canonical
PostgreSQL schema (`meshcore_public`), schema versioning and migrations,
database writes, and the public projections consumed by this API.

## Services

| Path             | Service                | Description                                                                                                         |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `restful-api/`   | **Meshat.se REST API** | Read-only public domain API (Fastify + Zod 4 + Bun.SQL), OpenAPI/Swagger at `/docs`, data source `meshcore_public`. |
| `mcp-server-v2/` | **Meshat.se MCP-V2**   | Official Model Context Protocol server; consumes the REST API over HTTP. No PostgreSQL access.                      |

## Architecture

```text
MeshCore publishers
        |
        v
meshcore-mqtt-broker        <- separate repository
(separate repository)
        |
        v
PostgreSQL meshcore_public  <- broker-owned canonical public schema
        |
        v
restful-api                 <- this repository
        |
        v
mcp-server-v2               <- this repository
```

- The **broker** is the only database writer and the single schema authority
  (DDL, migrations, fingerprint semantics).
- **REST** reads `meshcore_public` through its own read-only connection pool.
- **MCP** talks only to REST — never to PostgreSQL directly.

## Database compatibility

The canonical PostgreSQL schema is maintained by
[`Bjorkan/meshcore-mqtt-broker`](https://github.com/Bjorkan/meshcore-mqtt-broker).

This repository's PostgreSQL integration suite validates the REST service
against the broker schema (currently schema v11, fingerprint format v2).
Ordinary performance indexes are not part of the semantic fingerprint.
Continuous cross-repo integration runs in CI against the broker's `main`
branch, so drift between both repositories is detected automatically.

## Requirements

- [Bun](https://bun.sh) **1.4.0** (pinned via `packageManager`; Bun is the
  runtime and package manager — no npm workflow)
- Git
- Docker/Compose (used by the disposable PostgreSQL test databases)

## Recommended workspace layout

Clone the two repositories as siblings:

```bash
git clone git@github.com:Bjorkan/meshat-api.git
git clone git@github.com:Bjorkan/meshcore-mqtt-broker.git
```

Resulting layout:

```text
workspace/
├── meshat-api/
└── meshcore-mqtt-broker/
```

The REST integration suite provisions the canonical broker schema through the
sibling `meshcore-mqtt-broker` checkout. Duplicated database DDL does not live
in meshat-api.

## Basic checks

REST:

```bash
cd meshat-api/restful-api
bun install --frozen-lockfile
bun run check
```

MCP:

```bash
cd meshat-api/mcp-server-v2
bun install --frozen-lockfile
bun run check
```

Both run without any broker checkout or live services — `bun run check` covers
formatting, lint, typecheck and the unit/system tests.

## Full integration

From `restful-api/`, with the sibling broker checkout in place:

```bash
bun run test:integration   # disposable PostgreSQL + canonical broker schema
bun run check:full         # check + integration together
```

The integration harness starts a disposable PostgreSQL instance, provisions
the canonical schema through the broker repository's own tooling, loads a
deterministic fixture through the broker's ingest pipeline, and validates all
repository SQL semantics against real PostgreSQL.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for repository ownership boundaries,
cross-repo change rules and PR expectations.

## License

[MIT](LICENSE) © 2026 Bjorkan
