# Stage C pull request review package

Evidence level: pull request 5 is open. CI on `268cda8558a817571091c1e89830f1294de98928` does not certify a later head. Independent approval is not claimed. Record the GitHub check run on the final head. A later commit moves that head and needs a new check and a new review.

## Branch

```text
repository_id = 1410359112
repository = takovn2/roomAgent
base = main
baseline_main_sha = 3528f923692b53c80559ba55a7101773e9a8bd1b
head_branch = feat/stage-c-bootstrap-smoke-v1
merge = not performed
```

Suggested title: `feat(stage-c): safe staging bootstrap and governed smoke harness`.

## What a reviewer should check

- Bootstrap authentication uses `verifyAccessJwt`. The email header is not accepted.
- The client cannot send an owner id.
- Public database id, public database name, and the placeholder id are denied.
- Local simulator cannot target the real staging database id.
- Remote apply needs `remoteAuthorized`, `independentApproval`, and `STAGING_RELEASE_SHA` equal to `plan.repositorySha`. The test harness cannot set that remote gate.
- The approval token is independent of the plan digest. Wrangler vars must not contain `BOOTSTRAP_APPROVAL_DIGEST`, `BOOTSTRAP_APPROVAL_TOKEN`, `STAGING_RELEASE_SHA`, `TEST_MIGRATIONS`, or `BOOTSTRAP_LOCAL_HARNESS`.
- `STAGING_RUNTIME=cloudflare` disables the Vitest harness. A staging var that names the staging database while the D1 binding names another database fails preflight.
- The migration ledger must be the fifteen filenames `0001`–`0015`. System-role permission sets must match `ROLE_TEMPLATES`.
- After `VERIFIED`, remove `STAGING_OPERATOR_BOOTSTRAP` and delete the approval and release secrets. The flag stays enabled in git until that operational step.
- One D1 batch creates the user, organization, seven role templates, and one identity. A conflict writes nothing and deletes nothing.
- Same email with a different subject does not attach a second owner.
- Employees are not granted owner or `workflow.approve` for the smoke.
- Workflow start goes through `POST /orgs/:orgId/tasks/:taskId/workflow-runs`. A second key does not clear a hold. The smoke expects the run status not to be `complete`.
- `apps/api/wrangler.jsonc` is untouched. Migrations `0001`–`0015` are untouched.
- No JWT, session token, join code, or real operator email is in the diff.

## Reviewer eligibility

Preferred reviewer: `vn-taphoanhatung`. Permission observed for that account: `read` (`pull` true, `push` false). `author_association` on earlier reviews was `NONE`. This branch does not change branch protection or collaborator permission.

Three separate facts:

1. A formal review request is rejected. `POST /repos/takovn2/roomAgent/pulls/5/requested_reviewers` returned HTTP 422, “Reviews may only be requested from collaborators.” Do not retry that call.
2. That account can submit an approving review itself. Pull request 4 received APPROVED reviews `5478570269` and `5478603547` from `vn-taphoanhatung` on head `6f5a9d118e734e7e95e78f3b97b90a0ba0d477f8`, and the human owner merged that pull request.
3. No visible ruleset requires a write-level reviewer. Repository rulesets returned `[]`. Branch protection returned HTTP 404 to this token. Pull request 4 merged with an empty `reviewDecision`. The human owner already accepted that review style. A permission upgrade is not requested.

The implementing account `vn-tak` does not approve this pull request. An approval of an older head does not cover a newer head.

CI runs `38090874826` and `38090882679` succeeded for `268cda8558a817571091c1e89830f1294de98928` only.

## Not in this package

No merge commit. No exact-main certification. No Worker deploy. No remote D1 write.
