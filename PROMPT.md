# Meshat.se Official REST API + MCP-V2 — Product and Architecture Specification

## 1. Mission

Implement the official public read-only API services for **Meshat.se**:

1. **Meshat.se REST API**
2. **Meshat.se MCP-V2 Server**

These are production-facing public services, not prototypes.

The public API must be **domain-oriented**, not database-oriented. A consumer should understand MeshCore concepts such as nodes, observers, neighbors, regions, IATA areas, packets, messages, telemetry and traces. A consumer must never need to know PostgreSQL table names, column names, joins, or SQL.

The current network source is **MeshCore**. The architecture must allow **Meshtastic** to be added later as a sibling source without rewriting the platform.

Read `API-CONTRACT.md` for the public URL and response contract, and `TASKS.md` for the implementation checklist.

---

## 2. Required public URL model

The external REST API is rooted directly at:

```text
https://api.meshat.se/v1
```

Do **not** use `/api/v1`.

Examples:

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

Future Meshtastic routes must follow the same structure:

```text
/v1/meshtastic
/v1/meshtastic/nodes
/v1/meshtastic/packets
...
```

`/v1/sources` is the top-level source discovery endpoint.

---

## 3. Absolutely no public database-query API

The public REST API must **not** expose database internals.

Do not implement endpoints such as:

```text
/tables
/schema
/query
/sql
/rows
/columns
```

Do not implement generic public requests such as:

```json
{
  "table": "messages",
  "where": [...]
}
```

Do not implement MCP tools such as:

```text
list_tables
describe_table
query_table
execute_sql
run_sql
```

PostgreSQL tables are an internal implementation detail.

The target is that useful information in `meshcore_public` is exposed through carefully designed MeshCore domain endpoints, with stable names and finished response objects.

If useful data exists in `meshcore_public` but is not yet represented by a public endpoint, design a suitable domain endpoint instead of adding a table-query escape hatch.

---

## 4. Public access model

Both services are intentionally public and anonymous.

Do **not** implement:

- API keys
- JWT
- OAuth
- OAuth2
- OpenID Connect
- Basic Auth
- Bearer tokens
- login
- users
- sessions
- authentication middleware
- authorization middleware
- client certificates

Do not create dormant authentication scaffolding "for later".

The intended access model is:

```text
PUBLIC + ANONYMOUS + READ-ONLY
```

OpenAPI/Swagger must not require authentication.

The MCP endpoint must not require authentication.

---

## 5. Architecture

Use this separation:

```text
                         Public Internet
                              |
              +---------------+----------------+
              |                                |
              v                                v
      Meshat.se MCP-V2                 REST API clients
              |                                |
              | internal HTTP                  |
              +---------------+----------------+
                              |
                              v
                    Meshat.se REST API
                         |          |
                         |          +----> local documentation cache
                         |                    ^
                         |                    |
                         |            Codeberg documentation repo
                         v
                     PostgreSQL
                         |
                         v
                  meshcore_public
```

The REST API is the single data/domain service.

The MCP server must use the REST API as its backend.

The MCP server must not:

- connect directly to PostgreSQL
- receive PostgreSQL credentials
- contain a second SQL implementation
- contain its own alternate interpretation of the MeshCore database

MCP tools should map cleanly to REST domain operations.

---

## 6. Read the reference project first

Before implementing database-backed behavior, inspect:

```text
reference/meshcore-mqtt-broker/
```

Especially:

- `DATABASE.md`
- `ARCHITECTURE.md`
- `CONFIGURATION.md`
- `config.yaml`
- `postgres/initdb/01-meshcore-bootstrap.sql`
- `postgres/initdb/02-meshcore-schema.sql.inc`
- `src/database.ts`
- `src/neighbors.ts`
- `src/region-registry.ts`
- relevant tests

The reference tree is read-only.

The existing schema and broker behavior are the source of truth for how MeshCore data is stored.

Do not copy the broker's deployment/secret conventions when they conflict with this workspace.

---

## 7. Database access

Use the existing PostgreSQL role:

```text
meshcore_http
```

It is the intended read-only consumer of:

```text
meshcore_public
```

REST may read `meshcore_public` but must not access `meshcore_private`.

Do not create a wider database role.

Use `.env` for database credentials:

