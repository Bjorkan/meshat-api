import { createHash } from "node:crypto";
import { SQL, sql } from "bun";

// `sql` here is ONLY a fragment composer: it builds parameterized sub-queries
// that are always interpolated into (and executed by) the injected SQL
// instance. The ambient default pool is never queried.
import {
  type CursorKey,
  type ListRequest,
  type MeshcoreRepository,
  type MessageFilters,
  type NodeFilters,
  type ObserverFilters,
  type PacketFilters,
  type RegionFilters,
  type TelemetryFilters,
  type TraceFilters,
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
  mapSighting,
  mapTelemetry,
  mapTrace,
  safeCount,
} from "./mappers.js";
import type { SchemaMetadata } from "./domain.js";

/**
 * PostgreSQL access for the MeshCore domain, built directly on Bun.SQL.
 *
 * Every runtime value travels through tagged-template interpolation so
 * Bun.SQL binds it as a parameter. Conditional predicates are composed from
 * other tagged templates (empty templates compose away), sort columns are
 * static per-endpoint maps, and sort direction is one of two static
 * fragments. No raw SQL construction happens anywhere in this file.
 */

export const EXPECTED_SCHEMA_ID = "meshcore-mqtt-broker-postgres-v1";
export const EXPECTED_SCHEMA_VERSION = 9;
export type { SchemaMetadata } from "./domain.js";

type Row = Record<string, unknown>;
/** A tagged-template fragment; empty fragments compose away cleanly. */
type Frag = SQL.Query<unknown>;

const ASC = sql`ASC`;
const DESC = sql`DESC`;
const directionFor = (order: "asc" | "desc"): Frag => (order === "asc" ? ASC : DESC);

type MaybeFrag = Frag | null;

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function likePattern(value: string): string {
  const literal = value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\%");
  return `%${literal}%`;
}

// Conditional fragments always start with their logical operator so they can
// follow a `WHERE true` anchor, and they carry their own parameters at a
// single nesting level (the executed template).
const applyText = (column: Frag, value: string | undefined): MaybeFrag =>
  value === undefined ? null : sql`${column} ILIKE ${likePattern(value)} ESCAPE '\\'`;

const applyExact = (column: Frag, value: unknown): MaybeFrag =>
  value === undefined ? null : sql`${column} = ${value}`;

const applyRange =
  (column: Frag) =>
  (from: number | undefined, to: number | undefined): MaybeFrag => {
    if (from !== undefined && to !== undefined)
      return sql`${column} >= ${from} AND ${column} <= ${to}`;
    if (from !== undefined) return sql`${column} >= ${from}`;
    if (to !== undefined) return sql`${column} <= ${to}`;
    return null;
  };

const applyEntityRegion = (
  entityKey: Frag,
  region: string,
  seenFrom?: number,
  seenTo?: number,
): MaybeFrag => {
  if (!seenFrom && !seenTo)
    return sql`EXISTS (
      SELECT 1 FROM ${ENTITY_REGION_EVIDENCE} evidence
      WHERE evidence.entity_public_key = ${entityKey}
        AND evidence.region = ${region}
    )`;
  if (seenFrom !== undefined && seenTo !== undefined)
    return sql`EXISTS (
      SELECT 1 FROM ${ENTITY_REGION_EVIDENCE} evidence
      WHERE evidence.entity_public_key = ${entityKey}
        AND evidence.region = ${region}
        AND evidence.evidence_received_at_ms >= ${seenFrom}
        AND evidence.evidence_received_at_ms <= ${seenTo}
    )`;
  if (seenFrom !== undefined)
    return sql`EXISTS (
      SELECT 1 FROM ${ENTITY_REGION_EVIDENCE} evidence
      WHERE evidence.entity_public_key = ${entityKey}
        AND evidence.region = ${region}
        AND evidence.evidence_received_at_ms >= ${seenFrom}
    )`;
  return sql`EXISTS (
    SELECT 1 FROM ${ENTITY_REGION_EVIDENCE} evidence
    WHERE evidence.entity_public_key = ${entityKey}
      AND evidence.region = ${region}
      AND evidence.evidence_received_at_ms <= ${seenTo!}
  )`;
};

const applyCursor = (
  expression: Frag,
  idExpression: Frag,
  after: CursorKey | undefined,
  order: "asc" | "desc",
): MaybeFrag => {
  if (!after) return null;
  const operator = order === "desc" ? sql`<` : sql`>`;
  return sql`(${expression}, ${idExpression}) ${operator} (${after[0]}, ${after[1]})`;
};

function joinWith(parts: Array<Frag | null>, separator: " AND " | ", "): Frag {
  const present = parts.filter((part): part is Frag => part !== null);
  let acc: Frag | undefined;
  for (const part of present) {
    if (!acc) {
      acc = part;
      continue;
    }
    if (separator === " AND ") acc = sql`${acc} AND ${part}`;
    else acc = sql`${acc}, ${part}`;
  }
  return acc ?? sql``;
}

function where(clauses: Array<Frag | null>): Frag {
  const present = clauses.filter((clause): clause is Frag => clause !== null);
  if (present.length === 0) return sql``;
  return sql` WHERE true AND ${joinWith(present, " AND ")}`;
}

