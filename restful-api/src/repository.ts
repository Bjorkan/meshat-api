import type { QueryResultRow } from "pg";
import type {
  CursorKey,
  ListRequest,
  MeshcoreRepository,
  MessageFilters,
  NodeFilters,
  ObserverFilters,
  PacketFilters,
  Page,
  TelemetryFilters,
  TraceFilters,
} from "./domain.js";
import {
  isoTime,
  mapAdvert,
  mapHistory,
  mapMessage,
  mapNode,
  mapObserver,
  mapObserverMetric,
  mapObserverStatus,
  mapPacket,
  mapPacketObservation,
  safeCount,
  mapSighting,
  mapTelemetry,
  mapTrace,
} from "./mappers.js";

type Row = QueryResultRow & Record<string, unknown>;
export interface DatabasePool {
  query<T extends QueryResultRow = Row>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

type Sql = { clauses: string[]; values: unknown[] };
export const EXPECTED_SCHEMA_ID = "meshcore-mqtt-broker-postgres-v1";
export const EXPECTED_SCHEMA_VERSION = 8;
const add = (sql: Sql, value: unknown) => {
  sql.values.push(value);
  return `$${sql.values.length}`;
};

const regionsFor = (publicKey: string) => `ARRAY(
  SELECT DISTINCT membership.scope FROM (
    SELECT nes.scope
    FROM meshcore_public.neighbor_entries ne
    JOIN meshcore_public.neighbor_entry_scopes nes ON nes.entry_id = ne.id
    WHERE ne.neighbor_public_key = ${publicKey}
    UNION
    SELECT nss.scope
    FROM meshcore_public.neighbor_snapshots snapshot
    JOIN meshcore_public.neighbor_snapshot_scopes nss ON nss.snapshot_id = snapshot.id
    WHERE snapshot.observer_public_key = ${publicKey}
  ) membership ORDER BY membership.scope
)`;
const NODE_REGIONS = regionsFor("n.public_key");
const OBSERVER_REGIONS = regionsFor("o.public_key");
const NODE_IATA = `ARRAY(
  SELECT DISTINCT sighting.iata
  FROM meshcore_public.node_sightings sighting
  WHERE sighting.node_public_key = n.public_key
  ORDER BY sighting.iata
)`;
const NODE_SELECT = `n.public_key, n.owner_public_key, n.latest_name, n.latest_role,
  n.latest_latitude, n.latest_longitude, n.first_seen_at_ms, n.last_seen_at_ms,
  ${NODE_IATA} AS iata, ${NODE_REGIONS} AS regions`;
const observerSelect = (cutoff: string) => `o.public_key, o.label,
  (o.last_seen_at_ms >= ${cutoff}) AS active, o.iata, o.first_seen_at_ms,
  o.last_seen_at_ms, n.latest_name, n.latest_latitude, n.latest_longitude,
  ${OBSERVER_REGIONS} AS regions`;
const MESSAGE_SELECT = `message.packet_sha256, message.packet_observation_id,
  message.message_type, message.channel, message.channel_index, message.channel_name,
  message.sender_public_key, message.destination_public_key, message.encrypted,
  message.text, message.signature_valid, message.reported_at_ms, message.received_at_ms`;
const TELEMETRY_SELECT = `telemetry.id, telemetry.packet_sha256,
  telemetry.packet_observation_id, telemetry.node_public_key, telemetry.reported_at_ms,
  telemetry.received_at_ms, telemetry.metric_name, telemetry.numeric_value,
  telemetry.text_value, telemetry.boolean_value, telemetry.unit, telemetry.channel`;
const TRACE_SELECT = `trace.id, trace.packet_sha256, trace.packet_observation_id,
  trace.source_node_public_key, trace.tag, trace.reported_at_ms, trace.received_at_ms`;

function page<T>(rows: Row[], limit: number, mapper: (row: Row) => T): Page<T> {
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(mapper),
    hasMore,
    nextKey:
      hasMore && last
        ? [String(last.__sort_value), String(last.__cursor_id)]
        : null,
  };
}

function applyText(sql: Sql, column: string, value: string | undefined) {
  if (value !== undefined) {
    const literal = value
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    sql.clauses.push(`${column} ILIKE ${add(sql, `%${literal}%`)} ESCAPE '\\'`);
  }
}

function applyExact(sql: Sql, column: string, value: unknown) {
  if (value !== undefined) sql.clauses.push(`${column} = ${add(sql, value)}`);
}

function applyRange(
  sql: Sql,
  column: string,
  from: number | undefined,
  to: number | undefined,
) {
  if (from !== undefined) sql.clauses.push(`${column} >= ${add(sql, from)}`);
  if (to !== undefined) sql.clauses.push(`${column} <= ${add(sql, to)}`);
}

function applyCursor(
  sql: Sql,
  expression: string,
  idExpression: string,
  after: CursorKey | undefined,
  order: "asc" | "desc",
) {
  if (!after) return;
  const operator = order === "desc" ? "<" : ">";
  sql.clauses.push(
    `(${expression}, ${idExpression}) ${operator} (${add(sql, after[0])}, ${add(sql, after[1])})`,
  );
}