```dotenv
DATABASE_HOST=meshdb
DATABASE_PORT=5432
DATABASE_NAME=meshcore
DATABASE_USER=meshcore_http
DATABASE_PASSWORD=CHANGE_ME
DATABASE_SSL=false
DATABASE_POOL_MAX=4
```

Do not use password files or Docker secrets for this project.

`.env` must be ignored by Git.

MCP must not receive DB credentials.

---

## 8. Finished public objects, not database rows

Public response objects must be designed for API users.

Do not simply serialize PostgreSQL rows.

For example, prefer:

```json
{
  "public_key": "...",
  "name": "Repeater X",
  "role": "repeater",
  "location": {
    "latitude": 57.7826,
    "longitude": 14.1618
  },
  "first_seen": "2026-08-20T12:34:56Z",
  "last_seen": "2026-08-23T08:00:00Z"
}
```

over leaking internal fields such as:

```text
private_id
latest_name
first_seen_at_ms
location_updated_at_ms
```

Internal IDs may be used where there is no meaningful stable domain identifier, but they should not dominate the API design.

Translate internal field names into stable domain language.

Use ISO 8601 UTC timestamps in public objects.

---

## 9. Source discovery

Implement:

```http
GET /v1/sources
```

It should currently list MeshCore and later list Meshtastic as another source.

Each source entry should include useful discovery metadata such as:

- `id`
- `name`
- `description`
- `status`
- `api_version`
- `url`
- `documentation_url`
- optionally `capabilities`

Example concept:

```json
{
  "data": [
    {
      "id": "meshcore",
      "name": "MeshCore",
      "description": "Information om MeshCore-nätverket i Sverige",
      "status": "available",
      "api_version": "v1",
      "url": "/v1/meshcore",
      "documentation_url": "/v1/docs"
    }
  ]
}
```

---

## 10. MeshCore overview

Implement:

```http
GET /v1/meshcore
```

This is the discovery/index endpoint for MeshCore.

It should describe MeshCore data available through Meshat.se and link to the domain resources, for example:

- nodes
- observers
- neighbors via nodes
- regions
- IATA areas
- packets
- messages
- telemetry
- traces
- statistics
- activity

Do not expose database metadata here.

---

## 11. Important terminology: IATA vs Regions

These are distinct public concepts and must not be conflated.

### IATA

IATA represents the three-letter geographic MQTT/ingress area code used by Meshat.se/observers, such as:

```text
JKG
GOT
STO
```

The reference broker's `config.yaml` contains a Swedish mapping of primary and secondary IATA codes and friendly names.

Public API terminology should use **IATA** for these geographic ingress areas.

### Regions

MeshCore also has logical network scopes/regions represented by neighbor scope data.

The database may use names such as:

```text
scope
scopes_json
neighbor_snapshot_scopes
neighbor_entry_scopes
```

For the public Meshat.se API, expose this concept as **regions**.

Do not expose the internal term `scope` unless documentation needs to explain the mapping.

Therefore:

```text
/v1/meshcore/iata
```

is geographic ingress/IATA information, while:

```text
/v1/meshcore/regions
```

is MeshCore logical region/scope information.

---

## 12. Nodes

Nodes are a primary MeshCore resource.

Implement at least:

```http
GET /v1/meshcore/nodes
GET /v1/meshcore/nodes/{public_key}
GET /v1/meshcore/nodes/{public_key}/neighbors
GET /v1/meshcore/nodes/{public_key}/adverts
GET /v1/meshcore/nodes/{public_key}/sightings
GET /v1/meshcore/nodes/{public_key}/telemetry
```

The node collection should support useful controlled filters directly, for example:

```text
?name=
?role=
?region=
?iata=
?seen_from=
?seen_to=
?near_lat=
?near_lon=
?radius_km=
?sort=
?order=
?limit=
?cursor=
```

Only expose meaningful supported filters. Do not translate arbitrary query parameter names to SQL columns.

Geographic queries should use PostGIS where appropriate.

---

## 13. Neighbor model

Do not expose raw database neighbor snapshots as the primary public interface.

A useful public operation is:

```http
GET /v1/meshcore/nodes/{public_key}/neighbors
```

The endpoint should produce a useful current/aggregated neighbor view from available observer reports.

An observer is a MeshCore node that reports data over MQTT. The observer public key can correspond to the node with the same public key.

Neighbor analysis may combine evidence such as:

- latest neighbor reports from the node itself
- reports from other observers that list the node
- RSSI/SNR where available
- last-heard time
- logical MeshCore regions
- reporting observers/evidence count
- direction of evidence where relevant

Do not invent bidirectional certainty. If the database only proves one side reported the other, expose that accurately.

The API may return a derived relationship status such as `reported`, `reciprocal`, or similar if it is clearly defined and tested.

The public user should not need to understand `neighbor_snapshots`, `neighbor_entries`, or scope join tables.

---

## 14. Observers

Observers are MeshCore nodes that report over MQTT.

Implement at least:

```http
GET /v1/meshcore/observers
GET /v1/meshcore/observers/{public_key}
GET /v1/meshcore/observers/{public_key}/status
GET /v1/meshcore/observers/{public_key}/metrics
```

Observer collection filters should include useful options such as:

```text
?active=
?iata=
?region=
?name=
?near_lat=
?near_lon=
?radius_km=
?seen_from=
?seen_to=
?sort=
?order=
?limit=
?cursor=
```

For observer geographic position, join/use the MeshCore node with the same public key when node location exists. The API should not pretend observer state itself contains an authoritative GPS position when it does not.

---

## 15. IATA endpoints

Implement at least:

```http
GET /v1/meshcore/iata
GET /v1/meshcore/iata/{code}
```

The IATA collection should expose the configured Swedish Meshat.se mapping with friendly names and primary/secondary relationships.

Useful fields include:

- `code`
- `name`
- `type` (`primary` or `secondary`)
- `primary_code` for secondary entries
- current activity/count summaries when feasible
- links to filtered nodes/observers/activity

Use the reference broker mapping as the implementation source unless a better canonical source is already present in the workspace.

Keep attribution/license requirements from the reference data when required.

IATA filtering of observers/nodes should use the appropriate database hearing/observer region data, not arbitrary string matching.

---

## 16. MeshCore region endpoints

Expose logical MeshCore regions/scopes as regions.

Implement at least:

```http
GET /v1/meshcore/regions
GET /v1/meshcore/regions/{region}
GET /v1/meshcore/regions/{region}/nodes
```

The region overview should be derived from neighbor scope data and present useful domain information, such as:

- region name/id
- number of known/reported nodes
- reporting observers
- last activity
- links

Where appropriate, region detail may include bounded summaries rather than raw snapshot data.

Do not expose public `scope` routes.

---

## 17. Packets

Implement at least:

```http
GET /v1/meshcore/packets
GET /v1/meshcore/packets/{sha256}
GET /v1/meshcore/packets/{sha256}/observations
```

Support useful controlled filters, such as:

- packet hash
- packet type
- payload type
- route type
- decode status
- node/public key where meaningful
- observer
- IATA
- received time range
- sort/order
- limit/cursor

Packet responses may expose the raw **MeshCore packet bytes** in a field named `raw`.

Use a deterministic encoding such as hex, for example:

```json
{
  "raw": "0xa1b2c3..."
}
```

Do **not** expose raw MQTT receipt information merely because it exists internally.

Do not expose MQTT credentials, connection metadata, client IPs, raw broker state, or private ingest records.

---

## 18. Messages

Messages in the public projection may be served publicly.

Implement:

```http
GET /v1/meshcore/messages
GET /v1/meshcore/messages/{id}
```

Useful filters include:

- sender
- destination
- channel
- channel name
- message type
- encrypted state
- signature state
- IATA
- received time range
- sort/order

Messages must always use bounded page sizes.

Use a conservative default and maximum, for example:

```text
default: 50
max: 200
```

The exact limits should be configurable.

MCP must be able to continue through message results using a stateless opaque cursor.

---

## 19. Telemetry and traces

Implement curated domain endpoints for public protocol data, at least:

```http
GET /v1/meshcore/telemetry
GET /v1/meshcore/telemetry/{id}
GET /v1/meshcore/traces
GET /v1/meshcore/traces/{id}
GET /v1/meshcore/traces/{id}/hops
```

Expose meaningful domain fields and controlled filters rather than PostgreSQL row shapes.

---

## 20. Statistics and activity

Implement:

```http
GET /v1/meshcore/stats
GET /v1/meshcore/activity
```

`stats` should provide a useful current overview, for example counts of:

