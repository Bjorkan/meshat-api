import type {
  ListRequest,
  MeshcoreRepository,
  MessageFilters,
  NodeFilters,
  ObserverFilters,
  PacketFilters,
  Page,
  RegionFilters,
  TelemetryFilters,
  TraceFilters,
} from "../src/domain.js";
import type { DocumentationService, DocsMetadata } from "../src/docs.js";
import type {
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
} from "../src/contracts.js";

export const KEY = "A".repeat(64);
export const OTHER_KEY = "B".repeat(64);
export const HASH = "c".repeat(64);
export const MESSAGE_ID = `lp_${"d".repeat(64)}`;

const emptyPage = <T>(): Page<T> => ({
  items: [],
  hasMore: false,
  nextKey: null,
});

function page<T>(items: T[], hasMore = false, nextKey: [string, string] | null = null): Page<T> {
  return { items, hasMore, nextKey };
}

const baseNode: PublicNode = {
  public_key: KEY,
  owner_public_key: null,
  name: "Node",
  role: "repeater",
  location: null,
  first_seen: "2026-01-01T00:00:00.000Z",
  last_seen: "2026-01-02T00:00:00.000Z",
  iata: ["JKG"],
  regions: ["public"],
};

const baseObserver: PublicObserver = {
  public_key: KEY,
  name: "Observer",
  active: true,
  iata: "JKG",
  regions: ["public"],
  location: { latitude: 57, longitude: 14 },
  first_seen: "2026-01-01T00:00:00.000Z",
  last_seen: "2026-01-02T00:00:00.000Z",
};

const baseMessage: PublicMessage = {
  id: MESSAGE_ID,
  representative_packet_sha256: HASH,
  type: "TXT_MSG",
  channel: 0,
  channel_index: null,
  channel_name: null,
  sender: null,
  destination: null,
  encrypted: false,
  text: "hello",
  signature_valid: null,
  iata: ["JKG"],
  observation_count: 1,
  matched: { iata: ["JKG"], observation_count: 1 },
  reported_at: "2026-01-01T00:00:01.000Z",
  first_received_at: "2026-01-01T00:00:00.000Z",
  last_received_at: "2026-01-01T00:00:02.000Z",
};

const basePacket: PublicPacket = {
  sha256: HASH,
  logical_id: MESSAGE_ID,
  packet_type: "TXT_MSG",
  payload_type: "GROUPTEXT",
  route_type: "FLOOD",
  decode_status: "decoded",
  raw: "0xa1b2",
  first_seen: "2026-01-01T00:00:00.000Z",
  last_seen: "2026-01-01T00:00:00.000Z",
};

const baseTelemetry: PublicTelemetry = {
  id: "1",
  packet_sha256: HASH,
  node: KEY,
  metric: "battery",
  value: { type: "number", value: 4.1 },
  unit: "V",
  channel: null,
  iata: "JKG",
  reported_at: "2026-01-01T00:00:00.000Z",
  received_at: "2026-01-01T00:00:00.000Z",
};

const baseTrace: PublicTrace = {
  id: "1",
  packet_sha256: HASH,
  logical_id: null,
  source_node: null,
  observer: KEY,
  tag: "test",
  iata: "JKG",
  reported_at: null,
  received_at: "2026-01-01T00:00:00.000Z",
};

const traceHops: PublicTraceHop[] = [
  {
    id: "1",
    index: 0,
    prefix_hex: "aabbccdd",
    prefix_length_bytes: 4,
    snr: 5.5,
    resolved_node: null,
    resolution_confidence: null,
    resolution_status: "ambiguous",
    candidates: [
      { public_key: KEY, confidence: 0.9 },
      { public_key: OTHER_KEY, confidence: 0.4 },
    ],
  },
];

const statsFixture: PublicStats = {
  nodes: { known: 1, active_24h: 1 },
  observers: { known: 1, active: 1, active_window_seconds: 300 },
  regions: { configured: 329, observed: 27 },
  active_iata: 17,
  activity: {
    packets_24h: 68123,
    messages_24h: 3079,
    last_seen: "2026-08-25T08:54:59.852Z",
  },
};