const ENTITY_REGION_EVIDENCE = sql`(
  SELECT entry.neighbor_public_key AS entity_public_key,
    entry_scope.scope AS region,
    snapshot.received_at_ms AS evidence_received_at_ms
  FROM meshcore_public.neighbor_entry_scopes entry_scope
  JOIN meshcore_public.neighbor_entries entry ON entry.id = entry_scope.entry_id
  JOIN meshcore_public.neighbor_snapshots snapshot ON snapshot.id = entry.snapshot_id
  UNION ALL
  SELECT snapshot.observer_public_key AS entity_public_key,
    snapshot_scope.scope AS region,
    snapshot.received_at_ms AS evidence_received_at_ms
  FROM meshcore_public.neighbor_snapshot_scopes snapshot_scope
  JOIN meshcore_public.neighbor_snapshots snapshot ON snapshot.id = snapshot_scope.snapshot_id)`;

// Internal-only builders: callers pass reviewed column references such as
// sql`n.public_key`, never client input.
const regionsFor = (entityKey: Frag): Frag => sql`ARRAY(
  SELECT DISTINCT evidence.region
  FROM ${ENTITY_REGION_EVIDENCE} evidence
  WHERE evidence.entity_public_key = ${entityKey}
  ORDER BY evidence.region)`;
const NODE_REGIONS = regionsFor(sql`n.public_key`);
const OBSERVER_REGIONS = regionsFor(sql`o.public_key`);
const NODE_IATA = sql`ARRAY(
  SELECT DISTINCT sighting.iata
  FROM meshcore_public.node_sightings sighting
  WHERE sighting.node_public_key = n.public_key
  ORDER BY sighting.iata)`;
const NODE_SELECT = sql`n.public_key, n.owner_public_key, n.latest_name, n.latest_role,
  n.latest_latitude, n.latest_longitude, n.first_seen_at_ms, n.last_seen_at_ms,
  ${NODE_IATA} AS iata, ${NODE_REGIONS} AS regions`;
const observerSelect = (cutoff: number): Frag => sql`o.public_key, o.label,
  (o.last_seen_at_ms >= ${cutoff}) AS active, o.iata, o.first_seen_at_ms,
  o.last_seen_at_ms, n.latest_name, n.latest_latitude, n.latest_longitude,
  ${OBSERVER_REGIONS} AS regions`;
const MESSAGE_SELECT = sql`message.packet_sha256, message.packet_observation_id,
  message.message_type, message.channel, message.channel_index, message.channel_name,
  message.sender_public_key, message.destination_public_key, message.encrypted,
  message.text, message.signature_valid, message.reported_at_ms, message.received_at_ms`;
const TELEMETRY_SELECT = sql`telemetry.id, telemetry.packet_sha256,
  telemetry.packet_observation_id, telemetry.node_public_key, telemetry.reported_at_ms,
  telemetry.received_at_ms, telemetry.metric_name, telemetry.numeric_value,
  telemetry.text_value, telemetry.boolean_value, telemetry.unit, telemetry.channel`;
const TRACE_SELECT = sql`trace.id, trace.packet_sha256, trace.packet_observation_id,
  trace.source_node_public_key, trace.tag, trace.reported_at_ms, trace.received_at_ms,
  observation.observer_public_key AS observer,
  COALESCE(packet.logical_packet_id, trace.packet_sha256) AS logical_id`;

function page<T>(
  rows: Row[],
  limit: number,
  mapper: (row: Row) => T,
): import("./domain.js").Page<T> {
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(mapper),
    hasMore,
    nextKey: hasMore && last ? [String(last.__sort_value), String(last.__cursor_id)] : null,
  };
}

function nodeConditions(filters: NodeFilters): Array<Frag | null> {
  return [
    applyText(sql`n.latest_name`, filters.name),
    filters.role !== undefined
      ? sql`LOWER(COALESCE(n.latest_role, '')) = ${filters.role.toLowerCase()}`
      : null,
    applyRange(sql`n.last_seen_at_ms`)(filters.seenFrom, filters.seenTo),
    filters.iata
      ? sql`EXISTS (
      SELECT 1 FROM meshcore_public.node_sightings sighting
      WHERE sighting.node_public_key = n.public_key
        AND sighting.iata = ${filters.iata}
    )`
      : null,
    filters.region
      ? applyEntityRegion(sql`n.public_key`, filters.region, filters.seenFrom, filters.seenTo)
      : null,
    filters.nearLat !== undefined && filters.nearLon !== undefined && filters.radiusKm !== undefined
      ? sql`n.location IS NOT NULL AND public.ST_DWithin(
        n.location,
        public.ST_SetSRID(public.ST_MakePoint(${filters.nearLon}, ${filters.nearLat}), 4326)::public.geography,
        ${filters.radiusKm * 1000}
      )`
      : null,
  ];
}

export class PostgresMeshcoreRepository implements MeshcoreRepository {
  constructor(
    private readonly db: SQL,
    private readonly observerActiveWindowMs = 300_000,
    private readonly now: () => number = Date.now,
  ) {}

  async health(): Promise<SchemaMetadata> {
    const result = await this.db<Row[]>`
      SELECT schema_id, schema_version, schema_hash
       FROM meshcore_public.schema_metadata WHERE singleton = ${1}`;
    const metadata = result[0];
    if (
      metadata?.schema_id !== EXPECTED_SCHEMA_ID ||
      Number(metadata.schema_version) !== EXPECTED_SCHEMA_VERSION ||
      typeof metadata.schema_hash !== "string" ||
      metadata.schema_hash.length === 0
    )
      throw Object.assign(new Error("Unsupported MeshCore public schema"), {
        code: "SCHEMA_MISMATCH",
      });
    const fingerprint = await this.computeSchemaFingerprint();
    if (fingerprint !== metadata.schema_hash)
      throw Object.assign(new Error("MeshCore public schema fingerprint mismatch"), {
        code: "SCHEMA_MISMATCH",
      });
    return {
      schema_id: metadata.schema_id,
      schema_version: Number(metadata.schema_version),
      schema_hash: metadata.schema_hash,
    };
  }

