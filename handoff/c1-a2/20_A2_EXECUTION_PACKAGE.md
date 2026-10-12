# A2 operator contract — implemented, not executed

**Independent review and human mutation approval remain PENDING.** Method consent, prior PR approval, chat, artifacts, local tests and green CI do not authorize W1/W2/B1. No live token, Access session, secret, deployment or bootstrap was created by this implementation task.

## Modes

| Flag                                | Contract                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--help`                            | Public usage only.                                                                                             |
| `--verify-bundle`                   | Public, offline exact-manifest consistency; explicitly NOT_APPROVED.                                           |
| `--dry-run` / `--prepare` / no flag | Offline plan/template validation with excluded owner-private inputs; zero network.                             |
| `--execute`                         | Future owner-only workflow below; no force, retry, rollback or retirement.                                     |
| `--reconcile`                       | Owner-gated read-only deployment/version/D1 evidence; no mutation permits, marker deletion, retry or rollback. |

Unknown flags and combinations are rejected. Actual operations require the canonical repository layout and a clean reviewed Git bundle, not an unversioned extracted directory.

## Gates before credentials

1. Interactive stdin/stdout/stderr TTY; owner-private directory mode 0700 and input files 0600, correct owner, regular files without symlinks/hard links.
2. Strict approval record: action, reference, plan digest, immutable **Worker** `source_sha`, base version/deployment, account, Worker/name/ID, staging D1, A2 transport and human APPROVED status. Separately require `implementation_sha` and trusted `operator_bundle_sha256`; unknown/duplicate/malformed fields are refused.
3. Pin running Node and Git by canonical absolute path, executable hash and exact version. Read the actual full Git HEAD, reject tracked private artifacts and any uncommitted public bundle changes.
4. Verify both exact-coverage manifests, all public source/tests/fixtures/W1-template/metadata and no symlink paths. The owner-pinned outer digest is the external trust anchor; matching locally regenerated manifests alone is insufficient.
5. Refuse any W1/W2/B1 marker, legacy `c1-post-attempted`, or preexisting persisted bootstrap token. Pin cloudflared by canonical path/hash/exact approved version. Node >=22 and the conservative cloudflared >=2025 version gate are required; no PATH lookup or shell interpolation.
6. Owner types the implementation SHA and outer digest from the **independent review record**, not from this package. Validate all 17 canonical plan strings, its identity and digest, and the pinned template bindings. Recheck the reviewed source before reading the API token, before child attestation and before each mutation.

No real owner approval is shipped. The private record is an owner trust boundary, not a cryptographic review service or a substitute for Muse's review. A compromised owner account/running process is outside this model.

## Ordered, one-attempt workflow

- API token: hidden terminal input only, bounded format check, in memory/redactor only; never environment, argv, file or logs.
- Read-only D1 preflight: exact 0001–0015 ledger, empty FK check and approved uninitialized counts. SQL restricted to single SELECTs or FK PRAGMA; the organization name is a bound string parameter, never SQL text. Every API result must report `changed_db=false`, `rows_written=0`.
- Read-only Worker preflight: exact base active/latest versions/deployment, 18 live non-secret bindings with pinned canonical digest, empty secret list, pinned module/base64 hash/main module/compatibility date. Version-detail and latest bindings must agree.
- Generate a 32-byte CSPRNG bootstrap token only after preflight; never derive it from the public plan digest. Persist once, 0600/no-follow/exclusive with file and directory fsync. This plaintext owner-private recovery secret requires the owner's explicit A2 acceptance and retention/rotation decision. Only its SHA-256 is reportable.
- **W1:** repeat live Worker and D1 preflight. Build the request from freshly read bindings, not from the frozen template. Durably create `c1-w1-attempted` before one query-less PATCH `versions/latest`; preserve 18 bindings and add exactly the three approved secrets. No deploy query. Verify exact new version, unchanged traffic/base deployment, code parity, binding parity and secret names without returned secret values.
- **W2:** exact typed `DEPLOY <new version>` confirmation; repeat post-W1/source/D1 checks. Durably create `c1-w2-attempted`, then one percentage deployment POST for the verified new version at 100%, without force. Verify exact deployment ID, active traffic, latest version, module and binding parity.
- **B1:** recheck D1. Acquire a fresh Access token using the pinned cloudflared binary (no login fallback after command failure). JWT goes to pinned Node attestation only via stdin; use the baseline private identity file and expected email-hash file. Require RS256, pinned issuer/audience, times, exact subject/normalized email, signature/key and matched email binding. `iat` is mandatory and a safe integer. Age uses an unfloored millisecond clock and is at most 900.000 seconds, inclusive. Only future timestamps receive up to 60 seconds of skew. Expiration remains strict on that same clock. The runner samples freshness after attestation, after the post-W2 delay, and again synchronously immediately before the bootstrap POST. A stale token is not reacquired or retried. Read authenticated `/health`; this proves health only, **not** release certification.
- Owner types `BOOTSTRAP <approval ref>`. Re-attest after that potentially long prompt, then repeat source, deployment, module/bindings, plan and D1 checks. Durably create `c1-b1-attempted` before one bootstrap POST. Require HTTP 200, VERIFIED/PROVISIONED and exactly 76 writes, then verify exact post-D1 counts/ledger/FK state. The backend independently checks approved Worker release SHA and verified Access identity.
- STOP. No human session, C2 smoke, retirement, automatic rollback, resource creation/deletion or production operation.

The client sends `cf-access-token`; Access supplies the origin's `Cf-Access-Jwt-Assertion`. Never substitute a caller-supplied assertion or unverified email header. Redirects are errors; JWT is never sent to another target or included in certificate retrieval.

A cached Access JWT older than 15 minutes is not fresh attestation, even if unexpired. Arrange owner-controlled reauthentication before an authorized execution window. If freshness fails during the one-attempt flow, STOP, retain all markers/tokens, and reconcile read-only; do not relax the age limit, automatically refresh/login, or replay W1/W2/B1.

## Durable attempts, privacy and reconciliation

Each marker is exclusive/no-follow, mode 0600, complete allowlisted non-sensitive metadata, file fsync then parent-directory fsync. Any inability to guarantee durability fails closed. Partial files remain; unsupported directory fsync is not downgraded. Previous stage markers may coexist only inside a single current flow. Startup blocks every existing canonical/legacy marker; legacy POST blocks B1 replay while retained.

Durability is not tamper resistance: the trusted directory owner or root can delete markers and other private evidence, making a previous attempt indistinguishable from a first attempt. The owner must retain these files. Preventing replay by a malicious same-UID owner would require an independently controlled immutable journal outside this local trust model; no such guarantee or remote journal is implemented here.

Network interruption, malformed mutation response, unexpected success schema or unverifiable mutation result is **UNKNOWN_OUTCOME**, even when HTTP succeeded. Never delete a marker/token to retry. Read-only reconciliation gathers validated active/latest IDs and allowlisted D1 counts; it cannot grant a mutation permit and does not alter markers. Any new execution/source requires new independent review and owner authorization, with an owner-led reconciliation/credential rotation decision.

Child nonzero exit, signal, timeout, spawn/input failure and excessive stdout are STOPs. Child stderr, network error strings, raw JSON/error codes and unexpected response fields are not published. Outputs/receipts contain only fixed status text, validated public IDs/digests and counts; no credentials, identity/email/hash record or session token. Receipts are best effort, 0600/exclusive/durable; attempt markers remain authoritative.

## Owner-only operational decisions after review

The human owner must approve exact source/manifests and binary pins, private-input provenance, plaintext-token retention, narrowly scoped short-lived staging Worker Editor and D1 Read permissions, exclusive staging change window/background-writer controls, fresh Access identity/session and revocation/retirement plan. Per-Worker token acceptance and real Access forwarding must be verified by read-only preflight/live owner evidence, not inferred from these mocks. No API token, policy, DNS, secret or database mutation is authorized here.
