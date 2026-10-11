# Cloudflare / app endpoints used by operator/c1-runner.mjs (extracted from source, lines cited)
Base: https://api.cloudflare.com/client/v4 ; W = /accounts/{acct}/workers/workers/ai-company-os-api-staging ; S = /accounts/{acct}/workers/scripts/ai-company-os-api-staging

Reads (execute mode only; dry-run makes zero network calls):
- GET  S/deployments                         (L229)
- GET  W/versions/latest                     (L238, L257)
- GET  S/secrets                             (L242)
- GET  W/versions/{id}?include=modules       (L244, L262)
- GET  W/versions/{newId}                    (L381)
- POST /accounts/{acct}/d1/database/a6b8c2f6-d697-442b-8374-5006246324b2/query  (L216; read-only SQL enforced by assertReadOnlySql)

Mutations (each gated by one-shot allowNext allowlist, L180-191):
- W1  PATCH W/versions/latest  body = 18 preserved bindings + 3 secret_text, no `deploy` field  (L356-357)
- W2  POST  S/deployments  {strategy percentage, versions [{NEW,100}]}, no force  (L372-373)
- B1  POST  https://api-staging.tungjp.store/operator/staging-bootstrap  (L404-405), at most once

Guards: path must start /accounts/{acct}/ (PATH_REJECTED); public worker ai-company-os-api and public D1
a4b622e6-978b-4ce2-ad82-cd0eb1cc4387 rejected (PUBLIC_TARGET_REJECTED); any other D1 UUID rejected (D1_TARGET_REJECTED).
W1 request body template: ../19_W1_REQUEST_BODY_PLACEHOLDER.json (secret values are "<P>" placeholders).
Endpoint semantics (PATCH versions/latest without deploy => new version at 0% traffic) were verified from
Cloudflare docs/schema in 19_MUTATION_GATE_FINAL_CHECK.md; not exercised live on this account.
