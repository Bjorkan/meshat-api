import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { randomUUID } from "node:crypto";
import type { ZodTypeProvider } from "@fastify/type-provider-zod";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from "@fastify/type-provider-zod";
import { z, ZodError } from "zod/v4";
import { loadConfig, type AppConfig } from "./config.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type { ListRequest, MeshcoreRepository, Page, SortOrder } from "./domain.js";
import { GitDocumentationService, type DocumentationService } from "./docs.js";
import { ApiError, notFound } from "./errors.js";
import { getIata, iataEntries } from "./iata.js";
import { aggregateNeighbors } from "./mappers.js";
import { PostgresMeshcoreRepository } from "./repository.js";
import { createDatabase } from "./database.js";
import * as c from "./contracts.js";
import * as req from "./request-schemas.js";

type BuildOptions = {
  config?: AppConfig;
  repository?: MeshcoreRepository;
  docs?: DocumentationService;
  refreshDocs?: boolean;
  logger?: boolean;
};

/** Fastify instance typed with the official Zod type provider. */
type ZodFastifyInstance = FastifyInstance<
  Server,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export async function buildServer(options: BuildOptions = {}) {
  const config = options.config ?? loadConfig();
  const ownedPool = !options.repository;
  if (!options.repository && !config.database.password) {
    throw new Error("DATABASE_PASSWORD is required when creating the PostgreSQL client");
  }
  const db = options.repository
    ? undefined
    : createDatabase({ ...config.database, password: config.database.password ?? "" });
  const repository =
    options.repository ?? new PostgresMeshcoreRepository(db!, config.observerActiveWindowMs);
  const docs = options.docs ?? new GitDocumentationService(config.docs);
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    genReqId: (request) => request.headers["x-request-id"]?.toString() || randomUUID(),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onRoute", (route) => {
    if (route.schema?.summary && !route.schema.description)
      route.schema.description = `${route.schema.summary}.`;
  });

  await app.register(cors, {
    origin:
      config.corsOrigins === "*" ? true : config.corsOrigins.split(",").map((item) => item.trim()),
  });
  await app.register(rateLimit, {
    global: config.rateLimitEnabled,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    allowList: (request) => request.url === "/healthz" || request.url === "/readyz",
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error(`Rate limit exceeded; retry in ${context.after}.`), {
        statusCode: 429,
        code: "RATE_LIMIT_EXCEEDED",
      }),
  });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Meshat.se REST API",
        version: config.releaseId,
        description:
          "Public, anonymous, read-only domain API. `/docs` is Swagger UI; `/v1/docs` serves Meshat.se documentation content.",
      },
      tags: (
        [
          ["System", "Service health and discovery."],
          ["Sources", "Network source discovery."],
          ["Documentation", "Safe access to the cached Meshat.se documentation repository."],
          ["MeshCore Overview", "MeshCore domain discovery."],
          ["MeshCore Nodes", "Known nodes, adverts, sightings, and node telemetry."],
          ["MeshCore Neighbors", "Latest-per-observer derived neighbor evidence."],
          ["MeshCore Observers", "MQTT reporting nodes and their status/metrics."],
          ["MeshCore IATA", "Geographic MQTT ingress areas, not logical MeshCore regions."],
          ["MeshCore Regions", "Logical regions derived from neighbor scopes, not IATA."],
          ["MeshCore Packets", "MeshCore packets and public RF observations."],
          ["MeshCore Messages", "Bounded public message projection."],
          ["MeshCore Telemetry", "Typed public telemetry values."],
          ["MeshCore Traces", "Trace events and ambiguity-aware hops."],
          ["MeshCore Statistics", "Current summary and bounded activity buckets."],
        ] as const
      ).map(([name, description]) => ({ name, description })),
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((error, request, reply) => {
    const apiError = normalizeError(error as Error & { statusCode?: number });
    if (apiError.statusCode >= 500)
      request.log.error({ err: error, request_id: request.id }, "request failed");
    else request.log.info({ code: apiError.code, request_id: request.id }, "request rejected");
    reply.code(apiError.statusCode).send({
      error: {
        code: apiError.code,
        message: apiError.message,
        request_id: request.id,
      },
    });
  });
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Route was not found.",
        request_id: request.id,
      },
    });
  });

  if (ownedPool && db) app.addHook("onClose", async () => db.close({ timeout: 1 }));
  // Single typed view used by every registration so validation and
  // serialization run through the Zod compilers configured above.
  const routed = app.withTypeProvider<ZodTypeProvider>() as unknown as ZodFastifyInstance;
  registerSystemRoutes(routed, repository, docs, config);
  registerDiscoveryRoutes(routed);
  registerDocsRoutes(routed, docs);
  registerNodeRoutes(routed, repository, config);
  registerObserverRoutes(routed, repository, config);
  registerGeographyRoutes(routed, repository, config);
  registerPacketRoutes(routed, repository, config);
  registerProtocolRoutes(routed, repository, config);
  registerStatisticsRoutes(routed, repository);

  await app.ready();
  if (options.refreshDocs !== false) {
    try {
      await docs.refresh();
      app.log.info({ docs: docs.metadata() }, "documentation cache refreshed");
    } catch (error) {
      app.log.warn(
        { err: error, docs: docs.metadata() },
        "documentation refresh failed; core API remains available",
      );
    }
  }
  return routed;
}

