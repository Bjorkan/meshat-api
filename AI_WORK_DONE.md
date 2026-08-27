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

## 2026-08-27 00:55 CEST — glm-5.3-flash (opencode)

- Commits: meshcore-mqtt-broker f0e636a pushed to origin/main (fast-forward);
  meshat-apis local commit immediately after this entry (never pushed).
- Scope: Bun Phase 6 — broker driver migration pg → Bun.SQL under the
  existing ApplicationDatabase/ApplicationTransaction boundary. No SQL
  rewrite, no schema change (still v11), no recovery-policy change.

Delivery reconciliation first:

  - origin/main had moved to be50cd0 (three stale npm-era Renovate bumps:
    globals@17.10.0, typescript-eslint@8.67.0 and a tsx bump). Rebased the
    six local commits onto it; conflicts resolved by keeping the Bun tree
    (no package-lock.json, no tsx) while absorbing the two still-relevant
    devDependency pins. bun.lock sync commit 215e0ea pushed as catch-up.
  - pg-backed baseline: broker check green + 257/257; representative
    ApplicationDatabase bench loop median 25 ms (20×4 kB bytea inserts +
    tx + page read + bytea round-trip + claim-update + delete), database
    open→ready median 34 ms; production image 286 MB, idle RSS ~208 MiB.

Compatibility gate (Bun 1.4.0 / PostgreSQL 17 disposable): ALL GREEN —

  - explicit config beats ambient DATABASE_URL/POSTGRES_URL;
  - connection:{statement_timeout} → SHOW 5s; actual cancel proof on
    pg_sleep(80 ms timeout) ≈ 83 ms; search_path stable across six pooled
    connections; TLS: omit key = plaintext (any tls object requests SSL);
  - smallint/int4 → number, int8 → string parity; bytea Buffer exact
    round-trip incl empty; timestamptz Date with exact epoch ms/ISO;
    boolean/text/null/double parity;
  - plain JS arrays are REJECTED ("malformed array literal") — official
    sql.array(values,"TEXT") works in tagged and unsafe-param positions,
    so the adapter normalizes allowlisted string[]/number[] into safe
    array literals bound as positional parameters ($n::text[] casts stay);
  - sql.begin(): commit + rollback-on-throw proven; reserve() exclusive
    with release-stops-use; advisory lock exclusion across connections;
    SET LOCAL ROLE inside transactions; multi-statement DDL through
    unsafe() with no params;
  - error shapes: PostgresError carries code=ERR_POSTGRES_* plus
    errno=<pgcode> (28P01 auth, 3D000 missing db, 23505 unique,
    ERR_POSTGRES_CONNECTION_REFUSED for network); pool recovers after
    backend termination in ~255 ms; concurrent begin+pooled stress green
    (50 waves × 5 ops, max 4) with pool alive afterwards;
  - documented driver/server nuance: RESET search_path goes to the
    compiled default, NOT the startup GUC — sessions now restore with an
    explicit SET instead.

Migration (commit f0e636a):

  - src/database.ts: Pool/PoolClient/PoolConfig/QueryResult removed in
    favor of Bun.SQL types; DatabaseOptions keeps the broker's own shape
    (host/port/database/user/password/max/connectionTimeoutMillis/
    query_timeout/ssl with connectionString fallback parsing); run():
    Promise<void>, new changes() = RETURNING-row count; transaction()
    via sql.begin(); initialize/reprovision keep manual transactions on
    reserved sessions with SET ROLE adoption when membership allows;
    provisioning creates owner-owned schemas so migration role switches
    remain consistent; openDatabaseWithRecovery classification reads
    errno-first (57014 → migration_timeout etc.) without broad codes.
  - src/schema-migration.ts: reserved lock+work sessions from one max:2
    instance; same advisory lock key, same deadline via set_config,
    CONCURRENTLY builds still outside any transaction, fail-closed v9/v10
    checks preserved; db:migrate CLI updated to databaseConfig option.
  - Affected-row semantics migrated everywhere (23 rowCount sites gone):
    persistence incomingDelPacket/cleanup, mqtt history requeues and
    orphan purges, state-store bans/cleanups/reset, meshcore.io ingress/
    job claim guards, retry/completed/dropped finishers now UPDATE …
    RETURNING 1 counted via changes().
  - scripts/migrate-stored-packets.mjs now runs under bun against Bun.SQL
    and is fail-closed: genuine Node-V8 rows abort that table loudly
    before any write instead of being guessed at (the runtime codec had
    already dropped the transitional reader; the old test only stayed
    green because node spawned a stale dist build). Backfill test now
    codifies refusal + portable-row preservation + idempotent refusal.
  - Dependencies: "pg" and "@types/pg" removed; bun.lock has no
    node-postgres packages; frozen install verified after rm -rf
    node_modules.
  - Docs: AGENTS.md permanent rule replaced (Bun.SQL behind
    ApplicationDatabase…), DATABASE.md driver section added, MIGRATION.md
    backfill command now `bun` + fail-closed note.

