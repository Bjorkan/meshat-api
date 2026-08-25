import { z } from "zod/v4";

/**
 * Public API response contracts: the single source of truth shared by
 * runtime serialization, TypeScript types, and the OpenAPI document.
 *
 * These schemas describe HTTP responses only. No SQL, repository logic, or
 * Fastify concepts live here.
 *
 * Nullable (`| null`) means the field is always present but may be null;
 * `.optional()` means the field may be absent. Response serialization strips
 * any property that is not declared here, preserving the previous
 * fast-json-stringify whitelist guarantee.
 */

// Envelopes -----------------------------------------------------------------

export const paginationSchema = z
  .object({
    limit: z.number().int().describe("Applied bounded page size."),
    has_more: z.boolean().describe("Whether another page exists."),
    next_cursor: z
      .string()
      .nullable()
      .describe("Opaque stateless continuation cursor bound to this query."),
  })
  .meta({ id: "Pagination", description: "Keyset pagination trailer." });

export const errorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.string().describe("Stable machine-readable error code."),
      message: z.string(),
      request_id: z.string().describe("Request ID for log correlation."),
    }),
  })
  .meta({ id: "ErrorEnvelope", description: "Stable public error envelope." });

export const dataEnvelope = <T extends z.ZodType>(data: T) => z.object({ data }).meta({});
export const collectionEnvelope = <T extends z.ZodType>(item: T) =>
  z
    .object({
      data: z.array(item),
      pagination: paginationSchema,
    })
    .meta({ description: "Successful bounded collection response." });

/** Standard error responses shared by every public route. */
export const standardErrorResponses = {
  400: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  422: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  500: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
} as const;

// Shared value objects ------------------------------------------------------

export const locationSchema = z
  .object({
    latitude: z.number(),
    longitude: z.number(),
  })
  .nullable()
  .meta({ id: "Location" });

const isoTimestamp = z.iso.datetime();
const nullableIsoTimestamp = z.iso.datetime().nullable();

const typedValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("number"), value: z.number() }),
  z.object({ type: z.literal("boolean"), value: z.boolean() }),
  z.object({ type: z.literal("string"), value: z.string().nullable() }),
]);

// MeshCore resources --------------------------------------------------------

export const nodeSchema = z
  .object({
    public_key: z.string().regex(/^[0-9A-Fa-f]{64}$/),
    owner_public_key: z.string().nullable(),
    name: z.string().nullable(),
    role: z.string().nullable().describe("Lowercase MeshCore domain role."),
    location: locationSchema,
    first_seen: isoTimestamp,
    last_seen: isoTimestamp,
    iata: z.array(z.string()),
    regions: z.array(z.string()),
  })
  .meta({
    id: "MeshCoreNode",
    description:
      "Normalized MeshCore node. IATA ingress areas and logical MeshCore regions are separate arrays.",
  });
export type PublicNode = z.output<typeof nodeSchema>;

export const observerSchema = z
  .object({
    public_key: z.string(),
    name: z.string().nullable(),
    active: z.boolean(),
    iata: z.string().nullable(),
    regions: z.array(z.string()),
    location: locationSchema,
    first_seen: isoTimestamp,
    last_seen: isoTimestamp,
  })
  .meta({
    id: "MeshCoreObserver",
    description:
      "MQTT observer with location inherited from its same-key node. Active means recent accepted ingest within the configured activity window.",
  });
export type PublicObserver = z.output<typeof observerSchema>;

export const packetSchema = z
  .object({
    sha256: z.string(),
    logical_id: z.string().nullable(),
    packet_type: z.string().nullable(),
    payload_type: z.string().nullable(),
    route_type: z.string().nullable(),
    decode_status: z.string(),
    raw: z
      .string()
      .regex(/^0x[0-9a-f]*$/)
      .describe("MeshCore packet bytes as deterministic hex; never an MQTT receipt."),
    first_seen: isoTimestamp,
    last_seen: isoTimestamp,
  })
  .meta({ id: "MeshCorePacket" });
export type PublicPacket = z.output<typeof packetSchema>;

export const logicalMessageMatchedSchema = z
  .object({
    iata: z.array(z.string()),
    observation_count: z.number().int().min(1),
  })
  .meta({
    id: "LogicalMessageMatched",
    description: "Query-scope evidence; only these fields vary with the search filters.",
  });