function detailSchema(
  tag: string,
  summary: string,
  params: z.ZodType,
  responseContract: z.ZodType,
) {
  return {
    schema: {
      tags: [tag],
      summary,
      params,
      response: {
        200: c.dataEnvelope(responseContract),
        ...c.standardErrorResponses,
      },
    },
  };
}

function registerSystemRoutes(
  app: ZodFastifyInstance,
  repository: MeshcoreRepository,
  docs: DocumentationService,
  config: AppConfig,
) {
  app.get(
    "/",
    {
      schema: {
        tags: ["System"],
        summary: "Service metadata",
        response: { 200: c.dataEnvelope(c.rootDataSchema) },
      },
    },
    () => ({
      data: {
        name: "Meshat.se REST API",
        version: "v1",
        release_id: config.releaseId,
        access: "public-anonymous-read-only",
        api: "/v1",
        sources: "/v1/sources",
        swagger: "/docs",
        openapi: "/openapi.json",
        documentation_content: "/v1/docs",
      },
    }),
  );
  app.get(
    "/healthz",
    {
      config: { rateLimit: false },
      schema: {
        tags: ["System"],
        summary: "Process liveness",
        response: { 200: c.dataEnvelope(c.healthDataSchema) },
      },
    },
    () => ({ data: { status: "ok" as const } }),
  );
  app.get(
    "/readyz",
    {
      config: { rateLimit: false },
      schema: {
        tags: ["System"],
        summary: "Database readiness and documentation status",
        description:
          "Readiness requires the expected schema ID, version, and a stored SHA-256 schema fingerprint that matches a live fingerprint computed from the public database catalog.",
        response: {
          200: c.dataEnvelope(c.readyDataSchema),
          503: c.errorEnvelopeSchema,
        },
      },
    },
    async (): Promise<{ data: c.ReadyData }> => {
      let metadata: Awaited<ReturnType<typeof repository.health>>;
      try {
        metadata = await repository.health();
      } catch {
        // Error handler renders the stable 503 envelope.
        throw new ApiError(503, "DATABASE_UNAVAILABLE", "Database is unavailable.");
      }
      void docs;
      return {
        data: {
          status: "ready",
          database: "ready",
          docs: docs.metadata().status,
          release_id: config.releaseId,
          schema_version: metadata.schema_version,
          schema_hash: metadata.schema_hash,
        },
      };
    },
  );
  // Genuinely dynamic document; the OpenAPI document is its own contract.
  app.get(
    "/openapi.json",
    {
      schema: {
        tags: ["System"],
        summary: "Get the public OpenAPI document",
        description:
          "The complete public OpenAPI 3.1 document; genuinely dynamic, so it is its own contract.",
      },
    },
    (_request, reply) => reply.send(app.swagger()),
  );
}

