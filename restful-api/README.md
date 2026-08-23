# Meshat.se REST API

Production REST domain API for Meshat.se. Access is public, anonymous, read-only, and rooted at `/v1`. PostgreSQL is accessed only by this service as `meshcore_http`, through fixed parameterized queries against `meshcore_public`.

## Public Surface

- `/`, `/healthz`, `/readyz`: service metadata, liveness, and database readiness.
- `/docs`: public Swagger UI.
- `/openapi.json`: OpenAPI document without authentication schemes.
- `/v1/docs`: cached Meshat.se documentation content. This is distinct from Swagger.
- `/v1/sources`, `/v1/meshcore`: source and resource discovery.
- `/v1/meshcore/nodes`: nodes, detail, aggregated neighbors, adverts, sightings, and telemetry.
- `/v1/meshcore/observers`: observers, detail, current status, and metrics.
- `/v1/meshcore/iata`: configured geographic MQTT ingress areas.
- `/v1/meshcore/regions`: logical MeshCore regions derived from neighbor scopes.
- `/v1/meshcore/packets`: packets, raw MeshCore bytes, and public observations.
- `/v1/meshcore/messages`, `/telemetry`, `/traces`: public protocol projections.
- `/v1/meshcore/stats`, `/activity`: current summary and bounded time series.

There are no table, schema, arbitrary query, SQL, write, login, or authentication routes.

## Domain Semantics

IATA and MeshCore regions are intentionally separate. IATA codes such as `JKG` identify geographic MQTT ingress/hearing areas stored in public `iata` columns. Public `regions` are logical neighbor scopes derived only from neighbor `scope` membership and served from the broker-maintained `region_scopes` registry: built-in Swedish codes (`se`, `seXX` county, `seXXXX` municipality with hardcoded official municipality names such as `Halmstads kommun`) plus every scope detected in neighbor evidence. Region responses expose `region` (canonical lowercase scope), `name`, `first_seen`, `last_seen`, `manually_added`, `observation_count`, node/observer counts, and `last_activity`; registered regions with no evidence yet return zero counts. Swedish region inputs are case-insensitively normalized to lowercase.

Observer locations use the verified location of the node with the same public key. Radius searches use the public PostGIS geography index while responses use normalized latitude/longitude columns. Neighbor responses aggregate only each reporting observer's latest snapshot. `reciprocal` means both the requested node reports the counterpart and the counterpart reports the requested node; one-sided evidence remains `reported` and includes its direction.

Packet `raw` is the MeshCore packet byte sequence encoded as lowercase `0x` hex. Packet observation paths preserve ordered resolved, ambiguous, and unresolved hop information. Node, advert, and neighbor roles are normalized to lowercase; role filters are case-insensitive. Private MQTT receipts and metadata are never queried or returned. Messages are deduplicated by stable logical packet identity and aggregate their matching IATA observations; a message ID always uses the required `lp_` prefix, and `representative_packet_sha256` names the packet behind the latest matching observation. Packet search accepts `logical_id` to list every physical packet variant of one logical message. Message defaults and maxima are configured by `MESSAGE_DEFAULT_LIMIT` and `MESSAGE_MAX_LIMIT` (50 and 200 by default). Observer `active` means accepted ingest within `OBSERVER_ACTIVE_WINDOW_MS`, five minutes by default; it does not claim a live MQTT socket.

Large collections use versioned opaque keyset cursors. Cursors contain a query fingerprint and cannot be reused with different filters, sort, or order. They require no server-side session state.

## Documentation Cache

At startup the service shallow-clones `DOCS_GIT_REPOSITORY` into an isolated temporary checkout, validates its Git metadata and non-symlinked docs root, then swaps it into `DOCS_CACHE_DIR`. Repository URLs containing credentials are rejected. Stale metadata is read from the cached checkout's actual origin, checked-out ref, and commit; a cache from a different configured repository/ref is not served.

Only lowercase `**/*.md` files and exactly `meshtastic/example.yaml` beneath `DOCS_SUBDIR` are public. Other existing assets return `NOT_FOUND`. Public documents must be valid UTF-8 and are always returned with `encoding: "utf-8"`; binary/base64 responses are never produced. `DOCS_MAX_FILE_BYTES` defaults to and cannot exceed 65536 bytes. Oversized or malformed UTF-8 documents are excluded from index and search, while direct oversized retrieval returns `413`.

Traversal, absolute paths, `.git`, and symlink escapes remain rejected. Search considers public candidates in deterministic path order and scans at most 100 files and 4 MiB per request. Its non-cursor result contains `query`, `limit`, `returned`, `total_matches`, `scan_complete`, `truncated`, and `results`; `total_matches` covers scanned candidates, and `scan_complete` states whether that is the complete candidate set. A failed refresh leaves a matching prior tree untouched and serves it as `stale`; without a valid matching checkout, docs return `DOCS_UNAVAILABLE` while the core API remains running.

Startup refresh completes before the HTTP listener opens, and the supported Compose deployment runs one REST replica. The cache swap is designed for that lifecycle; cross-process writers to the same docs volume are not supported.

The runtime image includes Git and runs as the non-root `node` user. The deployment must make the configured cache directory writable, normally with the root Compose named volume.

## Configuration

Configuration comes from environment variables, normally the root `.env`. Important values are `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER=meshcore_http`, `DATABASE_PASSWORD`, `DATABASE_SSL`, `DATABASE_POOL_MAX`, `OBSERVER_ACTIVE_WINDOW_MS`, `REST_HOST`, `REST_PORT`, `TRUST_PROXY`, CORS/rate-limit settings, and the `DOCS_*` settings. Invalid values fail startup. No password-file or authentication settings are supported.

`TRUST_PROXY` defaults to false, preventing untrusted forwarding headers from controlling IP rate limits. The database pool defaults to four connections and production closes it during graceful shutdown. Readiness requires public schema ID `meshcore-mqtt-broker-postgres-v1` at version `7`.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Run the workspace deployment from the root with `docker compose up -d`. Use `npm run test:live` only against an explicitly selected `API_BASE_URL`; it performs anonymous read-only requests.
