import type {
  PublicAdvert,
  PublicMessage,
  PublicNeighbor,
  PublicNode,
  PublicObserver,
  PublicObserverMetric,
  PublicObserverStatus,
  PublicPacket,
  PublicPacketObservation,
  PublicSighting,
  PublicTelemetry,
  PublicTrace,
  PublicTraceHop,
} from "./contracts.js";

type Row = Record<string, unknown>;

export function isoTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const number =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" || typeof value === "number"
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(number) ? new Date(number).toISOString() : null;
}

export function safeId(value: unknown): string {
  return str(value);
}

/** Deterministic, injection-safe stringification for public text fields. */
function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  if (value == null) return "";
  return JSON.stringify(value);
}

function strOrNull(value: unknown): string | null {
  if (value == null || typeof value === "object") return null;
  return str(value);
}

export function safeCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error("Database count is outside the safe integer range");
  return count;
}

export function normalizedRole(value: unknown): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

export function location(
  latitude: unknown,
  longitude: unknown,
): { latitude: number; longitude: number } | null {
  if (latitude === null || longitude === null) return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { latitude: lat, longitude: lon } : null;
}

export function aggregateNeighbors(rows: Row[]): PublicNeighbor[] {
  const relationships = new Map<
    string,
    {
      public_key: string;
      node: { name: string | null; role: string | null };
      outbound: boolean;
      inbound: boolean;
      last_heard: string | null;
      signal: { snr: number | null; rssi: number | null };
      regions: Set<string>;
      reporters: Set<string>;
      reports: number;
    }
  >();
  for (const row of rows) {
    const key = str(row.counterpart_public_key);
    const item = relationships.get(key) ?? {
      public_key: key,
      node: {
        name: row.latest_name == null ? null : str(row.latest_name),
        role: normalizedRole(row.latest_role),
      },
      outbound: false,
      inbound: false,
      last_heard: null as string | null,
      signal: { snr: null as number | null, rssi: null as number | null },
      regions: new Set<string>(),
      reporters: new Set<string>(),
      reports: 0,
    };
    item.outbound ||= row.direction === "outbound";
    item.inbound ||= row.direction === "inbound";
    const heard = isoTime(row.last_heard_at_ms ?? row.received_at_ms);
    if (heard && (!item.last_heard || heard > item.last_heard)) {
      item.last_heard = heard;
      item.signal = {
        snr: row.snr == null ? null : Number(row.snr),
        rssi: row.rssi == null ? null : Number(row.rssi),
      };
    }
    for (const region of stringArray(row.regions)) item.regions.add(region);
    item.reporters.add(str(row.reporting_observer));
    item.reports += 1;
    relationships.set(key, item);
  }
  return [...relationships.values()].map((item) => ({
    public_key: item.public_key,
    node: item.node,
    relationship: item.outbound && item.inbound ? "reciprocal" : "reported",
    direction: item.outbound && item.inbound ? "both" : item.outbound ? "outbound" : "inbound",
    last_heard: item.last_heard,
    signal: item.signal,
    regions: [...item.regions].sort(),
    evidence: { report_count: item.reports, observer_count: item.reporters.size },
  }));
}

export function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function typedValue(row: Row): PublicTelemetry["value"] {
  if (row.numeric_value !== null && row.numeric_value !== undefined)
    return { type: "number", value: Number(row.numeric_value) };
  if (row.boolean_value !== null && row.boolean_value !== undefined)
    return { type: "boolean", value: Boolean(row.boolean_value) };
  return {
    type: "string",
    value: typeof row.text_value === "string" ? row.text_value : null,
  };
}

export function mapNode(row: Row): PublicNode {
  return {
    public_key: str(row.public_key),
    owner_public_key: strOrNull(row.owner_public_key),
    name: strOrNull(row.latest_name),
    role: normalizedRole(row.latest_role),
    location: location(row.latest_latitude, row.latest_longitude),
    first_seen: isoTime(row.first_seen_at_ms) ?? "",
    last_seen: isoTime(row.last_seen_at_ms) ?? "",
    iata: stringArray(row.iata),
    regions: stringArray(row.regions),
  };
}

