import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { FakeDocs, FakeRepository, HASH, KEY, MESSAGE_ID } from "./fakes.js";
import { errorOf, errorCode, jsonAs, payload, type OpenApiDocument } from "./support.js";

describe("public domain API", () => {
  let app: FastifyInstance;
  const repository = new FakeRepository();

  beforeAll(async () => {
    app = await buildServer({
      config: loadConfig({ DOCS_CACHE_DIR: "/tmp/unused-meshat-docs" }),
      repository,
      docs: new FakeDocs(),
      refreshDocs: false,
      logger: false,
    });
  });
  afterAll(async () => app.close());

  it("exposes health, source discovery, and MeshCore overview anonymously", async () => {
    expect((await app.inject("/")).statusCode).toBe(200);
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    expect((await app.inject("/readyz")).statusCode).toBe(200);
    const source = payload<Array<{ url?: string }>>(await app.inject("/v1/sources"))[0];
    expect(source?.url).toBe("/v1/meshcore");
    expect(
      payload<{ resources?: { regions?: string } }>(await app.inject("/v1/meshcore")).resources
        ?.regions,
    ).toBe("/v1/meshcore/regions");
    expect(
      payload<
        Array<{
          data_availability?: { telemetry?: { status?: string } };
        }>
      >(await app.inject("/v1/sources"))[0]?.data_availability?.telemetry?.status,
    ).toBe("limited");
  });

  it("has no old or generic database-browser routes", async () => {
    for (const route of [
      "/api/v1",
      "/api/v1/sources",
      "/v1/tables",
      "/v1/schema",
      "/v1/query",
      "/v1/meshcore/scopes",
    ]) {
      const response = await app.inject(route);
      expect(response.statusCode, route).toBe(404);
      expect(errorCode(response)).toBe("NOT_FOUND");
    }
  });

  it("validates node filters and binds cursors to the normalized query", async () => {
    const injection = "x%' OR 1=1 --";
    const first = await app.inject(
      `/v1/meshcore/nodes?name=${encodeURIComponent(injection)}&iata=jkg&limit=1`,
    );
    expect(first.statusCode).toBe(200);
    expect(repository.lastNodeRequest?.filters.name).toBe(injection);
    expect(repository.lastNodeRequest?.filters.iata).toBe("JKG");
    const cursor =
      jsonAs<{ pagination?: { next_cursor?: string | null } }>(first).pagination?.next_cursor ?? "";
    const continued = await app.inject(
      `/v1/meshcore/nodes?name=${encodeURIComponent(injection)}&iata=JKG&limit=1&cursor=${cursor}`,
    );
    expect(continued.statusCode).toBe(200);
    expect(repository.lastNodeRequest?.after).toEqual(["100", KEY]);
    const mismatch = await app.inject(
      `/v1/meshcore/nodes?name=other&iata=JKG&limit=1&cursor=${cursor}`,
    );
    expect(mismatch.statusCode).toBe(422);
    expect(errorCode(mismatch)).toBe("INVALID_CURSOR");
  });

  it("requires complete geographic filters and allowlisted sorts", async () => {
    expect((await app.inject("/v1/meshcore/nodes?near_lat=57")).statusCode).toBe(422);
    expect((await app.inject("/v1/meshcore/nodes?sort=private_id")).statusCode).toBe(400);
    expect(
      (await app.inject("/v1/meshcore/observers?near_lat=57&near_lon=14&radius_km=20")).statusCode,
    ).toBe(200);
    expect((await app.inject("/v1/meshcore/nodes?unsupported=value")).statusCode).toBe(400);
  });

  it("aggregates reciprocal latest-snapshot evidence honestly", async () => {
    const response = await app.inject(`/v1/meshcore/nodes/${KEY}/neighbors`);
    expect(response.statusCode).toBe(200);
    expect(payload<Array<Record<string, unknown>>>(response)[0]).toMatchObject({
      relationship: "reciprocal",
      direction: "both",
      evidence: { report_count: 2, observer_count: 2 },
    });
  });

  it("keeps IATA and logical regions separate", async () => {
    const iata = await app.inject("/v1/meshcore/iata/arn");
    expect(payload<Record<string, unknown>>(iata)).toMatchObject({
      code: "ARN",
      type: "secondary",
      primary_code: "STO",
    });
    expect(repository.lastIataCode).toBe("STO");
    expect(payload<{ links?: { nodes?: string } }>(iata).links?.nodes).toContain("iata=STO");
    const regions = await app.inject("/v1/meshcore/regions");
    expect(payload<unknown>(regions)).toEqual([
      {
        region: "public",
        name: "public",
        first_seen: null,
        last_seen: null,
        manually_added: false,
        observation_count: 1,
        node_count: 1,
        observer_count: 1,
        last_activity: null,
        links: {
          nodes: "/v1/meshcore/regions/public/nodes",
          observers: "/v1/meshcore/observers?region=public",
        },
      },
    ]);
    const se01 = await app.inject("/v1/meshcore/regions/SE01");
    expect(se01.statusCode).toBe(200);
    expect(repository.lastRegionLookup).toBe("se01");
    expect(payload<Record<string, unknown>>(se01)).toMatchObject({
      region: "se01",
      name: "Stockholms län",
    });
  });

  it("normalizes Swedish region prefixes but keeps custom scopes untouched", async () => {
    await app.inject("/v1/meshcore/regions?prefix=SE13");
    expect(repository.lastRegionRequest?.filters.prefix).toBe("se13");
    await app.inject("/v1/meshcore/regions?prefix=SE");
    expect(repository.lastRegionRequest?.filters.prefix).toBe("se");
    await app.inject("/v1/meshcore/regions?prefix=Custom%20Scope");
    expect(repository.lastRegionRequest?.filters.prefix).toBe("Custom Scope");
  });

  it("serves packet raw bytes and bounded message defaults", async () => {
    expect(payload<{ raw?: string }>(await app.inject(`/v1/meshcore/packets/${HASH}`)).raw).toBe(
      "0xa1b2",
    );
    expect((await app.inject("/v1/meshcore/messages")).statusCode).toBe(200);
    expect(repository.lastMessageRequest?.limit).toBe(50);
    expect((await app.inject("/v1/meshcore/messages?encrypted=false")).statusCode).toBe(200);
    expect(repository.lastMessageRequest?.filters.encrypted).toBe(false);
    expect((await app.inject("/v1/meshcore/messages?limit=201")).statusCode).toBe(400);
  });

  it("exposes every contracted detail/history route", async () => {
    const routes = [
      `/v1/meshcore/nodes/${KEY}`,
      `/v1/meshcore/nodes/${KEY}/adverts`,
      `/v1/meshcore/nodes/${KEY}/sightings`,
      `/v1/meshcore/nodes/${KEY}/telemetry`,
      "/v1/meshcore/observers",
      `/v1/meshcore/observers/${KEY}`,
      `/v1/meshcore/observers/${KEY}/status`,
      `/v1/meshcore/observers/${KEY}/metrics`,
      "/v1/meshcore/regions/public",
      "/v1/meshcore/regions/public/nodes",
      "/v1/meshcore/packets",
      `/v1/meshcore/packets/${HASH}/observations`,
      `/v1/meshcore/messages/${MESSAGE_ID}`,
      "/v1/meshcore/telemetry",
      "/v1/meshcore/telemetry/1",
      "/v1/meshcore/traces",
      "/v1/meshcore/traces/1",
      "/v1/meshcore/traces/1/hops",
      "/v1/meshcore/stats",
      "/v1/meshcore/activity?window=24h&interval=1h",
      "/v1/docs",
      "/v1/docs/search?q=mesh",
      "/v1/docs/guide.md",
    ];
    for (const route of routes) expect((await app.inject(route)).statusCode, route).toBe(200);
  });

  it("returns explicit non-cursor documentation search metadata", async () => {
    const search = jsonAs<{
      data?: Record<string, unknown>;
      pagination?: unknown;
    }>(await app.inject("/v1/docs/search?q=mesh&limit=7"));
    expect(search.data).toMatchObject({
      query: "mesh",
      limit: 7,
      returned: 1,
      total_matches: 1,
      scan_complete: true,
      truncated: false,
      results: [{ path: "guide.md", media_type: "text/markdown" }],
    });
    expect(search).not.toHaveProperty("pagination");
    expect(JSON.stringify(search)).not.toContain("next_cursor");
  });

  it("accepts uppercase logical message hex everywhere and normalizes it", async () => {
    const upper = MESSAGE_ID.replace(/[a-f]/g, (character) => character.toUpperCase());
    const message = await app.inject(`/v1/meshcore/messages/${upper}`);
    expect(message.statusCode).toBe(200);
    expect(payload<{ id?: string }>(message).id).toBe(MESSAGE_ID);
    const packets = await app.inject(`/v1/meshcore/packets?logical_id=${upper}`);
    expect(packets.statusCode).toBe(200);
    const barePrefix = await app.inject(`/v1/meshcore/messages/${MESSAGE_ID.toUpperCase()}`);
    expect(barePrefix.statusCode).toBe(400);
  });

  it("returns stable not-found and readiness errors with request IDs", async () => {
    const missing = await app.inject(`/v1/meshcore/nodes/${"F".repeat(64)}`);
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing)).toMatchObject({ code: "NOT_FOUND" });
    expect(errorOf(missing).request_id).toBeTruthy();
    repository.healthy = false;
    const readiness = await app.inject("/readyz");
    repository.healthy = true;
    expect(readiness.statusCode).toBe(503);
    expect(errorCode(readiness)).toBe("DATABASE_UNAVAILABLE");
  });

  it("rejects unknown IATA and inverted time ranges consistently", async () => {
    const unknown = await app.inject("/v1/meshcore/nodes?iata=ZZZ");
    expect(unknown.statusCode).toBe(422);
    expect(errorCode(unknown)).toBe("INVALID_ARGUMENT");
    const missing = await app.inject("/v1/meshcore/iata/ZZZ");
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing)).toBe("NOT_FOUND");
    const bareMessageId = await app.inject(`/v1/meshcore/messages/${"a".repeat(64)}`);
    expect(bareMessageId.statusCode).toBe(400);
    expect(errorCode(bareMessageId)).toBe("INVALID_ARGUMENT");
    const bareLogicalId = await app.inject(`/v1/meshcore/packets?logical_id=${"a".repeat(64)}`);
    expect(bareLogicalId.statusCode).toBe(400);
    expect(errorCode(bareLogicalId)).toBe("INVALID_ARGUMENT");
    const activityRegion = await app.inject("/v1/meshcore/activity?region=se13");
    expect(activityRegion.statusCode).toBe(400);
    expect(errorCode(activityRegion)).toBe("INVALID_ARGUMENT");

    const later = encodeURIComponent("2026-08-24T00:00:00Z");
    const earlier = encodeURIComponent("2026-08-23T00:00:00Z");
    for (const route of [
      `/v1/meshcore/nodes?seen_from=${later}&seen_to=${earlier}`,
      `/v1/meshcore/observers?seen_from=${later}&seen_to=${earlier}`,
      `/v1/meshcore/packets?received_from=${later}&received_to=${earlier}`,
      `/v1/meshcore/messages?received_from=${later}&received_to=${earlier}`,
      `/v1/meshcore/telemetry?received_from=${later}&received_to=${earlier}`,
      `/v1/meshcore/traces?received_from=${later}&received_to=${earlier}`,
    ]) {
      const response = await app.inject(route);
      expect(response.statusCode, route).toBe(422);
      expect(errorCode(response)).toBe("INVALID_ARGUMENT");
    }
  });

  it("publishes complete anonymous OpenAPI and Swagger UI", async () => {
    expect((await app.inject("/docs")).statusCode).toBe(200);
    const document = jsonAs<OpenApiDocument>(await app.inject("/openapi.json"));
    expect(document.info?.title).toBe("Meshat.se REST API");
    expect(document.components?.securitySchemes).toBeUndefined();
    for (const path of [
      "/openapi.json",
      "/v1/sources",
      "/v1/docs",
      "/v1/docs/{*}",
      "/v1/meshcore/nodes",
      "/v1/meshcore/observers",
      "/v1/meshcore/iata",
      "/v1/meshcore/regions",
      "/v1/meshcore/packets",
      "/v1/meshcore/messages",
      "/v1/meshcore/telemetry",
      "/v1/meshcore/traces",
      "/v1/meshcore/stats",
      "/v1/meshcore/activity",
    ]) {
      expect(document.paths?.[path], path).toBeTruthy();
    }
    expect(JSON.stringify(document)).not.toContain("information_schema");
    expect(
      document.paths?.["/v1/meshcore/observers"]?.get?.parameters?.some(
        (parameter) => parameter.name === "role",
      ),
    ).toBe(false);
    expect(
      document.paths?.["/v1/docs/{*}"]?.get?.parameters?.find((parameter) => parameter.name === "*")
        ?.required,
    ).toBe(true);
    expect(document.paths?.["/v1/meshcore/packets"]?.get?.responses?.["503"]).toBeTruthy();
    expect(document.paths?.["/v1/docs/{*}"]?.get?.responses?.["413"]).toBeTruthy();
    expect(document.paths?.["/v1/meshcore/messages"]?.get?.description).toContain(
      "configured default 50, configured maximum 200",
    );
    {
      // The response is emitted as a reusable $ref; resolve it before
      // asserting the exact required contract fields.
      const readySchema = document.paths?.["/readyz"]?.get?.responses?.["200"]?.content?.[
        "application/json"
      ]?.schema as { properties?: { data?: { $ref?: string } } };
      const ref = readySchema?.properties?.data?.$ref ?? "";
      const componentName = ref.split("/").pop() ?? "";
      const component = (
        document.components as unknown as { schemas?: Record<string, { required?: string[] }> }
      )?.schemas?.[componentName];
      expect(component!.required).toEqual([
        "status",
        "database",
        "docs",
        "release_id",
        "schema_version",
        "schema_hash",
      ]);
    }
    for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
      const operation = pathItem.get;
      if (!operation) continue;
      expect(operation.summary, path).toBeTruthy();
      expect(operation.description, path).toBeTruthy();
      const success = operation.responses?.["200"];
      expect(success?.description, path).toBeTruthy();
      // Documented dynamic-data exception: the OpenAPI document itself.
      if (path === "/openapi.json") return;
      const successSchema = success?.content?.["application/json"]?.schema;
      // Reusable-component responses carry documentation via nested $ref to
      // the registered schemas; inline responses must include an example.
      const usesComponent = JSON.stringify(successSchema ?? {}).includes('"$ref"');
      if (!usesComponent) expect(successSchema?.example, path).toBeTruthy();
      for (const parameter of operation.parameters ?? []) {
        if (parameter.in === "query")
          expect(parameter.description, `${path}:${parameter.name}`).toBeTruthy();
      }
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (status === "200") continue;
        expect(response.description, `${path}:${status}`).toBeTruthy();
        const errorSchema = response.content?.["application/json"]?.schema;
        // Error responses reference the shared ErrorEnvelope component.
        expect(JSON.stringify(errorSchema ?? {}).includes('"$ref"'), `${path}:${status}`).toBe(
          true,
        );
      }
    }
  });
});

