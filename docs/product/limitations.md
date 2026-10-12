# Known limitations

- No production or staging deploy is included. Live Workers and D1 databases are unchanged.
- Human sessions can be issued only to the organization creator because migration `0011` trigger `human_session_owner` rejects other users. A future migration is required before a second human operator can sign in. That migration is intentionally not in this milestone.
- The owner has every catalog permission. Other humans cannot authenticate against an organization. Permission-denied screens still apply to employees, self-approval, role conflicts, and cross-tenant tokens.
- Suspension is one way. There is no unsuspend RPC.
- Dashboard "online" is an unexpired, unrevoked `runtime_sessions` row. It is not the RoomDO presence snapshot. Room presence remains on the room screen.
- A reload drops human and employee bearers.
- `POST /j/:token` still accepts a code in the URL for older clients.
- Native Muse and CUE adapters are not implemented. No provider password is stored.
- Workflow completion inside the browser test stops at a created run. The Worker integration test asserts the start response. Waiting for every workflow stage under `wrangler dev` is not the certification path.
- The local fixture creates a new organization for each new idempotency key, at most 10 times a minute in one isolate.
- F3 remains `UNRESOLVED_MEDIUM`.
- This source milestone is not `ROOMAGENT_PRODUCT_MVP_V1_PRODUCTION_CERTIFIED` and not a staging deployment.
