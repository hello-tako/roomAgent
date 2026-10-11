# Baseline gaps and implementation closure

The original handoff's format failure (12 files), missing integrity/approval binding, absent W2 durability/replay protection, incomplete 13-test fault coverage, untested Access verifier, unchecked child exits/PATH execution, missing private-file protections and missing CI integration have source patches and regression tests.

The authoritative implementation ledger and test matrix are in `docs/reports/stage-c/C1_A2_SECURITY_HARDENING_REPORT.md` and `C1_A2_INDEPENDENT_REVIEW_PACKAGE.md`. The original handoff commit and CI failure remain historical, not validation of changed source. No old review/checksum is carried forward as approval.

Remaining owner/reviewer decisions are explicit: externally trusted exact-source/digest approval; trusted POSIX filesystem/running process and directory fsync; binary pins; private identity/plan provenance and plaintext A2 token retention; Cloudflare permission acceptance; exclusive change window/background D1 writers; live Access forwarding/release/runtime evidence. These are not implemented by declaring a gate PASS. Independent review, mutation approval, C1 live receipt, C2 and production certification remain PENDING/NOT_VERIFIED.
