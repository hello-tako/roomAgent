# 20 — A2 execution package (prepared, not executed)

Date 2026-10-11 ~10:14 JST. The owner consented to the A2 **method** only. C1 mutation approval = PENDING. No API token was created. W1, W2, and the POST did not run. No secret was written. The runner was never run against a live endpoint.

## 1. Package (operator/, outside Git, no push)

| File | Role |
| --- | --- |
| `operator/c1-runner.mjs` | Single-process Node runner. Default `--dry-run`. |
| `operator/c1-runner.test.mjs` | 13 local tests. All endpoints are mocked. |
| `operator/fixtures/bindings18.json` | Live 18-binding read (2026-10-11 10:07 JST). canonical SHA-256 `1feacf2a…dcff` |
| `operator/c1-owner-approval.TEMPLATE.txt` | Approval file template (invalid until the owner sets APPROVED) |
| `operator/attest-access-identity.mjs` | Existing attestation script (unchanged) |
| `19_W1_REQUEST_BODY_PLACEHOLDER.json` | W1 template (placeholders only) |
| `operator/SHA256SUMS` | SHA-256 of every file above. An independent reviewer binds the review to these hashes. |

### What `c1-runner.mjs --execute` does (refuses unless every gate passes)

0. Offline: loads the private attestation record and plan. Checks the 17 keys, all string-typed, every fixed value exact (ownerDisplayName, operatorIdentityRef, refs, IDs, issuer), and plan issuer/subject/email = attestation record. Recomputes the digest and requires `971425db…f173`. Checks that the template's 18 bindings hash to `1feacf2a…`.
1. Gates: interactive TTY required. `private/c1-owner-approval.txt` must match action, approval ref, digest, source SHA, base version, worker, D1, `secret_transport=A2`, and `human_owner_approval=APPROVED`. A `private/c1-w1-attempted` marker from an earlier run means refuse.
2. API token: hidden raw-mode prompt (no echo). Held in a process variable only. It is never placed in env, argv, a file, or output. Format check, then registered with the redactor.
3. Pre-W1 (reads): D1 ledger = 0001–0015 exact, `PRAGMA foreign_key_check` empty, counts = uninitialized (org named 0, orgs 0, users 0, identities 0, roles 0, role_permissions 0, employees/rooms/tasks 0, permissions 23), every read `changed_db=false` and `rows_written=0`. Worker: newest deployment `7e523eba` = [`cd03f994`@100], latest = `cd03f994`, 18 bindings hash `1feacf2a…`, secrets `[]`, module base64 SHA-256 `5c2370f0…c282`, main `index.js`, compat `2026-10-08`.
4. Approval token: `crypto.randomBytes(32)` → 64 hex (equivalent to `openssl rand -hex 32`), must differ from the digest. Written once with O_EXCL, mode 0600, to `private/c1-bootstrap-approval-token`, so a crash cannot orphan it. Only its SHA-256 goes into the receipt.
5. W1: drift re-check (step 3 Worker reads), then write the `c1-w1-attempted` marker, then exactly one `PATCH /accounts/ef250a88…/workers/workers/ai-company-os-api-staging/versions/latest` with **no query string** (no `deploy`). Body = 18 live bindings verbatim + 3 `secret_text`, annotations tagged with the approval ref. The mutation guard allows only this exact method+path, once.
6. Post-W1: latest = NEW ≠ base; newest deployment is still `7e523eba` [`cd03f994`@100]; NEW is in no deployment; NEW module hash, main module, and compat date are identical; the 18 non-secret bindings hash `1feacf2a…`; secret names are exactly the 3; no secret value is returned.
7. W2: the operator must type `DEPLOY <NEW>`. The post-W1 checks run again (drift check). Then exactly one `POST …/workers/scripts/ai-company-os-api-staging/deployments` with `{strategy:"percentage",versions:[{version_id:NEW,percentage:100}]}`, without `force`. Verify: newest deployment = [NEW@100] and the bindings are unchanged.
8. Pre-POST: D1 prestate again. Fresh Access JWT via `cloudflared access token` (falls back to `cloudflared access login --quiet`), piped by stdin into `attest-access-identity.mjs` → a new private record must be `VERIFIED`/`MATCHED` with the **same issuer, subject, and email** as `c1-access-attestation.json`. The plan is re-validated and the digest recomputed. The operator must type `BOOTSTRAP c1req-6c20d8157fe67e44067cd246`.
9. B1: write the `c1-post-attempted` marker first, then exactly one `POST https://api-staging.tungjp.store/operator/staging-bootstrap` with headers `cf-access-token` (JWT), `x-bootstrap-approval-token`, `x-bootstrap-approval-digest`, body `{plan}`, and `redirect: manual`. Requires HTTP 200, `state=VERIFIED`, `writes=76`.
10. Post-D1: ledger unchanged, FK empty, org named 1, orgs 1, users 1, identities 1, roles 7, role_permissions 66, employees/rooms/tasks 0, permissions 23.
11. STOP. No human session, no retirement, no retry. A secret-free receipt (`private/c1-exec-receipt-*.json`, 0600: steps, ids, HTTP/state/writes, token SHA-256) is written on success **and** on any STOP.