export const messageSchema = z
  .object({
    id: z.string().regex(/^lp_[0-9a-f]{64}$/),
    representative_packet_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .describe(
        "Packet of the latest matching RF observation; a logical message can have several packet variants.",
      ),
    type: z.string(),
    channel: z.number().int().nullable(),
    channel_index: z.number().int().nullable(),
    channel_name: z.string().nullable(),
    sender: z.string().nullable(),
    destination: z.string().nullable(),
    encrypted: z.boolean(),
    text: z.string().nullable(),
    signature_valid: z.boolean().nullable(),
    iata: z
      .array(z.string())
      .describe("Canonical IATA evidence across every observation of this logical message."),
    observation_count: z
      .number()
      .int()
      .min(1)
      .describe("Total observation count for the logical message across all filters."),
    matched: logicalMessageMatchedSchema,
    reported_at: nullableIsoTimestamp,
    first_received_at: isoTimestamp,
    last_received_at: isoTimestamp,
  })
  .meta({
    id: "MeshCoreMessage",
    description: "One logical MeshCore message aggregated across all matching RF observations.",
  });
export type PublicMessage = z.output<typeof messageSchema>;

export const telemetryValueSchema = typedValueSchema.meta({
  id: "TelemetryValue",
});

export const telemetrySchema = z
  .object({
    id: z.string(),
    packet_sha256: z.string(),
    node: z.string().nullable(),
    metric: z.string(),
    value: telemetryValueSchema,
    unit: z.string().nullable(),
    channel: z.number().int().nullable(),
    iata: z.string().nullable(),
    reported_at: nullableIsoTimestamp,
    received_at: isoTimestamp,
  })
  .meta({
    id: "MeshCoreTelemetry",
    description:
      "Decoded MeshCore protocol telemetry. Data is limited because encrypted response payloads cannot currently be normalized.",
  });
export type PublicTelemetry = z.output<typeof telemetrySchema>;

export const traceSchema = z
  .object({
    id: z.string(),
    packet_sha256: z.string(),
    logical_id: z
      .string()
      .nullable()
      .describe("Groups the packet variants of the same logical transmission."),
    source_node: z.string().nullable(),
    observer: z.string().nullable().describe("The reporting observer's public key."),
    tag: z.string().nullable(),
    iata: z.string().nullable(),
    reported_at: nullableIsoTimestamp,
    received_at: isoTimestamp,
  })
  .meta({ id: "MeshCoreTrace" });
export type PublicTrace = z.output<typeof traceSchema>;

export const traceHopSchema = z
  .object({
    id: z.string(),
    index: z.number().int(),
    prefix_hex: z.string(),
    prefix_length_bytes: z.number().int(),
    snr: z.number().nullable(),
    resolved_node: z.string().nullable(),
    resolution_confidence: z.number().nullable(),
    resolution_status: z.enum(["resolved", "unresolved", "ambiguous"]),
    candidates: z.array(z.object({ public_key: z.string(), confidence: z.number() })),
  })
  .meta({
    id: "TraceHop",
    description: "Ordered trace hop with ambiguity-aware prefix candidates.",
  });
export type PublicTraceHop = z.output<typeof traceHopSchema>;

export const regionSchema = z
  .object({
    region: z.string().describe("Canonical lowercase scope identifier."),
    name: z.string().describe("Administrative name, or the scope itself when unregistered."),
    first_seen: nullableIsoTimestamp,
    last_seen: nullableIsoTimestamp,
    manually_added: z.boolean(),
    observation_count: z.number().int().min(0),
    node_count: z.number().int().min(0),
    observer_count: z.number().int().min(0),
    last_activity: nullableIsoTimestamp,
    links: z.record(z.string(), z.string()),
  })
  .meta({
    id: "MeshCoreRegion",
    description: "Logical MeshCore region from the public registry, distinct from IATA.",
  });
export type PublicRegion = z.output<typeof regionSchema>;

const iataSummarySchema = z
  .object({
    node_count: z.number().int().min(0),
    observer_count: z.number().int().min(0),
    observation_count: z.number().int().min(0),
    last_activity: nullableIsoTimestamp,
  })
  .meta({ id: "IataSummary" });

export const iataEntrySchema = z
  .object({
    code: z.string(),
    name: z.string().nullable(),
    type: z.enum(["primary", "secondary"]),
    primary_code: z.string(),
    summary: iataSummarySchema.optional(),
    links: z.record(z.string(), z.string()).optional(),
  })
  .meta({ id: "MeshCoreIata", description: "Configured geographic MQTT ingress mapping." });
export type PublicIataEntry = z.output<typeof iataEntrySchema>;

export const neighborSchema = z
  .object({
    public_key: z.string(),
    node: z.object({
      name: z.string().nullable(),
      role: z.string().nullable(),
    }),
    relationship: z.enum(["reported", "reciprocal"]),
    direction: z.enum(["outbound", "inbound", "both"]),
    last_heard: nullableIsoTimestamp,
    signal: z.object({
      snr: z.number().nullable(),
      rssi: z.number().nullable(),
    }),
    regions: z.array(z.string()),
    evidence: z.object({
      report_count: z.number().int().min(1),
      observer_count: z.number().int().min(1),
    }),
  })
  .meta({ id: "MeshCoreNeighbor" });
