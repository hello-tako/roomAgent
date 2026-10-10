"""Operator planner for the Stage C staging bootstrap.

Default mode is plan-only. This process never writes remote D1. Remote writes go
through the staging Worker after a separate human approval sets the approval digest
secret. The public Worker and its database are rejected before any plan is emitted.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

from d1_preflight import load_jsonc

ROOT = Path(__file__).resolve().parents[1]
STAGING_CONFIG = ROOT / "apps" / "api" / "wrangler.staging.jsonc"
BASE_CONFIG = ROOT / "apps" / "api" / "wrangler.jsonc"
PUBLIC_D1 = "a4b622e6-978b-4ce2-ad82-cd0eb1cc4387"
PUBLIC_NAME = "ai-company-os"
PUBLIC_WORKER = "ai-company-os-api"
STAGING_D1 = "a6b8c2f6-d697-442b-8374-5006246324b2"
STAGING_NAME = "ai-company-os-staging"
STAGING_ACCOUNT = "ef250a88911fd24073cb73d1c07e0218"
STAGING_WORKER = "ai-company-os-api-staging"

MUTATION_COMMANDS = {"apply-bootstrap", "issue-session-smoke", "run-business-smoke"}


def target_reasons(staging):
    reasons = []
    if staging.get("name") != STAGING_WORKER:
        reasons.append("STAGING_WORKER_MISMATCH")
    if staging.get("name") == PUBLIC_WORKER:
        reasons.append("PROTECTED_PUBLIC_WORKER_TARGETED")
    if staging.get("account_id") != STAGING_ACCOUNT:
        reasons.append("CLOUDFLARE_ACCOUNT_MISMATCH")
    databases = staging.get("d1_databases") or []
    database = databases[0] if len(databases) == 1 else None
    if database is None:
        reasons.append("D1_DATABASE_COUNT")
    else:
        if database.get("database_name") != STAGING_NAME:
            reasons.append("D1_DATABASE_NAME_MISMATCH")
        if database.get("database_id") != STAGING_D1:
            reasons.append("D1_DATABASE_UUID_MISMATCH")
        if database.get("database_id") == PUBLIC_D1 or database.get("database_name") == PUBLIC_NAME:
            reasons.append("PROTECTED_PUBLIC_DATABASE_TARGETED")
    if staging.get("workers_dev") is not False:
        reasons.append("STAGING_PUBLIC_WORKERS_DEV_ENABLED")
    vars_ = staging.get("vars") or {}
    if vars_.get("STAGING_OPERATOR_BOOTSTRAP") != "enabled":
        reasons.append("STAGING_BOOTSTRAP_FLAG_NOT_ENABLED")
    if vars_.get("STAGING_ACCOUNT_ID") != STAGING_ACCOUNT:
        reasons.append("STAGING_ACCOUNT_VAR_MISMATCH")
    if vars_.get("STAGING_DATABASE_ID") != STAGING_D1:
        reasons.append("STAGING_DATABASE_VAR_MISMATCH")
    if vars_.get("STAGING_DATABASE_NAME") != STAGING_NAME:
        reasons.append("STAGING_DATABASE_NAME_VAR_MISMATCH")
    if vars_.get("STAGING_RUNTIME") != "cloudflare":
        reasons.append("STAGING_RUNTIME_NOT_PINNED")
    if staging.get("account_id") != vars_.get("STAGING_ACCOUNT_ID"):
        reasons.append("ACCOUNT_BINDING_VAR_DIVERGENCE")
    if database is not None and database.get("database_id") != vars_.get("STAGING_DATABASE_ID"):
        reasons.append("DATABASE_BINDING_VAR_DIVERGENCE")
    for forbidden in (
        "BOOTSTRAP_APPROVAL_DIGEST",
        "BOOTSTRAP_APPROVAL_TOKEN",
        "STAGING_RELEASE_SHA",
        "TEST_MIGRATIONS",
        "BOOTSTRAP_LOCAL_HARNESS",
    ):
        if forbidden in vars_:
            reasons.append(f"{forbidden}_MUST_NOT_BE_IN_CONFIG")
    return reasons


def inspect():
    staging = load_jsonc(STAGING_CONFIG)
    base = load_jsonc(BASE_CONFIG)
    reasons = target_reasons(staging)
    base_ids = [item.get("database_id") for item in base.get("d1_databases") or []]
    if PUBLIC_D1 not in base_ids and "00000000-0000-4000-8000-000000000001" not in base_ids:
        reasons.append("BASE_CONFIG_UNEXPECTED")
    if base.get("name") != PUBLIC_WORKER:
        reasons.append("BASE_WORKER_UNEXPECTED")
    base_vars = base.get("vars") or {}
    if "STAGING_OPERATOR_BOOTSTRAP" in base_vars:
        reasons.append("PUBLIC_CONFIG_ENABLES_BOOTSTRAP")
    if "TEST_MIGRATIONS" in base_vars or "BOOTSTRAP_LOCAL_HARNESS" in base_vars:
        reasons.append("PUBLIC_CONFIG_ENABLES_HARNESS")
    if base_vars.get("STAGING_RUNTIME") == "cloudflare":
        reasons.append("PUBLIC_CONFIG_MARKED_STAGING_RUNTIME")
    return {
        "tool": "roomagent-stage-c-bootstrap",
        "mode": "PLAN_ONLY",
        "remote_writes": 0,
        "reasons": reasons,
        "result": "PASS" if not reasons else "FAIL",
        "staging_worker": staging.get("name"),
        "staging_database_id": (staging.get("d1_databases") or [{}])[0].get("database_id"),
        "protected_public_worker": PUBLIC_WORKER,
        "protected_public_database_id": PUBLIC_D1,
    }


def mutation_blocked(command, approval_file):
    if command not in MUTATION_COMMANDS:
        return None
    if not approval_file:
        return "BOOTSTRAP_APPROVAL_MISSING"
    payload = json.loads(Path(approval_file).read_text())
    plan = payload.get("canonical_plan")
    digest = payload.get("plan_digest")
    reference = payload.get("human_approval_reference")
    if not isinstance(plan, dict) or not isinstance(digest, str) or not isinstance(reference, str):
        return "BOOTSTRAP_APPROVAL_MISSING"
    encoded = json.dumps(plan, sort_keys=True, separators=(",", ":")).encode()
    if hashlib.sha256(encoded).hexdigest() != digest:
        return "APPROVAL_DIGEST_MISMATCH"
    if plan.get("databaseId") == PUBLIC_D1 or plan.get("databaseName") == PUBLIC_NAME:
        return "PROTECTED_PUBLIC_DATABASE_TARGETED"
    if plan.get("databaseId") != STAGING_D1 or plan.get("execution") != "remote-staging":
        return "TARGET_REJECTED"
    return "REMOTE_MUTATION_REQUIRES_HUMAN_GATE"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=["inspect", "preflight", "plan", "verify", *sorted(MUTATION_COMMANDS)],
    )
    parser.add_argument("--approval-file")
    args = parser.parse_args(argv)
    report = inspect()
    report["command"] = args.command
    if args.command == "inspect":
        report["mode"] = "INSPECT"
    elif args.command == "preflight":
        report["mode"] = "PREFLIGHT"
    elif args.command == "plan":
        report["mode"] = "PLAN_ONLY"
        report["plan"] = {
            "environment": "staging",
            "execution": "remote-staging",
            "accountId": STAGING_ACCOUNT,
            "databaseId": STAGING_D1,
            "databaseName": STAGING_NAME,
            "schemaVersion": "0015",
            "orgName": "roomAgent Staging Smoke",
            "expectedPreState": "uninitialized",
            "expected_writes": "one D1 batch after a separate human gate",
            "remote_writes": 0,
            "approval": "random BOOTSTRAP_APPROVAL_TOKEN plus pinned BOOTSTRAP_APPROVAL_DIGEST",
            "release_sha": "STAGING_RELEASE_SHA secret must equal plan.repositorySha",
            "retirement_after_verified": [
                "remove var STAGING_OPERATOR_BOOTSTRAP",
                "delete secret BOOTSTRAP_APPROVAL_TOKEN",
                "delete secret BOOTSTRAP_APPROVAL_DIGEST",
                "delete secret STAGING_RELEASE_SHA",
            ],
        }
    elif args.command == "verify":
        report["mode"] = "VERIFY"
        report["checks"] = report["reasons"] or ["staging target pins match"]
    elif args.command in MUTATION_COMMANDS:
        report["mode"] = "MUTATION_REFUSED"
        report["mutation_block"] = mutation_blocked(args.command, args.approval_file)
        report["result"] = "BLOCKED"
        report["remote_writes"] = 0
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["result"] == "PASS" else 2


if __name__ == "__main__":
    sys.exit(main())
