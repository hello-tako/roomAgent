# Implementation ledger — Product MVP V1

Classifications mean the source behavior, not the existence of a file.
`docs/product/` is a contract draft. It is not evidence that a screen works.

Baseline: `11a1cab441462cc6087bae2f903dc2b5f1a49b56`.
Branch: `feat/roomagent-product-mvp-v1`.

## P11 — Human control plane

Classification: `PARTIAL`

Intended: an operator web app with authentication, dashboard, administration,
rooms, room workspace, task board, task detail, artifacts, governance, and
audit.

Implemented:

- Access organization list: `GET /access/organizations`.
- Human session issue and revoke routes already existed and were left in place.
- Local fixture `POST /local/product-fixture` for loopback only.
- Module-memory session helpers in `apps/web/src/session.ts`. Tokens are not
  written to web storage by that module.
- Task-view and permission helpers with unit tests.
- Vite proxy sketch, Playwright config, and package manifest.

Partial:

- No `apps/web/src/main.tsx`, no router, no screens, no CSS, no E2E spec.
- Sign-in, dashboard, admin, room, task, artifact, governance, and audit UI
  are not implemented.
- Theme, mobile nav, and keyboard focus behavior are not implemented.

Untouched:

- Production Access login bypass was not added.
- A second human operator was not added.

Files: `apps/web/**` (scaffold only), `apps/api/src/human-bootstrap-route.ts`,
`apps/api/src/product-fixture.ts`, `apps/api/src/http-guard.ts`,
`apps/api/wrangler.local.jsonc`.

Tests: `apps/web/src/permissions.test.ts`, `apps/web/src/task-views.test.ts`.
No browser test.

Defects: the web package cannot render a product. Playwright config expects
routes and test ids that do not exist.

Next: implement the screens against the HTTP contract in
`docs/product/api.md`, then correct that document where the code differs.

## P12 — Human API and organization management

Classification: `PARTIAL` and `NEEDS_REVIEW`

Intended: authenticated, permission-checked HTTP for the operator UI.

Implemented in `apps/api/src/control-plane.ts` and registered from
`apps/api/src/index.ts`:

- `GET /orgs/:orgId/me`
- `GET /orgs/:orgId/summary`
- `POST /orgs/:orgId/profile`
- Employee list, create, detail, suspension, role assign, role revoke
- Runtime bind and revoke
- Join-code issue and revoke
- Session list and revocation
- `DELETE /orgs/:orgId/agents/:employeeId/session`
- Departments list and create
- Roles list, create, and permission grant
- Rooms list, create, detail, membership, messages, events
- Tasks list, create, detail, and commands
- Artifact list without `r2_key`
- Approvals, workflows, and audit list without raw audit bodies

Authorization uses OrganizationDO for humans and AgentDO `verify` for
employee task commands. A client-supplied organization id is not authority.
Mutations require an idempotency key. OrganizationDO SQLite stores the replay
and a 40-request / 10-second actor limit. JSON bodies must contain exactly the
declared keys. Page size is 1–50.

`adoptEmployee` and `adoptRole` copy later D1 rows into OrganizationDO after
hydration. `createRole` and `grantPermission` both call `adoptRole`.

Partial:

- Employee HTTP is enabled for task commands only, not for every route.
- Dashboard "online" is an unexpired unrevoked `runtime_sessions` row, not
  RoomDO presence.
- `apps/api/test/control-plane.test.ts` was re-run on this worktree after
  `createRole` called `adoptRole`. Both tests passed. That run is not the
  full suite and is not CI. See `TEST_AND_CI_EVIDENCE.md`.

Untouched:

- Migrations `0001`–`0015`.
- Role templates and the self-approval set.
- Public `wrangler.jsonc` and `wrangler.staging.jsonc`.

Known defect to re-check: idempotency replays store non-500 responses,
including 403. A failed adopt cannot be retried with the same key.

Next: re-run `apps/api/test/control-plane.test.ts` on this tree. Do not widen
policy to make the test pass.

## P13 — Agent join and realtime room

Classification: `PARTIAL`

Implemented:

- `POST /join` reads `{code}` from the body. `POST /j/:token` remains.
- Both anonymous join routes share a 20 / 10-second isolate limit.
- RoomDO accepts `session.hello` with `actor_type: "human"` and a `hum_`
  token. Humans are not given employee sessions or presence. Human task and
  presence commands return `NOT_AVAILABLE`.
- Human close does not change employee presence.
- `AgentDO.endOwnSession` drops only the presented session.
- `packages/agent-client` reduces ordered room events, ignores duplicates,
  buffers a bounded gap, and marks delivery only when the server event carries
  the same idempotency key. Reconnect does not replay `message.send`.
- `initialSeq` lets a client hello at the room head instead of sequence 0.
  The existing connection tests passed after that field was added. They do
  not assert `initialSeq` itself.

Partial:

- No browser join page and no wired room client.
- Agent inbox socket is not wrapped by the package. The Worker route remains
  `GET /orgs/:orgId/agents/:employeeId/socket`.
- Provider-native Muse and CUE adapters are `NOT_STARTED` on purpose.

Files: `durable-objects/room/src/room-do.ts`,
`durable-objects/room/src/protocol.ts`, `durable-objects/agent/src/agent-do.ts`,
`apps/api/src/index.ts`, `packages/agent-client/**`.

Next: connect the human room page and the employee join page to the existing
sockets. Do not mint employee tokens for humans.

## P14 — Tasks, artifacts, and workflows

Classification: `PARTIAL`

Implemented on the API:

- Task commands go to TaskDO. Employee bearers must also hold the command
  scope (`approve` requires `artifact.approve`).
- The company test's intended path is: owner creates and assigns; Wes
  acknowledges, starts, and submits; owner approve returns
  `NO_SELF_APPROVAL`; Wes without the scope returns `NO_SCOPE`; Quinn, after
  custom role `final_approver` / `artifact.approve`, approves; owner
  completes.
- Artifact download sets `content-disposition: attachment`.
- Workflow start and resolution routes were not rewritten. Owner workflow
  start returned 201 in the earlier company run. That run was not repeated
  after the last edit.

Not implemented:

- Task board, artifact workspace, and workflow panels in the browser.
- A browser proof of QA, security, and final approval.

Do not complete tasks by writing SQLite. Use TaskDO.

## P15 — Security and reliability

Classification: `PARTIAL`

Implemented:

- Exact-origin CORS, loopback or https origin allowlist, and
  `ORIGIN_REJECTED` before the route.
- Security headers: nosniff, no-referrer, frame deny, CSP
  `default-src 'none'; frame-ancestors 'none'`.
- Fixture host check uses the request URL hostname, not a spoofable Host
  header alone.
- Join scopes are intersected with permissions held by the employee.
- Audit and timeline responses do not return secret-bearing payloads. The
  timeline keeps a short whitelist.
- Bearer tokens are not cookies, so the new design is not cookie-CSRF.

Still open:

- No browser XSS test, because there is no rendered message UI yet.
- No Playwright negatives for cross-tenant, expired codes, or unauthorized
  approval.
- Rate limits are per isolate or per OrganizationDO actor, not a global edge
  limit.
- `POST /j/:token` still places the code in the URL for old clients.

F3 stays `UNRESOLVED_MEDIUM`.

## P16 — Testing, CI, and documentation

Classification: `PARTIAL`

Implemented:

- `apps/api/test/control-plane.test.ts` covers the six-employee company over
  HTTP and sockets, plus several negatives. See the evidence file for which
  run is historical.
- Agent-client unit tests exist.
- Web unit tests exist for views and join-scope selection.
- `docs/product/` and the README / STATUS / PLAN corrections exist.
- Root script `test:e2e` points at the web package. The existing GitHub job
  `check` was not edited, so CI does not run Playwright yet.

Not done:

- The mandatory full command list was not run on this checkpoint.
- Playwright E2E was not written or run.
- CI was not extended.
- No pull request was a review request. The pause PR is a draft checkpoint.

Next: after the UI exists, add E2E inside the same `check` job, then run the
full command list from the original task.
