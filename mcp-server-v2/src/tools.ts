import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { RestError, type RestClient, type RestJson } from "./rest.js";

type ToolArgs = Record<string, unknown>;
type QueryValue = string | number | boolean | undefined;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  listResult?: boolean;
  outputSchema?: z.ZodObject;
  normalize?: (value: RestJson) => RestJson;
  request: (args: ToolArgs) => string;
}

export interface OperationalLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface McpServerOptions {
  requestId?: string;
  logger?: OperationalLogger;
}

class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

const text = (max = 200) => z.string().trim().min(1).max(max);
const input = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const segment = (label: string, max = 200) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        value !== "." &&
        value !== ".." &&
        !/[\\\u0000-\u001f\u007f]/.test(value),
      {
        message: `${label} must be one URL path segment.`,
      },
    );
const publicKey = z
  .string()
  .regex(
    /^[0-9a-fA-F]{64}$/,
    "public_key must contain 64 hexadecimal characters",
  )
  .transform((value) => value.toLowerCase());
const sha256 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "sha256 must contain 64 hexadecimal characters")
  .transform((value) => value.toLowerCase());
const logicalId = z
  .string()
  .regex(
    /^lp_[0-9a-fA-F]{64}$/i,
    "logical_id must start with lp_ and contain 64 hexadecimal characters",
  )
  .transform((value) => value.toLowerCase());
const iata = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "iata must contain exactly three letters")
  .transform((value) => value.toUpperCase());
const timestamp = z.string().datetime({ offset: true });
const order = z.enum(["asc", "desc"]);
const cursor = z.string().min(1).max(4096);
const limit = (maximum = 200, defaultValue?: number) => {
  const schema = z.number().int().min(1).max(maximum);
  return defaultValue === undefined
    ? schema.optional()
    : schema.default(defaultValue);
};
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const radiusKm = z.number().positive().max(1000);
const collectionOutput = z.object({
  items: z.array(z.json()),
  next_cursor: z.string().nullable(),
});
const restEnvelopeOutput = z.looseObject({ data: z.json() });
const DOC_MAX_BYTES = 65_536;
const safeDocPath = z
  .string()
  .min(1)
  .max(1000)
  .refine(isPublicDocPath, "REST returned a non-public documentation path");
const docFileFields = {
  title: z.string().max(DOC_MAX_BYTES).nullable(),
  size: z.number().int().nonnegative().max(DOC_MAX_BYTES),
};
const markdownDocFile = z
  .object({
    path: safeDocPath.refine((path) => path.endsWith(".md")),
    ...docFileFields,
    media_type: z.literal("text/markdown"),
  })
  .strict();
const yamlDocFile = z
  .object({
    path: z.literal("meshtastic/example.yaml"),
    ...docFileFields,
    media_type: z.literal("application/yaml"),
  })
  .strict();
const docFileOutput = z.union([markdownDocFile, yamlDocFile]);
const docsSourceOutput = z
  .object({
    repository: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password;
      }),
    ref: z.string().nullable(),
    commit: z.string().nullable(),
  })
  .strict();
const docsMetadataOutput = docsSourceOutput.extend({
  status: z.enum(["fresh", "stale", "unavailable"]),
});
const listDocsOutput = docsMetadataOutput
  .extend({ files: z.array(docFileOutput) })
  .strict();
const searchDocResultOutput = z.union([
  markdownDocFile.extend({ snippet: z.string().max(512) }).strict(),
  yamlDocFile.extend({ snippet: z.string().max(512) }).strict(),
]);
const searchDocsOutput = z
  .object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(50),
    returned: z.number().int().nonnegative(),
    total_matches: z.number().int().nonnegative(),
    scan_complete: z.boolean(),
    truncated: z.boolean(),
    results: z.array(searchDocResultOutput),
  })
  .strict();