function nodeConditions(filters: NodeFilters, alias = "n"): Sql {
  const sql: Sql = { clauses: [], values: [] };
  applyText(sql, `${alias}.latest_name`, filters.name);
  if (filters.role !== undefined)
    sql.clauses.push(
      `LOWER(COALESCE(${alias}.latest_role, '')) = ${add(sql, filters.role.toLowerCase())}`,
    );
  applyRange(sql, `${alias}.last_seen_at_ms`, filters.seenFrom, filters.seenTo);
  if (filters.iata) {
    sql.clauses.push(`EXISTS (
      SELECT 1 FROM meshcore_public.node_sightings sighting
      WHERE sighting.node_public_key = ${alias}.public_key AND sighting.iata = ${add(sql, filters.iata)}
    )`);
  }
  if (filters.region) {
    const region = add(sql, filters.region);
    sql.clauses.push(`(
      EXISTS (
        SELECT 1 FROM meshcore_public.neighbor_entries entry
        JOIN meshcore_public.neighbor_entry_scopes membership ON membership.entry_id = entry.id
        WHERE entry.neighbor_public_key = ${alias}.public_key AND membership.scope = ${region}
      ) OR EXISTS (
        SELECT 1 FROM meshcore_public.neighbor_snapshots snapshot
        JOIN meshcore_public.neighbor_snapshot_scopes membership ON membership.snapshot_id = snapshot.id
        WHERE snapshot.observer_public_key = ${alias}.public_key AND membership.scope = ${region}
      )
    )`);
  }
  if (
    filters.nearLat !== undefined &&
    filters.nearLon !== undefined &&
    filters.radiusKm !== undefined
  ) {
    const lon = add(sql, filters.nearLon);
    const lat = add(sql, filters.nearLat);
    const radius = add(sql, filters.radiusKm * 1000);
    sql.clauses.push(`${alias}.location IS NOT NULL AND public.ST_DWithin(
      ${alias}.location,
      public.ST_SetSRID(public.ST_MakePoint(${lon}, ${lat}), 4326)::public.geography,
      ${radius}
    )`);
  }
  return sql;
}

