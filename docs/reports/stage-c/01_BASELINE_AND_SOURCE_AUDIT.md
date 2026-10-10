# Stage C baseline and source audit

Evidence in this file is VERIFIED for repository identity and the source that was read.
Local test results are in [04_LOCAL_TEST_RESULTS.md](04_LOCAL_TEST_RESULTS.md).
Nothing here is DEPLOYED or REMOTE_TESTED.

## Repository authority

```text
REPOSITORY_AUTHORITY_VERIFIED
repository_id = 1410359112
repository = takovn2/roomAgent
default_branch = main
baseline_main_sha = 3528f923692b53c80559ba55a7101773e9a8bd1b
parent = 6cf1db7a5c014296c432963ec0559334a7f83ae2
feature_branch = feat/stage-c-bootstrap-smoke-v1
open_pull_requests_at_audit = none
rulesets = 0
branch_protection = HTTP 404 for the current token
baseline_ci = 38088977760 success
```

`origin/main` was still that SHA when the branch was cut. The working tree was clean at checkout.

## Two Workers

The public Worker stays protected. This branch does not edit `apps/api/wrangler.jsonc`, does not name that Worker as a deploy target, and rejects its database id in the bootstrap planner.

| Worker                      | Hostname                   | Last uploaded version                  | D1                                                                                   |
| --------------------------- | -------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `ai-company-os-api`         | `ai.tungjp.store`          | `a7acb953-ebae-46f8-9757-841100e121be` | `ai-company-os` `a4b622e6-978b-4ce2-ad82-cd0eb1cc4387`, migrations 0001–0010         |
| `ai-company-os-api-staging` | `api-staging.tungjp.store` | `3aeb3cbc-0f44-470c-af2c-30ab64d1bc55` | `ai-company-os-staging` `a6b8c2f6-d697-442b-8374-5006246324b2`, migrations 0001–0015 |

The staging version above was uploaded before this branch. It does not contain the Stage C route. Deploying it is a later human gate. Account `ef250a88911fd24073cb73d1c07e0218` is the pinned staging account. This audit did not mutate Cloudflare.

## What the source already did

`FoundationStore.createHumanUser` inserts one user. `createOrganization` inserts the organization and the seven system role templates in one D1 batch. `POST /orgs/:orgId/human-sessions` verifies an Access JWT, looks up `human_identities` by issuer and subject, and asks OrganizationDO for an owner session. That route requires the organization and the mapping to exist already. It does not create them.

Access verification is RS256 against the team JWKS. It checks issuer, audience, expiration, not-before, token type `app`, and the verified email and subject. `Cf-Access-Authenticated-User-Email` is not an identity. Sessions last at most 900 seconds. The stored value is a hash. Audit rows are append-only. Identity issuer, subject, email, user, and attestation reference are immutable. Status may become `disabled`. Rows are not deleted.

OrganizationDO is the authority check. `workflow.start` is an alias of `task.assign`. Workflow instances start only through `POST /orgs/:orgId/tasks/:taskId/workflow-runs`, which writes `workflow_start_claims` before `create()`. TaskDO owns task transitions. ArtifactDO owns immutable versions. Queue consumers insert `domain_events` with `ON CONFLICT(event_id) DO NOTHING`.

Migrations `0001` through `0015` are unchanged. This branch adds no migration `0016`.

## Gap closed on this branch

The first owner, organization, and Access mapping could not be created by the human-session route. The branch adds one staging-pinned D1 batch for those three records, local smoke that starts from that batch, and a plan-only operator script. The script does not write remote D1.
