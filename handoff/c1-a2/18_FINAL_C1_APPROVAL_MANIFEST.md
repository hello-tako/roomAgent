# 18 — Final C1 approval manifest

Revision 2. 2026-10-11 ~10:03 JST. Read-only. Nothing in this file has been executed.

## 1. Identity and plan

| Item | Value |
| --- | --- |
| action | `ROOMAGENT_STAGE_C1_SYNTHETIC_BOOTSTRAP` |
| approval_request_ref | `c1req-6c20d8157fe67e44067cd246` (PENDING, not an approval) |
| identity_attestation_ref | `c1att-c193013432ad85744374a37889fb88ee` (VERIFIED, RS256/JWKS, iss/aud/type=app PASS, email_binding MATCHED) |
| operatorIdentityRef | `c1op-bc5dc954153343965d3b4dad`. Bound: it is in the private plan next to the same attestationRef, issuer, subject, and email as the private attestation record. It is not the subject and contains no `@`. |
| ownerDisplayName | `roomAgent Staging Owner` (confirmed by the owner) |
| plan fields | 17 (exactly the keys the route parses) |
| canonical_plan_digest | `971425db70d25b830d7fc75146298a07c43f4ff69547a999ffeb89e2e7b5f173`, recomputed 2026-10-11 ~10:05 JST from `operator/private/c1-canonical-plan.json`, matches |
| repository / source_sha | `takovn2/roomAgent` (1410359112) / `3909fada8747ae27ea71daf6da9481a7eb8d9eff` |
| account | `ef250a88911fd24073cb73d1c07e0218` |
| worker | `ai-company-os-api-staging` (worker id `0e5cfb1a28814e60a4e2f7ce5210db6e`) |
| base version / deployment | `cd03f994-9bc8-4aca-84c0-0f11ce9e0b8d` @100% / `7e523eba-cc34-4a67-9d5d-5eb47a6e4e32` |
| D1 | `a6b8c2f6-d697-442b-8374-5006246324b2` (`ai-company-os-staging`) |
| organization | `roomAgent Staging Smoke` |

Plan (subject/email are private, see 17): environment=staging, execution=remote-staging, accountId, databaseId, databaseName, schemaVersion=0015, repositorySha, orgName, ownerDisplayName, operatorIdentityRef, issuer=https://little-bar-8ffa.cloudflareaccess.com, subject, email, verificationSource=cloudflare-access-operator-record, attestationRef, approvalRef=c1req-6c20d8157fe67e44067cd246, expectedPreState=uninitialized.

## 2. D1 budget (one route call, one D1 batch)

| Table | Rows |
| --- | --- |
| human_users | 1 |
| organizations | 1 |
| roles | 7 (owner, executive, manager, employee, qa, security, auditor) |
| role_permissions | 66 (23+11+9+7+6+6+4) |
| human_identities | 1 |
| **total statements** | **76** |

No employees, rooms, tasks, artifacts, queue messages, workflow instances, human sessions, or audit/session rows are in this approval.

## 3. Execution method: Cloudflare connector (`user-Cloudflare` `execute`), not Wrangler

Connector identity: user `30e8d570016f943a2528b6cf79b6adbe`. One account visible. The connector has write scope, and this approval authorizes only the calls listed below.

Capability findings (from the connector schema, Cloudflare OpenAPI spec, and docs; no mutating call was made):

