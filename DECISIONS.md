# Implementation decisions and reference limitations

## Public terminology

- Database columns named `iata` represent geographic MQTT/IATA ingress.
- Public MeshCore `regions` are logical neighbor scopes derived from `neighbor_entry_scopes` and `neighbor_snapshot_scopes`.
- The literal scope `*` is preserved as reported because the reference project does not define a different public interpretation.

## Neighbor evidence

- The current neighbor view uses the latest public snapshot per reporting observer.
- `reported` means evidence exists in one direction. `reciprocal` requires reports in both directions.
- Public projections omit the private replay classification. Evidence counts therefore count public reports and cannot claim independent RF transmissions.

## Trace hops

- The reference documentation mentions `trace_hops.resolution_status`, but the public table does not contain that column.
- The API reports resolved hops directly and derives current `ambiguous` versus `unresolved` status from `node_prefix_candidates`. This is current candidate state, not guaranteed ingestion-time state.

## IATA registry

- The Swedish primary/secondary mapping is REST-owned domain data copied from the reference `config.yaml`.
- The reference attribution notice does not identify an external source or license beyond pointing back to that configuration, so no additional attribution was invented.
- Secondary-code detail resolves activity and filtered links to its configured primary IATA because broker ingest accepts primary codes only.
- Unknown IATA filters are rejected; malformed IATA and well-formed unconfigured detail lookups remain distinct invalid/not-found cases.

## Database constraints

- Runtime readiness requires schema ID `meshcore-mqtt-broker-postgres-v1`, version `8`.
- Production verification confirmed that `meshcore_http` can execute the qualified PostGIS functions used by indexed radius searches.
- The current public schema lacks ideal leading timeline indexes for some global telemetry and aggregate queries. REST keeps all result sets bounded, but adding indexes requires a change to the read-only reference/database project and is outside this workspace's writable scope.

## MCP protocol

- MCP uses the modular TypeScript SDK V2 packages at `2.0.0`; the monolithic V1 SDK is not installed.
- `createMcpHandler` runs with `legacy: "reject"` and serves only protocol `2026-07-28`.
- The service is stateless per request and does not emit or require MCP session IDs.

## Observer and message semantics

- Observer `active` means accepted ingest within `OBSERVER_ACTIVE_WINDOW_MS` (default five minutes), not process-local MQTT socket ownership.
- Public messages are grouped by `COALESCE(logical_packet_id, packet_sha256)`. The stable logical identity is the public message ID and always uses the required `lp_` prefix; `representative_packet_sha256` names the packet behind the latest matching observation, and packet search accepts `logical_id` to list every packet variant.
- Message search returns the canonical resource fields for a logical ID (identical to `get_message`) plus an explicit `matched` object (`iata`, `observation_count`) describing only the query-scope evidence.
- Observer region filters are evidence-time aware: with `seen_from`/`seen_to` supplied, the region evidence must come from a neighbor report in the same window; otherwise the region condition describes ever-reported evidence.
- Logical IDs accept both hex cases and normalize to lowercase; advertised tool schemas and runtime validators use the same explicit pattern `^lp_[0-9a-fA-F]{64}$`.
- Stats and activity count distinct logical messages rather than observation-level message rows, and public aggregate counts are JSON integers. Stats expose `regions` as `{ configured, observed }` populations.
- Traces are observation-level events exposing `observer` and `logical_id`; they are intentionally not aggregated.

## MeshCore region scopes

- The broker normalizes reported MeshCore region scopes to canonical lowercase `se` (Sweden), `seXX` (county), and `seXXXX` (municipality) using the SCB "Län och kommuner" code list with municipality names hardcoded from the official Swedish municipality list (for example `Halmstads kommun`). The firmware `*` scope is named `Unscoped`; unknown scopes keep the scope code as their name.
- Schema v8 adds the public `region_scopes` registry: `region`, `name`, `first_seen_at_ms`, `last_seen_at_ms`, `manually_added`, and `observation_count`. The broker seeds every built-in Swedish scope as `manually_added` and upserts any scope detected in neighbor evidence. REST lists and resolves regions from this registry, so registered regions return zero counts before the first evidence arrives; Swedish region inputs normalize case-insensitively.

## Public documentation surface

