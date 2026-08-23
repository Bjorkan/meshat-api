# Meshat.se REST API and MCP-V2 Final Report

Final verification date: 2026-08-23

This report records the final implementation and verification evidence. The read-only `reference/meshcore-mqtt-broker/` tree was not changed; ingest changes were made in the separately authorized canonical broker repository.

Prelaunch remediation follow-up (2026-08-23): broker ingest/schema, REST domain semantics, and REST/MCP documentation behavior were changed, fully tested, and deployed. Live-runtime checks below reflect the resulting schema-v6 production deployment. Later same-day follow-ups moved production to schema version 8: canonical lowercase Swedish region scopes with named JSON projections, required `lp_`-prefixed message IDs, `representative_packet_sha256`, a `logical_id` packet filter, and the public `region_scopes` registry (312 built-in Swedish scopes with hardcoded official municipality names plus detected scopes) that REST serves with `region`, `name`, `first_seen`, `last_seen`, `manually_added`, `observation_count`, node/observer counts, and `last_activity`.

## 1. Files Created or Changed

The workspace root has no Git repository metadata from which to reconstruct a historical diff. The following is therefore the final implementation artifact set, not a claim that every listed file changed in the final reporting pass.

The documentation hardening follow-up changed these source/configuration/report files exactly (production builds also regenerated service `dist/` artifacts):

```text
.env.example
compose.yaml
DECISIONS.md
TASKS.md
FINAL-REPORT.md
restful-api/README.md
restful-api/src/config.ts
restful-api/src/docs.ts
restful-api/src/server.ts
restful-api/tests/config-cursor-mappers.test.ts
restful-api/tests/docs.test.ts
restful-api/tests/fakes.ts
restful-api/tests/system.test.ts
mcp-server-v2/README.md
mcp-server-v2/src/tools.ts
mcp-server-v2/tests/system.test.ts
```

Root platform and deployment files:

```text
.env.example
.gitignore
compose.yaml
README.md
DECISIONS.md
TASKS.md
FINAL-REPORT.md
```

REST service files:

```text
restful-api/.dockerignore
restful-api/Dockerfile
restful-api/README.md
restful-api/package.json
restful-api/package-lock.json
restful-api/tsconfig.json
restful-api/tsconfig.build.json
restful-api/src/config.ts
restful-api/src/cursor.ts
restful-api/src/docs.ts
restful-api/src/domain.ts
restful-api/src/errors.ts
restful-api/src/iata.ts
restful-api/src/mappers.ts
restful-api/src/repository.ts
restful-api/src/server.ts
restful-api/tests/config-cursor-mappers.test.ts
restful-api/tests/docs.test.ts
restful-api/tests/fakes.ts
restful-api/tests/live-endpoints.mjs
restful-api/tests/repository.test.ts
restful-api/tests/system.test.ts
restful-api/tests/verification-gaps.test.ts
```

MCP-V2 service files:

```text
mcp-server-v2/.dockerignore
mcp-server-v2/Dockerfile
mcp-server-v2/README.md
mcp-server-v2/package.json
mcp-server-v2/package-lock.json
mcp-server-v2/tsconfig.json
mcp-server-v2/src/main.ts
mcp-server-v2/src/rest.ts
mcp-server-v2/src/server.ts
mcp-server-v2/src/tools.ts
mcp-server-v2/tests/system.test.ts
```

Generated `dist/` output and installed `node_modules/` trees are build/runtime artifacts and are excluded from this source-file inventory. This final reporting change creates `FINAL-REPORT.md` and updates only root `TASKS.md` in addition to that new file.

## 2. Final Architecture

The production architecture is a public, anonymous, read-only domain API:

```text
Public REST clients --------------------------+
                                               |
Public MCP clients -> Meshat.se MCP-V2 --------+-> Meshat.se REST API
                       (REST HTTP only)                    |
                                             +------------+-------------+
                                             |                          |
                                             v                          v
                              PostgreSQL meshcore_public       persistent docs cache
                              as meshcore_http only                    |
                                                                    Codeberg
```

