# Meshat.se API Workspace — OpenCode Instructions

This workspace contains the official public Meshat.se REST API and MCP-V2 server.

## Read first, in this order

Before coding:

1. Read root `AGENTS.md` (this file).
2. Read `TODO.md` — it contains exactly the currently open work.
3. Read the latest relevant entries in `AI_WORK_DONE.md`.
4. Inspect `git status`; do not mix unrelated local changes into your work.
5. Inspect the files relevant to the task.
6. Do not assume a TODO item is still valid if the code already implements it.

Before implementation work on database-backed behavior, inspect relevant
files in `reference/meshcore-mqtt-broker/`.

`PROMPT.md` defines product/architecture requirements.

`API-CONTRACT.md` defines the public URL/resource contract.

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
- root `TODO.md` and root `AI_WORK_DONE.md`

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
- Run focused tests after meaningful changes.
- Run typecheck/lint/build when configured.
- Do not silently redesign public URLs or response semantics.

## Session start

Before coding:

1. Read root `AGENTS.md`.
2. Read `TODO.md`.
3. Read the latest relevant entries in `AI_WORK_DONE.md`.
4. Inspect `git status` and understand any pre-existing local changes before building on them.
5. Inspect the files relevant to the task.
6. Do not assume a TODO item is still valid if the code already implements it.

## Session end

Before ending any coding session:

1. Run the relevant project checks (`bun run check` in every touched project).
2. Update `TODO.md` to contain only currently unresolved work; delete finished lines instead of checking them off.
3. Append one accurate entry to `AI_WORK_DONE.md` (append-only, newest last).
4. Include actual date/time (Europe/Stockholm) and the actual model name when known.
5. Never claim a command passed unless it was actually executed in that session.

## AI markdown policy

Do not create new one-off AI work logs such as `TASKS.md`, `FIXLOG.md`,
`FINAL-REPORT.md`, `SESSION.md`, `BUGS-DONE.md`, or
`implementation-report.md`. Use only:

- `TODO.md` — current open work
- `AI_WORK_DONE.md` — append-only history of completed work

Product documentation lives separately in README/API docs.

## TODO policy

`TODO.md` contains only open work: real bugs, unimplemented requirements,
verification blockers, and concrete actionable technical debt. Completed
items are removed, never checked off. No history, no "nice ideas", no
changelog.

## Work log policy

`AI_WORK_DONE.md` is append-only. Each coding session records timestamp,
timezone, model, commit, what changed, why, and verification. Never rewrite
previous entries merely to make history look cleaner.

## Library policy

Prefer official/public APIs and maintained libraries where they materially
reduce local code (official MCP SDK, Fastify plugins, Zod, the PostgreSQL
client's native safe query API). Do not introduce dependencies for trivial
helpers. Do not monkeypatch libraries, modify `node_modules`, access library
private internals, or use patch-package unless the human explicitly approves
it.

## Runtime/toolchain policy

Bun is the permanent runtime and package manager for both projects
(explicit human architecture decision, 2026-08-25, pinned `bun@1.4.0`).
`bun.lock` is the only lockfile; Vitest/Jest have been replaced by
bun:test; TypeScript sources run directly under Bun in production and
`tsc --noEmit` remains the typecheck. Do not use npm/node/npx in normal
development or runtime, do not mix package managers, and do not add
compatibility shims. pg → Bun.SQL and Fastify → Bun.serve remain
separate, not-yet-approved decisions.

## SQL policy

All runtime SQL values must be parameterized (`$1`-style bound values) or
passed through the chosen database library's safe parameter API. Raw
interpolation of runtime values into SQL is forbidden. Dynamic identifiers
and sort directions must use explicit allowlists or the DB library's safe
identifier API. Never run `.unsafe()`-style escape hatches with user/runtime
input. In this workspace the enforced boundary is `restful-api/src/sql.ts`
(see "SQL changes require extra care" below).

## MCP policy

MCP must use the official TypeScript SDK public API only — no private
internals, no client-specific schema hacks, no per-User-Agent behavior. When
debugging tool discovery, raw `tools/list` from a fresh official MCP client
is the source of truth; never infer a server bug solely from a third-party
client's cached schema. The tool set is static per deployment; startup logs
publish version/build SHA/protocol generation/tool count and a tool schema
fingerprint so drift between deployments is observable.

## Test policy

```
bun run format && bun run lint && bun run typecheck && bun test && bun run check
```

When changing `mcp-server-v2/`, run the equivalent commands in that project.
If both changed, run `check` in both.

Fake-repository tests are NOT PostgreSQL integration tests, and must never
be described as such. A PostgreSQL integration test executes SQL against an
actual PostgreSQL instance.

## Code quality tooling (ESLint + Prettier)

Both `restful-api/` and `mcp-server-v2/` are separate Bun projects, each with:

- ESLint flat config (`eslint.config.mjs`, type-aware via project service)
- Prettier (`.prettierrc.json`, `.prettierignore`)
- Scripts: `lint`, `lint:fix`, `format`, `format:check`, `check`

Prettier owns formatting; ESLint owns code quality only. Never add
`eslint-plugin-prettier`. Do not disable rules globally or add inline
`eslint-disable` without a concrete documented reason.

### Required workflow when OpenCode changes TypeScript

In every project that contains changed TypeScript files:

1. Run `bun run format`.
2. Run `bun run lint` (zero warnings tolerated).
3. Fix reported lint errors in code; do not silence them.
4. Before finishing the session, run `bun run check`
   (= `format:check && lint && typecheck && test`).

If both projects were touched, run `check` in both.

### SQL changes require extra care

SQL construction safety is enforced by two ESLint rules plus conventions:

1. **`meshat/no-unsafe-sql-interpolation`** (local, in
   `restful-api/eslint-rules/`). Interpolation into SQL passed directly to
   `*.query(...)` is allowed only for branded `SqlParam`/`SqlFragment`
   values (opaque brands in `restful-api/src/sql.ts`) or AST-provable
   compile-time literals. String literal union types are NOT trusted on
   type information alone - a cast can lie - so sort directions go through
   `sqlDirection()`. There is no "module scope is trusted" escape hatch;
   unbranded constants carrying dynamic content are rejected. The rule
   fails closed without type information and has a RuleTester suite under
   `restful-api/tests/eslint-rules/`.
2. **`meshat/no-sql-brand-casts`** rejects casting values to
   `SqlFragment`/`SqlParam` anywhere outside `src/sql.ts`. The brands use
   unexported unique symbols; the only way to produce them is the `sql`
   tagged template, `joinSql()`, `sqlDirection()` and `placeholder(index)`
   inside the trust module.
3. **Conventions and tests.** Values always travel as `$1`-style bound
   parameters via the `add(sql, value)` helper; dynamic identifiers/sort
   columns come only from allowlist records typed as `SqlFragment`.
   Never interpolate runtime input into SQL template literals.

If query semantics change, run the relevant tests (`bun test` in
`restful-api/`). ESLint cannot verify SQL semantics against PostgreSQL;
the fake-based test suite does not execute queries against a real database.
