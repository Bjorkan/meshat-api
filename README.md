# Meshat.se APIs workspace

OpenCode workspace for the official public Meshat.se REST API and MCP-V2 server.

## Read first

OpenCode should load these through `opencode.json`, but they are also the human-readable source of truth:

1. `AGENTS.md`
2. `PROMPT.md`
3. `API-CONTRACT.md`
4. `TASKS.md`

The critical public API model is:

```text
https://api.meshat.se/v1/sources
https://api.meshat.se/v1/docs
https://api.meshat.se/v1/meshcore
https://api.meshat.se/v1/meshcore/nodes
https://api.meshat.se/v1/meshcore/observers
https://api.meshat.se/v1/meshcore/regions
https://api.meshat.se/v1/meshcore/iata
https://api.meshat.se/v1/meshcore/packets
https://api.meshat.se/v1/meshcore/messages
```

This is a curated domain API. There are intentionally no public table/schema/SQL query endpoints.

Swagger UI is served at `/docs`; Meshat.se documentation content is exposed separately at `/v1/docs` from the configured Codeberg repository.

## Workspace

```text
restful-api/                 REST implementation
mcp-server-v2/               MCP implementation
reference/meshcore-mqtt-broker/  read-only schema/domain reference
```

Do not modify the reference project.

No code or Docker images should be pushed remotely by the agent.

## Local verification

Create `.env` from `.env.example`, set the `meshcore_http` password in `DATABASE_PASSWORD`, and run:

```sh
docker compose config
docker compose build
docker compose up -d
```

REST is the only service attached to `postgresdb_db-internal`. MCP is attached only to the internal service network and accesses data and documentation over REST HTTP. The named `meshat-docs-cache` volume preserves the validated documentation checkout across REST container replacement.
