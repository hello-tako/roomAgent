# Stage C synthetic execution plan

Evidence level: NOT_TESTED on remote staging. Local smoke is LOCALLY_TESTED in `apps/api/test/stage-c-smoke.test.ts`. No remote approval has been requested by running these commands. The operator script refuses them.

## C1, not approved

```text
ACTION = ROOMAGENT_STAGE_C1_SYNTHETIC_BOOTSTRAP
account_id = ef250a88911fd24073cb73d1c07e0218
database_id = a6b8c2f6-d697-442b-8374-5006246324b2
database_name = ai-company-os-staging
deployment_sha = certified staging Worker SHA, not deployed
synthetic_org_name = roomAgent Staging Smoke
identity_attestation_ref = supplied at approval time, not stored here
expected_D1_writes = one batch: 1 human user, 1 organization, 7 system roles, role permissions from the existing templates, 1 human_identities row
rollback_or_reconciliation_plan = stop on failure; do not delete partial rows; do not retry a non-idempotent write; a repeated identical plan is verify-only when the row is already consistent
```

Allowed remote rows at C1: one human owner, one organization, one identity mapping. No second tenant. No employee, room, task, artifact, queue message, or workflow.

The operator identity evidence stays outside git. The plan must include issuer, subject, email, `verification_source`, `attestation_ref`, and `approval_ref`. The JWT itself is not a repository artifact.

Human session smoke, only inside an approved C1 scope: `POST /orgs/:orgId/human-sessions` with a verified Access JWT. Expect 201, TTL at most 900 seconds, a hash in D1, and an audit row. Wrong organization, unmapped subject, and a revoked session must deny. The session token is not logged. Revoke through the existing route after the check.

## C2, not approved

```text
ACTION = RUN_ROOMAGENT_STAGE_C2_SYNTHETIC_BUSINESS_SMOKE
scope = 2 synthetic employees, 1 room, 1 task, 1 small artifact, 1 governed workflow
employees = role templates employee and qa, not owner
runtime = browser session, not Muse and not CUE
```

Order: employees and roles, room, join code, redeem, WebSocket, one room event, task create, assign, acknowledge, start, artifact version, submit for review, then workflow start through the HTTP route. Missing QA, security, or human evidence must leave the run short of completion. Unauthorized employee action, cross-tenant action, expired session, a second start key, a held-run bypass, and a wrong artifact version must deny. Do not start the workflow when the task is not in a legal pre-state.

Expected effects, only after approval: D1 rows for those entities, one RoomDO and the task and artifact objects for that organization, one R2 object, the domain events the existing consumers already emit, and one workflow instance. No load test. No automatic delete of the synthetic rows, audit rows, or artifact bytes.

## Script

```text
python3 scripts/staging_bootstrap.py inspect
python3 scripts/staging_bootstrap.py preflight
python3 scripts/staging_bootstrap.py plan
python3 scripts/staging_bootstrap.py verify
```

Those four commands are read-only. `apply-bootstrap`, `issue-session-smoke`, and `run-business-smoke` print `MUTATION_REFUSED` and exit 2. They do not shell out to Wrangler and they do not submit SQL.