REST is the only service with PostgreSQL configuration and the only service attached to the external database network. It uses fixed domain repositories against `meshcore_public` as `meshcore_http`. MCP has no PostgreSQL client, credentials, SQL implementation, or documentation checkout; every tool calls REST over HTTP.

The root Compose deployment builds both custom images locally. REST joins the external database network, internal service network, and external `backend` proxy network. MCP joins only the internal service and proxy networks. A named `meshat-docs-cache` volume persists the REST-owned checkout. Both runtime images use the non-root `node` user; REST includes Git for startup documentation refresh.

The source-oriented `/v1/{source}` structure permits a future `/v1/meshtastic` sibling without combining source-specific storage models. Meshtastic itself is not implemented.

## 3. REST Endpoints

All operations are read-only `GET` operations. The public API root is `/v1`, not `/api/v1`.

| Endpoint                                      | Purpose                                         |
| --------------------------------------------- | ----------------------------------------------- |
| `/`                                           | Service identity and links                      |
| `/healthz`                                    | Process liveness                                |
| `/readyz`                                     | Database readiness and docs status              |
| `/docs`                                       | Public Swagger UI                               |
| `/openapi.json`                               | Public OpenAPI document                         |
| `/v1/sources`                                 | Source discovery                                |
| `/v1/meshcore`                                | MeshCore resource overview                      |
| `/v1/docs`                                    | Recursive sorted docs index and source metadata |
| `/v1/docs/search`                             | Bounded docs search                             |
| `/v1/docs/{path...}`                          | Safe docs file retrieval                        |
| `/v1/meshcore/nodes`                          | Filtered, sorted, cursor-paginated nodes        |
| `/v1/meshcore/nodes/{public_key}`             | Node detail                                     |
| `/v1/meshcore/nodes/{public_key}/neighbors`   | Aggregated current neighbor evidence            |
| `/v1/meshcore/nodes/{public_key}/adverts`     | Cursor-paginated adverts                        |
| `/v1/meshcore/nodes/{public_key}/sightings`   | Cursor-paginated sightings                      |
| `/v1/meshcore/nodes/{public_key}/telemetry`   | Cursor-paginated node telemetry                 |
| `/v1/meshcore/observers`                      | Filtered, sorted, cursor-paginated observers    |
| `/v1/meshcore/observers/{public_key}`         | Observer detail                                 |
| `/v1/meshcore/observers/{public_key}/status`  | Latest observer status                          |
| `/v1/meshcore/observers/{public_key}/metrics` | Cursor-paginated observer metrics               |
| `/v1/meshcore/iata`                           | Configured geographic ingress codes             |
| `/v1/meshcore/iata/{code}`                    | IATA mapping, activity summary, and links       |
| `/v1/meshcore/regions`                        | Logical MeshCore region summaries               |
| `/v1/meshcore/regions/{region}`               | Logical region detail                           |
| `/v1/meshcore/regions/{region}/nodes`         | Cursor-paginated region nodes                   |
| `/v1/meshcore/packets`                        | Filtered, sorted, cursor-paginated packets      |
| `/v1/meshcore/packets/{sha256}`               | Packet detail and raw MeshCore bytes            |
| `/v1/meshcore/packets/{sha256}/observations`  | Cursor-paginated public packet observations     |
| `/v1/meshcore/messages`                       | Bounded filtered public messages                |
| `/v1/meshcore/messages/{id}`                  | Message detail                                  |
| `/v1/meshcore/telemetry`                      | Filtered typed telemetry                        |
| `/v1/meshcore/telemetry/{id}`                 | Telemetry detail                                |
| `/v1/meshcore/traces`                         | Filtered trace events                           |
| `/v1/meshcore/traces/{id}`                    | Trace detail                                    |
| `/v1/meshcore/traces/{id}/hops`               | Ordered ambiguity-aware trace hops              |
| `/v1/meshcore/stats`                          | Curated current network summary                 |
| `/v1/meshcore/activity`                       | Bounded allowlisted activity time series        |

Controlled node filters are `name`, `role`, `region`, `iata`, `seen_from`, `seen_to`, `near_lat`, `near_lon`, `radius_km`, `sort`, `order`, `limit`, and `cursor`. Observer filters add `active` and intentionally omit a role filter. Geographic inputs must be supplied as a complete latitude/longitude/radius set and use PostGIS geography.

