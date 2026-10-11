# Source inventory (t13u section 2) — workspace ~/Documents/ROOMAGENT_STAGE_C1_BOOTSTRAP_PREPARATION
| Item | Status | Path |
|---|---|---|
| A2 runner | EXISTS | operator/c1-runner.mjs |
| Access attestation script | EXISTS | operator/attest-access-identity.mjs (spawned by runner as child process, not imported) |
| Related tests | EXISTS (single file) | operator/c1-runner.test.mjs (13 tests, node:test). No operator/tests/ directory -> MISSING as a directory; no tests for attest-access-identity.mjs -> MISSING |
| Fixtures | EXISTS | operator/fixtures/bindings18.json |
| Execution helpers | NONE SEPARATE (all helpers inline in c1-runner.mjs) |  |
| W1 body template (runtime input) | EXISTS | 19_W1_REQUEST_BODY_PLACEHOLDER.json (read by runner at ../ relative to operator/) |
| Owner approval template | EXISTS | operator/c1-owner-approval.TEMPLATE.txt (human_owner_approval=PENDING) |
| operator/SHA256SUMS | EXISTS | 6 entries, all verified OK |
| Dependency manifests (package.json / lockfile / .nvmrc) | MISSING | none anywhere in workspace |
| A2 execution configuration | EXISTS (embedded) | REAL_CONFIG frozen object in c1-runner.mjs L22+; no separate config file |
| 20_A2_EXECUTION_PACKAGE.md | EXISTS | 20_A2_EXECUTION_PACKAGE.md |
| operator/private/ | EXISTS, EXCLUDED | c1-canonical-plan.json, c1-access-attestation.json, expected-email.sha256 |

## Imports
c1-runner.mjs: node:crypto (createHash, randomBytes), node:fs, node:path, node:url, dynamic node:child_process (realDeps only).
attest-access-identity.mjs: node:crypto, node:fs (multi-line import), node:fs/promises, node:path, node:url.
c1-runner.test.mjs: node:test, node:assert/strict, node:fs, node:os, node:path, ./c1-runner.mjs, ./fixtures/bindings18.json.
No third-party npm dependencies. Unlisted runtime dependencies (not in SHA256SUMS, outside bundle):
- Node.js runtime (tested on v25.9.0; no engines pin)
- `cloudflared` CLI (spawned: `access token -app=...`, `access login`) — external binary, unpinned
- operator/private/* files (private, excluded by design)
- ../19_W1_REQUEST_BODY_PLACEHOLDER.json (in SHA256SUMS and in bundle)