| Need | Endpoint | Finding |
| --- | --- | --- |
| (a) new version with 3 secrets, not activated | `PATCH /accounts/{a}/workers/workers/{worker}/versions/latest?deploy=false` (JSON Merge Patch on latest) | CAPABLE. `deploy=true` would create a 100% deployment, so `deploy` must be omitted/false. Limitations: (1) it can only patch `latest`, so latest must equal active `cd03f994…` immediately before. (2) `bindings` is an array. Under RFC 7396 it is replaced as a whole, so the body must carry all 18 current bindings verbatim plus 3 `secret_text`. Never send a bindings list without them. (3) This endpoint has not been exercised on this account. |
| — rejected | `PATCH /workers/scripts/{w}/secrets-bulk`, `PUT …/secrets` | NOT USED. Script-level secret endpoints = `wrangler secret` semantics (new version deployed immediately). |
| (b) read back staged version | `GET /workers/workers/{w}/versions/{id}?include=modules`, `GET /workers/scripts/{w}/versions/{id}`, `GET …/versions` | CAPABLE (verified by read today). Secret bindings are returned as name+type only. Values are never returned. |
| (c) activate exactly that version | `POST /workers/scripts/{w}/deployments` body `{strategy:"percentage",versions:[{version_id:<NEW>,percentage:100}]}`, no `force` | CAPABLE. **0% deployment: NOT POSSIBLE** (`percentage` minimum 0.01, sum must be 100). It is also not needed, because a version created with `deploy=false` already serves 0% traffic. |
| (d) verify traffic | `GET /workers/scripts/{w}/deployments` | CAPABLE (verified by read today) |
| (e) audit evidence without secret values | `GET /accounts/{a}/logs/audit` (v2) | CAPABLE. Read works today (HTTP 200) and shows actor/resource/action. Limitation: the connector takes JS code as a tool argument. A secret written inline would appear in the agent transcript. Mitigation (mandatory): generate the token in a mode-0600 file on the agent box, build the call code in a 0600 file, pass it as `$file:/path` (substituted only when sent to the connector server), return only names/ids/hashes, copy the token to Mac `operator/private/` (0600) for the POST, then delete the box copies. `BOOTSTRAP_APPROVAL_DIGEST` and `STAGING_RELEASE_SHA` are not secret in value but are handled the same way. |
| bootstrap POST | `POST https://api-staging.tungjp.store/operator/staging-bootstrap` | NOT a connector call. It must run on the operator Mac, because it needs a fresh Access JWT (`cf-access-jwt-assertion`) plus headers `x-bootstrap-approval-token` and `x-bootstrap-approval-digest`, with values read from the pipe or 0600 files and never echoed. |

## 4. Exact remote mutation sequence (count = 3 calls)

| # | Call | Effect |
| --- | --- | --- |
| W1 | PATCH versions/latest (deploy=false): 18 existing bindings verbatim + `BOOTSTRAP_APPROVAL_TOKEN` (32 CSPRNG bytes, 64 hex, ≠ digest), `BOOTSTRAP_APPROVAL_DIGEST = 971425db…f173`, `STAGING_RELEASE_SHA = 3909fada…`; annotations `workers/message="C1 bootstrap approval secrets staged (c1req-6c20d8157fe67e44067cd246)"`, `workers/tag="c1-bootstrap-secrets"` | 1 new version, 0% traffic |
| W2 | POST deployments `[{<NEW>,100}]` | 1 new deployment, NEW at 100% |
| D1 | POST /operator/staging-bootstrap (from the Mac) | 76 D1 statements in one batch |

Worker version/deployment mutations = **2** (1 version, 1 deployment). Optional 0% deployment = **0** (impossible and unneeded).

## 5. Code/bindings identity check (between W1 and W2; STOP if any fails)

Reference = `cd03f994…`, read 2026-10-11:
- one module `index.js` (`application/javascript+module`); SHA-256 of its base64 content = `5c2370f0a6a01ea5050412777c91dd9000d80c0cc2c5fc43259a652d9f4dc282`; script etag `83b84262f0eb57ce05268d72b8eca9658a3abcb64ecd2ee4f83e2c1b25abbad7`
- main_module `index.js`, compatibility_date `2026-10-08`, usage_model standard, handlers fetch+queue, 5 DO classes + `ProductionTaskWorkflow`
- 18 bindings: 7 plain_text (ACCESS_AUD, ACCESS_TEAM_DOMAIN, STAGING_ACCOUNT_ID, STAGING_DATABASE_ID, STAGING_DATABASE_NAME, STAGING_OPERATOR_BOOTSTRAP=enabled, STAGING_RUNTIME=cloudflare), D1 DB, R2 ARTIFACTS, 3 queues, workflow PRODUCTION_TASK, 5 DO namespaces (ids in 15)

