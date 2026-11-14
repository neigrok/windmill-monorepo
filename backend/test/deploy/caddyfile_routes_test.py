#!/usr/bin/env python3
# The production Caddyfile in Caddy's own image, its upstreams stood in by Caddy answering with their name and port:
# which service and port each host and path reaches, and that the Cloudflare gate answers ahead of every route. The
# stand-in subscription service answers on its internal port too, so a route that reached it would show. Needs Docker.
from pathlib import Path
import secrets
import subprocess
import time
import unittest


CADDYFILE = Path(__file__).resolve().parents[2] / "deploy/Caddyfile"


class CaddyfileRoutesTest(unittest.TestCase):
    def setUp(self):
        self.network = "caddyfile-routes-" + secrets.token_hex(4)
        self.docker("network", "create", self.network)
        self.addCleanup(self.docker, "network", "rm", self.network)
        self.stand_in("server", ":8080")
        self.stand_in("subscriptions", ":8082-8083")

    def docker(self, *arguments):
        return subprocess.run(["docker", *arguments], capture_output=True, text=True, timeout=120,
                              check=True).stdout.strip()

    def stand_in(self, service, ports):
        container = self.docker("run", "-d", "--network", self.network, "--network-alias", service, "caddy:2",
                                "caddy", "respond", "--listen", ports, "--body", service + ":{{.Port}}")
        self.addCleanup(self.docker, "rm", "-f", container)

    def edge(self, cloudflare_ranges):
        container = self.docker("run", "-d", "--network", self.network, "-p", "127.0.0.1::443",
                                "-e", "DOMAIN_APP=app.localhost", "-e", "DOMAIN_API=api.localhost",
                                "-e", "ACME_EMAIL=ops@example.invalid", "-e", "CF_IPS=" + cloudflare_ranges,
                                "-v", str(CADDYFILE) + ":/etc/caddy/Caddyfile:ro", "caddy:2")
        self.addCleanup(self.docker, "rm", "-f", container)
        port = self.docker("port", container, "443/tcp").splitlines()[0].rsplit(":", 1)[1]
        for attempt in range(60):
            if self.answer(port, "app.localhost", "GET", "/v1/sync/hello")[0] != 0:
                return port
            time.sleep(0.5)
        raise AssertionError("the edge never answered: " + self.docker("logs", container))

    def answer(self, port, host, method, path):
        result = subprocess.run(["curl", "-sk", "--max-time", "5", "-X", method, "--resolve", f"{host}:{port}:127.0.0.1",
                                 "-w", "\n%{http_code}", f"https://{host}:{port}{path}"],
                                capture_output=True, text=True, timeout=30)
        body, status = result.stdout.rsplit("\n", 1)
        return int(status), body

    def routes(self, port):
        requests = [("app.localhost", "POST", "/v1/stores/app-store/notifications"),
                    ("app.localhost", "GET", "/v1/stores/app-store/notifications"),
                    ("api.localhost", "POST", "/v1/stores/app-store/notifications"),
                    ("app.localhost", "GET", "/v1/stores"),
                    ("app.localhost", "GET", "/v1/storesfront"),
                    ("app.localhost", "GET", "/v1/sync/hello"),
                    ("api.localhost", "GET", "/v1/sync/hello"),
                    ("app.localhost", "GET", "/internal/v1/feed"),
                    ("api.localhost", "GET", "/internal/v1/feed")]
        return {request: self.answer(port, *request) for request in requests}

    def test_store_doors_reach_the_public_port_and_every_other_path_stays_where_it_was(self):
        port = self.edge("0.0.0.0/0 ::/0")

        self.assertEqual(self.routes(port), {
            ("app.localhost", "POST", "/v1/stores/app-store/notifications"): (200, "subscriptions:8082"),
            ("app.localhost", "GET", "/v1/stores/app-store/notifications"): (200, "subscriptions:8082"),
            ("api.localhost", "POST", "/v1/stores/app-store/notifications"): (200, "subscriptions:8082"),
            ("app.localhost", "GET", "/v1/stores"): (200, "server:8080"),
            ("app.localhost", "GET", "/v1/storesfront"): (200, "server:8080"),
            ("app.localhost", "GET", "/v1/sync/hello"): (200, "server:8080"),
            ("api.localhost", "GET", "/v1/sync/hello"): (200, "server:8080"),
            ("app.localhost", "GET", "/internal/v1/feed"): (404, ""),
            ("api.localhost", "GET", "/internal/v1/feed"): (200, "server:8080")})

    def test_the_cloudflare_gate_answers_before_the_store_doors(self):
        port = self.edge("192.0.2.0/24")

        self.assertEqual(set(self.routes(port).values()), {(403, "")})


if __name__ == "__main__":
    unittest.main()