function registerDiscoveryRoutes(app: ZodFastifyInstance) {
  app.get(
    "/v1/sources",
    {
      schema: {
        tags: ["Sources"],
        summary: "List available network sources",
        response: { 200: c.dataEnvelope(z.array(c.sourceSchema)) },
      },
    },
    () => ({ data: [sourceDescription()] }),
  );
  app.get(
    "/v1/meshcore",
    {
      schema: {
        tags: ["MeshCore Overview"],
        summary: "Discover MeshCore resources",
        response: { 200: c.dataEnvelope(c.meshCoreOverviewSchema) },
      },
    },
    () => ({
      data: {
        ...sourceDescription(),
        resources: {
          nodes: "/v1/meshcore/nodes",
          observers: "/v1/meshcore/observers",
          regions: "/v1/meshcore/regions",
          iata: "/v1/meshcore/iata",
          packets: "/v1/meshcore/packets",
          messages: "/v1/meshcore/messages",
          telemetry: "/v1/meshcore/telemetry",
          traces: "/v1/meshcore/traces",
          stats: "/v1/meshcore/stats",
          activity: "/v1/meshcore/activity",
        },
      },
    }),
  );
}

function registerDocsRoutes(app: ZodFastifyInstance, docs: DocumentationService) {
  app.get(
    "/v1/docs",
    {
      schema: {
        tags: ["Documentation"],
        summary: "List the recursively indexed documentation subtree",
        description: "Returns metadata and sorted file entries, not every file's content.",
        response: {
          200: c.dataEnvelope(c.docsListDataSchema),
          503: c.errorEnvelopeSchema,
        },
      },
    },
    async (): Promise<{ data: c.DocsList }> => {
      const metadata = docs.metadata();
      return { data: { ...metadata, files: await docs.index() } };
    },
  );
  app.get<{ Querystring: { q: string; limit: number } }>(
    "/v1/docs/search",
    {
      schema: {
        tags: ["Documentation"],
        summary: "Search documentation text",
        description:
          "Bounded case-insensitive search over sorted public documentation candidates. The response reports whether all candidates were scanned and never uses a cursor.",
        querystring: req.docsSearchQuery(),
        response: {
          200: c.dataEnvelope(c.docsSearchResponseSchema),
          ...c.standardErrorResponses,
        },
      },
    },
    async (request) => ({ data: await docs.search(request.query.q, request.query.limit) }),
  );
  app.get<{ Params: { "*": string } }>(
    "/v1/docs/*",
    {
      schema: {
        tags: ["Documentation"],
        summary: "Get one documentation file",
        description:
          "Returns UTF-8 text only for Markdown files or exactly `meshtastic/example.yaml`. Other assets are not found; traversal, `.git`, symlink escapes, and oversized files are rejected.",
        params: req.wildcardPathSchema,
        response: {
          200: c.dataEnvelope(c.docContentDataSchema),
          ...c.standardErrorResponses,
          413: c.errorEnvelopeSchema,
        },
      },
    },
    async (request) => ({ data: await docs.get(request.params["*"]) }),
  );
}

function registerNodeRoutes(
  app: ZodFastifyInstance,
  repository: MeshcoreRepository,
  config: AppConfig,
) {
  app.get<{ Querystring: req.NodeQuery }>(
    "/v1/meshcore/nodes",
    {
      schema: {
        tags: ["MeshCore Nodes"],
        summary: "Search nodes",
        description:
          "Controlled filters with query-bound keyset pagination. `region` is a logical neighbor scope; `iata` is geographic ingress.",
        querystring: req.nodeQuery(config),
        response: { 200: c.collectionEnvelope(c.nodeSchema), ...c.standardErrorResponses },
      },
    },
    async (request) => {
      const query = request.query;
      const filters = {
        name: query.name,
        role: query.role,
        region: query.region,
        iata: query.iata,
        seenFrom: query.seen_from,
        seenTo: query.seen_to,
        nearLat: query.near_lat,
        nearLon: query.near_lon,
        radiusKm: query.radius_km,
      };
      return paginated(
        repository.listNodes(pageRequest("nodes", query, filters)),
        "nodes",
        query,
        filters,
      );
    },
  );
  app.get<{ Params: z.output<typeof req.publicKeyParams> }>(
    "/v1/meshcore/nodes/:public_key",
    detailSchema("MeshCore Nodes", "Get a node", req.publicKeyParams, c.nodeSchema),
    async (request) => {
      return { data: await required(repository.getNode(request.params.public_key), "Node") };
    },
  );
  app.get<{ Params: z.output<typeof req.publicKeyParams> }>(
    "/v1/meshcore/nodes/:public_key/neighbors",
    {
      schema: {
        tags: ["MeshCore Neighbors"],
        summary: "Get aggregated current neighbor relationships",
        description:
          "Uses only each observer's latest snapshot. `reciprocal` requires direct and reverse reports; direction is outbound, inbound, or both.",
        params: req.publicKeyParams,
        response: {
          200: c.dataEnvelope(z.array(c.neighborSchema)),
          ...c.standardErrorResponses,
        },
      },
    },
    async (request) => {
      await required(repository.getNode(request.params.public_key), "Node");
      return {
        data: aggregateNeighbors(await repository.getNeighborEvidence(request.params.public_key)),
      };
    },
  );
  registerNodeHistory(app, repository, config, "adverts", c.advertSchema, (key, page) =>
    repository.listNodeAdverts(key, page),
  );
  registerNodeHistory(app, repository, config, "sightings", c.sightingSchema, (key, page) =>
    repository.listNodeSightings(key, page),
  );
  registerNodeHistory(app, repository, config, "telemetry", c.telemetrySchema, (key, page) =>
    repository.listNodeTelemetry(key, page),
  );
}

