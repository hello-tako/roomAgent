# roomAgent C1 A2 — source handoff bundle (roomagent-c1-a2-handoff-20261011T105429JST)
Created by Grokbot (source handoff only, t13u section 2). Not a review, not an approval, not a mutation authorization.
GATE B, E, F remain PENDING. Do NOT run with --execute.

## Layout (original relative paths preserved)
- operator/c1-runner.mjs, operator/attest-access-identity.mjs, operator/c1-runner.test.mjs
- operator/fixtures/bindings18.json, operator/c1-owner-approval.TEMPLATE.txt (PENDING), operator/SHA256SUMS
- 18_FINAL_C1_APPROVAL_MANIFEST.md, 19_MUTATION_GATE_FINAL_CHECK.md, 19_W1_REQUEST_BODY_PLACEHOLDER.json, 20_A2_EXECUTION_PACKAGE.md
- HANDOFF_META/ (SOURCE_AUTHORITY.txt, CLOUDFLARE_ENDPOINTS.md, INVENTORY.md, KNOWN_GAPS_FOR_HOPLITE.md, OFFLINE_TEST_RESULT.txt)
- BUNDLE_SHA256SUMS (every file in bundle except itself, sorted relative paths)
- EXCLUDED: operator/private/ (canonical plan with identity, attestation record, expected-email hash), any approval/marker/receipt files.

## Verify integrity (offline)
  shasum -a 256 -c BUNDLE_SHA256SUMS
  shasum -a 256 -c operator/SHA256SUMS

## Run offline tests (no network, dummy credentials only; Node >= 20 with node:test; tested on v25.9.0)
  node --test operator/c1-runner.test.mjs
Expected: 13 pass, 0 fail. Tests mock every endpoint (https://mock.invalid) and use fake identity/tokens.

## Dry-run note
`node operator/c1-runner.mjs` (default --dry-run) needs operator/private/c1-access-attestation.json and c1-canonical-plan.json,
which are intentionally excluded; from this bundle it will STOP. Use the tests instead. Never pass --execute, never
supply a real Cloudflare API token or Access JWT.