- known nodes
- recently active nodes
- observers
- active observers
- MeshCore regions
- known IATA areas with activity
- packets/messages in a documented time window
- latest observed activity time

`activity` should provide a bounded time-series view with controlled parameters such as:

```text
?window=24h
?interval=1h
?iata=JKG
?region=...
```

Do not allow arbitrary SQL grouping expressions.

---

## 21. Documentation repository integration

The REST API must expose Meshat.se's public documentation from:

```text
https://codeberg.org/meshat/hemsidan.git
```

The website/documentation repository contains a `/docs` directory with Markdown and related documentation files.

At REST API startup:

1. Use a configured local cache directory.
2. If no checkout exists, perform a shallow clone of the configured repository/ref.
3. If a checkout already exists, fetch/update it to the configured ref.
4. Serve **only** content beneath the checked-out repository's `/docs` directory.
5. Never expose `.git`, repository secrets, files outside `/docs`, or arbitrary filesystem paths.

Recommended environment variables:

```dotenv
DOCS_GIT_REPOSITORY=https://codeberg.org/meshat/hemsidan.git
DOCS_GIT_REF=
DOCS_CACHE_DIR=/var/lib/meshat-docs/repo
DOCS_SUBDIR=docs
DOCS_MAX_FILE_BYTES=1048576
```

If `DOCS_GIT_REF` is empty, use the repository's remote default branch and report the resolved ref/commit in metadata. Do not assume a branch name that has not been verified.

Use a persistent Compose volume for the docs cache so a temporary Codeberg outage does not unnecessarily remove an already-known-good checkout.

If refresh fails but a valid cached checkout exists:

- keep serving the cached copy
- log a warning
- expose docs status as stale/degraded metadata

If no cached docs exist and clone fails:

- the core database API should still be able to start
- `/v1/docs` may return `503 DOCS_UNAVAILABLE`
- service metadata/readiness should indicate docs degradation without falsely claiming the database API is down

Do not clone user-supplied URLs. The repository location is deployment configuration, not a request parameter.

Do not execute files from the documentation repository.

---

## 22. Documentation endpoints

Implement at least:

```http
GET /v1/docs
GET /v1/docs/search
GET /v1/docs/{path...}
```

### `GET /v1/docs`

Return a recursive, sorted documentation index containing useful metadata such as:

- path
- title when derivable
- media type
- size
- source commit/ref metadata

Do not return the content of every file in the index response.

### `GET /v1/docs/{path...}`

Return the requested file from the repository's `/docs` subtree.

For text/Markdown documentation, use a machine-friendly object such as:

```json
{
  "data": {
    "path": "meshcore/getting-started.md",
    "media_type": "text/markdown",
    "content": "# ...",
    "source": {
      "repository": "https://codeberg.org/meshat/hemsidan.git",
      "ref": "<resolved-ref>",
      "commit": "..."
    }
  }
}
```

Reject path traversal and symlink escapes.

Apply a maximum file size.

### `GET /v1/docs/search?q=...`

Provide a lightweight search intended especially for MCP/agent use.

Search only documentation files under `/docs`.

Return bounded results with:

- path
- title
- short matching snippet
- score/ranking if implemented

Do not turn this into a general filesystem search.

---

## 23. Pagination and stateless cursors

Use opaque cursor/keyset pagination for large collections.

Do not use large `OFFSET` paging.

REST cursors must be completely stateless from the server's perspective.

A cursor should encode the information needed to continue the query, for example:

- cursor format version
- stable last sort key(s)
- resource/query type
- normalized filter/query fingerprint when needed

Protect against using a cursor with incompatible filters.

The client must treat the cursor as opaque.

Typical response:

```json
{
  "data": [...],
  "pagination": {
    "limit": 50,
    "has_more": true,
    "next_cursor": "opaque-value"
  }
}
```

Use stable database keys such as `received_at_ms + id` internally where applicable, but do not expose those implementation details as the public pagination contract.

---

## 24. Controlled sorting

Use endpoint-specific allowed sort values, for example:

```text
?sort=last_seen&order=desc
?sort=name&order=asc
?sort=received_at&order=desc
```

Do not allow arbitrary SQL column names.

Each endpoint must document its accepted sort values in Swagger.

Default order should be deterministic.

---

## 25. Response conventions

Collections:

```json
{
  "data": [],
  "pagination": {
    "limit": 100,
    "has_more": false,
    "next_cursor": null
  }
}
```