  private async computeSchemaFingerprint(): Promise<string> {
    // Constraint and index definitions are search-path dependent: PostgreSQL
    // omits schema qualifiers for relations visible through the current
    // search_path. The fingerprint pins `search_path = pg_catalog` on one
    // reserved connection so the contract hash is byte-stable across contexts.
    const client = await this.db.reserve();
    try {
      await client`SET search_path = pg_catalog`;
      try {
        return await this.computeSchemaFingerprintOnClient(client);
      } finally {
        await client`RESET search_path`;
      }
    } finally {
      client.release();
    }
  }

  private async computeSchemaFingerprintOnClient(
    client: Pick<SQL, never> & ((strings: TemplateStringsArray, ...values: unknown[]) => Frag),
  ): Promise<string> {
    // Explicit row shapes keep the fingerprint input byte-stable while the
    // generic Row stays unknown-valued everywhere else.
    const tables = (await client`
       SELECT table_name AS rel, table_type AS kind
       FROM information_schema.tables
       WHERE table_schema = 'meshcore_public'
       ORDER BY table_name`) as Array<{ rel: string; kind: string }>;
    const columns = (await client`
       SELECT table_name AS rel, ordinal_position AS position,
        column_name AS col, data_type AS type, is_nullable AS nullable,
        COALESCE(column_default, '') AS default_expr
       FROM information_schema.columns
       WHERE table_schema = 'meshcore_public'
       ORDER BY table_name, ordinal_position`) as Array<{
      rel: string;
      position: number | string;
      col: string;
      type: string;
      nullable: string;
      default_expr: string;
    }>;
    const constraints = (await client`
       SELECT cls.relname AS rel, con.conname AS name,
        pg_catalog.pg_get_constraintdef(con.oid) AS def
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
       JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
       WHERE ns.nspname = 'meshcore_public'
       ORDER BY cls.relname, con.conname`) as Array<{ rel: string; name: string; def: string }>;
    const indexes = (await client`
       SELECT indexname AS name, indexdef AS def
       FROM pg_catalog.pg_indexes
       WHERE schemaname = 'meshcore_public'
       ORDER BY indexname`) as Array<{ name: string; def: string }>;
    const lines = [
      `schema|${EXPECTED_SCHEMA_ID}|${EXPECTED_SCHEMA_VERSION}`,
      ...tables.map((row) => `table|${row.rel}|${row.kind}`),
      ...columns.map(
        (row) =>
          `column|${row.rel}|${row.position}|${row.col}|${row.type}|${row.nullable}|${row.default_expr}`,
      ),
      ...constraints.map((row) => `constraint|${row.rel}|${row.name}|${row.def}`),
      ...indexes.map((row) => `index|${row.name}|${row.def}`),
    ];
    return createHash("sha256").update(lines.join("\n")).digest("hex");
  }

  async listNodes(request: ListRequest<NodeFilters>) {
    const q = nodeConditions(request.filters);
    const sorts: Record<string, Frag> = {
      last_seen: sql`n.last_seen_at_ms`,
      first_seen: sql`n.first_seen_at_ms`,
      name: sql`LOWER(COALESCE(n.latest_name, ''))`,
      role: sql`LOWER(COALESCE(n.latest_role, ''))`,
    };
    const sort = sorts[request.sort]!;
    q.push(applyCursor(sort, sql`n.public_key`, request.after, request.order));
    const dir = directionFor(request.order);
    const rows = await this.db<Row[]>`
      SELECT ${NODE_SELECT},
      ${sort}::text AS __sort_value, n.public_key AS __cursor_id
      FROM meshcore_public.nodes n${where(q)} ORDER BY ${sort} ${dir}, n.public_key ${dir}
      LIMIT ${request.limit + 1}`;
    return page(rows, request.limit, mapNode);
  }

  async getNode(publicKey: string) {
    const rows = await this.db<Row[]>`
      SELECT ${NODE_SELECT} FROM meshcore_public.nodes n WHERE n.public_key = ${publicKey}`;
    return rows[0] ? mapNode(rows[0]) : null;
  }

  async getNeighborEvidence(publicKey: string): Promise<Row[]> {
    return this.db<Row[]>`
      WITH latest AS (
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
      WHERE latest.observer_public_key = ${publicKey}
      UNION ALL
      SELECT latest.observer_public_key AS counterpart_public_key,
        'inbound'::text AS direction, latest.observer_public_key AS reporting_observer,
        entry.calculated_last_heard_at_ms AS last_heard_at_ms, latest.received_at_ms,
        entry.snr, entry.rssi,
        ARRAY(SELECT membership.scope FROM meshcore_public.neighbor_entry_scopes membership
          WHERE membership.entry_id = entry.id ORDER BY membership.scope) AS regions
      FROM latest
      JOIN meshcore_public.neighbor_entries entry ON entry.snapshot_id = latest.id
      WHERE entry.neighbor_public_key = ${publicKey} AND latest.observer_public_key <> ${publicKey}
    )
    SELECT evidence.counterpart_public_key, evidence.direction,
      evidence.reporting_observer, evidence.last_heard_at_ms,
      evidence.received_at_ms, evidence.snr, evidence.rssi, evidence.regions,
      node.latest_name, node.latest_role
    FROM evidence LEFT JOIN meshcore_public.nodes node ON node.public_key = evidence.counterpart_public_key
    ORDER BY evidence.counterpart_public_key, evidence.direction`;
  }

