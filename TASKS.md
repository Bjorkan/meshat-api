# TASKS.md — Meshat.se Domain REST API + MCP-V2

Mark `[x]` only after implementation **and verification**.

If blocked, leave the task unchecked and append `BLOCKED: <reason>`.

Before ending a work session, update this file to reflect actual progress.

Audit evidence (2026-08-23): broker schema-v6 commit `1126324`, 211 PostgreSQL-backed tests, build, lint, successful image workflow `32644268616`, published digest `sha256:1cd14b1c4ecd6bbbdb9d10a7fb5ef088908b767829c9f5fd28e8333b66de3359`, and healthy production deployment; REST typecheck, 60 tests, build, local/root and remote Docker builds; MCP modular V2 packages 2.0.0, no monolithic V1 or `server-legacy`, typecheck, 16 tests, build, and local/root and remote Docker builds; public schema version 6 with `iata` rather than ingress `region`; live checks for active observers, logical messages, numeric counts, docs restrictions, REST readiness, and MCP `2026-07-28` with 23 output-schema tools. Fresh docs remained on `main` commit `1f2c230215e5423bceecb4183d86c738932b4ed6`.

Normative fix round, schema v9 (2026-08-23): coordinated REST+MCP (`meshat-apis`) and broker (`meshcore-mqtt-broker`) remediation of the deep bug report; work log in `FIXLOG.md`, decisions in `DECISIONS.md`. Broker schema v9 stores a real SHA-256 public-contract fingerprint (static initdb writes `pending`, repaired on first start), adds private `node_adverts.owner_public_key` and `observers.latest_iata_event_id`, 229 PostgreSQL-backed tests (10 new regression tests), build/lint/format clean. REST 69 tests and MCP 17 tests pass with typecheck/build clean. Semantics now enforced: canonical entity-region evidence relation drives node/observer region filters, region nodes, and region summary counts (a reporter never inherits a neighbor's region; region `observer_count` equals `search_observers(region)` cardinality); node/observer region/IATA filters correlate evidence time with `seen_from`/`seen_to`; activity lost its `region` filter entirely; rate limiting no longer trusts the HTTP Host header; trace hops classify >1 current candidates as ambiguous only; region `prefix` normalizes Swedish codes to lowercase before SQL and cursor fingerprints; readiness publishes `release_id`, `schema_version`, and matching schema fingerprint in both services and refuses on mismatch; every MCP tool validates REST responses against explicit semantic output schemas and fails closed with `UPSTREAM_CONTRACT_ERROR`.

Coordinated v9 release live (2026-08-24): broker commits `8e8bc35` + `76cb87f` pushed to `Bjorkan/meshcore-mqtt-broker@main`; CI ran 229 PostgreSQL-backed tests, built, and published `bjorkan/meshcore-mqtt-broker@sha256:87602920aea4…`. A search-path-dependent `pg_get_constraintdef()` qualification drift was found during rollout and fixed in both fingerprint implementations (`SET search_path = pg_catalog` on one dedicated client). Production DB at production-host was backed up (`~/meshcore-pre-v9-20260824-2144.sql.gz`, 257 MB) then auto-reprovisioned to schema v9 per the documented clean-install lifecycle: `schema_version = 9`, real fingerprint `7fb7ea2f…` written by the broker. REST/MCP source synced to `~/PostgresDB/meshat-apis`, deployed as `1.0.0-v9` / `2.0.0-v9`, both containers healthy. Live verification: REST `/readyz` reports release/schema-version/fingerprint identical to the DB marker; `prefix=SE13` normalizes to lowercase; activity rejects `region` with 400; fresh-session MCP discovery shows 23 tools with canonical `lp_` patterns, no activity region argument, working list/iata/stats/regions/activity tools through semantic output schemas; observers reconnected and ingest is repopulating. `corescope_corescope` swarm service was force-updated on request after the MQTT restart.

---

Region scope and message-contract follow-up (2026-08-23): broker commit `b3fcb58` adds the SCB-based Swedish region scope registry with canonical lowercase `se`/`seXX`/`seXXXX` scopes and named JSON projections, schema version 7, 218 PostgreSQL-backed tests, and published digest `sha256:7e605949975f7a16161227ff7468055a144450c2a6e416bc6823db8004f629ae`; REST 61 tests and MCP 16 tests with message IDs requiring the `lp_` prefix, `representative_packet_sha256` replacing singular `packet_sha256` on messages, and a `logical_id` packet filter; live checks confirmed 400s for bare IDs, successful logical-ID lookups, and packet-variant listing through both REST and MCP.

Region registry deployment (2026-08-23): broker commits `cbe4562`, `713d721`, and `a73e730` add the public `region_scopes` registry table (schema version 8, 219 tests) seeded with all 312 built-in Swedish scopes (municipality names hardcoded from the official Swedish municipality list, `*` named `Unscoped`) and upserted with detected scopes; production seed fix ensures registry rows on every pool open; published digest `sha256:31589029326dedcb4fab2efc115edb542be22488fa4b2c0a5ff09893cc2dd8cd`. REST 62 tests serve registry-driven regions with `region`, `name`, `first_seen`, `last_seen`, `manually_added`, `observation_count`, node/observer counts, and `last_activity`; uppercase Swedish region inputs normalize to lowercase. Live checks confirmed 317 regions, `se01` → `Stockholms län` with zero counts before evidence, `se1380` → `Halmstads kommun`, `*` → `Unscoped`, and MCP `list_regions`/`get_region` with names.

Deep regression remediation (2026-08-23): REST 63 tests and MCP 16 tests. MCP logical-ID tool schemas now use one canonical advertised-and-runtime pattern `^lp_[0-9a-fA-F]{64}$` for both `get_message` and `search_packets.logical_id`, verified equal across repeated fresh-client discovery. Observer region filters bind evidence to the same `seen_from`/`seen_to` window as the general activity filter. Message search returns canonical resource fields identical to `get_message` plus explicit `matched.iata`/`matched.observation_count` query scope. `list_regions` is a bounded keyset-paginated catalog with `observed_only`, `manually_added`, and `prefix` in REST and MCP. `stats.regions` is now `{ configured, observed }`. Traces expose `observer` and `logical_id`. Region objects include observer and activity links. Live checks confirmed discovery hashes, five-item cursor pages without overlap, 9 observed regions, canonical/matched message equality, evidence-time-bound observer filtering, and numeric stats.

Code quality tooling (2026-08-24): ESLint 10 + typescript-eslint 8.67 flat configs with type-aware linting (project service) added to both `restful-api/` and `mcp-server-v2/`, plus Prettier 3.9 (`.prettierrc.json`, `.prettierignore`) and scripts `lint`, `lint:fix`, `format`, `format:check`, `check` in both package.json files. Active rules include no-floating-promises, no-misused-promises, await-thenable, switch-exhaustiveness-check, no-unnecessary-type-assertion, and the no-unsafe-* family; require-await stays on for src but is off for REST tests (fake async interfaces), documented in config. Per human instruction during implementation, no custom ESLint rules were written; SQL safety remains a convention enforced via the `add()` bound-parameter helper, allowlisted sort/identifier records, and PostgreSQL-backed tests. Fixes driven by the new rules: SIGTERM handlers wrapped as intentional fire-and-forget, sync Fastify handlers de-asynced, `unknown | null` unions collapsed, pg rows narrowed to unknown-valued records, typed boundaries for inject().json() and OpenAPI documents in tests, explicit row shapes for schema fingerprint queries. Practical probes confirmed floating-promise and non-exhaustive-switch detection and Prettier auto-format. Verified per project: format:check, lint (0 warnings), typecheck, tests (REST 69, MCP 17), build. AGENTS.md documents the required workflow; opencode.json allows the eight npm quality commands.

SQL hardening round (2026-08-24): after human review decisions (target architecture C = branded fragments, bridge B = local AST rule; no "module scope is trusted" escape hatch), added `restful-api/eslint-rules/no-unsafe-sql-interpolation.mjs` plus `src/sql.ts` branded types (`SqlParam`, `SqlFragment`, `frag()`/`param()` identity helpers as the single trusted boundary) and refactored `repository.ts` accordingly: `add()` returns `SqlParam`, `where()`/select constants/sort maps/historyPage+protocolPage fragment arguments are `SqlFragment`, node alias parameter removed, packet matched-received-at expression built through `frag()`. The rule fails closed without type information, allows compile-time string literal unions (e.g. SortOrder) in addition to brands, flags concatenation into query calls, and has a 16-case RuleTester suite (`tests/eslint-rules/`) using an on-disk fixture target so the project service accepts the virtual files. Practical probe: `pool.query(\`SELECT * FROM nodes WHERE name = '${name}'\`)` is rejected with a stable message. Verified REST format:check, lint (0 warnings), typecheck, 85 tests (69 domain + 16 rule), build, full check; MCP check unchanged and green (rule intentionally not installed there - no SQL). NOTE: no PostgreSQL integration tests were run or exist in this workspace's test suite; the fake-based suite does not execute SQL against a real database, and no SQL semantics were changed in this round (string values identical, only TypeScript typing/wrapping).

Opaque SQL boundary round (2026-08-24): implementing the human follow-up decisions on the two remaining gaps (cast-lying literal unions; frag() as general bypass). `src/sql.ts` now brands `SqlParam`/`SqlFragment` with unexported unique symbols (opaque; ordinary structural construction impossible) and exposes only: the tagged-template composer `` sql`...` `` (slots accept `SqlParam | SqlFragment`, raw strings are a compile error), `joinSql(parts, separator)`, runtime-allowlisted `sqlDirection(direction)`, and number-only `placeholder(index)`; the general `frag(string)`/`param(string)` constructors were removed. `meshat/no-unsafe-sql-interpolation` no longer trusts string-literal unions on type information alone - a cast like `request.query.order as "asc" | "desc"` is flagged (proven by probe and RuleTester case); AST-provable literals remain valid. New rule `meshat/no-sql-brand-casts` rejects casts to the brands outside `src/sql.ts` (alias-symbol, structural-substring and textual detection; verified against inline `import()` type casts). `repository.ts` was rewired mechanically to the composer/helpers - clause arrays are `SqlFragment[]`, ORDER BY directions go through `sqlDirection(request.order)`, getObserver uses `placeholder(2)`, packet matched-received-at composes via `joinSql`; SQL text semantics unchanged. Rule suites grew to 22 cases (16 interpolation + 6 brand-cast); 91 REST tests pass total with format:check, lint (0 warnings), typecheck, build and full check green; MCP check remains green and untouched. Same caveat as before: fake-based tests only, no PostgreSQL execution, no SQL-semantics changes.

---

## Phase 1 — Read and inspect

- [x] Read root `AGENTS.md`.
- [x] Read `PROMPT.md`.
- [x] Read `API-CONTRACT.md`.
- [x] Read reference `DATABASE.md`.
- [x] Read reference `ARCHITECTURE.md`.
- [x] Read reference `config.yaml` IATA mapping.
- [x] Read public schema SQL.
- [x] Inspect `src/database.ts` projections/relationships.
- [x] Inspect neighbor implementation/tests.
- [x] Inspect region registry/config behavior.
- [x] Confirm DB host alias.
- [x] Confirm DB external Docker network.
- [x] Confirm `meshcore_http` grants/read-only behavior.
- [x] Confirm useful indexes/stable pagination keys.
- [x] Document any reference ambiguity in `DECISIONS.md` rather than guessing silently.

---

## Phase 2 — Project setup

### REST

- [x] Create/verify Node.js + TypeScript + ESM project.
- [x] Add Fastify or equivalent small framework.
- [x] Add `pg`.
- [x] Add runtime validation/schema tooling.
- [x] Add Swagger/OpenAPI and Swagger UI.
- [x] Add CORS.
- [x] Add rate limiting.
- [x] Add structured logging.
- [x] Add test framework.
- [x] Add `Dockerfile`.
- [x] Add `.dockerignore`.
- [x] Add README.

### MCP

- [x] Create/verify Node.js + TypeScript + ESM project.
- [x] Add official MCP TypeScript SDK.
- [x] Verify support for stable MCP 2026-07-28/current corresponding SDK API.
- [x] Add REST HTTP client layer.
- [x] Add validation/schema tooling.
- [x] Add structured logging.
- [x] Add test framework.
- [x] Add `Dockerfile`.
- [x] Add `.dockerignore`.
- [x] Add README.

---

## Phase 3 — Environment and Git hygiene

- [x] Keep `.env` ignored.
- [x] Keep `.env.example` tracked.
- [x] Use `DATABASE_HOST`.
- [x] Use `DATABASE_PORT`.
- [x] Use `DATABASE_NAME`.
- [x] Use `DATABASE_USER=meshcore_http`.
- [x] Use `DATABASE_PASSWORD`.
- [x] Use `DATABASE_SSL`.
- [x] Use `DATABASE_POOL_MAX`.
- [x] Use `DATABASE_NETWORK`.
- [x] Use `REST_HOST`/`REST_PORT`.
- [x] Use `MCP_HOST`/`MCP_PORT`.
- [x] Use `REST_API_BASE_URL`.
- [x] Use CORS/rate-limit/proxy settings.
- [x] Add docs repository settings.
- [x] Do not add password-file settings.
- [x] Do not add API-key/JWT/OAuth settings.

---

## Phase 4 — REST platform foundation

- [x] Create central app/bootstrap module.
- [x] Add request ID support.
- [x] Add structured error envelope.
- [x] Add graceful shutdown.
- [x] Add DB pool only to REST.
- [x] Add safe DB query/repository helpers.
- [x] Add ISO timestamp conversion helpers.
- [x] Add location normalization helpers.
- [x] Add opaque stateless cursor utility.
- [x] Add cursor query/filter binding/fingerprint.
- [x] Add controlled sort enum helpers.
- [x] Add rate limiting.
- [x] Add body/request limits.
- [x] Ensure no generic table/schema/query router exists.

---

## Phase 5 — Database safety

- [x] REST uses `meshcore_http`.
- [x] REST queries only `meshcore_public`.
- [x] No `meshcore_private` query exists.
- [x] All values are bound parameters.
- [x] Dynamic identifiers are avoided or strictly internal/allowlisted.
- [x] No user-supplied table name reaches SQL.
- [x] No user-supplied SQL column name reaches SQL.
- [x] No arbitrary SQL expression is accepted.
- [x] Max pool size defaults around 4.
- [x] Statement timeout/read-only DB protections are preserved.
- [ ] Large collections use indexed keyset queries. BLOCKED: Global telemetry lacks an ideal leading timeline index in the read-only reference schema.

---

## Phase 6 — System and Swagger

- [x] `GET /`
- [x] `GET /healthz`
- [x] `GET /readyz`
- [x] `GET /docs` Swagger UI.
- [x] `GET /openapi.json`.
- [x] Swagger title is `Meshat.se REST API`.
- [x] Swagger "Try it out" works anonymously.
- [x] No OpenAPI auth security scheme exists.
- [x] Swagger clearly distinguishes `/docs` from `/v1/docs`.
- [x] Every public domain route has summary/description/schema/examples.

---

## Phase 7 — Source discovery

- [x] `GET /v1/sources`.
- [x] MeshCore item has id/name/description/status/version/url/docs URL.
- [x] MeshCore capabilities are useful and stable.
- [x] Design can add Meshtastic later without changing route philosophy.

---

## Phase 8 — MeshCore overview

- [x] `GET /v1/meshcore`.
- [x] Returns source identity/status.
- [x] Links to all implemented MeshCore domain resources.
- [x] Does not mention DB tables/schemas.

---

## Phase 9 — IATA registry

- [x] Parse/copy canonical primary IATA mapping from reference config into REST-owned domain data.
- [x] Preserve required attribution/license notes.
- [x] Represent secondary IATA -> primary IATA relationship.
- [x] `GET /v1/meshcore/iata`.
- [x] `GET /v1/meshcore/iata/{code}`.
- [x] Normalize code input to uppercase.
- [x] Return friendly names where known.
- [x] Return useful current summary/counts where queries are cheap/indexed.
- [x] Document that IATA is geographic ingress, not MeshCore region/scope.

---

## Phase 10 — MeshCore logical regions

- [x] Model public region from neighbor scope data.
- [x] Do not expose public `scope` routes.
- [x] `GET /v1/meshcore/regions`.
- [x] `GET /v1/meshcore/regions/{region}`.
- [x] `GET /v1/meshcore/regions/{region}/nodes`.
- [x] Return node count/reporting observer count/last activity where feasible.
- [x] Keep IATA and region filtering/semantics separate.

---

## Phase 11 — Nodes

- [x] `GET /v1/meshcore/nodes`.
- [x] `GET /v1/meshcore/nodes/{public_key}`.
- [x] `GET /v1/meshcore/nodes/{public_key}/adverts`.
- [x] `GET /v1/meshcore/nodes/{public_key}/sightings`.
- [x] `GET /v1/meshcore/nodes/{public_key}/telemetry`.
- [x] Filter by name.
- [x] Filter by role.
- [x] Filter by MeshCore region.
- [x] Filter by IATA.
- [x] Filter by seen time range.
- [x] Geographic near/radius filter.
- [x] Controlled sort values.
- [x] Stateless cursor pagination.
- [x] Finished node objects with ISO timestamps and normalized location.

---

## Phase 12 — Node neighbors

- [x] `GET /v1/meshcore/nodes/{public_key}/neighbors`.
- [x] Use current/relevant neighbor report evidence.
- [x] Include direct reports where node/observer reports neighbors.
- [x] Include reverse evidence where other observers report this node, when useful.
- [x] Do not claim bidirectional relation without both directions.
- [x] Define relationship status precisely.
- [x] Expose last-heard time.
- [x] Expose SNR/RSSI where available.
- [x] Expose MeshCore regions.
- [x] Expose evidence/report counts without leaking DB snapshot mechanics.
- [x] Add tests for one-way vs reciprocal evidence.
- [x] No raw neighbor snapshot table endpoint exists.

---

## Phase 13 — Observers

- [x] `GET /v1/meshcore/observers`.
- [x] `GET /v1/meshcore/observers/{public_key}`.
- [x] `GET /v1/meshcore/observers/{public_key}/status`.
- [x] `GET /v1/meshcore/observers/{public_key}/metrics`.
- [x] Filter by active state.
- [x] Filter by name/label.
- [x] Filter by IATA.
- [x] Filter by MeshCore region where meaningfully derivable.
- [x] Filter by seen time range.
- [x] Geographic near/radius filter.
- [x] Observer location comes from same-public-key node location.
- [x] Controlled sorting.
- [x] Stateless cursor where collection/history can grow.

---

## Phase 14 — Packets

- [x] `GET /v1/meshcore/packets`.
- [x] `GET /v1/meshcore/packets/{sha256}`.
- [x] `GET /v1/meshcore/packets/{sha256}/observations`.
- [x] Controlled packet filters.
- [x] Observer filter.
- [x] IATA filter via observation/hearing data.
- [x] Time-range filters.
- [x] Stateless cursor.
- [x] Packet detail exposes MeshCore raw bytes as `raw` hex string.
- [x] Raw MQTT/private ingest data is not exposed.
- [x] Observation response normalizes observer/IATA/signal/path information.

---

## Phase 15 — Messages

- [x] `GET /v1/meshcore/messages`.
- [x] `GET /v1/meshcore/messages/{id}`.
- [x] Sender filter.
- [x] Destination filter.
- [x] Channel/channel-name filter.
- [x] Message type filter.
- [x] Encrypted filter.
- [x] Signature filter.
- [x] IATA filter.
- [x] Time-range filter.
- [x] Default page size approximately 50.
- [x] Hard maximum approximately 200 or another documented safe value.
- [x] Stateless opaque cursor continuation.
- [x] Public message text is returned when present in public projection.

---

## Phase 16 — Telemetry

- [x] `GET /v1/meshcore/telemetry`.
- [x] `GET /v1/meshcore/telemetry/{id}`.
- [x] Node filter.
- [x] Metric filter.
- [x] IATA filter.
- [x] Time-range filter.
- [x] Controlled sort.
- [x] Stateless cursor.
- [x] Finished typed value representation.

---

## Phase 17 — Traces

- [x] `GET /v1/meshcore/traces`.
- [x] `GET /v1/meshcore/traces/{id}`.
- [x] `GET /v1/meshcore/traces/{id}/hops`.
- [x] Source-node filter.
- [x] Tag filter.
- [x] IATA filter.
- [x] Time-range filter.
- [x] Stateless cursor.
- [x] Preserve ambiguous hop resolution/confidence information in domain form.

---

## Phase 18 — Stats and activity

- [x] `GET /v1/meshcore/stats`.
- [x] Define/document each statistic.
- [ ] Avoid unbounded expensive counts. BLOCKED: Current stats use exact full-table aggregate counts; production measured approximately 141 ms, but bounded cost as data grows is not guaranteed.
- [x] `GET /v1/meshcore/activity`.
- [x] Allowlisted windows.
- [x] Allowlisted intervals.
- [x] Validate sensible window/interval pairs.
- [x] Optional IATA filter.
- [x] Optional MeshCore region filter.
- [x] Return ISO UTC buckets.

---

## Phase 19 — Documentation clone/cache subsystem

- [x] Add `DOCS_GIT_REPOSITORY` defaulting to `https://codeberg.org/meshat/hemsidan.git`.
- [x] Add `DOCS_GIT_REF`.
- [x] Add `DOCS_CACHE_DIR`.
- [x] Add `DOCS_SUBDIR=docs`.
- [x] Add max docs file size setting.
- [x] REST image contains Git runtime if Git CLI implementation is used.
- [x] On startup, shallow clone when cache is missing.
- [x] On startup, fetch/update configured ref when cache exists.
- [x] Repository URL is deployment configuration, not request input.
- [x] Never execute checkout files.
- [x] Serve only repository `/docs` subtree.
- [x] Reject `..` path traversal.
- [x] Reject absolute filesystem paths.
- [x] Reject symlink escapes.
- [x] Never expose `.git`.
- [x] Persist checkout in Compose volume.
- [x] If refresh fails and cache exists, serve stale cache and report degraded status.
- [x] If no cache exists and clone fails, core API remains available and docs return 503.
- [x] Log docs commit/ref/status without leaking secrets.

---

## Phase 20 — Documentation API

- [x] `GET /v1/docs` returns sorted recursive index.
- [x] Index includes path/title/media type/size where available.
- [x] Index includes repository/ref/commit/status metadata.
- [x] `GET /v1/docs/search?q=...`.
- [x] Docs search is bounded.
- [x] Docs search returns useful snippets.
- [x] `GET /v1/docs/{path...}`.
- [x] Markdown/text returned as machine-friendly content.
- [x] File size limit enforced.
- [x] Unknown file -> 404.
- [x] Docs unavailable -> stable 503 error.

---

## Phase 21 — Cursor implementation verification

- [x] Cursor is opaque.
- [x] Cursor requires no server-side session/cache.
- [x] Cursor includes versioning.
- [x] Cursor uses stable keyset state.
- [x] Cursor is bound to resource/query/filter state as appropriate.
- [x] Malformed cursor rejected.
- [x] Cursor reused with incompatible filters rejected safely.
- [x] `has_more` and `next_cursor` are correct.
- [x] No large OFFSET query is used for high-volume endpoints.

---

## Phase 22 — MCP base

- [x] Use official MCP TypeScript SDK.
- [x] Implement stable MCP 2026-07-28/current corresponding SDK behavior.
- [x] `/mcp` works.
- [x] `GET /healthz` works.
- [x] `GET /readyz` works.
- [x] MCP is stateless.
- [x] No sticky-session requirement.
- [x] No authentication/API key.
- [x] MCP only knows `REST_API_BASE_URL` for data/docs.
- [x] No DB credentials in MCP container.
- [x] No docs Git clone in MCP container.
- [x] Every tool declares and validates an output schema.

---

## Phase 23 — MCP source/overview tools

- [x] `list_sources`.
- [x] `get_source`.
- [x] `get_meshcore_overview`.
- [x] Tool descriptions are clear and concise.

---

## Phase 24 — MCP node/observer tools

- [x] `search_nodes`.
- [x] `get_node`.
- [x] `get_node_neighbors`.
- [x] `search_observers`.
- [x] `get_observer`.
- [x] Expose REST filters as structured tool arguments.
- [x] Pass/return stateless cursor.

---

## Phase 25 — MCP region/IATA tools

- [x] `list_regions`.
- [x] `get_region`.
- [x] `list_iata`.
- [x] `get_iata`.
- [x] Tool descriptions explicitly distinguish MeshCore regions from IATA geography.

---

## Phase 26 — MCP packet/message/protocol tools

- [x] `search_packets`.
- [x] `get_packet`.
- [x] `search_messages`.
- [x] `get_message`.
- [x] `search_telemetry`.
- [x] `search_traces`.
- [x] Bounded limits.
- [x] Stateless cursor pass-through.
- [x] No raw SQL/database tool.

---

## Phase 27 — MCP stats/docs tools

- [x] `get_meshcore_stats`.
- [x] `get_meshcore_activity`.
- [x] `list_docs`.
- [x] `search_docs`.
- [x] `get_doc`.
- [x] Docs tools use REST only.

---

## Phase 28 — MCP failure handling

- [x] REST unavailable -> useful MCP error, no crash.
- [x] REST timeout -> useful MCP error.
- [x] REST 429 -> useful MCP error.
- [x] Invalid cursor -> useful MCP error.
- [x] Not found -> useful MCP error.
- [x] Docs unavailable -> useful MCP error.
- [x] Subsequent cursor call works on a fresh MCP instance with no session state.

---

## Phase 29 — Docker / Compose

- [x] REST Dockerfile is multi-stage where sensible.
- [x] MCP Dockerfile is multi-stage where sensible.
- [x] Both runtime containers use non-root users.
- [x] REST runtime includes Git if needed for docs refresh.
- [x] Shared root `compose.yaml` created.
- [x] Both services use local `build:`.
- [x] REST joins DB external network.
- [x] REST and MCP share internal service network.
- [x] MCP does not join DB network.
- [x] MCP depends on healthy/ready REST as appropriate.
- [x] Add named persistent docs cache volume.
- [x] Use `.env`.
- [x] Do not use Docker secret/password files.
- [x] Do not use remote images for custom services.

---

## Phase 30 — REST tests

- [x] Public root/health/readiness.
- [x] `/v1/sources` response contract.
- [x] `/v1/meshcore` response contract.
- [x] No `/v1/tables` route.
- [x] No `/v1/query` route.
- [x] No `/v1/schema` route.
- [x] Node filters/sorting/cursor.
- [x] Geographic node search.
- [x] IATA node filter.
- [x] MeshCore region node filter.
- [x] Neighbor one-way evidence.
- [x] Neighbor reciprocal evidence.
- [x] Observer location via same-key node.
- [x] Observer geographic filter.
- [x] IATA mapping/detail.
- [x] Region listing/detail/nodes.
- [x] Packet list/detail.
- [x] Packet `raw` is MeshCore bytes.
- [x] Raw MQTT metadata not present.
- [x] Message bounded pagination.
- [x] Telemetry.
- [x] Traces/hops.
- [x] Stats.
- [x] Activity allowed windows/intervals.
- [x] Cursor malformed/mismatched cases.
- [x] SQL injection strings in all text filters remain values, never syntax.
- [x] No private-schema query.
- [x] Rate limiting.
- [x] No auth required.
- [x] Swagger/OpenAPI works.
- [x] OpenAPI contains no auth scheme.

---

## Phase 31 — Docs tests

- [x] Missing cache -> clone path tested/mocked appropriately.
- [x] Existing cache -> update path tested.
- [x] Refresh failure + valid cache -> stale fallback.
- [x] Refresh failure + no cache -> docs 503, core API still works.
- [x] `/v1/docs` index sorted/deterministic.
- [x] `/v1/docs/search` returns bounded snippets.
- [x] `/v1/docs/{path}` returns content.
- [x] `../` traversal rejected.
- [x] Encoded traversal rejected.
- [x] Absolute paths rejected.
- [x] Symlink escape rejected.
- [x] `.git` not exposed.
- [x] Max file size enforced.
- [x] Public docs allowlist is only lowercase `**/*.md` plus exact `meshtastic/example.yaml`.
- [x] Existing non-public assets return not found and no docs response uses base64.
- [x] Invalid UTF-8 and oversized documents are excluded from index/search.
- [x] Docs inline size defaults to and is capped at 65536 bytes.
- [x] Search candidates are deterministically sorted and search metadata reports scan/result truncation without a cursor.

---

## Phase 32 — MCP tests

- [x] Official SDK client can call server.
- [x] Public anonymous access.
- [x] Tool discovery.
- [x] Tool discovery includes output schemas for all tools.
- [x] Successful structured output validates against the advertised schema.
- [x] No DB/table/SQL tools present.
- [x] `list_sources`.
- [x] `search_nodes` + continuation cursor.
- [x] `get_node_neighbors`.
- [x] `search_observers`.
- [x] `list_regions`/`get_region`.
- [x] `list_iata`/`get_iata`.
- [x] `search_packets`/`get_packet`.
- [x] `search_messages` + continuation cursor.
- [x] `search_telemetry`.
- [x] `search_traces`.
- [x] stats/activity tools.
- [x] list/search/get docs.
- [x] Stateless cursor continuation on fresh MCP instance.
- [x] REST unavailable/timeout/429 handling.
- [x] MCP does not require DB credentials.
- [x] Docs tools use distinct normalizers and accurate tool-specific output schemas.
- [x] `search_docs` returns explicit REST search metadata without `next_cursor`.
- [x] Docs tools reject malformed binary MIME, base64, oversized, and cursor-like REST responses.

Documentation hardening verification (2026-08-23): REST typecheck, 56 tests, and production build passed; MCP typecheck, 16 tests, and production build passed; root `docker compose config --quiet` passed with a temporary non-secret password placeholder. The later prelaunch remediation below supersedes this local-only checkpoint with deployment and live verification.

Prelaunch remediation verification (2026-08-23):

- [x] Broker requires configured primary IATA and keeps neighbor scope as MeshCore region evidence.
- [x] Broker schema v6 uses `iata` columns and rejects normalized non-three-letter ingress values.
- [x] Broker schema v7 keeps canonical lowercase `se`/`seXX`/`seXXXX` region scopes with named JSON scope projections.
- [x] Message IDs require the `lp_` prefix everywhere; `representative_packet_sha256` names the latest matching packet.
- [x] Packet search accepts `logical_id` to list all packet variants of one logical message.
- [x] Production test ingress is disabled and unknown IATA is rejected before normalized history.
- [x] Observer `active` is derived from a documented recent-ingest window.
- [x] Messages are deduplicated by stable logical identity with aggregated IATA evidence.
- [x] Region node counts include known nodes and observer counts use reporting observers consistently.
- [x] Stats/activity message counts use logical messages and all public aggregate counts are numbers.
- [x] Inverted seen/received ranges are rejected by REST and MCP.
- [x] Unknown IATA filters are rejected and secondary codes resolve to their configured primary ingress.
- [x] Packet received-time sorting uses the latest observation matching all observation/node filters.
- [x] Telemetry availability is explicitly reported as limited pending decodable production payloads.
- [x] Broker, REST, MCP, Compose, image publication, schema transition, health/readiness, and deep live contracts were verified.

---

## Phase 33 — Integration verification

- [x] `docker compose config` succeeds.
- [x] `docker compose build` succeeds.
- [x] `docker compose up -d` succeeds.
- [x] REST health/readiness succeeds.
- [x] MCP health/readiness succeeds.
- [x] `/v1/sources` succeeds anonymously.
- [x] `/v1/meshcore` succeeds anonymously.
- [x] `/v1/meshcore/nodes` succeeds anonymously.
- [x] `/v1/meshcore/iata` succeeds anonymously.
- [x] `/v1/meshcore/regions` succeeds anonymously.
- [x] `/v1/meshcore/messages` succeeds anonymously.
- [x] `/v1/docs` returns repository docs or documented degraded result.
- [x] `/docs` renders Swagger UI.
- [x] `/openapi.json` validates.
- [x] Real MCP client/SDK can invoke at least one domain tool.
- [x] Real MCP client/SDK can paginate a list tool statelessly.
- [ ] No source/image push occurs. BLOCKED: External push history cannot be independently proven from this workspace audit; no push command was run.

---

## Phase 34 — Documentation

### REST README

- [x] Explain public anonymous read-only model.
- [x] Explain `/v1` route structure.
- [x] Explain IATA vs MeshCore region.
- [x] Document nodes/observers/neighbors.
- [x] Document packet raw field.
- [x] Document message cursor limits.
- [x] Document docs clone/cache behavior.
- [x] Document `/docs` Swagger vs `/v1/docs` content.
- [x] Document `.env`.
- [x] Document rate limits.
- [x] Document local Docker/Compose.

### MCP README

- [x] Explain REST-only backend.
- [x] Explain stateless MCP behavior.
- [x] Document domain tools.
- [x] Document cursor continuation.
- [x] Document docs tools.
- [x] Explicitly state no DB/table/SQL tools.
- [x] Document local Docker/Compose.

---

## Phase 35 — Final prohibitions check

- [x] No public `/tables` endpoint.
- [x] No public `/schema` endpoint.
- [x] No public generic `/query` endpoint.
- [x] No raw SQL input.
- [x] No `query_table` MCP tool.
- [x] No `list_tables` MCP tool.
- [x] No `describe_table` MCP tool.
- [x] No write REST endpoint.
- [x] No write MCP tool.
- [x] No API key support.
- [x] No JWT support.
- [x] No OAuth support.
- [x] No DB password hardcoded.
- [x] `.env` is gitignored.
- [x] MCP contains no DB credentials.
- [x] `meshcore_private` is not accessed.
- [x] Raw MQTT/private ingest metadata is not exposed.
- [ ] Nothing was pushed to GitHub/Codeberg/container registry. BLOCKED: External push history cannot be independently proven from this workspace audit; no push command was run.

---

## Phase 36 — Final report

Final implementation report: `FINAL-REPORT.md`.

- [x] Report files created/changed.
- [x] Report final REST endpoints.
- [x] Report domain response model decisions.
- [x] Report IATA vs region implementation.
- [x] Report neighbor aggregation semantics.
- [x] Report cursor implementation.
- [x] Report docs repository ref/commit and cache behavior.
- [x] Report Swagger/OpenAPI status.
- [x] Report MCP tools.
- [x] Report unit tests.
- [x] Report integration tests.
- [x] Report `docker compose config`.
- [x] Report `docker compose build`.
- [x] Report runtime health/readiness.
- [x] Report remaining blockers/limitations.
