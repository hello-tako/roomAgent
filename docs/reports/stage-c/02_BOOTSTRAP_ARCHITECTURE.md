# Stage C bootstrap architecture

Evidence level: LOCALLY_TESTED for the batch and the route guards. NOT_TESTED on remote D1. Not DEPLOYED.

## Decision

The first organization is created by an operator-controlled staging path, not by a public admin route.

`FoundationStore.createHumanUser` and `createOrganization` are separate D1 calls. A failure between them would leave a user without an organization. Remote `wrangler d1 execute` would also skip the role-template invariant. This branch does not use either shortcut.

`packages/db/src/staging-bootstrap.ts` copies the organization and role-template SQL into one `db.batch` with the human user and the `human_identities` row. D1 batch is the atomicity boundary. The states `USER_CREATED`, `ORGANIZATION_CREATED`, and `IDENTITY_MAPPED` are not committed separately. A failed batch rolls back. The outcome is either `VERIFIED` or a conflict/denial with `writes: 0`.

There is no public `/admin/bootstrap`. The Worker route is `POST /operator/staging-bootstrap`. It returns 404 unless `STAGING_OPERATOR_BOOTSTRAP` is exactly `enabled`. That variable is set only in `apps/api/wrangler.staging.jsonc` and in the API Vitest bindings. `apps/api/wrangler.jsonc` does not set it.

## Target pins

The plan must say `environment = staging`, the staging account id, schema version `0015`, and a 40-character repository SHA. Remote execution also requires database id `a6b8c2f6-d697-442b-8374-5006246324b2`, database name `ai-company-os-staging`, and organization name `roomAgent Staging Smoke`.

These targets are rejected before any write:

- Public database id `a4b622e6-978b-4ce2-ad82-cd0eb1cc4387`
- Public database name `ai-company-os`
- Placeholder id `00000000-0000-4000-8000-000000000001`
- A local-simulator plan that uses the real staging database id or any name other than `local-simulator`
- A remote plan whose organization name is not `roomAgent Staging Smoke`

The route also requires the Worker vars `STAGING_ACCOUNT_ID`, `STAGING_DATABASE_ID`, and `STAGING_DATABASE_NAME` to equal those staging constants. The var pin does not read the live binding uuid back from Cloudflare. The Wrangler `d1_databases` id is checked by `scripts/staging_bootstrap.py` and by `scripts/d1_preflight.py` before a deploy. A config that points the binding at the public database fails those checks.

## Approval

`applyStagingBootstrap` refuses to write unless the caller passes the SHA-256 of the canonical plan JSON. Canonical form sorts keys and stringifies values with `JSON.stringify`.

Remote staging needs three independent pins, all set as Worker secrets and absent from Wrangler vars:

- Header `x-bootstrap-approval-digest` equals the plan digest.
- Secret `BOOTSTRAP_APPROVAL_DIGEST` equals that same digest, so a different plan is rejected.
- Header `x-bootstrap-approval-token` equals secret `BOOTSTRAP_APPROVAL_TOKEN`, a random 64-hex value. If that secret equals the plan digest, the route returns `APPROVAL_TOKEN_DERIVED`.

Knowing the plan is enough to recompute the digest. It is not enough to recompute the token. Replaying the same plan stays possible until those secrets are deleted. That replay is idempotent: a matching organization returns `VERIFIED` with `writes: 0`. There is no migration that consumes the token.

Remote apply also requires `STAGING_RUNTIME=cloudflare`, `independentApproval`, and `STAGING_RELEASE_SHA` equal to `plan.repositorySha`. The release SHA is a deploy-time secret. It is not hardcoded and it is not committed.

`STAGING_OPERATOR_BOOTSTRAP` stays `enabled` in the staging config so a later approved deploy can run the one bootstrap. After the outcome is `VERIFIED`, remove that var and delete `BOOTSTRAP_APPROVAL_TOKEN`, `BOOTSTRAP_APPROVAL_DIGEST`, and `STAGING_RELEASE_SHA`. The route then returns 404. The response field `retirement` states that plan. `database_binding_checked_by_route` is false: the route checks the pinned vars, and the deploy preflight checks the D1 binding uuid and account.

A `--yes` flag is not authorization. The operator script never calls the route. Its mutation commands return `REMOTE_MUTATION_REQUIRES_HUMAN_GATE` or an earlier deny, and `remote_writes` stays 0.

## Harness isolation

Vitest may apply a `local-simulator` plan only when all three are true: `TEST_MIGRATIONS` is present, `BOOTSTRAP_LOCAL_HARNESS` is `vitest`, and `STAGING_RUNTIME` is not `cloudflare`. The staging config sets `STAGING_RUNTIME` to `cloudflare`, so those test bindings cannot skip the approval token on a staging deploy. `isTestHarness()` itself is unchanged and still means `"TEST_MIGRATIONS" in env`. The operator inspect rejects `TEST_MIGRATIONS`, `BOOTSTRAP_LOCAL_HARNESS`, `BOOTSTRAP_APPROVAL_TOKEN`, `BOOTSTRAP_APPROVAL_DIGEST`, and `STAGING_RELEASE_SHA` inside Wrangler vars.

## Verification after the batch

Before a write, inspect compares `d1_migrations.name` ordered by id with the fifteen filenames `0001` through `0015`. A short ledger is `SCHEMA_INCOMPLETE`, a different name is `SCHEMA_MISMATCH`, and an extra row is `SCHEMA_DRIFT`. A query failure is treated as an empty ledger.

After a successful batch, inspect runs again. `VERIFIED` requires seven system roles whose permission codes match `ROLE_TEMPLATES`. A count mismatch is `ROLE_TEMPLATE_CONFLICT`. A permission mismatch is `ROLE_PERMISSION_CONFLICT`. The code does not delete rows to repair either case.

## Idempotency

The identity key is the existing unique pair `(issuer, subject)`, plus unique `(issuer, email)`. A repeat of the same plan returns `VERIFIED` with `writes: 0` when that mapping is active, the attestation reference matches, exactly one organization of the approved name was created by that user, and the seven system roles have the template permission sets.

Same email and a different subject is `IDENTITY_MISMATCH` and writes nothing. An organization name already owned by someone else is `BOOTSTRAP_STATE_CONFLICT`. A disabled identity is `IDENTITY_DISABLED` and is not re-enabled. An attestation mismatch is `ATTESTATION_CONFLICT`. Unclear ownership is a conflict. The code does not delete rows, does not add a second owner, and does not rewrite audit records.

## What a later remote apply may write

One human user, one organization, seven system roles and their existing permission templates, and one identity mapping. No second remote tenant. No employee, room, task, artifact, queue message, or workflow. Those belong to a separate Stage C2 gate.