const getDocOutput = z
  .object({
    path: safeDocPath,
    media_type: z.enum(["text/markdown", "application/yaml"]),
    content: z.string().max(DOC_MAX_BYTES),
    encoding: z.literal("utf-8"),
    source: docsSourceOutput,
  })
  .strict();

const page = (maximum = 200, defaultValue?: number) => ({
  limit: limit(maximum, defaultValue),
  cursor: cursor.optional(),
});
const receivedRange = {
  received_from: timestamp.optional(),
  received_to: timestamp.optional(),
};
const seenRange = {
  seen_from: timestamp.optional(),
  seen_to: timestamp.optional(),
};
const near = {
  near_lat: latitude.optional(),
  near_lon: longitude.optional(),
  radius_km: radiusKm.optional(),
};

function validateGeo(args: ToolArgs): void {
  const count = [args.near_lat, args.near_lon, args.radius_km].filter(
    (value) => value !== undefined,
  ).length;
  if (count !== 0 && count !== 3) {
    throw new ToolInputError(
      "near_lat, near_lon, and radius_km must be supplied together",
    );
  }
}

function geoQuery(path: string, args: ToolArgs): string {
  validateGeo(args);
  return query(path, args);
}

function query(path: string, args: ToolArgs): string {
  validateTimeRange(args, "seen_from", "seen_to");
  validateTimeRange(args, "received_from", "received_to");
  const parameters = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(args)) {
    const value = rawValue as QueryValue;
    if (value !== undefined) parameters.set(key, String(value));
  }
  const encoded = parameters.toString();
  return encoded.length === 0 ? path : `${path}?${encoded}`;
}

function validateTimeRange(
  args: ToolArgs,
  fromKey: string,
  toKey: string,
): void {
  const from = args[fromKey];
  const to = args[toKey];
  if (
    typeof from === "string" &&
    typeof to === "string" &&
    Date.parse(from) > Date.parse(to)
  )
    throw new ToolInputError(`${fromKey} must not be later than ${toKey}`);
}

function encodedSegment(value: unknown): string {
  return encodeURIComponent(String(value));
}

function encodedDocPath(value: unknown): string {
  const path = String(value);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("%") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.length > 1000
  ) {
    throw new ToolInputError(
      "path must be an unencoded safe relative documentation path",
    );
  }
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.toLowerCase() === ".git" ||
        part.length > 255,
    )
  ) {
    throw new ToolInputError(
      "path must be an unencoded safe relative documentation path",
    );
  }
  return parts.map(encodeURIComponent).join("/");
}

function isPublicDocPath(path: string): boolean {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("%") ||
    /[\u0000-\u001f\u007f]/.test(path)
  )
    return false;
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.toLowerCase() === ".git",
    )
  )
    return false;
  return path.endsWith(".md") || path === "meshtastic/example.yaml";
}

function invalidDocsResponse(message: string): never {
  throw new RestError("INVALID_REST_RESPONSE", message);
}

function parseDocsEnvelope<T>(schema: z.ZodType<T>, value: RestJson): T {
  const parsed = z.object({ data: schema }).strict().safeParse(value);
  if (!parsed.success)
    invalidDocsResponse(
      "The Meshat.se REST API returned an invalid documentation response.",
    );
  return parsed.data.data;
}

function normalizeListDocs(value: RestJson): RestJson {
  const data = parseDocsEnvelope(listDocsOutput, value);
  const paths = data.files.map(({ path }) => path);
  const sorted = [...paths].sort(comparePaths);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => path !== sorted[index])
  )
    invalidDocsResponse(
      "The Meshat.se REST API returned an invalid documentation index.",
    );
  return data;
}

function normalizeSearchDocs(value: RestJson): RestJson {
  const data = parseDocsEnvelope(searchDocsOutput, value);
  if (
    data.returned !== data.results.length ||
    data.total_matches < data.returned ||
    data.truncated !==
      (!data.scan_complete || data.total_matches > data.returned)
  )
    invalidDocsResponse(
      "The Meshat.se REST API returned invalid documentation search metadata.",
    );
  return data;
}

