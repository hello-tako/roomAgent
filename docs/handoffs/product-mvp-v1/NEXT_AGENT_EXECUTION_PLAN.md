# Next agent execution plan

## 1. Checkout

```bash
git clone https://github.com/hello-tako/roomAgent.git
cd roomAgent
git fetch origin feat/roomagent-product-mvp-v1
git checkout feat/roomagent-product-mvp-v1
```

Confirm the commit matches the checkpoint SHA in the draft PR body.
Confirm `main` is `11a1cab441462cc6087bae2f903dc2b5f1a49b56` before any rebase.
Do not rebase, force-push, or commit to main unless the owner asks.

The local implementation worktree used for this pause was `/tmp/roomagent-mvp`.
Other worktrees are historical and must stay put:

- `/private/tmp/roomagent-pr9` at `1c606c45`
- `/private/tmp/roomagent-main-3909fada` at `3909fada`
- `/Users/tunbee27/Documents/roomAgent` on `feat/stage-c-bootstrap-smoke-v1`

Do not commit from the Documents checkout.

## 2. Environment

- Node 22
- pnpm 10.33.2 (`packageManager` field)
- Repo-local git identity may stay `vn-tak` /
  `335007142+vn-tak@users.noreply.github.com`
- GitHub CLI, when a push is required, should be `hello-tako`
- No Cloudflare token is required for source work
- Do not decrypt Wrangler storage or call `wrangler whoami`

## 3. Dependencies

From the repository root, not from the user home directory:

```bash
pnpm install --frozen-lockfile
```

If that fails because the lockfile and `apps/web/package.json` diverged after
this checkpoint, stop and inspect the diff. Do not delete the web package to
make install pass.

## 4. Validation commands

Run these before claiming the milestone is ready. They were not all run at
the pause:

```bash
pnpm --filter @ai-company/api types
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm test:operator
node handoff/c1-a2/operator/secret-safety.mjs
node handoff/c1-a2/operator/c1-runner.mjs --verify-bundle
python3 scripts/test-migrations.py
python3 scripts/test-d1-preflight.py
python3 scripts/test-staging-bootstrap.py
python3 scripts/d1_preflight.py manifest
python3 scripts/d1_preflight.py config
```

On macOS, operator tests may need a private `TMPDIR` outside a symlinked
parent, then delete that directory. Do not weaken the operator's symlink
checks.

Targeted tests already observed green are listed in `TEST_AND_CI_EVIDENCE.md`.
Re-run them after any edit.

## 5. First files to inspect

1. `docs/handoffs/product-mvp-v1/MASTER_HANDOFF.md`
2. `apps/api/src/control-plane.ts`
3. `apps/api/src/index.ts`
4. `apps/api/test/control-plane.test.ts`
5. `durable-objects/room/src/room-do.ts` human hello
6. `durable-objects/organization/src/organization-do.ts` `adoptRole`
7. `packages/agent-client/src/connection.ts`
8. `apps/web/package.json` and the missing `src/main.tsx`

## 6. Known unfinished or broken areas

- The web app does not boot. `index.html` references `src/main.tsx`, which
  was not written.
- No pages, no CSS, no Playwright spec.
- `docs/product/frontend.md` describes files that are absent.
- Full format, lint, typecheck, and workspace tests were not run.
- `initialSeq` has no direct unit assertion.
- CI does not run `pnpm test:e2e` yet. Add that inside job `check` only after
  the E2E exists. Keep the job name `check`. Actions app id `15368`.

## 7. Next implementation steps

1. Add `apps/web/src/main.tsx`, the router, and the screens in
   `docs/product/frontend.md`, adjusted to the real JSON from the control
   plane. Keep the `data-testid` values named in the product docs.
2. Use `@ai-company/agent-client` `RoomConnection` for human and employee
   rooms. Add a small agent-inbox socket for `inbox.ack`. Do not log tokens.
3. Keep bearers in `session.ts` memory. Reload loses the session on purpose.
4. Prove the Northwind scenario through the UI and the existing APIs:
   local fixture, Studio Floor, Wes join via `POST /join`, messages delivered
   only after the server event, NONE-policy task, owner self-approval denial,
   Quinn custom role approval, owner complete, audit, revoke.
5. Add security negatives: other organization, expired or replayed join code,
   unauthorized approve.
6. Extend `.github/workflows/ci.yml` without renaming `check` and without
   deploy credentials.
7. Reconcile product docs with the built UI.
8. Run the full command list. Open or update one PR. Request independent
   review only when CI is green on that exact head.

## 8. Regression tests that must keep passing

- `apps/api/test/control-plane.test.ts`
- Existing company POC, human session, join, room, task, artifact, and
  workflow tests
- `packages/agent-client` unit tests
- C1 operator tests and `--verify-bundle`
- Migration name ledger stays `0001`–`0015`

## 9. Milestone

Finish `ROOMAGENT_PRODUCT_MVP_V1_P11_P16` as a locally functioning browser
MVP. Do not self-issue production certified or staging deployed.

## 10. When to request review

Request Muse (`vn-taphoanhatung`) or another owner-designated reviewer only
against the exact head whose `check` run is green. Do not request review of
this pause commit. Do not merge. Do not self-approve. PR #9 approval does not
cover this branch.

## Decisions that must not be reversed casually

- No D1 migration for control-plane idempotency.
- No widened role templates.
- No fake employee session for the human operator.
- No production login bypass.
- Fixture stays flag-and-hostname gated.
- `POST /join` is the new client path; `/j/:token` stays for old clients.
- Quinn's custom role is the approval path, not owner self-approval.
- Native provider status stays `unimplemented` until a real adapter exists.
