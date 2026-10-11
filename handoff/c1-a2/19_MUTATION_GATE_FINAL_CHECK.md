# 19 — Mutation gate final check (CHECK A + CHECK B)

2026-10-11 ~10:07–10:12 JST. Read-only. No W1, no W2, no POST, no secret write, no real token generated. Mutation approval is still PENDING.

```text
RECEIPT = ROOMAGENT_STAGE_C1_MUTATION_GATE_BLOCKED
CHECK_A (secret transport via $file / tool arguments) = BLOCKED
CHECK_B (W1 endpoint, schema, live state, bindings diff) = PASS
```

## CHECK A — secret transport

### What was proven

| Question | Evidence | Result |
| --- | --- | --- |
| Is `$file:` substituted tool-side, not by the model? | The platform's CallDynamicTool contract applies the substitution to external MCP namespaces when the call is sent. In a dummy test (`ok.js`, no API call) the model sent only the path, the snippet ran remotely, and the platform appended "…was replaced with the contents of … (111 bytes) before the call". | PROVEN (tool-side) |
| Is file content echoed back in results? | A syntax-error dummy (`syn.js`) returned only `Error: Unexpected token '{'`, with no code echo. A runtime-error dummy was blocked by Auto-review before it ran: the reviewer could not see the opaque file content, so it was not tested. | PARTIAL. Not echoed on a parse error. Runtime error paths are untested, and a thrown message or stack could include code. |
| Does the content reach the remote connector server? | YES, by design. `execute` is a code-execution tool. The substituted string is the JS code itself and is sent verbatim to the remote MCP server, which runs it in its sandbox and calls api.cloudflare.com. | A secret in the code = a secret in the remote server's request payload |
| Does the remote MCP server, or the platform's MCP client, log tool arguments? | No documentation available to me states either way. The connector server's operator and retention policy were not verified. | NOT PROVABLE |
| Can Auto-review audit a `$file` call? | No. It blocked the opaque dummy call. A W1 sent through `$file` would be unreviewable or blocked. | Negative |

Conclusion: putting `BOOTSTRAP_APPROVAL_TOKEN` into a tool argument, inline or through `$file:`, cannot be shown to stay out of remote or connector logs. **BLOCKED.**

Scope note: only `BOOTSTRAP_APPROVAL_TOKEN` is secret. `BOOTSTRAP_APPROVAL_DIGEST` (971425db…, already in the reports) and `STAGING_RELEASE_SHA` (3909fada…) are public values stored as secret_text. They can appear in arguments.

### Safer alternatives (proposed, not executed; each needs the owner's choice and the C1 approval)

**A1 — Token generated inside the connector sandbox, returned only as a sealed envelope (recommended if the connector is kept)**
1. On the Mac: generate an RSA-3072 key pair for RSA-OAEP-SHA256. The private key goes in `operator/private/` (0600) and never leaves the Mac. The public key is not secret.
2. W1 code (inline and readable, so Auto-review can inspect it; no `$file`): `crypto.getRandomValues(32 bytes)` → 64 hex; assert ≠ digest; PATCH as in CHECK B with that value; return only `{new_version_id, token_sha256, token_rsa_oaep_b64}`. Wrap the code in try/catch so an error returns no variables.
3. On the Mac: decrypt into `operator/private/bootstrap-approval-token` (0600) and check that the SHA-256 matches `token_sha256`.
- The token is never in an argument, a result, a transcript, or a model context (only ciphertext and a hash are).
- Residual risk: the plaintext exists in the remote sandbox's memory for the duration of the call (not in its logged arguments). The connector server operator was not verified.

**A2 — Direct Cloudflare API call from the Mac, with no connector or agent in the secret path (strongest isolation)**
1. The owner creates a short-lived API token in the dashboard: account `ef250a88…` only, `Workers Scripts Edit`, TTL of a few hours. The owner enters it through a hidden prompt (`read -s`) into one Mac process's environment. It is not pasted into chat or files.
2. That process: `openssl rand -hex 32` > 0600 file → builds the W1 body from `19_W1_REQUEST_BODY_PLACEHOLDER.json` locally → one `curl -X PATCH …/versions/latest` (no `deploy` param) → prints only the new version id and HTTP status. The same process can later send the bootstrap POST.
3. The owner revokes the API token after C1.
- Residual risk: this needs a new owner-issued Edit token, which the original task forbids without owner consent, so it is an explicit owner decision.

**A3 — Owner enters the token through a hidden prompt on the Mac**, and the Mac sends it directly to api.cloudflare.com. This is the same as A2 for transport; it only changes where the token is generated.

## CHECK B — W1

### Endpoint and semantics (Cloudflare OpenAPI spec, read through the connector `search`)

- `PATCH https://api.cloudflare.com/client/v4/accounts/ef250a88911fd24073cb73d1c07e0218/workers/workers/ai-company-os-api-staging/versions/latest`
  - `worker_id` accepts an ID or a name. The staging worker id is `0e5cfb1a28814e60a4e2f7ce5210db6e`, so the id form can be used to remove name ambiguity.
- The spec says: "Only `/versions/latest` is supported. Creates a new Worker version by applying a JSON Merge Patch (RFC 7396) to the latest version… Omitted fields are inherited from the latest version."
- Query `deploy` (boolean): "If true, a deployment will be created that sends 100% of traffic to the new version." W1 omits it (or sends `false`), so no deployment is created and the new version takes 0% traffic.
- Content-Type `application/json`. Top-level keys sent: `annotations`, `bindings` only. Modules, compatibility date, and usage model are inherited.
- `secret_text.text` is `writeOnly` and `x-sensitive`, so it is never returned by reads or in the response.
- Binding schemas: d1 requires name/type/database_id (`id` is optional and sent as read); plain_text requires name/type/text; queue requires queue_name; r2 requires bucket_name; workflow requires workflow_name (class_name optional); DO accepts class_name/namespace_id.