export class FakeRepository implements MeshcoreRepository {
  lastNodeRequest?: ListRequest<NodeFilters>;
  lastMessageRequest?: ListRequest<MessageFilters>;
  lastIataCode?: string;
  lastRegionLookup?: string;
  lastRegionRequest?: ListRequest<RegionFilters>;
  healthy = true;
  /** When true, detail lookups include internal fields the wire must strip. */
  leakInternalFields = false;
  schemaMetadata = {
    schema_id: "meshcore-mqtt-broker-postgres-v1",
    schema_version: 9,
    schema_hash: "f".repeat(64),
  };

  async health() {
    if (!this.healthy) throw new Error("database down");
    return this.schemaMetadata;
  }

  async listNodes(request: ListRequest<NodeFilters>): Promise<Page<PublicNode>> {
    this.lastNodeRequest = request;
    return page([baseNode], !request.after, request.after ? null : ["100", KEY]);
  }

  async getNode(publicKey: string): Promise<PublicNode | null> {
    if (publicKey !== KEY) return null;
    if (this.leakInternalFields)
      return {
        ...baseNode,
        // Internal-only fields that must never reach the wire.
        password: "secret",
        private_metadata: { nested: true },
      } as unknown as PublicNode;
    return baseNode;
  }

  async getNeighborEvidence(): Promise<
    Page<unknown> extends never ? never : Array<Record<string, unknown>>
  > {
    return [
      {
        counterpart_public_key: OTHER_KEY,
        direction: "outbound",
        reporting_observer: KEY,
        last_heard_at_ms: "1000",
        snr: 8,
        rssi: -90,
        regions: ["public"],
        latest_name: "Peer",
        latest_role: "repeater",
      },
      {
        counterpart_public_key: OTHER_KEY,
        direction: "inbound",
        reporting_observer: OTHER_KEY,
        last_heard_at_ms: "2000",
        snr: 9,
        rssi: -88,
        regions: ["public"],
      },
    ];
  }

