# AI_WORK_DONE

Append-only work log. Newest entries last. Each entry records the actual
time (Europe/Stockholm), the actual model, the commit, what changed, why,
and how it was verified.

## 2026-08-25 00:18 CEST — ox-alpha

- Commit: not committed (working tree on `cf8635c`)
- Scope: implementation and simplification round for REST + MCP; raw MCP
  manifest verification; AI workflow file cleanup.

What:

- REST (`restful-api/`): every route's querystring and params JSON Schema
  is now derived from the same Zod schemas the handlers parse with
  (`documentedSchema()` / `paramsSchema()` over `zod-to-json-schema`,
  openApi3 target) instead of being hand-written in parallel. Deleted the
  seven hand-maintained query builders and five param helpers
  (~230 lines); added a small boolean→numeric `exclusiveMinimum`
  normalization for AJV compatibility.
- Evaluated and rejected for now: `fastify-type-provider-zod` (v5–v7).
  Its validator/serializer compilers are global per scope, its serializer
  requires all-Zod response models (current response JSON Schemas double
  as fast-json-stringify whitelists with curated examples asserted by
  tests), and zod-v4-core migration of responses cannot be verified
  against live data without a PostgreSQL-backed suite. The chosen
  derivation pattern delivers the same single-source guarantee for
  requests with zero wire-format change.
- Evaluated and kept: `pg` + branded `sql.ts` + local ESLint SQL rules.
  postgres.js would remove ~90 lines of local hardening but require
  rewriting 1000+ lines of repository SQL with no live-PostgreSQL test
  coverage here, and does not clearly expose statement_timeout; net risk
  exceeds net simplification. Verified trust boundaries intact:
  no `frag()`/`param()` constructors exist anymore, brands opaque,
  casts only inside `src/sql.ts`.
- Evaluated and kept: Node + npm runtime (Bun rejected — no dependency
  removals, official MCP SDK/Fastify stack already verified on Node,
  toolchain mixing forbidden).
- Evaluated and kept: current MCP Fastify wiring over
  `createMcpFastifyApp` — the factory offers nothing beyond the official
  hooks already used (`hostHeaderValidation`, `originValidation`,
  `createMcpHandler`, `toNodeHandler`) and lacks trustProxy/bodyLimit/
  logger options this service needs.
- MCP (`mcp-server-v2/`): new `src/version.ts` makes package.json the
  single version source (`MCP_RELEASE_ID` stays as optional deployment
  override, default now derives from package version); optional
  `MCP_BUILD_SHA` validated and exposed via `/healthz.build_sha`.
  Startup log line publishes service, version, release id, build SHA,
  protocol generation, tool count, and deterministic `tool_schema_sha256`
  fingerprint (SHA-256 over canonicalized name/description/inputSchema/
  outputSchema/annotations). Tool registration now announces static
  tools via public capabilities API: `tools.listChanged = false`.
- MCP tests: new `tests/manifest.test.ts` drives real Streamable HTTP
  with fresh official SDK clients: byte-identical normalized manifests
  across 10 fresh sessions; manifest unchanged after search_messages/
  list_regions/get_message calls within a session and across sessions;
  exact 23-tool set with no table/SQL tools; critical schema assertions
  (get_message `lp_` required input pattern vs lowercase output pattern,
  search_packets.logical_id, list_regions args, activity has no region,
  nodes/observers region+seen contract, observers own-public-key wording);
  serverInfo version surfaced.
- New `tests/live-manifest.mjs` + `npm run test:live` smoke script
  (skips unless `MCP_LIVE_BASE_URL` set): initialize, discovery schema
  assertions, search_messages/list_regions/stats calls; verified working
  against a locally built instance.
- Docs/workflow: deleted obsolete AI history files `TASKS.md`,
  `FIXLOG.md`, `FINAL-REPORT.md`, `DECISIONS.md`; permanent decisions
  they contained were folded into `restful-api/README.md` (trace hop
  classification semantics, IATA registry provenance). Created root
  `TODO.md` (open work only) and this append-only `AI_WORK_DONE.md`.
  Root `AGENTS.md` rewritten with permanent policies (session start/end,
  AI markdown policy, TODO policy, work-log policy, library policy,
  Node/Bun policy, SQL policy, MCP policy, test policy incl. fake-vs-
  integration honesty). Updated references in `PROMPT.md`,
  `opencode.json`, root `README.md`.