Leak guards: no secret in argv or env. Every stdout line and the receipt pass through a redactor (registered values + JWT-shaped + `Bearer …`). Uncaught exceptions print only `STOP <code>` (no stack). Child stderr is discarded. The `curl` command line is not used at all, because Node `fetch` keeps headers off argv. In dry-run, `fetch` is replaced by a stub that throws, and no Cloudflare client is created.

Hard target guards: every Cloudflare path must start with `/accounts/ef250a88911fd24073cb73d1c07e0218/`. Worker paths must name `ai-company-os-api-staging` or its id. D1 paths must name `a6b8c2f6…`. Any path containing `ai-company-os-api` (public) or `a4b622e6…` is rejected. D1 SQL must be a single SELECT or `PRAGMA foreign_key_check` (write keywords and multiple statements are rejected), and a response showing a write = STOP.

Unknown-outcome rule: a network error on W1, W2, or B1 = `UNKNOWN_OUTCOME` STOP. The marker files make a rerun refuse. The next step is read-only re-reads and an owner decision.

## 2. Validation results

- `node --check` on runner + tests: OK (Mac Node v25.9.0; box Node v22.23.3). shellcheck: not applicable (no shell script; the runner is Node, chosen for in-process secrets and mockable I/O).
- `node --test operator/c1-runner.test.mjs`: **13/13 pass** on the Mac and on the box. They cover: dry-run = 0 network calls; refusal without approval file / wrong digest / wrong ref / no TTY (0 calls); happy path = exactly [PATCH versions/latest, POST deployments, POST bootstrap], W1 without query, 21 bindings with the first 18 hash-equal, W2 = [{NEW,100}] without query, token ≠ digest, the POST carries the right headers and only `{plan}`, and no API token/approval token/JWT/subject/email in output or receipt; pre-W1 drift (latest, bindings, secrets) → 0 mutations; post-W1 code mismatch → no W2; W1 network error → exactly 1 PATCH and rerun refused; W2 not confirmed → no deployment; POST 500 / network error → exactly 1 POST, marker present, secrets scrubbed; D1 read reporting a write → STOP; guards (public worker, public D1, foreign account, non-allowlisted mutation, write SQL); real-config template hash; redactor; plan/approval tampering.
- `node operator/c1-runner.mjs` (dry-run, real private files): `DRY_RUN_OK`. Plan digest PASS `971425db…`, template PASS, approval file ABSENT, network NONE.

## 3. Source provenance (gate item 3): **MATCH**

