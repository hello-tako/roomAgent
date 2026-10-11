# C1-A2 implementation handoff — independent review required

Repository: `takovn2/roomAgent` (ID `1410359112`). Implementation branch: `fix/roomagent-c1-a2-security-hardening`.
Worker source/baseline main: `3909fada8747ae27ea71daf6da9481a7eb8d9eff`. Original handoff: `6fac326a7fd3f504a51c23372485af252012e2c8`.
The exact implementation SHA and CI run/job IDs are supplied in the pull request after commit. They are not the Worker release SHA.

This is an implementation package, **not GATE B approval, mutation authority, or live runtime certification**. Only the human owner may authorize a future operation after Muse's exact-source review. No real approval record, credential, identity record, marker, or receipt is included.

## Read and verify

- [Security findings and implementation evidence](../../docs/reports/stage-c/C1_A2_SECURITY_HARDENING_REPORT.md).
- [Independent review instructions and threat matrix](../../docs/reports/stage-c/C1_A2_INDEPENDENT_REVIEW_PACKAGE.md).
- [Operator contract and recovery](20_A2_EXECUTION_PACKAGE.md).
- `operator/SHA256SUMS`: every public operator file plus the W1 template, excluding itself. Paths are relative to this bundle root.
- `BUNDLE_SHA256SUMS`: every public bundle file, including the inner manifest, excluding itself. Only `operator/private/` runtime inputs are excluded.

From the repository root (Node >=22, frozen lockfile):

```bash
pnpm install --frozen-lockfile
pnpm test:operator
node handoff/c1-a2/operator/secret-safety.mjs
node handoff/c1-a2/operator/c1-runner.mjs --verify-bundle
```

For conventional checksum tools, change into `handoff/c1-a2` before checking **either** manifest:

```bash
sha256sum -c operator/SHA256SUMS
sha256sum -c BUNDLE_SHA256SUMS
```

A consistency result is explicitly **NOT_APPROVED**. An owner must obtain the trusted outer-manifest digest and exact implementation SHA independently from the reviewed commit, not regenerate them locally and call that approval.

## Private inputs and supported runtime

Default `--dry-run` / `--prepare` is offline and requires the owner's excluded private plan and identity record. The public `--verify-bundle` mode needs neither private inputs nor credentials. All automated tests use local keys, dummy credentials, temporary directories and mocked endpoints; no Cloudflare account calls are made.

Actual execution requires a canonical Git checkout of the reviewed commit, POSIX no-follow/exclusive-create/directory-fsync support, a 0700 owner-private directory, 0600 owner-private regular input files, independently pinned Node/git/cloudflared paths, executable SHA-256 and exact versions, and an interactive TTY. The approval template remains **PENDING**. Do not run `--execute` during this implementation assignment.

The original 13-test snapshot in `HANDOFF_META/OFFLINE_TEST_RESULT.txt` is historical evidence only, not validation of this changed package.