  async listNodeAdverts(publicKey: string, request: ListRequest<object>) {
    return this.historyPage(
      sql`SELECT advert.id, advert.node_public_key, advert.packet_sha256, advert.advert_timestamp,
        advert.first_observed_at_ms, advert.name, advert.role, advert.latitude, advert.longitude,
        advert.flags, advert.signature_valid, advert.verified, advert.verification_error`,
      sql`meshcore_public.node_adverts advert`,
      sql`advert.node_public_key = ${publicKey}`,
      sql`advert.first_observed_at_ms`,
      sql`advert.id`,
      request,
      mapAdvert,
    );
  }

  async listNodeSightings(publicKey: string, request: ListRequest<object>) {
    return this.historyPage(
      sql`SELECT sighting.id, sighting.node_public_key, sighting.observer_public_key,
        sighting.iata, sighting.sighting_type, sighting.received_at_ms`,
      sql`meshcore_public.node_sightings sighting`,
      sql`sighting.node_public_key = ${publicKey}`,
      sql`sighting.received_at_ms`,
      sql`sighting.id`,
      request,
      mapSighting,
    );
  }

  async listNodeTelemetry(publicKey: string, request: ListRequest<object>) {
    return this.listTelemetry({
      ...request,
      filters: { node: publicKey },
      sort: "received_at",
    });
  }

  async listObservers(request: ListRequest<ObserverFilters>) {
    const filters = request.filters;
    const clauses: Array<Frag | null> = [];
    const activeCutoff = this.now() - this.observerActiveWindowMs;
    if (filters.active !== undefined) {
      const activeFilter = filters.active ? sql`>=` : sql`<`;
      clauses.push(sql`o.last_seen_at_ms ${activeFilter} ${activeCutoff}`);
    }
    clauses.push(applyText(sql`COALESCE(o.label, n.latest_name)`, filters.name));
    clauses.push(applyExact(sql`o.iata`, filters.iata));
    clauses.push(applyRange(sql`o.last_seen_at_ms`)(filters.seenFrom, filters.seenTo));
    if (filters.region) {
      clauses.push(
        applyEntityRegion(sql`o.public_key`, filters.region, filters.seenFrom, filters.seenTo),
      );
    }
    if (
      filters.nearLat !== undefined &&
      filters.nearLon !== undefined &&
      filters.radiusKm !== undefined
    ) {
      clauses.push(sql`n.location IS NOT NULL AND public.ST_DWithin(
        n.location,
        public.ST_SetSRID(public.ST_MakePoint(${filters.nearLon}, ${filters.nearLat}), 4326)::public.geography,
        ${filters.radiusKm * 1000}
      )`);
    }
    const sorts: Record<string, Frag> = {
      last_seen: sql`o.last_seen_at_ms`,
      first_seen: sql`o.first_seen_at_ms`,
      name: sql`LOWER(COALESCE(o.label, n.latest_name, ''))`,
    };
    const sort = sorts[request.sort]!;
    clauses.push(applyCursor(sort, sql`o.public_key`, request.after, request.order));
    const dir = directionFor(request.order);
    const rows = await this.db<Row[]>`
      SELECT ${observerSelect(activeCutoff)},
      ${sort}::text AS __sort_value, o.public_key AS __cursor_id
      FROM meshcore_public.observers o
      LEFT JOIN meshcore_public.nodes n ON n.public_key = o.public_key
      ${where(clauses)} ORDER BY ${sort} ${dir}, o.public_key ${dir}
      LIMIT ${request.limit + 1}`;
    return page(rows, request.limit, mapObserver);
  }

  async getObserver(publicKey: string) {
    const activeCutoff = this.now() - this.observerActiveWindowMs;
    const rows = await this.db<Row[]>`
      SELECT ${observerSelect(activeCutoff)}
      FROM meshcore_public.observers o
      LEFT JOIN meshcore_public.nodes n ON n.public_key = o.public_key
      WHERE o.public_key = ${publicKey}`;
    return rows[0] ? mapObserver(rows[0]) : null;
  }

  async getObserverStatus(publicKey: string) {
    const rows = await this.db<Row[]>`
      SELECT status.id, status.observer_public_key,
       status.iata, status.reported_at_ms, status.received_at_ms,
      status.origin, status.model, status.firmware_version
      FROM meshcore_public.observer_status status
      WHERE status.observer_public_key = ${publicKey}
      ORDER BY status.received_at_ms DESC, status.id DESC LIMIT 1`;
    return rows[0] ? mapObserverStatus(rows[0]) : null;
  }

  async listObserverMetrics(publicKey: string, request: ListRequest<object>) {
    return this.historyPage(
      sql`SELECT metric.id, metric.observer_public_key, metric.metric_name,
        metric.numeric_value, metric.text_value, metric.boolean_value, metric.unit,
        metric.reported_at_ms, metric.received_at_ms`,
      sql`meshcore_public.observer_metrics metric`,
      sql`metric.observer_public_key = ${publicKey}`,
      sql`metric.received_at_ms`,
      sql`metric.id`,
      request,
      mapObserverMetric,
    );
  }