function normalizeGetDoc(value: RestJson): RestJson {
  const data = parseDocsEnvelope(getDocOutput, value);
  const expectedMediaType = data.path.endsWith(".md")
    ? "text/markdown"
    : "application/yaml";
  if (
    data.media_type !== expectedMediaType ||
    Buffer.byteLength(data.content, "utf8") > DOC_MAX_BYTES
  )
    invalidDocsResponse(
      "The Meshat.se REST API returned invalid documentation content.",
    );
  return data;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const tools: ToolDefinition[] = [
  {
    name: "list_sources",
    description:
      "List the network data sources currently available from Meshat.se.",
    inputSchema: input({}),
    listResult: true,
    request: () => "/v1/sources",
  },
  {
    name: "get_source",
    description:
      "Get the overview for a Meshat.se source. MeshCore is currently the only source.",
    inputSchema: input({
      source: z.literal("meshcore").default("meshcore"),
    }),
    request: () => "/v1/meshcore",
  },
  {
    name: "get_meshcore_overview",
    description:
      "Get MeshCore source metadata and links to its domain resources.",
    inputSchema: input({}),
    request: () => "/v1/meshcore",
  },
  {
    name: "search_nodes",
    description:
      "Search MeshCore nodes. IATA filters geographic ingress areas; region filters logical MeshCore neighbor regions.",
    inputSchema: input({
      name: text(100).optional(),
      role: text(50).optional(),
      region: text(100).optional(),
      iata: iata.optional(),
      ...seenRange,
      ...near,
      sort: z.enum(["last_seen", "first_seen", "name", "role"]).optional(),
      order: order.optional(),
      ...page(),
    }),
    listResult: true,
    request: (args) => geoQuery("/v1/meshcore/nodes", args),
  },
  {
    name: "get_node",
    description:
      "Get one normalized MeshCore node by its 64-character public key.",
    inputSchema: input({ public_key: publicKey }),
    request: ({ public_key }) =>
      `/v1/meshcore/nodes/${encodedSegment(public_key)}`,
  },
  {
    name: "get_node_neighbors",
    description:
      "Get aggregated neighbor evidence for a MeshCore node without implying reciprocity unless both directions were reported.",
    inputSchema: input({ public_key: publicKey }),
    request: ({ public_key }) =>
      `/v1/meshcore/nodes/${encodedSegment(public_key)}/neighbors`,
  },
  {
    name: "search_observers",
    description:
      "Search MQTT-reporting MeshCore observers. IATA is geographic ingress; region is a logical MeshCore neighbor region. Locations come from same-key nodes.",
    inputSchema: input({
      active: z.boolean().optional(),
      name: text(100).optional(),
      iata: iata.optional(),
      region: text(100).optional(),
      ...seenRange,
      ...near,
      sort: z.enum(["last_seen", "first_seen", "name"]).optional(),
      order: order.optional(),
      ...page(),
    }),
    listResult: true,
    request: (args) => geoQuery("/v1/meshcore/observers", args),
  },
  {
    name: "get_observer",
    description:
      "Get one MeshCore MQTT observer by its 64-character public key.",
    inputSchema: input({ public_key: publicKey }),
    request: ({ public_key }) =>
      `/v1/meshcore/observers/${encodedSegment(public_key)}`,
  },
  {
    name: "list_regions",
    description:
      "List logical MeshCore neighbor regions. These are distinct from geographic IATA ingress areas.",
    inputSchema: input({}),
    listResult: true,
    request: () => "/v1/meshcore/regions",
  },
  {
    name: "get_region",
    description:
      "Get one logical MeshCore neighbor region, not a geographic IATA ingress area.",
    inputSchema: input({ region: segment("region", 100) }),
    request: ({ region }) => `/v1/meshcore/regions/${encodedSegment(region)}`,
  },
  {
    name: "list_iata",
    description:
      "List configured three-letter geographic MQTT ingress areas and their primary/secondary relationships. IATA is not a MeshCore neighbor region.",
    inputSchema: input({}),
    listResult: true,
    request: () => "/v1/meshcore/iata",
  },
  {
    name: "get_iata",
    description:
      "Get one geographic IATA ingress area. Input is normalized to uppercase.",
    inputSchema: input({ code: iata }),
    request: ({ code }) => `/v1/meshcore/iata/${encodedSegment(code)}`,
  },
  {
    name: "search_packets",
    description:
      "Search normalized public MeshCore packets using controlled packet and observation filters. Use logical_id to list every physical packet variant of one logical message.",
    inputSchema: input({
      hash: sha256.optional(),
      logical_id: logicalId.optional(),
      packet_type: text(50).optional(),
      payload_type: text(50).optional(),
      route_type: text(50).optional(),
      decode_status: text(50).optional(),
      node: publicKey.optional(),
      observer: publicKey.optional(),
      iata: iata.optional(),
      ...receivedRange,
      sort: z.enum(["received_at", "first_seen"]).optional(),
      order: order.optional(),
      ...page(),
    }),
    listResult: true,
    request: (args) => query("/v1/meshcore/packets", args),
  },
  {
    name: "get_packet",
    description:
      "Get one public MeshCore packet, including raw MeshCore bytes, by SHA-256 hash.",
    inputSchema: input({ sha256 }),
    request: ({ sha256: hash }) =>
      `/v1/meshcore/packets/${encodedSegment(hash)}`,
  },
  {
    name: "search_messages",
    description:
      "Search public MeshCore messages with bounded, stateless cursor pagination.",
    inputSchema: input({
      sender: publicKey.optional(),
      destination: publicKey.optional(),
      channel: z.string().max(100).optional(),
      channel_name: z.string().max(100).optional(),
      message_type: z.string().max(50).optional(),
      encrypted: z.boolean().optional(),
      signature_valid: z.boolean().optional(),
      iata: iata.optional(),
      ...receivedRange,
      sort: z.enum(["received_at"]).optional(),
      order: order.optional(),
      ...page(200, 50),
    }),
    listResult: true,
    request: (args) => query("/v1/meshcore/messages", args),
  },
  {
    name: "get_message",
    description:
      "Get one logical public MeshCore message by its stable logical identifier.",
    inputSchema: input({
      id: z
        .string()
        .regex(
          /^lp_[0-9a-f]{64}$/i,
          "id must be a logical packet identifier starting with lp_",
        )
        .transform((value) => value.toLowerCase()),
    }),
    request: ({ id }) => `/v1/meshcore/messages/${encodedSegment(id)}`,
  },
  {
    name: "search_telemetry",
    description: "Search normalized public MeshCore telemetry values.",
    inputSchema: input({
      node: publicKey.optional(),
      metric: text(100).optional(),
      iata: iata.optional(),
      ...receivedRange,
      sort: z.enum(["received_at"]).optional(),
      order: order.optional(),
      ...page(),
    }),
    listResult: true,
    request: (args) => query("/v1/meshcore/telemetry", args),
  },
  {
    name: "search_traces",
    description:
      "Search public MeshCore route traces while preserving REST-provided ambiguity information.",
    inputSchema: input({
      source_node: publicKey.optional(),
      tag: text(100).optional(),
      iata: iata.optional(),
      ...receivedRange,
      sort: z.enum(["received_at"]).optional(),
      order: order.optional(),
      ...page(),
    }),
    listResult: true,
    request: (args) => query("/v1/meshcore/traces", args),
  },
  {
    name: "get_meshcore_stats",
    description: "Get the current curated MeshCore network statistics summary.",
    inputSchema: input({}),
    request: () => "/v1/meshcore/stats",
  },
  {
    name: "get_meshcore_activity",
    description:
      "Get bounded MeshCore activity buckets using allowlisted windows and intervals.",
    inputSchema: input({
      window: z.enum(["1h", "6h", "24h", "7d", "30d"]).optional(),
      interval: z.enum(["5m", "15m", "1h", "6h", "1d"]).optional(),
      iata: iata.optional(),
      region: text(100).optional(),
    }),
    request: (args) => query("/v1/meshcore/activity", args),
  },
  {
    name: "list_docs",
    description:
      "List the recursively indexed public Meshat.se documentation files served by REST.",
    inputSchema: input({}),
    outputSchema: listDocsOutput,
    normalize: normalizeListDocs,
    request: () => "/v1/docs",
  },
  {
    name: "search_docs",
    description:
      "Search only public Meshat.se documentation and return bounded matching snippets.",
    inputSchema: input({ q: text(200), limit: limit(50, 20) }),
    outputSchema: searchDocsOutput,
    normalize: normalizeSearchDocs,
    request: (args) => query("/v1/docs/search", args),
  },
  {
    name: "get_doc",
    description:
      "Get one public Meshat.se documentation file by a safe relative path.",
    inputSchema: input({ path: z.string().min(1).max(1000) }),
    outputSchema: getDocOutput,
    normalize: normalizeGetDoc,
    request: ({ path }) => `/v1/docs/${encodedDocPath(path)}`,
  },
];

export const TOOL_NAMES = tools.map(({ name }) => name);

function normalizeList(value: RestJson): RestJson {
  if (!Array.isArray(value.data)) {
    throw new RestError(
      "INVALID_REST_RESPONSE",
      "The Meshat.se REST API returned an invalid collection response.",
    );
  }
  const pagination = value.pagination;
  if (
    pagination !== undefined &&
    (pagination === null ||
      typeof pagination !== "object" ||
      Array.isArray(pagination))
  ) {
    throw new RestError(
      "INVALID_REST_RESPONSE",
      "The Meshat.se REST API returned invalid pagination metadata.",
    );
  }
  const nextCursor = (pagination as Record<string, unknown> | undefined)
    ?.next_cursor;
  if (
    nextCursor !== undefined &&
    nextCursor !== null &&
    typeof nextCursor !== "string"
  ) {
    throw new RestError(
      "INVALID_REST_RESPONSE",
      "The Meshat.se REST API returned an invalid continuation cursor.",
    );
  }
  return { items: value.data, next_cursor: nextCursor ?? null };
}

function success(value: RestJson, definition: ToolDefinition): CallToolResult {
  const output = definition.normalize
    ? definition.normalize(value)
    : definition.listResult
      ? normalizeList(value)
      : value;
  return {
    content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
  };
}

function failure(error: unknown): CallToolResult {
  const safe =
    error instanceof RestError
      ? {
          code: error.code,
          message: error.message,
          ...(error.requestId === undefined
            ? {}
            : { request_id: error.requestId }),
        }
      : error instanceof ToolInputError
        ? {
            code: "INVALID_ARGUMENT",
            message: error.message,
          }
        : {
            code: "INTERNAL_ERROR",
            message: "The tool request failed unexpectedly.",
          };
  const envelope = { error: safe };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    isError: true,
  };
}

export function createMcpServer(
  restClient: RestClient,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "Meshat.se MCP-V2",
    version: "2.0.0",
  });

  for (const definition of tools) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema:
          definition.outputSchema ??
          (definition.listResult === true
            ? collectionOutput
            : restEnvelopeOutput),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args, context) => {
        try {
          return success(
            await restClient.get(definition.request(args), {
              requestId: options.requestId,
              signal: context.mcpReq.signal,
            }),
            definition,
          );
        } catch (error) {
          if (error instanceof RestError) {
            options.logger?.warn(
              {
                tool: definition.name,
                code: error.code,
                status: error.status ?? null,
                request_id: error.requestId ?? options.requestId ?? null,
              },
              "Meshat.se REST tool request failed",
            );
          }
          return failure(error);
        }
      },
    );
  }

  return server;
}