function registerNodeHistory(
  app: ZodFastifyInstance,
  repository: MeshcoreRepository,
  config: AppConfig,
  segment: string,
  contract: z.ZodType,
  loader: (key: string, request: ListRequest<object>) => Promise<Page<unknown>>,
) {
  app.get<{ Params: { public_key: string }; Querystring: req.PageQuery }>(
    `/v1/meshcore/nodes/:public_key/${segment}`,
    {
      schema: {
        tags: ["MeshCore Nodes"],
        summary: `List node ${segment}`,
        params: req.publicKeyParams,
        querystring: req.pageQuery(config),
        response: {
          200: c.collectionEnvelope(contract),
          ...c.standardErrorResponses,
        },
      },
    },
    async (request) => {
      await required(repository.getNode(request.params.public_key), "Node");
      const query = request.query;
      const filters = { public_key: request.params.public_key };
      const resource = `node-${segment}`;
      const pageRequestValue = pageRequest(resource, query, {}, filters);
      return paginated(
        loader(request.params.public_key, pageRequestValue),
        resource,
        query,
        filters,
      );
    },
  );
}

function registerObserverRoutes(
  app: ZodFastifyInstance,
  repository: MeshcoreRepository,
  config: AppConfig,
) {
  app.get<{ Querystring: req.ObserverQuery }>(
    "/v1/meshcore/observers",
    {
      schema: {
        tags: ["MeshCore Observers"],
        summary: "Search reporting observers",
        description:
          "Observer location and geographic radius filters use the same-public-key node's verified latitude/longitude.",
        querystring: req.observerQuery(config),
        response: { 200: c.collectionEnvelope(c.observerSchema), ...c.standardErrorResponses },
      },
    },
    async (request) => {
      const query = request.query;
      const filters = {
        active: query.active,
        name: query.name,
        iata: query.iata,
        region: query.region,
        seenFrom: query.seen_from,
        seenTo: query.seen_to,
        nearLat: query.near_lat,
        nearLon: query.near_lon,
        radiusKm: query.radius_km,
      };
      return paginated(
        repository.listObservers(pageRequest("observers", query, filters)),
        "observers",
        query,
        filters,
      );
    },
  );
  app.get<{ Params: z.output<typeof req.publicKeyParams> }>(
    "/v1/meshcore/observers/:public_key",
    detailSchema("MeshCore Observers", "Get an observer", req.publicKeyParams, c.observerSchema),
    async (request) => {
      return {
        data: await required(repository.getObserver(request.params.public_key), "Observer"),
      };
    },
  );
  app.get<{ Params: z.output<typeof req.publicKeyParams> }>(
    "/v1/meshcore/observers/:public_key/status",
    detailSchema(
      "MeshCore Observers",
      "Get latest observer status",
      req.publicKeyParams,
      c.observerStatusSchema,
    ),
    async (request) => {
      await required(repository.getObserver(request.params.public_key), "Observer");
      return {
        data: await required(
          repository.getObserverStatus(request.params.public_key),
          "Observer status",
        ),
      };
    },
  );
  app.get<{
    Params: z.output<typeof req.publicKeyParams>;
    Querystring: req.PageQuery;
  }>(
    "/v1/meshcore/observers/:public_key/metrics",
    {
      schema: {
        tags: ["MeshCore Observers"],
        summary: "List observer metrics history",
        params: req.publicKeyParams,
        querystring: req.pageQuery(config),
        response: {
          200: c.collectionEnvelope(c.observerMetricSchema),
          ...c.standardErrorResponses,
        },
      },
    },
    async (request) => {
      await required(repository.getObserver(request.params.public_key), "Observer");
      const query = request.query;
      const binding = { public_key: request.params.public_key };
      return paginated(
        repository.listObserverMetrics(
          request.params.public_key,
          pageRequest("observer-metrics", query, {}, binding),
        ),
        "observer-metrics",
        query,
        binding,
      );
    },
  );
}