  async getIataSummary(code: string) {
    const rows = await this.db<Row[]>`
      SELECT
      (SELECT count(DISTINCT node_public_key)::text FROM meshcore_public.node_sightings WHERE iata = ${code}) AS node_count,
      (SELECT count(*)::text FROM meshcore_public.observers WHERE iata = ${code}) AS observer_count,
      (SELECT count(*)::text FROM meshcore_public.packet_observations WHERE iata = ${code}) AS observation_count,
      (SELECT max(received_at_ms)::text FROM meshcore_public.packet_observations WHERE iata = ${code}) AS last_activity_at_ms`;
    const row = rows[0]!;
    return {
      node_count: safeCount(row.node_count),
      observer_count: safeCount(row.observer_count),
      observation_count: safeCount(row.observation_count),
      last_activity: mapHistory({
        last_activity_at_ms: row.last_activity_at_ms,
      }).last_activity_at,
    };
  }

  async listRegions(request: ListRequest<RegionFilters>) {
    const filters = request.filters;
    const clauses: Array<Frag | null> = [];
    if (filters.observedOnly) clauses.push(sql`registry.observation_count > 0`);
    if (filters.manuallyAdded !== undefined)
      clauses.push(sql`registry.manually_added = ${filters.manuallyAdded}`);
    if (filters.prefix) {
      clauses.push(sql`registry.region LIKE ${`${escapeLike(filters.prefix)}%`} ESCAPE '\\'`);
    }
    clauses.push(
      applyCursor(sql`registry.region`, sql`registry.region`, request.after, request.order),
    );
    const rows = await this.db<Row[]>`
      ${REGION_SUMMARY_SQL} ${where(clauses)}
      ORDER BY registry.region ${directionFor(request.order)} LIMIT ${request.limit + 1}`;
    return page(rows, request.limit, mapRegion);
  }

  async getRegion(region: string) {
    const rows = await this.db<Row[]>`${REGION_SUMMARY_SQL} WHERE registry.region = ${region}`;
    return rows[0] ? mapRegion(rows[0]) : null;
  }

  async listRegionNodes(region: string, request: ListRequest<object>) {
    const clauses: Array<Frag | null> = [applyEntityRegion(sql`n.public_key`, region)];
    clauses.push(
      applyCursor(sql`n.last_seen_at_ms`, sql`n.public_key`, request.after, request.order),
    );
    const dir = directionFor(request.order);
    const rows = await this.db<Row[]>`
      SELECT ${NODE_SELECT}, n.last_seen_at_ms::text AS __sort_value,
      n.public_key AS __cursor_id FROM meshcore_public.nodes n ${where(clauses)}
      ORDER BY n.last_seen_at_ms ${dir}, n.public_key ${dir} LIMIT ${request.limit + 1}`;
    return page(rows, request.limit, mapNode);
  }

  async listPackets(request: ListRequest<PacketFilters>) {
    const filters = request.filters;
    const clauses: Array<Frag | null> = [];
    for (const [column, value] of [
      [sql`packet.packet_sha256`, filters.hash],
      [sql`packet.logical_packet_id`, filters.logicalId],
      [sql`packet.packet_type`, filters.packetType],
      [sql`packet.payload_type`, filters.payloadType],
      [sql`packet.route_type`, filters.routeType],
      [sql`packet.decode_status`, filters.decodeStatus],
    ] as const) {
      clauses.push(applyExact(column, value));
    }
    const hasObservationFilter = Boolean(
      filters.observer ||
      filters.iata ||
      filters.node ||
      filters.receivedFrom !== undefined ||
      filters.receivedTo !== undefined,
    );
    let matchedReceivedAt: Frag = sql`packet.last_seen_at_ms`;
    if (hasObservationFilter) {
      const inner: Frag[] = [sql`observation.packet_sha256 = packet.packet_sha256`];
      if (filters.observer) inner.push(sql`observation.observer_public_key = ${filters.observer}`);
      if (filters.iata) inner.push(sql`observation.iata = ${filters.iata}`);
      if (filters.receivedFrom !== undefined)
        inner.push(sql`observation.received_at_ms >= ${filters.receivedFrom}`);
      if (filters.receivedTo !== undefined)
        inner.push(sql`observation.received_at_ms <= ${filters.receivedTo}`);
      if (filters.node)
        inner.push(sql`EXISTS (SELECT 1 FROM meshcore_public.node_sightings sighting
          WHERE sighting.packet_observation_id = observation.id
            AND sighting.node_public_key = ${filters.node})`);
      matchedReceivedAt = sql`(SELECT max(observation.received_at_ms)
        FROM meshcore_public.packet_observations observation
        WHERE ${joinWith(inner, " AND ")})`;
      clauses.push(sql`${matchedReceivedAt} IS NOT NULL`);
    }
    const sorts: Record<string, Frag> = {
      received_at: matchedReceivedAt,
      first_seen: sql`packet.first_seen_at_ms`,
    };
    const sort = sorts[request.sort]!;
    clauses.push(applyCursor(sort, sql`packet.packet_sha256`, request.after, request.order));
    const dir = directionFor(request.order);
    const rows = await this.db<Row[]>`
      SELECT packet.packet_sha256, packet.raw_packet_blob,
      packet.logical_packet_id, packet.packet_type, packet.payload_type, packet.route_type,
      packet.decode_status, packet.first_seen_at_ms, packet.last_seen_at_ms,
      ${sort}::text AS __sort_value, packet.packet_sha256 AS __cursor_id
      FROM meshcore_public.packets packet ${where(clauses)}
      ORDER BY ${sort} ${dir}, packet.packet_sha256 ${dir} LIMIT ${request.limit + 1}`;
    return page(rows, request.limit, mapPacket);
  }

