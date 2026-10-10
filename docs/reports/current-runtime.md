# Current runtime

Recorded: 2026-10-10. GitHub `main` is `6cf1db7`.

Canonical repository: https://github.com/takovn2/roomAgent.
`origin` is still `https://github.com/vn-tak/roomAgent.git`. GitHub resolves that URL to `takovn2/roomAgent`.

Certification stays `AI_COMPANY_OS_POC_PARTIAL`. This record does not issue `AI_COMPANY_OS_POC_CERTIFIED`. Muse and CUE were not contacted. CI for `6cf1db7` passed: https://github.com/takovn2/roomAgent/actions/runs/38044689758.

## Public Worker

| Item     | Value                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| Worker   | `ai-company-os-api`                                                                        |
| Version  | `a7acb953-ebae-46f8-9757-841100e121be`                                                     |
| Uploaded | 2026-10-08T22:16:40Z                                                                       |
| Hostname | `https://ai.tungjp.store`                                                                  |
| Health   | HTTP 200 `{"status":"ok","service":"ai-company-os-api"}`, checked 2026-10-10               |
| D1       | `ai-company-os`, `a4b622e6-978b-4ce2-ad82-cd0eb1cc4387`, migrations `0001` through `0010`  |
| R2       | `ai-company-os-artifacts`                                                                  |
| Queues   | `ai-company-os-domain-events`, `ai-company-os-agent-delivery`, `ai-company-os-dead-letter` |
| Workflow | `ai-company-os-production-task`                                                            |

This upload is the Phase 10 publication build. It is older than `main`. `apps/api/wrangler.jsonc` on `main` still uses the placeholder D1 id and has no custom domain. Deploying that file would replace this Worker. Do not do that until a release is chosen on purpose.

## Staging Worker

| Item     | Value                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| Worker   | `ai-company-os-api-staging`                                                                                        |
| Version  | `3aeb3cbc-0f44-470c-af2c-30ab64d1bc55`                                                                             |
| Uploaded | 2026-10-10T11:01:04Z                                                                                               |
| Hostname | `https://api-staging.tungjp.store`                                                                                 |
| Edge     | Cloudflare Access. Unauthenticated `GET /health` returns HTTP 302 to the Access login.                             |
| D1       | `ai-company-os-staging`, `a6b8c2f6-d697-442b-8374-5006246324b2`, migrations `0001` through `0015`                  |
| R2       | `ai-company-os-staging-artifacts`                                                                                  |
| Queues   | `ai-company-os-staging-domain-events`, `ai-company-os-staging-agent-delivery`, `ai-company-os-staging-dead-letter` |
| Workflow | `ai-company-os-staging-production-task`                                                                            |
| Config   | `apps/api/wrangler.staging.jsonc`                                                                                  |

The Worker response behind Access was not read. A 302 proves the hostname and Access application answer. It does not prove `/health` inside the Worker.

Unrelated account databases, buckets, and queues were not changed by this check. Bindings in both Wrangler files still omit `"remote": true`.
