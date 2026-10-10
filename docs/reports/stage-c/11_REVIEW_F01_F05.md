# Stage C review findings F01–F05

Evidence level: remediated in the working tree of `feat/stage-c-bootstrap-smoke-v1` and covered by local regression tests. Not an independent APPROVED review. Not a merge approval. Not deployed.

The reviewed candidate before this remediation was `268cda8558a817571091c1e89830f1294de98928`. That commit stays in history. These fixes are a new commit. An approval of the old head does not apply.

## F01 — Bootstrap endpoint lifecycle

`STAGING_OPERATOR_BOOTSTRAP` stays `enabled` in `apps/api/wrangler.staging.jsonc`. Removing it in git before the approved bootstrap deploy would make that deploy unable to call the route. The route response includes `retirement`: after `VERIFIED`, remove the var and delete `BOOTSTRAP_APPROVAL_TOKEN` and `BOOTSTRAP_APPROVAL_DIGEST`. Until the var is removed, the route still answers. Once the secrets are deleted, a Cloudflare runtime cannot write, because the Vitest harness is disabled when `STAGING_RUNTIME` is `cloudflare`.

## F02 — Approval authorization

The old check stored the plan digest in `BOOTSTRAP_APPROVAL_DIGEST`. Anyone who could read the plan could recompute that secret. The route now also requires `BOOTSTRAP_APPROVAL_TOKEN`, a random 64-hex secret delivered in `x-bootstrap-approval-token`. The token must not equal the plan digest. The digest secret remains a pin for one exact plan. Replay of that same plan is still possible until the secrets are deleted, and that replay writes nothing when the organization already matches. No migration records token consumption. Migrations `0001`–`0015` are unchanged.

## F03 — Verification integrity

Remote apply denies `RELEASE_SHA_NOT_PINNED` or `RELEASE_SHA_MISMATCH` unless `STAGING_RELEASE_SHA` is 40 hex and equals `plan.repositorySha`. The accepted SHA is a deploy secret, not a constant in source. Inspect requires `d1_migrations.name` to equal the fifteen migration filenames in order. A repeat inspect requires each system role's permission codes to match `ROLE_TEMPLATES`. The first successful batch is read back before the response says `PROVISIONED`.

## F04 — Test-harness isolation

`isTestHarness()` is still `"TEST_MIGRATIONS" in env`. The bootstrap route does not treat that alone as approval. `bootstrapHarnessAllowed` also requires `BOOTSTRAP_LOCAL_HARNESS=vitest` and `STAGING_RUNTIME` other than `cloudflare`. Staging config sets `STAGING_RUNTIME` to `cloudflare`. Python inspect rejects the harness markers and the approval secrets in vars.

## F05 — Database binding isolation

The route pins `STAGING_ACCOUNT_ID`, `STAGING_DATABASE_ID`, and `STAGING_DATABASE_NAME`. It reports `database_binding_checked_by_route: false` because a Worker does not expose the live D1 binding uuid. `scripts/d1_preflight.py` and `scripts/staging_bootstrap.py` check the account id and the `d1_databases` uuid against the staging pins, and they fail when the var and the binding diverge. A config whose vars name the staging database while the binding names the public database is rejected. This check does not deploy and does not query live D1.

## Reviewer

`vn-taphoanhatung` remains the preferred independent reviewer. Formal `requested_reviewers` returned HTTP 422. That account submitted APPROVED reviews on pull request 4 with read permission, and no visible ruleset requires write. This repository's permissions are unchanged. `vn-tak` does not approve pull request 5.