export function mapObserver(row: Row): PublicObserver {
  return {
    public_key: str(row.public_key),
    name:
      row.label == null ? (row.latest_name == null ? null : str(row.latest_name)) : str(row.label),
    active: Boolean(row.active),
    iata: row.iata == null ? null : str(row.iata),
    regions: stringArray(row.regions),
    location: location(row.latest_latitude, row.latest_longitude),
    first_seen: isoTime(row.first_seen_at_ms) ?? "",
    last_seen: isoTime(row.last_seen_at_ms) ?? "",
  };
}

export function mapPacket(row: Row): PublicPacket {
  const blob = row.raw_packet_blob;
  const raw = Buffer.isBuffer(blob)
    ? `0x${blob.toString("hex")}`
    : blob == null
      ? "0x"
      : `0x${str(blob)}`;
  return {
    sha256: str(row.packet_sha256),
    logical_id: row.logical_packet_id == null ? null : str(row.logical_packet_id),
    packet_type: row.packet_type == null ? null : str(row.packet_type),
    payload_type: row.payload_type == null ? null : str(row.payload_type),
    route_type: row.route_type == null ? null : str(row.route_type),
    decode_status: str(row.decode_status),
    raw,
    first_seen: isoTime(row.first_seen_at_ms) ?? "",
    last_seen: isoTime(row.last_seen_at_ms) ?? "",
  };
}

export function mapMessage(row: Row): PublicMessage {
  return {
    id: safeId(row.logical_id),
    representative_packet_sha256: str(row.packet_sha256),
    type: str(row.message_type),
    channel: strOrNull(row.channel),
    channel_index: row.channel_index == null ? null : Number(row.channel_index),
    channel_name: row.channel_name == null ? null : str(row.channel_name),
    sender: row.sender_public_key == null ? null : str(row.sender_public_key),
    destination: row.destination_public_key == null ? null : str(row.destination_public_key),
    encrypted: Boolean(row.encrypted),
    text: strOrNull(row.text),
    signature_valid: row.signature_valid == null ? null : Boolean(row.signature_valid),
    iata: stringArray(row.all_iata),
    observation_count: safeCount(row.total_observation_count),
    matched: {
      iata: stringArray(row.matched_iata),
      observation_count: safeCount(row.matched_observation_count),
    },
    reported_at: isoTime(row.reported_at_ms),
    first_received_at: isoTime(row.first_received_at_ms) ?? "",
    last_received_at: isoTime(row.last_received_at_ms) ?? "",
  };
}

export function mapTelemetry(row: Row): PublicTelemetry {
  return {
    id: safeId(row.id),
    packet_sha256: str(row.packet_sha256),
    node: row.node_public_key == null ? null : str(row.node_public_key),
    metric: str(row.metric_name),
    value: typedValue(row),
    unit: row.unit == null ? null : str(row.unit),
    channel: strOrNull(row.channel),
    iata: row.iata == null ? null : str(row.iata),
    reported_at: isoTime(row.reported_at_ms),
    received_at: isoTime(row.received_at_ms) ?? "",
  };
}

export function mapTrace(row: Row): PublicTrace {
  return {
    id: safeId(row.id),
    packet_sha256: str(row.packet_sha256),
    logical_id: row.logical_id == null ? null : str(row.logical_id),
    source_node: row.source_node_public_key == null ? null : str(row.source_node_public_key),
    observer: row.observer == null ? null : str(row.observer),
    tag: row.tag == null ? null : str(row.tag),
    iata: row.iata == null ? null : str(row.iata),
    reported_at: isoTime(row.reported_at_ms),
    received_at: isoTime(row.received_at_ms) ?? "",
  };
}

