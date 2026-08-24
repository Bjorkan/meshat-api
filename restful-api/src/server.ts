import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z, ZodError } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadConfig, type AppConfig } from "./config.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type { ListRequest, MeshcoreRepository, Page, SortOrder } from "./domain.js";
import { GitDocumentationService, type DocumentationService } from "./docs.js";
import { ApiError, notFound } from "./errors.js";
import { getIata, iataEntries } from "./iata.js";
import { normalizeRegionScope } from "./region-scopes.js";
import { aggregateNeighbors } from "./mappers.js";
import { PostgresMeshcoreRepository, type DatabasePool } from "./repository.js";

type BuildOptions = {
  config?: AppConfig;
  repository?: MeshcoreRepository;
  pool?: DatabasePool;
  docs?: DocumentationService;
  refreshDocs?: boolean;
  logger?: boolean;
};

const publicKeySchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/)
  .transform((value) => value.toUpperCase());
const hashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase());
const logicalIdSchema = z
  .string()
  .regex(/^lp_[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase());
const idSchema = z.string().regex(/^\d+$/);
const messageIdSchema = z
  .string()
  .regex(/^lp_[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase());
const iataSchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());
const iataFilterSchema = iataSchema.transform((code, context) => {
  const entry = getIata(code);
  if (!entry) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "IATA code is not configured",
    });
    return z.NEVER;
  }
  return entry.primary_code;
});
const regionSchema = z.string().trim().min(1).max(100).transform(normalizeRegionScope);
const booleanSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");
const dateSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => Date.parse(value));
const limitSchema = (fallback: number, maximum: number) =>
  z.coerce.number().int().min(1).max(maximum).default(fallback);
const cursorSchema = z.string().min(1).max(4096).optional();
const orderSchema = z.enum(["asc", "desc"]).default("desc");

const paginationProperties = {
  limit: { type: "integer", description: "Applied bounded page size." },
  has_more: { type: "boolean", description: "Whether another page exists." },
  next_cursor: {
    type: ["string", "null"],
    description: "Opaque stateless continuation cursor bound to this query.",
  },
};
const collectionResponse = (item: Record<string, unknown> = {}) => ({
  type: "object",
  description: "Successful bounded collection response.",
  example: {
    data: [],
    pagination: { limit: 50, has_more: false, next_cursor: null },
  },
  required: ["data", "pagination"],
  properties: {
    data: {
      type: "array",
      items:
        item.type === "object" && item.properties === undefined
          ? { ...item, additionalProperties: true }
          : Object.keys(item).length
            ? item
            : { type: "object", additionalProperties: true },
    },
    pagination: { type: "object", properties: paginationProperties },
  },
});
const dataResponse = (data: Record<string, unknown> = {}) => ({
  type: "object",
  description: "Successful domain response envelope.",
  example: { data: {} },
  required: ["data"],
  properties: {
    data:
      data.type === "object" && data.properties === undefined
        ? { ...data, additionalProperties: true }
        : data.type === "array" &&
            typeof data.items === "object" &&
            data.items !== null &&
            !("properties" in data.items)
          ? { ...data, items: { ...data.items, additionalProperties: true } }
          : data,
  },
});
const errorResponse = {
  type: "object",
  description: "Stable public error envelope. The request ID can be used for log correlation.",
  example: {
    error: {
      code: "INVALID_ARGUMENT",
      message: "A request argument is invalid.",
      request_id: "01JEXAMPLE00000000000000000",
    },
  },
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "request_id"],
      properties: {
        code: { type: "string", example: "INVALID_ARGUMENT" },
        message: { type: "string" },
        request_id: { type: "string" },
      },
    },
  },
};
const standardErrors = {
  400: errorResponse,
  404: errorResponse,
  422: errorResponse,
  429: errorResponse,
  500: errorResponse,
  503: errorResponse,
};

