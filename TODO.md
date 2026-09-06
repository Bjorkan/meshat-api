# TODO

- [P3] Live-verified 2026-08-25: `/v1/docs/.git/*` returns an empty-body 403 from the host-level CrowdSec WAF (`remediationStatusCode: 403`) before reaching REST; the app itself already answers contract-compliant JSON 400 (verified via container-local request). Decide whether to tune the host Traefik/CrowdSec config so edge-blocked paths also carry an error body — outside workspace write scope, needs human/host action or explicit acceptance.
- [P3] Profile remaining message qualifier and activity aggregation cost at larger production volumes before further optimization. Any new supporting index belongs in the broker repository and requires EXPLAIN evidence; avoid preaggregation without measured need.
