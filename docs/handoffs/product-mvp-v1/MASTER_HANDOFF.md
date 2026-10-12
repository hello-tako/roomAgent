# Product MVP V1 master handoff

Status: `ROOMAGENT_PRODUCT_MVP_V1_PAUSED`. This is a WIP checkpoint, not an
implementation completion, not independent review, and not a deploy.

## Project

RoomAgent is a Cloudflare-native multi-agent company OS. A human operator
administers an organization. AI employees join through one-time codes and work
inside authorized rooms. TaskDO owns task state. ArtifactDO owns immutable
versions. OrganizationDO owns authority. Muse and CUE are future runtimes, not
the employee record.

Current milestone: `ROOMAGENT_PRODUCT_MVP_V1_P11_P16`.

The owner ordered a safe pause before the operator UI and browser E2E were
finished. Preserve this tree. Do not treat it as ready to merge.

## Repository

| Item                        | Value                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Repository                  | `hello-tako/roomAgent`                                                                                            |
| Repository ID               | `1410359112`                                                                                                      |
| Development branch          | `feat/roomagent-product-mvp-v1`                                                                                   |
| Baseline main               | `11a1cab441462cc6087bae2f903dc2b5f1a49b56`                                                                        |
| Worktree                    | `/tmp/roomagent-mvp` (macOS `/private/tmp/roomagent-mvp`)                                                         |
| Local git identity          | `vn-tak` / `335007142+vn-tak@users.noreply.github.com`                                                            |
| Push account                | `hello-tako` (id `336900841`) via `gh`                                                                            |
| Origin URL recorded locally | `https://github.com/vn-tak/roomAgent.git` (transfer/redirect). Push and read back against `hello-tako/roomAgent`. |

The checkpoint commit SHA is recorded in the draft PR body after the commit.
It is intentionally absent from this tracked file.

Protected main at the pause was `11a1cab441462cc6087bae2f903dc2b5f1a49b56`,
the PR #9 merge. Parents: `628a002950f84bf847513b7d25f7d90ca9867dac` and
reviewed head `1c606c45cd397097cf3c951c4c07da0befb0affa`.

## Architecture in force

- Cloudflare Worker (`apps/api`) is the only HTTP gateway. The browser must
  not call Durable Object RPC directly.
- OrganizationDO authorizes. RoomDO orders room events. AgentDO owns employee
  sessions and inbox. TaskDO owns task transitions. ArtifactDO owns versions,
  reviews, and approvals.
- Humans and employees are different principals. The operator does not receive
  a fake employee session.
- Join codes and bearer tokens are credentials. The new UI direction keeps
  them in module memory, not `localStorage`, `sessionStorage`, or cookies.
- Chat text and artifact bytes have zero authority.
- No migration `0016`. Idempotency and rate limits for the new control plane
  live in OrganizationDO SQLite tables `control_rates` and `control_replays`.
- Role templates were not widened. The owner-approval deadlock is handled by
  a custom role plus `adoptRole`, not by giving employees `artifact.approve`
  or `workflow.approve` on the system templates.

## What this session implemented

Backend control plane and realtime extensions are in the worktree and are the
bulk of the checkpoint. The operator React application was started and then
frozen. It has session, permission, and task-view modules plus Vite and
Playwright scaffolding. It does not have `src/main.tsx`, routes, screens, or
an E2E spec.

`docs/product/` describes the intended product contract. Several screens in
those documents are not built. Trust the source tree over those documents
when they disagree.

Details: [IMPLEMENTATION_LEDGER.md](IMPLEMENTATION_LEDGER.md),
[ARCHITECTURE_AND_API_HANDOFF.md](ARCHITECTURE_AND_API_HANDOFF.md),
[TEST_AND_CI_EVIDENCE.md](TEST_AND_CI_EVIDENCE.md),
[SECURITY_AND_RISK_REGISTER.md](SECURITY_AND_RISK_REGISTER.md),
[NEXT_AGENT_EXECUTION_PLAN.md](NEXT_AGENT_EXECUTION_PLAN.md).

## Critical assumptions

- Human sessions can be issued only to `organizations.created_by_user_id`
  because migration `0011` trigger `human_session_owner` rejects everyone
  else. Do not add a migration in order to create a second human operator
  unless the owner approves that schema change.