function registerGeographyRoutes(
  app: ZodFastifyInstance,
  repository: MeshcoreRepository,
  config: AppConfig,
) {
  app.get(
    "/v1/meshcore/iata",
    {
      schema: {
        tags: ["MeshCore IATA"],
        summary: "List configured Swedish IATA ingress areas",
        description:
          "Primary and secondary geographic MQTT ingress codes. These are not logical MeshCore regions.",
        response: { 200: c.dataEnvelope(z.array(c.iataEntrySchema)) },
      },
    },
    () => ({ data: iataEntries }),
  );
  app.get<{ Params: z.output<typeof req.iataParams> }>(
    "/v1/meshcore/iata/:code",
    {
      schema: {
        tags: ["MeshCore IATA"],
        summary: "Get IATA mapping and current activity summary",
        params: req.iataParams,
        response: {
          200: c.dataEnvelope(c.iataEntrySchema),
          ...c.standardErrorResponses,
        },
      },
    },
    async (request) => {
      const entry = getIata(request.params.code);
      if (!entry) throw new ApiError(404, "NOT_FOUND", "IATA code is not configured.");
      return {
        data: {
          ...entry,
          summary: await repository.getIataSummary(entry.primary_code),
          links: {
            nodes: `/v1/meshcore/nodes?iata=${entry.primary_code}`,
            observers: `/v1/meshcore/observers?iata=${entry.primary_code}`,
            activity: `/v1/meshcore/activity?iata=${entry.primary_code}`,
          },
        },
      };
    },
  );
  app.get<{ Querystring: req.RegionQuery }>(
    "/v1/meshcore/regions",
    {
      schema: {
        tags: ["MeshCore Regions"],
        summary: "List logical MeshCore regions",
        description:
          "Bounded catalog over the public region registry. `observed_only` keeps regions with observed scope evidence; `manually_added` selects the built-in Swedish catalog; `prefix` filters by region prefix.",
        querystring: req.regionQuery(config),
        response: { 200: c.collectionEnvelope(c.regionSchema), ...c.standardErrorResponses },
      },
    },
    async (request) => {
      const query = request.query;
      const filters = {
        observedOnly: query.observed_only,
        manuallyAdded: query.manually_added,
        prefix: query.prefix,
      };
      return paginated(
        repository.listRegions(
          pageRequest("regions", { ...query, sort: "region", order: "asc" }, filters),
        ),
        "regions",
        { sort: "region", order: "asc", ...query },
        filters,
      );
    },
  );
  app.get<{ Params: z.output<typeof req.regionParams> }>(
    "/v1/meshcore/regions/:region",
    {
      schema: {
        tags: ["MeshCore Regions"],
        summary: "Get a logical MeshCore region",
        params: req.regionParams,
        response: { 200: c.dataEnvelope(c.regionSchema), ...c.standardErrorResponses },
      },
    },
    async (request) => {
      return { data: await required(repository.getRegion(request.params.region), "Region") };
    },
  );
  app.get<{
    Params: z.output<typeof req.regionParams>;
    Querystring: req.PageQuery;
  }>(
    "/v1/meshcore/regions/:region/nodes",
    {
      schema: {
        tags: ["MeshCore Regions"],
        summary: "List nodes reported in a logical region",
        params: req.regionParams,
        querystring: req.pageQuery(config),
        response: { 200: c.collectionEnvelope(c.nodeSchema), ...c.standardErrorResponses },
      },
    },
    async (request) => {
      await required(repository.getRegion(request.params.region), "Region");
      const query = request.query;
      const binding = { region: request.params.region };
      return paginated(
        repository.listRegionNodes(
          request.params.region,
          pageRequest("region-nodes", query, {}, binding),
        ),
        "region-nodes",
        query,
        binding,
      );
    },
  );
}

