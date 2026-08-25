import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { GitDocumentationService } from "../src/docs.js";
import { aggregateNeighbors } from "../src/mappers.js";
import { buildServer } from "../src/server.js";
import { FakeRepository } from "./fakes.js";
import { errorCode } from "./support.js";

const temporaryRoots: string[] = [];
afterEach(async () =>
  Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("remaining REST verification gaps", () => {
  it("distinguishes one-way outbound, one-way inbound, and reciprocal neighbors", () => {
    const base = {
      counterpart_public_key: "B".repeat(64),
      reporting_observer: "A".repeat(64),
      received_at_ms: "1000",
      regions: ["public"],
      latest_role: "REPEATER",
    };
    expect(aggregateNeighbors([{ ...base, direction: "outbound" }])[0]).toMatchObject({
      relationship: "reported",
      direction: "outbound",
      node: { role: "repeater" },
    });
    expect(aggregateNeighbors([{ ...base, direction: "inbound" }])[0]).toMatchObject({
      relationship: "reported",
      direction: "inbound",
    });
    expect(
      aggregateNeighbors([
        { ...base, direction: "outbound" },
        {
          ...base,
          direction: "inbound",
          reporting_observer: "B".repeat(64),
        },
      ])[0],
    ).toMatchObject({
      relationship: "reciprocal",
      direction: "both",
      evidence: { report_count: 2, observer_count: 2 },
    });
  });

  it("rejects nonsensical and excessive activity window/interval combinations", async () => {
    const app = await buildServer({
      config: loadConfig({ DOCS_CACHE_DIR: "/tmp/unused-meshat-docs" }),
      repository: new FakeRepository(),
      refreshDocs: false,
      logger: false,
    });
    for (const query of ["window=1h&interval=6h", "window=30d&interval=5m"]) {
      const response = await app.inject(`/v1/meshcore/activity?${query}`);
      expect(response.statusCode, query).toBe(422);
      expect(errorCode(response)).toBe("INVALID_ARGUMENT");
    }
    await app.close();
  });

  it("contains no meshcore_private reference in any production TypeScript source", async () => {
    const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
    const files = (await readdir(sourceDirectory)).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(join(sourceDirectory, file), "utf8");
      expect(source, file).not.toContain("meshcore_private");
    }
  });

  it("keeps core routes available when initial docs refresh fails", async () => {
    const root = join(tmpdir(), `meshat-docs-app-${randomUUID()}`);
    temporaryRoots.push(root);
    await mkdir(root, { recursive: true });
    const config = loadConfig({ DOCS_CACHE_DIR: join(root, "repo") });
    const docs = new GitDocumentationService(config.docs, async () => {
      throw new Error("documentation remote unavailable");
    });
    const app = await buildServer({
      config,
      repository: new FakeRepository(),
      docs,
      logger: false,
    });
    expect((await app.inject("/v1/sources")).statusCode).toBe(200);
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    const unavailable = await app.inject("/v1/docs");
    expect(unavailable.statusCode).toBe(503);
    expect(errorCode(unavailable)).toBe("DOCS_UNAVAILABLE");
    await app.close();
  });
});
