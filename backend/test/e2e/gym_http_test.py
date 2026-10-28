import json
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

import anonymous_coach
import coach_live
from gym_http import SCHEMA, gym_headers


class GymHttpHeadersTest(unittest.TestCase):
    def test_schema_comes_from_the_current_product_registry_and_does_not_gate_mcp(self):
        registry = Path(__file__).resolve().parents[3] / "packages/api-contract/sync/gym.registry.json"
        self.assertEqual(SCHEMA, str(json.loads(registry.read_text())["version"]))
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


if __name__ == "__main__":
    unittest.main()
