# Primary agent authority and risk ledger

Status: source follow-up for independent review. This ledger is not approval, not a Cloudflare mutation record, and not runtime certification.

## Verified authority

| Item                                       | Verified state                                                                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub actor                               | `hello-tako` (`336900841`), repository admin                                                                                                                                                                            |
| Repository                                 | `hello-tako/roomAgent`, immutable id `1410359112`                                                                                                                                                                       |
| Default branch                             | `main` at `628a002950f84bf847513b7d25f7d90ca9867dac`                                                                                                                                                                    |
| Open pull request                          | [#9](https://github.com/hello-tako/roomAgent/pull/9), draft, branch `fix/roomagent-c1-a2-security-hardening--review-follow-up`                                                                                          |
| PR #9 base                                 | `628a002950f84bf847513b7d25f7d90ca9867dac`                                                                                                                                                                              |
| PR #9 head before this follow-up           | `f55c525f33b0472559a34f7d69e460da2baea496`                                                                                                                                                                              |
| Prior approved review                      | PR #6 review `5481983056` on `f7e51422792f14609d710861bd802d4ec0e0d391` by `tako-vn1`. Attribution to `vn-taphoanhatung` remains `REVIEWER_ATTRIBUTION_PENDING_OWNER_CONFIRMATION`. That approval does not cover PR #9. |
| Collaborators                              | `hello-tako` admin; `takovn2` write; `vn-tak` write; `vn-taphoanhatung` (`329713999`) read                                                                                                                              |
| Branch protection                          | Not protected (HTTP 404). Rulesets: none. Environments: none.                                                                                                                                                           |
| CI                                         | `.github/workflows/ci.yml` (`379043649`), `contents: read`, job `check`                                                                                                                                                 |
| Committer identity used for this follow-up | Existing repository-local git identity. The pushing GitHub account is `hello-tako`.                                                                                                                                     |
| Cloudflare actions in this assignment      | NONE                                                                                                                                                                                                                    |

## Governance gaps (not applied)

`main` does not require a pull request, CI, a review, dismissal of stale approvals, or conversation resolution. Force-push and branch deletion are not blocked by GitHub rules. No environment protects deployment.

`vn-taphoanhatung` has read permission only. A required approving review cannot be satisfied by that account until the owner grants a permission that GitHub accepts for pull-request reviews. This follow-up does not grant permissions and does not change branch protection or environments.

## Checkpoint evidence

Issue #7 comment `6114695354` embeds one incremental Git bundle.

| Check                       | Result                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------- |
| Gzip SHA-256                | `7f16e080a174c1e7886171071a027f5c92b66b3cef79a7f07af931fabf4311e5`                      |
| Raw bundle length / SHA-256 | 25506 bytes / `31de21102231d7459575f90ace5ebbdac5fd3a76b9262e0cdf6ea5c29069ee33`        |
| `git bundle verify`         | OK. Requires base `628a002950f84bf847513b7d25f7d90ca9867dac`                            |
| Checkpoint commit / tree    | `b644cff7e63452102d3b13c596866fe745a88367` / `d29f89ff9a44a6c17e816c01aae1f9f041bcd4ed` |
| Adoption                    | Selective. The checkpoint commit was not cherry-picked.                                 |

Adopted from the checkpoint after comparison with PR #9:

- Unfloored millisecond attestation clock, `TOKEN_STALE` when age exceeds 900.000 seconds, and `assertAccessJwtTimeBounds`.
- Runner samples after fresh attestation, after the post-W2/D1/review delay, and synchronously immediately before the B1 `fetch`. No asynchronous work sits between that last sample and dispatch. Failure keeps the attempt marker. The token is not reacquired.
- Descriptor integrity: `O_NOFOLLOW|O_NONBLOCK`, bigint snapshots, ancestor rechecks, unsafe-mode rejection, and the checkpoint integrity tests.

Preserved from PR #9 and not replaced by the checkpoint:

- `Number.isSafeInteger` for `iat`. Fractional `iat` remains `TOKEN_ISSUED_AT_INVALID`.
- Parameterized `WHERE name = ?` and the non-string parameter rejection.
- `secret-safety.mjs` and its tests.
- `.prettierignore`.
- `apps/api/test/room-task-boundary.test.ts`.

## Risk ledger

| ID                                  | State                            | Note                                                                                                                                                                             |
| ----------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 JWT millisecond boundary         | SOURCE_REMEDIATED_PENDING_REVIEW | 900000ms is inside the inclusive window. 900001ms and 900999ms are stale. Flooring the clock is removed.                                                                         |
| F1 delay before B1                  | SOURCE_REMEDIATED_PENDING_REVIEW | Human confirmation, D1 reads, and review checks cannot skip the final pre-dispatch sample.                                                                                       |
| F2 descriptor race                  | SOURCE_REMEDIATED_PENDING_REVIEW | Leaf no-follow and ancestor snapshots are tested. This does not pin every ancestor descriptor and does not defeat same-UID or root swap-and-restore.                             |
| F3 same-UID marker replay           | UNRESOLVED_MEDIUM                | A same-UID owner or root can delete local attempt markers. No marker redesign and no forced retry were added.                                                                    |
| Checkpoint SQL interpolation        | REJECTED                         | Not merged.                                                                                                                                                                      |
| Checkpoint secret-scanner reduction | REJECTED                         | Not merged.                                                                                                                                                                      |
| Governance                          | OPEN                             | `main` is unprotected. `vn-taphoanhatung` cannot currently be a required approver.                                                                                               |
| Staging versus source               | NOT_RECERTIFIED                  | Historical staging Worker pin `3909fada8747ae27ea71daf6da9481a7eb8d9eff` is not current `main`. Issue #8 receipts are historical and do not authorize W1, W2, or B1.             |
| Production Worker                   | UNTOUCHED                        | No production deploy, secret, D1 write, Access change, or bootstrap.                                                                                                             |
| D1 compatibility                    | UNCHANGED_CONTRACT               | Organization-name counts stay bound parameters. The read-only SQL guard is unchanged. A client error without a D1 response remains an uncertain outcome and must not be retried. |
| Live product workflow               | NOT_STARTED                      | Stage 5 is outside this delivery.                                                                                                                                                |

## Manifests after this follow-up

- Operator manifest SHA-256: `3f93809a62fc8424caaccbe13ed6e393468b30e762f610bc28884be605755978`
- Bundle manifest SHA-256: `06aa52d6e96ad14fd82e875127c6b26f2a61286bae5e51c65c27b48eb28ef736`

`c1-runner.mjs --verify-bundle` returns `BUNDLE_CONSISTENT_NOT_APPROVED` for these hashes. Consistency is not owner approval.

Two local path-identity corrections are included so the same source runs on macOS and Linux. The CLI treats `/tmp` and `/private/tmp` as the same entry file by comparing real paths. The runner test copy excludes only `operator/private`, so a checkout under `/private/tmp` is not mistaken for private runtime input.

## No-mutation statement

This follow-up changes GitHub source on the existing PR #9 branch only. It does not deploy, write D1, set secrets, call bootstrap, change Access, or mutate the public Worker `ai-company-os-api`.
