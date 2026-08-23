# Meshat.se Public API Contract

This file defines the intended public HTTP surface. It is authoritative for URL naming and public resource semantics.

The API is public, anonymous and read-only.

Base URL:

```text
https://api.meshat.se/v1
```

Swagger UI is separate and lives at:

```text
https://api.meshat.se/docs
```

OpenAPI JSON:

```text
https://api.meshat.se/openapi.json
```

Meshat.se documentation content API:

```text
https://api.meshat.se/v1/docs
```

## Contract rules

- Never expose PostgreSQL tables, schemas, columns or SQL as public API concepts.
- Never add `/v1/tables`, `/v1/query`, `/v1/schema` or equivalent.
- Public objects are normalized domain objects.
- Public timestamps are ISO 8601 UTC.
- Large collections use opaque stateless cursors.
- Filters and sorting are endpoint-specific allowlists.
- `limit` is bounded per endpoint.
- No endpoint requires authentication or an API key.
- All error bodies use a stable machine-readable `error.code`.

---

# 1. Platform discovery

## GET `/v1/sources`

Lists network sources exposed by Meshat.se.

Example:

```json
{
  "data": [
    {
      "id": "meshcore",
      "name": "MeshCore",
      "description": "Information om MeshCore-nätverket i Sverige",
      "status": "available",
      "api_version": "v1",
      "url": "/v1/meshcore",
      "documentation_url": "/v1/docs",
      "capabilities": [
        "nodes",
        "observers",
        "neighbors",
        "regions",
        "iata",
        "packets",
        "messages",
        "telemetry",
        "traces",
        "statistics"
      ]
    }
  ]
}
```

Future:

```json
{
  "id": "meshtastic",
  "name": "Meshtastic",
  "url": "/v1/meshtastic"
}
```

---

# 2. Documentation

REST owns the cached checkout of:

```text
https://codeberg.org/meshat/hemsidan.git
```

Only the repository `/docs` subtree is public through these routes.

## GET `/v1/docs`

Returns a recursive sorted index, not all contents at once.

Example:

```json
{
  "data": {
    "repository": "https://codeberg.org/meshat/hemsidan.git",
    "ref": "<resolved-ref>",
    "commit": "0123456789abcdef...",
    "status": "fresh",
    "files": [
      {
        "path": "meshcore/getting-started.md",
        "title": "Getting started with MeshCore",
        "media_type": "text/markdown",
        "size": 4821
      }
    ]
  }
}
```

`status` may be `fresh`, `stale` or `unavailable` as appropriate.

## GET `/v1/docs/search?q={query}&limit={n}`

Searches only documentation content.

Example:

```json
{
  "data": [
    {
      "path": "meshcore/getting-started.md",
      "title": "Getting started with MeshCore",
      "snippet": "...matching text..."
    }
  ]
}
```

Default limit should be small, for example 20; max should be bounded, for example 50.

## GET `/v1/docs/{path...}`

Returns one documentation file.

Example:

```json
{
  "data": {
    "path": "meshcore/getting-started.md",
    "media_type": "text/markdown",
    "content": "# Getting started...",
    "source": {
      "repository": "https://codeberg.org/meshat/hemsidan.git",
      "ref": "<resolved-ref>",
      "commit": "0123456789abcdef..."
    }
  }
}
```

Reject `..`, absolute paths, symlink escape, `.git`, and paths outside `/docs`.

---

# 3. MeshCore overview

## GET `/v1/meshcore`

Returns source description, status and resource links.

Example shape:

```json
{
  "data": {
    "id": "meshcore",
    "name": "MeshCore",
    "description": "Information om MeshCore-nätverket i Sverige",
    "status": "available",
    "resources": {
      "nodes": "/v1/meshcore/nodes",
      "observers": "/v1/meshcore/observers",
      "regions": "/v1/meshcore/regions",
      "iata": "/v1/meshcore/iata",
      "packets": "/v1/meshcore/packets",
      "messages": "/v1/meshcore/messages",
      "telemetry": "/v1/meshcore/telemetry",
      "traces": "/v1/meshcore/traces",
      "stats": "/v1/meshcore/stats",
      "activity": "/v1/meshcore/activity"
    }
  }
}
```

---

# 4. Nodes

## GET `/v1/meshcore/nodes`

Search/list nodes.

Supported filter contract should include, when backed correctly by the data model:

```text
name
role
region
iata
seen_from
seen_to
near_lat
near_lon
radius_km
sort
order
limit
cursor
```

Recommended allowed sorts:

```text
last_seen
first_seen
name
role
```

Example node:

```json
{
  "public_key": "64-hex-character-key",
  "name": "Mesh node",
  "role": "repeater",
  "location": {
    "latitude": 57.7826,
    "longitude": 14.1618
  },
  "first_seen": "2026-08-20T12:34:56Z",
  "last_seen": "2026-08-23T08:00:00Z",
  "iata": ["JKG"],
  "regions": ["public"]
}
```

Do not force `iata` or `regions` to be singular if evidence shows multiple values.

## GET `/v1/meshcore/nodes/{public_key}`

Returns a finished node object plus useful summary links/metadata.

## GET `/v1/meshcore/nodes/{public_key}/neighbors`

Returns derived/aggregated neighbor relationships.

Recommended neighbor item fields:

```json
{
  "public_key": "...",
  "node": {
    "name": "...",
    "role": "..."
  },
  "relationship": "reported|reciprocal|inferred",
  "last_heard": "2026-08-23T08:00:00Z",
  "signal": {
    "snr": 8.5,
    "rssi": -91
  },
  "regions": ["..."],
  "evidence": {
    "report_count": 3,
    "observer_count": 2
  }
}
```

Only use `inferred` if it has a precise documented definition.

Do not claim reciprocal adjacency unless evidence exists in both directions.

## GET `/v1/meshcore/nodes/{public_key}/adverts`

Cursor-paginated verified/historical advert information.

## GET `/v1/meshcore/nodes/{public_key}/sightings`

Cursor-paginated sighting information, normalized with IATA and observer identity.

## GET `/v1/meshcore/nodes/{public_key}/telemetry`

Node-specific telemetry.

---

# 5. Observers

Observers are nodes that report data over MQTT.

## GET `/v1/meshcore/observers`

Useful filters:

```text
active
name
iata
region
seen_from
seen_to
near_lat
near_lon
radius_km
sort
order
limit
cursor
```

For geographic search, use the node with the same public key and its verified node location.

Example observer:

```json
{
  "public_key": "...",
  "name": "Observer A",
  "active": true,
  "iata": "JKG",
  "location": {
    "latitude": 57.78,
    "longitude": 14.16
  },
  "first_seen": "...",
  "last_seen": "..."
}
```

## GET `/v1/meshcore/observers/{public_key}`

Observer detail.

## GET `/v1/meshcore/observers/{public_key}/status`

Current/recent status domain view.

## GET `/v1/meshcore/observers/{public_key}/metrics`

Bounded observer metrics history with cursor where needed.

No separate observer-neighbor route is required as the primary neighbor interface is node-oriented.

---

# 6. IATA

IATA means geographic three-letter MQTT/observer ingress area.

## GET `/v1/meshcore/iata`

Return primary and secondary configured codes.

Example:

```json
{
  "data": [
    {
      "code": "JKG",
      "name": "Jönköping och södra Vätternområdet",
      "type": "primary",
      "primary_code": "JKG"
    },
    {
      "code": "ARN",
      "name": null,
      "type": "secondary",
      "primary_code": "STO"
    }
  ]
}
```

## GET `/v1/meshcore/iata/{code}`

Return mapping information plus useful current summary/counts and links.

Normalize code input case-insensitively to uppercase.

---

# 7. MeshCore regions

Public `regions` correspond to MeshCore neighbor scopes/regions, **not** IATA.

## GET `/v1/meshcore/regions`

List logical regions observed in neighbor scope data.

Useful fields:

```text
name
node_count
observer_count
last_activity
```

## GET `/v1/meshcore/regions/{region}`

Region detail/summary.

## GET `/v1/meshcore/regions/{region}/nodes`

Cursor-paginated nodes associated with the logical MeshCore region.

Do not create public `/scopes` endpoints.

---

# 8. Packets

## GET `/v1/meshcore/packets`

Useful filters:

```text
hash
packet_type
payload_type
route_type
decode_status
node
observer
iata
received_from
received_to
sort
order
limit
cursor
```

Recommended default sort:

```text
received_at desc
```

## GET `/v1/meshcore/packets/{sha256}`

Packet detail.

The public packet object must contain the raw MeshCore bytes:

```json
{
  "raw": "0xa1b2c3..."
}
```

Do not expose raw MQTT receipt payload/metadata from private ingest storage.

## GET `/v1/meshcore/packets/{sha256}/observations`

Returns bounded observations of this MeshCore packet by observers.

Useful observation fields:

```text
observer
iata
received_at
rssi
snr
path when available
```

Do not expose private MQTT event metadata.

---

# 9. Messages

## GET `/v1/meshcore/messages`

Useful filters:

```text
sender
destination
channel
channel_name
message_type
encrypted
signature_valid
iata
received_from
received_to
sort
order
limit
cursor
```

Default limit: approximately 50.

Maximum limit: approximately 200.

