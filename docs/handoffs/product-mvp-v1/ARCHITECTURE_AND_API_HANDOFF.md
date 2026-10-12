# Architecture and API handoff

This file describes the code in the checkpoint, not the unfinished screens
named in `docs/product/frontend.md`.

## Packages

| Path                           | Role                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `apps/api`                     | Hono Worker, queues, `ProductionTaskWorkflow`                                                                    |
| `apps/web`                     | Scaffold only. React 19, Vite, React Router, and TanStack Query are declared. No application entry is committed. |
| `packages/agent-client`        | Browser-safe room reducer and `RoomConnection`. No `cloudflare:workers` import.                                  |
| `packages/domain`              | Unchanged ids, task machine, validation                                                                          |
| `packages/policy`              | Unchanged catalog and role templates                                                                             |
| `packages/db`                  | Unchanged. Still expects migrations `0001`–`0015` only.                                                          |
| `durable-objects/organization` | Authority, human sessions, join codes, `adoptEmployee`, `adoptRole`, control-plane rate and replay               |
| `durable-objects/room`         | Ordered events plus human hello                                                                                  |
| `durable-objects/agent`        | Employee sessions, inbox, `endOwnSession`                                                                        |
| `durable-objects/task`         | Unchanged TaskDO                                                                                                 |
| `durable-objects/artifact`     | Unchanged ArtifactDO. Download header is set by the Worker.                                                      |

New dependencies from this milestone: `@ai-company/web` workspace packages
listed in `apps/web/package.json`, and `@ai-company/agent-client`. The root
script `test:e2e` calls the web package. Lockfile: `pnpm-lock.yaml`.

## Frontend

Present:

- `apps/web/index.html` mounts `/src/main.tsx`, and that module is not in the
  tree. `vite` cannot serve the app until it exists.
- `src/session.ts` holds human and employee bearers in module memory.
- `src/permissions.ts` `can` and `joinScopes` (maximum 8, preferred order,
  never invents `workflow.approve`).
- `src/task-views.ts` maps backend states to backlog, assigned, progress,
  review, revision, done, held, and closed. These are filters, not a second
  state machine.
- Vite proxies `/orgs`, `/join`, `/j`, `/health`, `/local`, and `/access` to
  `127.0.0.1:8787`, with WebSocket on `/orgs`.
- `VITE_LOCAL_FIXTURE` is not yet read by a screen. The intended check is
  `import.meta.env.VITE_LOCAL_FIXTURE === "true"`.

Navigation routes in `docs/product/frontend.md` are a plan. Do not mark them
done.

## Authentication

Production: Cloudflare Access injects `cf-access-jwt-assertion` on the same
host. `GET /access/organizations` returns at most 20 active organizations
whose `created_by_user_id` is the mapped user: `{id,name,status}`. It does
not return email, subject, or the session token.
`POST /orgs/:orgId/human-sessions` issues the bearer.
`DELETE /orgs/:orgId/human-sessions/current` revokes it.

Failures include `BOOTSTRAP_NOT_CONFIGURED` (503),
`ACCESS_IDENTITY_INVALID` (401), and unmapped or disabled identity (403).

Local: `POST /local/product-fixture` with `x-idempotency-key`. Allowed only
when the env flag is `enabled` and `new URL(request.url).hostname` is
loopback. A spoofed Host header cannot enable it on a public route because
Workers set `request.url` from the actual route. The response includes the
human bearer. Do not log it. Each new key creates a new organization, at most
10 times a minute in one isolate. GET is not implemented (404).

`apps/api/wrangler.local.jsonc` sets the flag and
`WEB_ORIGIN=http://127.0.0.1:5173`. Worker name
`ai-company-os-api-local`. Placeholder D1 id
`00000000-0000-4000-8000-000000000001`. Comment says do not deploy.

Human bearers match `hum_` plus 64 hex characters. Employee bearers are 64
hex plus `x-employee-id`. Verification is AgentDO or OrganizationDO. The URL
organization id is only the lookup key.

CORS allows the configured Vite origins or an https origin no longer than 200
characters. Allowed headers: `authorization`, `content-type`,
`x-idempotency-key`, `x-employee-id`, `x-request-id`. Methods: GET, POST,
DELETE, PUT, OPTIONS. Missing Origin is allowed for same-origin tools.

## Organization authority

Humans receive catalog permissions only when `actorId` is the organization
creator. Other humans get an empty set, and non-owner human sessions cannot
be inserted under the current trigger.

