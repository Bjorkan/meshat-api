export type SortOrder = "asc" | "desc";
export type CursorKey = [string, string];

export type SchemaMetadata = {
  schema_id: string;
  schema_version: number;
  schema_hash: string;
};

export type Page<T> = {
  items: T[];
  hasMore: boolean;
  nextKey: CursorKey | null;
};

export type ListRequest<TFilters extends object> = {
  filters: TFilters;
  sort: string;
  order: SortOrder;
  limit: number;
  after?: CursorKey;
};

export type NodeFilters = {
  name?: string;
  role?: string;
  region?: string;
  iata?: string;
  seenFrom?: number;
  seenTo?: number;
  nearLat?: number;
  nearLon?: number;
  radiusKm?: number;
};

export type ObserverFilters = NodeFilters & { active?: boolean };
export type PacketFilters = {
  hash?: string;
  logicalId?: string;
  packetType?: string;
  payloadType?: string;
  routeType?: string;
  decodeStatus?: string;
  node?: string;
  observer?: string;
  iata?: string;
  receivedFrom?: number;
  receivedTo?: number;
};
export type MessageFilters = {
  sender?: string;
  destination?: string;
  channel?: string;
  channelName?: string;
  messageType?: string;
  encrypted?: boolean;
  signatureValid?: boolean;
  iata?: string;
  receivedFrom?: number;
  receivedTo?: number;
};
export type TelemetryFilters = {
  node?: string;
  metric?: string;
  iata?: string;
  receivedFrom?: number;
  receivedTo?: number;
};
export type TraceFilters = {
  sourceNode?: string;
  tag?: string;
  iata?: string;
  receivedFrom?: number;
  receivedTo?: number;
};

export type RegionFilters = {
  observedOnly?: boolean;
  manuallyAdded?: boolean;
  prefix?: string;
};

import type {
  PublicActivityBucket,
  PublicAdvert,
  PublicIataEntry,
  PublicMessage,
  PublicNode,
  PublicObserver,
  PublicObserverMetric,
  PublicObserverStatus,
  PublicPacket,
  PublicPacketObservation,
  PublicRegion,
  PublicSighting,
  PublicStats,
  PublicTelemetry,
  PublicTrace,
  PublicTraceHop,
} from "./contracts.js";

/** Raw DB row shape consumed by the neighbor aggregation (external boundary). */
export type NeighborEvidenceRow = Record<string, unknown>;

export interface MeshcoreRepository {
  health(): Promise<SchemaMetadata>;
  listNodes(request: ListRequest<NodeFilters>): Promise<Page<PublicNode>>;
  getNode(publicKey: string): Promise<PublicNode | null>;
  getNeighborEvidence(publicKey: string): Promise<NeighborEvidenceRow[]>;
  listNodeAdverts(publicKey: string, request: ListRequest<object>): Promise<Page<PublicAdvert>>;
  listNodeSightings(publicKey: string, request: ListRequest<object>): Promise<Page<PublicSighting>>;
  listNodeTelemetry(
    publicKey: string,
    request: ListRequest<object>,
  ): Promise<Page<PublicTelemetry>>;
  listObservers(request: ListRequest<ObserverFilters>): Promise<Page<PublicObserver>>;
  getObserver(publicKey: string): Promise<PublicObserver | null>;
  getObserverStatus(publicKey: string): Promise<PublicObserverStatus | null>;
  listObserverMetrics(
    publicKey: string,
    request: ListRequest<object>,
  ): Promise<Page<PublicObserverMetric>>;
  getIataSummary(code: string): Promise<PublicIataEntry["summary"]>;
  listRegions(request: ListRequest<RegionFilters>): Promise<Page<PublicRegion>>;
  getRegion(region: string): Promise<PublicRegion | null>;
  listRegionNodes(region: string, request: ListRequest<object>): Promise<Page<PublicNode>>;
  listPackets(request: ListRequest<PacketFilters>): Promise<Page<PublicPacket>>;
  getPacket(hash: string): Promise<PublicPacket | null>;
  listPacketObservations(
    hash: string,
    request: ListRequest<object>,
  ): Promise<Page<PublicPacketObservation>>;
  listMessages(request: ListRequest<MessageFilters>): Promise<Page<PublicMessage>>;
  getMessage(id: string): Promise<PublicMessage | null>;
  listTelemetry(request: ListRequest<TelemetryFilters>): Promise<Page<PublicTelemetry>>;
  getTelemetry(id: string): Promise<PublicTelemetry | null>;
  listTraces(request: ListRequest<TraceFilters>): Promise<Page<PublicTrace>>;
  getTrace(id: string): Promise<PublicTrace | null>;
  listTraceHops(id: string): Promise<PublicTraceHop[]>;
  getStats(): Promise<PublicStats>;
  getActivity(input: {
    fromMs: number;
    toMs: number;
    intervalMs: number;
    iata?: string;
  }): Promise<PublicActivityBucket[]>;
}
