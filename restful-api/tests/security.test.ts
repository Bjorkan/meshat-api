import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { FakeDocs, FakeRepository, KEY } from "./fakes.js";
import type { PublicNode } from "../src/contracts.js";

/**
 * Security guarantees that previously came from hand-written
 * fast-json-stringify whitelists, now enforced by the Zod serializer:
 *   1. undeclared internal repository fields never reach the wire
 *   2. response-contract failures surface as generic internal errors,
 *      never as Zod internals/stacks/data
 */

let app: Awaited<ReturnType<typeof buildServer>>;
let repository: FakeRepository;

beforeAll(async () => {
  repository = new FakeRepository();
  app = await buildServer({
    config: loadConfig({ DOCS_CACHE_DIR: "/tmp/unused-meshat-docs" }),
    repository,
    docs: new FakeDocs(),
    refreshDocs: false,
    logger: false,
  });
});

afterAll(async () => app.close());

describe("response field-leakage guard (§59)", () => {
  it("strips internal fields injected by the repository", async () => {
    repository.leakInternalFields = true;
    const response = await app.inject(`/v1/meshcore/nodes/${KEY}`);
    expect(response.statusCode).toBe(200);
    const rawBody: string = response.body;
    expect(rawBody).not.toContain("password");
    expect(rawBody).not.toContain("secret");
    expect(rawBody).not.toContain("private_metadata");
    const node = (JSON.parse(rawBody) as { data: Record<string, unknown> }).data;
    expect(Object.keys(node).sort()).toEqual([
      "first_seen",
      "iata",
      "last_seen",
      "location",
      "name",
      "owner_public_key",
      "public_key",
      "regions",
      "role",
    ]);
    repository.leakInternalFields = false;
  });
});

describe("response contract failure guard (§60)", () => {
  it("returns a generic internal error envelope without internals", async () => {
    // Sabotage the repository so a required public field goes missing and
    // the serializer must reject the response.
    const original = repository.getNode.bind(repository);
    const brokenGetNode = async (): Promise<PublicNode> =>
      ({ public_key: KEY }) as unknown as PublicNode;
    repository.getNode = brokenGetNode;
    try {
      const response = await app.inject(`/v1/meshcore/nodes/${KEY}`);
      expect(response.statusCode).toBe(500);
      const parsedBody = JSON.parse(response.body) as {
        error: { code: string; request_id: string };
      };
      expect(parsedBody.error.code).toBe("INTERNAL_ERROR");
      expect(parsedBody.error.request_id).toBeTruthy();
      expect(response.body).not.toContain("ZodError");
      expect(response.body).not.toContain("stack");
      expect(JSON.stringify(parsedBody)).not.toContain("issues");
    } finally {
      repository.getNode = original;
    }
  });
});