Employees use role templates. Conflicts remain: employee plus security, and
implement permissions plus `security.approve`, with the owner role skipped in
that check. Custom role `final_approver` plus QA does not trip that conflict.
That was observed in the earlier company test, not re-certified here.

`adoptRole` copies a non-system D1 role and its `role_permissions` into
OrganizationDO SQLite. System roles are hydrated with the organization and
must not be inserted by this path.

Suspension is one-way.

## Employee identity and join

Join codes are 64 hex, one-time, TTL 0 through 600 seconds. Treat them as
credentials. `POST /join` keeps the code out of the URL. Redeem still requires
an active runtime binding. The issued session returns `org_id`,
`employee_id`, `session_id`, `token`, and `expires_at`.

`issueJoinCode` requires `runtime.bind`. Requested scopes that the employee
does not hold are `NO_PERMISSION`. A second redeem is `ALREADY_USED`.

`DELETE /orgs/:orgId/agents/:employeeId/session` calls `endOwnSession` with
an empty scope check and drops that session only.

The local fixture creates Northwind Studio, owner Avery Chen, departments
Studio and Review, employees Mina Cho (manager), Wes Adler, Nia Patel, Omar
Shah (employees), Quinn Blake (QA), Sam Ibarra (security), browser runtime
bindings, and rooms Studio Floor and Review Bay. It does not pre-issue join
codes.

Worker scopes used by the test: `room.read`, `room.message.send`,
`task.read`, `task.accept`, `artifact.read`, `artifact.create`,
`artifact.modify`. Quinn's join also includes `artifact.approve` after the
custom role. Sam does not get `room.message.send` and is not a member of
Studio Floor.

## Realtime

Employee room hello is unchanged: `employee_id` plus 64-hex token, membership
required.

Human hello: `data.actor_type` is `human` and `data.token` matches
`^hum_[0-9a-f]{64}$`. The socket is authorized for `room.read`. Replay window
is 100. A gap at or beyond that window is `RESYNC_REQUIRED`. Ping before
authentication was left as it already behaved.

`RoomConnection` sends `last_seen_seq` from reducer head, default 0, or
`initialSeq` when provided. Heartbeat default 20 seconds. Reconnect backoff
is `500 * 2^min(attempt,5)`, maximum 6 attempts, stop on `session.revoked`.

Agent socket hello is `{v:1,type:"session.hello",data:{token}}` without an
employee id. `inbox.ack` uses `data.inbox_id`. The client package does not
implement that socket yet.

Room commands from employees: `task.ack`, `task.start`, `task.submit`, and
`message.send`. Published messages are `message.created`. `submit` moves
WORKING to REVIEW. Do not mark a message delivered until the server event
with the same idempotency key arrives.

## Task, artifact, and workflow

Task states stay the TaskDO set: CREATED, QUEUED, DELIVERED, ACKNOWLEDGED,
WORKING, SUBMITTED, REVIEW, REVISION, APPROVED, COMPLETED, CANCELLED, FAILED,
EXPIRED, BLOCKED, PAUSED.

Create ignores `assignee_id` and starts at CREATED. Assignee-only commands
are ack, start, and submit. Approve requires `artifact.final_approve` and
denies the creator and the assignee. Complete requires `task.assign`.

HTTP task command body is exactly `{command, assignee_id}`. Create body keys
are exactly `title`, `objective`, `room_id`, `assignee_id`, `depends_on`,
`completion_policy`. Idempotency scope is `task:{id}` or `task:create` and
does not include the command name, so each command needs a new key.

Artifact list omits `r2_key`. Create and upload responses may still include
it. The UI must not render that key and must not use
`dangerouslySetInnerHTML`. Allowed media types are unchanged.

Workflow start body remains exactly `{artifact_id, version}`. Resolution body
remains exactly `{hold_reason}`. `workflow.approve` stays restricted.
`TOOL_ACCESS` is not human authorization.

## Migrations

None. Adding `0016` would be `SCHEMA_DRIFT` against `packages/db` and the C1
operator ledger. Control-plane durability is OrganizationDO SQLite only.

## Permission boundaries that must stay

- Do not grant owner or `workflow.approve` to the employee template.
- Do not let the frontend decide authorization.
- Do not let agent-authored text trigger administration.
- Do not store provider passwords or automate MFA.
- Do not log join codes or tokens.