Verification:

  - Broker clean install: format/lint/typecheck green; bun test
    257/257 across 28 files against real disposable PostgreSQL — all
    Aedes persistence, bytea restart recovery, MQTT history ingestion,
    state store, region scope, recovery/migration registry and
    concurrency suites included; final grep shows zero first-party
    node-postgres references.
  - After-bench: representative loop median 28 ms (pg 25 ms; +12 %,
    within acceptance, noise-level ms deltas), open→ready 40 ms (pg 34).
  - Production deploy on production-host: rollback target recorded as image
    meshcore-mqtt-broker:v10-bridge (pg-backed); rsync + local build to
    tag bunsql-1; compose switched to the new tag. Container healthy in
    ~12 s. GET /status BEFORE created_at 2026-08-26T19:26:01.615Z ==
    AFTER == unchanged, schema_version 11, resets_total 0 — no
    reprovision triggered by first Bun.SQL start (§54 respected).
  - Live MQTT: 768 publish/auth log lines within two minutes, internal
    birth + heartbeat publishes flowing, IATA policy still enforced.
  - Idle RSS 142.9 MiB (pg baseline ~208 MiB); image 285 MB (286 MB).
  - Production logs since restart: zero PostgresError/statement-timeout/
    reset/fingerprint/unhandled-rejection lines.
  - REST: container-level medians post-deploy stats 64–66 ms,
    messages?limit=50 ~233 ms, activity 24h/1h ~337 ms, telemetry 1 ms,
    observers 3 ms — higher than the Phase-5 snapshots (48/156/208) and
    stable across reruns; attributed to three extra hours of production
    data growth plus cold caches after unrelated restarts, not to this
    driver change (REST owns its own Bun.SQL pool and was not restarted).
    Left as watch-items in TODO. API_BASE_URL=… tests/live-endpoints.mjs
    exit 0.
  - MCP: bun run check 22/22; MCP_LIVE_BASE_URL=… test:live → LIVE SMOKE
    PASSED (23 tools, fingerprint unchanged).

## 2026-08-27 01:35 CEST — glm-5.3-flash (opencode)

- Commits: meshat-api 82c52ef pushed to origin/main; broker c9025b1 pushed
  to origin/main. Two independent repositories, separate histories and CI.
- Scope: Bun Phase 7 — permanent two-repo structure, GitHub migration of
  the API/MCP repository with history preserved, cross-repo compatibility
  CI in both directions, contributor experience. No runtime source
  changes; no production restarts.

Repository migration:

  - meshat-api established as the canonical development repository from
    the existing local repo (remote previously absent): origin is now
    git@github.com:Bjorkan/meshat-api.git, branch main, SSH push only.
    The full existing history was preserved via a one-time pre-publication
    rewrite on the empty remote: host identifiers (auth.se), personal
    home paths (/home/jesper/...) and local usernames were scrubbed from
    every blob and commit message across all commits after an explicit
    requirement that no production host references may exist anywhere.
    Verification: git log --all -p across the rewritten history contains
    zero occurrences; the backup of the original .git was kept outside
    the repository until acceptance. No force push was needed (empty new
    remote); refs/original were cleaned up.
  - Local canonical folder renamed meshat-apis → meshat-api; no symlink
    alias left behind; old name retired.
  - Secret scan: tree clean (only disposable localhost test credentials
    by design, e.g. meshcore_http:integration_http@127.0.0.1 in harnesses)
    plus one historical combined-pattern pass over every commit.

