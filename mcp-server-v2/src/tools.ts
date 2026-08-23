import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { RestError, type RestClient, type RestJson } from "./rest.js";

type ToolArgs = Record<string, unknown>;
type QueryValue = string | number | boolean | undefined;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema?: z.ZodType;
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
    .refine((value) => value !== "." && value !== ".." && !/[\\\u0000-\u001f\u007f]/.test(value), {
      message: `${label} must be one URL path segment.`,
    });
const publicKey = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "public_key must contain 64 hexadecimal characters")
  .transform((value) => value.toLowerCase());
const sha256 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "sha256 must contain 64 hexadecimal characters")
  .transform((value) => value.toLowerCase());
const logicalId = z
  .string()
  .regex(
    /^lp_[0-9a-fA-F]{64}$/,
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
  return defaultValue === undefined ? schema.optional() : schema.default(defaultValue);
};
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const radiusKm = z.number().positive().max(1000);
const DOC_MAX_BYTES = 65_536;

function upstreamContractError(message: string): never {
  throw new RestError(
    "UPSTREAM_CONTRACT_ERROR",
    `The Meshat.se REST API returned a response that violates the published contract: ${message}`,
  );
}

function parseDataEnvelope<T>(schema: z.ZodType<T>, value: RestJson): T {
  const parsed = z.object({ data: schema }).strict().safeParse(value);
  if (!parsed.success) {
    upstreamContractError("the data envelope did not match the documented resource schema.");
  }
  return parsed.data.data;
}

function semanticList(
  item: z.ZodType,
  resource: string,
): {
  outputSchema: z.ZodObject<{
    items: z.ZodArray<z.ZodType>;
    next_cursor: z.ZodNullable<z.ZodString>;
  }>;
  normalize: (value: RestJson) => RestJson;
} {
  const envelope = z.object({
    data: z.array(z.unknown()),
    pagination: z
      .object({ next_cursor: z.string().nullable().optional() })
      .passthrough()
      .optional(),
  });
  return {
    outputSchema: z.object({ items: z.array(item), next_cursor: z.string().nullable() }).strict(),
    normalize: (value) => {
      const parsed = envelope.safeParse(value);
      if (!parsed.success) {
        upstreamContractError(
          `the ${resource} collection response did not match the pagination contract.`,
        );
      }
      const items = parsed.data.data.map((entry) => {
        const result = item.safeParse(entry);
        if (!result.success) {
          upstreamContractError(`a ${resource} item did not match the documented resource schema.`);
        }
        return result.data;
      });
      return {
        items,
        next_cursor: parsed.data.pagination?.next_cursor ?? null,
      };
    },
  };
}

function semanticDetail(item: z.ZodType): {
  outputSchema: z.ZodType;
  normalize: (value: RestJson) => RestJson;
} {
  return {
    outputSchema: item,
    normalize: (value) => parseDataEnvelope(item, value) as RestJson,
  };
}

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
const listDocsOutput = docsMetadataOutput.extend({ files: z.array(docFileOutput) }).strict();
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

const isoString = z.string().datetime({ offset: true });
const isoNullable = isoString.nullable();
const hex64 = z.string().regex(/^[0-9a-fA-F]{64}$/);
const nullableHex64 = hex64.nullable();
const locationOutput = z.object({ latitude: z.number(), longitude: z.number() }).strict();
const nodeOutput = z
  .object({
    public_key: hex64,
    owner_public_key: nullableHex64,
    name: z.string().nullable(),
    role: z.string().nullable(),
    location: locationOutput.nullable(),
    first_seen: isoString,
    last_seen: isoString,
    iata: z.array(z.string()),
    regions: z.array(z.string()),
  })
  .strict();
const observerOutput = z
  .object({
    public_key: hex64,
    name: z.string().nullable(),
    active: z.boolean(),
    iata: z.string().nullable(),
    regions: z.array(z.string()),
    location: locationOutput.nullable(),
    first_seen: isoString,
    last_seen: isoString,
  })
  .strict();
