import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import anonymous_coach
import coach_live
from gym_http import REGISTRY, SCHEMA, gym_headers


class GymHttpHeadersTest(unittest.TestCase):
    def test_schema_comes_from_the_current_product_registry_and_does_not_gate_mcp(self):
        self.assertEqual(SCHEMA, str(json.loads(REGISTRY.read_text())["version"]))
        for path in ["/v1/gym/exercises", "/v1/gym/ask", "/v1/gym/shared/fixture",
                     "/v1/gym/shared-logs/fixture", "/v1/gym/threads/fixture/attachments/fixture"]:
            self.assertEqual(gym_headers(path), {"Sync-Schema": SCHEMA})
        for path in ["/mcp", "/v1/ai/installations", "/v1/journal/export"]:
            self.assertEqual(gym_headers(path), {})

    def test_live_coach_and_anonymous_onboarding_probes_send_the_dynamic_header(self):
        for owner, method in [(coach_live.LiveCoachProof, "request"), (anonymous_coach.AnonymousCoachProof, "call")]:
            proof = owner.__new__(owner)
            proof.accounts = {"free": {"token": "fixture"}}
            response = MagicMock(status=200)
            response.read.return_value = b"{}"
            response.getheader.return_value = "application/json"
            response.getheaders.return_value = []
            with patch("http.client.HTTPConnection") as connection:
                connection.return_value.getresponse.return_value = response
                getattr(proof, method)("GET", "/v1/gym/exercises")
                self.assertEqual(connection.return_value.request.call_args.args[3]["Sync-Schema"], SCHEMA)

    def test_backend_only_layout_imports_both_live_helpers_from_the_configured_contract(self):
        with tempfile.TemporaryDirectory(prefix="windmill-carrier-contract-") as temporary:
            root = Path(temporary)
            relocated = root / "backend/test/e2e"
            relocated.mkdir(parents=True)
            for name in ["gym_http.py", "anonymous_coach.py", "coach_live.py"]:
                shutil.copyfile(Path(__file__).with_name(name), relocated / name)
            contract = root / "configured-contract"
            (contract / "sync").mkdir(parents=True)
            registry = json.loads(REGISTRY.read_text())
            registry["version"] += 1
            (contract / "sync/gym.registry.json").write_text(json.dumps(registry))
            result = subprocess.run([sys.executable, "-c", "import anonymous_coach, coach_live, gym_http; print(gym_http.SCHEMA)"],
                                    cwd=relocated, env=dict(os.environ, WM_API_CONTRACT_DIR=str(contract), PYTHONDONTWRITEBYTECODE="1"),
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, str(registry["version"]) + "\n")
            self.assertFalse((root / "packages").exists())

    def test_an_explicit_missing_contract_fails_clearly_without_falling_back_to_the_checkout(self):
        with tempfile.TemporaryDirectory(prefix="windmill-carrier-missing-") as temporary:
            missing = Path(temporary) / "absent-contract"
            result = subprocess.run([sys.executable, "-c", "import gym_http"], cwd=Path(__file__).parent,
                                    env=dict(os.environ, WM_API_CONTRACT_DIR=str(missing), PYTHONDONTWRITEBYTECODE="1"),
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(f"Gym HTTP carrier registry is missing at {missing / 'sync/gym.registry.json'}", result.stderr)
            self.assertIn("set WM_API_CONTRACT_DIR", result.stderr)


if __name__ == "__main__":
    unittest.main()