const nodeSchema = {
  type: "object",
  description:
    "Normalized MeshCore node. IATA ingress areas and logical MeshCore regions are separate arrays.",
  properties: {
    public_key: { type: "string", pattern: "^[0-9A-Fa-f]{64}$" },
    owner_public_key: { type: ["string", "null"] },
    name: { type: ["string", "null"] },
    role: {
      type: ["string", "null"],
      description: "Lowercase MeshCore domain role.",
    },
    location: {
      type: ["object", "null"],
      properties: {
        latitude: { type: "number" },
        longitude: { type: "number" },
      },
    },
    first_seen: { type: "string", format: "date-time" },
    last_seen: { type: "string", format: "date-time" },
    iata: { type: "array", items: { type: "string" } },
    regions: { type: "array", items: { type: "string" } },
  },
};
const observerSchema = {
  type: "object",
  description:
    "MQTT observer with location inherited from its same-key node. Active means recent accepted ingest within the configured activity window.",
  properties: {
    public_key: { type: "string" },
    name: {},
    active: { type: "boolean" },
    iata: { type: ["string", "null"] },
    regions: { type: "array", items: { type: "string" } },
    location: nodeSchema.properties.location,
    first_seen: { type: "string", format: "date-time" },
    last_seen: { type: "string", format: "date-time" },
  },
};
const packetSchema = {
  type: "object",
  description: "Packet identity; `raw` is MeshCore bytes, never an MQTT receipt.",
  properties: {
    sha256: { type: "string" },
    logical_id: {},
    packet_type: {},
    payload_type: {},
    route_type: {},
    decode_status: { type: "string" },
    raw: { type: "string", pattern: "^0x[0-9a-f]*$" },
    first_seen: { type: "string", format: "date-time" },
    last_seen: { type: "string", format: "date-time" },
  },
};
const messageSchema = {
  type: "object",
  description: "One logical MeshCore message aggregated across all matching RF observations.",
  properties: {
    id: { type: "string", pattern: "^lp_[0-9a-f]{64}$" },
    representative_packet_sha256: {
      type: "string",
      pattern: "^[0-9a-f]{64}$",
      description:
        "Packet of the latest matching RF observation; a logical message can have several packet variants.",
    },
    type: { type: "string" },
    channel: {},
    channel_index: {},
    channel_name: {},
    sender: {},
    destination: {},
    encrypted: { type: "boolean" },
    text: {},
    signature_valid: {},
    iata: {
      type: "array",
      items: { type: "string" },
      description: "Canonical IATA evidence across every observation of this logical message.",
    },
    observation_count: {
      type: "integer",
      minimum: 1,
      description: "Total observation count for the logical message across all filters.",
    },
    matched: {
      type: "object",
      description:
        "Query-scope evidence for this result; only these fields vary with the search filters.",
      properties: {
        iata: { type: "array", items: { type: "string" } },
        observation_count: { type: "integer", minimum: 1 },
      },
    },
    reported_at: {},
    first_received_at: { type: "string", format: "date-time" },
    last_received_at: { type: "string", format: "date-time" },
  },
};
const telemetrySchema = {
  type: "object",
  description:
    "Decoded MeshCore protocol telemetry. Data is limited because encrypted response payloads cannot currently be normalized.",
  properties: {
    id: { type: "string" },
    packet_sha256: { type: "string" },
    node: {},
    metric: { type: "string" },
    value: {
      type: "object",
      properties: {
        type: { enum: ["number", "string", "boolean"] },
        value: {},
      },
    },
    unit: {},
    channel: {},
    iata: {},
    reported_at: {},
    received_at: { type: "string", format: "date-time" },
  },
};
const traceSchema = {
  type: "object",
  description:
    "One observation-level trace event. `observer` identifies the reporting observer and `logical_id` groups the packet variants of the same logical transmission.",
  properties: {
    id: { type: "string" },
    packet_sha256: { type: "string" },
    logical_id: { type: ["string", "null"] },
    source_node: {},
    observer: { type: ["string", "null"] },
    tag: {},
    iata: {},
    reported_at: {},
    received_at: { type: "string", format: "date-time" },
  },
};
const regionResponseSchema = {
  type: "object",
  description:
    "Logical MeshCore region from the public region registry, distinct from IATA. `region` is the canonical lowercase scope; `name` is the administrative name or the scope itself when none is registered.",
  properties: {
    region: { type: "string" },
    name: { type: "string" },
    first_seen: { type: ["string", "null"], format: "date-time" },
    last_seen: { type: ["string", "null"], format: "date-time" },
    manually_added: { type: "boolean" },
    observation_count: { type: "integer", minimum: 0 },
    node_count: { type: "integer", minimum: 0 },
    observer_count: { type: "integer", minimum: 0 },
    last_activity: { type: ["string", "null"], format: "date-time" },
    links: { type: "object", additionalProperties: { type: "string" } },
  },
};
const iataResponseSchema = {
  type: "object",
  description: "Configured geographic MQTT ingress mapping.",
  properties: {
    code: { type: "string" },
    name: {},
    type: { enum: ["primary", "secondary"] },
    primary_code: { type: "string" },
    summary: { type: "object", additionalProperties: true },
    links: { type: "object", additionalProperties: { type: "string" } },
  },
};
const neighborSchema = {
  type: "object",
  properties: {
    public_key: { type: "string" },
    node: { type: "object", additionalProperties: true },
    relationship: { enum: ["reported", "reciprocal"] },
    direction: { enum: ["outbound", "inbound", "both"] },
    last_heard: {},
    signal: { type: "object", additionalProperties: true },
    regions: { type: "array", items: { type: "string" } },
    evidence: { type: "object", additionalProperties: true },
  },
};
const advertSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    node: { type: "string" },
    packet_sha256: {},
    advert_timestamp: {},
    observed_at: { type: "string", format: "date-time" },
    name: {},
    role: { description: "Lowercase MeshCore domain role." },
    location: nodeSchema.properties.location,
    flags: {},
    signature_valid: {},
    verified: { type: "boolean" },
    verification_error: {},
  },
};
const sightingSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    node: { type: "string" },
    observer: { type: "string" },
    iata: { type: "string" },
    type: { type: "string" },
    received_at: { type: "string", format: "date-time" },
  },
};
const metricSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    observer: { type: "string" },
    metric: { type: "string" },
    value: telemetrySchema.properties.value,
    unit: {},
    reported_at: {},
    received_at: { type: "string", format: "date-time" },
  },
};
const observerStatusSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    observer: { type: "string" },
    iata: { type: "string" },
    reported_at: { type: ["string", "null"], format: "date-time" },
    received_at: { type: "string", format: "date-time" },
    origin: { type: ["string", "null"] },
    model: { type: ["string", "null"] },
    firmware_version: { type: ["string", "null"] },
  },
};
const packetObservationSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    packet_sha256: { type: "string" },
    observer: { type: "string" },
    iata: { type: "string" },
    received_at: { type: "string", format: "date-time" },
    reported_at: {},
    signal: { type: "object", properties: { rssi: {}, snr: {}, score: {} } },
    direction: {},
    path: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          prefix_hex: { type: "string" },
          prefix_length_bytes: { type: "integer" },
          resolved_node: {},
          resolution_status: { type: "string" },
          resolution_confidence: {},
        },
      },
    },
  },
};
const docFileSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path", "title", "media_type", "size"],
  properties: {
    path: { type: "string" },
    title: { type: ["string", "null"] },
    media_type: { enum: ["text/markdown", "application/yaml"] },
    size: { type: "integer" },
  },
};
const docsMetadataProperties = {
  repository: { type: "string", format: "uri" },
  ref: { type: ["string", "null"] },
  commit: { type: ["string", "null"] },
  status: { enum: ["fresh", "stale", "unavailable"] },
};