A clean checkout of `takovn2/roomAgent` @ `3909fada8747ae27ea71daf6da9481a7eb8d9eff` was built on the agent box (Node 22.23.3, pnpm 10.33.2 `--frozen-lockfile`, wrangler 4.148.0). Command: `wrangler deploy --dry-run --outdir … --config wrangler.staging.jsonc`. It ran with no auth and no remote calls ("--dry-run: exiting now"). Output `index.js`: 553,724 bytes, raw SHA-256 `f4700897fa3c587f24ae003867cf6fc77f418a3bb9f732dfc73965a377d834b0`. Its base64 (738,300 chars) has SHA-256 `5c2370f0a6a01ea5050412777c91dd9000d80c0cc2c5fc43259a652d9f4dc282`, which equals the deployed `cd03f994` module. The dry-run listed the same 18 bindings. The live version runs code byte-identical to a clean rebuild of the certified SHA.

## 4. API token (owner creates it only after C1 approval; never paste it in chat)

Per-Worker scoping **is possible** (Cloudflare docs, 2026-09-15 "Granular Worker permissions"; `/workers/authorization/workers/`). It requires an **account-owned** token with Workers role scope "Individual Workers". The docs say bound resources (D1, R2, Queues, DO) need no separate permission to deploy. Legacy `Workers Scripts Edit` = Editor on **all** Workers in the account, which is not wanted.

Exact steps:
1. Open **https://dash.cloudflare.com/ef250a88911fd24073cb73d1c07e0218/api-tokens** (Manage Account → Account API Tokens). The user-profile page `https://dash.cloudflare.com/profile/api-tokens` does not document per-Worker scope. If the owner uses it, the narrowest option there is account-wide Workers Scripts Edit (wider), and that is an owner decision.
2. Create Token → Custom token. Name: `roomagent-c1-w1w2-shortlived`.
3. Permissions:
   - **Workers → Editor**, scope **Individual Workers → `ai-company-os-api-staging` only**. This covers version reads incl. modules, PATCH versions/latest, deployments read/create, and the secret-name list.
   - **D1 → Read**, account `ef250a88…`, for the pre/post SELECT and PRAGMA. The Query endpoint accepts `D1 Read` (API reference). Per-database D1 scoping is not documented, so this is read access to every D1 in the account, including public D1 (read-only). This is an owner decision. Without it the runner stops at its first D1 read, before any mutation.
   - Nothing else: no Account Settings, Access, Zone, DNS, Workers Routes, R2, Queues, or any Edit on D1.
4. TTL: start now, end = start + 2 hours (the shortest practical window covering W1→POST).
5. Client IP filtering (optional, recommended): the Mac's current public IP only.
6. Create. Copy the value once and do not store it anywhere. Run `node operator/c1-runner.mjs --execute` in a local terminal and type or paste it **only** at the hidden prompt.

Unverified: whether the `/workers/workers/{name}/versions/*` endpoints accept a per-Worker Editor token. If they return 403, the runner stops during the pre-W1 GETs, before any mutation.

## 5. Revocation plan (gate item 5)

- Immediately after the runner exits, for **any** outcome including a STOP: the owner deletes `roomagent-c1-w1w2-shortlived` on the same Account API Tokens page. The TTL is the backstop.
- Verification (read-only, by the agent through the existing connector): audit log v2 shows a token deletion entry after the run, and shows only the expected W1/W2 actions authored by that token.
- The approval-token file `private/c1-bootstrap-approval-token` stays (0600) until `ROOMAGENT_STAGE_C1_BOOTSTRAP_RETIREMENT` removes the secrets. Then it is deleted.
- If any secret is ever seen in output: revoke the API token at once, treat the approval token as burned (rotation needs a new approval), and follow `10_SECURITY_AND_RECOVERY_PLAN.md`.

## 6. Background writes

Queue depth = **NOT_VERIFIED**. Background writes to D1 by queues, workflows, or DOs are not assumed absent. The runner re-reads the D1 prestate immediately before W1 and again immediately before the POST, and the poststate check is exact. Any unexpected change = STOP and report; it is never "fixed".