Packet, message, telemetry, and trace routes expose only their documented filter allowlists. Activity accepts windows `1h`, `6h`, `24h`, `7d`, and `30d`, and intervals `5m`, `15m`, `1h`, `6h`, and `1d`; invalid or excessive combinations are rejected.

There are no `/api/v1`, table, schema, scope, arbitrary query, SQL, or write routes.

## 4. Response and Domain Models

Collections use `{ "data": [...], "pagination": { "limit", "has_more", "next_cursor" } }`. Details use `{ "data": {...} }`. Errors use `{ "error": { "code", "message", "request_id" } }` with stable public codes and no database errors or stack traces.

Public normalization includes:

- ISO 8601 UTC timestamps instead of millisecond database fields.
- Big integer identifiers represented as strings to avoid JavaScript precision loss.
- Locations represented as `{ latitude, longitude }`, never PostGIS binary data.
- Node, advert, and neighbor roles normalized to lowercase.
- Nodes exposing stable public keys, name, role, location, first/last seen time, IATA arrays, and logical region arrays.
- Observers exposing active state and IATA, with location inherited from the node having the same public key.
- Telemetry and observer metrics exposing typed values as `number`, `boolean`, or `string` objects.
- Messages exposing normalized sender, destination, channel, encryption/signature state, public text when available, IATA, and timestamps.
- Trace and packet path hops retaining ordered prefix, resolution status, candidate/confidence, and unresolved/ambiguous information.
- Stats exposing known and 24-hour-active nodes, observer counts, region and active-IATA counts, distinct packets and messages over 24 hours, and latest activity.

Internal row fields such as cursor helpers and `private_id` are removed. Public resources are finished domain objects rather than generic database rows.

## 5. IATA Implementation

IATA means a three-letter geographic MQTT/observer ingress area. The REST-owned registry was copied from the operator-maintained Swedish mapping in the reference broker configuration. It contains 20 primary entries and 33 secondary entries, sorted by code. Primary entries carry Swedish friendly names; secondary entries carry `primary_code` and do not invent names absent from the source.

Input is case-insensitively normalized to uppercase. Detail responses add current node, observer, packet-observation, and latest-activity summaries for the requested code plus filtered resource links. Historical observations under a secondary code remain attributed to that requested code rather than being rewritten to its primary code.

No extra source or licence attribution was invented because the reference notice identifies no external source beyond its own configuration.

## 6. MeshCore Region Implementation

Public MeshCore regions are logical neighbor scopes, not IATA geography. They are derived from both `neighbor_entry_scopes` membership and `neighbor_snapshot_scopes` self-membership. The internal `scope` term is not exposed as a route, and the literal `*` remains unchanged because the reference project defines no alternate interpretation.

Region summaries provide name, distinct node count, reporting-observer count, last activity, and a node link. Region-node membership and node/observer region filters include both nodes reported as neighbors and observers reporting self-scope membership. `/v1/meshcore/regions/{region}/nodes` uses bounded keyset pagination.

## 7. Neighbor Aggregation

`/v1/meshcore/nodes/{public_key}/neighbors` uses the latest public neighbor snapshot per reporting observer. It combines:

- Outbound evidence where the requested node reports a counterpart.
- Inbound evidence where another observer reports the requested node.
- Latest-heard time and the signal attached to the newest evidence.
- Logical region membership.
- Public report and distinct reporting-observer counts.

`reported` means evidence exists in only one direction. `reciprocal` requires both outbound and inbound reports, and direction is explicitly `outbound`, `inbound`, or `both`. It does not infer bidirectional RF adjacency. Because private replay classification is not in the public projection, report counts are public report records and are not claimed to be independent RF transmissions.

Automated tests now directly assert outbound-only, inbound-only, and reciprocal behavior.

## 8. Cursor Design

Large collections use keyset pagination and request one extra row to determine `has_more`. A cursor is base64url-encoded JSON containing:

- Format version `1`.
- Resource identity.
- A SHA-256 fingerprint of normalized filters, sort, and order.
- The final stable sort key and identity key.