export class PostgresMeshcoreRepository implements MeshcoreRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly observerActiveWindowMs = 300_000,
    private readonly now: () => number = Date.now,
  ) {}

  async health() {
    const result = await this.pool.query<Row>(
      "SELECT schema_id, schema_version FROM meshcore_public.schema_metadata WHERE singleton = $1",
      [1],
    );
    const metadata = result.rows[0];
    if (
      metadata?.schema_id !== EXPECTED_SCHEMA_ID ||
      Number(metadata.schema_version) !== EXPECTED_SCHEMA_VERSION
    )
      throw Object.assign(new Error("Unsupported MeshCore public schema"), {
        code: "SCHEMA_MISMATCH",
      });
  }

  async listNodes(request: ListRequest<NodeFilters>) {
    const sql = nodeConditions(request.filters);
    const sorts: Record<string, string> = {
      last_seen: "n.last_seen_at_ms",
      first_seen: "n.first_seen_at_ms",
      name: "LOWER(COALESCE(n.latest_name, ''))",
      role: "LOWER(COALESCE(n.latest_role, ''))",
    };
    const sort = sorts[request.sort]!;
    applyCursor(sql, sort, "n.public_key", request.after, request.order);
    const limit = add(sql, request.limit + 1);
    const result = await this.pool.query<Row>(
      `SELECT ${NODE_SELECT},
      ${sort}::text AS __sort_value, n.public_key AS __cursor_id
      FROM meshcore_public.nodes n
      ${where(sql)} ORDER BY ${sort} ${request.order}, n.public_key ${request.order}
      LIMIT ${limit}`,
      sql.values,
    );
    return page(result.rows, request.limit, mapNode);
  }

  async getNode(publicKey: string) {
    const result = await this.pool.query<Row>(
      `SELECT ${NODE_SELECT} FROM meshcore_public.nodes n WHERE n.public_key = $1`,
      [publicKey],
    );
    return result.rows[0] ? mapNode(result.rows[0]) : null;
  }

  async getNeighborEvidence(publicKey: string) {
    const result = await this.pool.query<Row>(
      `WITH latest AS (
      SELECT DISTINCT ON (snapshot.observer_public_key)
        snapshot.id, snapshot.observer_public_key, snapshot.received_at_ms
      FROM meshcore_public.neighbor_snapshots snapshot
      ORDER BY snapshot.observer_public_key, snapshot.received_at_ms DESC, snapshot.id DESC
    ), evidence AS (
      SELECT entry.neighbor_public_key AS counterpart_public_key,
        'outbound'::text AS direction, latest.observer_public_key AS reporting_observer,
        entry.calculated_last_heard_at_ms AS last_heard_at_ms, latest.received_at_ms,
        entry.snr, entry.rssi,
        ARRAY(SELECT membership.scope FROM meshcore_public.neighbor_entry_scopes membership
          WHERE membership.entry_id = entry.id ORDER BY membership.scope) AS regions
      FROM latest
      JOIN meshcore_public.neighbor_entries entry ON entry.snapshot_id = latest.id
      WHERE latest.observer_public_key = $1
      UNION ALL
      SELECT latest.observer_public_key AS counterpart_public_key,
        'inbound'::text AS direction, latest.observer_public_key AS reporting_observer,
        entry.calculated_last_heard_at_ms AS last_heard_at_ms, latest.received_at_ms,
        entry.snr, entry.rssi,
        ARRAY(SELECT membership.scope FROM meshcore_public.neighbor_entry_scopes membership
          WHERE membership.entry_id = entry.id ORDER BY membership.scope) AS regions
      FROM latest
      JOIN meshcore_public.neighbor_entries entry ON entry.snapshot_id = latest.id
      WHERE entry.neighbor_public_key = $1 AND latest.observer_public_key <> $1
    )
    SELECT evidence.counterpart_public_key, evidence.direction,
      evidence.reporting_observer, evidence.last_heard_at_ms,
      evidence.received_at_ms, evidence.snr, evidence.rssi, evidence.regions,
      node.latest_name, node.latest_role
    FROM evidence LEFT JOIN meshcore_public.nodes node ON node.public_key = evidence.counterpart_public_key
    ORDER BY evidence.counterpart_public_key, evidence.direction`,
      [publicKey],
    );
    return result.rows;
  }

  async listNodeAdverts(publicKey: string, request: ListRequest<object>) {
    return this.historyPage(
      `SELECT advert.id, advert.node_public_key, advert.packet_sha256, advert.advert_timestamp,
        advert.first_observed_at_ms, advert.name, advert.role, advert.latitude, advert.longitude,
        advert.flags, advert.signature_valid, advert.verified, advert.verification_error`,
      "meshcore_public.node_adverts advert",
      "advert.node_public_key = $1",
      [publicKey],
      "advert.first_observed_at_ms",
      "advert.id",
      request,
      mapAdvert,
    );
  }

  async listNodeSightings(publicKey: string, request: ListRequest<object>) {
    return this.historyPage(
      `SELECT sighting.id, sighting.node_public_key, sighting.observer_public_key,
        sighting.iata, sighting.sighting_type, sighting.received_at_ms`,
      "meshcore_public.node_sightings sighting",
      "sighting.node_public_key = $1",
      [publicKey],
      "sighting.received_at_ms",
      "sighting.id",
      request,
      mapSighting,
    );
  }

  async listNodeTelemetry(publicKey: string, request: ListRequest<object>) {
    const result = await this.listTelemetry({
      ...request,
      filters: { node: publicKey },
      sort: "received_at",
    });
    return result;
  }

  async listObservers(request: ListRequest<ObserverFilters>) {
    const filters = request.filters;
    const sql: Sql = { clauses: [], values: [] };
    const activeCutoff = add(sql, this.now() - this.observerActiveWindowMs);
    if (filters.active !== undefined)
      sql.clauses.push(
        `o.last_seen_at_ms ${filters.active ? ">=" : "<"} ${activeCutoff}`,
      );
    applyText(sql, "COALESCE(o.label, n.latest_name)", filters.name);
    applyExact(sql, "o.iata", filters.iata);
    applyRange(sql, "o.last_seen_at_ms", filters.seenFrom, filters.seenTo);
    if (filters.region) {
      const region = add(sql, filters.region);
      sql.clauses.push(`EXISTS (
        SELECT 1 FROM meshcore_public.neighbor_snapshots snapshot
        WHERE snapshot.observer_public_key = o.public_key AND (
          EXISTS (SELECT 1 FROM meshcore_public.neighbor_snapshot_scopes membership
            WHERE membership.snapshot_id = snapshot.id AND membership.scope = ${region})
          OR EXISTS (SELECT 1 FROM meshcore_public.neighbor_entries entry
            JOIN meshcore_public.neighbor_entry_scopes membership ON membership.entry_id = entry.id
            WHERE entry.snapshot_id = snapshot.id AND membership.scope = ${region})
        )
      )`);
    }
    if (
      filters.nearLat !== undefined &&
      filters.nearLon !== undefined &&
      filters.radiusKm !== undefined
    ) {
      const lon = add(sql, filters.nearLon);
      const lat = add(sql, filters.nearLat);
      const radius = add(sql, filters.radiusKm * 1000);
      sql.clauses.push(`n.location IS NOT NULL AND public.ST_DWithin(
        n.location,
        public.ST_SetSRID(public.ST_MakePoint(${lon}, ${lat}), 4326)::public.geography,
        ${radius}
      )`);
    }
    const sorts: Record<string, string> = {
      last_seen: "o.last_seen_at_ms",
      first_seen: "o.first_seen_at_ms",
      name: "LOWER(COALESCE(o.label, n.latest_name, ''))",
    };
    const sort = sorts[request.sort]!;
    applyCursor(sql, sort, "o.public_key", request.after, request.order);
    const limit = add(sql, request.limit + 1);
    const result = await this.pool.query<Row>(
      `SELECT ${observerSelect(activeCutoff)},
      ${sort}::text AS __sort_value, o.public_key AS __cursor_id
      FROM meshcore_public.observers o
      LEFT JOIN meshcore_public.nodes n ON n.public_key = o.public_key
      ${where(sql)} ORDER BY ${sort} ${request.order}, o.public_key ${request.order}
      LIMIT ${limit}`,
      sql.values,
    );
    return page(result.rows, request.limit, mapObserver);
  }

  async getObserver(publicKey: string) {
    const activeCutoff = this.now() - this.observerActiveWindowMs;
    const result = await this.pool.query<Row>(
      `SELECT ${observerSelect("$2")}
      FROM meshcore_public.observers o
      LEFT JOIN meshcore_public.nodes n ON n.public_key = o.public_key
      WHERE o.public_key = $1`,
      [publicKey, activeCutoff],
    );
    return result.rows[0] ? mapObserver(result.rows[0]) : null;
  }

  async getObserverStatus(publicKey: string) {
    const result = await this.pool.query<Row>(
      `SELECT status.id, status.observer_public_key,
       status.iata, status.reported_at_ms, status.received_at_ms,
      status.origin, status.model, status.firmware_version
      FROM meshcore_public.observer_status status
      WHERE status.observer_public_key = $1
      ORDER BY status.received_at_ms DESC, status.id DESC LIMIT 1`,
      [publicKey],
    );
    return result.rows[0] ? mapObserverStatus(result.rows[0]) : null;
  }

  async listObserverMetrics(publicKey: string, request: ListRequest<object>) {
    return this.historyPage(
      `SELECT metric.id, metric.observer_public_key, metric.metric_name,
        metric.numeric_value, metric.text_value, metric.boolean_value, metric.unit,
        metric.reported_at_ms, metric.received_at_ms`,
      "meshcore_public.observer_metrics metric",
      "metric.observer_public_key = $1",
      [publicKey],
      "metric.received_at_ms",
      "metric.id",
      request,
      mapObserverMetric,
    );
  }

  async getIataSummary(code: string) {
    const result = await this.pool.query<Row>(
      `SELECT
      (SELECT count(DISTINCT node_public_key)::text FROM meshcore_public.node_sightings WHERE iata = $1) AS node_count,
      (SELECT count(*)::text FROM meshcore_public.observers WHERE iata = $1) AS observer_count,
      (SELECT count(*)::text FROM meshcore_public.packet_observations WHERE iata = $1) AS observation_count,
      (SELECT max(received_at_ms)::text FROM meshcore_public.packet_observations WHERE iata = $1) AS last_activity_at_ms`,
      [code],
    );
    const row = result.rows[0]!;
    return {
      node_count: safeCount(row.node_count),
      observer_count: safeCount(row.observer_count),
      observation_count: safeCount(row.observation_count),
      last_activity: mapHistory({
        last_activity_at_ms: row.last_activity_at_ms,
      }).last_activity_at,
    };
  }

  async listRegions() {
    const result = await this.pool.query<Row>(
      `${REGION_SUMMARY_SQL} ORDER BY registry.region`,
    );
    return result.rows.map(mapRegion);
  }

  async getRegion(region: string) {
    const result = await this.pool.query<Row>(
      `${REGION_SUMMARY_SQL} WHERE registry.region = $1`,
      [region],
    );
    return result.rows[0] ? mapRegion(result.rows[0]) : null;
  }

  async listRegionNodes(region: string, request: ListRequest<object>) {
    const sql: Sql = { clauses: [], values: [region] };
    sql.clauses.push(`(
      EXISTS (SELECT 1 FROM meshcore_public.neighbor_entries entry
        JOIN meshcore_public.neighbor_entry_scopes membership ON membership.entry_id = entry.id
        WHERE entry.neighbor_public_key = n.public_key AND membership.scope = $1)
      OR EXISTS (SELECT 1 FROM meshcore_public.neighbor_snapshots snapshot
        JOIN meshcore_public.neighbor_snapshot_scopes membership ON membership.snapshot_id = snapshot.id
        WHERE snapshot.observer_public_key = n.public_key AND membership.scope = $1)
    )`);
    applyCursor(
      sql,
      "n.last_seen_at_ms",
      "n.public_key",
      request.after,
      request.order,
    );
    const limit = add(sql, request.limit + 1);
    const result = await this.pool.query<Row>(
      `SELECT ${NODE_SELECT}, n.last_seen_at_ms::text AS __sort_value,
      n.public_key AS __cursor_id FROM meshcore_public.nodes n ${where(sql)}
      ORDER BY n.last_seen_at_ms ${request.order}, n.public_key ${request.order} LIMIT ${limit}`,
      sql.values,
    );
    return page(result.rows, request.limit, mapNode);
  }

  async listPackets(request: ListRequest<PacketFilters>) {
    const filters = request.filters;
    const sql: Sql = { clauses: [], values: [] };
    applyExact(sql, "packet.packet_sha256", filters.hash);
    applyExact(sql, "packet.logical_packet_id", filters.logicalId);
    applyExact(sql, "packet.packet_type", filters.packetType);
    applyExact(sql, "packet.payload_type", filters.payloadType);
    applyExact(sql, "packet.route_type", filters.routeType);
    applyExact(sql, "packet.decode_status", filters.decodeStatus);
    const hasObservationFilter = Boolean(
      filters.observer ||
      filters.iata ||
      filters.node ||
      filters.receivedFrom !== undefined ||
      filters.receivedTo !== undefined,
    );
    let matchedReceivedAt = "packet.last_seen_at_ms";
    if (hasObservationFilter) {
      const inner: string[] = [
        "observation.packet_sha256 = packet.packet_sha256",
      ];
      if (filters.observer)
        inner.push(
          `observation.observer_public_key = ${add(sql, filters.observer)}`,
        );
      if (filters.iata)
        inner.push(`observation.iata = ${add(sql, filters.iata)}`);
      if (filters.receivedFrom !== undefined)
        inner.push(
          `observation.received_at_ms >= ${add(sql, filters.receivedFrom)}`,
        );
      if (filters.receivedTo !== undefined)
        inner.push(
          `observation.received_at_ms <= ${add(sql, filters.receivedTo)}`,
        );
      if (filters.node)
        inner.push(`EXISTS (SELECT 1 FROM meshcore_public.node_sightings sighting
          WHERE sighting.packet_observation_id = observation.id
            AND sighting.node_public_key = ${add(sql, filters.node)})`);
      matchedReceivedAt = `(SELECT max(observation.received_at_ms)
        FROM meshcore_public.packet_observations observation
        WHERE ${inner.join(" AND ")})`;
      sql.clauses.push(`${matchedReceivedAt} IS NOT NULL`);
    }
    const sorts: Record<string, string> = {
      received_at: matchedReceivedAt,
      first_seen: "packet.first_seen_at_ms",
    };
    const sort = sorts[request.sort]!;
    applyCursor(
      sql,
      sort,
      "packet.packet_sha256",
      request.after,
      request.order,
    );
    const limit = add(sql, request.limit + 1);
    const result = await this.pool.query<Row>(
      `SELECT packet.packet_sha256, packet.raw_packet_blob,
      packet.logical_packet_id, packet.packet_type, packet.payload_type, packet.route_type,
      packet.decode_status, packet.first_seen_at_ms, packet.last_seen_at_ms,
      ${sort}::text AS __sort_value, packet.packet_sha256 AS __cursor_id
      FROM meshcore_public.packets packet ${where(sql)}
      ORDER BY ${sort} ${request.order}, packet.packet_sha256 ${request.order} LIMIT ${limit}`,
      sql.values,
    );
    return page(result.rows, request.limit, mapPacket);
  }

  async getPacket(hash: string) {
    const result = await this.pool.query<Row>(
      `SELECT packet_sha256, raw_packet_blob,
      logical_packet_id, packet_type, payload_type, route_type, decode_status,
      first_seen_at_ms, last_seen_at_ms FROM meshcore_public.packets WHERE packet_sha256 = $1`,
      [hash],
    );
    return result.rows[0] ? mapPacket(result.rows[0]) : null;
  }

  async listPacketObservations(hash: string, request: ListRequest<object>) {
    return this.historyPage(
      `SELECT observation.id, observation.packet_sha256,
        observation.observer_public_key AS observer, observation.iata,
        observation.received_at_ms, observation.reported_at_ms, observation.rssi,
        observation.snr, observation.score, observation.direction,
        ARRAY(SELECT json_build_object(
            'index', hop.hop_index,
            'prefix_hex', hop.prefix_hex,
            'prefix_length_bytes', hop.prefix_length_bytes,
            'resolved_node', hop.resolved_node_public_key,
            'resolution_status', hop.resolution_status,
            'resolution_confidence', hop.resolution_confidence
          ) FROM meshcore_public.packet_paths path
          JOIN meshcore_public.packet_path_hops hop ON hop.path_id = path.id
          WHERE path.packet_observation_id = observation.id ORDER BY hop.hop_index) AS path`,
      "meshcore_public.packet_observations observation",
      "observation.packet_sha256 = $1",
      [hash],
      "observation.received_at_ms",
      "observation.id",
      request,
      mapPacketObservation,
    );
  }

  async listMessages(request: ListRequest<MessageFilters>) {
    const filters = request.filters;
    const filtered: Sql = { clauses: [], values: [] };
    applyExact(filtered, "message.sender_public_key", filters.sender);
    applyExact(filtered, "message.destination_public_key", filters.destination);
    applyExact(filtered, "message.channel", filters.channel);
    applyExact(filtered, "message.channel_name", filters.channelName);
    applyExact(filtered, "message.message_type", filters.messageType);
    applyExact(filtered, "message.encrypted", filters.encrypted);
    applyExact(filtered, "message.signature_valid", filters.signatureValid);
    applyExact(filtered, "observation.iata", filters.iata);
    applyRange(
      filtered,
      "observation.received_at_ms",
      filters.receivedFrom,
      filters.receivedTo,
    );
    const outer: Sql = { clauses: [], values: filtered.values };
    applyCursor(
      outer,
      "summary.last_received_at_ms",
      "summary.logical_id",
      request.after,
      request.order,
    );
    const limit = add(outer, request.limit + 1);
    const result = await this.pool.query<Row>(
      `WITH filtered AS (
        SELECT ${MESSAGE_SELECT}, observation.iata AS observation_iata,
          observation.received_at_ms AS observation_received_at_ms,
          COALESCE(packet.logical_packet_id, message.packet_sha256) AS logical_id
        FROM meshcore_public.messages message
        JOIN meshcore_public.packet_observations observation
          ON observation.id = message.packet_observation_id
        JOIN meshcore_public.packets packet
          ON packet.packet_sha256 = message.packet_sha256
        ${where(filtered)}
      ), summary AS (
        SELECT logical_id, min(observation_received_at_ms) AS first_received_at_ms,
          max(observation_received_at_ms) AS last_received_at_ms,
          count(DISTINCT packet_observation_id)::text AS observation_count,
          array_agg(DISTINCT observation_iata ORDER BY observation_iata) AS iata
        FROM filtered GROUP BY logical_id
      ), representative AS (
        SELECT DISTINCT ON (logical_id) * FROM filtered
        ORDER BY logical_id, observation_received_at_ms DESC, packet_observation_id DESC
      )
      SELECT representative.*, summary.first_received_at_ms,
        summary.last_received_at_ms, summary.observation_count, summary.iata,
        summary.last_received_at_ms::text AS __sort_value,
        summary.logical_id AS __cursor_id
      FROM summary JOIN representative USING (logical_id)
      ${where(outer)}
      ORDER BY summary.last_received_at_ms ${request.order},
        summary.logical_id ${request.order} LIMIT ${limit}`,
      outer.values,
    );
    return page(result.rows, request.limit, mapMessage);
  }

  async getMessage(id: string) {
    const result = await this.pool.query<Row>(
      `WITH matches AS (
        SELECT ${MESSAGE_SELECT}, observation.iata AS observation_iata,
          observation.received_at_ms AS observation_received_at_ms,
          COALESCE(packet.logical_packet_id, message.packet_sha256) AS logical_id
        FROM meshcore_public.messages message
        JOIN meshcore_public.packet_observations observation
          ON observation.id = message.packet_observation_id
        JOIN meshcore_public.packets packet
          ON packet.packet_sha256 = message.packet_sha256
        WHERE COALESCE(packet.logical_packet_id, message.packet_sha256) = $1
      ), summary AS (
        SELECT logical_id, min(observation_received_at_ms) AS first_received_at_ms,
          max(observation_received_at_ms) AS last_received_at_ms,
          count(DISTINCT packet_observation_id)::text AS observation_count,
          array_agg(DISTINCT observation_iata ORDER BY observation_iata) AS iata
        FROM matches GROUP BY logical_id
      ), representative AS (
        SELECT DISTINCT ON (logical_id) * FROM matches
        ORDER BY logical_id, observation_received_at_ms DESC, packet_observation_id DESC
      )
      SELECT representative.*, summary.first_received_at_ms,
        summary.last_received_at_ms, summary.observation_count, summary.iata
      FROM summary JOIN representative USING (logical_id)`,
      [id],
    );
    return result.rows[0] ? mapMessage(result.rows[0]) : null;
  }

  async listTelemetry(request: ListRequest<TelemetryFilters>) {
    const filters = request.filters;
    const sql: Sql = { clauses: [], values: [] };
    applyExact(sql, "telemetry.node_public_key", filters.node);
    applyExact(sql, "telemetry.metric_name", filters.metric);
    applyExact(sql, "observation.iata", filters.iata);
    applyRange(
      sql,
      "telemetry.received_at_ms",
      filters.receivedFrom,
      filters.receivedTo,
    );
    return this.protocolPage(
      `SELECT ${TELEMETRY_SELECT}, observation.iata`,
      `meshcore_public.telemetry telemetry JOIN meshcore_public.packet_observations observation
        ON observation.id = telemetry.packet_observation_id`,
      "telemetry.received_at_ms",
      "telemetry.id",
      request,
      sql,
      mapTelemetry,
    );
  }

  async getTelemetry(id: string) {
    const result = await this.pool.query<Row>(
      `SELECT ${TELEMETRY_SELECT}, observation.iata
      FROM meshcore_public.telemetry telemetry
      JOIN meshcore_public.packet_observations observation ON observation.id = telemetry.packet_observation_id
      WHERE telemetry.id = $1`,
      [id],
    );
    return result.rows[0] ? mapTelemetry(result.rows[0]) : null;
  }

  async listTraces(request: ListRequest<TraceFilters>) {
    const filters = request.filters;
    const sql: Sql = { clauses: [], values: [] };
    applyExact(sql, "trace.source_node_public_key", filters.sourceNode);
    applyExact(sql, "trace.tag", filters.tag);
    applyExact(sql, "observation.iata", filters.iata);
    applyRange(
      sql,
      "observation.received_at_ms",
      filters.receivedFrom,
      filters.receivedTo,
    );
    return this.protocolPage(
      `SELECT ${TRACE_SELECT}, observation.iata`,
      `meshcore_public.traces trace JOIN meshcore_public.packet_observations observation
        ON observation.id = trace.packet_observation_id`,
      "observation.received_at_ms",
      "observation.id",
      request,
      sql,
      mapTrace,
    );
  }

  async getTrace(id: string) {
    const result = await this.pool.query<Row>(
      `SELECT ${TRACE_SELECT}, observation.iata
      FROM meshcore_public.traces trace
      JOIN meshcore_public.packet_observations observation ON observation.id = trace.packet_observation_id
      WHERE trace.id = $1`,
      [id],
    );
    return result.rows[0] ? mapTrace(result.rows[0]) : null;
  }

  async listTraceHops(id: string) {
    const result = await this.pool.query<Row>(
      `SELECT hop.id, hop.hop_index AS index,
      hop.prefix_hex, hop.prefix_length_bytes, hop.snr,
      hop.resolved_node_public_key AS resolved_node, hop.resolution_confidence,
      CASE WHEN hop.resolved_node_public_key IS NOT NULL THEN 'resolved'
        WHEN EXISTS (SELECT 1 FROM meshcore_public.node_prefix_candidates candidate
          WHERE candidate.prefix_hex = hop.prefix_hex
            AND candidate.prefix_length_bytes = hop.prefix_length_bytes) THEN 'ambiguous'
        ELSE 'unresolved' END AS resolution_status,
      ARRAY(SELECT json_build_object('public_key', candidate.node_public_key, 'confidence', candidate.confidence)
        FROM meshcore_public.node_prefix_candidates candidate
        WHERE candidate.prefix_hex = hop.prefix_hex
          AND candidate.prefix_length_bytes = hop.prefix_length_bytes
        ORDER BY candidate.confidence DESC, candidate.node_public_key) AS candidates
      FROM meshcore_public.trace_hops hop WHERE hop.trace_id = $1 ORDER BY hop.hop_index`,
      [id],
    );
    return result.rows.map(mapHistory);
  }

  async getStats() {
    const now = this.now();
    const activeFrom = now - 86_400_000;
    const observerActiveFrom = now - this.observerActiveWindowMs;
    const result = await this.pool.query<Row>(
      `SELECT
      (SELECT count(*)::text FROM meshcore_public.nodes) AS known_nodes,
      (SELECT count(*)::text FROM meshcore_public.nodes WHERE last_seen_at_ms >= $1) AS active_nodes,
      (SELECT count(*)::text FROM meshcore_public.observers) AS known_observers,
      (SELECT count(*)::text FROM meshcore_public.observers WHERE last_seen_at_ms >= $2) AS active_observers,
      (SELECT count(DISTINCT scope)::text FROM (
        SELECT scope FROM meshcore_public.neighbor_snapshot_scopes
        UNION SELECT scope FROM meshcore_public.neighbor_entry_scopes) regions) AS regions,
      (SELECT count(DISTINCT iata)::text FROM meshcore_public.packet_observations WHERE received_at_ms >= $1) AS active_iata,
      (SELECT count(DISTINCT packet_sha256)::text FROM meshcore_public.packet_observations WHERE received_at_ms >= $1) AS packets_24h,
      (SELECT count(DISTINCT COALESCE(packet.logical_packet_id, message.packet_sha256))::text
        FROM meshcore_public.messages message
        JOIN meshcore_public.packets packet ON packet.packet_sha256 = message.packet_sha256
        WHERE message.received_at_ms >= $1) AS messages_24h,
      (SELECT max(received_at_ms)::text FROM meshcore_public.packet_observations) AS last_seen_at_ms`,
      [activeFrom, observerActiveFrom],
    );
    const row = result.rows[0]!;
    return {
      nodes: {
        known: safeCount(row.known_nodes),
        active_24h: safeCount(row.active_nodes),
      },
      observers: {
        known: safeCount(row.known_observers),
        active: safeCount(row.active_observers),
        active_window_seconds: this.observerActiveWindowMs / 1000,
      },
      regions: safeCount(row.regions),
      active_iata: safeCount(row.active_iata),
      activity: {
        packets_24h: safeCount(row.packets_24h),
        messages_24h: safeCount(row.messages_24h),
        last_seen: mapHistory({ last_seen_at_ms: row.last_seen_at_ms })
          .last_seen_at,
      },
    };
  }

  async getActivity(input: {
    fromMs: number;
    toMs: number;
    intervalMs: number;
    iata?: string;
    region?: string;
  }) {
    const sql: Sql = {
      clauses: [
        "observation.received_at_ms >= $1",
        "observation.received_at_ms <= $2",
      ],
      values: [input.fromMs, input.toMs],
    };
    if (input.iata)
      sql.clauses.push(`observation.iata = ${add(sql, input.iata)}`);
    if (input.region) {
      const region = add(sql, input.region);
      sql.clauses.push(`EXISTS (
        SELECT 1 FROM meshcore_public.node_sightings sighting
        WHERE sighting.packet_observation_id = observation.id AND (
          EXISTS (SELECT 1 FROM meshcore_public.neighbor_entries entry
            JOIN meshcore_public.neighbor_entry_scopes membership ON membership.entry_id = entry.id
            WHERE entry.neighbor_public_key = sighting.node_public_key AND membership.scope = ${region})
          OR EXISTS (SELECT 1 FROM meshcore_public.neighbor_snapshots snapshot
            JOIN meshcore_public.neighbor_snapshot_scopes membership ON membership.snapshot_id = snapshot.id
            WHERE snapshot.observer_public_key = sighting.node_public_key AND membership.scope = ${region})
        )
      )`);
    }
    const interval = add(sql, input.intervalMs);
    const result = await this.pool.query<Row>(
      `SELECT
      (floor(observation.received_at_ms / ${interval}::numeric) * ${interval}::numeric)::bigint AS bucket_at_ms,
      count(*)::text AS observations,
      count(DISTINCT observation.packet_sha256)::text AS packets,
       count(DISTINCT COALESCE(packet.logical_packet_id, message.packet_sha256))::text AS messages
      FROM meshcore_public.packet_observations observation
      LEFT JOIN meshcore_public.messages message ON message.packet_observation_id = observation.id
      LEFT JOIN meshcore_public.packets packet ON packet.packet_sha256 = message.packet_sha256
      ${where(sql)} GROUP BY bucket_at_ms ORDER BY bucket_at_ms`,
      sql.values,
    );
    return result.rows.map((row) => ({
      bucket_at: mapHistory({ bucket_at_ms: row.bucket_at_ms }).bucket_at,
      observations: safeCount(row.observations),
      packets: safeCount(row.packets),
      messages: safeCount(row.messages),
    }));
  }

  private async historyPage(
    select: string,
    from: string,
    condition: string,
    values: unknown[],
    sort: string,
    id: string,
    request: ListRequest<object>,
    mapper: (row: Row) => unknown = mapHistory,
  ) {
    const sql: Sql = { clauses: [condition], values: [...values] };
    applyCursor(sql, sort, id, request.after, request.order);
    const limit = add(sql, request.limit + 1);
    const result = await this.pool.query<Row>(
      `${select}, ${sort}::text AS __sort_value,
      ${id}::text AS __cursor_id FROM ${from} ${where(sql)}
      ORDER BY ${sort} ${request.order}, ${id} ${request.order} LIMIT ${limit}`,
      sql.values,
    );
    return page(result.rows, request.limit, mapper);
  }

  private async protocolPage<T>(
    select: string,
    from: string,
    sort: string,
    id: string,
    request: ListRequest<object>,
    sql: Sql,
    mapper: (row: Row) => T,
  ) {
    applyCursor(sql, sort, id, request.after, request.order);
    const limit = add(sql, request.limit + 1);
    const result = await this.pool.query<Row>(
      `${select}, ${sort}::text AS __sort_value,
      ${id}::text AS __cursor_id FROM ${from} ${where(sql)}
      ORDER BY ${sort} ${request.order}, ${id} ${request.order} LIMIT ${limit}`,
      sql.values,
    );
    return page(result.rows, request.limit, mapper);
  }
}