Why:

- Eliminate drift-prone duplicated request schema maintenance while
  preserving the public error contract exactly (AJV/Zod split untouched;
  all 91 REST tests pass unmodified except none needed changes).
- Prove with executable evidence where MCP discovery drift lives
  (server manifests are deterministic; deployed comparison pending
  network access) and make any future deployment drift observable from
  one startup log line or `/healthz`.
- Replace ad-hoc status/history markdown files with the two permanent
  workflow files so future agents have one TODO and one log.

Verification:

- Baseline before changes: `npm run check` green in both projects
  (REST 91 tests, MCP 17 tests).
- REST after: `npm run format:check`, `npm run lint` (0 warnings),
  `npm run typecheck`, `npm test` (91 passed), `npm run build`,
  full `npm run check` green. OpenAPI spot-checked: query parameter
  descriptions/patterns/defaults preserved; `radius_km`
  exclusiveMinimum normalized to numeric form.
- MCP after: full `npm run check` green (format/lint/typecheck/
  22 tests/build). New manifest tests pass, including 10-session
  determinism and post-tool-call stability. Live smoke script exercised
  end-to-end against local build ("LIVE SMOKE PASSED").
- Deployed live check NOT performed: `mcp.meshat.se` unreachable from
  this environment (curl timeout). Recorded in `TODO.md` instead of
  claiming live verification.

Notes:

- Dependencies added: `zod-to-json-schema` (REST, runtime). Dependencies
  removed: none (spike dependency `fastify-type-provider-zod` was
  installed for evaluation and uninstalled again). No versions of the
  pinned MCP SDK generation changed.
- Wire-format behavior of both services is intentionally unchanged;
  the only public-visible additions are `/healthz.build_sha` on MCP,
  the startup observability log line, and `tools.listChanged=false`.

## 2026-08-25 10:38 CEST — ox-alpha

- Commit: 0f804d7 (deployed); docs commit follows this entry
- Scope: production deployment of 94aff57 + 0f804d7 to production-host and live
  verification of REST + MCP.

What:

  - Fixed a deploy-blocking edge before rollout: Compose always passes
    `MCP_RELEASE_ID` through, so an unset value arrives as empty string
    and would fail release-id validation at startup. Empty string now
    falls back to the package version (`0f804d7`).
  - Deployed to `production-host` (host `webserver`) where the workspace is
    mirrored without git: rsynced the tree with `--delete`
    (excluding `.git/`, `node_modules/`, `dist/`, `reference/`, `.env`)
    so the four deleted AI history files disappeared server-side too;
    dry-run itemized before applying.
  - Built both images on the server with `MCP_BUILD_SHA=0f804d7` and
    recreated the stack via `docker compose up -d`; restful-api became
    healthy first, then mcp-v2.
  - Made build identity sticky: added `MCP_BUILD_SHA=0f804d7` next to the
    existing `MCP_RELEASE_ID=2.0.0-v9` in `PostgresDB/.env` so future
    plain `docker compose up -d` keeps exposing it.