Repo quality added (top-of-history commit 82c52ef):

  - README.md rewritten as the public landing page: two-repository
    architecture diagram (broker separate), service descriptions,
    database-compatibility section naming schema v11/fingerprint-v2 and
    the broker as sole DDL authority, requirements, sibling workspace
    layout, clone commands, fast check commands and the integration path.
  - CONTRIBUTING.md (full guide: ownership boundaries, cross-repo change
    rules + checklist, deploy-order guidance, PR linking pattern) and a
    short CONTRIBUTE.md pointing at it; PR template with contract-impact
    checklist; MIT LICENSE (2026 Bjorkan).
  - AGENTS.md: Related-repositories section (permanent two-repo policy,
    ownership matrix, permanent verification rules for schema-facing
    changes in both directions), sibling-checkout subsection, pg→Bun.SQL
    line replaced with current Bun.SQL reality.
  - .github/workflows/ci.yml: four jobs, all actions SHA-pinned (checkout
    v7.0.1, setup-bun v2.2.0, buildx v4.3.0, build-push v6.9.0) with Bun
    1.4.0: rest (check), mcp (check), rest-integration (checks out
    Bjorkan/meshcore-mqtt-broker@main as sibling at the documented layout,
    reports its resolved SHA into the step summary, installs both trees,
    runs the real PostgreSQL integration suite via MESHCORE_BROKER_REPO),
    and build-only Docker builds for both Dockerfiles (no push).

