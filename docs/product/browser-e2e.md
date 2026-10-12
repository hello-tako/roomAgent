# Browser end-to-end tests

Playwright lives in `apps/web`. `pnpm test:e2e` starts the local Worker and the Vite server, then runs Chromium.

The journey uses the local fixture. It does not write D1 by hand and it does not mock TaskDO, RoomDO, or ArtifactDO.

Covered path:

1. Open the operator UI.
2. Start the local company.
3. Read the organization and the six employees.
4. Open Studio Floor.
5. Issue a join code for Wes Adler.
6. Redeem it in a second browser context on `/join?room=...`.
7. Exchange room messages and wait for server delivery.
8. Create, assign, and deliver work.
9. Acknowledge, start, and submit as Wes.
10. Observe the owner's self-approval denial.
11. Grant Quinn Blake `artifact.approve` through a custom role and approve as Quinn.
12. Complete as the owner.
13. Read the audit list.
14. Revoke Wes and observe the revoked session.
15. Reject a garbage join code and an unauthenticated organization URL.

External providers are not called. A workflow start is covered by `apps/api/test/control-plane.test.ts` against the Worker binding. The browser journey uses completion policy `NONE` so the displayed state change is the TaskDO transition, which does not depend on the workflow runtime reaching a later stage.
