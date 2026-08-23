# FIXLOG — Bugfixomgång 2026-08-23 (schema v9)

Arbetslogg och **arbetsgrund** för den djupgående buggrapporten. Varje batch
dokumenterar **vad**, **hur** och **varför** lösningen ser ut som den gör,
samt verifiering. Batcherna körs i ordning; en batch loggas som klar först när
implementation och tester faktiskt har körts.

**Arbetsregel:** 5 lösningar i taget. Denna fil läses om innan varje
arbetspass så att statusen alltid är aktuell.

**Huvudprincip (§34):**

> Publika entities, filters och aggregates ska alltid kunna härledas
> deterministiskt från retained, trusted evidence.

Repon som omfattas:

- `meshat-apis/` (detta workspace): `restful-api/`, `mcp-server-v2/`
- `~/Projekt/meshcore-mqtt-broker/` (separat git-repo): broker-fixar + schema v9

---

## Statusöversikt

| Batch | Område                                                                                                 | Status      |
| ----- | ------------------------------------------------------------------------------------------------------ | ----------- |
| 1     | REST: rate-limit, activity-region, observer/region-identitet                                           | KLAR        |
| 2     | REST: tidskorrelerad evidence, prefix, trace-hop, release/schema-hash                                  | KLAR        |
| 3     | MCP: semantiska scheman, release-metadata                                                              | KLAR        |
| 4     | Tester: REST + MCP regression (§31)                                                                    | KLAR        |
| 5     | Broker: schema v9 fingerprint, region reprocess/retention, observer-IATA retention, advert-owner-trust | KLAR        |
| 6     | Broker: prefix-resolution, packet-advert replace, TRACE-identitet, latest_iata, advert-dokumentation   | KLAR        |
| 7     | Broker: regressionstester (§31)                                                                        | KLAR        |
| 8     | TASKS/DECISIONS/README + full verifiering                                                              | KLAR        |

---

## Batch 1 — REST: rate-limit, activity-region, region-identitet

**Status: KLAR** (REST 63 tester, MCP 16 tester, typecheck OK 2026-08-23).

- [x] **1.1 Host-header rate-limit bypass bort (§13)**
  - `server.ts`: allowList innehåller nu endast `/healthz` och `/readyz`;
    `request.hostname === "restful-api"` är borttaget. Varje route har redan
    `config: { rateLimit: false }` för health/ready.
  - Varför: Host är klientkontrollerad och får inte vara trust-signal.

- [x] **1.2 `region` bort från activity (§6)**
  - Bort från: REST `activityQuery` + OpenAPI-querystring, `repository.getActivity`
    (+ dess SQL-EXISTS), `domain.ts`-typen, MCP `get_meshcore_activity`,
    region-objektets `links.activity` (`mapRegion`).
  - Beskrivningen förklarar nu varför: per-observation region-evidence saknas i
    datamodellen. `?region=` ger 422 via strict schema.

- [x] **1.3 Observer-regionfilter → egen nyckel-evidence (§3)**
  - `listObservers` regionfilter använder den kanoniska
    `entity_region_evidence`-relationen med `entity_public_key = o.public_key`.
    Tidigare ingick `neighbor_entry_scopes` för entries **inuti observerns egen
    snapshot** (= grannarnas regioner) — det var buggen. Tidsfönstret
    `seen_from/seen_to` binds till `evidence.evidence_received_at_ms`.

- [x] **1.4 Region summary `observer_count` = egen membership (§4)**
  - `REGION_SUMMARY_SQL`: `observer_count` räknar unika `entity_public_key` som
    finns i `observers`; `node_count` räknar unika keys som finns i `nodes`.
    Invarianten `get_region(R).observer_count == antal unika resultat från
search_observers(region=R)` gäller nu per konstruktion (samma relation).

- [x] **1.5 Gemensam `entity_region_evidence`-relation (§26)**
  - `repository.ts`: ett enda SQL-fragment
    (`entry_scopes ⋈ entries ⋈ snapshots` med entity = `neighbor_public_key`
    UNION ALL `snapshot_scopes ⋈ snapshots` med entity = `observer_public_key`;
    kolumner `entity_public_key, region, evidence_received_at_ms`).
  - Används av: `regionsFor` (node/observer-display), node-regionfilter,
    observer-regionfilter, `listRegionNodes`, `REGION_SUMMARY_SQL`.
  - En neighbors region kan aldrig göra reportern till medlem.

