# AI Company OS

Cloudflare-native control plane for an organization of independent AI employees.

Muse and CUE are replaceable execution runtimes. They are not the employee record.

## Status

Repository: `hello-tako/roomAgent` (`1410359112`). Protected `main` for this product milestone is `11a1cab441462cc6087bae2f903dc2b5f1a49b56`, the PR #9 merge. The operator application, human HTTP control plane, and browser agent client are documented in [docs/product/architecture.md](docs/product/architecture.md). That work is source only. It does not deploy, change Cloudflare, or certify staging.

Historical certification remains `AI_COMPANY_OS_POC_PARTIAL`. Phase 0 through Phase 10 records stay in this repository. The six-agent company test ran locally on browser sessions. Muse and CUE were not contacted. Stage C merged through pull request 5; the resulting main was `3909fada8747ae27ea71daf6da9481a7eb8d9eff`. C1-A2 merged through pull request 9. Those earlier statements that called pull request 5 open are historical and are not the current branch state. See [docs/reports/stage-c/FINAL_STAGE_C_CERTIFICATION.md](docs/reports/stage-c/FINAL_STAGE_C_CERTIFICATION.md) and [docs/STATUS.md](docs/STATUS.md).

`https://ai.tungjp.store` serves the 2026-10-08 Worker. `https://api-staging.tungjp.store` is the 2026-10-10 staging Worker behind Cloudflare Access. Neither hostname is a production certification or a Muse session. This product milestone does not change either runtime.

- Current runtime: [docs/reports/current-runtime.md](docs/reports/current-runtime.md)
- Remediation ledger: [docs/reports/architecture-remediation-v1.md](docs/reports/architecture-remediation-v1.md)
- Current state: [docs/STATUS.md](docs/STATUS.md)
- Remaining plan: [docs/PLAN.md](docs/PLAN.md)
- Review package: [docs/reports/publication.md](docs/reports/publication.md)
- Company proof: [docs/testing/e2e-company-poc.md](docs/testing/e2e-company-poc.md)

## Local checks

```bash
pnpm install --frozen-lockfile
pnpm --filter @ai-company/api types
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
python3 scripts/test-migrations.py
python3 scripts/test-staging-bootstrap.py
```

`pnpm test` stays on local bindings. `apps/api/wrangler.jsonc` is still the placeholder database and has no `"remote": true`. The live ids are in [docs/reports/current-runtime.md](docs/reports/current-runtime.md).

Do not deploy `apps/api/wrangler.jsonc` onto `ai.tungjp.store`. That file would replace the Worker that is already there. Staging deploys use `apps/api/wrangler.staging.jsonc`. Leave unrelated account databases, buckets, and queues alone.

## Layout

```text
apps/api                         stateless Worker gateway, queue consumers, and ProductionTaskWorkflow
apps/web                         operator and agent browser application
packages/agent-client            provider-neutral room connection and event reducer
packages/domain                  ids, validation, entity types, task machine, artifact keys, event envelope, workflow cap, adapter port
packages/policy                  permission catalog, role templates, decision function
packages/schemas                 command validation
packages/db                      tenant-scoped D1 store
durable-objects/organization     OrganizationDO authority and join codes
durable-objects/room             RoomDO hibernating WebSocket
durable-objects/agent            AgentDO session, inbox, browser adapter
durable-objects/task             TaskDO state machine
durable-objects/artifact         ArtifactDO immutable versions, reviews, and approvals
migrations                       schema, permission seed, authority, room, join, session, task, event, artifact, governance, and workflow projections
```
