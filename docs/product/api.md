# Operator API contract

All organization routes require a bearer. A human bearer matches `hum_` plus 64 hex characters. An employee bearer is 64 hex and is sent with `x-employee-id` on the routes that accept employees. A client-supplied organization or employee id is not authorization. The token is verified in that organization.

Error body: `{ "error": { "code", "message", "request_id" } }`. Mutating control-plane errors omit `request_id` when they are stored for replay. Status 401 means the session is missing, expired, or revoked. Status 403 means the actor is authenticated and not allowed. Status 404 hides cross-tenant existence where the Durable Object returns `TENANT_BOUNDARY`.

Mutations require `x-idempotency-key` matching `^[A-Za-z0-9_-]{8,80}$`. The JSON object must contain exactly the documented keys. Bodies larger than 16384 bytes are rejected. Page size is 1 through 50. The cursor query is `after`, and the next page uses the last returned id.

| Method and path                                  | Permission                                 | Body                                         |
| ------------------------------------------------ | ------------------------------------------ | -------------------------------------------- |
| `GET /orgs/:orgId/me`                            | valid human session                        |                                              |
| `GET /orgs/:orgId/summary`                       | `task.read`                                |                                              |
| `POST /orgs/:orgId/profile`                      | `organization.policy.manage`               | `{name}`                                     |
| `GET /orgs/:orgId/employees`                     | `task.read`                                |                                              |
| `POST /orgs/:orgId/employees`                    | `agent.invite`                             | `{display_name}`                             |
| `GET /orgs/:orgId/employees/:employeeId`         | `task.read`                                |                                              |
| `POST .../suspension`                            | `agent.remove`                             | `{}`                                         |
| `POST .../roles`                                 | `agent.role.assign`                        | `{role_code}`                                |
| `DELETE .../roles/:roleId`                       | `agent.role.assign`                        |                                              |
| `POST .../runtime-bindings`                      | `runtime.bind`                             | `{runtime_type, adapter_type, external_ref}` |
| `POST /runtime-bindings/:bindingId/revocation`   | `runtime.revoke`                           |                                              |
| `POST .../join-codes`                            | `runtime.bind`                             | `{scopes, ttl_seconds}`                      |
| `POST /join-codes/:joinId/revocation`            | `runtime.revoke`                           |                                              |
| `GET .../sessions`                               | `runtime.bind`                             |                                              |
| `POST .../sessions/:sessionId/revocation`        | `runtime.revoke`                           |                                              |
| `DELETE /orgs/:orgId/agents/:employeeId/session` | that employee token                        |                                              |
| `GET/POST /departments`                          | `task.read` / `organization.policy.manage` | `{name, parent_department_id}`               |
| `GET/POST /roles`                                | `task.read` / `organization.policy.manage` | `{code, name}`                               |
| `POST /roles/:roleId/permissions`                | `organization.policy.manage`               | `{permission}`                               |
| `GET/POST /rooms`                                | `room.read` / `agent.invite`               | `{name, department_id}`                      |
| `GET /rooms/:roomId`                             | `room.read`                                |                                              |
| `POST /rooms/:roomId/members`                    | `agent.invite`                             | `{employee_id}`                              |
| `POST /rooms/:roomId/messages`                   | `room.message.send`                        | `{body}`                                     |
| `GET /rooms/:roomId/events?after=`               | `room.read`                                |                                              |
| `GET/POST /tasks`                                | `task.read` / TaskDO on create             | create keys below                            |
| `POST /tasks/:taskId/commands`                   | TaskDO                                     | `{command, assignee_id}`                     |
| `GET /tasks/:taskId`                             | `task.read`                                |                                              |
| `GET /artifacts`                                 | `artifact.read`                            |                                              |
| `GET /approvals`                                 | `security.audit`                           |                                              |
| `GET /workflows`                                 | `task.read`                                |                                              |
| `GET /audit`                                     | `security.audit`                           |                                              |

Task create body keys are exactly `title`, `objective`, `room_id`, `assignee_id`, `depends_on`, and `completion_policy`. `assignee_id` is null at creation. `depends_on` is an array of task ids. Policies are `NONE`, `ARTIFACT_APPROVED`, `QA_SECURITY`, and `HUMAN_FINAL`.

Task commands are `assign`, `deliver`, `ack`, `start`, `submit`, `request_revision`, `approve`, `complete`, `fail`, and `cancel`. `assignee_id` is required as a key and is null except for `assign`. The idempotency scope is the task id, not the command name, so every command uses a new key.

Employee task commands use the same path. The session scope must include the permission for that command (`approve` requires `artifact.approve`). TaskDO still applies role permissions, assignee rules, and self-approval.

Join code scopes are intersected with the employee's current permissions before OrganizationDO issues the code. A requested scope the employee does not hold is `NO_PERMISSION`.

`POST /join` accepts exactly `{code}`. `POST /orgs/:orgId/join` and `POST /j/:token` remain. The anonymous join routes share a limit of 20 requests per 10 seconds per isolate.

Artifact list responses do not include `r2_key`. Artifact download sets `content-disposition: attachment`.

Existing artifact, review, security approval, final approval, and workflow routes are unchanged aside from the attachment disposition. Workflow start body is exactly `{artifact_id, version}`. Resolution body is exactly `{hold_reason}`.
