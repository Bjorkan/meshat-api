import { z } from "zod/v4";
import { getIata } from "./iata.js";
import { normalizeRegionScope } from "./region-scopes.js";
import type { AppConfig } from "./config.js";

/**
 * Single source of truth for REST request contracts: querystrings and path
 * parameters. Fastify validates these through @fastify/type-provider-zod,
 * so the compiled validators, the TypeScript handler inputs, and the
 * OpenAPI document all come from this module.
 *
 * Every conditional fragment here keeps the exact wire behavior of the
 * previous AJV+parse combination: strict unknown-parameter rejection,
 * canonicalizing transforms, cross-field refinements, and bounded limits.
 */

export const publicKeySchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/)
  .transform((value) => value.toUpperCase());
export const hashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase());
export const logicalIdSchema = z
  .string()
  .regex(/^lp_[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase());
export const idSchema = z.string().regex(/^\d+$/);
export const messageIdSchema = logicalIdSchema;
export const iataSchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());
export const regionParamSchema = z.string().trim().min(1).max(100);
export const wildcardPathSchema = z.object({ "*": z.string().min(1) });

export const iataFilterSchema = iataSchema.transform((code, context) => {
  const entry = getIata(code);
  if (!entry) {
    context.addIssue({ code: "custom", message: "IATA code is not configured" });
    return z.NEVER;
  }
  return entry.primary_code;
});
export const regionFilterSchema = z.string().trim().min(1).max(100).transform(normalizeRegionScope);
export const booleanQuerySchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");
export const dateQuerySchema = z.iso
  .datetime({ offset: true })
  .transform((value) => Date.parse(value));
export const orderQuerySchema = z.enum(["asc", "desc"]).default("desc");
export const cursorQuerySchema = z.string().min(1).max(4096).optional();
export const limitQuerySchema = (fallback: number, maximum: number) =>
  z.coerce.number().int().min(1).max(maximum).default(fallback);

function refineGeo(
  value: { near_lat?: number; near_lon?: number; radius_km?: number },
  context: z.RefinementCtx,
): void {
  const count = [value.near_lat, value.near_lon, value.radius_km].filter(
    (item) => item !== undefined,
  ).length;
  if (count !== 0 && count !== 3)
    context.addIssue({
      code: "custom",
      message: "near_lat, near_lon, and radius_km must be supplied together",
    });
}

function refineSeenRange(
  value: { seen_from?: number; seen_to?: number },
  context: z.RefinementCtx,
): void {
  refineTimeRange(value.seen_from, value.seen_to, "seen", context);
}

function refineReceivedRange(
  value: { received_from?: number; received_to?: number },
  context: z.RefinementCtx,
): void {
  refineTimeRange(value.received_from, value.received_to, "received", context);
}

function refineTimeRange(
  from: number | undefined,
  to: number | undefined,
  name: string,
  context: z.RefinementCtx,
): void {
  if (from !== undefined && to !== undefined && from > to)
    context.addIssue({
      code: "custom",
      message: `${name}_from must not be later than ${name}_to`,
    });
}

// Shared parameter objects -------------------------------------------------

export const publicKeyParams = z.object({ public_key: publicKeySchema });
export const hashParams = z.object({ sha256: hashSchema });
export const idParams = z.object({ id: idSchema });
export const messageIdParams = z.object({ id: messageIdSchema });
export const regionParams = z.object({ region: regionFilterSchema });
export const iataParams = z.object({ code: iataSchema });

// Per-endpoint queries ------------------------------------------------------

export function docsSearchQuery() {
  return z.strictObject({
    q: z.string().trim().min(1).max(200).describe("Case-insensitive documentation search text."),
    limit: limitQuerySchema(20, 50),
  });
}

export function pageQuery(config: AppConfig) {
  return z.strictObject({
    limit: limitQuerySchema(config.defaultLimit, config.maxLimit).describe(
      "Bounded number of records to return.",
    ),
    cursor: cursorQuerySchema.describe("Opaque stateless continuation cursor."),
    order: orderQuerySchema.describe("Sort direction."),
  });
}

export function nodeQuery(config: AppConfig) {
  return z
    .strictObject({
      name: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe("Case-insensitive literal name substring."),
      role: z.string().trim().min(1).max(50).optional().describe("Case-insensitive MeshCore role."),
      region: regionFilterSchema
        .optional()
        .describe("Logical MeshCore neighbor region, distinct from IATA."),
      iata: iataFilterSchema.optional().describe("Three-letter geographic MQTT ingress code."),
      seen_from: dateQuerySchema
        .optional()
        .describe("Inclusive lower last-seen timestamp in ISO 8601 format."),
      seen_to: dateQuerySchema
        .optional()
        .describe("Inclusive upper last-seen timestamp in ISO 8601 format."),
      near_lat: z.coerce
        .number()
        .min(-90)
        .max(90)
        .optional()
        .describe("Radius-search center latitude."),
      near_lon: z.coerce
        .number()
        .min(-180)
        .max(180)
        .optional()
        .describe("Radius-search center longitude."),
      radius_km: z.coerce
        .number()
        .positive()
        .max(1000)
        .optional()
        .describe("Maximum geography radius in kilometres."),
      sort: z
        .enum(["last_seen", "first_seen", "name", "role"])
        .default("last_seen")
        .describe("Allowlisted deterministic sort field."),
      order: orderQuerySchema.describe("Sort direction."),
      limit: limitQuerySchema(config.defaultLimit, config.maxLimit).describe(
        "Bounded number of records to return.",
      ),
      cursor: cursorQuerySchema.describe("Opaque stateless continuation cursor."),
    })
    .superRefine(refineGeo)
    .superRefine(refineSeenRange);
}

