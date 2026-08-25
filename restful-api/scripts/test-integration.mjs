#!/usr/bin/env bun
// Orchestrates the REST PostgreSQL integration suite:
//   1. start disposable PostgreSQL via the sibling broker's compose.test.yaml
//   2. provision the canonical MeshCore schema + deterministic fixture
//   3. run bun test for tests/integration against it as meshcore_http
//   4. always stop the container and remove volumes
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const here = import.meta.dirname;
const brokerRepo = path.resolve(
  process.env.MESHCORE_BROKER_REPO ?? path.join(here, "..", "..", "..", "meshcore-mqtt-broker"),
);

if (!fs.existsSync(path.join(brokerRepo, "compose.test.yaml"))) {
  console.error(
    `[integration] broker repo with compose.test.yaml not found at ${brokerRepo}. Set MESHCORE_BROKER_REPO.`,
  );
  process.exit(2);
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  return result.status ?? 1;
}

let exitCode = 1;
try {
  if (run("bun", [path.join(brokerRepo, "scripts/test-db-up.mjs")]) !== 0)
    process.exit(1);
  if (
    run("bun", [path.join(here, "integration-provision.mjs")], {
      MESHCORE_BROKER_REPO: brokerRepo,
    }) !== 0
  )
    process.exit(1);

  exitCode = run("bun", ["test", "tests/integration"], {
    INTEGRATION_DATABASE_URL:
      process.env.INTEGRATION_DATABASE_URL ??
      "postgresql://meshcore_http:integration_http@127.0.0.1:55432/meshcore",
    DATABASE_HOST: "127.0.0.1",
    DATABASE_PORT: "55432",
    DATABASE_NAME: "meshcore",
    DATABASE_USER: "meshcore_http",
    DATABASE_PASSWORD: "integration_http",
    DATABASE_SSL: "false",
    DATABASE_POOL_MAX: "4",
  });
} finally {
  run("bun", [path.join(brokerRepo, "scripts/test-db-down.mjs")]);
}
process.exit(exitCode);