export async function buildServer(options: BuildOptions = {}) {
  const config = options.config ?? loadConfig();
  const ownedPool = !options.repository;
  if (!options.repository && !config.database.password) {
    throw new Error("DATABASE_PASSWORD is required when creating the PostgreSQL pool");
  }
  const pool = options.pool ?? (options.repository ? undefined : new Pool(config.database));
  const repository =
    options.repository ?? new PostgresMeshcoreRepository(pool!, config.observerActiveWindowMs);
  const docs = options.docs ?? new GitDocumentationService(config.docs);
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: true,
        useDefaults: true,
      },
    },
    genReqId: (request) => request.headers["x-request-id"]?.toString() || randomUUID(),
  });
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
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((error, request, reply) => {
    const apiError = normalizeError(error as Error & { statusCode?: number; validation?: unknown });
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

  if (ownedPool && pool) app.addHook("onClose", async () => pool.end());
  registerSystemRoutes(app, repository, docs, config);
  registerDiscoveryRoutes(app);
  registerDocsRoutes(app, docs);
  registerNodeRoutes(app, repository, config);
  registerObserverRoutes(app, repository, config);
  registerGeographyRoutes(app, repository, config);
  registerPacketRoutes(app, repository, config);
  registerProtocolRoutes(app, repository, config);
  registerStatisticsRoutes(app, repository);

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
  return app;
}

function registerSystemRoutes(
  app: FastifyInstance,
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
        response: { 200: dataResponse({ type: "object" }) },
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
        response: { 200: dataResponse({ type: "object" }) },
      },
    },
    () => ({ data: { status: "ok" } }),
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
          200: dataResponse({
            type: "object",
            properties: {
              status: { enum: ["ready"] },
              database: { enum: ["ready"] },
              docs: { enum: ["fresh", "stale", "unavailable"] },
              release_id: { type: "string" },
              schema_version: { type: "integer" },
              schema_hash: { type: "string" },
            },
            required: ["status", "database", "docs", "release_id", "schema_version", "schema_hash"],
          }),
          503: errorResponse,
        },
      },
    },
    async (request, reply) => {
      try {
        const metadata = await repository.health();
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
      } catch {
        return reply.code(503).send({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable.",
            request_id: request.id,
          },
        });
      }
    },
  );
  app.get(
    "/openapi.json",
    {
      schema: {
        tags: ["System"],
        summary: "Get the public OpenAPI document",
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            description: "The complete public OpenAPI 3 document.",
            example: {
              openapi: "3.0.3",
              info: { title: "Meshat.se REST API", version: "1.0.0" },
              paths: {},
            },
          },
        },
      },
    },
    () => app.swagger(),
  );
}

