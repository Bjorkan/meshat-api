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

export interface MeshcoreRepository {
  health(): Promise<SchemaMetadata>;
  listNodes(request: ListRequest<NodeFilters>): Promise<Page<unknown>>;
  getNode(publicKey: string): Promise<unknown>;
  getNeighborEvidence(publicKey: string): Promise<unknown[]>;
  listNodeAdverts(publicKey: string, request: ListRequest<object>): Promise<Page<unknown>>;
  listNodeSightings(publicKey: string, request: ListRequest<object>): Promise<Page<unknown>>;
  listNodeTelemetry(publicKey: string, request: ListRequest<object>): Promise<Page<unknown>>;
  listObservers(request: ListRequest<ObserverFilters>): Promise<Page<unknown>>;
  getObserver(publicKey: string): Promise<unknown>;
  getObserverStatus(publicKey: string): Promise<unknown>;
  listObserverMetrics(publicKey: string, request: ListRequest<object>): Promise<Page<unknown>>;
  getIataSummary(code: string): Promise<unknown>;
  listRegions(request: ListRequest<RegionFilters>): Promise<Page<unknown>>;
  getRegion(region: string): Promise<unknown>;
  listRegionNodes(region: string, request: ListRequest<object>): Promise<Page<unknown>>;
  listPackets(request: ListRequest<PacketFilters>): Promise<Page<unknown>>;
  getPacket(hash: string): Promise<unknown>;
  listPacketObservations(hash: string, request: ListRequest<object>): Promise<Page<unknown>>;
  listMessages(request: ListRequest<MessageFilters>): Promise<Page<unknown>>;
  getMessage(id: string): Promise<unknown>;
  listTelemetry(request: ListRequest<TelemetryFilters>): Promise<Page<unknown>>;
  getTelemetry(id: string): Promise<unknown>;
  listTraces(request: ListRequest<TraceFilters>): Promise<Page<unknown>>;
  getTrace(id: string): Promise<unknown>;
  listTraceHops(id: string): Promise<unknown[]>;
  getStats(): Promise<unknown>;
  getActivity(input: {
    fromMs: number;
    toMs: number;
    intervalMs: number;
    iata?: string;
  }): Promise<unknown[]>;
}
