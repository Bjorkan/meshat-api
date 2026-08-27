# Contributing to Meshat API

Thanks for considering a contribution! This repository hosts two services:

- `restful-api/` — the public Meshat.se REST API (Fastify, Zod 4, Bun.SQL)
- `mcp-server-v2/` — the Meshat.se MCP-V2 server (official MCP SDK)

## Repository relationship

These are **separate repositories**:

| Repository                                                                        | Content                                                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Bjorkan/meshat-api` (this repo)                                                  | REST + MCP services, public contracts, CI                                                               |
| [`Bjorkan/meshcore-mqtt-broker`](https://github.com/Bjorkan/meshcore-mqtt-broker) | MQTT ingestion broker, canonical PostgreSQL schema (`meshcore_public`), migrations, all database writes |

The broker is the single database/schema authority. REST reads the public
schema read-only; MCP talks only to REST. **Do not add canonical
CREATE TABLE / ALTER TABLE logic in meshat-api** to work around schema needs —
schema changes belong in the broker repository.

Normal changes usually touch **one** repository: a change in this repo does not
require a broker commit when the broker contract already supports it, and an
internal broker refactor does not require a commit here when the public
contract is unchanged.

## Toolchain

Everything runs on [Bun](https://bun.sh) 1.4.0 (`packageManager` pins it).
Do not use npm/node/npx workflows; there are no npm lockfiles.

```bash
cd restful-api        # or mcp-server-v2/
bun install --frozen-lockfile
bun run check         # format + lint + typecheck + unit/system tests
```

## Full PostgreSQL integration (REST)

The integration suite needs the **sibling broker checkout** because schema
provisioning uses the broker's own canonical tooling:

```bash
git clone git@github.com:Bjorkan/meshat-api.git workspace/meshat-api
git clone git@github.com:Bjorkan/meshcore-mqtt-broker.git workspace/meshcore-mqtt-broker

cd workspace/meshcore-mqtt-broker
bun install --frozen-lockfile    # once, so the harness can reuse its test tooling

cd ../meshat-api/restful-api
bun install --frozen-lockfile
bun run test:integration   # disposable PostgreSQL via compose
bun run check:full         # check + integration together
```

If your layout differs, point the harness at the sibling checkout explicitly
with `MESHCORE_BROKER_REPO` (for example `../../meshcore-mqtt-broker`
relative to `restful-api/`).

## Cross-repo changes

Changes that alter the shared database/public contract must be coordinated.
Typical cases:

- **REST needs a new public column/relation:** implement it in the broker
  (schema/projection) first or in coordinated parallel PRs; extend REST
  compatibility tests; verify REST integration against the changed broker.
- **Broker removes/renames a public relation:** REST must be updated or
  compatibility preserved before delivery; run the REST integration suite
  against the changed broker tree.
- **MCP presentation/tool-only change:** normally no broker involvement at
  all; just run `bun run check` in `mcp-server-v2/`.
- **Index-only or driver/internal broker refactor:** no REST source change,
  but run REST integration as a smoke check against the changed broker.

Cross-repo checklist for DB/schema-related changes:

- [ ] Did the broker schema change?
- [ ] Is schema version/fingerprint impact understood?
      (ordinary performance indexes are excluded from fingerprint-v2)
- [ ] Does REST integration pass against the changed broker tree?
- [ ] Is backward/forward deploy compatibility understood?
- [ ] Does MCP still pass if the REST wire contract changed?

When deployment coordination is needed, prefer backward-compatible contract
evolution and follow this order where practical:

1. make the schema/public contract change backward-compatible where possible
2. deploy the broker/schema support
3. verify
4. deploy REST dependent on it
5. deploy MCP only if its interface depended on something new

Avoid lockstep deploys unless a specific change genuinely requires them.

## Pull requests

PRs go to **one** repository. If a change requires both repos, open separate
PRs/commits and link them in each description, stating:

```
Related broker/API change: <repository> PR/commit
Deployment order: broker → REST → MCP (if applicable)
Compatibility: verified by rest-integration CI / local suite run
```

CI runs on every push/PR and includes a cross-repository job that checks out
the current broker `main` and runs the real PostgreSQL integration suite.
If that job fails on your branch, fix the root cause rather than skipping the
compatibility gate.

## Repo layout rules

- No git submodules and no vendored copies of the broker inside this repo.
- No shared workspace/package root across the two repositories.
- The only broker artifact consumed here is runtime data through PostgreSQL —
  nothing else.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