NEW must have an identical module hash, main module, compat date, and the 18 bindings deep-equal. It must have exactly 3 additional `secret_text` names and no other change. NEW must be at 0% traffic and `cd03f994` must still be at 100%.

Provenance limitation: the module hash proves NEW = the code of `cd03f994`. That `cd03f994` was built from `3909fada` comes from the Stage C deploy record (01/02). A local rebuild with a hash comparison was **NOT_VERIFIED**.

## 6. Pre-execution checks (immediately before W1, again before the POST)

1. Fresh Access JWT via `cloudflared access token` → `attest-access-identity.mjs` in a new private file → the issuer, subject, and email must equal `c1-access-attestation.json` (same iss/sub/email). The current JWT expired at 10:58 JST on 2026-10-11.
2. Worker: active deployment `7e523eba` with `cd03f994` @100%, latest = `cd03f994`, secrets empty, 18 bindings unchanged.
3. D1 (SELECT/PRAGMA, rows_written 0): ledger exactly 0001–0015; `PRAGMA foreign_key_check` empty; org `roomAgent Staging Smoke` 0; human_users 0; human_identities 0 (no issuer/subject/email match); roles 0; role_permissions 0 (no partial bootstrap); permissions 23.
4. Recompute the digest from the private plan; it must equal `971425db…f173`.
5. Audit log: no unexpected change on `ai-company-os-api-staging` or D1 `a6b8c2f6` since 2026-10-11 08:43:35 JST. The 2026-10-11 cron updates seen were on unrelated Workers `frigo`/`frigo-staging`.

## 7. Expected runtime verification

- After W2: deployment shows NEW @100%. D1 binding still `a6b8c2f6`. Public Worker untouched.
- POST: HTTP 200, `state=VERIFIED`, `writes=76`. Record only state, reason, writes, and the server-issued usr_/org_/hid_ ids (no token, JWT, subject, or email).
- D1 after: organizations(name)=1, human_users=1, human_identities=1, roles=7, role_permissions=66, employees/rooms/tasks=0, FK check empty, ledger unchanged.
- Audit v2 shows exactly 1 version upload, 1 deployment, and D1 queries for this window.

## 8. Failure handling (no retries without a new decision)

- Any precheck mismatch → STOP before W1.
- W1 error or uncertain result → read versions. If a version was created, leave it undeployed (0% traffic, harmless) and STOP.
- §5 identity check fails → do not run W2. STOP. NEW stays undeployed.
- W2 error → read deployments. If NEW is not at 100%, STOP. No `force`, no automatic rollback.
- POST 403/409/5xx/timeout → do not retry. Re-read D1. `BOOTSTRAP_STATE_CONFLICT`/partial rows → `C1_BOOTSTRAP_PRESTATE_CONFLICT`. Do not delete rows.
- Any secret value seen in output → follow `10_SECURITY_AND_RECOVERY_PLAN.md` (rotate the token via a new approval).

## 9. Rollback limitations

Worker rollback to `cd03f994` needs its own approval. It does not undo D1. human_identities and audit rows are immutable (`IDENTITY_IMMUTABLE`, `AUDIT_IMMUTABLE`). D1 Time Travel restore is not part of this plan.

## 10. Secret lifecycle and retirement (separate action)

NOT_CONFIGURED → (W1) STAGED → (W2) ACTIVATED → (POST) BOOTSTRAP_EXECUTED → (reads) BOOTSTRAP_VERIFIED → RETIRED.

Retirement = `ROOMAGENT_STAGE_C1_BOOTSTRAP_RETIREMENT`, a separate approval and not included here. Proposed shape: one PATCH versions/latest that drops `STAGING_OPERATOR_BOOTSTRAP`, `BOOTSTRAP_APPROVAL_TOKEN`, `BOOTSTRAP_APPROVAL_DIGEST` (and `STAGING_RELEASE_SHA` if approved), then one deployment @100%, then verify that `POST /operator/staging-bootstrap` returns 404 and the secret names are absent. Then a reviewed GitHub PR removes the flag from `wrangler.staging.jsonc`, so a later deploy cannot re-enable it. The local token copies are deleted at retirement.