Cursors require no server-side storage or session. Resource, query fingerprint, key shape, numeric/natural-key format, and identity format are validated before a key reaches PostgreSQL. Malformed, forged-invalid, cross-resource, or filter/sort/order-mismatched cursors return `INVALID_CURSOR`. The cursor contains no secret, but clients must treat it as opaque.

MCP passes REST cursors unchanged and returns `next_cursor`; final verification continued a page through a fresh MCP client and instance with no session state.

## 9. Packet `raw` Behavior

Packet `raw` is the actual public MeshCore packet byte sequence from `meshcore_public.packets.raw_packet_blob`, encoded deterministically as lowercase hexadecimal with a `0x` prefix, for example `0xa1b2`.

The packet API does not query or return raw private MQTT receipts, broker credentials, client addresses, connection state, or private ingest metadata. Public observations expose only normalized observer, IATA, received/reported times, signal, direction, and structured path hops.

## 10. Documentation Clone and Cache

REST owns the checkout of `https://codeberg.org/meshat/hemsidan.git`. At startup it creates an isolated shallow clone of the configured ref, validates the checkout and non-symlinked docs root, resolves origin/ref/commit metadata, and replaces the active cache. An empty `DOCS_GIT_REF` follows the remote default branch rather than assuming a branch name.

Only lowercase `**/*.md` and exactly `meshtastic/example.yaml` beneath `DOCS_SUBDIR` (default `docs`) are indexed, searched, and served. Other existing assets are returned as not found. Documents must decode as valid UTF-8 and are returned only as UTF-8 text; REST never emits base64 documentation. `DOCS_MAX_FILE_BYTES` defaults to and is capped at 65536 bytes, and oversized documents are excluded from index/search. Direct oversized retrieval remains a bounded `413` error.

The implementation continues to reject credentials in repository URLs, traversal, encoded traversal, absolute paths, empty/dot segments, `.git`, and symlink escapes. Search evaluates deterministic path-sorted candidates and is bounded to 100 files and 4 MiB scanned per request, with a result maximum of 50. It returns `query`, `limit`, `returned`, `total_matches`, `scan_complete`, `truncated`, and `results`, with no cursor.

A failed refresh keeps and serves a matching validated cache as `stale`. A cache from a different configured repository or ref is not served. With no valid cache, docs return `503 DOCS_UNAVAILABLE`, while health and core domain routes remain available. Compose persists the cache in `meshat-docs-cache`.

Final live docs metadata was:

```text
status: fresh
ref: main
commit: 1f2c230215e5423bceecb4183d86c738932b4ed6
repository: https://codeberg.org/meshat/hemsidan.git
```

The supported Compose deployment uses one REST replica; concurrent writers sharing one docs volume are not supported.

## 11. Swagger and OpenAPI

Swagger UI is public at `/docs`, while `/v1/docs` is the separate Meshat.se documentation content API. `/openapi.json` reports OpenAPI `3.1.0`, title `Meshat.se REST API`, 36 paths, domain tags, controlled query parameters, success/error schemas, descriptions, and examples.

Tests assert that every published GET operation has a summary, description, successful response description/example, query-parameter descriptions, and error descriptions/examples. No OpenAPI authentication security scheme exists. Forbidden generic database paths are absent.

Formal Redocly minimal validation reported the document as valid. It also reported 74 non-fatal style warnings, primarily missing `operationId` values; these are style findings, not schema-validation failures.

## 12. MCP Tools and Protocol

Meshat.se MCP-V2 exposes `POST /mcp`, `GET /healthz`, and REST-backed `GET /readyz`. Other methods on `/mcp` are rejected with `405`. It uses the official modular V2 packages pinned to `2.0.0`:

```text
@modelcontextprotocol/server
@modelcontextprotocol/fastify
@modelcontextprotocol/node
@modelcontextprotocol/client (tests only)
```

