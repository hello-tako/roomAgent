# Status

## Product MVP source

Recorded against protected `main` `11a1cab441462cc6087bae2f903dc2b5f1a49b56` on `hello-tako/roomAgent` (`1410359112`). That commit is the PR #9 merge. The operator web application and its HTTP control plane live on `feat/roomagent-product-mvp-v1`. Product contracts are in [docs/product/architecture.md](docs/product/architecture.md).

This section supersedes earlier "current" wording below where those notes still describe pull request 5 as open, C1-A2 as unmerged, or the absence of a human UI. The historical sections stay as the record of those milestones. They are not rewritten.

No Cloudflare Worker, secret, D1, Access, route, or release pin was changed for this product milestone. `ROOMAGENT_PRODUCT_MVP_V1_PRODUCTION_CERTIFIED` and `ROOMAGENT_PRODUCT_MVP_V1_STAGING_DEPLOYED` are not issued. F3 remains `UNRESOLVED_MEDIUM`. Native Muse and CUE adapters remain unimplemented.

## Stage C and C1-A2

PR [#5](https://github.com/takovn2/roomAgent/pull/5) was merged on 2026-10-10 UTC. Its independently APPROVED head was `08e379e96c029ac929277622a0933a5db7c9810b`; resulting main `3909fada8747ae27ea71daf6da9481a7eb8d9eff` passed exact-main CI [38093203477](https://github.com/takovn2/roomAgent/actions/runs/38093203477). This approval covers Stage C source, not the subsequent C1-A2 operator hardening.

C1-A2 source is on `fix/roomagent-c1-a2-security-hardening`, derived from verified handoff `6fac326a7fd3f504a51c23372485af252012e2c8` (one commit ahead of the unchanged baseline main). The original handoff CI [38105477230](https://github.com/takovn2/roomAgent/actions/runs/38105477230) failed formatting; later checks were skipped. Source/negative tests/CI integration are now implemented for a new independent review. Read the [hardening report](reports/stage-c/C1_A2_SECURITY_HARDENING_REPORT.md) and [Muse review package](reports/stage-c/C1_A2_INDEPENDENT_REVIEW_PACKAGE.md); exact implementation head and CI are recorded in the PR after publication.

**GATE B and human mutation approval remain PENDING.** This task did not deploy, write remote D1, perform W1/W2/B1, create a staging owner/session, retire secrets or modify production. No new live Cloudflare observation/certification is claimed. `ROOMAGENT_STAGING_STAGE_C_RUNTIME_CERTIFIED`, `ROOMAGENT_STAGE_C1_SYNTHETIC_BOOTSTRAP_VERIFIED` and `AI_COMPANY_OS_POC_CERTIFIED` are not issued; POC remains PARTIAL. Historical runtime observations below are not fresh evidence for this implementation.

## Current runtime

Recorded: 2026-10-10. The runtime note below was drafted against `6cf1db7`. The commit that published it is `3528f923692b53c80559ba55a7101773e9a8bd1b` on https://github.com/takovn2/roomAgent.
`origin` is still `https://github.com/vn-tak/roomAgent.git`, and GitHub resolves it to `takovn2/roomAgent`.

Certification stays `AI_COMPANY_OS_POC_PARTIAL`. The detail is [current-runtime.md](reports/current-runtime.md).

| Surface                            | What is live                                                                                                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://ai.tungjp.store`          | Worker `ai-company-os-api` version `a7acb953-ebae-46f8-9757-841100e121be`, uploaded 2026-10-08. `GET /health` returned HTTP 200. D1 `ai-company-os` has migrations `0001`–`0010`. This build is older than `main`.     |
| `https://api-staging.tungjp.store` | Worker `ai-company-os-api-staging` version `3aeb3cbc-0f44-470c-af2c-30ab64d1bc55`, uploaded 2026-10-10. Cloudflare Access returns HTTP 302 before the Worker. D1 `ai-company-os-staging` has migrations `0001`–`0015`. |

`apps/api/wrangler.jsonc` on `main` is still the local placeholder. The public hostname was deployed from an earlier tree. Do not deploy the current placeholder file onto `ai.tungjp.store`. CI for `6cf1db7` passed. Muse and CUE were not contacted.

## Staging P1 remediation

State: `ROOMAGENT_STAGING_P1_REMEDIATION_AWAITING_INDEPENDENT_REVIEW`.

P1-01 through P1-05 are implemented with local regression coverage on top of the merged
remediation v1 (`main` `dee1e56`). The record is
[staging-p1-remediation.md](reports/staging-p1-remediation.md). That record said nothing was
deployed. The live account on 2026-10-10 is in Current runtime above. This status update does
not close the review gate.

## Architecture remediation v1

State: `ROOMAGENT_REMEDIATION_IMPLEMENTED_AWAITING_INDEPENDENT_REVIEW`.

Implementation is on `fix/architecture-remediation-v1`, based on the reviewed publication commit.
R1–R17 have local regression coverage: 135 tests / 41 files PASS, plus two migration checks.
Exact-head CI evidence is recorded on the remediation PR. That record said no merge or
deployment was authorized. The work is now on `main` at `6cf1db7`. See Current runtime for
what is actually uploaded. The implementation ledger is
[architecture-remediation-v1.md](reports/architecture-remediation-v1.md).
Historical phase gates below are not evidence for the new remediation.

This status update does not authorize a new deploy and does not contact Muse or CUE.

## Historical baseline (superseded where noted)

Recorded: 2026-10-09

Repository: https://github.com/vn-tak/roomAgent
Branch: `main`
Publication: the first commit on `main`. Phase reports still say ending SHA `none` because each phase closed while the tree was untracked.

Certification: `AI_COMPANY_OS_POC_PARTIAL`

The local company test gate is `PHASE10_COMPANY_POC_PASS`. That gate is the browser-session proof for organization `AI STUDIO LAB`. It is not `AI_COMPANY_OS_POC_CERTIFIED`. The blockers are in `docs/PLAN.md` and `docs/reports/publication.md`.

## Phase gates

| Phase | Gate                            | Record                            |
| ----- | ------------------------------- | --------------------------------- |
| 0     | `PHASE0_DISCOVERY_COMPLETE`     | `docs/PHASE0_DISCOVERY_REPORT.md` |
| 1     | `PHASE1_DOMAIN_FOUNDATION_PASS` | `docs/reports/phase1.md`          |
| 2     | `PHASE2_AUTHORITY_ENGINE_PASS`  | `docs/reports/phase2.md`          |
| 3     | `PHASE3_ROOM_REALTIME_PASS`     | `docs/reports/phase3.md`          |
| 4     | `PHASE4_AGENT_JOIN_PASS`        | `docs/reports/phase4.md`          |
| 5     | `PHASE5_TASK_ENGINE_PASS`       | `docs/reports/phase5.md`          |
| 6     | `PHASE6_EVENT_DELIVERY_PASS`    | `docs/reports/phase6.md`          |
| 7     | `PHASE7_ARTIFACT_PIPELINE_PASS` | `docs/reports/phase7.md`          |
| 8     | `PHASE8_GOVERNANCE_PASS`        | `docs/reports/phase8.md`          |
| 9     | `PHASE9_DURABLE_WORKFLOW_PASS`  | `docs/reports/phase9.md`          |
| 10    | `PHASE10_COMPANY_POC_PASS`      | `docs/reports/phase10.md`         |

## What runs locally

The API Worker is a stateless gateway, the queue consumers, and `ProductionTaskWorkflow`.

| Piece          | Local state                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OrganizationDO | Authority, roles, suspension, blocks, join codes. Tested. Not deployed.                                                                                        |
| RoomDO         | Hibernating WebSocket and monotonic sequence. Tested. Not deployed.                                                                                            |
| AgentDO        | Browser redeem, inbox, reachability, sweep. Tested. Not deployed.                                                                                              |
| TaskDO         | Task transitions and the handoff cap of 8. Tested. Not deployed.                                                                                               |
| ArtifactDO     | Immutable versions, reviews, final approval, security approval. Tested. Not deployed.                                                                          |
| D1             | Migrations `0001` through `0010` applied on the local placeholder database `ai-company-os` (`00000000-0000-4000-8000-000000000001`). Remote apply was not run. |
| Queues         | Local names `ai-company-os-domain-events`, `ai-company-os-agent-delivery`, `ai-company-os-dead-letter`. No remote queue was created.                           |
| Workflows      | One class, `ProductionTaskWorkflow`, binding `PRODUCTION_TASK`, local name `ai-company-os-production-task`. Not deployed.                                      |
| R2             | Local binding `ARTIFACTS` / `ai-company-os-artifacts`. No remote bucket was created.                                                                           |
| Adapters       | `BrowserAgentAdapter` is implemented. Muse and CUE remain labels in the schema and are not clients.                                                            |

`@ai-company/domain` is an API devDependency that the Worker imports.

## Company proof

Organization display name: `AI STUDIO LAB`.

| Employee                | Role      |
| ----------------------- | --------- |
| EMP01 CEO / Coordinator | executive |
| EMP02 Manager           | manager   |
| EMP03 Worker A          | employee  |
| EMP04 Worker B          | employee  |
| EMP05 QA                | qa        |
| EMP06 Security          | security  |

Six browser sessions. Each active binding is `runtime_type = BROWSER`, `adapter_type = browser`, `external_ref` null. Session rows store `token_hash` only. There is no seventh CUE employee. Muse and CUE were not contacted.

The project is room `PROJECT POC-001`. The task objective is `Create and review one small creative artifact.` The recorded path is in `docs/testing/e2e-company-poc.md`.

Delivery proof on that task: inbox `QUEUED`, then `DELIVERED` after the worker socket opens. The task stays `DELIVERED` until `ack`, then `ACKNOWLEDGED`, then `start` moves it to `WORKING`. Task ack does not set `current_task_id`. After sweep, availability is `DEGRADED`. Reachability while the socket is open is `BROWSER_CONNECTED`.

## Last recorded checks

These commands passed at the close of Phase 10, before this publication document:

- `pnpm test` — 92 passed (domain 14, policy 15, schemas 2, api 61)
- `pnpm typecheck` passed
- `pnpm lint` passed
- `pnpm format` passed

The push of this commit is the first GitHub Actions run. CI uses pnpm 10.33.2, Node 22, a frozen lockfile, `pnpm --filter @ai-company/api types`, format, lint, typecheck, and test. CI does not deploy.

## Production and secrets

Production mutations: none.
Secrets: none.
Unrelated Cloudflare resources on the same login stay untouched. Examples named during discovery include `frigo`, `selinow`, `chophanmem`, `tungjpstore`, and their databases, buckets, and queues.

## Known engine limits

The local workflow engine can report instance status `running` while `waitForEvent` is pending. The `workflow_runs` row is `waiting_for_approval`. A 24 hour event timeout can print a hang warning. Denial paths throw `NonRetryableError`, and the local engine prints that while recording the instance as `errored`. Those logs are non-failures when the suite exit code is 0.
