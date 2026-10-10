# Stage C staging deployment plan

Evidence level: NOT_DEPLOYED. The dry-run in [04_LOCAL_TEST_RESULTS.md](04_LOCAL_TEST_RESULTS.md) is LOCALLY_TESTED only.

## Why a later deploy is required

This branch adds `POST /operator/staging-bootstrap` and staging vars. The Worker uploaded as `3aeb3cbc-0f44-470c-af2c-30ab64d1bc55` does not contain that route. `DEPLOY_NOT_REQUIRED` does not apply after merge. Deploy still waits for a separate human approval after exact-main CI is green.

## Gate D1 manifest, not yet approved

```text
ACTION = DEPLOY_ROOMAGENT_STAGE_C_STAGING_WORKER
repository_id = 1410359112
deployment_sha = exact certified merge SHA, not known yet
Cloudflare_account_id = ef250a88911fd24073cb73d1c07e0218
Worker = ai-company-os-api-staging
config = apps/api/wrangler.staging.jsonc
D1_database_id = a6b8c2f6-d697-442b-8374-5006246324b2
Access_hostname = api-staging.tungjp.store
current_worker_version = 3aeb3cbc-0f44-470c-af2c-30ab64d1bc55
proposed_worker_version = assigned by Cloudflare at deploy time
```

Forbidden target:

```text
Worker = ai-company-os-api
hostname = ai.tungjp.store
config = apps/api/wrangler.jsonc
D1 = a4b622e6-978b-4ce2-ad82-cd0eb1cc4387
```

## Expected side effects after an approved deploy

A new version of `ai-company-os-api-staging` on the existing hostname. Same D1, R2, queues, Durable Object classes, and workflow binding. New plain-text vars pin the staging account and database and set `STAGING_OPERATOR_BOOTSTRAP` to `enabled`. No new route is created by this plan. Access application `8a141d2f-91a5-4cfc-bc8d-33aedfcec070` is not modified. MFA is not modified. The approval digest secret is not set by the deploy file. Without that secret the route cannot write.

## Rollback limit

Cloudflare can serve a previous version only after a separate approval. This plan does not delete the Worker, the Durable Object namespaces, queues, or R2 objects, and it does not roll back D1.

## Preflight before that deploy

Read-only checks, after merge certification: account id, Worker name, current version, Access hostname, D1 uuid, migration ledger `0001`–`0015`, R2 binding, Durable Object classes, workflow binding, queue names, and absence of the public database id in the staging config. No remote mutation in that preflight.