export function observerQuery(config: AppConfig) {
  return z
    .strictObject({
      active: booleanQuerySchema
        .optional()
        .describe("Recent observer ingest activity within the configured activity window."),
      name: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe("Case-insensitive literal name substring."),
      iata: iataFilterSchema.optional().describe("Three-letter geographic MQTT ingress code."),
      region: regionFilterSchema
        .optional()
        .describe("Logical MeshCore neighbor region, distinct from IATA."),
      seen_from: dateQuerySchema
        .optional()
        .describe("Inclusive lower last-seen timestamp in ISO 8601 format."),
      seen_to: dateQuerySchema
        .optional()
        .describe("Inclusive upper last-seen timestamp in ISO 8601 format."),
      near_lat: z.coerce
        .number()
        .min(-90)
        .max(90)
        .optional()
        .describe("Radius-search center latitude."),
      near_lon: z.coerce
        .number()
        .min(-180)
        .max(180)
        .optional()
        .describe("Radius-search center longitude."),
      radius_km: z.coerce
        .number()
        .positive()
        .max(1000)
        .optional()
        .describe("Maximum geography radius in kilometres."),
      sort: z
        .enum(["last_seen", "first_seen", "name"])
        .default("last_seen")
        .describe("Allowlisted deterministic sort field."),
      order: orderQuerySchema.describe("Sort direction."),
      limit: limitQuerySchema(config.defaultLimit, config.maxLimit).describe(
        "Bounded number of records to return.",
      ),
      cursor: cursorQuerySchema.describe("Opaque stateless continuation cursor."),
    })
    .superRefine(refineGeo)
    .superRefine(refineSeenRange);
}

export function regionQuery(config: AppConfig) {
  return z.strictObject({
    observed_only: booleanQuerySchema
      .optional()
      .describe("Keep only regions with retained scope evidence."),
    manually_added: booleanQuerySchema
      .optional()
      .describe("Select the built-in Swedish region catalog."),
    prefix: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Region prefix filter; Swedish se/seXX/seXXXX codes are normalized to lowercase before matching.",
      )
      .transform((value) => (value === undefined ? undefined : normalizeRegionScope(value))),
    limit: limitQuerySchema(config.defaultLimit, config.maxLimit).describe(
      "Bounded number of records to return.",
    ),
    cursor: cursorQuerySchema.describe("Opaque stateless continuation cursor."),
  });
}

export function packetQuery(config: AppConfig) {
  return z
    .strictObject({
      hash: hashSchema.optional().describe("Exact packet SHA-256 hash."),
      logical_id: logicalIdSchema
        .optional()
        .describe(
          "Exact route-independent logical packet identity, lp_ followed by 64 hex characters.",
        ),
      packet_type: z
        .string()
        .trim()
        .min(1)
        .max(50)
        .optional()
        .describe("Decoded MeshCore packet type."),
      payload_type: z
        .string()
        .trim()
        .min(1)
        .max(50)
        .optional()
        .describe("Decoded MeshCore payload type."),
      route_type: z
        .string()
        .trim()
        .min(1)
        .max(50)
        .optional()
        .describe("Decoded MeshCore route type."),
      decode_status: z.string().trim().min(1).max(50).optional().describe("Packet decode status."),
      node: publicKeySchema.optional().describe("Exact node public key."),
      observer: publicKeySchema.optional().describe("Exact observer public key."),
      iata: iataFilterSchema.optional().describe("Three-letter geographic MQTT ingress code."),
      received_from: dateQuerySchema
        .optional()
        .describe("Inclusive lower received timestamp in ISO 8601 format."),
      received_to: dateQuerySchema
        .optional()
        .describe("Inclusive upper received timestamp in ISO 8601 format."),
      sort: z
        .enum(["received_at", "first_seen"])
        .default("received_at")
        .describe("Allowlisted deterministic sort field."),
      order: orderQuerySchema.describe("Sort direction."),
      limit: limitQuerySchema(config.defaultLimit, config.maxLimit).describe(
        "Bounded number of records to return.",
      ),
      cursor: cursorQuerySchema.describe("Opaque stateless continuation cursor."),
    })
    .superRefine(refineReceivedRange);
}