- `issueSession` still requires `runtime.bind` on the subject. Leave that
  gate in place.
- Only the owner template holds `artifact.approve`. The owner who creates a
  task cannot approve it (`NO_SELF_APPROVAL`). A custom role such as
  `final_approver` granted to a non-creator, non-assignee employee is the
  path the company test used. Do not weaken `SELF_APPROVAL_ACTIONS`.
- `complete` is allowed for the owner after `APPROVED` because `complete` is
  not a self-approval action and requires `task.assign`.
- Local demo auth is `POST /local/product-fixture` only when
  `LOCAL_PRODUCT_FIXTURE=enabled` and the request URL hostname is loopback
  (`localhost`, `127.0.0.1`, `company.local`, or `::1`). The flag is absent
  from `wrangler.jsonc` and `wrangler.staging.jsonc`.
- `apps/api/wrangler.local.jsonc` is a local-only config. Do not deploy it.
- F3 remains `UNRESOLVED_MEDIUM`. F4 and F5 are not accepted.
- Native Muse and CUE adapters are not implemented.
  `NATIVE_PROVIDER_STATUS` is `"unimplemented"`.

## Risks

- The last passing company integration run happened before `createRole` also
  called `adoptRole`, before Prettier rewrites, and before `initialSeq` was
  added to `RoomConnection`. Those edits were not re-run as a suite before
  the pause. See the test evidence file.
- `docs/product/` can be read as if the UI already exists. It does not.
- Pushing this branch runs the existing GitHub Actions job `check`, including
  `wrangler deploy --dry-run` for the staging config. That dry run is not a
  deployment. Do not add a real deploy.
- `pnpm-lock.yaml` may have been refreshed so the new workspace packages
  install. If the install was still running or failed, the test evidence file
  says so. Do not assume frozen install succeeds until that note is current.

## Unfinished work

1. Finish `apps/web` screens and wire `@ai-company/agent-client`.
2. Add Playwright E2E for the operator journey and the security negatives.
3. Extend the existing `check` job only. Do not rename it. Do not add deploy
   credentials.
4. Re-run the required local command list on the checkpoint tree.
5. Reconcile `docs/product/` with the code that actually exists.
6. Open the PR for independent review only after CI is green on that exact
   head. This pause PR is a draft checkpoint and is not that review request.

## Resume rules

- Work on `feat/roomagent-product-mvp-v1`. Never commit to protected main.
- Do not edit `handoff/c1-a2/operator/`, `handoff/c1-a2/BUNDLE_SHA256SUMS`,
  release pins, or public/staging Wrangler deploy configs.
- Do not rewrite migrations `0001`–`0015`.
- Do not deploy, write remote D1, change Access, DNS, secrets, branch
  protection, or collaborators.
- Do not force-push or rewrite the checkpoint commit.
- Do not self-approve or merge.
- Do not print join codes, bearer tokens, Access JWTs, or Cloudflare tokens.

## START HERE — INCOMING AGENT

1. Read this file, then `NEXT_AGENT_EXECUTION_PLAN.md`.
2. Check out `feat/roomagent-product-mvp-v1` from
   `https://github.com/hello-tako/roomAgent` at the checkpoint SHA in the
   draft PR body. Confirm main is still
   `11a1cab441462cc6087bae2f903dc2b5f1a49b56` before rebasing. Do not rebase
   unless the owner asks.
3. Confirm `handoff/c1-a2/operator/SHA256SUMS` is
   `6609c3e77b3788578ec97016a01f12e9b794290822a402d017b4b88032670fe5` and
   `handoff/c1-a2/BUNDLE_SHA256SUMS` is
   `1037cb2f72c2b45c539035a18e24696d80464332c7ad82d1dcc10da5c3df7a7e`.
4. Install from the repo root with the package manager recorded in
   `NEXT_AGENT_EXECUTION_PLAN.md`.
5. First coding task: build the missing operator UI on the existing HTTP and
   room protocol. Do not redesign the backend that already passes the company
   scenario unless a failing test proves a defect.
6. The product is ready for independent review only when the definition of
   done in the original P11–P16 request is met and CI job `check` is green
   on that head. Do not request Muse review of this pause commit.