function registerPacketRoutes(
  app: ZodFastifyInstance,
  repository: MeshcoreRepository,
  config: AppConfig,
) {
  app.get<{ Querystring: req.PacketQuery }>(
    "/v1/meshcore/packets",
    {
      schema: {
        tags: ["MeshCore Packets"],
        summary: "Search packets",
        description:
          "Returns MeshCore packet bytes as deterministic `0x` hex; no private MQTT receipt metadata is exposed.",
        querystring: req.packetQuery(config),
        response: { 200: c.collectionEnvelope(c.packetSchema), ...c.standardErrorResponses },
      },
    },
    async (request) => {
      const query = request.query;
      const filters = {
        hash: query.hash,
        logicalId: query.logical_id,
        packetType: query.packet_type,
        payloadType: query.payload_type,
        routeType: query.route_type,
        decodeStatus: query.decode_status,
        node: query.node,
        observer: query.observer,
        iata: query.iata,
        receivedFrom: query.received_from,
        receivedTo: query.received_to,
      };
      return paginated(
        repository.listPackets(pageRequest("packets", query, filters)),
        "packets",
        query,
        filters,
      );
    },
  );
  app.get<{ Params: z.output<typeof req.hashParams> }>(
    "/v1/meshcore/packets/:sha256",
    detailSchema(
      "MeshCore Packets",
      "Get packet detail including raw MeshCore bytes",
      req.hashParams,
      c.packetSchema,
    ),
    async (request) => {
      return { data: await required(repository.getPacket(request.params.sha256), "Packet") };
    },
  );
  app.get<{ Params: z.output<typeof req.hashParams>; Querystring: req.PageQuery }>(
    "/v1/meshcore/packets/:sha256/observations",
    {
      schema: {
        tags: ["MeshCore Packets"],
        summary: "List public RF observations for a packet",
        description:
          "Includes observer, IATA, signal and decoded path only; private MQTT envelope fields are excluded.",
        params: req.hashParams,
        querystring: req.pageQuery(config),
        response: {
          200: c.collectionEnvelope(c.packetObservationSchema),
          ...c.standardErrorResponses,
        },
      },
    },
    async (request) => {
      await required(repository.getPacket(request.params.sha256), "Packet");
      const query = request.query;
      const binding = { sha256: request.params.sha256 };
      return paginated(
        repository.listPacketObservations(
          request.params.sha256,
          pageRequest("packet-observations", query, {}, binding),
        ),
        "packet-observations",
        query,
        binding,
      );
    },
  );
}

