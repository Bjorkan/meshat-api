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
  return String(value);
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

export function location(latitude: unknown, longitude: unknown) {
  if (latitude === null || longitude === null) return null;
  const lat = Number(latitude);
  const lon = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { latitude: lat, longitude: lon } : null;
}

export function typedValue(row: Row) {
  if (row.numeric_value !== null && row.numeric_value !== undefined)
    return { type: "number", value: Number(row.numeric_value) };
  if (row.boolean_value !== null && row.boolean_value !== undefined)
    return { type: "boolean", value: Boolean(row.boolean_value) };
  return {
    type: "string",
    value: typeof row.text_value === "string" ? row.text_value : null,
  };
}

export function mapNode(row: Row) {
  return {
    public_key: row.public_key,
    owner_public_key: row.owner_public_key ?? null,
    name: row.latest_name ?? null,
    role: normalizedRole(row.latest_role),
    location: location(row.latest_latitude, row.latest_longitude),
    first_seen: isoTime(row.first_seen_at_ms),
    last_seen: isoTime(row.last_seen_at_ms),
    iata: stringArray(row.iata),
    regions: stringArray(row.regions),
  };
}

export function mapObserver(row: Row) {
  return {
    public_key: row.public_key,
    name: row.label ?? row.latest_name ?? null,
    active: Boolean(row.active),
    iata: row.iata ?? null,
    regions: stringArray(row.regions),
    location: location(row.latest_latitude, row.latest_longitude),
    first_seen: isoTime(row.first_seen_at_ms),
    last_seen: isoTime(row.last_seen_at_ms),
  };
}

export function mapPacket(row: Row) {
  return {
    sha256: row.packet_sha256,
    logical_id: row.logical_packet_id ?? null,
    packet_type: row.packet_type ?? null,
    payload_type: row.payload_type ?? null,
    route_type: row.route_type ?? null,
    decode_status: row.decode_status,
    raw: Buffer.isBuffer(row.raw_packet_blob)
      ? `0x${row.raw_packet_blob.toString("hex")}`
      : (row.raw_packet_blob ?? null),
    first_seen: isoTime(row.first_seen_at_ms),
    last_seen: isoTime(row.last_seen_at_ms),
  };
}

export function mapMessage(row: Row) {
  return {
    id: safeId(row.logical_id),
    representative_packet_sha256: row.packet_sha256,
    type: row.message_type,
    channel: row.channel ?? null,
    channel_index: row.channel_index ?? null,
    channel_name: row.channel_name ?? null,
    sender: row.sender_public_key ?? null,
    destination: row.destination_public_key ?? null,
    encrypted: Boolean(row.encrypted),
    text: row.text ?? null,
    signature_valid: row.signature_valid ?? null,
    iata: stringArray(row.all_iata),
    observation_count: safeCount(row.total_observation_count),
    matched: {
      iata: stringArray(row.matched_iata),
      observation_count: safeCount(row.matched_observation_count),
    },
    reported_at: isoTime(row.reported_at_ms),
    first_received_at: isoTime(row.first_received_at_ms),
    last_received_at: isoTime(row.last_received_at_ms),
  };
}

export function mapTelemetry(row: Row) {
  return {
    id: safeId(row.id),
    packet_sha256: row.packet_sha256,
    node: row.node_public_key ?? null,
    metric: row.metric_name,
    value: typedValue(row),
    unit: row.unit ?? null,
    channel: row.channel ?? null,
    iata: row.iata ?? null,
    reported_at: isoTime(row.reported_at_ms),
    received_at: isoTime(row.received_at_ms),
  };
}

export function mapTrace(row: Row) {
  return {
    id: safeId(row.id),
    packet_sha256: row.packet_sha256,
    logical_id: row.logical_id ?? null,
    source_node: row.source_node_public_key ?? null,
    observer: row.observer ?? null,
    tag: row.tag ?? null,
    iata: row.iata ?? null,
    reported_at: isoTime(row.reported_at_ms),
    received_at: isoTime(row.received_at_ms),
  };
}

export function mapAdvert(row: Row) {
  return {
    id: safeId(row.id),
    node: row.node_public_key,
    packet_sha256: row.packet_sha256 ?? null,
    advert_timestamp: typeof row.advert_timestamp === "string" ? row.advert_timestamp : null,
    observed_at: isoTime(row.first_observed_at_ms),
    name: row.name ?? null,
    role: normalizedRole(row.role),
    location: location(row.latitude, row.longitude),
    flags: row.flags ?? null,
    signature_valid: row.signature_valid ?? null,
    verified: Boolean(row.verified),
    verification_error: row.verification_error ?? null,
  };
}

export function mapSighting(row: Row) {
  return {
    id: safeId(row.id),
    node: row.node_public_key,
    observer: row.observer_public_key,
    iata: row.iata,
    type: row.sighting_type,
    received_at: isoTime(row.received_at_ms),
  };
}

export function mapObserverMetric(row: Row) {
  return {
    id: safeId(row.id),
    observer: row.observer_public_key,
    metric: row.metric_name,
    value: typedValue(row),
    unit: row.unit ?? null,
    reported_at: isoTime(row.reported_at_ms),
    received_at: isoTime(row.received_at_ms),
  };
}

export function mapObserverStatus(row: Row) {
  return {
    id: safeId(row.id),
    observer: row.observer_public_key,
    iata: row.iata,
    reported_at: isoTime(row.reported_at_ms),
    received_at: isoTime(row.received_at_ms),
    origin: row.origin ?? null,
    model: row.model ?? null,
    firmware_version: row.firmware_version ?? null,
  };
}

export function mapPacketObservation(row: Row) {
  return {
    id: safeId(row.id),
    packet_sha256: row.packet_sha256,
    observer: row.observer,
    iata: row.iata,
    received_at: isoTime(row.received_at_ms),
    reported_at: isoTime(row.reported_at_ms),
    signal: {
      rssi: row.rssi == null ? null : Number(row.rssi),
      snr: row.snr == null ? null : Number(row.snr),
      score: row.score == null ? null : Number(row.score),
    },
    direction: row.direction ?? null,
    path: Array.isArray(row.path)
      ? row.path.map((hop) => {
          const value = hop as Row;
          return {
            index: Number(value.index),
            prefix_hex: String(value.prefix_hex),
            prefix_length_bytes: Number(value.prefix_length_bytes),
            resolved_node: value.resolved_node ?? null,
            resolution_status: value.resolution_status,
            resolution_confidence:
              value.resolution_confidence == null ? null : Number(value.resolution_confidence),
          };
        })
      : [],
  };
}

export function mapHistory(row: Row): Row {
  const result: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("__") || key === "private_id") continue;
    if (key.endsWith("_at_ms")) result[key.slice(0, -3)] = isoTime(value);
    else if (key === "id") result.id = safeId(value);
    else if (typeof value === "bigint") result[key] = value.toString();
    else result[key] = value;
  }
  return result;
}

export function aggregateNeighbors(rows: Row[]) {
  const relationships = new Map<
    string,
    {
      public_key: string;
      node: { name: unknown; role: unknown };
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
    const key = String(row.counterpart_public_key);
    const item = relationships.get(key) ?? {
      public_key: key,
      node: {
        name: row.latest_name ?? null,
        role: normalizedRole(row.latest_role),
      },
      outbound: false,
      inbound: false,
      last_heard: null,
      signal: { snr: null, rssi: null },
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
    item.reporters.add(String(row.reporting_observer));
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
    evidence: {
      report_count: item.reports,
      observer_count: item.reporters.size,
    },
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
