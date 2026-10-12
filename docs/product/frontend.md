# Frontend structure

The operator application lives in `apps/web` (`@ai-company/web`).

```text
src/main.tsx            React root, query client, theme
src/app.tsx             routes
src/session.ts          in-memory human and employee bearers
src/api.ts              typed Worker client
src/pages/              one screen per route
src/styles.css          light and dark themes
e2e/                    Playwright
```

Vite serves the application and proxies `/orgs`, `/join`, `/j`, `/health`, `/local`, and `/access` to the local Worker, including room and agent WebSockets. The browser stays on one origin.

TanStack Query loads reads. Mutations send a fresh idempotency key and are not retried. Reads may retry a network failure or HTTP 503 at most twice and honor the query abort signal.

Human and employee tokens stay in module memory. A reload requires a new sign-in or a new join. The theme choice is the only localStorage value.

Screens:

| Route                                 | Purpose                                             |
| ------------------------------------- | --------------------------------------------------- |
| `/`                                   | Access continuation and the local fixture           |
| `/expired`, `/unauthorized`, `/error` | Session and failure states                          |
| `/orgs/:orgId`                        | Dashboard                                           |
| `/orgs/:orgId/admin`                  | Employees, roles, departments, bindings, join codes |
| `/orgs/:orgId/rooms`                  | Directory, search, creation                         |
| `/orgs/:orgId/rooms/:roomId`          | Messages, presence, members                         |
| `/orgs/:orgId/tasks`                  | Board over authoritative states                     |
| `/orgs/:orgId/tasks/:taskId`          | Task detail and commands                            |
| `/orgs/:orgId/artifacts`              | List and upload                                     |
| `/orgs/:orgId/artifacts/:artifactId`  | Version, reviews, download                          |
| `/orgs/:orgId/governance`             | Workflows and approvals                             |
| `/orgs/:orgId/audit`                  | Audit events                                        |
| `/join`                               | Employee join code redemption                       |
| `/agent`                              | Employee room and inbox                             |

Buttons for privileged actions render only when `/me` lists the permission. The Worker still decides. Message and artifact text is rendered as text.