export function mapAdvert(row: Row): PublicAdvert {
  return {
    id: safeId(row.id),
    node: str(row.node_public_key),
    packet_sha256: row.packet_sha256 == null ? null : str(row.packet_sha256),
    advert_timestamp: typeof row.advert_timestamp === "string" ? row.advert_timestamp : null,
    observed_at: isoTime(row.first_observed_at_ms),
    name: row.name == null ? null : str(row.name),
    role: normalizedRole(row.role),
    location: location(row.latitude, row.longitude),
    flags: row.flags == null ? null : Number(row.flags),
    signature_valid: row.signature_valid == null ? null : Boolean(row.signature_valid),
    verified: Boolean(row.verified),
    verification_error: row.verification_error == null ? null : str(row.verification_error),
  };
}

export function mapSighting(row: Row): PublicSighting {
  return {
    id: safeId(row.id),
    node: str(row.node_public_key),
    observer: str(row.observer_public_key),
    iata: str(row.iata),
    type: str(row.sighting_type),
    received_at: isoTime(row.received_at_ms),
  };
}

export function mapObserverMetric(row: Row): PublicObserverMetric {
  return {
    id: safeId(row.id),
    observer: str(row.observer_public_key),
    metric: str(row.metric_name),
    value: typedValue(row),
    unit: row.unit == null ? null : str(row.unit),
    reported_at: isoTime(row.reported_at_ms),
    received_at: isoTime(row.received_at_ms) ?? "",
  };
}

export function mapObserverStatus(row: Row): PublicObserverStatus {
  return {
    id: safeId(row.id),
    observer: str(row.observer_public_key),
    iata: str(row.iata),
    reported_at: isoTime(row.reported_at_ms),
    received_at: isoTime(row.received_at_ms) ?? "",
    origin: row.origin == null ? null : str(row.origin),
    model: row.model == null ? null : str(row.model),
    firmware_version: row.firmware_version == null ? null : str(row.firmware_version),
  };
}

export function mapPacketObservation(row: Row): PublicPacketObservation {
  return {
    id: safeId(row.id),
    packet_sha256: str(row.packet_sha256),
    observer: str(row.observer),
    iata: str(row.iata),
    received_at: isoTime(row.received_at_ms) ?? "",
    reported_at: isoTime(row.reported_at_ms),
    signal: {
      rssi: row.rssi == null ? null : Number(row.rssi),
      snr: row.snr == null ? null : Number(row.snr),
      score: row.score == null ? null : Number(row.score),
    },
    direction: row.direction == null ? null : str(row.direction),
    path: Array.isArray(row.path)
      ? row.path.map((hop) => {
          const value = hop as Row;
          return {
            index: Number(value.index),
            prefix_hex: str(value.prefix_hex),
            prefix_length_bytes: Number(value.prefix_length_bytes),
            resolved_node: value.resolved_node == null ? null : str(value.resolved_node),
            resolution_status: str(value.resolution_status),
            resolution_confidence:
              value.resolution_confidence == null ? null : Number(value.resolution_confidence),
          };
        })
      : [],
  };
}

export function mapTraceHop(row: Row): PublicTraceHop {
  const candidates = Array.isArray(row.candidates) ? row.candidates : [];
  const resolved = row.resolved_node ?? null;
  let status: PublicTraceHop["resolution_status"] = "unresolved";
  if (resolved !== null) status = "resolved";
  else if (candidates.length > 1) status = "ambiguous";
  return {
    id: safeId(row.id),
    index: Number(row.index),
    prefix_hex: str(row.prefix_hex),
    prefix_length_bytes: Number(row.prefix_length_bytes),
    snr: row.snr == null ? null : Number(row.snr),
    resolved_node: resolved == null ? null : str(resolved),
    resolution_confidence:
      row.resolution_confidence == null ? null : Number(row.resolution_confidence),
    resolution_status: status,
    candidates: candidates.map((candidate) => {
      const entry = candidate as Row;
      return { public_key: str(entry.public_key), confidence: Number(entry.confidence) };
    }),
  };
}