function registerProtocolRoutes(
  app: ZodFastifyInstance,
  repository: MeshcoreRepository,
  config: AppConfig,
) {
  app.get<{ Querystring: req.MessageQuery }>(
    "/v1/meshcore/messages",
    {
      schema: {
        tags: ["MeshCore Messages"],
        summary: "Search public messages",
        description: `Always bounded: configured default ${config.messageDefaultLimit}, configured maximum ${config.messageMaxLimit}, with stateless keyset cursors.`,
        querystring: req.messageQuery(config),
        response: { 200: c.collectionEnvelope(c.messageSchema), ...c.standardErrorResponses },
      },
    },
    async (request) => {
      const query = request.query;
      const filters = {
        sender: query.sender,
        destination: query.destination,
        channel: query.channel,
        channelName: query.channel_name,
        messageType: query.message_type,
        encrypted: query.encrypted,
        signatureValid: query.signature_valid,
        iata: query.iata,
        receivedFrom: query.received_from,
        receivedTo: query.received_to,
      };
      return paginated(
        repository.listMessages(pageRequest("messages", query, filters)),
        "messages",
        query,
        filters,
      );
    },
  );
  app.get<{ Params: z.output<typeof req.messageIdParams> }>(
    "/v1/meshcore/messages/:id",
    {
      schema: {
        tags: ["MeshCore Messages"],
        summary: "Get a logical public message",
        params: req.messageIdParams,
        response: {
          200: c.dataEnvelope(c.messageSchema),
          ...c.standardErrorResponses,
        },
      },
    },
    async (request) => {
      return { data: await required(repository.getMessage(request.params.id), "Message") };
    },
  );

  app.get<{ Querystring: req.TelemetryQuery }>(
    "/v1/meshcore/telemetry",
    {
      schema: {
        tags: ["MeshCore Telemetry"],
        summary: "Search typed telemetry values",
        querystring: req.telemetryQuery(config),
        response: {
          200: c.collectionEnvelope(c.telemetrySchema),
          ...c.standardErrorResponses,
        },
      },
    },
    async (request) => {
      const query = request.query;
      const filters = {
        node: query.node,
        metric: query.metric,
        iata: query.iata,
        receivedFrom: query.received_from,
        receivedTo: query.received_to,
      };
      return paginated(
        repository.listTelemetry(pageRequest("telemetry", query, filters)),
        "telemetry",
        query,
        filters,
      );
    },
  );
  app.get<{ Params: z.output<typeof req.idParams> }>(
    "/v1/meshcore/telemetry/:id",
    detailSchema("MeshCore Telemetry", "Get a telemetry value", req.idParams, c.telemetrySchema),
    async (request) => {
      return { data: await required(repository.getTelemetry(request.params.id), "Telemetry") };
    },
  );

  app.get<{ Querystring: req.TraceQuery }>(
    "/v1/meshcore/traces",
    {
      schema: {
        tags: ["MeshCore Traces"],
        summary: "Search trace events",
        querystring: req.traceQuery(config),
        response: { 200: c.collectionEnvelope(c.traceSchema), ...c.standardErrorResponses },
      },
    },
    async (request) => {
      const query = request.query;
      const filters = {
        sourceNode: query.source_node,
        tag: query.tag,
        iata: query.iata,
        receivedFrom: query.received_from,
        receivedTo: query.received_to,
      };
      return paginated(
        repository.listTraces(pageRequest("traces", query, filters)),
        "traces",
        query,
        filters,
      );
    },
  );
  app.get<{ Params: z.output<typeof req.idParams> }>(
    "/v1/meshcore/traces/:id",
    detailSchema("MeshCore Traces", "Get a trace event", req.idParams, c.traceSchema),
    async (request) => {
      return { data: await required(repository.getTrace(request.params.id), "Trace") };
    },
  );
  app.get<{ Params: z.output<typeof req.idParams> }>(
    "/v1/meshcore/traces/:id/hops",
    {
      schema: {
        tags: ["MeshCore Traces"],
        summary: "List ordered trace hops",
        description:
          "Preserves resolved, unresolved, and ambiguous prefix candidates with confidence.",
        params: req.idParams,
        response: {
          200: c.dataEnvelope(z.array(c.traceHopSchema)),
          ...c.standardErrorResponses,
        },
      },
    },
    async (request) => {
      await required(repository.getTrace(request.params.id), "Trace");
      return { data: await repository.listTraceHops(request.params.id) };
    },
  );
}

function registerStatisticsRoutes(app: ZodFastifyInstance, repository: MeshcoreRepository) {
  app.get(
    "/v1/meshcore/stats",
    {
      schema: {
        tags: ["MeshCore Statistics"],
        summary: "Get current network statistics",
        description:
          "Active nodes, IATA, packets and logical messages use the trailing 24-hour window. Active observers have accepted ingest within the configured recent-activity window.",
        response: {
          200: c.dataEnvelope(c.statsSchema),
          ...c.standardErrorResponses,
        },
      },
    },
    async () => ({ data: await repository.getStats() }),
  );
  app.get<{ Querystring: req.ActivityQuery }>(
    "/v1/meshcore/activity",
    {
      schema: {
        tags: ["MeshCore Statistics"],
        summary: "Get bounded activity time series",
        description:
          "Allowlisted windows and intervals with an optional geographic IATA filter. There is no region filter because per-observation region attribution evidence does not exist in the current data model.",
        querystring: req.activityQuery(),
        response: {
          200: c.dataEnvelope(z.array(c.activityBucketSchema)),
          ...c.standardErrorResponses,
        },
      },
    },
    async (request) => {
      const query = request.query;
      const windowMs = req.ACTIVITY_WINDOWS[query.window];
      const intervalMs = req.ACTIVITY_INTERVALS[query.interval];
      if (intervalMs > windowMs || windowMs / intervalMs > 500)
        throw new ApiError(
          422,
          "INVALID_ARGUMENT",
          "The interval is not valid for the selected window.",
        );
      const toMs = Date.now();
      return {
        data: await repository.getActivity({
          fromMs: toMs - windowMs,
          toMs,
          intervalMs,
          iata: query.iata,
        }),
      };
    },
  );
}