export type PublicNeighbor = z.output<typeof neighborSchema>;

export const advertSchema = z
  .object({
    id: z.string(),
    node: z.string(),
    packet_sha256: z.string().nullable(),
    advert_timestamp: z.string().nullable(),
    observed_at: nullableIsoTimestamp,
    name: z.string().nullable(),
    role: z.string().nullable().describe("Lowercase MeshCore domain role."),
    location: locationSchema,
    flags: z.number().int().nullable(),
    signature_valid: z.boolean().nullable(),
    verified: z.boolean(),
    verification_error: z.string().nullable(),
  })
  .meta({ id: "MeshCoreAdvert" });
export type PublicAdvert = z.output<typeof advertSchema>;

export const sightingSchema = z
  .object({
    id: z.string(),
    node: z.string(),
    observer: z.string(),
    iata: z.string(),
    type: z.string(),
    received_at: nullableIsoTimestamp,
  })
  .meta({ id: "MeshCoreSighting" });
export type PublicSighting = z.output<typeof sightingSchema>;

export const observerMetricSchema = z
  .object({
    id: z.string(),
    observer: z.string(),
    metric: z.string(),
    value: telemetryValueSchema,
    unit: z.string().nullable(),
    reported_at: nullableIsoTimestamp,
    received_at: isoTimestamp,
  })
  .meta({ id: "MeshCoreMetric" });
export type PublicObserverMetric = z.output<typeof observerMetricSchema>;

export const observerStatusSchema = z
  .object({
    id: z.string(),
    observer: z.string(),
    iata: z.string(),
    reported_at: nullableIsoTimestamp,
    received_at: isoTimestamp,
    origin: z.string().nullable(),
    model: z.string().nullable(),
    firmware_version: z.string().nullable(),
  })
  .meta({ id: "ObserverStatus" });
export type PublicObserverStatus = z.output<typeof observerStatusSchema>;

export const packetPathHopSchema = z
  .object({
    index: z.number().int(),
    prefix_hex: z.string(),
    prefix_length_bytes: z.number().int(),
    resolved_node: z.string().nullable(),
    resolution_status: z.string(),
    resolution_confidence: z.number().nullable(),
  })
  .meta({ id: "PacketPathHop" });

export const packetObservationSchema = z
  .object({
    id: z.string(),
    packet_sha256: z.string(),
    observer: z.string(),
    iata: z.string(),
    received_at: isoTimestamp,
    reported_at: nullableIsoTimestamp,
    signal: z.object({
      rssi: z.number().nullable(),
      snr: z.number().nullable(),
      score: z.number().nullable(),
    }),
    direction: z.string().nullable(),
    path: z.array(packetPathHopSchema),
  })
  .meta({
    id: "PacketObservation",
    description: "Public RF observation; private MQTT envelope fields are excluded.",
  });
export type PublicPacketObservation = z.output<typeof packetObservationSchema>;

export const statsSchema = z
  .object({
    nodes: z.object({
      known: z.number().int().min(0),
      active_24h: z.number().int().min(0),
    }),
    observers: z.object({
      known: z.number().int().min(0),
      active: z.number().int().min(0),
      active_window_seconds: z.number(),
    }),
    regions: z
      .object({
        configured: z.number().int().min(0),
        observed: z
          .number()
          .int()
          .min(0)
          .describe(
            "`configured` counts the public region catalog; `observed` counts catalog regions with any scope evidence.",
          ),
      })
      .describe("Region registry counters."),
    active_iata: z.number().int().min(0),
    activity: z.object({
      packets_24h: z
        .number()
        .int()
        .min(0)
        .describe("Distinct packet hashes observed during the trailing 24 hours."),
      messages_24h: z
        .number()
        .int()
        .min(0)
        .describe("Distinct logical MeshCore messages observed during the trailing 24 hours."),
      last_seen: nullableIsoTimestamp,
    }),
  })
  .meta({ id: "MeshCoreStats", description: "Current network statistics." });
export type PublicStats = z.output<typeof statsSchema>;

export const activityBucketSchema = z
  .object({
    bucket_at: isoTimestamp,
    observations: z.number().int().min(0),
    packets: z.number().int().min(0),
    messages: z.number().int().min(0),
  })
  .meta({ id: "ActivityBucket" });
export type PublicActivityBucket = z.output<typeof activityBucketSchema>;

// Discovery ------------------------------------------------------------------

export const sourceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    status: z.string(),
    api_version: z.string(),
    url: z.string(),
    documentation_url: z.string(),
    data_availability: z.record(
      z.string(),
      z.object({ status: z.string(), description: z.string() }),
    ),
    capabilities: z.array(z.string()),
  })
  .meta({ id: "Source" });

