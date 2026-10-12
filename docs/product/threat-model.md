# Product threat model

This note covers the operator application and the HTTP control plane. The earlier model in `docs/security/threat-model.md` still applies to the Durable Objects.

| Threat                        | Control                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant token            | Human verification is bound to the organization id. A foreign token is `SESSION_INVALID`. Room and task ids from another organization are not found.  |
| Cross-room employee           | Room hello requires membership. A non-member receives `NOT_MEMBER`. Task commands carry the room id and TaskDO rejects a mismatch.                    |
| Employee impersonation        | The employee token is verified inside the AgentDO named by `x-employee-id`. A token from another employee does not match.                             |
| Join-code replay              | Redemption is one time. The digest is stored. The code is not logged.                                                                                 |
| Session theft                 | Human revoke and employee revoke close later socket commands with `session.revoked`. Tokens are not stored in the browser beyond the page.            |
| Permission escalation         | Join scopes are intersected with held permissions. TaskDO and OrganizationDO decide. The UI hiding a button is not the control.                       |
| Role conflict                 | OrganizationDO still rejects employee plus security, and implementation permissions plus `security.approve`.                                          |
| Self-approval                 | The task creator cannot `approve`. The artifact creator cannot final-approve. The security approver cannot approve their own implementation.          |
| Unauthorized task transition  | TaskDO checks the command, the assignee, and the current state. Humans cannot acknowledge, start, or submit.                                          |
| WebSocket authentication      | Hello is required. A bad token is rejected. Ping before hello stays the existing behavior.                                                            |
| Replay and duplicate commands | Idempotency keys replay the stored result. Room messages replay the same envelope. The reducer drops duplicate sequences.                             |
| Realtime gaps                 | Gaps at the replay window request a resync. The client does not fill the gap locally.                                                                 |
| Secret exposure               | Audit and timeline responses omit raw bodies. Artifact lists omit `r2_key`. Join responses are `no-store`.                                            |
| Untrusted content             | Messages and artifacts are text or downloaded attachments. The API sends `nosniff` and an attachment disposition. The UI does not parse message HTML. |
| XSS                           | React text rendering. API CSP is `default-src 'none'` on Worker responses. The SPA CSP is the Vite host's responsibility at deploy time.              |
| CSRF                          | Bearers are not cookies.                                                                                                                              |
| CORS                          | Exact origin match. Other origins are rejected before the route.                                                                                      |
| Redirects                     | The application does not redirect to a client-supplied URL.                                                                                           |
| Payload and page limits       | JSON bodies are capped. Page size is at most 50. Anonymous join and control-plane mutations are rate limited.                                         |
| Agent text as authority       | Chat text is stored as a message. It is not parsed as a command.                                                                                      |

F3 in the C1 operator trust model remains `UNRESOLVED_MEDIUM`. This milestone does not accept F3, F4, or F5.
