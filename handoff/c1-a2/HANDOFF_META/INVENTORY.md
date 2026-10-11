# Public C1-A2 bundle inventory

All public operator `.mjs` source/tests, `fixtures/bindings18.json`, the PENDING owner template and W1 placeholder are controlled by `operator/SHA256SUMS`. Every public bundle file, including that inner manifest and HANDOFF metadata, is controlled by `BUNDLE_SHA256SUMS`. Both use bundle-root relative paths. Neither manifest hashes itself; outer hashes inner.

Operator components: runner; pure/CLI Access attestation; exact bundle integrity; durable attempt markers; secure private I/O and pinned child processes; secret-safety scanner. Their colocated test suites are executed by `pnpm test:operator` without credentials or live Cloudflare.

Private plan, original/fresh identity records, expected-email hash, owner approval, bootstrap token, attempt markers and receipts are intentionally excluded, ignored by Git/format/lint and prohibited from tracking. Execution validates modes/provenance/content separately. Public consistency does not authorize execution.

Detailed inventory is mechanically verifiable from both manifests; review/evidence documents are under `docs/reports/stage-c/` and bound by the exact implementation Git commit.