export function messageQuery(config: AppConfig) {
  return z
    .strictObject({
      sender: publicKeySchema.optional().describe("Exact resolved sender public key."),
      destination: publicKeySchema.optional().describe("Exact resolved destination public key."),
      channel: z.string().max(100).optional().describe("Exact public channel identifier."),
      channel_name: z
        .string()
        .max(100)
        .optional()
        .describe("Exact configured public channel name."),
      message_type: z.string().max(50).optional().describe("Decoded message type."),
      encrypted: booleanQuerySchema
        .optional()
        .describe("Whether the message payload remains encrypted."),
      signature_valid: booleanQuerySchema.optional().describe("Verified signature state."),
      iata: iataFilterSchema.optional().describe("Three-letter geographic MQTT ingress code."),
      received_from: dateQuerySchema
        .optional()
        .describe("Inclusive lower received timestamp in ISO 8601 format."),
      received_to: dateQuerySchema
        .optional()
        .describe("Inclusive upper received timestamp in ISO 8601 format."),
      sort: z.literal("received_at").default("received_at"),
      order: orderQuerySchema.describe("Sort direction."),
      limit: limitQuerySchema(config.messageDefaultLimit, config.messageMaxLimit).describe(
        "Bounded number of records to return.",
      ),
      cursor: cursorQuerySchema.describe("Opaque stateless continuation cursor."),
    })
    .superRefine(refineReceivedRange);
}

export function telemetryQuery(config: AppConfig) {
  return z
    .strictObject({
      node: publicKeySchema.optional().describe("Exact node public key."),
      metric: z.string().trim().min(1).max(100).optional().describe("Exact telemetry metric name."),
      iata: iataFilterSchema.optional().describe("Three-letter geographic MQTT ingress code."),
      received_from: dateQuerySchema
        .optional()
        .describe("Inclusive lower received timestamp in ISO 8601 format."),
      received_to: dateQuerySchema
        .optional()
        .describe("Inclusive upper received timestamp in ISO 8601 format."),
      sort: z.literal("received_at").default("received_at"),
      order: orderQuerySchema.describe("Sort direction."),
      limit: limitQuerySchema(config.defaultLimit, config.maxLimit).describe(
        "Bounded number of records to return.",
      ),
      cursor: cursorQuerySchema.describe("Opaque stateless continuation cursor."),
    })
    .superRefine(refineReceivedRange);
}

export function traceQuery(config: AppConfig) {
  return z
    .strictObject({
      source_node: publicKeySchema.optional().describe("Exact node public key."),
      tag: z.string().trim().min(1).max(100).optional().describe("Exact trace tag."),
      iata: iataFilterSchema.optional().describe("Three-letter geographic MQTT ingress code."),
      received_from: dateQuerySchema
        .optional()
        .describe("Inclusive lower received timestamp in ISO 8601 format."),
      received_to: dateQuerySchema
        .optional()
        .describe("Inclusive upper received timestamp in ISO 8601 format."),
      sort: z.literal("received_at").default("received_at"),
      order: orderQuerySchema.describe("Sort direction."),
      limit: limitQuerySchema(config.defaultLimit, config.maxLimit).describe(
        "Bounded number of records to return.",
      ),
      cursor: cursorQuerySchema.describe("Opaque stateless continuation cursor."),
    })
    .superRefine(refineReceivedRange);
}

export const ACTIVITY_WINDOWS = {
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
} as const;
export const ACTIVITY_INTERVALS = {
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "6h": 21_600_000,
  "1d": 86_400_000,
} as const;

export function activityQuery() {
  return z.strictObject({
    window: z
      .enum(["1h", "6h", "24h", "7d", "30d"])
      .default("24h")
      .describe("Allowlisted trailing activity window."),
    interval: z
      .enum(["5m", "15m", "1h", "6h", "1d"])
      .default("1h")
      .describe("Allowlisted activity bucket interval."),
    iata: iataFilterSchema.optional().describe("Three-letter geographic MQTT ingress code."),
  });
}

// Handler-facing output types (post-validation, post-transform) ------------

export type PageQuery = z.output<ReturnType<typeof pageQuery>>;
export type DocsSearchQuery = z.output<ReturnType<typeof docsSearchQuery>>;
export type NodeQuery = z.output<ReturnType<typeof nodeQuery>>;
export type ObserverQuery = z.output<ReturnType<typeof observerQuery>>;
export type RegionQuery = z.output<ReturnType<typeof regionQuery>>;
export type PacketQuery = z.output<ReturnType<typeof packetQuery>>;
export type MessageQuery = z.output<ReturnType<typeof messageQuery>>;
export type TelemetryQuery = z.output<ReturnType<typeof telemetryQuery>>;
export type TraceQuery = z.output<ReturnType<typeof traceQuery>>;
export type ActivityQuery = z.output<ReturnType<typeof activityQuery>>;
