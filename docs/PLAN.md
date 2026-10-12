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

The paragraph below is the 2026-10-10 plan note. Pull request 5 and the C1-A2 branch have since merged. Current product work is the following section.

Stage C source was merged through PR #5 at `3909fada8747ae27ea71daf6da9481a7eb8d9eff` with exact-main CI success; the former open-PR state is obsolete. C1-A2 operator hardening was implemented on `fix/roomagent-c1-a2-security-hardening` and later merged as pull request 9 at `11a1cab441462cc6087bae2f903dc2b5f1a49b56`. Read [the independent review package](reports/stage-c/C1_A2_INDEPENDENT_REVIEW_PACKAGE.md). No deploy, C1 bootstrap, C2 smoke, retirement or production certification follows from code merge/CI. Current live runtime state must be re-observed separately; Muse/CUE product adapters remain unimplemented.

## Product MVP

The operator UI, authenticated organization HTTP API, browser agent join, and realtime room client are in scope on `feat/roomagent-product-mvp-v1`. Contracts are in [docs/product/](product/architecture.md). The earlier sentence that this remediation plan does not start a UI described that remediation only. It does not cancel the product milestone.

The milestone still does not deploy, widen role templates, add migration `0016`, or treat a browser adapter as a native Muse or CUE connection. Independent review of the product pull request is required before merge. Live Cloudflare changes need a separate authorization.

## Safety rules that stay in force

- Workers, Durable Objects with SQLite, D1, Queues, Workflows, and R2. KV only if a later design shows it is required.
- OrganizationDO authorizes. RoomDO orders messages. AgentDO owns inbox and reachability. TaskDO owns task transitions. ArtifactDO owns versions, reviews, and approvals. D1 is the relational query. Queues are the at-least-once bus. The one workflow waits for a human. R2 stores immutable bytes.
- Chat text and artifact bytes have zero authority.
- Logs omit Authorization, Cookie, tokens, join codes, session tokens, event payloads, artifact bytes, review text, and task objectives.
- Role templates stay as seeded. Employee plus security is rejected. `workflow.approve` stays off the employee, QA, and security templates.
- Wrangler stays without `"remote": true`.
- Git identity for this repo is local: `vn-tak` / `335007142+vn-tak@users.noreply.github.com`.
