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

On the Worker, the header `x-bootstrap-approval-digest` must equal that digest. Remote staging also requires the Worker secret `BOOTSTRAP_APPROVAL_DIGEST` to equal the same digest. The secret is not in git and is not in Wrangler vars. A `--yes` flag is not authorization. The operator script never calls the route. Its mutation commands return `REMOTE_MUTATION_REQUIRES_HUMAN_GATE` or an earlier deny, and `remote_writes` stays 0.

Vitest sets `TEST_MIGRATIONS`. In that harness the route may apply a `local-simulator` plan when the header digest matches. It still verifies the Access JWT. It cannot set `remoteAuthorized`. `TEST_MIGRATIONS` in a Wrangler var file fails the operator inspect.

## Idempotency

The identity key is the existing unique pair `(issuer, subject)`, plus unique `(issuer, email)`. A repeat of the same plan returns `VERIFIED` with `writes: 0` when that mapping is active, the attestation reference matches, and exactly one organization of the approved name was created by that user with seven system roles.

Same email and a different subject is `IDENTITY_MISMATCH` and writes nothing. An organization name already owned by someone else is `BOOTSTRAP_STATE_CONFLICT`. A disabled identity is `IDENTITY_DISABLED` and is not re-enabled. An attestation mismatch is `ATTESTATION_CONFLICT`. Unclear ownership is a conflict. The code does not delete rows, does not add a second owner, and does not rewrite audit records.

## What a later remote apply may write

One human user, one organization, seven system roles and their existing permission templates, and one identity mapping. No second remote tenant. No employee, room, task, artifact, queue message, or workflow. Those belong to a separate Stage C2 gate.