**Teständringar i samma batch:** 5 testfall som assertade gammal SQL-form
uppdaterades till den nya kanoniska semantiken; injection-testet använder nu
`getActivity({ iata: injection })`; MCP endpoint-map och valid/invalid-case
använder IATA i stället för region på activity.

**Notering (medveten beteendeändring):** tidigare räknade
`REGION_SUMMARY_SQL.observer_count` reporting-observers av _entries_ i regionen;
nu räknas observers vars egen nyckel har region-evidence. Detta är exakt
§4:s BESLUT och invariant.

---

## Batch 2 — REST: tidskorrelerad evidence, prefix, trace-hop, release/schema

**Status: KLAR** (REST 64 tester, typecheck + build OK 2026-08-23).

- [x] **2.1 Node `region`/`iata` + `seen_*` korreleras till samma evidence (§5)**
  - `nodeConditions`: IATA-EXISTS binder nu `sighting.received_at_ms` till
    `seen_from/seen_to`; regionfilter (`applyEntityRegion`) binder
    `evidence.evidence_received_at_ms` till samma fönster. Det generella
    `nodes.last_seen_at_ms`-kravet behålls när det är satt. Samma
    evidence-population uppfyller därmed båda villkoren.

- [x] **2.2 Region-prefix normaliseras för svenska scopes (§18)**
  - `regionQuery.prefix` transformeras med `normalizeRegionScope` (lowerca
    endast `se`/`seXX`/`seXXXX`). Sker före SQL och cursor-fingerprint.
    OpenAPI-beskrivning tillagd. `prefix=SE13` matchar nu `se13...`.

- [x] **2.3 Trace-hop: ≤1 candidate = unresolved (§17)**
  - `listTraceHops` CASE: `resolved` endast med stored
    `resolved_node_public_key`; `ambiguous` endast om candidate-count > 1;
    annars `unresolved`. En sent tillkommen kandidat kan inte retroaktivt
    göra en historisk hop resolved.

- [x] **2.4 Logical ID case-regler (§24) — verifierad + test**
  - Både REST och MCP accepterar redan `lp_` + `[0-9a-fA-F]{64}` och
    normaliserar till lowercase (REST-transform + MCP-transform). Nytt
    REST-test: uppercase hex accepteras i `get_message` och
    `search_packets.logical_id` och normaliseras; uppercase `LP_`-prefix
    avvisas (400) — exakt kontraktsregeln.

- [x] **2.5 Release ID + riktig schema-hash (§2, §15)**
  - `config.ts`: ny `RELEASE_ID` (default `1.0.0`). Exponeras i `/`-metadata,
    `/readyz` och OpenAPI `info.version`.
  - `repository.ts`: `EXPECTED_SCHEMA_VERSION = 9`; `health()` läser
    `schema_metadata.schema_hash` och beräknar ett live SHA-256-fingerprint
    över det kanoniska publika DB-kontraktet
    (`information_schema.tables/columns` + `pg_constraint` +
    `pg_indexes`, serialisering `schema|… table|… column|… constraint|…
index|…`), och vägrar readiness vid mismatch. `/readyz` returnerar
    `release_id`, `schema_version`, `schema_hash`.
  - Varför: `schema_hash` var tidigare en kopia av schema-ID — ingen riktig
    driftsignal. Nu upptäcks broker/API-schema-drift automatiskt.
  - Beroende: broker schema v9 (Batch 5.1) måste lagra samma fingerprint med
    samma serialisering — koordinerad release.

**Teständringar:** health-testerna byggdes om för multi-query-fingerprinten
(RecordingPool fick en `responses`-kö); ett test pinnar den kanoniska
serialiseringsformen; readyz OpenAPI-required-lista uppdaterad; nytt
logical-ID-test.

---

## Batch 3 — MCP: semantiska scheman + release-metadata

**Status: KLAR** (MCP 17 tester, typecheck OK 2026-08-23).

