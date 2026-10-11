# Known gaps vs t13u sections 3/4 — input for Hoplite (NOT fixed by Grokbot)
1. No package.json / lockfile / engines pin. Node version (tested v25.9.0) and test command are undocumented in-tree.
2. No operator/tests/ directory: tests are a single operator/c1-runner.test.mjs; attest-access-identity.mjs has NO tests.
3. Fixture vs live metadata: operator/fixtures/bindings18.json and the 18 bindings in 19_W1_REQUEST_BODY_PLACEHOLDER.json are a
   frozen snapshot (hash 1feacf2a...). Runner does compare live bindings against this hash pre-W1 (DRIFT_BINDINGS), but W1 body
   is built from the template file, not from the freshly-read live version metadata; t13u requires W1 to preserve the live bindings.
   Decide: build from live read + assert equal to pinned hash, or keep template + document.
4. No self-integrity check: runner never verifies its own SHA-256 or operator/SHA256SUMS before --execute.
5. SHA256SUMS does not cover the private plan/attestation inputs (by design) nor HANDOFF metadata; no deterministic full-bundle manifest in operator/.
6. Attempt markers: W1 (c1-w1-attempted) and POST (c1-post-attempted) exist; NO W2 marker. Only the W1 marker is checked at startup.
   Markers written with O_EXCL|0600 but no fsync of file/dir (durability, t13u req 19). Not one marker per mutating op.
7. Missing negative tests requested in t10u/t13u: explicit HTTP 403 from CF API (fail-closed), expired Access JWT, Access identity mismatch
   (FRESH_IDENTITY_MISMATCH path), interrupted W2 (network error during deployment POST), unexpected response schema,
   arbitrary non-staging D1 UUID (only public D1 tested), wrong (non-public) Worker name, pre-W1 source/module hash mismatch,
   marker durability/replay after W2 or POST interruption.
8. Preparation mode is "--dry-run" default; t13u says "non-mutating preparation mode" - naming fine, but there is no explicit
   "--prepare" vs "--execute" authorization-evidence check beyond the approval file + TTY.
9. Approval token is persisted once to operator/private (0600) to survive crashes; a secret at rest on disk; Muse/Owner must accept or change —
   needs explicit justification or change. Also needs cleanup/rotation policy after C1.
10. cloudflared is an unpinned external dependency (spawned by name via PATH); no path/version pin.
11. No CLI --help / usage doc in-tree; run instructions live only in 20_A2_EXECUTION_PACKAGE.md.
12. Reviewer cannot recompute the live identity-bound digest from the public bundle (private plan excluded) — algorithm only
    (canonicalPlan + sha256hex in runner, exercised by tests with fake identity).