The monolithic V1 SDK and a legacy server are absent. The official modular client negotiated protocol `2026-07-28`; `legacy: "reject"` rejected legacy initialization with protocol error `-32022`. The server creates fresh request state, emits no MCP session ID, and retains no pagination session. All 23 tools advertise and validate output schemas. Paginated domain collection tools use `{items,next_cursor}`. `list_docs`, `search_docs`, and `get_doc` use distinct normalizers and exact documentation output schemas; `search_docs` returns scan/result metadata with no `next_cursor`. MCP rejects malformed REST docs responses with binary/mismatched MIME, base64 encoding, non-public paths, oversized content, invalid index ordering, cursor-like search fields, or inconsistent search metadata.

The 23 read-only domain tools are:

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

Tool arguments mirror endpoint-specific REST validation. Paginated domain collections normalize REST output to `{ items, next_cursor }`; details retain their meaningful REST envelopes, while docs tools return validated direct documentation objects. REST timeout, cancellation, unavailable service, 429, invalid cursor, not found, docs-unavailable, and malformed docs-response failures become safe MCP tool errors. There are no table, schema, SQL, database, or write tools.

## 13. Environment Handling

Sensitive runtime values come from `.env`; `.env` and `.env.*` are ignored while `.env.example` remains trackable. No password files or Docker secrets are used.

REST settings cover:

```text
DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER
DATABASE_PASSWORD, DATABASE_SSL, DATABASE_POOL_MAX
DATABASE_STATEMENT_TIMEOUT_MS, DATABASE_NETWORK
REST_HOST, REST_PORT, CORS_ORIGINS, TRUST_PROXY
API_RATE_LIMIT_ENABLED, API_RATE_LIMIT_MAX, API_RATE_LIMIT_WINDOW_MS
API_DEFAULT_LIMIT, API_MAX_LIMIT, MESSAGE_DEFAULT_LIMIT, MESSAGE_MAX_LIMIT
API_BODY_LIMIT_BYTES
DOCS_GIT_REPOSITORY, DOCS_GIT_REF, DOCS_CACHE_DIR
DOCS_SUBDIR, DOCS_MAX_FILE_BYTES
```

`DATABASE_USER` is schema-validated to exactly `meshcore_http`; pool maximum defaults to 4 and is capped at 5. Compose accepts `MESHCORE_HTTP_PASSWORD` as an optional deployment-level fallback for `DATABASE_PASSWORD`, but MCP receives neither value.

MCP settings cover only its listener, REST backend/timeout, Host and Origin allowlists, trusted proxy, and rate limiting:

```text
MCP_HOST, MCP_PORT, REST_API_BASE_URL, REST_API_TIMEOUT_MS
MCP_ALLOWED_HOSTS, MCP_ALLOWED_ORIGINS, MCP_TRUST_PROXY
MCP_RATE_LIMIT_ENABLED, MCP_RATE_LIMIT_MAX, MCP_RATE_LIMIT_WINDOW_MS
```

No API-key, JWT, OAuth, login, session, or authorization configuration exists.

## 14. Security and Query Protection

The services are intentionally anonymous, but capacity and query surfaces are constrained:

- REST uses only `meshcore_http`, validates public schema ID `meshcore-mqtt-broker-postgres-v1` version `8`, and references only `meshcore_public`.
- Repository values are bound parameters. User table names, columns, SQL fragments, and arbitrary expressions are never accepted.
- Sort expressions and filters are endpoint-specific allowlists.
- Geographic search uses qualified PostGIS functions with bound coordinates/radius.
- Page sizes, body sizes, docs file size, docs search work, activity buckets, cursor length, and text fields are bounded.
- REST and MCP have configurable IP-aware rate limiting and explicit trusted-proxy handling.
- MCP additionally applies official Host and Origin validation to `/mcp`; this is request-origin protection, not authentication.
- REST errors are sanitized and include request IDs. MCP propagates safe REST error codes and request IDs without response bodies in operational logs.
- Documentation repository URLs cannot contain credentials, and checkout files are read but never executed.
- Source tests scan all production REST TypeScript files for `meshcore_private` references and exercise injection-like values across every free-text SQL filter family.

No raw SQL, writes, authentication scaffolding, private MQTT metadata, or database credentials are exposed publicly.

## 15. Test and Audit Results

Final REST verification completed successfully:

