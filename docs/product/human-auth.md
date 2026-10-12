# Human authentication

Production entry is Cloudflare Access on the application host. The Worker does not implement a password form and does not accept a login bypass.

1. Access injects `cf-access-jwt-assertion`.
2. `GET /access/organizations` verifies the assertion and returns the active organizations created by the mapped user. The response has id, name, and status. It has no email, subject, or token.
3. `POST /orgs/:orgId/human-sessions` verifies the assertion again, resolves the operator-provisioned identity, and asks OrganizationDO for a session.
4. The response bearer is `hum_` plus 64 hex characters, with a 900 second lifetime.
5. The browser keeps the bearer in memory and sends `Authorization: Bearer`.
6. `DELETE /orgs/:orgId/human-sessions/current` revokes that session.
7. Room sockets call `humanSessionOpen` on later commands and close with `session.revoked` when the session is gone.

Identity failures use `ACCESS_IDENTITY_INVALID`, `IDENTITY_NOT_MAPPED`, `IDENTITY_MISMATCH`, and `IDENTITY_DISABLED`. Missing Access configuration uses `BOOTSTRAP_NOT_CONFIGURED` and HTTP 503.

The local fixture calls the trusted `issueHumanSession` RPC and returns the owner bearer once. That route is not registered for other hostnames and is absent unless `LOCAL_PRODUCT_FIXTURE=enabled`.

Migration `0011` trigger `human_session_owner` inserts a human session only when `user_id` is `organizations.created_by_user_id`. A second human operator cannot receive a session until a later migration. This milestone does not add that migration. Non-owners are denied at session issue. Employees are not given human bearers.

Cookie authentication is not used, so browser mutations do not rely on a CSRF cookie. Cross-origin requests need an `Origin` equal to `WEB_ORIGIN` or one of the two loopback Vite origins. A missing `Origin` is allowed for same-origin and test clients. Any other origin is `ORIGIN_REJECTED`.
