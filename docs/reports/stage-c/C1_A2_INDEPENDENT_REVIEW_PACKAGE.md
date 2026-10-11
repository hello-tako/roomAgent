# C1-A2 independent review package — Muse

Status: implementation handoff only. **Review of the updated source and human mutation approval are PENDING.** The [Muse review](https://github.com/takovn2/roomAgent/pull/6#pullrequestreview-5481983056) approved the earlier `f7e5142` head; it is not approval of these follow-up changes. Hoplite is not the independent reviewer or production operator. No live runtime or production certification is issued.

## Exact evidence coordinates

Repository `takovn2/roomAgent`, ID `1410359112`; branch `fix/roomagent-c1-a2-security-hardening`. Baseline main/Worker source `3909fada8747ae27ea71daf6da9481a7eb8d9eff`; original handoff `6fac326a7fd3f504a51c23372485af252012e2c8`. The implementation SHA, PR URL, exact-head CI run/job IDs and conclusion are in the PR/final handoff after commit. This avoids self-referential commit/manifests. Review the commit, not a mutable branch label.

- Inner operator manifest SHA-256: `7ff9c4be0199fce8c6e2aac0af07d7c34e99306182fe4d1bdd983f40e4220197`.
- Outer bundle manifest SHA-256: `a0d8e31d1ccaea5ebbdb796e5080c209a3e578235b3b680e284e91052afcd79a`.
- Detailed findings, source functions, test counts and limitations: [hardening report](C1_A2_SECURITY_HARDENING_REPORT.md).
- Original main CI 38093203477 was SUCCESS; original handoff CI 38105477230 was FAILURE with later steps SKIPPED. Neither approves this new operator source.

## Follow-up review focus

Challenge the 900-second mandatory-`iat` freshness boundary, descriptor no-follow/type/inode checks and replacement cleanup, canonical private-path classification and real Git filename reads, and bound D1 organization-name parameters. The [review disposition ledger](C1_A2_SECURITY_HARDENING_REPORT.md#pr-6-independent-review-dispositions) accounts for every finding, including F3 and scanner limits that are documented, not eliminated. Review the changed exact head and new hashes; do not reuse the earlier approval.

## Reviewer source order

1. `handoff/c1-a2/operator/c1-runner.mjs`: argument modes; pre-credential approval/source gates; canonical 17-field plan; exact Cloudflare allowlists/result schemas/SQL guards; W1 live body/rechecks; W2 active/latest/deployment checks; B1 fresh attestation after confirmation; no-force/no-retry; sanitized failure/receipt and read-only reconciliation.
2. `bundle-integrity.mjs`: independently trusted outer digest, full implementation SHA, exact inner/outer coverage, private exclusion, traversal/duplicates/nonregular/symlink/ancestor rejection. Cross-check the runner's clean Git validation and repeated gates. Matching local manifests alone must not pass trusted approval.
3. `attempt-markers.mjs`: mode 0600, exclusive/no-follow, complete non-sensitive stage metadata, full-write/file-fsync/directory-fsync ordering, failure preservation, parent identity checks, legacy block and restart semantics.
4. `runtime-io.mjs`: 0700/0600 owner inputs, no symlinks/hard links, durable exclusive secret/receipt files, canonical allowed binary path/hash/version pins, clean actual Git source, shell-free isolated child, stdin JWT and nonzero/signal/timeout/output-cap handling.
5. `attest-access-identity.mjs`: pure RS256 verification and injected clock/JWKS; pinned issuer/aud/certs; exp/nbf/iat; human token type; public key constraints/kid/signature; exact subject and normalized email/hash; baseline identity file; private CLI paths/modes; no JWT/email/hash/private record in stdout/stderr.
6. `secret-safety.mjs`, ignore/config files and `.github/workflows/ci.yml`: already-tracked private artifacts, public credentials/identity/receipt detection, hash-only diagnostics, no test blanket exemptions, all suites/checksum gate, no deploy/continue-on-error/private dependencies.
7. All colocated `*.test.mjs`, `fixtures/bindings18.json`, W1 placeholder, PENDING owner template and both manifests. Verify the frozen fixture's DB binding targets the same staging D1 as REAL_CONFIG and the request preserves all 18 live non-secret bindings plus only 3 approved secrets.
8. Existing unchanged runtime `apps/api/src/staging-bootstrap-route.ts`, `access-jwt.ts`, `human-bootstrap-route.ts`, `packages/db/src/staging-bootstrap.ts` and staging config: confirm the backend independently validates Access assertion, plan/release/approval and domain boundaries. Production config/migrations were not changed.

## Threat matrix to reproduce

| Boundary            | Tests/assertions to challenge                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner approval      | absent/malformed/duplicate/unknown fields; wrong reference/digest/Worker SHA/account/Worker/D1/base; pending approval; wrong/missing external bundle digest/implementation SHA; non-TTY; invalid token format; independent digest confirmation                                       |
| Source integrity    | one-byte runner/attestation/fixture/template/manifest changes; jointly recomputed manifests with stale owner anchor; omitted/extra/duplicate/traversal files; symlink public files/ancestors; source/Git change after confirmations; zero credentials/network on failed initial gate |
| Cloudflare contract | HTTP 401/403/404/409/429/500 for reads and each W1/W2/B1; malformed JSON/missing result/unexpected success; wrong account/resource/public targets; encoded/unallowlisted paths; deploy/force query refusal; one-shot permit                                                          |
| W1/W2 safety        | preflight latest/deployment/traffic/module/binding/secrets drift; live bindings change between reads; exact new version; W1 no traffic shift; W2 own confirmation/marker; exact deployment/latest/code/secret-name/binding parity; no bootstrap after drift                          |
| Durable filesystem  | every existing canonical/legacy marker; O_EXCL collision; mode/no-follow/parent checks; permission/full-write/file-fsync/dir-fsync faults; interrupted/partial marker; restart; W1/W2/B1 unknown outcomes; reconciliation only reads and never deletes/replays                       |
| Access identity     | local RSA/JWKS fixtures for issuer/aud/subject/email/type/signature/kid/JWK/exp/nbf/iat failures; fresh re-attestation after B1 prompt; child exit/spawn/signal/timeout/output errors; JWT stdin, no arbitrary PATH, no JWT in cert retrieval                                        |
| Privacy             | stdout/stderr/receipt/thrown error/child/network/schema canaries for API/approval/session tokens, JWT, identity/email; raw response IDs/error codes not blindly copied; private records/hash/files forbidden from Git; unsafe filename diagnostics hashed                            |
| B1 and recovery     | health failure; own typed confirmation; final D1/plan/deployment/source checks; redirects/failures/schema ambiguity UNKNOWN_OUTCOME; exactly one POST; zero replay; no human session/retirement/rollback/production action                                                           |

## Offline reproduction

Use a fresh canonical checkout of the exact PR head, installed Node >=22 and `pnpm install --frozen-lockfile`. Run every command in the report; **never supply live credentials or execute W1/W2/B1**. `pnpm test:operator` runs all suites with temporary private fixtures and mocked network. `--verify-bundle` uses public files only and explicitly returns NOT_APPROVED.

From `handoff/c1-a2`, both `sha256sum -c operator/SHA256SUMS` and `sha256sum -c BUNDLE_SHA256SUMS` must pass. Independently hash both manifest files and compare with the values above and the PR evidence. Confirm outer includes inner, neither hashes itself, every required public file is covered and private data is intentionally excluded. Local recomputation is not an authorization shortcut.

Check exact remote head/base ancestry, new push/PR CI conclusions (not historical runs), all job steps/no skips, reviews and unresolved threads. Green CI alone is not a reason to APPROVE. A new commit or changed manifest invalidates review of old source.

## Owner-only decisions and remaining non-certifications

Muse must assess the documented owner-file/independent-pin trust boundary, same-owner filesystem/running-process assumptions, POSIX durability support, API non-atomicity/exclusive change window, background D1 writers, binary build pins, A2 plaintext token at-rest retention and revocation/rotation. The human owner must approve those and all future operational scope; Hoplite does not grant it.

Review F3 remains a trust-model limit: a same-UID directory owner or root can remove attempt markers/private evidence and permit replay. Exclusive creation and fsync protect against crashes, races and retained markers, not deliberate owner deletion. Evidence retention is mandatory; independently controlled tamper-resistant storage would require a separate owner-approved design. The bounded credential scanner is also not comprehensive DLP. Neither limitation is claimed fixed by green tests or this report.

Live Cloudflare permissions/resource state, Access forwarding/token/session, staging release/runtime, C1 76-write receipt, C2/business flow and production certification remain NOT_VERIFIED. No operator test or dry-run certifies a live identity/account/Worker/database. This task performed source/CI/GitHub delivery only, not Cloudflare mutations or merge.

## Authoritative protocol references

- [Cloudflare OpenAPI schema](https://github.com/cloudflare/api-schemas/blob/main/openapi.json): Beta Worker PATCH latest creates a deployment when `deploy=true`; the query-less JSON PATCH is deliberately non-deploying.
- [Beta Worker Versions](https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/): top-level version metadata and `include=modules`/`content_base64`.
- [Deployment list](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/) and [create](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/): active-first deployment, percentage versions, no force.
- [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) and [CLI guide](https://developers.cloudflare.com/cloudflare-one/tutorials/cli/): client `cf-access-token`, Access-origin assertion, `cloudflared access token -app=...`. Wire behavior is documented/tested locally, not certified live here.
- [D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/): optional string `params` bind the organization-name predicate without changing the read-only SQL allowlist.
