# Stage C pull request review package

Evidence level: the diff is local until the branch is pushed. CI_CERTIFIED and independent approval are not claimed in this file. Record the GitHub check run on the final head. A later commit would move that head and needs a new check.

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
- Remote apply needs `remoteAuthorized`, which the test harness cannot set.
- The approval secret is not committed. Wrangler vars must not contain `BOOTSTRAP_APPROVAL_DIGEST` or `TEST_MIGRATIONS`.
- One D1 batch creates the user, organization, seven role templates, and one identity. A conflict writes nothing and deletes nothing.
- Same email with a different subject does not attach a second owner.
- Employees are not granted owner or `workflow.approve` for the smoke.
- Workflow start goes through `POST /orgs/:orgId/tasks/:taskId/workflow-runs`. A second key does not clear a hold. The smoke expects the run status not to be `complete`.
- `apps/api/wrangler.jsonc` is untouched. Migrations `0001`–`0015` are untouched.
- No JWT, session token, join code, or real operator email is in the diff.

## Reviewer

Requested reviewer: `vn-taphoanhatung`.

GitHub reports that account's repository permission as `read`. Rulesets on the repository returned an empty list. Branch protection returned HTTP 404 to the pushing token, so a hidden admin rule is not visible from here. A read-only review may be a comment rather than a merge-approving review. This branch does not change branch protection or collaborator permission. If the human owner requires a write collaborator, they name that reviewer. The implementing account does not approve its own pull request.

## Not in this package

No merge commit. No exact-main certification. No Worker deploy. No remote D1 write.
