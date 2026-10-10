# Stage C failure and recovery

Evidence level: the stop conditions are implemented in local guards. Remote recovery is NOT_TESTED and is not authorized.

## Stop without retry

```text
REPOSITORY_ID_MISMATCH
UNEXPECTED_MAIN_DRIFT
PROTECTED_PUBLIC_WORKER_TARGETED
CLOUDFLARE_ACCOUNT_MISMATCH
D1_DATABASE_UUID_MISMATCH
SCHEMA_DRIFT
MIGRATION_LEDGER_DRIFT
UNREVIEWED_CODE_DEPLOYMENT
INDEPENDENT_REVIEW_MISSING
MERGE_APPROVAL_MISSING
DEPLOYMENT_APPROVAL_MISSING
IDENTITY_ATTESTATION_MISSING
BOOTSTRAP_APPROVAL_MISSING
UNAUTHORIZED_OWNER_CREATION
TENANT_ISOLATION_FAILURE
WORKFLOW_GOVERNANCE_BYPASS
ARTIFACT_IMMUTABILITY_FAILURE
UNEXPECTED_PUBLIC_ACCESS
UNRELATED_RESOURCE_MUTATION
UNEXPECTED_PRODUCTION_MUTATION
BOOTSTRAP_STATE_CONFLICT
```

## If a remote bootstrap fails later

1. Keep the evidence of the target ids, the plan digest, and the error code.
2. Do not retry a write that may have partially landed unless a fresh inspect shows the same plan is `PLAN_READY` or already `VERIFIED`.
3. Do not delete the user, organization, identity, audit rows, or artifacts.
4. Do not reset D1, restore Time Travel, purge queues, or delete Durable Object namespaces.
5. Do not change branch protection.
6. A conflict stays a conflict until a human owner chooses a reconciliation pull request.

A repeated identical plan against a consistent organization returns `VERIFIED` with zero writes. That is the only automatic recovery this code performs.

## Containment already in the tree

The operator script has no remote write path. The Worker route 404s when the staging flag is absent, which is the public Wrangler file. The route 403s when the pinned vars are not the staging constants. `applyStagingBootstrap` rejects the public database before `db.batch`.