Why:

  - Apply the simplification/observability round to production; prove
    raw deployed MCP discovery correctness (previous round's P1) instead
    of leaving it open.

Verification:

  - MCP startup log on the server: service Meshat.se MCP-V2,
    version 2.0.0, release_id 2.0.0-v9, build_sha 0f804d7,
    protocol_generation 2026-07-28, tool_count 23,
    tool_schema_sha256 37cf376304352dd4dadce2e393b1f5eff97821b2692249d31
    99920db76d1f179 — byte-identical to the local build's fingerprint.
  - `MCP_LIVE_BASE_URL=https://mcp.meshat.se npm run test:live` from this
    machine: LIVE SMOKE PASSED — initialize pinned to 2026-07-28,
    listChanged false, 23 tools, critical schemas current,
    search_messages 3 items, list_regions(observed_only) 5 items,
    get_meshcore_stats ok. The earlier discovery drift is therefore
    attributed: the deployment had been serving an older image; raw
    discovery against the updated deployment is correct, so any residual
    connector staleness is external client cache. TODO P1 items removed.
  - `API_BASE_URL=https://api.meshat.se node tests/live-endpoints.mjs`:
    all domain routes 200, invalid query 400, forbidden browser routes
    (/api/v1, /tables, /query, /schema, /scopes) 404.

Notes:

  - production-host resolves to public A/AAAA records only; IPv6 has no route
    from this network and NAT hairpin blocked IPv4 while a related host
    was down — connection succeeded once the server was up again.
  - No git push or image push anywhere; transfer was rsync over SSH per
    existing deployment practice.

## 2026-08-25 11:06 CEST — ox-alpha

- Commit: docs-only commit after this entry (no code changed)
- Scope: adversarial live test of the deployed REST API
  (https://api.meshat.se) looking for errors; no source changes.

What:

  - Probed ~45 live requests: base/health endpoints, node cursor
    continuation, filter validation, error paths (garbage/mismatched
    cursors, bad keys/dates/radius/limit, path traversal, .git,
    forbidden routes), packet->observations and message->packet chains,
    traces/hops, observer sub-resources, region id lookups incl. the
    `*` region, IATA primary/secondary consistency (53 codes),
    activity window/interval validation, docs index/search/get,
    OpenAPI/Swagger sanity, rate-limit headers.

Findings (recorded in TODO):

  - `/v1/docs/.git/*` returns 403 with an empty body -> violates the
    machine-readable error contract (P3).
  - `/v1/meshcore/regions` mixes configured aliases (zero-node
    municipalities, raw scopes like `F`, `dk29`) with observed regions;
    no way to separate them while stats reports observed=27 (P3).
  - Non-issues confirmed live: cursor-filter binding rejects mismatched
    reuse with 422; keyset order is gapless; role is a documented free
    string so unknown roles yield empty results by contract; region
    detail requires the `region` id (`se`), not display name
    ("Sverige") — links already point at ids.

Verification:

  - All checks executed against production over TLS with curl/python;
    no test doubles. No code was modified, so no build/test rerun was
    needed.

## 2026-08-25 11:45 CEST — ox-alpha

- Commit: docs-only commit after this entry (no source changes)
- Scope: remediation attempt for the two P3 findings from the previous
  live test; both resolved as non-app issues after deeper verification.

What:

  - Item "docs .git empty 403": reproduced against the running REST
    container directly on the server (`docker exec` + fetch):
    `/v1/docs/.git/config` returns contract-compliant JSON
    `400 INVALID_ARGUMENT` with request_id. Traced the public empty-body
    403 to the host Traefik stack's CrowdSec bouncer plugin
    (Dynamic/crowdsec.yml, `remediationStatusCode: 403`, appsec enabled)
    which blocks `.git` probing before it reaches the app. Host proxy
    config is outside workspace write scope; TODO now records the
    decision item instead of an app fix.
  - Item "regions mixing configured/observed": verified in production
    that the documented separation already exists and works:
    `observed_only=true` returned 32 regions with zero zero-node rows,
    params are declared in OpenAPI, and simultaneous calls show
    `stats.regions.observed == observed_only count` (40 == 40, twice).
    The earlier 27-vs-32 mismatch was time skew between measurements,
    not a consistency bug. TODO item removed.

Why:

  - Close out the live-test findings accurately; avoid shipping
    speculative API surface (e.g. min_node_count) when existing
    documented filters already satisfy the need.

Verification:

  - Container-local request via docker exec on production-host (400 JSON).
  - Two consecutive simultaneous stats+list comparisons (40 == 40).
  - OpenAPI parameter declaration check against live /openapi.json.
  - No code changed; no rebuild required.

## 2026-08-25 12:45 CEST — ox-alpha

- Commits: meshat-apis 493ce6d (REST+MCP Bun migration) + docs commit after
  this entry; meshcore-mqtt-broker (separate repo) 55745c9 (portable packet
  codec + backfill) and 7f2add9 (Bun runtime/toolchain).
- Scope: full Node.js+npm → Bun migration for restful-api, mcp-server-v2 and
  the broker, including staged production rollout with persistence-format
  migration. Runtime/toolchain only: Fastify, official MCP SDK, pg, Aedes,
  ws, mqtt, Zod, ESLint, Prettier and tsc --noEmit all kept.

What:

  - Pinned bun@1.4.0 everywhere (packageManager, Dockerfile digests,
    docs). bun.lock is the only lockfile in all three projects;
    package-lock.json deleted; frozen installs verified per project.
  - Tests migrated to bun:test with parity: REST 91, MCP 22 (manifest
    determinism suite byte-identical), broker 239 including the real
    PostgreSQL suite. ESLint RuleTester suites re-bound to bun:test and
    still catch every SQL-safety case. Broker tests now execute TS
    sources directly (../dist/* imports removed); jest/ts-node/tsx/
    @typescript/native/.node-version/jest.config/check-lockfile script
    removed; @types/node dropped in all three after proving bun-types
    covers node:* typing without regressions.
  - Broker persistence: V8 serialization replaced by a portable
    versioned codec — ASCII magic `MESHMQTT1` + @msgpack/msgpack body
    behind encodeStoredPacket/decodeStoredPacket; function-valued
    properties still stripped before persisting; binary fields
    normalized to Buffer. Frozen Node-V8 fixtures prove retired rows
    are rejected loudly (never guessed). scripts/migrate-stored-packets
    .mjs migrates retained_packets/mqtt_outgoing/mqtt_incoming/
    mqtt_wills idempotently in bounded transactional batches.
  - Production rollout on production-host exactly staged: REST+MCP rebuilt as
    pinned oven/bun images (alpine) and recreated; broker first got the
    Node transition release (built locally as
    meshcore-mqtt-broker:transition-node since the pulled bjorkan image
    cannot receive our commits without pushing), then backfill ran
    against the live DB, then the Bun image (oven/bun:1.4.0-slim,
    digest-pinned, UID/GID 1000 bun user preserved setpriv drop).

Verification:

  - Baselines before any change: npm run check green ×3; broker
    npm test 25 suites/229 tests against isolated PostgreSQL.
  - After migration: clean-install bun checks green ×3; broker PG suite
    239/239 under Bun; local boot smoke for broker incl. graceful
    SIGTERM → "broker stopped" → exit 0; CLI help works via Bun.
  - Backfill report (production): retained_packets legacy_before=16
    migrated=16 failed=0 legacy_after=0; other tables 0 rows/0 legacy;
    second run idempotent (all zeros); restart recovery proven under
    Node transition release AND again under the Bun release; DB check
    shows 16/16 retained rows carrying the MESHMQTT1 prefix.
  - Production health: broker container healthy with compose healthcheck
    fixed to setpriv --reuid=bun + bun src/healthcheck.ts (loopback MQTT
    publish/subscribe + PostgreSQL query pass per probe); heartbeats
    flow every 30s; external subscribers (corescope, beacon) connected;
    real observer traffic exercised auth/IATA policy (XYZ correctly
    denied); zero Critical/ERROR lines post-switch. REST readyz ready
    with unchanged schema fingerprint; MCP startup logs runtime=bun,
    bun_version=1.4.0 and tool_schema_sha256 identical to the Node build
    (37cf376304352dd4…), tool_count 23.
  - Live smokes from this machine after deploy:
    API_BASE_URL=https://api.meshat.se bun tests/live-endpoints.mjs all
    green; MCP_LIVE_BASE_URL=https://mcp.meshat.se bun run test:live →
    LIVE SMOKE PASSED.
  - Graceful shutdown verified in production containers: MCP SIGTERM →
    "Shutting down" → stop 899 ms; REST stop 943 ms; both restarted
    healthy. bun pm untrusted reports 0 untrusted scripts in all three
    projects, so no trustedDependencies were needed; allowScripts
    removed with the npm-only lockfile portability checker.

Performance notes (not optimized, just measured):

  - Images: broker 387 MB → 286 MB (Bun/slim), REST 277 MB → 202 MB,
    MCP 268 MB → 173 MB. Idle RSS in production: broker ~151 MiB,
    REST ~71 MiB, MCP ~61 MiB. No functional latency regressions
    observed in live smokes; no microbenchmarks taken.

Why pg/Fastify/Aedes/ws stayed:

  - Task boundary: runtime/toolchain round only; pg→Bun.SQL and
    Fastify→Bun.serve are separate unapproved decisions (TODO keeps the
    pg→Bun.SQL evaluation note). No monkeypatches or shims were added
    anywhere; the single compatibility friction found was bun-types not
    typing expect() as thenable, resolved by using Bun's public test
    API instead of suppressions.

Rollback posture:

  - REST/MCP: previous image tags remain on the server. Broker rollback
    target is the transition-node image (reads MESHMQTT1 format);
    rolling back to the pre-migration pure-V8 image would be unsafe by
    design now that persisted rows are portable-format. Documented in
    broker MIGRATION.md.

Notes:

  - Server-side compose edits required for deploy (outside workspace
    files but inside the deployment task): broker service image line
    switched from pulled bjorkan digest to locally built tags, and its
    inline healthcheck updated to bun/src paths. Backup kept at
    ~/PostgresDB/compose.yaml.bak-pre-bun.

## 2026-08-25 15:52 CEST — ox-alpha

- Commits: meshat-apis f22f76c (PostgreSQL integration suite on canonical
  broker schema) + b7284b4 (REST pg→Bun.SQL migration, custom SQL layer
  removal, hygiene); meshcore-mqtt-broker 8649145 (test-db lifecycle
  scripts + @types/pg to devDependencies). Docs commit after this entry.
- Scope: "Bun Phase 2" — real PostgreSQL integration tests first, then
  REST pg→Bun.SQL. Broker stays on pg by decision; MCP architecture
  untouched.

Integration suite (built BEFORE any driver change):

  - restful-api/scripts/test-integration.mjs orchestrates: sibling broker
    repo resolution (MESHCORE_BROKER_REPO override, clear error when
    absent), disposable PostgreSQL via the broker's compose.test.yaml,
    canonical schema provisioning through the broker's own
    openTestDatabase (stored fingerprint included), production-like
    read-only meshcore_http grants, deterministic fixture loaded through
    the broker's MqttHistoryService ingest pipeline, bun test run, and
    always-down cleanup.
  - Broker repo gained scripts/test-db-up.mjs / test-db-down.mjs so its
    compose.test.yaml database can serve consumers other than Jest.
  - Suite proven green against the EXISTING pg implementation first
    (24/24), then kept green through the Bun.SQL migration (26/26 with
    the added startup-parameter assertions).

Bun.SQL migration:

  - Explicit `new SQL({...})` instance from a small src/database.ts
    factory (never the ambient default): hostname/port/database/username/
    password/max/tls plus connection startup parameters
    statement_timeout and application_name — verified live via SHOW on
    both (§15). Pool ownership stays with Fastify onClose via
    db.close({timeout}).
  - All runtime values flow through tagged-template binding; conditional
    fragments follow the documented pattern at a single nesting level
    (parameter-bearing fragments composed deeper than one level proved
    unreliable in Bun 1.4.0 — WHERE-anchored flat slots used instead);
    sort columns are static per-endpoint maps; direction is ASC/DESC
    static fragments; sql.reserve() owns the search_path-pinned
    fingerprint computation with try/finally release.
  - Removed entirely: src/sql.ts (SqlParam/SqlFragment/placeholder/
    joinSql/sqlDirection), eslint-rules/no-unsafe-sql-interpolation and
    no-sql-brand-casts plus their RuleTester suites, @typescript-eslint/
    rule-tester, @typescript-eslint/utils, pg and @types/pg. A standard
    no-restricted-syntax rule now blocks .unsafe() in production source.
  - RecordingPool SQL-string tests deleted; every invariant they pinned
    is now asserted semantically against real PostgreSQL (region
    membership, evidence windows, cursor binding over HTTP, injection-
    as-data, PostGIS radius, bytea raw hex, bigint strings).

Verification:

  - Baselines before work: REST 91/91, MCP 22/22, broker check + 239/239
    against isolated PostgreSQL. After: REST check 74 unit/system +
    test:integration 26/26 (check:full green), MCP 22/22 unchanged,
    broker 239/239 unchanged. Clean frozen installs verified for all
    three; bun pm untrusted reports zero scripts everywhere;
    @types/bun pinned to exactly 1.4.0 in all three projects.
  - Driver semantics parity confirmed by integration probes: int8 as
    string, integer/float8 as numbers, boolean/text/text[] native, NULL,
    bytea as Buffer feeding identical public hex, PostGIS ST_X/ST_Y
    numbers. No bigint:true option was enabled, preserving the pg-era
    string API.
  - Production deploy of REST on production-host: image rebuilt (201 MB), container
    healthy, /readyz reports ready with database actually exercised
    (fingerprint recomputation runs through Bun.SQL reserved connection),
    stored schema hash unchanged (7fb7ea2f…). Live smokes:
    API_BASE_URL=https://api.meshat.se bun tests/live-endpoints.mjs all
    green; MCP_LIVE_BASE_URL=https://mcp.meshat.se bun run test:live →
    LIVE SMOKE PASSED (23 tools, protocol 2026-07-28, wire contract
    unchanged). Ten minutes of production logs contain zero
    PostgresError/statement-timeout/prepared-statement issues; spot
    checks across nodes/observers/regions/iata/packets/messages/traces/
    stats/activity all 200.
  - Performance (production, median of 5–7 in-container requests):
    /healthz 1 ms, nodes?limit=25 8 ms, stats ~330–345 ms,
    messages?limit=50 ~1.5 s, activity 0.8–1.7 s; RSS ~76 MiB; image
    202 MB → 201 MB. messages/activity are dominated by heavy aggregate
    queries on production data; no controlled pre-migration comparison
    exists for them, so treat as watch-items (TODO updated) rather than
    regressions.

Why pg/Fastify/Aedes/ws stayed where they did:

  - Broker pg migration is explicitly out of scope this round (just
    production-migrated persistence; 239-test suite guards it); TODO now
    carries "evaluate broker pg → Bun.SQL after REST's Bun.SQL has been
    stable in production". MCP keeps Fastify + official SDK adapters
    (@modelcontextprotocol/node is an SDK adapter name, not a Node
    runtime dependency).

Notes:

  - AGENTS.md no longer references the nonexistent reference/ copy; the
    sibling ../meshcore-mqtt-broker is documented as schema authority
    with MESHCORE_BROKER_REPO override.
  - Stale local dist/ trees removed (gitignored); no build pipeline was
    reintroduced. NODE_ENV=production retained in Dockerfiles per npm
    ecosystem convention.

## 2026-08-25 21:43 CEST — ox-alpha

- Commits: meshat-apis 7fa54d0 (Zod single-source contract migration) +
  f94bd79 (docs/TODO). Broker untouched this round. Deployed to production-host.
- Scope: "Bun Phase 3" — REST public contracts as ONE Zod source of truth
  via the official Fastify Zod type provider. No DB-semantics, wire-format
  or MCP-contract changes.

Versions:

  - fastify 5.2.1 → 5.12.1 (parity with MCP)
  - zod ^3.24.1 → 4.2.0
  - @fastify/swagger ^9.5.0 → 9.5.2
  - @fastify/type-provider-zod 1.0.0 added (official provider)
  - removed: zod-to-json-schema

What:

  - src/contracts.ts: every public response contract in Zod 4 with stable
    registry IDs (MeshCoreNode, MeshCoreMessage, MeshCoreStats,
    ErrorEnvelope, Pagination, Location, TelemetryValue,
    LogicalMessageMatched, PacketPathHop, TraceHop, Source,
    MeshCoreOverview, DocFile/DocsList/DocsSearchResponse/DocContent,
    ReadyData/HealthData/RootInfo) plus dataEnvelope/collectionEnvelope
    helpers and shared standardErrorResponses.
  - src/request-schemas.ts: all querystring/param contracts moved out of
    server.ts with descriptions preserved, canonicalizing transforms
    (public key upper, sha256/logical id lower, IATA upper + primary
    resolution, region normalization), strict objects, cross-field
    refinements, bounded limits, activity windows/intervals.
  - server.ts uses validatorCompiler/serializerCompiler/ZodTypeProvider
    and registers Swagger with jsonSchemaTransform +
    jsonSchemaTransformObject; handlers consume typed request.query/
    params directly (parse() removed); ajv customOptions block removed;
    file shrank 1968 → ~1148 lines.
  - Repository interface fully typed from derived contract types
    (PublicNode/PublicMessage/...): Page<unknown> and unknown returns
    eliminated from the public surface; mappers annotated and given
    deterministic string coercions at the raw boundary.
  - Request error contract preserved via the official
    hasZodFastifySchemaValidationErrors helper: structural violations 400
    INVALID_ARGUMENT, cross-field refinements and unconfigured-IATA
    transforms 422 INVALID_ARGUMENT; cursor binding stays
    422 INVALID_CURSOR; unknown params stay 400 strict.
  - Response failures surface as generic INTERNAL_ERROR envelopes while
    root causes log internally (verified by sabotage test).

Cross-check catch worth recording:

  - MCP output schemas flagged message.channel as string|null during live
    smoke (production channel values are hash strings). The new REST
    serializer rejected the old silently-coerced numeric passthrough —
    fixed REST contract+mapper to string|null per downstream authority;
    MCP was not touched.

Tests:

  - Baselines before work: REST check green (48 unit/system + 26
    integration), MCP 22, broker check + 239.
  - New tests: tests/contracts.test.ts (node whitelist-strip /
    missing-required / nullable semantics, message matched + logical id
    pattern + nullables, telemetry variants, trace hop ambiguity,
    ErrorEnvelope request_id, Pagination nullability), tests/security.test.ts
    (field-leakage regression proving internal repository fields never
    reach the wire; response-contract failure returning generic envelope
    without Zod internals), ref-aware OpenAPI invariant assertions in
    system.test.ts (3.1.0, reusable components incl. ReadyData required
    fields, error responses reference ErrorEnvelope).
  - After: REST bun run check 62 pass + test:integration 26 pass;
    check:full green from clean install path. MCP bun run check green
    (22 tests), manifest suite green, exactly 23 tools, fingerprint
    unchanged (37cf3763…). Broker unchanged; earlier same-session run:
    check green, 239/239.

Deployment:

  - REST rebuilt and deployed on production-host twice during verification (the
    second deploy fixed message.channel to the downstream string|null
    contract after the MCP live smoke caught it). Final state: container
    healthy, API_BASE_URL=https://api.meshat.se bun tests/live-endpoints.mjs
    green, MCP_LIVE_BASE_URL=https://mcp.meshat.se bun run test:live →
    LIVE SMOKE PASSED, zero serialization/Zod/INTERNAL_ERROR lines in
    production logs, live OpenAPI serves openapi 3.1.0 with 68 reusable
    components including MeshCoreNode/MeshCoreMessage/MeshCoreStats/
    ErrorEnvelope/Pagination.

Performance:

  - In-container medians against the integration fixture: nodes?limit=50
    ~1 ms, messages?limit=50 ~1 ms, stats ~1 ms, activity <1 ms — Zod
    serialization adds no gross overhead at these sizes. Production heavy
    endpoints remain query-dominated (unchanged TODO watch-items).


## 2026-08-26 23:33 CEST — glm-5.3-flash (opencode)

- Commits: meshcore-mqtt-broker unchanged this round (no push required);
  meshat-apis local commit immediately after this entry (never pushed).
- Scope: Bun Phase 5 — performance verification, production index-drift
  closure and operational cleanup. Recovery/API/MCP contracts untouched.

What:

- REST schema gate fix: `ACCEPTED_SCHEMA_VERSIONS` extended to
  `[9, 10, 11]` and `EXPECTED_SCHEMA_VERSION` raised to 11 in
  `restful-api/src/repository.ts`. The integration suite's canonical-
  provisioning fixture became v11 with the broker recovery round, so
  `repository.health()` rejected it (`SCHEMA_MISMATCH`) and
  `bun run test:integration` failed 1/29. Fingerprint-v2 semantics are
  version-generic already; only the gate list was stale.
- Performance harness hardening in `restful-api/scripts/performance.ts`
  (dev tooling only): strict `PERF_SCALE_*` validation (integer,
  finite, >0, per-var bounded maximum; exit 2 otherwise), readable
  plan-chain output per query in the summary, dataset/versions banner,
  a fixed undefined-plan crash in the after-phase summary, and a new
  statelessness-proof telemetry cursor walk driven through the real
  `PostgresMeshcoreRepository.listTelemetry()` keyset: bounded window,
  both directions, duplicate/gap/ordering assertions, termination
  guarantees. Existing narrow-first message SQL and all query
  semantics left untouched.
- Production index-drift closure (READ-ONLY inspection then operator
  DDL exactly matching the canonical source at
  `meshcore-mqtt-broker/src/database.ts:534-536`, no tooling added):
  production was missing all three v10+ performance indexes
  (`public_telemetry_received`, `public_messages_received`,
  `public_observers_last_seen`) while holding older differently-named
  indexes. Created each via `CREATE INDEX CONCURRENTLY IF NOT EXISTS`
  on production-host as psql superuser against the meshdb container.

Why:

- The REST repo must accept the now-canonical v11 fixtures/production;
  check:full was red without it.
- §18 of the round plan: canonical-performance-index vs production
  mismatch is index drift, not semantic drift — schema stays 11,
  fingerprint-v2 excludes ordinary indexes so no bump/reset applied.

Verification:

- Baselines: broker `bun run check` green + `bun run test` 257/257
  against disposable PostgreSQL; MCP `bun run check` 22/22; REST
  `bun run check` 62 pass + `test:integration` 29/29 after the v11
  gate fix (was 28 pass / 1 fail); `check:full` green end-to-end.
- Harness default scale (Bun 1.4.0, PostgreSQL 17.10 test image;
  obs=100k, logical_messages=20k→60k rows, telemetry=100k,
  observers=120; 7 measured EXPLAIN runs, median): telemetry keyset
  desc 15 ms → 0 ms after indexes (`Limit -> Index Only Scan` on
  public_telemetry_received), stats ~103–134 ms, activity ~155–167 ms,
  messages-narrow 233–249 ms vs wide count-baseline 72–85 ms (shapes
  not equivalent: narrow returns 50 full page rows through the
  matched/canonical/representative pipeline; wide is an aggregate-only
  cheaper baseline). Larger scale ×2 (obs=200k, msgs=40k, telem=200k,
  observers=240): telemetry keyset still 0 ms, stats 235 ms,
  activity 272 ms, narrow ~505 ms, wide 163 ms. Telemetry cursor walk:
  desc 8 pages 800/800 rows, asc 8 pages 800/800 rows — no gaps, no
  duplicates, both directions terminate. Index sizes at that scale:
  telemetry 6176 kB, messages 3712 kB, observers 48 kB.
- Production inventory before fix: 62 pg_indexes rows in
  meshcore_public; the three canonical timeline indexes absent. After
  `CREATE INDEX CONCURRENTLY`: all three present, indisvalid=t,
  indisready=t; sizes 368 kB (messages), 40 kB (observers),
  8192 bytes (telemetry).
- `/status` before index work: {"status":"ok",
  "database":{"schema_version":11,
  "created_at":"2026-08-26T19:26:01.615Z","age":"2 hours 4 minutes",
  "resets_total":0}}. After: identical created_at, schema_version 11,
  resets_total 0 — timestamp unchanged by index-only work.
- Production latency (in-container, 2 warmup + 7 measured medians,
  post-fix): stats 48 ms, messages?limit=50 156 ms, activity
  window=24h&interval=1h 208 ms, telemetry?limit=50 1 ms,
  observers?limit=50 4 ms — down from 2026-08-25 medians of ~340 ms /
  ~1.5 s / 0.8–1.7 s. Public-side medians from client machine:
  67 / 170 / 228 / 22 / 26 ms.
- Live semantics spot-check: messages expose lp_ logical ids,
  representative_packet_sha256, canonical multi-IATA +
  observation_count, matched subset with counts, first/last_received_at
  and opaque cursor; readyz 200.
- Live smokes: API_BASE_URL=https://api.meshat.se bun
  tests/live-endpoints.mjs → exit 0; MCP_LIVE_BASE_URL=
  https://mcp.meshat.se bun run test:live → LIVE SMOKE PASSED.
- Broker live: 4027 publish/authorization log lines within 5 minutes;
  internal heartbeats flowing; container healthy.

TODO changes:

- Removed stale "[P2] global telemetry lacks leading timeline index"
  TODO — canonical provisioning carries it, fixture plan verified,
  cursor tests green, production index valid.
- Replaced vague stats/messages/activity TODO with concrete post-fix
  medians and the real remaining hotspot (activity's distinct
  logical-message aggregation over packet_observations).
- Kept WAF decision item and broker pg→Bun.SQL evaluation item.

Notes:

- No new indexes beyond the three canonical ones; no preaggregation,
  cache layer, materialized view, ORM or monkeypatch introduced; stats
  remain exact counts; broker recovery/state machine untouched; broker
  still uses pg; MCP source unchanged (22 tests / 23 tools).