export const meshCoreOverviewSchema = sourceSchema
  .extend({
    resources: z.record(z.string(), z.string()),
  })
  .meta({ id: "MeshCoreOverview" });

// System ----------------------------------------------------------------------

export const rootDataSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    release_id: z.string(),
    access: z.string(),
    api: z.string(),
    sources: z.string(),
    swagger: z.string(),
    openapi: z.string(),
    documentation_content: z.string(),
  })
  .meta({ id: "RootInfo" });

export const healthDataSchema = z.object({ status: z.literal("ok") }).meta({ id: "HealthData" });

export const readyDataSchema = z
  .object({
    status: z.literal("ready"),
    database: z.literal("ready"),
    docs: z.enum(["fresh", "stale", "unavailable"]),
    release_id: z.string(),
    schema_version: z.number().int(),
    schema_hash: z.string(),
  })
  .meta({ id: "ReadyData" });

// Documentation ----------------------------------------------------------------

const docsMetadataShape = {
  repository: z.string(),
  ref: z.string().nullable(),
  commit: z.string().nullable(),
  status: z.enum(["fresh", "stale", "unavailable"]),
};

export const docFileSchema = z
  .object({
    path: z.string(),
    title: z.string().nullable(),
    media_type: z.enum(["text/markdown", "application/yaml"]),
    size: z.number().int(),
  })
  .meta({ id: "DocFile" });

export const docsListDataSchema = z
  .object({
    ...docsMetadataShape,
    files: z.array(docFileSchema),
  })
  .meta({ id: "DocsList" });

export const docsSearchResultSchema = docFileSchema
  .extend({
    snippet: z.string(),
  })
  .meta({ id: "DocsSearchResult" });

export const docsSearchResponseSchema = z
  .object({
    query: z.string(),
    limit: z.number().int(),
    returned: z.number().int(),
    total_matches: z.number().int(),
    scan_complete: z.boolean(),
    truncated: z.boolean(),
    results: z.array(docsSearchResultSchema),
  })
  .meta({ id: "DocsSearchResponse" });

export const docContentDataSchema = z
  .object({
    path: z.string(),
    media_type: z.enum(["text/markdown", "application/yaml"]),
    content: z.string(),
    encoding: z.literal("utf-8"),
    source: z.object({
      repository: z.string(),
      ref: z.string().nullable(),
      commit: z.string().nullable(),
    }),
  })
  .meta({ id: "DocContent" });

// Registry ---------------------------------------------------------------------

// Registering with stable IDs lets the official OpenAPI transform emit
// reusable components instead of duplicating large object schemas per route.
const REGISTRY: Record<string, z.ZodType> = {
  Pagination: paginationSchema,
  ErrorEnvelope: errorEnvelopeSchema,
  Location: locationSchema,
  TelemetryValue: telemetryValueSchema,
  LogicalMessageMatched: logicalMessageMatchedSchema,
  PacketPathHop: packetPathHopSchema,
  MeshCoreNode: nodeSchema,
  MeshCoreObserver: observerSchema,
  MeshCorePacket: packetSchema,
  MeshCoreMessage: messageSchema,
  MeshCoreTelemetry: telemetrySchema,
  MeshCoreTrace: traceSchema,
  TraceHop: traceHopSchema,
  MeshCoreRegion: regionSchema,
  MeshCoreIata: iataEntrySchema,
  MeshCoreNeighbor: neighborSchema,
  MeshCoreAdvert: advertSchema,
  MeshCoreSighting: sightingSchema,
  MeshCoreMetric: observerMetricSchema,
  ObserverStatus: observerStatusSchema,
  PacketObservation: packetObservationSchema,
  MeshCoreStats: statsSchema,
  ActivityBucket: activityBucketSchema,
  Source: sourceSchema,
  MeshCoreOverview: meshCoreOverviewSchema,
  RootInfo: rootDataSchema,
  HealthData: healthDataSchema,
  ReadyData: readyDataSchema,
  DocFile: docFileSchema,
  DocsList: docsListDataSchema,
  DocsSearchResult: docsSearchResultSchema,
  DocsSearchResponse: docsSearchResponseSchema,
  DocContent: docContentDataSchema,
};
// Idempotent: Bun evaluates this module once per test file, and the global
// registry rejects duplicate IDs.
for (const [id, schema] of Object.entries(REGISTRY)) {
  try {
    z.globalRegistry.add(schema, { id });
  } catch {
    // Already registered with the same stable ID.
  }
}

// Derived handler-facing types -----------------------------------------------

export type ReadyData = z.output<typeof readyDataSchema>;
export type DocsList = z.output<typeof docsListDataSchema>;
export type RootInfo = z.output<typeof rootDataSchema>;
export type HealthData = z.output<typeof healthDataSchema>;