```text
TypeScript typecheck: passed
Vitest: 60 tests passed
Production build: passed
npm audit: passed
```

The REST suite covers domain routes, anonymous access, filtering, complete PostGIS radius SQL, region membership, one-way and reciprocal neighbors, observer same-key location, IATA mapping, packet bytes/privacy, bounded messages, telemetry, trace ambiguity, activity validation, cursors, broad injection binding, private-schema source scanning, docs clone/update/stale/unavailable safety, deterministic docs ordering, rate limiting, and OpenAPI documentation requirements.

Final MCP verification completed successfully:

```text
TypeScript typecheck: passed
Vitest: 16 tests passed
Production build: passed
npm audit: passed
```

MCP dependency inspection confirmed modular `@modelcontextprotocol/server`, `@modelcontextprotocol/fastify`, and `@modelcontextprotocol/node` at `2.0.0`, with no monolithic V1 package and no `server-legacy`. Official modular V2 client tests covered modern negotiation, 23-tool discovery/mapping, output-schema discovery and structured-output validation, anonymous use, stateless fresh-client cursor continuation, safe errors, input bounds, Host/Origin checks, rate limiting, request correlation/cancellation, and legacy rejection.

The documentation hardening follow-up was verified locally after these original final checks:

```text
REST TypeScript typecheck: passed
REST Vitest: 56 tests passed
REST production build: passed
MCP TypeScript typecheck: passed
MCP Vitest: 16 tests passed
MCP production build: passed
Root docker compose config: passed with a temporary non-secret password placeholder
Deployment/live runtime: not run for this follow-up
```

Earlier deep live checks covered domain semantics, forbidden routes, packet privacy, pagination, and MCP behavior. Final public REST checks from the server returned HTTP 200 for every listed public route in the final route sweep.

## 16. Docker Compose Config Result

`docker compose config` succeeded for the local/root deployment and for the remote deployment configuration. The rendered topology retained local `build:` definitions, REST-only database-network access, the internal REST/MCP network, proxy attachment, health-dependent MCP startup, environment substitution, and the persistent docs volume.

## 17. Docker Compose Build Result

Local/root Docker image builds succeeded for both REST and MCP. Remote Compose builds also succeeded for both services. Images were built from the workspace Dockerfiles; no custom image pull or registry publication was required.

## 18. Runtime Health and Readiness

Remote deployment succeeded with broker digest `sha256:1cd14b1c4ecd6bbbdb9d10a7fb5ef088908b767829c9f5fd28e8333b66de3359`; broker, REST, and MCP reached healthy state. PostgreSQL reported public schema version 6 and only the `iata` ingress column. Live REST checks found 27 allowlisted docs, blocked a JavaScript asset with 404, returned numeric stats, found 103 recently active observers and 10 unique logical messages, and found no malformed public IATA observations. The official MCP V2 runtime check negotiated `2026-07-28`, discovered output schemas on all 23 tools, preserved non-cursor docs search metadata, filtered active observers, and retrieved a message by its logical ID.

The CrowdSec decision for the verifier IP was removed. After the bouncer cache refreshed, public REST and MCP health checks returned HTTP 200; the earlier HTTP 403 was a transient cache observation rather than an application container health or route failure.

## 19. Remaining Limitations and Blockers

- The read-only reference schema has no ideal leading timeline index for the global telemetry collection. Results are bounded and keyset-paginated, but the index cannot be added in this workspace.
- `/v1/meshcore/stats` currently performs exact full-table aggregate counts. Production measurement was approximately 141 ms, but the implementation has no bounded-cost guarantee as data grows.
- OpenAPI is valid, but Redocly reported 74 style warnings, mainly absent `operationId` values.
- The supported docs-cache lifecycle assumes one REST writer/replica for the shared volume.
- Broker commit `1126324` was pushed directly to `main` as requested; GitHub Actions run `32644268616` published the verified multi-platform image.
- Meshtastic remains a future source; the architecture supports it, but no Meshtastic routes or backend are implemented.

No implementation blocker prevents the verified REST or MCP services from running. The two substantive database-performance limitations are the global telemetry index and the lack of a future bounded-cost guarantee for exact stats counts.
