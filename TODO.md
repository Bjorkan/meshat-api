# TODO

- [P3] Live-verified 2026-08-25: `/v1/docs/.git/*` returns an empty-body 403 from the host-level CrowdSec WAF (`remediationStatusCode: 403`) before reaching REST; the app itself already answers contract-compliant JSON 400 (verified via container-local request). Decide whether to tune the host Traefik/CrowdSec config so edge-blocked paths also carry an error body — outside workspace write scope, needs human/host action or explicit acceptance.
- [P3] Stats uses exact full-table aggregate counts (~141 ms measured pre-Bun.SQL); post-migration production medians: stats ~340 ms, `messages?limit=50` ~1.5 s, `activity` 0.8–1.7 s. Replace with bounded/estimated counts and/or add covering indexes if this grows — index work belongs to the broker schema.
- [P2] Global telemetry lacks an ideal leading timeline index in the public reference schema, so global telemetry keyset paging cannot be fully index-optimal until the broker project adds one.
- [P3] Evaluate broker pg → Bun.SQL after REST's Bun.SQL has been stable in production (REST migrated 2026-08-25).