function registerDiscoveryRoutes(app: FastifyInstance) {
  app.get(
    "/v1/sources",
    {
      schema: {
        tags: ["Sources"],
        summary: "List available network sources",
        response: {
          200: dataResponse({
            type: "array",
            items: { type: "object", additionalProperties: true },
          }),
        },
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
        response: { 200: dataResponse({ type: "object" }) },
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

function registerDocsRoutes(app: FastifyInstance, docs: DocumentationService) {
  app.get(
    "/v1/docs",
    {
      schema: {
        tags: ["Documentation"],
        summary: "List the recursively indexed documentation subtree",
        description: "Returns metadata and sorted file entries, not every file's content.",
        response: {
          200: dataResponse({
            type: "object",
            additionalProperties: false,
            required: ["repository", "ref", "commit", "status", "files"],
            properties: {
              ...docsMetadataProperties,
              files: { type: "array", items: docFileSchema },
            },
          }),
          503: errorResponse,
        },
      },
    },
    async () => ({ data: { ...docs.metadata(), files: await docs.index() } }),
  );
  const docsSearchQuery = z
    .object({
      q: z.string().trim().min(1).max(200),
      limit: limitSchema(20, 50),
    })
    .strict();
  app.get<{ Querystring: unknown }>(
    "/v1/docs/search",
    {
      schema: {
        tags: ["Documentation"],
        summary: "Search documentation text",
        description:
          "Bounded case-insensitive search over sorted public documentation candidates. The response reports whether all candidates were scanned and never uses a cursor.",
        querystring: documentedSchema(docsSearchQuery),
        response: {
          200: dataResponse({
            type: "object",
            additionalProperties: false,
            required: [
              "query",
              "limit",
              "returned",
              "total_matches",
              "scan_complete",
              "truncated",
              "results",
            ],
            properties: {
              query: { type: "string" },
              limit: { type: "integer" },
              returned: { type: "integer" },
              total_matches: { type: "integer" },
              scan_complete: { type: "boolean" },
              truncated: { type: "boolean" },
              results: {
                type: "array",
                items: {
                  ...docFileSchema,
                  required: [...docFileSchema.required, "snippet"],
                  properties: {
                    ...docFileSchema.properties,
                    snippet: { type: "string" },
                  },
                },
              },
            },
          }),
          ...standardErrors,
        },
      },
    },
    async (request) => {
      const query = parse(docsSearchQuery, request.query);
      return { data: await docs.search(query.q, query.limit) };
    },
  );
  app.get<{ Params: { "*": string } }>(
    "/v1/docs/*",
    {
      schema: {
        tags: ["Documentation"],
        summary: "Get one documentation file",
        description:
          "Returns UTF-8 text only for Markdown files or exactly `meshtastic/example.yaml`. Other assets are not found; traversal, `.git`, symlink escapes, and oversized files are rejected.",
        params: {
          type: "object",
          required: ["*"],
          properties: { "*": { type: "string", minLength: 1 } },
        },
        response: {
          200: dataResponse({
            type: "object",
            properties: {
              path: { type: "string" },
              media_type: { enum: ["text/markdown", "application/yaml"] },
              content: { type: "string" },
              encoding: { const: "utf-8" },
              source: {
                type: "object",
                additionalProperties: false,
                required: ["repository", "ref", "commit"],
                properties: {
                  repository: docsMetadataProperties.repository,
                  ref: docsMetadataProperties.ref,
                  commit: docsMetadataProperties.commit,
                },
              },
            },
            required: ["path", "media_type", "content", "encoding", "source"],
            additionalProperties: false,
          }),
          ...standardErrors,
          413: errorResponse,
          503: errorResponse,
        },
      },
    },
    async (request) => ({ data: await docs.get(request.params["*"]) }),
  );
}

function registerNodeRoutes(
  app: FastifyInstance,
  repository: MeshcoreRepository,
  config: AppConfig,
) {
  function nodeQuery(config: AppConfig) {
    return z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        role: z.string().trim().min(1).max(50).optional(),
        region: regionSchema.optional(),
        iata: iataFilterSchema.optional(),
        seen_from: dateSchema.optional(),
        seen_to: dateSchema.optional(),
        near_lat: z.coerce.number().min(-90).max(90).optional(),
        near_lon: z.coerce.number().min(-180).max(180).optional(),
        radius_km: z.coerce.number().positive().max(1000).optional(),
        sort: z.enum(["last_seen", "first_seen", "name", "role"]).default("last_seen"),
        order: orderSchema,
        limit: limitSchema(config.defaultLimit, config.maxLimit),
        cursor: cursorSchema,
      })
      .strict()
      .superRefine(validateGeo)
      .superRefine(validateSeenRange);
  }
  app.get<{ Querystring: unknown }>(
    "/v1/meshcore/nodes",
    {
      schema: {
        tags: ["MeshCore Nodes"],
        summary: "Search nodes",
        description:
          "Controlled filters with query-bound keyset pagination. `region` is a logical neighbor scope; `iata` is geographic ingress.",
        querystring: documentedSchema(nodeQuery(config)),
        response: { 200: collectionResponse(nodeSchema), ...standardErrors },
      },
    },
    async (request) => {
      const query = parse(nodeQuery(config), request.query);
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
  app.get<{ Params: unknown }>(
    "/v1/meshcore/nodes/:public_key",
    detailSchema("MeshCore Nodes", "Get a node", "public_key", nodeSchema),
    async (request) => {
      const { public_key } = parse(z.object({ public_key: publicKeySchema }), request.params);
      return { data: await required(repository.getNode(public_key), "Node") };
    },
  );
  app.get<{ Params: unknown }>(
    "/v1/meshcore/nodes/:public_key/neighbors",
    {
      schema: {
        tags: ["MeshCore Neighbors"],
        summary: "Get aggregated current neighbor relationships",
        description:
          "Uses only each observer's latest snapshot. `reciprocal` requires direct and reverse reports; direction is outbound, inbound, or both.",
        params: publicKeyParams(),
        response: {
          200: dataResponse({ type: "array", items: neighborSchema }),
          ...standardErrors,
        },
      },
    },
    async (request) => {
      const { public_key } = parse(z.object({ public_key: publicKeySchema }), request.params);
      await required(repository.getNode(public_key), "Node");
      return {
        data: aggregateNeighbors(
          (await repository.getNeighborEvidence(public_key)) as Record<string, unknown>[],
        ),
      };
    },
  );
  registerNodeHistory(app, repository, config, "adverts", (key, page) =>
    repository.listNodeAdverts(key, page),
  );
  registerNodeHistory(app, repository, config, "sightings", (key, page) =>
    repository.listNodeSightings(key, page),
  );
  registerNodeHistory(app, repository, config, "telemetry", (key, page) =>
    repository.listNodeTelemetry(key, page),
  );
}

function registerNodeHistory(
  app: FastifyInstance,
  repository: MeshcoreRepository,
  config: AppConfig,
  segment: string,
  loader: (key: string, request: ListRequest<object>) => Promise<Page<unknown>>,
) {
  app.get<{ Params: unknown; Querystring: unknown }>(
    `/v1/meshcore/nodes/:public_key/${segment}`,
    {
      schema: {
        tags: ["MeshCore Nodes"],
        summary: `List node ${segment}`,
        params: publicKeyParams(),
        querystring: documentedSchema(pageQuery(config)),
        response: {
          200: collectionResponse(
            segment === "adverts"
              ? advertSchema
              : segment === "sightings"
                ? sightingSchema
                : telemetrySchema,
          ),
          ...standardErrors,
        },
      },
    },
    async (request) => {
      const { public_key } = parse(z.object({ public_key: publicKeySchema }), request.params);
      const query = parse(pageQuery(config), request.query);
      await required(repository.getNode(public_key), "Node");
      const filters = { public_key };
      const resource = `node-${segment}`;
      const pageRequestValue = pageRequest(resource, query, {}, filters);
      return paginated(loader(public_key, pageRequestValue), resource, query, filters);
    },
  );
}

function registerObserverRoutes(
  app: FastifyInstance,
  repository: MeshcoreRepository,
  config: AppConfig,
) {
  function observerQuery(config: AppConfig) {
    return z
      .object({
        active: booleanSchema.optional(),
        name: z.string().trim().min(1).max(100).optional(),
        iata: iataFilterSchema.optional(),
        region: regionSchema.optional(),
        seen_from: dateSchema.optional(),
        seen_to: dateSchema.optional(),
        near_lat: z.coerce.number().min(-90).max(90).optional(),
        near_lon: z.coerce.number().min(-180).max(180).optional(),
        radius_km: z.coerce.number().positive().max(1000).optional(),
        sort: z.enum(["last_seen", "first_seen", "name"]).default("last_seen"),
        order: orderSchema,
        limit: limitSchema(config.defaultLimit, config.maxLimit),
        cursor: cursorSchema,
      })
      .strict()
      .superRefine(validateGeo)
      .superRefine(validateSeenRange);
  }
  app.get<{ Querystring: unknown }>(
    "/v1/meshcore/observers",
    {
      schema: {
        tags: ["MeshCore Observers"],
        summary: "Search reporting observers",
        description:
          "Observer location and geographic radius filters use the same-public-key node's verified latitude/longitude.",
        querystring: documentedSchema(observerQuery(config)),
        response: {
          200: collectionResponse(observerSchema),
          ...standardErrors,
        },
      },
    },
    async (request) => {
      const query = parse(observerQuery(config), request.query);
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
  app.get<{ Params: unknown }>(
    "/v1/meshcore/observers/:public_key",
    detailSchema("MeshCore Observers", "Get an observer", "public_key", observerSchema),
    async (request) => {
      const { public_key } = parse(z.object({ public_key: publicKeySchema }), request.params);
      return {
        data: await required(repository.getObserver(public_key), "Observer"),
      };
    },
  );
  app.get<{ Params: unknown }>(
    "/v1/meshcore/observers/:public_key/status",
    detailSchema(
      "MeshCore Observers",
      "Get latest observer status",
      "public_key",
      observerStatusSchema,
    ),
    async (request) => {
      const { public_key } = parse(z.object({ public_key: publicKeySchema }), request.params);
      await required(repository.getObserver(public_key), "Observer");
      return {
        data: await required(repository.getObserverStatus(public_key), "Observer status"),
      };
    },
  );
  app.get<{ Params: unknown; Querystring: unknown }>(
    "/v1/meshcore/observers/:public_key/metrics",
    {
      schema: {
        tags: ["MeshCore Observers"],
        summary: "List observer metrics history",
        params: publicKeyParams(),
        querystring: documentedSchema(pageQuery(config)),
        response: { 200: collectionResponse(metricSchema), ...standardErrors },
      },
    },
    async (request) => {
      const { public_key } = parse(z.object({ public_key: publicKeySchema }), request.params);
      const query = parse(pageQuery(config), request.query);
      await required(repository.getObserver(public_key), "Observer");
      const binding = { public_key };
      return paginated(
        repository.listObserverMetrics(
          public_key,
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
  app: FastifyInstance,
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
        response: {
          200: dataResponse({ type: "array", items: iataResponseSchema }),
        },
      },
    },
    () => ({ data: iataEntries }),
  );
  app.get<{ Params: unknown }>(
    "/v1/meshcore/iata/:code",
    {
      schema: {
        tags: ["MeshCore IATA"],
        summary: "Get IATA mapping and current activity summary",
        params: {
          type: "object",
          required: ["code"],
          properties: { code: { type: "string", pattern: "^[A-Za-z]{3}$" } },
        },
        response: { 200: dataResponse(iataResponseSchema), ...standardErrors },
      },
    },
    async (request) => {
      const { code } = parse(z.object({ code: iataSchema }), request.params);
      const entry = getIata(code);
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
  const regionQuery = z
    .object({
      observed_only: booleanSchema.optional(),
      manually_added: booleanSchema.optional(),
      prefix: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .transform((value) => (value === undefined ? undefined : normalizeRegionScope(value))),
      limit: limitSchema(config.defaultLimit, config.maxLimit),
      cursor: cursorSchema,
    })
    .strict();
  app.get<{ Querystring: unknown }>(
    "/v1/meshcore/regions",
    {
      schema: {
        tags: ["MeshCore Regions"],
        summary: "List logical MeshCore regions",
        description:
          "Bounded catalog over the public region registry. `observed_only` keeps regions with observed scope evidence; `manually_added` selects the built-in Swedish catalog; `prefix` filters by region prefix.",
        querystring: documentedSchema(regionQuery),
        response: {
          200: collectionResponse(regionResponseSchema),
          ...standardErrors,
        },
      },
    },
    async (request) => {
      const query = parse(regionQuery, request.query);
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
  app.get<{ Params: unknown }>(
    "/v1/meshcore/regions/:region",
    {
      schema: {
        tags: ["MeshCore Regions"],
        summary: "Get a logical MeshCore region",
        params: regionParams(),
        response: {
          200: dataResponse(regionResponseSchema),
          ...standardErrors,
        },
      },
    },
    async (request) => {
      const { region } = parse(z.object({ region: regionSchema }), request.params);
      return { data: await required(repository.getRegion(region), "Region") };
    },
  );
  app.get<{ Params: unknown; Querystring: unknown }>(
    "/v1/meshcore/regions/:region/nodes",
    {
      schema: {
        tags: ["MeshCore Regions"],
        summary: "List nodes reported in a logical region",
        params: regionParams(),
        querystring: documentedSchema(pageQuery(config)),
        response: { 200: collectionResponse(nodeSchema), ...standardErrors },
      },
    },
    async (request) => {
      const { region } = parse(z.object({ region: regionSchema }), request.params);
      const query = parse(pageQuery(config), request.query);
      await required(repository.getRegion(region), "Region");
      const binding = { region };
      return paginated(
        repository.listRegionNodes(region, pageRequest("region-nodes", query, {}, binding)),
        "region-nodes",
        query,
        binding,
      );
    },
  );
}

function registerPacketRoutes(
  app: FastifyInstance,
  repository: MeshcoreRepository,
  config: AppConfig,
) {
  const packetQuery = z
    .object({
      hash: hashSchema.optional(),
      logical_id: logicalIdSchema.optional(),
      packet_type: z.string().trim().min(1).max(50).optional(),
      payload_type: z.string().trim().min(1).max(50).optional(),
      route_type: z.string().trim().min(1).max(50).optional(),
      decode_status: z.string().trim().min(1).max(50).optional(),
      node: publicKeySchema.optional(),
      observer: publicKeySchema.optional(),
      iata: iataFilterSchema.optional(),
      received_from: dateSchema.optional(),
      received_to: dateSchema.optional(),
      sort: z.enum(["received_at", "first_seen"]).default("received_at"),
      order: orderSchema,
      limit: limitSchema(config.defaultLimit, config.maxLimit),
      cursor: cursorSchema,
    })
    .strict()
    .superRefine(validateReceivedRange);
  app.get<{ Querystring: unknown }>(
    "/v1/meshcore/packets",
    {
      schema: {
        tags: ["MeshCore Packets"],
        summary: "Search packets",
        description:
          "Returns MeshCore packet bytes as deterministic `0x` hex; no private MQTT receipt metadata is exposed.",
        querystring: documentedSchema(packetQuery),
        response: { 200: collectionResponse(packetSchema), ...standardErrors },
      },
    },
    async (request) => {
      const query = parse(packetQuery, request.query);
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
  app.get<{ Params: unknown }>(
    "/v1/meshcore/packets/:sha256",
    detailSchema(
      "MeshCore Packets",
      "Get packet detail including raw MeshCore bytes",
      "sha256",
      packetSchema,
    ),
    async (request) => {
      const { sha256 } = parse(z.object({ sha256: hashSchema }), request.params);
      return { data: await required(repository.getPacket(sha256), "Packet") };
    },
  );
  app.get<{ Params: unknown; Querystring: unknown }>(
    "/v1/meshcore/packets/:sha256/observations",
    {
      schema: {
        tags: ["MeshCore Packets"],
        summary: "List public RF observations for a packet",
        description:
          "Includes observer, IATA, signal and decoded path only; private MQTT envelope fields are excluded.",
        params: hashParams(),
        querystring: documentedSchema(pageQuery(config)),
        response: {
          200: collectionResponse(packetObservationSchema),
          ...standardErrors,
        },
      },
    },
    async (request) => {
      const { sha256 } = parse(z.object({ sha256: hashSchema }), request.params);
      const query = parse(pageQuery(config), request.query);
      await required(repository.getPacket(sha256), "Packet");
      const binding = { sha256 };
      return paginated(
        repository.listPacketObservations(
          sha256,
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
  app: FastifyInstance,
  repository: MeshcoreRepository,
  config: AppConfig,
) {
  const messageQuery = z
    .object({
      sender: publicKeySchema.optional(),
      destination: publicKeySchema.optional(),
      channel: z.string().max(100).optional(),
      channel_name: z.string().max(100).optional(),
      message_type: z.string().max(50).optional(),
      encrypted: booleanSchema.optional(),
      signature_valid: booleanSchema.optional(),
      iata: iataFilterSchema.optional(),
      received_from: dateSchema.optional(),
      received_to: dateSchema.optional(),
      sort: z.literal("received_at").default("received_at"),
      order: orderSchema,
      limit: limitSchema(config.messageDefaultLimit, config.messageMaxLimit),
      cursor: cursorSchema,
    })
    .strict()
    .superRefine(validateReceivedRange);
  app.get<{ Querystring: unknown }>(
    "/v1/meshcore/messages",
    {
      schema: {
        tags: ["MeshCore Messages"],
        summary: "Search public messages",
        description: `Always bounded: configured default ${config.messageDefaultLimit}, configured maximum ${config.messageMaxLimit}, with stateless keyset cursors.`,
        querystring: documentedSchema(messageQuery),
        response: { 200: collectionResponse(messageSchema), ...standardErrors },
      },
    },
    async (request) => {
      const query = parse(messageQuery, request.query);
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
  app.get<{ Params: unknown }>(
    "/v1/meshcore/messages/:id",
    {
      schema: {
        tags: ["MeshCore Messages"],
        summary: "Get a logical public message",
        params: messageIdParams(),
        response: { 200: dataResponse(messageSchema), ...standardErrors },
      },
    },
    async (request) => {
      const { id } = parse(z.object({ id: messageIdSchema }), request.params);
      return { data: await required(repository.getMessage(id), "Message") };
    },
  );

  const telemetryQuery = z
    .object({
      node: publicKeySchema.optional(),
      metric: z.string().trim().min(1).max(100).optional(),
      iata: iataFilterSchema.optional(),
      received_from: dateSchema.optional(),
      received_to: dateSchema.optional(),
      sort: z.literal("received_at").default("received_at"),
      order: orderSchema,
      limit: limitSchema(config.defaultLimit, config.maxLimit),
      cursor: cursorSchema,
    })
    .strict()
    .superRefine(validateReceivedRange);
  app.get<{ Querystring: unknown }>(
    "/v1/meshcore/telemetry",
    {
      schema: {
        tags: ["MeshCore Telemetry"],
        summary: "Search typed telemetry values",
        querystring: documentedSchema(telemetryQuery),
        response: {
          200: collectionResponse(telemetrySchema),
          ...standardErrors,
        },
      },
    },
    async (request) => {
      const query = parse(telemetryQuery, request.query);
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
  app.get<{ Params: unknown }>(
    "/v1/meshcore/telemetry/:id",
    detailSchema("MeshCore Telemetry", "Get a telemetry value", "id", telemetrySchema),
    async (request) => {
      const { id } = parse(z.object({ id: idSchema }), request.params);
      return { data: await required(repository.getTelemetry(id), "Telemetry") };
    },
  );

  const traceQuery = z
    .object({
      source_node: publicKeySchema.optional(),
      tag: z.string().trim().min(1).max(100).optional(),
      iata: iataFilterSchema.optional(),
      received_from: dateSchema.optional(),
      received_to: dateSchema.optional(),
      sort: z.literal("received_at").default("received_at"),
      order: orderSchema,
      limit: limitSchema(config.defaultLimit, config.maxLimit),
      cursor: cursorSchema,
    })
    .strict()
    .superRefine(validateReceivedRange);
  app.get<{ Querystring: unknown }>(
    "/v1/meshcore/traces",
    {
      schema: {
        tags: ["MeshCore Traces"],
        summary: "Search trace events",
        querystring: documentedSchema(traceQuery),
        response: { 200: collectionResponse(traceSchema), ...standardErrors },
      },
    },
    async (request) => {
      const query = parse(traceQuery, request.query);
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
  app.get<{ Params: unknown }>(
    "/v1/meshcore/traces/:id",
    detailSchema("MeshCore Traces", "Get a trace event", "id", traceSchema),
    async (request) => {
      const { id } = parse(z.object({ id: idSchema }), request.params);
      return { data: await required(repository.getTrace(id), "Trace") };
    },
  );
  app.get<{ Params: unknown }>(
    "/v1/meshcore/traces/:id/hops",
    {
      schema: {
        tags: ["MeshCore Traces"],
        summary: "List ordered trace hops",
        description:
          "Preserves resolved, unresolved, and ambiguous prefix candidates with confidence.",
        params: idParams(),
        response: {
          200: dataResponse({ type: "array", items: { type: "object" } }),
          ...standardErrors,
        },
      },
    },
    async (request) => {
      const { id } = parse(z.object({ id: idSchema }), request.params);
      await required(repository.getTrace(id), "Trace");
      return { data: await repository.listTraceHops(id) };
    },
  );
}

function registerStatisticsRoutes(app: FastifyInstance, repository: MeshcoreRepository) {
  app.get(
    "/v1/meshcore/stats",
    {
      schema: {
        tags: ["MeshCore Statistics"],
        summary: "Get current network statistics",
        description:
          "Active nodes, IATA, packets and logical messages use the trailing 24-hour window. Active observers have accepted ingest within the configured recent-activity window.",
        response: {
          200: dataResponse({
            type: "object",
            properties: {
              nodes: { type: "object", additionalProperties: true },
              observers: { type: "object", additionalProperties: true },
              regions: {
                type: "object",
                description:
                  "`configured` counts the public region catalog (built-in Swedish scopes plus detected scopes); `observed` counts catalog regions with any scope evidence.",
                properties: {
                  configured: { type: "integer", minimum: 0 },
                  observed: { type: "integer", minimum: 0 },
                },
              },
              active_iata: { type: "integer", minimum: 0 },
              activity: {
                type: "object",
                properties: {
                  packets_24h: {
                    type: "integer",
                    minimum: 0,
                    description: "Distinct packet hashes observed during the trailing 24 hours.",
                  },
                  messages_24h: {
                    type: "integer",
                    minimum: 0,
                    description:
                      "Distinct logical MeshCore messages observed during the trailing 24 hours.",
                  },
                  last_seen: {},
                },
              },
            },
          }),
          ...standardErrors,
        },
      },
    },
    async () => ({ data: await repository.getStats() }),
  );
  const windows = {
    "1h": 3_600_000,
    "6h": 21_600_000,
    "24h": 86_400_000,
    "7d": 604_800_000,
    "30d": 2_592_000_000,
  } as const;
  const intervals = {
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "6h": 21_600_000,
    "1d": 86_400_000,
  } as const;
  const activityQuery = z
    .object({
      window: z.enum(["1h", "6h", "24h", "7d", "30d"]).default("24h"),
      interval: z.enum(["5m", "15m", "1h", "6h", "1d"]).default("1h"),
      iata: iataFilterSchema.optional(),
    })
    .strict();
  app.get<{ Querystring: unknown }>(
    "/v1/meshcore/activity",
    {
      schema: {
        tags: ["MeshCore Statistics"],
        summary: "Get bounded activity time series",
        description:
          "Allowlisted windows and intervals with an optional geographic IATA filter. There is no region filter because per-observation region attribution evidence does not exist in the current data model.",
        querystring: documentedSchema(activityQuery),
        response: {
          200: dataResponse({ type: "array", items: { type: "object" } }),
          ...standardErrors,
        },
      },
    },
    async (request) => {
      const query = parse(activityQuery, request.query);
      const windowMs = windows[query.window];
      const intervalMs = intervals[query.interval];
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
) {
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

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  try {
    return schema.parse(value) as z.output<S>;
  } catch (error) {
    if (error instanceof ZodError)
      throw new ApiError(
        422,
        "INVALID_ARGUMENT",
        error.issues
          .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
          .join("; "),
      );
    throw error;
  }
}

function normalizeError(
  error: Error & { statusCode?: number; validation?: unknown; code?: string },
) {
  if (error instanceof ApiError) return error;
  if (error.statusCode === 429) return new ApiError(429, "RATE_LIMIT_EXCEEDED", error.message);
  if (error.validation) {
    const validation = JSON.stringify(error.validation);
    if (validation.includes("public_key"))
      return new ApiError(
        400,
        "INVALID_PUBLIC_KEY",
        "Public key must contain exactly 64 hexadecimal characters.",
      );
    if (validation.includes("iata") || validation.includes('"code"'))
      return new ApiError(400, "INVALID_IATA", "IATA must be a three-letter code.");
    return new ApiError(400, "INVALID_ARGUMENT", error.message);
  }
  if (error.statusCode && error.statusCode < 500)
    return new ApiError(error.statusCode ?? 400, "INVALID_ARGUMENT", error.message);
  if (error.code && (/^[0-9A-Z]{5}$/.test(error.code) || error.code.startsWith("ECONN")))
    return new ApiError(503, "DATABASE_UNAVAILABLE", "Database is unavailable.");
  return new ApiError(500, "INTERNAL_ERROR", "Internal server error.");
}

function validateGeo(
  value: { near_lat?: number; near_lon?: number; radius_km?: number },
  context: z.RefinementCtx,
) {
  const count = [value.near_lat, value.near_lon, value.radius_km].filter(
    (item) => item !== undefined,
  ).length;
  if (count !== 0 && count !== 3)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "near_lat, near_lon, and radius_km must be supplied together",
    });
}

function validateSeenRange(
  value: { seen_from?: number; seen_to?: number },
  context: z.RefinementCtx,
) {
  validateTimeRange(value.seen_from, value.seen_to, "seen", context);
}

function validateReceivedRange(
  value: { received_from?: number; received_to?: number },
  context: z.RefinementCtx,
) {
  validateTimeRange(value.received_from, value.received_to, "received", context);
}

function validateTimeRange(
  from: number | undefined,
  to: number | undefined,
  name: string,
  context: z.RefinementCtx,
) {
  if (from !== undefined && to !== undefined && from > to)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${name}_from must not be later than ${name}_to`,
    });
}

/**
 * Single source of truth for request contracts: every route's querystring and
 * params JSON Schema (AJV validation + OpenAPI) is derived from the same Zod
 * schema the handler parses with, so the two can no longer drift apart.
 */
const jsonSchemaOptions = { target: "openApi3", $refStrategy: "none" } as const;

/** Convert draft-06 boolean exclusiveMinimum to the numeric form AJV expects. */
function normalizeJsonSchema<T extends { properties?: Record<string, Record<string, unknown>> }>(
  schema: T,
): T {
  for (const property of Object.values(schema.properties ?? {})) {
    if (property.exclusiveMinimum === true && typeof property.minimum === "number") {
      property.exclusiveMinimum = property.minimum;
      delete property.minimum;
    }
  }
  return schema;
}

function documentedSchema<T extends z.ZodTypeAny>(schema: T) {
  return documentedQuery(
    normalizeJsonSchema(
      zodToJsonSchema(schema, jsonSchemaOptions) as unknown as {
        properties: Record<string, Record<string, unknown>>;
      },
    ),
  );
}

function paramsSchema(shape: z.ZodRawShape) {
  return normalizeJsonSchema(
    zodToJsonSchema(z.object(shape), jsonSchemaOptions) as {
      type: "object";
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    },
  );
}

function publicKeyParams() {
  return paramsSchema({ public_key: publicKeySchema });
}
function hashParams() {
  return paramsSchema({ sha256: hashSchema });
}
function idParams() {
  return paramsSchema({ id: idSchema });
}
function messageIdParams() {
  return paramsSchema({ id: messageIdSchema });
}
function regionParams() {
  return paramsSchema({
    region: z.string().trim().min(1).max(100),
  });
}

function pageQuery(config: AppConfig) {
  return z
    .object({
      limit: limitSchema(config.defaultLimit, config.maxLimit),
      cursor: cursorSchema,
      order: orderSchema,
    })
    .strict();
}
function detailSchema(
  tag: string,
  summary: string,
  parameter: "public_key" | "sha256" | "id",
  responseSchema: Record<string, unknown> = { type: "object" },
) {
  return {
    schema: {
      tags: [tag],
      summary,
      params:
        parameter === "public_key"
          ? publicKeyParams()
          : parameter === "sha256"
            ? hashParams()
            : idParams(),
      response: { 200: dataResponse(responseSchema), ...standardErrors },
    },
  };
}

function documentedQuery<T extends { properties: Record<string, Record<string, unknown>> }>(
  schema: T,
) {
  const descriptions: Record<string, string> = {
    name: "Case-insensitive literal name substring.",
    role: "Case-insensitive MeshCore role.",
    region: "Logical MeshCore neighbor region, distinct from IATA.",
    iata: "Three-letter geographic MQTT ingress code.",
    seen_from: "Inclusive lower last-seen timestamp in ISO 8601 format.",
    seen_to: "Inclusive upper last-seen timestamp in ISO 8601 format.",
    received_from: "Inclusive lower received timestamp in ISO 8601 format.",
    received_to: "Inclusive upper received timestamp in ISO 8601 format.",
    near_lat: "Radius-search center latitude.",
    near_lon: "Radius-search center longitude.",
    radius_km: "Maximum geography radius in kilometres.",
    sort: "Allowlisted deterministic sort field.",
    order: "Sort direction.",
    limit: "Bounded number of records to return.",
    cursor: "Opaque stateless continuation cursor.",
    active: "Recent observer ingest activity within the configured activity window.",
    hash: "Exact packet SHA-256 hash.",
    logical_id:
      "Exact route-independent logical packet identity, for example lp_ followed by 64 hex characters.",
    packet_type: "Decoded MeshCore packet type.",
    payload_type: "Decoded MeshCore payload type.",
    route_type: "Decoded MeshCore route type.",
    decode_status: "Packet decode status.",
    node: "Exact node public key.",
    observer: "Exact observer public key.",
    sender: "Exact resolved sender public key.",
    destination: "Exact resolved destination public key.",
    channel: "Exact public channel identifier.",
    channel_name: "Exact configured public channel name.",
    message_type: "Decoded message type.",
    encrypted: "Whether the message payload remains encrypted.",
    signature_valid: "Verified signature state.",
    metric: "Exact telemetry metric name.",
    source_node: "Exact resolved trace source public key.",
    tag: "Exact trace tag.",
    window: "Allowlisted trailing activity window.",
    interval: "Allowlisted activity bucket interval.",
    q: "Case-insensitive documentation search text.",
    prefix:
      "Region prefix filter; Swedish se/seXX/seXXXX codes are normalized to lowercase before matching.",
    observed_only: "Keep only regions with retained scope evidence.",
    manually_added: "Select the built-in Swedish region catalog.",
  };
  for (const [name, property] of Object.entries(schema.properties)) {
    property.description ??= descriptions[name] ?? `Filter by ${name.replaceAll("_", " ")}.`;
  }
  return schema;
}

if (process.env.NODE_ENV !== "test") {
  const runtimeConfig = loadConfig();
  const app = await buildServer({ config: runtimeConfig });
  const close = async () => {
    await app.close();
  };
  // Fire-and-forget by design: close() awaits app.close() and records a
  // non-zero exit code when shutdown fails.
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  await app.listen({ host: runtimeConfig.host, port: runtimeConfig.port });
}