describe("configured message bounds", () => {
  it("uses environment-derived message defaults and maxima", async () => {
    const repository = new FakeRepository();
    const app = await buildServer({
      config: loadConfig({
        DOCS_CACHE_DIR: "/tmp/unused-meshat-docs",
        MESSAGE_DEFAULT_LIMIT: "7",
        MESSAGE_MAX_LIMIT: "9",
      }),
      repository,
      docs: new FakeDocs(),
      refreshDocs: false,
      logger: false,
    });
    expect((await app.inject("/v1/meshcore/messages")).statusCode).toBe(200);
    expect(repository.lastMessageRequest?.limit).toBe(7);
    expect((await app.inject("/v1/meshcore/messages?limit=10")).statusCode).toBe(400);
    const openapi = jsonAs<OpenApiDocument>(await app.inject("/openapi.json"));
    expect(openapi.paths?.["/v1/meshcore/messages"]?.get?.description).toContain(
      "configured default 7, configured maximum 9",
    );
    const limit = openapi.paths?.["/v1/meshcore/messages"]?.get?.parameters?.find(
      (parameter) => parameter.name === "limit",
    );
    expect(limit?.schema).toMatchObject({ default: 7, maximum: 9 });
    await app.close();
  });
});

describe("rate limiting", () => {
  it("uses the stable public error code", async () => {
    const app = await buildServer({
      config: loadConfig({
        DOCS_CACHE_DIR: "/tmp/unused-meshat-docs",
        API_RATE_LIMIT_MAX: "1",
      }),
      repository: new FakeRepository(),
      docs: new FakeDocs(),
      refreshDocs: false,
      logger: false,
    });
    await app.inject("/v1/sources");
    const response = await app.inject("/v1/sources");
    expect(response.statusCode).toBe(429);
    expect(errorCode(response)).toBe("RATE_LIMIT_EXCEEDED");
    await app.close();
  });

  it("does not trust the client-controlled Host header as a bypass", async () => {
    const app = await buildServer({
      config: loadConfig({
        DOCS_CACHE_DIR: "/tmp/unused-meshat-docs",
        API_RATE_LIMIT_MAX: "1",
      }),
      repository: new FakeRepository(),
      docs: new FakeDocs(),
      refreshDocs: false,
      logger: false,
    });
    await app.inject({
      method: "GET",
      url: "/v1/sources",
      headers: { host: "restful-api" },
    });
    const limited = await app.inject({
      method: "GET",
      url: "/v1/sources",
      headers: { host: "restful-api" },
    });
    expect(limited.statusCode).toBe(429);
    expect(errorCode(limited)).toBe("RATE_LIMIT_EXCEEDED");
    await app.close();
  });

  it("still exempts only the health and readiness paths", async () => {
    const app = await buildServer({
      config: loadConfig({
        DOCS_CACHE_DIR: "/tmp/unused-meshat-docs",
        API_RATE_LIMIT_MAX: "1",
      }),
      repository: new FakeRepository(),
      docs: new FakeDocs(),
      refreshDocs: false,
      logger: false,
    });
    await app.inject("/v1/sources");
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    expect((await app.inject("/readyz")).statusCode).toBe(200);
    const limited = await app.inject("/v1/sources");
    expect(limited.statusCode).toBe(429);
    await app.close();
  });
});
