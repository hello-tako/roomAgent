"""Guards for the Stage C operator planner. No remote call is made."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import staging_bootstrap as sb  # noqa: E402


class StagingBootstrapGuardTest(unittest.TestCase):
    def test_live_configs_stay_on_the_staging_side_of_the_public_worker(self):
        report = sb.inspect()
        self.assertEqual(report["result"], "PASS")
        self.assertEqual(report["remote_writes"], 0)
        self.assertEqual(report["staging_database_id"], sb.STAGING_D1)
        self.assertNotEqual(report["staging_database_id"], sb.PUBLIC_D1)

    def test_public_database_and_missing_approval_block_mutation(self):
        self.assertEqual(sb.mutation_blocked("apply-bootstrap", None), "BOOTSTRAP_APPROVAL_MISSING")
        public = {
            "human_approval_reference": "STAGE-C1-TEST",
            "plan_digest": "0" * 64,
            "canonical_plan": {
                "databaseId": sb.PUBLIC_D1,
                "databaseName": sb.PUBLIC_NAME,
                "execution": "remote-staging",
            },
        }
        encoded = json.dumps(public["canonical_plan"], sort_keys=True, separators=(",", ":")).encode()
        import hashlib

        public["plan_digest"] = hashlib.sha256(encoded).hexdigest()
        with tempfile.NamedTemporaryFile("w", delete=False) as handle:
            json.dump(public, handle)
            path = handle.name
        self.assertEqual(
            sb.mutation_blocked("apply-bootstrap", path),
            "PROTECTED_PUBLIC_DATABASE_TARGETED",
        )

    def test_a_harness_binding_in_config_is_rejected(self):
        staging = {
            "name": sb.STAGING_WORKER,
            "account_id": sb.STAGING_ACCOUNT,
            "workers_dev": False,
            "d1_databases": [
                {"database_name": sb.STAGING_NAME, "database_id": sb.STAGING_D1},
            ],
            "vars": {
                "STAGING_OPERATOR_BOOTSTRAP": "enabled",
                "STAGING_ACCOUNT_ID": sb.STAGING_ACCOUNT,
                "STAGING_DATABASE_ID": sb.STAGING_D1,
                "STAGING_DATABASE_NAME": sb.STAGING_NAME,
                "TEST_MIGRATIONS": "present",
            },
        }
        self.assertIn("TEST_HARNESS_MUST_NOT_BE_IN_CONFIG", sb.target_reasons(staging))

    def test_a_matching_remote_plan_still_does_not_write(self):
        import hashlib

        plan = {
            "databaseId": sb.STAGING_D1,
            "databaseName": sb.STAGING_NAME,
            "execution": "remote-staging",
        }
        encoded = json.dumps(plan, sort_keys=True, separators=(",", ":")).encode()
        payload = {
            "human_approval_reference": "STAGE-C1-TEST",
            "plan_digest": hashlib.sha256(encoded).hexdigest(),
            "canonical_plan": plan,
        }
        with tempfile.NamedTemporaryFile("w", delete=False) as handle:
            json.dump(payload, handle)
            path = handle.name
        self.assertEqual(
            sb.mutation_blocked("run-business-smoke", path),
            "REMOTE_MUTATION_REQUIRES_HUMAN_GATE",
        )


if __name__ == "__main__":
    unittest.main()