Broker CI modernization (commit c9025b1):

  - All three workflows moved off Node/npm/jest to Bun 1.4.0:
    postgres-functional now runs bun run check + test:postgres against
    the service PostgreSQL; autofix runs Prettier/ESLint through bun;
    build-image test job drops lockfile-portability/npm-log artifacts and
    path filters updated from package-lock/.node-version/jest.config to
    bun.lock + postgres/** (Buildx/Scout/QEMU/publish protections kept).
  - New api-compatibility job: checks out Bjorkan/meshat-api main as a
    read-only sibling next to THIS broker commit and runs the REST
    PostgreSQL integration suite against it on every PR/push — drift is
    caught on the broker side too, not only on API main.

Verification:

  - Baselines before migration: REST check:full green (62 unit/system +
    29 integration), MCP check green (22 tests), broker check green +
    257/257 tests.
  - Remote Actions: meshat-api CI run 33023471875 = success with all four
    jobs green on the first push (REST check, MCP check, REST integration
    vs broker main, Docker builds). Broker CI run 33023774410 for c9025b1
    = success with api-compatibility + postgres-functional green.
  - Fresh two-repo acceptance in /tmp/opencode/fresh-workspace: cloned
    both repositories from GitHub into sibling layout; fresh REST clone
    passes bun install/check (62) and integration (29/29) against the
    fresh broker clone with MESHCORE_BROKER_REPO pointing there;
    fresh MCP clone passes check (22). check:full re-run also green.
  - Repo independence: rest/mcp `bun run check` needs no broker checkout;
    only the PostgreSQL integration suite uses the sibling broker; no
    submodules, no vendored broker source, no shared workspace, no
    duplicated DDL anywhere in meshat-api.

## 2026-08-27 02:15 CEST — glm-5.3-flash (opencode)

- Commits: meshat-api 997bed8 (docs) + this log-only commit pushed to
  origin/main; broker a17f85c pushed to origin/main.
- Scope: BUN PHASE 7.1 — close remaining repository-policy and
  documentation drift after Phase 7's two-repo/Bun.SQL migration.
  Docs/policy only; no runtime source, schema, recovery, CI or deploy
  changes anywhere.

Policy reconciliation (meshat-api):

  - AGENTS.md "Non-negotiable architecture": removed stale
    "Docker images are built locally / Never push source/images/releases
    remotely"; replaced with the build-only-CI + approved-release-workflow
    rule and a pointer to the new permanent section.
  - AGENTS.md gained permanent "## Repository delivery" (commit → push
    origin/main over SSH remote git@github.com:Bjorkan/meshat-api.git,
    never force-push/rewrite main, no empty commits, broker delivered
    separately) plus explicit independence lines (separate commits/pushes/
    releases, cross-repo source changes only when the contract requires)
    in Related repositories.
  - AGENTS.md SQL policy rewritten from the deleted src/sql.ts brand layer
    (SqlParam/SqlFragment/joinSql/sqlDirection/placeholder + both custom
    ESLint rules + their RuleTester suites) to actual Bun.SQL reality:
    explicit Bun.SQL instance, tagged-template parameterization only,
    .unsafe() forbidden in restful-api/src/**, static allowlists for
    identifiers/sort columns/directions, no arbitrary SQL endpoint,
    real PostgreSQL tests when semantics change. Old two-rule description
    replaced with the five current rules.
  - PROMPT.md §35 corrected because its permanent "Never run: git push"
    actively contradicted the human-approved delivery policy: now commit +
    push origin/main via SSH per AGENTS.md delivery policy, never force-
    push; docker push/gh pr create/gh release still require an explicitly
    approved release workflow.

Docs corrections (meshat-api):

  - restful-api/README.md Development: deleted documentation of the removed
    custom SQL layer/rules; documented Bun.SQL directly (tagged templates,
    parametrized values, static per-endpoint sort allowlists, two static
    direction fragments, .unsafe() prohibited in src/**).
  - restful-api/README.md readiness rewritten from source
    (src/repository.ts): canonical schema version = 11 with fingerprint-v2;
    bridge acceptance of versions 9/10/11 while production migrates, where
    v9 uses the legacy fingerprint format (includes performance indexes)
    and v10/v11 use fingerprint-v2 (excludes them); unsupported versions
    or fingerprint mismatch return 503.
  - CONTRIBUTING.md integration commands fixed: wrong sibling path
    (cd ../meshcore-mqtt-broker from workspace/meshat-api/restful-api)
    replaced by an explicitly ordered command chain verified literally in
    this session, plus the MESHCORE_BROKER_REPO=../../meshcore-mqtt-broker
    override (validated against path.resolve() usage in the harness).
  - mcp-server-v2/tests/live-manifest.mjs usage comment: npm run test:live
    → bun run test:live (comment only).
  - Root README architecture diagram duplicate "(separate repository)"
    line removed.
  - opencode.json permissions allowlist extended with exactly
    "bun run test:integration" and "bun run check:full" (config is an
    exact-command allowlist; JSON re-validated).

Broker:

  - AGENTS.md gained compact permanent "## Repository delivery" section:
    independent repository (not part of/submodule/package dependency of
    meshat-api), run full Bun/PostgreSQL checks → commit → push
    origin/main over SSH, never force-push, no empty commits, verify
    meshat-api compatibility when schema/public-contract behavior changes.
    No runtime/recovery/schema behavior touched.

Verification (all executed this session):

  - Baselines on 619390d/c9025b1: REST bun install --frozen-lockfile +
    check green (62 pass, 30 skip, 0 fail); MCP check green (22 pass);
    broker check green + full bun test green (257 pass) against live test
    PostgreSQL via broker compose.test.yaml.
  - Literal contributor-doc verification: sibling layout, broker bun
    install, REST install, then REST bun run check:full green end-to-end
    (92 unit/system + 29 integration tests; disposable PostgreSQL spun up
    through the sibling broker tooling; first attempt hit a one-off port
    55432 race against my own leftover broker test container — retried
    clean after removing it).
  - Post-edit checks: REST format + check green (62/0); MCP format +
    check green (22/0); broker format/lint/typecheck green (docs only).
    opencode.json parses as valid JSON.
  - Stale-term scan across current operational docs/source (excluding
    AI_WORK_DONE/git history): zero matches for npm workflows (outside
    explicit prohibitions), src/sql.ts, SqlParam, SqlFragment, custom rule
    names, "Never push source", "Docker images are built locally",
    or outdated schema-version claims. PROMPT.md was edited before the
    scan and no longer contains the contradiction.
  - TODO.md left unchanged (both open items still valid); AI_WORK_DONE
    history untouched apart from this append-only entry.

## 2026-08-27 10:45 CEST — z-ai/glm-5.3-flash

- Commit: meshat-api 4c9e529 (fix(rest): repair message cursor pagination).
  Broker untouched this round. Deployed REST-only to production-host.

Scope: "Bun Phase 7.2" — fix live message cursor pagination (page 2 returned
INTERNAL_ERROR via MCP search_messages cursor continuation; observed request
IDs req-15j / req-15o, reproduced pre-deploy with live request id
50be7bbe-b44e-4d4c-bdac-4cf56e0c5ed1).

Root cause:

  - restful-api/src/repository.ts listMessages built the keyset cursor
    predicate from sql`page.last_received_at_ms` / sql`page.logical_id`, but
    the predicate executes inside page_keys whose scope is
    summary/representative_key/matched_summary — no `page` alias exists.
    PostgreSQL: SQLSTATE 42P01 `missing FROM-clause entry for table "page"`,
    normalized by REST error mapping to INTERNAL_ERROR.
  - Page 1 worked because applyCursor returns null when no cursor is passed;
    any continuation page referenced the invalid alias and failed.
  - The final outer join also had no deterministic ORDER BY; required because
    the next cursor key derives from the last visible row.

Fix (minimal, per hotfix round):

  - Cursor predicate now references summary.last_received_at_ms /
    summary.logical_id (the aliases actually in scope at that point).
  - Added explicit final ORDER BY page_keys.last_received_at_ms ${dir},
    page_keys.logical_id ${dir} after the representative-message join,
    identical to the page_keys keyset ordering.
  - No cursor format change (v1 encoding/base64url/fingerprint/key tuple/
    logical-id normalization unchanged; previously issued message cursors
    work), no message semantics change (canonical lp_ id, first/last
    received_at, total observation_count, canonical IATA, matched subset,
    globally latest representative all unchanged), no sort-contract change,
    no error-mapping suppression, narrow-first architecture retained, no new
    indexes, no cache/preaggregation, Bun.SQL retained, schema untouched.

Test gap closed (the gap is why CI missed it):

  - New PostgreSQL integration fixture in
    tests/integration/repository.integration.test.ts adds four deterministic
    logical messages with realistic 13-digit epoch timestamps so multi-page
    walks never depend on accidental base-fixture counts.
  - New integration tests: repository desc cursor walk (no duplicates/gaps,
    strict tuple order, exact global-order equality incl. page-1 slice vs
    unpaginated listing — catches missing final ORDER BY), asc walk,
    iata-filtered walk, HTTP page-2 flow (200 + disjoint ids + boundary
    tuple ordering), HTTP walk-to-end ending on null next_cursor with guard,
    filtered HTTP pagination with matched-vs-canonical totals, message
    cursor/filter mismatch → 422 INVALID_CURSOR. Pre-fix reproduction run
    executed first: exactly the (Q) cursor tests failed with
    `missing FROM-clause entry for table "page"` errno 42P01 while all other
    tests passed (30 pass / 6 fail); post-fix 36/36 green.

Live smoke hardening:

  - tests/live-endpoints.mjs now follows messages next_cursor to a second
    page (skips naturally when production has no further page) and asserts
    no duplicate ids between pages.
  - mcp-server-v2/tests/live-manifest.mjs now follows search_messages
    next_cursor through the stateless MCP pass-through (the exact production
    failure path) asserting !isError, structured content and no duplicate
    ids; MCP runtime source untouched (still 23 tools, same fingerprint).

Verification:

  - REST: bun install --frozen-lockfile ok; format:check, lint, typecheck,
    bun test 62 pass / 0 fail (38 skip = DB-backed), test:integration
    36 pass / 0 fail, check green, check:full green.
  - MCP: format:check, lint, typecheck, bun test 22 pass / 0 fail, check
    green.
  - CI run 33055041650: REST check ✓, Docker build (no push) ✓,
    REST integration vs broker main ✓, MCP check ✓.
  - Push b456d05..4c9e529 via git@github.com:Bjorkan/meshat-api.git; origin/main
    at 4c9e5290e756c99e586014b8599eb46e34c892d5.

Production deploy (REST only):

  - Rollback target recorded: running image meshat-apis-restful-api
    sha256:2523cf894f048092ef051a5120144d586eac5e5672f01d6fdfb174ed0ab26a57
    (built 2026-08-26); rollback = recreate container from previous image tag.
  - Pre-deploy live repro confirmed old failure: messages?limit=2&order=desc
    then cursor → INTERNAL_ERROR (request_id above).
  - Established procedure followed: rsync mirror to
    production-host:/home/jesper/PostgresDB/meshat-apis (--delete excluding
    .git/, node_modules/, dist/, reference/, .env; dry-run itemized first),
    docker compose build restful-api, docker compose up -d --no-deps
    restful-api. MCP runtime NOT redeployed (only its test manifest changed);
    broker NOT touched; no DB operation anywhere.
  - Post-deploy: /readyz 200 {status ready, database ready, docs fresh,
    schema_version 11}. Desc page1→page2 200 with distinct ids and strictly
    descending last_received_at across the boundary (no duplicates, no gaps);
    asc page1→page2 200 correct ascending order; filtered iata=GOT page1→
    page2 200 with consistent matched IATA subsets; regions?limit=2 cursor
    continuation still 200 (sanity).
  - API_BASE_URL=https://api.meshat.se bun tests/live-endpoints.mjs:
    all green including the new second-page smoke.
  - MCP_LIVE_BASE_URL=https://mcp.meshat.se bun run test:live:
    LIVE SMOKE PASSED — initialize pinned 2026-07-28, 23 tools,
    search_messages 3 items, search_messages page 2 ok: 3 items (stateless
    cursor pass-through), list_regions/get_meshcore_stats ok.
  - Production logs since restart: zero INTERNAL_ERROR/42P01/missing
    FROM-clause/pagination errors in the verification window.

## 2026-08-27 11:19 CEST — z-ai/glm-5.3-flash

- Commit: meshat-api 892f1a7 (fix(rest): escape literal LIKE search characters).
  Broker untouched this round. Deployed REST-only to production-host.

Scope: "Bun Phase 7.3" — fix literal text search escaping for node/observer
name search (`applyText`), used by GET /v1/meshcore/nodes?name=...,
GET /v1/meshcore/observers?name=..., and MCP search_nodes / search_observers.

Live reproduction (pre-deploy):

  - MCP/REST search_observers(name="KiekR_hepp") → 0 items while substring
    "KiekR" returned KiekR_hepp; search_nodes(name="Solar_test") → 0 items
    while "Solar" returned SE-HEL-Solar_test among others.
  - Any `_` in the query made matches impossible; % and \ behaved correctly.

Root cause:

  - restful-api/src/repository.ts likePattern duplicated escapeLike's
    replaceAll chain and had a typo: "_" was mapped to "\\%" instead of
    "\\_". A caller-supplied underscore therefore became an escaped literal
    percent sign in the ILIKE pattern (`%Literal\%Test%`), requiring a real
    `%` character that the actual names never contain.
  - Existing "injection-like text remains data" integration test covers SQL
    injection safety (parameterization) but not LIKE-literal semantics, so it
    could not catch this.
  - Correct existing escapeLike helper untouched; region prefix filter
    (escapeLike-based) unaffected and verified unchanged.

Fix:

  - likePattern(value) = `%${escapeLike(value)}%` — single canonical LIKE-
    escaping implementation for \, % and _; no new dependency, no regex,
    no .unsafe(), values remain Bun.SQL bound parameters, ESCAPE '\' and
    case-insensitive substring semantics retained.

Tests (tests/integration/repository.integration.test.ts "(R)"):

  - Explicit fixture: nodes Literal_Test_Node / LiteralXTestNode /
    Value%Node / ValueABCNode / Back\Slash / Solar_Test_Fixture and
    observers Literal_Test_Observer / LiteralXTestObserver / Observer%Label.
  - Assertions: underscore literal found via listNodes AND listObservers;
    wildcard control proves '_' does not act as single-char wildcard
    (LiteralXTest finds only the X row; LiteralX_Test finds nothing);
    percent literal exact-match without widening (Value%Node / Value%);
    backslash literal match; broad-substring probes prove both lookalike
    rows exist before narrowing; case-insensitivity (LITERAL_TEST);
    HTTP end-to-end /v1/meshcore/nodes|observers?name=... (query parsing →
    repository → PostgreSQL).
  - Pre-fix run: exactly the three underscore-literal tests failed
    (39 pass / 3 fail); post-fix all green.

Verification:

  - REST: format:check, lint, typecheck green; unit/system 62 pass;
    test:integration 42 pass (36 baseline + 6 new); check and check:full
    green.
  - MCP source untouched: bun run check 22 pass; 23 tools; fingerprint
    unchanged; no tool-schema change required.
  - CI run 33057682769 (REST check ✓, MCP check ✓, rest-integration vs
    broker main ✓, docker build ✓). Push 31c0ad7..892f1a7 over SSH;
    origin/main = 892f1a7fea21fc1da8c2f826c2de995efaeaed24.
  - Production deploy (established procedure): rollback target recorded as
    previous REST image sha256:7e32f051f839… (Phase 7.2 build); rsync mirror
    with dry-run first; docker compose build/up --no-deps restful-api on
    production-host. New image 60c659ded293 healthy; no MCP redeploy, no
    broker restart, no DB operation.
  - Post-deploy live checks: /readyz 200 {ready, schema_version 11};
    nodes?name=Solar_test → ["SE-HEL-Solar_test"]; observers?name=KiekR_hepp
    → ["KiekR_hepp"]; ordinary substrings still work (name=Solar returns the
    full Solar family incl. SE-HEL-Solar_test; name=KiekR returns both
    KiekR_jonher_mobile and KiekR_hepp).
  - Via live MCP tools directly: search_nodes(Solar_test) and
    search_observers(KiekR_hepp) return the same fixed results through
    mcp.meshat.se without any MCP redeploy (pure REST proxying).
  - Phase 7.2 regression sanity: search_messages(limit=2) → next_cursor →
    page 2 ok, isError=false, no duplicate ids; both REST and MCP live
    smokes green.
  - Production logs since restart: zero error/pagination/42P01 lines.

- Post-delivery addendum (2026-08-27 11:35 CEST): docs-only CI run
  33058053133 for commit 926e626 initially failed in "REST integration vs
  broker main" with transient SQLSTATE 57P03 ("the database system is
  starting up") during first pool connection, right after the disposable
  container reported healthy; the identical source run 33057682769 was green
  and a --failed rerun passed unchanged. No source impact. Recorded as a P3
  TODO: add connect-retry/backoff to integration-provision.mjs.

## 2026-08-27 16:40 CEST — z-ai/glm-5.3-flash

- Commit: meshat-api 773eebf (perf(rest): candidate-first logical message
  aggregation). Broker untouched. REST-only deploy to production-host.

Scope: "Bun Phase 8" — production performance re-baseline, message/activity
profiling, evidence-driven optimization. No cache/preaggregation added.

Production re-baseline (apples-to-apples, container loopback, warm medians):
  - messages limit=50: 1390 ms (limit-independent flat curve; 1371–1516),
    external 1458 ms — genuine DB cost, not transport (nodes control 7 ms
    internal vs 102 ms external → transport floor ≈ 0.09–0.10 s).
  - activity 24h/1h: 864–2025 ms bimodal; external 2108 ms.
  - stats: 433 ms; nodes(20) 7 ms.
  - Dataset at profiling time: packet_observations ~172k, packets ~120k,
    messages 97k, packet_path_hops ~709k, nodes 799, observers 116;
    autoanalyze fresh; pg_stat_statements not installed (not added).
  - Historical 156 ms snapshot is not comparable: dataset was ~36 h old
    when Phase 7 measured; volume growth, not a code regression, drove
    latency. Growth is linear in observation volume (old pipeline:
    216 ms @100k obs -> 1071 ms @400k obs locally).

EXPLAIN (ANALYZE, BUFFERS) production findings (read-only, statement_timeout):
  - listMessages unfiltered: 1967 ms; hottest = GroupAggregate with
    array_agg(DISTINCT ...)/count(DISTINCT ...) over ~97k rows (matched
    summary 700–770 ms), then two more big sorts re-reading a 97k-row CTE
    (summary 910–990 ms, DISTINCT ON rep 209–238 ms); LIMIT applied last.
    All buffers shared hit; no temp spills; plans sequential.
  - getActivity 24h/1h: two LEFT JOIN passes + per-bucket count(DISTINCT ...)
    over the window volume; scales with window size (1h/5m ≈ 90 ms).

Root cause: full-population aggregation before LIMIT in listMessages.

Fix (semantics-preserving, verified before implementation):
  - One materialized evidence pass, top-K candidate selection on the same
    canonical (last_received, logical_id) keyset, and matched/canonical/
    representative aggregation restricted to the page candidates.
  - message.received_at_ms == observation.received_at_ms verified: trigger
    DDL (broker src/database.ts) copies the same event value AND production
    mismatch count = 0.
  - Equivalence proof on production snapshots (REPEATABLE READ, EXCEPT ALL
    both directions): unfiltered page1 50/50 identical, iata=GOT identical,
    zero diff rows. Phase 7.2 cursor walks, asc/desc, filtered pagination,
    matched totals, cursor mismatch: integration 42/42 green.

Measured (disposable Postgres, sequential sampling, median of 7):
  1x (100k obs): messages 276->96 ms (-65%), iata=GOT 162->129 ms,
     activity 134->135 ms (unchanged by design).
  4x (400k obs): messages 1151->257 ms (-78%), iata=GOT 782->444 ms (-43%),
     activity 476->491 ms (unchanged).
  Activity base-CTE candidate was REJECTED by evidence: 1360 ms vs 568 ms
  old at 4x; activity left untouched this round.
  Harness extension: messages-narrow-v2 / activity-base SQL labels plus
  sequential repo-level medians (messages unfiltered/GOT, activity).

Verification:
  - REST: format:check, lint, typecheck green; unit 62 pass; integration
    42 pass; check and check:full green; test:performance green incl.
    telemetry cursor pagination verification (asc+desc, no gaps/dups).
  - MCP source untouched: bun run check 22 pass; no tool-schema change.
  - CI run 33081743610: REST check ✓, MCP check ✓, Docker build ✓;
    integration job hit the known transient 57P03 warmup flake once
    (already tracked in TODO) and passed green on --failed rerun.
  - Push 111e12e..773eebf via git@github.com:Bjorkan/meshat-api.git;
    origin/main = 773eebf.

Production deploy (established procedure, REST only):
  - Rollback target recorded: meshat-apis-restful-api image
    sha256:60c659ded29328e898760d8638e2affb77cf74096ce17d5bb4dc75a296343031
    (Phase 7.3 build). rsync mirror with --dry-run itemized first
    (4 files), docker compose build restful-api, docker compose up -d
    --no-deps restful-api. New image 788b5b28a63e9639f2e463cf45e47cef4b3
    6425eba5b48956cd88cd01e5ddf09; broker, MCP, DB untouched; no DDL.
  - Post-deploy: /readyz 200 {ready, schema_version 11, docs fresh,
    schema_hash bdb45ae3... unchanged}; zero error/42P01 lines in logs.
  - Post-deploy internal warm medians: messages limit=50 ~568 ms (-59%),
    limit=200 ~596 ms (-57%), iata=GOT ~882 ms (-21%; residual cost =
    qualifier DISTINCT pass over ~85k GOT observations), activity ~952 ms,
    stats ~457 ms, nodes control ~8.5 ms.
  - Post-deploy external medians: messages limit=50 ~779 ms, limit=200
    ~730 ms, activity ~1061 ms, stats ~521 ms.
  - Live regression sanity after deploy: messages page1->page2 200 with
    strictly descending last_received_at, no duplicates; 4-page desc walk
    20 ids no duplicates; nodes name=Solar_test and observers
    name=KiekR_hepp still resolve (Phase 7.3 intact).