- [x] **3.1 Semantiska output-scheman för alla REST-resurser (§16)**
  - `tools.ts`: explicita zod-scheman för Node, Observer, Region, IATA, Packet,
    LogicalMessage, Telemetry, Trace, Stats, ActivityBucket, Source/Overview,
    Neighbor. List-verktyg: `{ items, next_cursor }` med per-item-validering;
    detail-verktyg: unwrapped `data` validerad mot resurs-schemat. Vid mismatch
    kastas `RestError("UPSTREAM_CONTRACT_ERROR")` → tool-`isError`, aldrig
    genomsläpp av invalid data.
  - Beteendeändring: `get_node` etc returnerar nu ren validerad resurs (ej
    `{data: ...}`-envelope). Docs-verktygen behåller sina strikta normalizers.

- [x] **3.2 MCP release/readyz-metadata + activity utan region (§2, §6)**
  - `server.ts`: `MCP_RELEASE_ID` (default `2.0.0`); `/healthz` → `{status,
release_id}`; `/readyz` → `{status, release_id, rest: {release_id,
schema_version, schema_hash}}` från REST. `get_meshcore_activity` har
    inget `region`-argument längre.

- [x] **3.3 Trace-resursen är explicit observationsnivå (§25)**
  - `traceOutput` kräver `id, packet_sha256, logical_id, observer, iata, tag,
source_node, reported_at, received_at`; verktygsbeskrivningen förklarar
    att rader med samma packet är olika observationer.

- [x] **3.4 Stats-regions shape (§22) — verifierad**
  - `statsOutput.regions` valideras som `{configured, observed}`.

- [x] **3.5 `list_regions` paginerad i MCP (§21) — verifierad**
  - `limit` default 50 / max 200, `cursor`, `prefix`, `observed_only`,
    `manually_added` redan på plats; regionOutput-schemat validerar nu varje
    katalogpost inkl. links utan activity.

**Teständringar:** komplett fixture-fabrik (`domainFixture`) för alla
domain-endpoints; health/ready-test, discovery-test, endpoint-map-test och
collection/detail-test omskrivna för de nya schemana; nytt test för
UPSTREAM_CONTRACT_ERROR vid drivande REST-svar.

## Batch 4 — Regressionstester REST + MCP (§31)

**Status: KLAR** (REST 69 tester, MCP 17 tester 2026-08-23).

- [x] 4.1 REST: Host-bypass bort (`Host: restful-api` rate-limitas som
      extern trafik); endast health/ready undantas; activity-`?region=` → 400
      INVALID_ARGUMENT.
- [x] 4.2 REST: observer-regionfilter via kanonisk relation
      (`entity_public_key = o.public_key`; gammal self-snapshot-join frånvarande);
      region-aggregat räknar observers via samma relation.
- [x] 4.3 REST: node region/IATA + `seen_*` binder
      `sighting.received_at_ms`/`evidence.evidence_received_at_ms` till fönstret.
- [x] 4.4 REST: `prefix=SE13`/`SE` normaliseras; custom scopes rörs inte;
      trace-hop klassas resolved/ambiguous(>1)/unresolved.
- [x] 4.5 REST: release/schema-hash i metadata + readiness; readyz 503 vid
      schema-mismatch (inkl. korrupt hash); kanonisk fingerprint-serialisering
      pinnad i test.
- [x] 4.6 MCP: fresh-session discovery ger identiska tool-scheman
      (`get_message`, `search_packets`, `get_node`); output-validering stoppar
      kontraktdrift; activity utan region; readyz inkluderar REST
      release/schema-version/hash.

---

## Batch 5 — Broker: schema v9, region-registry, observer-IATA retention, advert-trust

**Status: KLAR** (`~/Projekt/meshcore-mqtt-broker`, 229 Postgres-tester,
build + lint + prettier OK 2026-08-23).

- [x] **5.1 Schema v9 med riktig SHA-256 fingerprint (§15)**
  - `src/database.ts`: `CURRENT_SCHEMA_VERSION = 9`; ny
    `computePublicSchemaFingerprint()` som serialiserar `meshcore_public`
    exakt som REST (samma fyra katalogfrågor + samma radformat
    `schema| table| column| constraint| index|`) och SHA-256:ar texten.
  - `initialize()` och `resetProductionDatabase()` lagrar den beräknade
    hashen i båda markörerna; statiska initdb-filen skriver version 9 +
    `pending`, som första broker-start repareras till riktigt hash i
    `validateCurrentSchema()`. Därefter vägrar brokern öppna en DB vars
    lagrade fingerprint skiljer sig från live-beräkningen (privat ELLER
    publik markör).
  - v9-kolumner i samma migration: privat `node_adverts.owner_public_key`
    (5.5) och `observers.latest_iata_event_id` (6.4). MIGRATION.md uppdaterad.

