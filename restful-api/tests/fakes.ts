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

export const KEY = "A".repeat(64);
export const OTHER_KEY = "B".repeat(64);
export const HASH = "c".repeat(64);
export const MESSAGE_ID = `lp_${"d".repeat(64)}`;

const emptyPage = (): Page<unknown> => ({
  items: [],
  hasMore: false,
  nextKey: null,
});

export class FakeRepository implements MeshcoreRepository {
  lastNodeRequest?: ListRequest<NodeFilters>;
  lastMessageRequest?: ListRequest<MessageFilters>;
  lastIataCode?: string;
  lastRegionLookup?: string;
  lastRegionRequest?: ListRequest<RegionFilters>;
  healthy = true;
  schemaMetadata = {
    schema_id: "meshcore-mqtt-broker-postgres-v1",
    schema_version: 9,
    schema_hash: "f".repeat(64),
  };

  async health() {
    if (!this.healthy) throw new Error("database down");
    return this.schemaMetadata;
  }
  async listNodes(request: ListRequest<NodeFilters>) {
    this.lastNodeRequest = request;
    return {
      items: [
        {
          public_key: KEY,
          name: "Node",
          role: "repeater",
          location: null,
          first_seen: "2026-01-01T00:00:00.000Z",
          last_seen: "2026-01-02T00:00:00.000Z",
          iata: ["JKG"],
          regions: ["public"],
        },
      ],
      hasMore: !request.after,
      nextKey: request.after ? null : (["100", KEY] as [string, string]),
    };
  }
  async getNode(publicKey: string) {
    return publicKey === KEY ? { public_key: KEY, name: "Node" } : null;
  }
  async getNeighborEvidence() {
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
  async listNodeAdverts() {
    return emptyPage();
  }
  async listNodeSightings() {
    return emptyPage();
  }
  async listNodeTelemetry() {
    return emptyPage();
  }
  async listObservers(_request: ListRequest<ObserverFilters>) {
    return emptyPage();
  }
  async getObserver(publicKey: string) {
    return publicKey === KEY
      ? { public_key: KEY, location: { latitude: 57, longitude: 14 } }
      : null;
  }
  async getObserverStatus() {
    return {
      observer_public_key: KEY,
      received_at: "2026-01-01T00:00:00.000Z",
    };
  }
  async listObserverMetrics() {
    return emptyPage();
  }
  async getIataSummary(code: string) {
    this.lastIataCode = code;
    return { node_count: 1, observer_count: 1 };
  }
  async listRegions(request: ListRequest<RegionFilters>) {
    this.lastRegionRequest = request;
    return {
      items: [
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
      ],
      hasMore: false,
      nextKey: null,
    };
  }
  async getRegion(region: string) {
    this.lastRegionLookup = region;
    if (region === "public") return { region: "public", name: "public", node_count: 1 };
    if (region === "se01") return { region: "se01", name: "Stockholms län", node_count: 0 };
    return null;
  }
  async listRegionNodes() {
    return emptyPage();
  }
  async listPackets(_request: ListRequest<PacketFilters>) {
    return emptyPage();
  }
  async getPacket(hash: string) {
    return hash === HASH ? { sha256: HASH, raw: "0xa1b2" } : null;
  }
  async listPacketObservations() {
    return emptyPage();
  }
  async listMessages(request: ListRequest<MessageFilters>) {
    this.lastMessageRequest = request;
    return emptyPage();
  }
  async getMessage(id: string) {
    return id === MESSAGE_ID ? { id, text: "hello" } : null;
  }
  async listTelemetry(_request: ListRequest<TelemetryFilters>) {
    return emptyPage();
  }
  async getTelemetry(id: string) {
    return id === "1" ? { id, metric: "battery" } : null;
  }
  async listTraces(_request: ListRequest<TraceFilters>) {
    return emptyPage();
  }
  async getTrace(id: string) {
    return id === "1" ? { id, tag: "test" } : null;
  }
  async listTraceHops() {
    return [{ index: 0, resolution_status: "ambiguous" }];
  }
  async getStats() {
    return { nodes: { known: 1 } };
  }
  async getActivity() {
    return [{ bucket_at: "2026-01-01T00:00:00.000Z", packets: 1 }];
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
        media_type: "text/markdown",
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
          media_type: "text/markdown",
          size: 7,
          snippet: "MeshCore",
        },
      ],
    };
  }
  async get(path: string) {
    return {
      path,
      media_type: "text/markdown",
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
