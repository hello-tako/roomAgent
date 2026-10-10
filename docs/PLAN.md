# Plan

Recorded: 2026-10-09. Runtime checked again on 2026-10-10 in [current-runtime.md](reports/current-runtime.md).

The numbered build order in the master plan is P0 through P10. Those ten implementation phases have local gates. This plan says what that means, what is still open, and what a later session may do.

## Closed locally

| Order | Work                                                                         | Gate                            |
| ----- | ---------------------------------------------------------------------------- | ------------------------------- |
| P0    | Discovery. Empty repository. No product resources on the Cloudflare account. | `PHASE0_DISCOVERY_COMPLETE`     |
| P1    | Domain types, permission catalog, tenant-scoped D1.                          | `PHASE1_DOMAIN_FOUNDATION_PASS` |
| P2    | OrganizationDO authority.                                                    | `PHASE2_AUTHORITY_ENGINE_PASS`  |
| P3    | RoomDO hibernating WebSocket.                                                | `PHASE3_ROOM_REALTIME_PASS`     |
| P4    | Join codes, browser session, inbox.                                          | `PHASE4_AGENT_JOIN_PASS`        |
| P5    | TaskDO state machine and handoff cap.                                        | `PHASE5_TASK_ENGINE_PASS`       |
| P6    | Domain events, idempotent consumers, retry, dead letter.                     | `PHASE6_EVENT_DELIVERY_PASS`    |
| P7    | ArtifactDO and immutable R2 versions.                                        | `PHASE7_ARTIFACT_PIPELINE_PASS` |
| P8    | Reviews, approvals, append-only audit.                                       | `PHASE8_GOVERNANCE_PASS`        |
| P9    | One `ProductionTaskWorkflow`. Human approval waits on `waitForEvent`.        | `PHASE9_DURABLE_WORKFLOW_PASS`  |
| P10   | Six-employee company proof on browser sessions.                              | `PHASE10_COMPANY_POC_PASS`      |

Policies that already constrain the code: test layers, format/lint/typecheck/test gates, forward-only migrations, no secrets in the repo, structured denials, and the threat model. Two Workers are already uploaded. See [current-runtime.md](reports/current-runtime.md) before any further deploy.

## Certification

State: `AI_COMPANY_OS_POC_PARTIAL`.

`AI_COMPANY_OS_POC_CERTIFIED` stays unissued. The master-plan success list includes a real Muse join. This repository proved the same company flow with browser sessions and left Muse unimplemented on purpose. A browser row labeled `muse` would be a false session, so that shortcut is rejected.

## Remediation and next gates

Architecture remediation v1 closes the independent review findings without a rewrite.
Its implementation ledger and local/CI evidence are in
[architecture-remediation-v1.md](reports/architecture-remediation-v1.md).
The remediation and staging P1 branches are merged on `main` `6cf1db7`. The review
gate tokens in `docs/STATUS.md` are still open. This plan does not start a UI or a
live Muse/CUE integration.

Remaining product work after independent review requires a new explicit request:
human identity-provider/login integration (the minimal session has trusted internal
issuance only), human UI, approved runtime adapters, and any staging/production
provisioning. Vectorize remains unused. This remediation is not production certification.

TaskDO and ArtifactDO remain per-organization MVP serialization domains
(`tasks:{orgId}`, `artifacts:{orgId}`). Future scale may require project/task shards
and per-artifact or artifact shards. No premature sharding is performed here.

## Next safe step

Stage C local code is on `feat/stage-c-bootstrap-smoke-v1`. The next human gates are pull-request review, merge, then a separate staging deploy, then C1 bootstrap, then C2 business smoke. None of those remote steps is authorized by the local suite. Read [current-runtime.md](reports/current-runtime.md) and [stage-c/06_STAGING_DEPLOYMENT_PLAN.md](reports/stage-c/06_STAGING_DEPLOYMENT_PLAN.md) before any deploy. The public hostname still runs the 2026-10-08 Worker, and `apps/api/wrangler.jsonc` does not describe it. Muse and CUE stay unimplemented.

## Safety rules that stay in force

- Workers, Durable Objects with SQLite, D1, Queues, Workflows, and R2. KV only if a later design shows it is required.
- OrganizationDO authorizes. RoomDO orders messages. AgentDO owns inbox and reachability. TaskDO owns task transitions. ArtifactDO owns versions, reviews, and approvals. D1 is the relational query. Queues are the at-least-once bus. The one workflow waits for a human. R2 stores immutable bytes.
- Chat text and artifact bytes have zero authority.
- Logs omit Authorization, Cookie, tokens, join codes, session tokens, event payloads, artifact bytes, review text, and task objectives.
- Role templates stay as seeded. Employee plus security is rejected. `workflow.approve` stays off the employee, QA, and security templates.
- Wrangler stays without `"remote": true`.
- Git identity for this repo is local: `vn-tak` / `335007142+vn-tak@users.noreply.github.com`.