- [x] **5.2 `region_scopes` reprocess-idempotent (§7)**
  - Ny modul `src/region-scope-aggregate.ts`:
    `ensureRegionScopeRow()`, `rebuildRegionScopes(transaction, scopes?)`,
    `regionScopesForEvents()`. Registryn behandlas som **derived aggregate**:
    ingest säkrar katalograder och recomputera berörda scopes från retained
    evidence i stället för att inkrementera.
  - `normalizeNeighbors` samlar scopes och kör EN rebuild per event;
    `ProcessingRepository.resetDerived` fångar eventets scopes före delete
    och rebuild:ar efter — därmed är `reprocess × N` bit-identiskt.

- [x] **5.3 `region_scopes` korrigeras vid retention (§8)**
  - `deleteExpiredEvents` fångar påverkade scopes före delete-batchen och
    kör `rebuildRegionScopes` efteråt. Scopes utan retained evidence nollas
    (`observation_count = 0`, gränser `NULL`); katalogmetadata (`name`,
    `manually_added`) bevaras.

- [x] **5.4 `observer_iata_history` gruppvis vid retention (§9)**
  - `refreshObservers`: radvis decrement-loop ersatt med unika
    `(observer_id, iata)`-grupper per batch + exakt EN recompute per grupp
    från kvarvarande `mqtt_events` (upsert/delete). Batcher som raderar
    flera rader i samma grupp kan inte längre dubbel-decrementera eller
    radera aggregates med retained evidence kvar.

- [x] **5.5 Owner endast från verified adverts (§10)**
  - `nodes.owner_public_key` uppdateras bara när adverten är verified
    (`CASE WHEN $verified THEN excluded... ELSE behåll`), både vid INSERT
    och CONFLICT. Owner sparas nu alltid på privat `node_adverts.owner_public_key`
    så att trusted state kan rebuildas från retained **verified** adverts
    (senaste per observationsordning) i `rebuildAdvertDerivedNodeState()`.

## Batch 6 — Broker: prefix-resolution, packet-advert replace, TRACE, latest_iata, dokumentation

**Status: KLAR.**

- [x] **6.1 Unverified-only prefix candidate blir aldrig resolved (§11)**
  - `resolvePrefix()` filtrerar nu på trusted candidates
    (`confidence >= 1` ⇔ verified-evidence): 0 trusted → `unresolved`,
    > 1 trusted → `ambiguous`, exakt 1 → `resolved`. Confidence 0.5 (unverified)
    > räcker aldrig.
- [x] **6.2 Replace-semantik för packet-owned advert-state (§12)**
  - `resetDerived` samlar paketens advert-noder, raderar `node_adverts` för
    eventets packets innan ny decode, och rebuild:ar nodernas
    canonical/prefix-state via delade `rebuildAdvertDerivedNodeState()`
    (används även av retention `refreshNodes` och ingest
    `refreshAdvertNodes`). ADVERT→OTHER lämnar ingen stale advert.
- [x] **6.3 TRACE logical identity utan SNR (§14)**
  - `logical-packet-identity.ts`: `snrValues` borttagen ur TRACE-nyckeln;
    DATABASE.md uppdaterad. Samma payload ger samma logical ID oavsett SNR.
- [x] **6.4 `latest_iata` deterministisk vid tie (§19)**
  - `ObserverRepository.resolve()` tar emot `eventId` och avgör senaste IATA
    på `(received_at_ms, event_id)` lexikografiskt (nya kolumnen
    `latest_iata_event_id`). Retention-recomputen sätter samma par. Lägre
    event-id vinner aldrig en tie.
- [x] **6.5 Advert-dokumentation (§20)**
  - `INGEST.md`: observation order är kanonisk för senaste trusted
    observation; protokolltimestamp är payload-metadata. Även §10/§11-trust
    samt derived registry beskrivna i `DATABASE.md`.

## Batch 7 — Broker: regressionstester (§31)

