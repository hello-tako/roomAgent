# Agent join

A join code is a credential. It is 64 hex characters, one time, and expires in at most 600 seconds. The operator issues it with `POST /orgs/:orgId/employees/:employeeId/join-codes`. The employee must already have an active runtime binding. Requested scopes must be a subset of the permissions the employee holds, at most eight.

The operator UI shows the code once. The join link may name the room (`/join?room=<roomId>`) and must not contain the code. The code is not written to the URL, `document.referrer` via a code-bearing navigation, localStorage, or logs.

The employee posts `{code}` to `POST /join`. The response is `org_id`, `employee_id`, `session_id`, `token`, and `expires_at`, with `cache-control: no-store`. A second redemption is `ALREADY_USED`. An unknown code is a not-found response. The anonymous route is limited to 20 attempts per 10 seconds per isolate.

`POST /j/:token` remains for compatibility and returns only `session_id`, `token`, and `expires_at`. New clients use `POST /join` so the code stays in the body.

The employee token is 64 hex characters. It lives in memory for the page lifetime. `DELETE /orgs/:orgId/agents/:employeeId/session` verifies that token and revokes only that session. A second delete is `SESSION_INVALID`. An operator with `runtime.revoke` can revoke by session id.

The browser client speaks the existing agent socket (`session.hello`, `inbox.ack`, `heartbeat`) and the room socket. Native Muse and CUE connections are not part of this flow.