### Fresh live state (read 2026-10-11 10:07:01 JST)

| Check | Value | Result |
| --- | --- | --- |
| worker | `ai-company-os-api-staging` / `0e5cfb1a28814e60a4e2f7ce5210db6e` | PASS |
| active deployment | `7e523eba-cc34-4a67-9d5d-5eb47a6e4e32`, `cd03f994…` @100%, unchanged (2 deployments total) | PASS |
| latest version | `cd03f994-9bc8-4aca-84c0-0f11ce9e0b8d` (#2) = active | PASS |
| versions | only `cd03f994…`, `3aeb3cbc…` (no undeployed newer version) | PASS |
| secrets | `[]` | PASS |
| bindings | 18; identical across the new-API latest, the new-API by-id, and the legacy version read | PASS |

### W1 body vs. fresh bindings

`19_W1_REQUEST_BODY_PLACEHOLDER.json` (placeholders only, no real value):
- 21 bindings: entries 1–18 are a deep copy of the fresh read. Each one is equal byte-for-byte in canonical sorted JSON and in as-read key order, 18/18.
- Canonical SHA-256 of the fresh 18 is `1feacf2a5bcb6be55972c1727e75a5257c2ee28830a76955786aaf15fb3dfcff`. The first 18 entries of the body have the same hash.
- Added, exactly 3, all `secret_text`: `BOOTSTRAP_APPROVAL_TOKEN` (<64-hex CSPRNG, ≠ digest>), `BOOTSTRAP_APPROVAL_DIGEST` (<971425db…f173>), `STAGING_RELEASE_SHA` (<3909fada…>).
- Binding names are unique. The body contains no `a4b622e6`, no `ai.tungjp.store`, and no `"ai-company-os-api"`. The target path names only `ai-company-os-api-staging`.
- annotations: `workers/message = "C1 bootstrap approval secrets staged (c1req-6c20d8157fe67e44067cd246)"`, `workers/tag = "c1-bootstrap-secrets"`.

### Post-W1 independent checks (all before any W2)

1. Read the version list: exactly one new id, and it is `latest`.
2. Read the deployments: the newest deployment is still `7e523eba` with `cd03f994` @100%. The new id does not appear in any deployment.
3. Read the new version with `include=modules`: one module `index.js` (`application/javascript+module`), SHA-256 of its base64 content = `5c2370f0a6a01ea5050412777c91dd9000d80c0cc2c5fc43259a652d9f4dc282`. main_module `index.js`, compat `2026-10-08`, usage_model standard. The legacy read's script etag should be `83b84262f0eb57ce05268d72b8eca9658a3abcb64ecd2ee4f83e2c1b25abbad7`; it is informational only, because an etag could change even when the module hash is equal.
4. New bindings: the 18 non-secret entries have canonical SHA-256 `1feacf2a…dcff`. There are exactly 3 extra entries, of type `secret_text` with the 3 names, and no values returned.
5. Secret names (script `secrets` endpoint and version bindings): exactly the 3.
6. Audit log v2: exactly one version-creation entry for `ai-company-os-api-staging` in the window, no deployment entry, and nothing on `ai-company-os-api`.
7. Token check (A1/A2): the local SHA-256 equals the reported `token_sha256`, and the token ≠ digest.

**STOP rule:** if any check fails or is uncertain, do not run W2. Leave the new version undeployed (0% traffic, harmless). Do not delete or patch it again, and do not use `force`. Report to the owner. Any value leak triggers `10_SECURITY_AND_RECOVERY_PLAN.md` (the token is treated as burned, and a new approval is needed).

## Remaining risks

1. Secret transport is unresolved (CHECK A). The owner must choose A1 or A2 (or A3). Until then the gate is BLOCKED.
2. The PATCH `/versions/latest` endpoint has never been exercised on this account. The RFC 7396 array-replace behaviour is mitigated by sending all 18 bindings, and the post-W1 diff verifies the result.
3. The read representation of a binding may omit server-side defaults (for example DO `script_name`). The post-W1 hash comparison of the 18 entries detects any drift.
4. `latest` can move if anyone uploads between the precheck and W1. Re-read immediately before W1, and stop on mismatch.
5. Code provenance: the module hash proves parity with `cd03f994`. That `cd03f994` was built from `3909fada` rests on the Stage C deploy record. A local rebuild hash was NOT_VERIFIED.
6. The connector holds write scope on the whole account (it is not least-privilege). The Auto-review gate cannot see `$file` content.
7. The Access JWT expires at 10:58 JST today. Execution needs a fresh JWT with the same iss/sub/email.
8. Queue depth is NOT_VERIFIED.

## Update 2026-10-11 ~10:14 JST: transport = A2

The owner chose A2, consenting to the method only. CHECK A is closed **by design** for A2: the approval token is generated, held, and sent by one local Mac process (`operator/c1-runner.mjs`) directly to api.cloudflare.com and api-staging.tungjp.store. It never passes through the connector, agent arguments, or model context. The owner's API token is entered through a hidden prompt into that process only. Mocked tests prove no secret reaches stdout or the receipt (see 20). The connector stays read-only (verification and audit). Residual: the owner's terminal environment (screen, clipboard). `$file`/connector transport remains rejected.