**Status: KLAR** (229 tester mot riktig isolerad Postgres via
compose.test.yaml; 10 nya).

Nya tester:

- Region: reprocess-idempotens (2× reprocess, registry oförändrat);
  retention resettar scope till count 0/null medan evidence finns kvar →
  korrekt partial state (count=2) och full reset; katalograden består.
- Observer-IATA: 2 expired + 1 retained i SAMMA batch → aggregatet överlever
  med count=1 och boundaries från retained eventet (fångar den gamla
  dubbel-decrement-buggen).
- Advert-trust: invalid advert med annan owner kan varken ta över eller
  nolla `nodes.owner_public_key`; owner ligger på advert-raden.
- Prefix-trust: unverified-only candidate → hop `unresolved`; efter verified
  advert → `resolved`.
- Reprocess replace: ADVERT→TXT_MSG vid reprocess tömmer `node_adverts`,
  `nodes`, publik projektion och prefix-kandidater.
- latest_iata-tie: `(received_at_ms, event_id)`-ordning — lägre id vinner
  inte en tie (enhetstest av resolve-upserten).
- TRACE-identitet: SNR [4,-1] / [99,99] / saknas / strängar → samma logical ID.
- Schema-fingerprint: initialize lagrar riktig 64-hex-hash (≠ schema-id) i
  båda markörerna; korrupt hash gör att reopen vägrar med
  IncompatibleDatabaseError.

Designnotering under vägen: initialize()-inserts använder `ON CONFLICT DO
NOTHING` (aldrig DO UPDATE) — ett provisioning-path får aldrig tyst reparera
ett korrupt fingerprint; refuseringen sker i `validateCurrentSchema`/openPool
och 'pending' från statiska filen repareras explicit där.

---

## Batch 8 — Dokumentation och full verifiering

**Status: KLAR** (slutverifiering 2026-08-23).

- [x] 8.1 `TASKS.md` uppdateras (nya [x] endast efter körda tester; broker-fixar
      markeras i broker-repo-avsnitt).
- [x] 8.2 `DECISIONS.md` uppdateras med beslut från denna omgång.
- [x] 8.3 README (REST/MCP) om release-ID, schema-hash, activity-region bort.
- [x] 8.4 REST: typecheck + vitest + build.
- [x] 8.5 MCP: typecheck + vitest + build.
- [x] 8.6 Broker: lint + format-check + build + `npm run test` (riktig Postgres
      via compose.test.yaml).
- [x] 8.7 `docker compose config --quiet` + `docker compose build` i meshat-apis.

---

## Definition of Done (från rapport §33)

- [x] Alla gamla REST/MCP-tester passerar (69 REST + 17 MCP, utökade).
- [x] Alla nya regressionstester passerar (10 nya brokertester + nya REST/MCP-fall).
- [x] Brokerns 229 integrationstester körs mot riktig isolerad Postgres.
- [x] Reprocess körs två gånger på region-fixture utan state drift (test).
- [x] Retention körs på fixtures med flera rows per aggregate group (observer-IATA + region).
- [x] Discovery från nya sessioner är deterministisk och identisk (test); live-verifiering sker vid nästa deploy.
- [x] REST och MCP exponerar konfigurerbara release-ID:n; MCP readyz speglar REST:s.
- [x] Samma fingerprint-serialisering i broker och API; mismatch vägras i båda (testad).
- [x] `Host: restful-api` kringgår inte rate limit (testad).
- [x] Unverified adverts påverkar varken owner eller prefix-resolution (testat).
- [x] Regionfilter använder endast entityns egen evidence-relation (testat).
- [x] Activity saknar regionfilter i både REST och MCP (testat).

---

## Kvarvarande begränsningar

- **Samordnad release krävs:** REST readiness (`EXPECTED_SCHEMA_VERSION = 9`
  + fingerprintjämförelse) refuserar medvetet mot dagens schema-v8-databas
  tills den uppdaterade brokern har startat en gång och skrivit den riktiga
  hashen. Statiska initdb-databaser får `pending` som repareras vid första
  v9-start.
- Live-verifiering av MCP-discovery/release-fingerprint mot produktion kan
  först göras vid nästa deploy; alla motsvarande invarianter är testade
  lokalt i detta arbete.
- Ingen kod eller image har pushats utanför de lokala repon.