  async listNodeAdverts(): Promise<Page<PublicAdvert>> {
    return emptyPage();
  }
  async listNodeSightings(): Promise<Page<PublicSighting>> {
    return emptyPage();
  }
  async listNodeTelemetry(): Promise<Page<PublicTelemetry>> {
    return page([{ ...baseTelemetry }]);
  }
  async listObservers(_request: ListRequest<ObserverFilters>): Promise<Page<PublicObserver>> {
    return page([{ ...baseObserver }]);
  }
  async getObserver(publicKey: string): Promise<PublicObserver | null> {
    return publicKey === KEY ? { ...baseObserver } : null;
  }
  async getObserverStatus(): Promise<PublicObserverStatus | null> {
    return {
      id: "1",
      observer: KEY,
      iata: "JKG",
      reported_at: "2026-01-01T00:00:00.000Z",
      received_at: "2026-01-01T00:00:00.000Z",
      origin: "Stockholm observer",
      model: "T-Deck",
      firmware_version: "1.2.3",
    };
  }
  async listObserverMetrics(): Promise<Page<PublicObserverMetric>> {
    return page([
      {
        id: "1",
        observer: KEY,
        metric: "battery",
        value: { type: "number", value: 4.1 },
        unit: "V",
        reported_at: "2026-01-01T00:00:00.000Z",
        received_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
  }
  async getIataSummary(code: string): Promise<PublicIataEntry["summary"]> {
    this.lastIataCode = code;
    return { node_count: 1, observer_count: 1, observation_count: 2, last_activity: null };
  }
  async listRegions(request: ListRequest<RegionFilters>): Promise<Page<PublicRegion>> {
    this.lastRegionRequest = request;
    return page([
      {
        region: "public",
        name: "public",
        first_seen: null,
        last_seen: null,
        manually_added: false,
        observation_count: 1,
        node_count: 1,
        observer_count: 1,
        last_activity: null,
        links: {
          nodes: "/v1/meshcore/regions/public/nodes",
          observers: "/v1/meshcore/observers?region=public",
        },
      },
    ]);
  }
  async getRegion(region: string): Promise<PublicRegion | null> {
    this.lastRegionLookup = region;
    if (region === "public")
      return {
        region: "public",
        name: "public",
        first_seen: null,
        last_seen: null,
        manually_added: false,
        observation_count: 1,
        node_count: 1,
        observer_count: 1,
        last_activity: null,
        links: {
          nodes: "/v1/meshcore/regions/public/nodes",
          observers: "/v1/meshcore/observers?region=public",
        },
      };
    if (region === "se01")
      return {
        region: "se01",
        name: "Stockholms län",
        first_seen: null,
        last_seen: null,
        manually_added: true,
        observation_count: 0,
        node_count: 0,
        observer_count: 0,
        last_activity: null,
        links: {
          nodes: "/v1/meshcore/regions/se01/nodes",
          observers: "/v1/meshcore/observers?region=se01",
        },
      };
    return null;
  }
  async listRegionNodes(): Promise<Page<PublicNode>> {
    return emptyPage();
  }
  async listPackets(_request: ListRequest<PacketFilters>): Promise<Page<PublicPacket>> {
    return page([{ ...basePacket }]);
  }
  async getPacket(hash: string): Promise<PublicPacket | null> {
    if (hash !== HASH) return null;
    return { ...basePacket, sha256: hash };
  }
  async listPacketObservations(): Promise<Page<PublicPacketObservation>> {
    return page([
      {
        id: "1",
        packet_sha256: HASH,
        observer: KEY,
        iata: "JKG",
        received_at: "2026-01-01T00:00:00.000Z",
        reported_at: null,
        signal: { rssi: -90, snr: 8, score: null },
        direction: "outbound",
        path: [],
      },
    ]);
  }
  async listMessages(request: ListRequest<MessageFilters>): Promise<Page<PublicMessage>> {
    this.lastMessageRequest = request;
    return page([{ ...baseMessage }]);
  }
  async getMessage(id: string): Promise<PublicMessage | null> {
    if (id !== MESSAGE_ID) return null;
    return { ...baseMessage, id };
  }
  async listTelemetry(_request: ListRequest<TelemetryFilters>): Promise<Page<PublicTelemetry>> {
    return page([{ ...baseTelemetry }]);
  }
  async getTelemetry(id: string): Promise<PublicTelemetry | null> {
    if (id !== "1") return null;
    return { ...baseTelemetry, id };
  }
  async listTraces(_request: ListRequest<TraceFilters>): Promise<Page<PublicTrace>> {
    return page([{ ...baseTrace }]);
  }
  async getTrace(id: string): Promise<PublicTrace | null> {
    if (id !== "1") return null;
    return { ...baseTrace, id };
  }
  async listTraceHops(): Promise<PublicTraceHop[]> {
    return traceHops.map((hop) => ({ ...hop }));
  }
  async getStats(): Promise<PublicStats> {
    return { ...statsFixture };
  }
  async getActivity(): Promise<
    Array<{ bucket_at: string; observations: number; packets: number; messages: number }>
  > {
    return [{ bucket_at: "2026-01-01T00:00:00.000Z", observations: 2, packets: 1, messages: 1 }];
  }
}

export class FakeDocs implements DocumentationService {
  state: DocsMetadata = {
    repository: "https://example.test/docs.git",
    ref: "main",
    commit: "abc",
    status: "fresh",
  };
  async refresh() {}
  metadata() {
    return this.state;
  }
  async index() {
    return [
      {
        path: "guide.md",
        title: "Guide",
        media_type: "text/markdown" as const,
        size: 7,
      },
    ];
  }
  async search(query: string, limit: number) {
    return {
      query,
      limit,
      returned: 1,
      total_matches: 1,
      scan_complete: true,
      truncated: false,
      results: [
        {
          path: "guide.md",
          title: "Guide",
          media_type: "text/markdown" as const,
          size: 7,
          snippet: "MeshCore",
        },
      ],
    };
  }
  async get(path: string) {
    return {
      path,
      media_type: "text/markdown" as const,
      content: "# Guide",
      encoding: "utf-8" as const,
      source: {
        repository: this.state.repository,
        ref: this.state.ref,
        commit: this.state.commit,
      },
    };
  }
}
