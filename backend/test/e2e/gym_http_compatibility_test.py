import http.client
import json
import os
from pathlib import Path
import unittest
from urllib.parse import urlsplit

from gym_http import SCHEMA


@unittest.skipUnless(os.environ.get("WM_GYM_HTTP_ORIGIN"), "set WM_GYM_HTTP_ORIGIN to an isolated local server")
class GymHttpCompatibilityTest(unittest.TestCase):
    def request(self, method, path, schema=None, extra=None):
        origin = urlsplit(os.environ["WM_GYM_HTTP_ORIGIN"])
        self.assertEqual(origin.hostname, "127.0.0.1")
        self.assertEqual(origin.scheme, "http")
        connection = http.client.HTTPConnection(origin.hostname, origin.port, timeout=10)
        headers = {"Content-Type": "application/json", **(extra or {})}
        if schema is not None:
            headers["Sync-Schema"] = schema
        try:
            connection.request(method, path, "{}" if method in ("POST", "PUT") else None, headers)
            response = connection.getresponse()
            raw = response.read()
            return response.status, json.loads(raw) if raw and "json" in response.getheader("Content-Type", "") else None, dict(response.getheaders())
        finally:
            connection.close()

    def test_every_active_json_image_share_import_and_stream_mount_is_guarded(self):
        routes = [("GET", "/exercises"), ("GET", "/exercises/last"), ("GET", "/exercises/fixture01/record"),
                  ("POST", "/sessions/import"), ("GET", "/sessions"), ("GET", "/sessions/fixture01"),
                  ("GET", "/sessions/fixture01/review"), ("GET", "/last"), ("GET", "/routines"),
                  ("GET", "/routines/fixture01"), ("GET", "/proposals"), ("GET", "/proposals/fixture01"),
                  ("GET", "/preferences"), ("GET", "/notes"), ("GET", "/bodyweight"), ("GET", "/stats"),
                  ("PUT", "/threads/fixture01/attachments/fixture01"), ("GET", "/threads/fixture01/attachments/fixture01"),
                  ("POST", "/threads/fixture01/generations/fixture01/routines/fixture01/confirm"),
                  ("POST", "/threads/fixture01/generations/fixture01/stop"), ("GET", "/threads"),
                  ("GET", "/threads/fixture01"), ("DELETE", "/threads/fixture01"),
                  ("POST", "/sessions/fixture01/share"), ("DELETE", "/sessions/fixture01/share"),
                  ("GET", "/shared/" + "A" * 43), ("GET", "/history"), ("POST", "/log-shares"),
                  ("GET", "/log-shares"), ("DELETE", "/log-shares/fixture01"), ("GET", "/shared-logs/" + "A" * 43)]
        if os.environ.get("WM_GYM_HTTP_VENDOR") == "1":
            routes += [("POST", "/ask"), ("POST", "/coach/turns"), ("GET", "/coach/turns/fixture01"),
                       ("POST", "/coach/turns/fixture01/results"), ("POST", "/coach/turns/fixture01/stop")]
        if os.environ.get("WM_GYM_HTTP_ONBOARDING") == "1":
            routes += [("POST", "/coach/onboarding"), ("GET", "/coach/onboarding/fixture01")]
        registry = Path(__file__).resolve().parents[3] / "packages/api-contract/sync/gym.registry.json"
        old = str(json.loads(registry.read_text())["minVersion"] - 1)
        for method, path in routes:
            with self.subTest(method=method, path=path):
                for schema in [None, old]:
                    status, body, _ = self.request(method, "/v1/gym" + path, schema, {"Accept": "text/event-stream"})
                    self.assertEqual((status, body["code"]), (426, "client-update-required"))
                status, body, _ = self.request(method, "/v1/gym" + path, "malformed")
                self.assertEqual((status, body["code"]), (400, "malformed"))
                status, body, _ = self.request(method, "/v1/gym" + path, SCHEMA)
                self.assertIn(status, [400, 401, 404, 503])
                self.assertNotEqual((body or {}).get("code"), "client-update-required")

    def test_retired_writes_unknown_routes_and_unrelated_paths_preserve_their_status(self):
        for schema in [None, "malformed", SCHEMA]:
            status, body, _ = self.request("POST", "/v1/gym/sessions", schema)
            self.assertEqual((status, body["code"]), (410, "client-update-required"))
            self.assertEqual(self.request("GET", "/v1/gym/unknown/fixture", schema)[0], 404)
        self.assertEqual(self.request("GET", "/v1/journal/pages")[0], 401)

    def test_options_allows_schema_for_private_photo_get_and_put(self):
        for method in ["GET", "PUT"]:
            status, _, headers = self.request("OPTIONS", "/v1/gym/threads/fixture01/attachments/fixture01", extra={
                "Origin": os.environ["WM_GYM_HTTP_ORIGIN"], "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": "sync-schema,authorization,content-type"})
            self.assertEqual(status, 204)
            headers = {name.lower(): value for name, value in headers.items()}
            self.assertEqual(headers["access-control-allow-origin"], os.environ["WM_GYM_HTTP_ORIGIN"])
            self.assertIn("sync-schema", headers["access-control-allow-headers"])

    def test_absent_conditional_routes_remain_404(self):
        routes = []
        if os.environ.get("WM_GYM_HTTP_VENDOR") != "1":
            routes += [("POST", "/ask"), ("POST", "/coach/turns"), ("GET", "/coach/turns/fixture01"),
                       ("POST", "/coach/turns/fixture01/results"), ("POST", "/coach/turns/fixture01/stop")]
        if os.environ.get("WM_GYM_HTTP_ONBOARDING") != "1":
            routes += [("POST", "/coach/onboarding"), ("GET", "/coach/onboarding/fixture01")]
        for method, path in routes:
            with self.subTest(method=method, path=path):
                self.assertEqual(self.request(method, "/v1/gym" + path)[0], 404)


if __name__ == "__main__":
    unittest.main()