Not included: human session issue/revoke (`NOT_AUTHORIZED`), C2, any public resource.

```text
STATUS = ROOMAGENT_STAGE_C1_A2_EXECUTION_BLOCKED (pending independent review gate B + owner approval; see 20)
ACTION = ROOMAGENT_STAGE_C1_SYNTHETIC_BOOTSTRAP
approval_request_ref = c1req-6c20d8157fe67e44067cd246
canonical_plan_digest = 971425db70d25b830d7fc75146298a07c43f4ff69547a999ffeb89e2e7b5f173
identity_attestation_ref = c1att-c193013432ad85744374a37889fb88ee
worker_mutations = 2 (1 version via connector PATCH deploy=false, 1 deployment @100%)
D1_statements = 76
execution_method = Cloudflare connector (Worker steps) + operator Mac (Access JWT + bootstrap POST)
conditions = §5 identity check passes between W1 and W2; fresh JWT same iss/sub/email; fresh D1 prestate
human_owner_approval = PENDING
```

## Revision 3 (2026-10-11 ~10:12 JST): mutation gate final check

See `19_MUTATION_GATE_FINAL_CHECK.md`. CHECK B (W1 endpoint, deploy semantics, fresh state, 18 bindings preserved byte-for-byte plus exactly 3 secret_text) = PASS. CHECK A (moving the token through connector arguments or `$file:`) = BLOCKED, because it cannot be shown to stay out of remote or connector logs. The §3 (e) `$file` mitigation is withdrawn. The owner must choose A1 (sandbox-generated token, RSA-OAEP envelope to a Mac key) or A2 (direct Mac API call with a short-lived, owner-issued, account-scoped Workers Scripts Edit token entered through a hidden prompt). human_owner_approval = PENDING.

## Revision 4 (2026-10-11 ~10:14 JST): A2 execution method

Supersedes §3 (connector execution) and the §4 call path. The connector is read-only from here on.

- Transport/execution: **A2**. `operator/c1-runner.mjs --execute` on the operator Mac, one process. Owner's short-lived, account-owned API token (Workers Editor scoped to `ai-company-os-api-staging` only + D1 Read) entered through a hidden prompt.
- Remote mutations: exactly 3. W1 `PATCH /accounts/ef250a88…/workers/workers/ai-company-os-api-staging/versions/latest` (no `deploy`, 18 bindings verbatim + 3 secret_text = 21). W2 `POST /accounts/ef250a88…/workers/scripts/ai-company-os-api-staging/deployments` `[{NEW,100}]` (no `force`, typed confirmation). B1 one `POST /operator/staging-bootstrap` (typed confirmation). Worker mutations = 2. 0% deployment = 0.
- D1 budget: 76 (human_users 1, organizations 1, roles 7, role_permissions 66, human_identities 1).
- Provenance: **MATCH**. A clean rebuild of `3909fada` gives an `index.js` whose base64 SHA-256 = `5c2370f0…c282` = the deployed `cd03f994` module.
- Package hashes: `operator/SHA256SUMS`. Independent review gate B must bind to these hashes. Any file change invalidates the review.
- Token revocation: immediately after the run, any outcome (see 20 §5).
- Queue depth NOT_VERIFIED. Background D1 writes are not assumed absent. Exact pre/post reads, and STOP on deviation.

```text
STATUS = ROOMAGENT_STAGE_C1_A2_EXECUTION_BLOCKED
blocking = INDEPENDENT_REVIEW_GATE_B_PENDING, HUMAN_OWNER_C1_APPROVAL_PENDING
ACTION = ROOMAGENT_STAGE_C1_SYNTHETIC_BOOTSTRAP
human_owner_approval = PENDING
```
