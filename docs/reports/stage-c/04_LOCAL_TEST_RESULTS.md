# Stage C local test results

Evidence level: LOCALLY_TESTED. Not CI_CERTIFIED until the pull-request checks finish. Not DEPLOYED. Not REMOTE_TESTED.

Commands ran from `/Users/tunbee27/Documents/roomAgent` on 2026-10-11. Wrangler stayed on 4.148.0. `worker-configuration.d.ts` did not change. `git diff --check` was clean before these reports were added. The reports were formatted after the suite.

| Command                                                     | Result                             |
| ----------------------------------------------------------- | ---------------------------------- |
| `pnpm install --frozen-lockfile`                            | PASS                               |
| `pnpm --filter @ai-company/api types`                       | PASS                               |
| `pnpm format`                                               | PASS                               |
| `pnpm lint`                                                 | PASS                               |
| `pnpm typecheck`                                            | PASS                               |
| `pnpm test`                                                 | PASS                               |
| `python3 scripts/test-migrations.py`                        | 11 OK                              |
| `python3 scripts/test-d1-preflight.py`                      | 17 OK                              |
| `python3 scripts/d1_preflight.py manifest`                  | PASS                               |
| `python3 scripts/d1_preflight.py config`                    | PASS                               |
| `python3 scripts/test-staging-bootstrap.py`                 | 4 OK                               |
| `wrangler deploy --dry-run --config wrangler.staging.jsonc` | exited at `--dry-run: exiting now` |

`pnpm test` counts:

| Package            | Tests |
| ------------------ | ----- |
| `packages/domain`  | 14    |
| `packages/schemas` | 2     |
| `packages/policy`  | 15    |
| `apps/api`         | 130   |
| Total              | 161   |

The previous JavaScript baseline cited for this repository was 155. This branch adds 6 API tests and does not remove any. API files: 39 passed. Migration tests stay 11. D1 preflight tests stay 17.

The dry-run was Wrangler 4.148.0 with `--outdir` set outside the repository. The printed bindings were the staging Worker names: D1 `ai-company-os-staging`, R2 `ai-company-os-staging-artifacts`, the three staging queues, and the staging Durable Object classes. It printed `--dry-run: exiting now`. It did not publish a version.

Workflow engine logs during `pnpm test` included `NonRetryableError`, hang cancellation, and dead-letter warnings from existing governance tests. The process exit code was 0. Those logs are not a Stage C bypass. The new smoke expects the governed run to stay not `complete`.

The first planner run inside the full log executed 3 Python tests. A harness-binding guard was added after that log line. A second run of `python3 scripts/test-staging-bootstrap.py` executed 4 tests and passed. JavaScript sources did not change between those runs.

`scripts/d1_preflight.py config` still reports `DO_REMOTE_PROVISIONING_NOT_PERFORMED: true`. That flag is a static checker constant. It is not a claim that the live staging Worker has no Durable Objects. This run did not change that checker and did not deploy.

## F01–F05 remediation run

The same command list was run again after the approval-token, release SHA, migration ledger, role-permission, harness, and binding checks. JavaScript totals stayed 161 because the new assertions sit inside existing tests: domain 14, policy 15, schemas 2, API 130 across 39 files. Python migration tests stayed 11. D1 preflight tests are 19. Staging bootstrap planner tests are 6. `d1_preflight.py manifest` and `config` returned PASS. Wrangler 4.148.0 dry-run of `wrangler.staging.jsonc` printed `STAGING_RUNTIME` as `cloudflare` and exited at `--dry-run: exiting now`. It did not publish. `worker-configuration.d.ts` did not change. `apps/api/wrangler.jsonc` and migrations `0001`–`0015` did not change.

The same workflow-engine logs appeared (`NonRetryableError`, hang cancellation, dead-letter warnings). The process exit code was 0. Those logs are not a harness bypass.