Single resource:

```json
{
  "data": {}
}
```

Errors:

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Human-readable explanation",
    "request_id": "..."
  }
}
```

Use stable machine-readable error codes.

Do not leak SQL, stack traces, database driver errors, credentials, or private data.

---

## 26. Time and serialization

Use ISO 8601 UTC strings for public timestamps.

Example:

```text
2026-08-23T08:00:00Z
```

Avoid JavaScript precision loss for database bigint values. Convert to a suitable public domain value rather than blindly serializing bigint.

Return locations as finished objects:

```json
{
  "location": {
    "latitude": 57.7826,
    "longitude": 14.1618
  }
}
```

Do not return PostGIS WKB.

Raw MeshCore packet bytes should be returned as a deterministic hex string in the packet `raw` field.

---

## 27. Swagger UI / OpenAPI

Swagger UI is mandatory and public.

Expose:

```http
GET /docs
GET /openapi.json
```

Note the intentional distinction:

```text
/docs       = Swagger UI
/v1/docs    = Meshat.se documentation content API
```

Swagger UI must:

- show every public REST endpoint
- group routes by domain tags
- document every supported filter
- document sorting
- document cursor pagination
- show request/response examples
- show errors
- support "Try it out"
- work anonymously

Use title:

```text
Meshat.se REST API
```

Do not add OpenAPI security schemes for API keys/JWT/OAuth.

Recommended tags include:

- System
- Sources
- Documentation
- MeshCore Overview
- MeshCore Nodes
- MeshCore Observers
- MeshCore Neighbors
- MeshCore Regions
- MeshCore IATA
- MeshCore Packets
- MeshCore Messages
- MeshCore Telemetry
- MeshCore Traces
- MeshCore Statistics

---

## 28. Rate limiting and abuse protection

The API is anonymous, so protect capacity without authentication.

Use:

- IP-aware rate limiting
- bounded page sizes
- request body limits
- controlled filter sets
- controlled sort options
- PostgreSQL read-only account
- PostgreSQL statement timeout
- small DB connection pool
- parameterized SQL
- indexed/keyset pagination

Make reverse-proxy trust explicit/configurable.

Example:

```dotenv
TRUST_PROXY=false
API_RATE_LIMIT_ENABLED=true
API_RATE_LIMIT_MAX=120
API_RATE_LIMIT_WINDOW_MS=60000
```

Do not trust arbitrary `X-Forwarded-For` values unless the deployment explicitly configures trusted proxy behavior.

---

## 29. MCP-V2 protocol requirements

Official service name:

```text
Meshat.se MCP-V2
```

Endpoint:

```http
/mcp
```

Also provide:

```http
GET /healthz
GET /readyz
```

Use the official Model Context Protocol TypeScript SDK and implement against the stable `2026-07-28` MCP specification or the corresponding current stable SDK API.

The 2026-07-28 protocol core is stateless. Do not reintroduce sticky-session assumptions or server-side pagination session state.

The MCP service is public and anonymous.

---

## 30. MCP domain tools

MCP must expose domain tools, not database tools.

Implement at least a useful set equivalent to:

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

Add additional domain tools where they make the public data significantly easier for an LLM to use.

Do not add table/schema/SQL tools.

Tool descriptions should clearly explain concepts such as IATA vs MeshCore region.

---

## 31. MCP cursor behavior

Tools returning large lists must accept an optional opaque `cursor` and bounded `limit`.

Tool responses should return an opaque `next_cursor` when more results exist.

Example concept:

```json
{
  "items": [...],
  "next_cursor": "opaque-value"
}
```

The MCP server itself must not keep pagination sessions.

The cursor should simply be passed through to the appropriate REST endpoint.

This gives fully stateless continuation across calls and MCP server instances.

---

## 32. MCP documentation use

The documentation API is particularly important for MCP.

MCP should use REST endpoints:

```text
/v1/docs
/v1/docs/search
/v1/docs/{path...}
```

for tools such as:

```text
list_docs
search_docs
get_doc
```

Do not independently clone the Codeberg repository inside the MCP container.

REST owns the documentation cache and content normalization just as REST owns database access.

---

## 33. Future Meshtastic

The source architecture must make this natural later:

```text
GET /v1/sources
GET /v1/meshtastic
GET /v1/meshtastic/nodes
GET /v1/meshtastic/packets
...
```

Do not force MeshCore and Meshtastic into the same database schema or identical internal data model.

Use source/domain modules that can have separate backends while sharing platform concerns such as:

- response conventions
- request IDs
- Swagger/OpenAPI
- rate limiting
- pagination utilities
- logging
- common HTTP errors

Do not implement cross-database joins unless a future explicit product requirement asks for it.

---

## 34. Docker / Compose

Both services need their own Dockerfiles and should be built locally.

The shared root `compose.yaml` must use `build:` for:

```text
restful-api
mcp-server-v2
```

Do not push images.

REST joins the existing PostgreSQL network and an internal API network.

MCP joins only the internal API network unless another explicit need exists.

The existing database network is expected to be:

```text
postgresdb_db-internal
```

and the DB alias is expected to be:

```text
meshdb
```

Verify against reference deployment files before finalizing.

Add a persistent volume for REST documentation checkout/cache.

Example concept:

```yaml
volumes:
  meshat-docs-cache:
```

The REST image needs `git` available at runtime if the implementation performs runtime clone/fetch with the Git CLI.

---

## 35. Git and external actions

Never run:

```text
git push
docker push
gh pr create
gh release
```

Do not publish code or images.

Cloning/fetching the explicitly configured public Meshat.se documentation repository at REST runtime is allowed and required for the docs feature.

Do not treat the no-push rule as a no-network rule.

---

## 36. Testing priorities

Tests must verify domain behavior, not only route existence.

REST tests should cover:

- anonymous public access
- source discovery
- MeshCore overview
- node filters
- geographic node search
- aggregated neighbor semantics
- observer geographic lookup using same-key node location
- IATA primary/secondary mapping
- distinction between IATA and MeshCore regions
- packet raw MeshCore bytes and exclusion of raw MQTT metadata
- bounded message pagination
- stateless cursors
- invalid/mismatched cursors
- docs clone/cache behavior
- docs path traversal rejection
- docs search
- Swagger/OpenAPI
- no auth/security schemes
- rate limiting
- SQL injection resistance in all query parameters
- no private-schema access

MCP tests should cover:

- protocol initialization/requests with the official SDK
- anonymous access
- domain tool discovery
- cursor continuation with no MCP-side session
- REST unavailable handling
- docs tools
- no database credentials
- absence of table/SQL tools

---

## 37. Definition of done

Do not consider the project complete until all of the following are true:

- `/v1/sources` is implemented.
- `/v1/meshcore` is implemented.
- MeshCore domain endpoints are comprehensive enough that clients do not need database-table access.
- No public table/schema/query endpoint exists.
- No generic DB MCP tool exists.
- IATA and MeshCore regions are modeled separately and clearly.
- Nodes and observers have useful filters.
- Observer location uses the corresponding node location where available.
- Node neighbor endpoint provides useful aggregated neighbor information.
- Packets expose raw MeshCore packet data but not raw MQTT private/ingest data.
- Messages are public, bounded and cursor-paginated.
- Cursors are opaque and stateless.
- Stats/activity endpoints exist.
- `/v1/docs` exposes the Meshat.se docs repository `/docs` subtree.
- REST refreshes/clones the configured docs repo at startup with safe caching.
- MCP exposes docs tools through REST.
- Swagger UI works at `/docs`.
- OpenAPI JSON works at `/openapi.json`.
- REST and MCP require no authentication/API key.
- REST uses `meshcore_http` and only reads `meshcore_public`.
- MCP uses REST and does not access PostgreSQL.
- Future `/v1/meshtastic/...` can be added without rewriting the platform.
- Docker images build locally.
- Compose validates and starts.
- Tests have actually been run.
- Nothing has been pushed externally.

---

## 38. Final implementation report

When finished, report:

1. files created/changed
2. final architecture
3. all REST endpoints
4. response/domain models
5. IATA implementation
6. MeshCore region implementation
7. neighbor aggregation behavior
8. cursor design
9. packet `raw` behavior
10. docs clone/cache behavior and currently served commit/ref
11. Swagger/OpenAPI status
12. MCP tools
13. `.env` handling
14. security/query protection
15. test results
16. `docker compose config` result
17. `docker compose build` result
18. runtime health/readiness results
19. remaining limitations/blockers

Only claim a check passed if it was actually executed.