- Public checkout content is intentionally narrower than the configured docs subtree: only lowercase `**/*.md` and exactly `meshtastic/example.yaml` are indexed, searched, or served.
- Public documents are valid UTF-8 text only. Binary assets, other YAML files, MDX, and other existing repository assets are treated as not found rather than encoded or exposed.
- Inline documents default to and are capped at 65536 bytes. Oversized documents do not appear in index/search.
- Search scans deterministically sorted candidates under fixed file/byte work limits. `total_matches` is exact when `scan_complete` is true; `truncated` is true when scanning is incomplete or the result limit omits matches. Search is deliberately non-cursor-based.
- MCP validates each REST docs response with a tool-specific schema and emits no synthetic `next_cursor` for documentation search.

## Deep regression remediation round (2026-08-23, schema v9)

Decisions from the normative bug-fix report; details and tests in `FIXLOG.md`.

- REST and MCP are deployed as one atomic release unit: `RELEASE_ID` (REST, default `1.0.0`) and `MCP_RELEASE_ID` (default `2.0.0`) are published in root metadata, `/healthz`, `/readyz`, and the OpenAPI version; MCP `/readyz` forwards the REST release id plus schema version and fingerprint so a stale MCP against a newer REST is observable from a fresh session.
- Schema v9 replaces the schema-ID copy in `schema_hash` with a real SHA-256 fingerprint over a canonical serialization of the public catalog contract (tables, columns in order with type/nullability/default, constraints, indexes, schema id/version). Broker and REST compute it identically; readiness refuses on mismatch. The static initdb asset stores `pending`, which the first broker start repairs explicitly; provisioning paths never silently overwrite an existing marker.
- One canonical entity-region evidence relation (entry scopes for the entity as neighbor UNION snapshot scopes for the entity as observer, each with evidence receipt time) drives node region filters, observer region filters, region nodes, and region summary counts. A reporter never inherits a reported neighbor's region, `observer_count` equals the distinct observers matching `search_observers(region=...)`, and combining a region/IATA filter with `seen_from`/`seen_to` constrains that same evidence population to the window.
- The activity time series has no `region` filter in v1 (REST parameter removed and rejected, MCP argument removed, region `links.activity` removed) until per-observation region attribution evidence exists.
- `region_scopes` is a derived aggregate over retained neighbor scope evidence: ingest ensures catalog rows and rebuilds affected scopes, reprocess rebuilds pre-delete scopes after cleanup, retention rebuilds post-delete, and scopes without retained evidence reset counts/boundaries to zero/NULL while keeping catalog metadata. Repeated reprocessing is bit-identical.
- Observer IATA aggregates recompute once per `(observer_id, iata)` group per retention batch instead of per deleted row, eliminating double-decrement.
- All trusted advert-derived node state — name, role, location, and now `owner_public_key` — updates only from verified adverts by observation order; owner is stored on private advert rows so rebuilds derive it from retained verified adverts. Prefix resolution requires exactly one trusted (verified-evidence) candidate: zero trusted stays unresolved regardless of unverified candidates.
- Packet decode reprocess uses replace semantics: all packet-owned decoder-derived advert state is removed before the new decode, then canonical/prefix state rebuilds from remaining evidence, so ADVERT→OTHER cannot leave stale adverts.
- TRACE logical identity excludes SNR entirely; observation metadata must not fork transmission identity.
- `observers.latest_iata` breaks equal-receipt ties deterministically by `(received_at_ms, event_id)` via the new private `latest_iata_event_id` column, used identically in live ingest and retention recomputation.
- Trace hop classification: stored ingestion-time resolution means `resolved`; more than one current candidate means `ambiguous`; zero or one current candidate without stored resolution means `unresolved`. Late candidates never retroactively resolve historical hops.
- Region `prefix` filtering lowercases only Swedish standard codes (`se`, `seXX`, `seXXXX`) before SQL and cursor fingerprints; unknown custom scopes keep their case.
- Every MCP tool now validates REST responses against explicit semantic resource schemas (Node, Observer, Region, IATA, Packet, LogicalMessage, Telemetry, Trace, Stats, ActivityBucket, Source/Overview, Neighbor); violations surface as `UPSTREAM_CONTRACT_ERROR` tool errors rather than invalid structured content. Detail tools return the validated resource directly instead of the REST envelope.
