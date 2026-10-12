# Test and CI evidence

These results were observed in `/tmp/roomagent-mvp` on 2026-10-12 before the
handoff commit. They are not GitHub Actions results. They are not a full
certification of the checkpoint after documentation-only edits.

## Commands that passed on this worktree

`pnpm --filter @ai-company/agent-client test`

- Vitest 4.1.11
- `test/reducer.test.ts`: 6 passed
- `test/connection.test.ts`: 2 passed
- 2 files, 8 tests, 0 failed, start 21:34:50 local

`pnpm --filter @ai-company/web test`

- `src/task-views.test.ts`: 1 passed
- `src/permissions.test.ts`: 2 passed
- 2 files, 3 tests, 0 failed, start 21:34:52 local

`pnpm exec vitest run test/control-plane.test.ts` from `apps/api`

- 1 file, 2 tests, 0 failed, duration about 1.43 seconds, start 21:34:53 local
- Includes `operates the six-employee company through authenticated HTTP and sockets`
- Log line: `workflow.start` outcome `created`, run id
  `wfr_bfbc3ab6de7e268bfbde89e042235b17`
- The same run printed an uncaught workerd hang exception after that created
  outcome. The vitest file still passed. This noise was already known inside
  passing workflow tests. It is not a new green workflow certification.

No tests were skipped in these three commands.

## Not run on this checkpoint

- `pnpm install --frozen-lockfile` as a clean CI-style install. A non-frozen
  `pnpm install` in the worktree completed and added 62 packages so the new
  web dependencies match `pnpm-lock.yaml`.
- `pnpm --filter @ai-company/api types`
- `pnpm format`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` (full workspace)
- `pnpm test:operator`
- `node handoff/c1-a2/operator/secret-safety.mjs`
- `node handoff/c1-a2/operator/c1-runner.mjs --verify-bundle`
- Python migration, D1 preflight, and staging bootstrap scripts
- `pnpm test:e2e`
- `apps/web` production build
- GitHub Actions

Reason: the owner ordered a pause. The full list takes long enough that it
was left for the next agent and for the CI run that a branch push starts.
Do not describe the three passing commands as that full list.

## Browser E2E

`NOT_RUN`. `apps/web/e2e/` does not exist. Playwright is a dependency. The
config would start Wrangler on `wrangler.local.jsonc` and Vite with
`VITE_LOCAL_FIXTURE=true`. Nothing was executed.

## GitHub Actions

Not started at the time this file was written. A later push of
`feat/roomagent-product-mvp-v1` starts the existing workflow job `check`
because `.github/workflows/ci.yml` triggers on `push`. This milestone did not
edit that file. The job includes `wrangler deploy --dry-run` against
`wrangler.staging.jsonc` with `WRANGLER_SEND_METRICS=false`. That step is not
a deployment. Record the actual run URL from GitHub after the push. Do not
invent a passing conclusion if the run is pending or red.

## C1 files

`git diff` for `handoff/`, `migrations/`, `apps/api/wrangler.jsonc`,
`apps/api/wrangler.staging.jsonc`, and `apps/api/worker-configuration.d.ts`
was empty at inventory time.

`shasum -a 256 handoff/c1-a2/operator/SHA256SUMS` =
`6609c3e77b3788578ec97016a01f12e9b794290822a402d017b4b88032670fe5`

`shasum -a 256 handoff/c1-a2/BUNDLE_SHA256SUMS` =
`1037cb2f72c2b45c539035a18e24696d80464332c7ad82d1dcc10da5c3df7a7e`

Those hashes match the reviewed C1 manifests. `--verify-bundle` was not
re-executed during the pause.

## Flaky or noisy

The workerd hang inside the passing control-plane test is environmental noise
from the local workflow runner. Do not hide it. Do not treat it as a product
pass or as a product failure by itself. The assertion process exited 0.
