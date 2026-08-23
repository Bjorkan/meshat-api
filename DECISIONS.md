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
- Stats and activity count distinct logical messages rather than observation-level message rows, and public aggregate counts are JSON integers.

## MeshCore region scopes

- The broker normalizes reported MeshCore region scopes to canonical lowercase `se` (Sweden), `seXX` (county), and `seXXXX` (municipality) using the SCB "Län och kommuner" code list with municipality names hardcoded from the official Swedish municipality list (for example `Halmstads kommun`). The firmware `*` scope is named `Unscoped`; unknown scopes keep the scope code as their name.
- Schema v8 adds the public `region_scopes` registry: `region`, `name`, `first_seen_at_ms`, `last_seen_at_ms`, `manually_added`, and `observation_count`. The broker seeds every built-in Swedish scope as `manually_added` and upserts any scope detected in neighbor evidence. REST lists and resolves regions from this registry, so registered regions return zero counts before the first evidence arrives; Swedish region inputs normalize case-insensitively.

## Public documentation surface

- Public checkout content is intentionally narrower than the configured docs subtree: only lowercase `**/*.md` and exactly `meshtastic/example.yaml` are indexed, searched, or served.
- Public documents are valid UTF-8 text only. Binary assets, other YAML files, MDX, and other existing repository assets are treated as not found rather than encoded or exposed.
- Inline documents default to and are capped at 65536 bytes. Oversized documents do not appear in index/search.
- Search scans deterministically sorted candidates under fixed file/byte work limits. `total_matches` is exact when `scan_complete` is true; `truncated` is true when scanning is incomplete or the result limit omits matches. Search is deliberately non-cursor-based.
- MCP validates each REST docs response with a tool-specific schema and emits no synthetic `next_cursor` for documentation search.