function where(sql: Sql) {
  return sql.clauses.length ? `WHERE ${sql.clauses.join(" AND ")}` : "";
}

const REGION_SUMMARY_SQL = `WITH membership AS (
    SELECT entry_scope.scope, entry.neighbor_public_key AS node_public_key,
      snapshot.observer_public_key, snapshot.received_at_ms
    FROM meshcore_public.neighbor_entry_scopes entry_scope
    JOIN meshcore_public.neighbor_entries entry ON entry.id = entry_scope.entry_id
    JOIN meshcore_public.neighbor_snapshots snapshot ON snapshot.id = entry.snapshot_id
    UNION ALL
    SELECT snapshot_scope.scope, snapshot.observer_public_key AS node_public_key,
      snapshot.observer_public_key, snapshot.received_at_ms
    FROM meshcore_public.neighbor_snapshot_scopes snapshot_scope
    JOIN meshcore_public.neighbor_snapshots snapshot ON snapshot.id = snapshot_scope.snapshot_id
  ), counts AS (
    SELECT membership.scope,
      count(DISTINCT node.public_key)::text AS node_count,
      count(DISTINCT membership.observer_public_key)::text AS observer_count,
      max(membership.received_at_ms)::text AS last_activity_at_ms
    FROM membership
    LEFT JOIN meshcore_public.nodes node ON node.public_key = membership.node_public_key
    GROUP BY membership.scope
  )
  SELECT registry.region, registry.name, registry.first_seen_at_ms,
    registry.last_seen_at_ms, registry.manually_added,
    registry.observation_count::text AS observation_count,
    COALESCE(counts.node_count, '0') AS node_count,
    COALESCE(counts.observer_count, '0') AS observer_count,
    counts.last_activity_at_ms
  FROM meshcore_public.region_scopes registry
  LEFT JOIN counts ON counts.scope = registry.region`;

function mapRegion(row: Row) {
  return {
    region: row.region,
    name: row.name ?? null,
    first_seen: isoTime(row.first_seen_at_ms),
    last_seen: isoTime(row.last_seen_at_ms),
    manually_added: Boolean(row.manually_added),
    observation_count: safeCount(row.observation_count),
    node_count: safeCount(row.node_count),
    observer_count: safeCount(row.observer_count),
    last_activity: mapHistory({ last_activity_at_ms: row.last_activity_at_ms })
      .last_activity_at,
    links: {
      nodes: `/v1/meshcore/regions/${encodeURIComponent(String(row.region))}/nodes`,
    },
  };
}