The implementation may tune these values, but the endpoint must always be bounded.

## GET `/v1/meshcore/messages/{id}`

Returns one normalized public message.

Use public text where the public projection contains it.

---

# 10. Telemetry

## GET `/v1/meshcore/telemetry`

Useful filters:

```text
node
metric
iata
received_from
received_to
sort
order
limit
cursor
```

## GET `/v1/meshcore/telemetry/{id}`

Normalized telemetry detail.

---

# 11. Traces

## GET `/v1/meshcore/traces`

Useful filters:

```text
source_node
tag
iata
received_from
received_to
sort
order
limit
cursor
```

## GET `/v1/meshcore/traces/{id}`

Trace detail.

## GET `/v1/meshcore/traces/{id}/hops`

Normalized ordered hop list, including ambiguity/confidence information where applicable.

---

# 12. Statistics

## GET `/v1/meshcore/stats`

A useful current summary, not a raw `COUNT(*)` dump.

Possible shape:

```json
{
  "data": {
    "nodes": {
      "known": 1234,
      "active_24h": 420
    },
    "observers": {
      "known": 80,
      "active": 61
    },
    "regions": 14,
    "active_iata": 18,
    "activity": {
      "packets_24h": 120000,
      "messages_24h": 5200,
      "last_seen": "2026-08-23T08:00:00Z"
    }
  }
}
```

Exact metrics may vary based on useful indexed queries.

Document each metric definition.

---

# 13. Activity

## GET `/v1/meshcore/activity`

Controlled parameters:

```text
window
interval
iata
region
```

Provide allowlisted values such as:

```text
window: 1h, 6h, 24h, 7d, 30d
interval: 5m, 15m, 1h, 6h, 1d
```

Validate sensible window/interval combinations.

Return time buckets in ISO 8601 UTC.

---

# 14. Pagination contract

Collection endpoints that can grow large use:

```text
limit
cursor
```

Response:

```json
{
  "data": [],
  "pagination": {
    "limit": 50,
    "has_more": true,
    "next_cursor": "opaque-value"
  }
}
```

Cursor requirements:

- opaque to clients
- contains no secrets
- server-side session state is not required
- deterministic continuation
- invalid/malformed cursors produce a stable 400/422 error
- cursor reuse with incompatible filters must be rejected or safely bound to the original query

MCP tools pass these cursors through unchanged.

---

# 15. Error contract

Example:

```json
{
  "error": {
    "code": "INVALID_CURSOR",
    "message": "The cursor is invalid for this query.",
    "request_id": "01J..."
  }
}
```

Suggested stable codes include:

```text
INVALID_ARGUMENT
INVALID_CURSOR
INVALID_PUBLIC_KEY
INVALID_IATA
NOT_FOUND
RATE_LIMIT_EXCEEDED
DOCS_UNAVAILABLE
DATABASE_UNAVAILABLE
INTERNAL_ERROR
```

---

# 16. MCP mapping

The MCP server must expose domain tools rather than REST-path strings or DB primitives.

Recommended minimum mapping:

| MCP tool | REST operation |
| --- | --- |
| `list_sources` | `GET /v1/sources` |
| `get_source` | source overview |
| `get_meshcore_overview` | `GET /v1/meshcore` |
| `search_nodes` | `GET /v1/meshcore/nodes` |
| `get_node` | `GET /v1/meshcore/nodes/{public_key}` |
| `get_node_neighbors` | `GET /v1/meshcore/nodes/{public_key}/neighbors` |
| `search_observers` | `GET /v1/meshcore/observers` |
| `get_observer` | `GET /v1/meshcore/observers/{public_key}` |
| `list_regions` | `GET /v1/meshcore/regions` |
| `get_region` | `GET /v1/meshcore/regions/{region}` |
| `list_iata` | `GET /v1/meshcore/iata` |
| `get_iata` | `GET /v1/meshcore/iata/{code}` |
| `search_packets` | `GET /v1/meshcore/packets` |
| `get_packet` | `GET /v1/meshcore/packets/{sha256}` |
| `search_messages` | `GET /v1/meshcore/messages` |
| `get_message` | `GET /v1/meshcore/messages/{id}` |
| `search_telemetry` | `GET /v1/meshcore/telemetry` |
| `search_traces` | `GET /v1/meshcore/traces` |
| `get_meshcore_stats` | `GET /v1/meshcore/stats` |
| `get_meshcore_activity` | `GET /v1/meshcore/activity` |
| `list_docs` | `GET /v1/docs` |
| `search_docs` | `GET /v1/docs/search` |
| `get_doc` | `GET /v1/docs/{path...}` |

Do not implement `query_table`, `describe_table`, `list_tables` or raw SQL tools.