function sourceDescription() {
  return {
    id: "meshcore",
    name: "MeshCore",
    description: "Information om MeshCore-nätverket i Sverige",
    status: "available",
    api_version: "v1",
    url: "/v1/meshcore",
    documentation_url: "/v1/docs",
    data_availability: {
      telemetry: {
        status: "limited",
        description:
          "Telemetry is exposed when observers provide decodable MeshCore protocol telemetry; encrypted response payloads cannot currently be normalized.",
      },
    },
    capabilities: [
      "nodes",
      "observers",
      "neighbors",
      "regions",
      "iata",
      "packets",
      "messages",
      "telemetry",
      "traces",
      "statistics",
    ],
  };
}

function pageRequest<T extends object>(
  resource: string,
  query: { sort?: string; order?: SortOrder; limit: number; cursor?: string },
  filters: T,
  binding: unknown = filters,
): ListRequest<T> {
  const sort = query.sort ?? "received_at";
  const order = query.order ?? "desc";
  return {
    filters,
    sort,
    order,
    limit: query.limit,
    after: decodeCursor(query.cursor, resource, {
      filters: binding,
      sort,
      order,
    }),
  };
}

async function paginated<T>(
  promise: Promise<Page<T>>,
  resource: string,
  query: { sort?: string; order?: SortOrder; limit: number },
  binding: unknown,
): Promise<{
  data: T[];
  pagination: {
    limit: number;
    has_more: boolean;
    next_cursor: string | null;
  };
}> {
  const result = await promise;
  const sort = query.sort ?? "received_at";
  const order = query.order ?? "desc";
  return {
    data: result.items,
    pagination: {
      limit: query.limit,
      has_more: result.hasMore,
      next_cursor: result.nextKey
        ? encodeCursor(resource, { filters: binding, sort, order }, result.nextKey)
        : null,
    },
  };
}

async function required<T>(promise: Promise<T | null>, resource: string): Promise<T> {
  const value = await promise;
  if (value === null) throw notFound(resource);
  return value;
}

/** Extract a ZodError from provider validation failures at either level. */
function extractZodError(error: Error): ZodError | undefined {
  if (error instanceof ZodError) return error;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof ZodError) return cause;
  return undefined;
}

function formatZodIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    .join("; ");
}

function normalizeError(error: Error & { statusCode?: number; code?: string }): ApiError {
  if ((hasZodFastifySchemaValidationErrors as unknown as (candidate: unknown) => boolean)(error)) {
    // Cross-field refinements (geo trio, inverted ranges, unconfigured IATA
    // transforms) carry code "custom" and were 422 under the previous
    // parse()-based flow; structural request errors were 400.
    const validation = (
      error as unknown as {
        validation: Array<{ keyword: string; instancePath: string; message: string }>;
      }
    ).validation;
    const hasRefinement = validation.some((entry) => entry.keyword === "custom");
    const message = validation
      .map((entry) => `${entry.instancePath.replaceAll("/", ".") || "request"}: ${entry.message}`)
      .join("; ");
    return new ApiError(hasRefinement ? 422 : 400, "INVALID_ARGUMENT", message);
  }
  const zodError = extractZodError(error);
  if (zodError) {
    const hasRefinement = zodError.issues.some((issue) => issue.code === "custom");
    return new ApiError(hasRefinement ? 422 : 400, "INVALID_ARGUMENT", formatZodIssues(zodError));
  }
  if (error instanceof ApiError) return error;
  if (error.statusCode === 429) return new ApiError(429, "RATE_LIMIT_EXCEEDED", error.message);
  if (error.statusCode && error.statusCode < 500)
    return new ApiError(error.statusCode, "INVALID_ARGUMENT", error.message);
  if (error.code && (/^[0-9A-Z]{5}$/.test(error.code) || error.code.startsWith("ECONN")))
    return new ApiError(503, "DATABASE_UNAVAILABLE", "Database is unavailable.");
  return new ApiError(500, "INTERNAL_ERROR", "Internal server error.");
}

if (process.env.NODE_ENV !== "test") {
  const runtimeConfig = loadConfig();
  const app = await buildServer({ config: runtimeConfig });
  const close = async () => {
    await app.close();
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  await app.listen({ host: runtimeConfig.host, port: runtimeConfig.port });
}
