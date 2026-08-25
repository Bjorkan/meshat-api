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