  async getPacket(hash: string) {
    const rows = await this.db<Row[]>`
      SELECT packet_sha256, raw_packet_blob,
      logical_packet_id, packet_type, payload_type, route_type, decode_status,
      first_seen_at_ms, last_seen_at_ms FROM meshcore_public.packets WHERE packet_sha256 = ${hash}`;
    return rows[0] ? mapPacket(rows[0]) : null;
  }

  async listPacketObservations(hash: string, request: ListRequest<object>) {
    return this.historyPage(
      sql`SELECT observation.id, observation.packet_sha256,
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
      sql`meshcore_public.packet_observations observation`,
      sql`observation.packet_sha256 = ${hash}`,
      sql`observation.received_at_ms`,
      sql`observation.id`,
      request,
      mapPacketObservation,
    );
  }

  async listMessages(request: ListRequest<MessageFilters>) {
    const filters = request.filters;
    const filteredClauses: Array<Frag | null> = [];
    for (const [column, value] of [
      [sql`message.sender_public_key`, filters.sender],
      [sql`message.destination_public_key`, filters.destination],
      [sql`message.channel`, filters.channel],
      [sql`message.channel_name`, filters.channelName],
      [sql`message.message_type`, filters.messageType],
      [sql`message.encrypted`, filters.encrypted],
      [sql`message.signature_valid`, filters.signatureValid],
      [sql`observation.iata`, filters.iata],
    ] as const) {
      filteredClauses.push(applyExact(column, value));
    }
    filteredClauses.push(
      applyRange(sql`observation.received_at_ms`)(filters.receivedFrom, filters.receivedTo),
    );
    const outerClauses: Array<Frag | null> = [
      applyCursor(
        sql`summary.last_received_at_ms`,
        sql`summary.logical_id`,
        request.after,
        request.order,
      ),
    ];
    const dir = directionFor(request.order);
    const rows = await this.db<Row[]>`
      WITH matches AS (
        SELECT ${MESSAGE_SELECT}, observation.iata AS observation_iata,
          observation.received_at_ms AS observation_received_at_ms,
          COALESCE(packet.logical_packet_id, message.packet_sha256) AS logical_id
        FROM meshcore_public.messages message
        JOIN meshcore_public.packet_observations observation
          ON observation.id = message.packet_observation_id
        JOIN meshcore_public.packets packet
          ON packet.packet_sha256 = message.packet_sha256
        ${where(filteredClauses)}
      ), matched_ids AS (
        SELECT DISTINCT logical_id FROM matches
      ), matched_summary AS (
        SELECT logical_id,
          count(DISTINCT packet_observation_id)::text AS observation_count,
          array_agg(DISTINCT observation_iata ORDER BY observation_iata) AS iata
        FROM matches GROUP BY logical_id
      ), canonical AS (
        SELECT ${MESSAGE_SELECT}, observation.iata AS observation_iata,
          observation.received_at_ms AS observation_received_at_ms,
          COALESCE(packet.logical_packet_id, message.packet_sha256) AS logical_id
        FROM meshcore_public.messages message
        JOIN meshcore_public.packet_observations observation
          ON observation.id = message.packet_observation_id
        JOIN meshcore_public.packets packet
          ON packet.packet_sha256 = message.packet_sha256
        WHERE COALESCE(packet.logical_packet_id, message.packet_sha256) IN (
          SELECT logical_id FROM matched_ids
        )
      ), summary AS (
        SELECT logical_id, min(observation_received_at_ms) AS first_received_at_ms,
          max(observation_received_at_ms) AS last_received_at_ms,
          count(DISTINCT packet_observation_id)::text AS observation_count,
          array_agg(DISTINCT observation_iata ORDER BY observation_iata) AS iata
        FROM canonical GROUP BY logical_id
      ), representative AS (
        SELECT DISTINCT ON (logical_id) * FROM canonical
        ORDER BY logical_id, observation_received_at_ms DESC, packet_observation_id DESC
      )
      SELECT representative.*, summary.first_received_at_ms,
        summary.last_received_at_ms,
        summary.observation_count AS total_observation_count,
        summary.iata AS all_iata,
        matched_summary.observation_count AS matched_observation_count,
        matched_summary.iata AS matched_iata,
        summary.last_received_at_ms::text AS __sort_value,
        summary.logical_id AS __cursor_id
      FROM summary
      JOIN representative USING (logical_id)
      JOIN matched_summary USING (logical_id)
      ${where(outerClauses)}
      ORDER BY summary.last_received_at_ms ${dir},
        summary.logical_id ${dir} LIMIT ${request.limit + 1}`;
    return page(rows, request.limit, mapMessage);
  }

  async getMessage(id: string) {
    const rows = await this.db<Row[]>`
      WITH matches AS (
        SELECT ${MESSAGE_SELECT}, observation.iata AS observation_iata,
          observation.received_at_ms AS observation_received_at_ms,
          COALESCE(packet.logical_packet_id, message.packet_sha256) AS logical_id
        FROM meshcore_public.messages message
        JOIN meshcore_public.packet_observations observation
          ON observation.id = message.packet_observation_id
        JOIN meshcore_public.packets packet
          ON packet.packet_sha256 = message.packet_sha256
        WHERE COALESCE(packet.logical_packet_id, message.packet_sha256) = ${id}
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
        summary.last_received_at_ms,
        summary.observation_count AS total_observation_count,
        summary.iata AS all_iata,
        summary.observation_count AS matched_observation_count,
        summary.iata AS matched_iata
      FROM summary JOIN representative USING (logical_id)`;
    return rows[0] ? mapMessage(rows[0]) : null;
  }

  async listTelemetry(request: ListRequest<TelemetryFilters>) {
    const filters = request.filters;
    const clauses: Array<Frag | null> = [];
    for (const [column, value] of [
      [sql`telemetry.node_public_key`, filters.node],
      [sql`telemetry.metric_name`, filters.metric],
      [sql`observation.iata`, filters.iata],
    ] as const) {
      clauses.push(applyExact(column, value));
    }
    clauses.push(
      applyRange(sql`telemetry.received_at_ms`)(filters.receivedFrom, filters.receivedTo),
    );
    return this.protocolPage(
      sql`SELECT ${TELEMETRY_SELECT}, observation.iata`,
      sql`meshcore_public.telemetry telemetry JOIN meshcore_public.packet_observations observation
        ON observation.id = telemetry.packet_observation_id`,
      sql`telemetry.received_at_ms`,
      sql`telemetry.id`,
      request,
      clauses,
      mapTelemetry,
    );
  }

  async getTelemetry(id: string) {
    const rows = await this.db<Row[]>`
      SELECT ${TELEMETRY_SELECT}, observation.iata
      FROM meshcore_public.telemetry telemetry
      JOIN meshcore_public.packet_observations observation ON observation.id = telemetry.packet_observation_id
      WHERE telemetry.id = ${id}`;
    return rows[0] ? mapTelemetry(rows[0]) : null;
  }

  async listTraces(request: ListRequest<TraceFilters>) {
    const filters = request.filters;
    const clauses: Array<Frag | null> = [];
    for (const [column, value] of [
      [sql`trace.source_node_public_key`, filters.sourceNode],
      [sql`trace.tag`, filters.tag],
      [sql`observation.iata`, filters.iata],
    ] as const) {
      clauses.push(applyExact(column, value));
    }
    clauses.push(
      applyRange(sql`observation.received_at_ms`)(filters.receivedFrom, filters.receivedTo),
    );
    return this.protocolPage(
      sql`SELECT ${TRACE_SELECT}, observation.iata`,
      sql`meshcore_public.traces trace
      JOIN meshcore_public.packet_observations observation
        ON observation.id = trace.packet_observation_id
      JOIN meshcore_public.packets packet
        ON packet.packet_sha256 = trace.packet_sha256`,
      sql`observation.received_at_ms`,
      sql`observation.id`,
      request,
      clauses,
      mapTrace,
    );
  }

  async getTrace(id: string) {
    const rows = await this.db<Row[]>`
      SELECT ${TRACE_SELECT}, observation.iata
      FROM meshcore_public.traces trace
      JOIN meshcore_public.packet_observations observation ON observation.id = trace.packet_observation_id
      JOIN meshcore_public.packets packet ON packet.packet_sha256 = trace.packet_sha256
      WHERE trace.id = ${id}`;
    return rows[0] ? mapTrace(rows[0]) : null;
  }

  async listTraceHops(id: string) {
    const rows = await this.db<Row[]>`
      SELECT hop.id, hop.hop_index AS index,
      hop.prefix_hex, hop.prefix_length_bytes, hop.snr,
      hop.resolved_node_public_key AS resolved_node, hop.resolution_confidence,
      CASE WHEN hop.resolved_node_public_key IS NOT NULL THEN 'resolved'
        WHEN (SELECT count(*) FROM meshcore_public.node_prefix_candidates candidate
          WHERE candidate.prefix_hex = hop.prefix_hex
            AND candidate.prefix_length_bytes = hop.prefix_length_bytes) > 1 THEN 'ambiguous'
        ELSE 'unresolved' END AS resolution_status,
      ARRAY(SELECT json_build_object('public_key', candidate.node_public_key, 'confidence', candidate.confidence)
        FROM meshcore_public.node_prefix_candidates candidate
        WHERE candidate.prefix_hex = hop.prefix_hex
          AND candidate.prefix_length_bytes = hop.prefix_length_bytes
        ORDER BY candidate.confidence DESC, candidate.node_public_key) AS candidates
      FROM meshcore_public.trace_hops hop WHERE hop.trace_id = ${id} ORDER BY hop.hop_index`;
    return rows.map(mapHistory);
  }

  async getStats() {
    const now = this.now();
    const activeFrom = now - 86_400_000;
    const observerActiveFrom = now - this.observerActiveWindowMs;
    const rows = await this.db<Row[]>`
      SELECT
      (SELECT count(*)::text FROM meshcore_public.nodes) AS known_nodes,
      (SELECT count(*)::text FROM meshcore_public.nodes WHERE last_seen_at_ms >= ${activeFrom}) AS active_nodes,
      (SELECT count(*)::text FROM meshcore_public.observers) AS known_observers,
      (SELECT count(*)::text FROM meshcore_public.observers WHERE last_seen_at_ms >= ${observerActiveFrom}) AS active_observers,
      (SELECT count(*)::text FROM meshcore_public.region_scopes) AS configured_regions,
      (SELECT count(*)::text FROM meshcore_public.region_scopes WHERE observation_count > 0) AS observed_regions,
      (SELECT count(DISTINCT iata)::text FROM meshcore_public.packet_observations WHERE received_at_ms >= ${activeFrom}) AS active_iata,
      (SELECT count(DISTINCT packet_sha256)::text FROM meshcore_public.packet_observations WHERE received_at_ms >= ${activeFrom}) AS packets_24h,
      (SELECT count(DISTINCT COALESCE(packet.logical_packet_id, message.packet_sha256))::text
        FROM meshcore_public.messages message
        JOIN meshcore_public.packets packet ON packet.packet_sha256 = message.packet_sha256
        WHERE message.received_at_ms >= ${activeFrom}) AS messages_24h,
      (SELECT max(received_at_ms)::text FROM meshcore_public.packet_observations) AS last_seen_at_ms`;
    const row = rows[0]!;
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
      regions: {
        configured: safeCount(row.configured_regions),
        observed: safeCount(row.observed_regions),
      },
      active_iata: safeCount(row.active_iata),
      activity: {
        packets_24h: safeCount(row.packets_24h),
        messages_24h: safeCount(row.messages_24h),
        last_seen: mapHistory({ last_seen_at_ms: row.last_seen_at_ms }).last_seen_at,
      },
    };
  }

  async getActivity(input: { fromMs: number; toMs: number; intervalMs: number; iata?: string }) {
    const clauses: Frag[] = [
      sql`observation.received_at_ms >= ${input.fromMs}`,
      sql`observation.received_at_ms <= ${input.toMs}`,
    ];
    if (input.iata) clauses.push(sql`observation.iata = ${input.iata}`);
    const rows = await this.db<Row[]>`
      SELECT
      (floor(observation.received_at_ms / ${input.intervalMs}::numeric) * ${input.intervalMs}::numeric)::bigint AS bucket_at_ms,
      count(*)::text AS observations,
      count(DISTINCT observation.packet_sha256)::text AS packets,
       count(DISTINCT COALESCE(packet.logical_packet_id, message.packet_sha256))::text AS messages
      FROM meshcore_public.packet_observations observation
      LEFT JOIN meshcore_public.messages message ON message.packet_observation_id = observation.id
      LEFT JOIN meshcore_public.packets packet ON packet.packet_sha256 = message.packet_sha256
      ${where(clauses)} GROUP BY bucket_at_ms ORDER BY bucket_at_ms`;
    return rows.map((row) => ({
      bucket_at: mapHistory({ bucket_at_ms: row.bucket_at_ms }).bucket_at,
      observations: safeCount(row.observations),
      packets: safeCount(row.packets),
      messages: safeCount(row.messages),
    }));
  }

  private async historyPage(
    select: Frag,
    from: Frag,
    condition: Frag,
    sort: Frag,
    id: Frag,
    request: ListRequest<object>,
    mapper: (row: Row) => unknown = mapHistory,
  ) {
    const clauses: Array<Frag | null> = [condition];
    clauses.push(applyCursor(sort, id, request.after, request.order));
    const dir = directionFor(request.order);
    const rows = await this.db<Row[]>`
      ${select}, ${sort}::text AS __sort_value,
      ${id}::text AS __cursor_id FROM ${from} ${where(clauses)}
      ORDER BY ${sort} ${dir}, ${id} ${dir} LIMIT ${request.limit + 1}`;
    return page(rows, request.limit, mapper);
  }

  private async protocolPage<T>(
    select: Frag,
    from: Frag,
    sort: Frag,
    id: Frag,
    request: ListRequest<object>,
    clauses: Array<Frag | null>,
    mapper: (row: Row) => T,
  ) {
    clauses.push(applyCursor(sort, id, request.after, request.order));
    const dir = directionFor(request.order);
    const rows = await this.db<Row[]>`
      ${select}, ${sort}::text AS __sort_value,
      ${id}::text AS __cursor_id FROM ${from} ${where(clauses)}
      ORDER BY ${sort} ${dir}, ${id} ${dir} LIMIT ${request.limit + 1}`;
    return page(rows, request.limit, mapper);
  }
}

const REGION_SUMMARY_SQL = sql`WITH evidence AS (
    SELECT entity_public_key, region, evidence_received_at_ms
    FROM ${ENTITY_REGION_EVIDENCE}
  ), counts AS (
    SELECT evidence.region,
      count(DISTINCT node.public_key)::text AS node_count,
      count(DISTINCT observer.public_key)::text AS observer_count,
      max(evidence.evidence_received_at_ms)::text AS last_activity_at_ms
    FROM evidence
    LEFT JOIN meshcore_public.nodes node ON node.public_key = evidence.entity_public_key
    LEFT JOIN meshcore_public.observers observer ON observer.public_key = evidence.entity_public_key
    GROUP BY evidence.region
  )
  SELECT registry.region, registry.name, registry.first_seen_at_ms,
    registry.last_seen_at_ms, registry.manually_added,
    registry.observation_count::text AS observation_count,
    COALESCE(counts.node_count, '0') AS node_count,
    COALESCE(counts.observer_count, '0') AS observer_count,
    counts.last_activity_at_ms,
    registry.region AS __sort_value,
    registry.region AS __cursor_id
  FROM meshcore_public.region_scopes registry
  LEFT JOIN counts ON counts.region = registry.region`;

function mapRegion(row: Row) {
  const region = String(row.region);
  const encoded = encodeURIComponent(region);
  return {
    region: row.region,
    name: row.name ?? null,
    first_seen: isoTime(row.first_seen_at_ms),
    last_seen: isoTime(row.last_seen_at_ms),
    manually_added: Boolean(row.manually_added),
    observation_count: safeCount(row.observation_count),
    node_count: safeCount(row.node_count),
    observer_count: safeCount(row.observer_count),
    last_activity: mapHistory({ last_activity_at_ms: row.last_activity_at_ms }).last_activity_at,
    links: {
      nodes: `/v1/meshcore/regions/${encoded}/nodes`,
      observers: `/v1/meshcore/observers?region=${encoded}`,
    },
  };
}

export default PostgresMeshcoreRepository;