const regionOutput = z
  .object({
    region: z.string(),
    name: z.string().nullable(),
    first_seen: isoNullable,
    last_seen: isoNullable,
    manually_added: z.boolean(),
    observation_count: z.number().int().nonnegative(),
    node_count: z.number().int().nonnegative(),
    observer_count: z.number().int().nonnegative(),
    last_activity: isoNullable,
    links: z.object({ nodes: z.string(), observers: z.string() }).strict(),
  })
  .strict();
const iataOutput = z
  .object({
    code: z.string().regex(/^[A-Z]{3}$/),
    name: z.string().nullable(),
    type: z.enum(["primary", "secondary"]),
    primary_code: z.string().regex(/^[A-Z]{3}$/),
    summary: z
      .object({
        node_count: z.number().int().nonnegative(),
        observer_count: z.number().int().nonnegative(),
        observation_count: z.number().int().nonnegative(),
        last_activity: isoNullable,
      })
      .strict()
      .optional(),
    links: z
      .object({
        nodes: z.string(),
        observers: z.string(),
        activity: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
const packetOutput = z
  .object({
    sha256: hex64,
    logical_id: z.string().nullable(),
    packet_type: z.string().nullable(),
    payload_type: z.string().nullable(),
    route_type: z.string().nullable(),
    decode_status: z.string(),
    raw: z
      .string()
      .regex(/^0x[0-9a-f]*$/)
      .nullable(),
    first_seen: isoNullable,
    last_seen: isoNullable,
  })
  .strict();
const logicalMessageOutput = z
  .object({
    id: z.string().regex(/^lp_[0-9a-f]{64}$/),
    representative_packet_sha256: hex64,
    type: z.string().nullable(),
    channel: z.string().nullable(),
    channel_index: z.number().nullable(),
    channel_name: z.string().nullable(),
    sender: nullableHex64,
    destination: nullableHex64,
    encrypted: z.boolean(),
    text: z.string().nullable(),
    signature_valid: z.boolean().nullable(),
    iata: z.array(z.string()),
    observation_count: z.number().int().min(1),
    matched: z
      .object({
        iata: z.array(z.string()),
        observation_count: z.number().int().min(1),
      })
      .strict(),
    reported_at: isoNullable,
    first_received_at: isoNullable,
    last_received_at: isoNullable,
  })
  .strict();
const telemetryOutput = z
  .object({
    id: z.string(),
    packet_sha256: hex64,
    node: nullableHex64,
    metric: z.string(),
    value: z
      .object({
        type: z.enum(["number", "string", "boolean"]),
        value: z.unknown(),
      })
      .strict(),
    unit: z.string().nullable(),
    channel: z.string().nullable(),
    iata: z.string().nullable(),
    reported_at: isoNullable,
    received_at: isoNullable,
  })
  .strict();
const traceOutput = z
  .object({
    id: z.string(),
    packet_sha256: hex64,
    logical_id: z.string().nullable(),
    source_node: nullableHex64,
    observer: nullableHex64,
    tag: z.string().nullable(),
    iata: z.string().nullable(),
    reported_at: isoNullable,
    received_at: isoNullable,
  })
  .strict();
const statsOutput = z
  .object({
    nodes: z
      .object({
        known: z.number().int().nonnegative(),
        active_24h: z.number().int().nonnegative(),
      })
      .strict(),
    observers: z
      .object({
        known: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        active_window_seconds: z.number().nonnegative(),
      })
      .strict(),
    regions: z
      .object({
        configured: z.number().int().nonnegative(),
        observed: z.number().int().nonnegative(),
      })
      .strict(),
    active_iata: z.number().int().nonnegative(),
    activity: z
      .object({
        packets_24h: z.number().int().nonnegative(),
        messages_24h: z.number().int().nonnegative(),
        last_seen: isoNullable,
      })
      .strict(),
  })
  .strict();
const activityBucketOutput = z
  .object({
    bucket_at: isoString,
    observations: z.number().int().nonnegative(),
    packets: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
  })
  .strict();
const sourceOutput = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    status: z.string(),
    api_version: z.string(),
    url: z.string(),
    documentation_url: z.string(),
    capabilities: z.array(z.string()),
  })
  .passthrough();
const overviewOutput = sourceOutput.extend({ resources: z.object({}).passthrough() }).passthrough();
const neighborOutput = z
  .object({
    public_key: hex64,
    node: z.object({ name: z.string().nullable(), role: z.string().nullable() }).strict(),
    relationship: z.enum(["reported", "reciprocal"]),
    direction: z.enum(["outbound", "inbound", "both"]),
    last_heard: isoNullable,
    signal: z.object({ snr: z.number().nullable(), rssi: z.number().nullable() }).strict(),
    regions: z.array(z.string()),
    evidence: z
      .object({
        report_count: z.number().int().nonnegative(),
        observer_count: z.number().int().nonnegative(),
      })
      .strict(),
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
    throw new ToolInputError("near_lat, near_lon, and radius_km must be supplied together");
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

function validateTimeRange(args: ToolArgs, fromKey: string, toKey: string): void {
  const from = args[fromKey];
  const to = args[toKey];
  if (typeof from === "string" && typeof to === "string" && Date.parse(from) > Date.parse(to))
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
    throw new ToolInputError("path must be an unencoded safe relative documentation path");
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
    throw new ToolInputError("path must be an unencoded safe relative documentation path");
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
      (part) => part.length === 0 || part === "." || part === ".." || part.toLowerCase() === ".git",
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
    invalidDocsResponse("The Meshat.se REST API returned an invalid documentation response.");
  return parsed.data.data;
}

function normalizeListDocs(value: RestJson): RestJson {
  const data = parseDocsEnvelope(listDocsOutput, value);
  const paths = data.files.map(({ path }) => path);
  const sorted = [...paths].sort(comparePaths);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => path !== sorted[index]))
    invalidDocsResponse("The Meshat.se REST API returned an invalid documentation index.");
  return data;
}

function normalizeSearchDocs(value: RestJson): RestJson {
  const data = parseDocsEnvelope(searchDocsOutput, value);
  if (
    data.returned !== data.results.length ||
    data.total_matches < data.returned ||
    data.truncated !== (!data.scan_complete || data.total_matches > data.returned)
  )
    invalidDocsResponse("The Meshat.se REST API returned invalid documentation search metadata.");
  return data;
}

function normalizeGetDoc(value: RestJson): RestJson {
  const data = parseDocsEnvelope(getDocOutput, value);
  const expectedMediaType = data.path.endsWith(".md") ? "text/markdown" : "application/yaml";
  if (
    data.media_type !== expectedMediaType ||
    Buffer.byteLength(data.content, "utf8") > DOC_MAX_BYTES
  )
    invalidDocsResponse("The Meshat.se REST API returned invalid documentation content.");
  return data;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const nodeList = semanticList(nodeOutput, "node");
const nodeDetail = semanticDetail(nodeOutput);
const observerList = semanticList(observerOutput, "observer");
const observerDetail = semanticDetail(observerOutput);
const regionList = semanticList(regionOutput, "region");
const regionDetail = semanticDetail(regionOutput);
const iataList = semanticList(iataOutput, "IATA");
const iataDetail = semanticDetail(iataOutput);
const packetList = semanticList(packetOutput, "packet");
const packetDetail = semanticDetail(packetOutput);
const messageList = semanticList(logicalMessageOutput, "logical message");
const messageDetail = semanticDetail(logicalMessageOutput);
const telemetryList = semanticList(telemetryOutput, "telemetry");
const traceList = semanticList(traceOutput, "trace");
const statsDetail = semanticDetail(statsOutput);
const activityList = semanticList(activityBucketOutput, "activity bucket");
const sourceList = semanticList(sourceOutput, "source");
const overviewDetail = semanticDetail(overviewOutput);
const neighborList = semanticList(neighborOutput, "neighbor");

const tools: ToolDefinition[] = [
  {
    name: "list_sources",
    description: "List the network data sources currently available from Meshat.se.",
    inputSchema: input({}),
    outputSchema: sourceList.outputSchema,
    normalize: sourceList.normalize,
    request: () => "/v1/sources",
  },
  {
    name: "get_source",
    description: "Get the overview for a Meshat.se source. MeshCore is currently the only source.",
    inputSchema: input({
      source: z.literal("meshcore").default("meshcore"),
    }),
    outputSchema: overviewDetail.outputSchema,
    normalize: overviewDetail.normalize,
    request: () => "/v1/meshcore",
  },
  {
    name: "get_meshcore_overview",
    description: "Get MeshCore source metadata and links to its domain resources.",
    inputSchema: input({}),
    outputSchema: overviewDetail.outputSchema,
    normalize: overviewDetail.normalize,
    request: () => "/v1/meshcore",
  },
  {
    name: "search_nodes",
    description:
      "Search MeshCore nodes. IATA filters geographic ingress areas; region filters logical MeshCore neighbor regions, and combined seen time filters apply to the same evidence.",
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
    outputSchema: nodeList.outputSchema,
    normalize: nodeList.normalize,
    request: (args) => geoQuery("/v1/meshcore/nodes", args),
  },
  {
    name: "get_node",
    description: "Get one normalized MeshCore node by its 64-character public key.",
    inputSchema: input({ public_key: publicKey }),
    outputSchema: nodeDetail.outputSchema,
    normalize: nodeDetail.normalize,
    request: ({ public_key }) => `/v1/meshcore/nodes/${encodedSegment(public_key)}`,
  },
  {
    name: "get_node_neighbors",
    description:
      "Get aggregated neighbor evidence for a MeshCore node without implying reciprocity unless both directions were reported.",
    inputSchema: input({ public_key: publicKey }),
    outputSchema: neighborList.outputSchema,
    normalize: neighborList.normalize,
    request: ({ public_key }) => `/v1/meshcore/nodes/${encodedSegment(public_key)}/neighbors`,
  },
  {
    name: "search_observers",
    description:
      "Search MQTT-reporting MeshCore observers. IATA is geographic ingress; region is a logical MeshCore neighbor region that must belong to the observer's own public key. Locations come from same-key nodes.",
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
    outputSchema: observerList.outputSchema,
    normalize: observerList.normalize,
    request: (args) => geoQuery("/v1/meshcore/observers", args),
  },
  {
    name: "get_observer",
    description: "Get one MeshCore MQTT observer by its 64-character public key.",
    inputSchema: input({ public_key: publicKey }),
    outputSchema: observerDetail.outputSchema,
    normalize: observerDetail.normalize,
    request: ({ public_key }) => `/v1/meshcore/observers/${encodedSegment(public_key)}`,
  },
  {
    name: "list_regions",
    description:
      "List logical MeshCore neighbor regions from the public region catalog with bounded pagination. Use observed_only to keep regions with evidence and manually_added for the built-in Swedish catalog. These are distinct from geographic IATA ingress areas.",
    inputSchema: input({
      observed_only: z.boolean().optional(),
      manually_added: z.boolean().optional(),
      prefix: text(100).optional(),
      ...page(200, 50),
    }),
    outputSchema: regionList.outputSchema,
    normalize: regionList.normalize,
    request: (args) => query("/v1/meshcore/regions", args),
  },
  {
    name: "get_region",
    description: "Get one logical MeshCore neighbor region, not a geographic IATA ingress area.",
    inputSchema: input({ region: segment("region", 100) }),
    outputSchema: regionDetail.outputSchema,
    normalize: regionDetail.normalize,
    request: ({ region }) => `/v1/meshcore/regions/${encodedSegment(region)}`,
  },
  {
    name: "list_iata",
    description:
      "List configured three-letter geographic MQTT ingress areas and their primary/secondary relationships. IATA is not a MeshCore neighbor region.",
    inputSchema: input({}),
    outputSchema: iataList.outputSchema,
    normalize: iataList.normalize,
    request: () => "/v1/meshcore/iata",
  },
  {
    name: "get_iata",
    description: "Get one geographic IATA ingress area. Input is normalized to uppercase.",
    inputSchema: input({ code: iata }),
    outputSchema: iataDetail.outputSchema,
    normalize: iataDetail.normalize,
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
    outputSchema: packetList.outputSchema,
    normalize: packetList.normalize,
    request: (args) => query("/v1/meshcore/packets", args),
  },
  {
    name: "get_packet",
    description: "Get one public MeshCore packet, including raw MeshCore bytes, by SHA-256 hash.",
    inputSchema: input({ sha256 }),
    outputSchema: packetDetail.outputSchema,
    normalize: packetDetail.normalize,
    request: ({ sha256: hash }) => `/v1/meshcore/packets/${encodedSegment(hash)}`,
  },
  {
    name: "search_messages",
    description:
      "Search public MeshCore messages with bounded, stateless cursor pagination. Canonical message fields are stable; query-scope evidence is returned under matched.",
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
    outputSchema: messageList.outputSchema,
    normalize: messageList.normalize,
    request: (args) => query("/v1/meshcore/messages", args),
  },
  {
    name: "get_message",
    description: "Get one logical public MeshCore message by its stable logical identifier.",
    inputSchema: input({
      id: z
        .string()
        .regex(/^lp_[0-9a-fA-F]{64}$/, "id must be a logical packet identifier starting with lp_")
        .transform((value) => value.toLowerCase()),
    }),
    outputSchema: messageDetail.outputSchema,
    normalize: messageDetail.normalize,
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
    outputSchema: telemetryList.outputSchema,
    normalize: telemetryList.normalize,
    request: (args) => query("/v1/meshcore/telemetry", args),
  },
  {
    name: "search_traces",
    description:
      "Search public MeshCore route traces. Each result is one observation-level trace event: rows that share a packet differ by reporting observer and IATA evidence.",
    inputSchema: input({
      source_node: publicKey.optional(),
      tag: text(100).optional(),
      iata: iata.optional(),
      ...receivedRange,
      sort: z.enum(["received_at"]).optional(),
      order: order.optional(),
      ...page(),
    }),
    outputSchema: traceList.outputSchema,
    normalize: traceList.normalize,
    request: (args) => query("/v1/meshcore/traces", args),
  },
  {
    name: "get_meshcore_stats",
    description: "Get the current curated MeshCore network statistics summary.",
    inputSchema: input({}),
    outputSchema: statsDetail.outputSchema,
    normalize: statsDetail.normalize,
    request: () => "/v1/meshcore/stats",
  },
  {
    name: "get_meshcore_activity",
    description:
      "Get bounded MeshCore activity buckets using allowlisted windows and intervals and an optional geographic IATA filter. There is no region filter because per-observation region attribution evidence does not exist in the current data model.",
    inputSchema: input({
      window: z.enum(["1h", "6h", "24h", "7d", "30d"]).optional(),
      interval: z.enum(["5m", "15m", "1h", "6h", "1d"]).optional(),
      iata: iata.optional(),
    }),
    outputSchema: activityList.outputSchema,
    normalize: activityList.normalize,
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
    description: "Search only public Meshat.se documentation and return bounded matching snippets.",
    inputSchema: input({ q: text(200), limit: limit(50, 20) }),
    outputSchema: searchDocsOutput,
    normalize: normalizeSearchDocs,
    request: (args) => query("/v1/docs/search", args),
  },
  {
    name: "get_doc",
    description: "Get one public Meshat.se documentation file by a safe relative path.",
    inputSchema: input({ path: z.string().min(1).max(1000) }),
    outputSchema: getDocOutput,
    normalize: normalizeGetDoc,
    request: ({ path }) => `/v1/docs/${encodedDocPath(path)}`,
  },
];

export const TOOL_NAMES = tools.map(({ name }) => name);

function success(value: RestJson, definition: ToolDefinition): CallToolResult {
  const output = definition.normalize ? definition.normalize(value) : value;
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
          ...(error.requestId === undefined ? {} : { request_id: error.requestId }),
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

export function createMcpServer(restClient: RestClient, options: McpServerOptions = {}): McpServer {
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
        outputSchema: definition.outputSchema ?? z.object({}),
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
