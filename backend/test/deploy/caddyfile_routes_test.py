#!/usr/bin/env python3
# The production Caddyfile in Caddy's own image, its upstreams stood in by Caddy answering with their name and port:
# which service and port each host and path reaches, that the Cloudflare gate answers ahead of every route, and that the
# App Store's door answers only Apple's subnet. The stand-in subscription service answers on its internal port too, so a
# route that reached it would show. Needs Docker.
from pathlib import Path
import base64
import hashlib
import http.server
import json
import socket
import ssl
import tempfile
import threading
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
        class AiHandler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def do_PUT(self):
                self.do_GET()
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.headers.get("Upgrade", "").lower() == "websocket":
                    key = self.headers["Sec-WebSocket-Key"]
                    accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                    self.send_response(101)
                    self.send_header("Connection", "Upgrade")
                    self.send_header("Upgrade", "websocket")
                    self.send_header("Sec-WebSocket-Accept", accept)
                    self.send_header("Sec-WebSocket-Protocol", "wm-live.v1")
                    self.end_headers()
                    body = b'{"type":"started"}'
                    self.wfile.write(bytes([0x81, len(body)]) + body)
                    self.wfile.flush()
                    return
                body = json.dumps({key: self.headers.get(key) for key in ("Cookie", "X-Windmill-Installation", "Authorization", "Sec-WebSocket-Protocol")}) if self.path in {"/v1/calls/headers", "/v1/pictures/headers"} else "ai:8084"
                self.send_response(200)
                self.send_header("Content-Length", str(len(body.encode())))
                self.end_headers()
                self.wfile.write(body.encode())

        server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), AiHandler)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        directory = tempfile.TemporaryDirectory(prefix="ai-caddy-upstream-")
        self.addCleanup(directory.cleanup)
        config = Path(directory.name) / "Caddyfile"
        config.write_text(":8084 {\n reverse_proxy host.docker.internal:" + str(server.server_port) + "\n}\n:8085 {\n respond ai:8085\n}\n")
        self.ai_container = self.docker("run", "-d", "--network", self.network, "--network-alias", "ai",
            "--add-host", "host.docker.internal:host-gateway", "-v", str(config) + ":/etc/caddy/Caddyfile:ro", "caddy:2")
        self.addCleanup(self.docker, "rm", "-f", self.ai_container)
        self.edges = {}
        maintenance = tempfile.TemporaryDirectory(prefix="caddy-maintenance-")
        self.addCleanup(maintenance.cleanup)
        self.maintenance = Path(maintenance.name)
        web = tempfile.TemporaryDirectory(prefix="caddy-web-")
        self.addCleanup(web.cleanup)
        self.web = Path(web.name)

    def docker(self, *arguments):
        result = subprocess.run(["docker", *arguments], capture_output=True, text=True, timeout=120, check=True)
        return (result.stdout + (result.stderr if arguments[0] == "logs" else "")).strip()

    def stand_in(self, service, ports):
        container = self.docker("run", "-d", "--network", self.network, "--network-alias", service, "caddy:2",
                                "caddy", "respond", "--listen", ports, "--body", service + ":{{.Port}}")
        self.addCleanup(self.docker, "rm", "-f", container)

    def edge(self, cloudflare_ranges):
        container = self.docker("run", "-d", "--network", self.network, "-p", "127.0.0.1::443",
                                "-e", "DOMAIN_APP=app.localhost", "-e", "DOMAIN_API=api.localhost",
                                "-e", "ACME_EMAIL=ops@example.invalid", "-e", "CF_IPS=" + cloudflare_ranges,
                                "-v", str(CADDYFILE) + ":/etc/caddy/Caddyfile:ro",
                                "-v", str(self.maintenance) + ":/srv/windmill-maintenance:ro",
                                "-v", str(self.web) + ":/srv/windmill-web:ro", "caddy:2")
        self.addCleanup(self.docker, "rm", "-f", container)
        port = self.docker("port", container, "443/tcp").splitlines()[0].rsplit(":", 1)[1]
        for attempt in range(60):
            if self.answer(port, "app.localhost", "GET", "/v1/sync/hello")[0] != 0:
                self.edges[port] = container
                return port
            time.sleep(0.5)
        raise AssertionError("the edge never answered: " + self.docker("logs", container))

    def answer(self, port, host, method, path, client="17.58.0.1"):
        result = subprocess.run(["curl", "-sk", "--max-time", "5", "-X", method, "--resolve", f"{host}:{port}:127.0.0.1",
                                 "-H", "CF-Connecting-IP: " + client, "-w", "\n%{http_code}",
                                 f"https://{host}:{port}{path}"],
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
                    ("api.localhost", "GET", "/internal/v1/feed"),
                    ("app.localhost", "GET", "/v1/allowance"),
                    ("api.localhost", "PUT", "/v1/pictures/example"),
                    ("api.localhost", "POST", "/v1/ai/passes"),
                    ("api.localhost", "GET", "/v1/calls/example/result"),
                    ("app.localhost", "GET", "/v1/allowance-extra"),
                    ("app.localhost", "GET", "/v1/calls"),
                    ("app.localhost", "GET", "/internal/v1/budgets")]
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
            ("api.localhost", "GET", "/internal/v1/feed"): (200, "server:8080"),
            ("app.localhost", "GET", "/v1/allowance"): (200, "ai:8084"),
            ("api.localhost", "PUT", "/v1/pictures/example"): (200, "ai:8084"),
            ("api.localhost", "POST", "/v1/ai/passes"): (200, "server:8080"),
            ("api.localhost", "GET", "/v1/calls/example/result"): (200, "ai:8084"),
            ("app.localhost", "GET", "/v1/allowance-extra"): (200, "server:8080"),
            ("app.localhost", "GET", "/v1/calls"): (200, "server:8080"),
            ("app.localhost", "GET", "/internal/v1/budgets"): (404, "")})

    def test_a_pause_answers_every_path_on_both_hosts_503_until_it_is_lifted_and_the_gate_still_answers_first(self):
        port = self.edge("0.0.0.0/0 ::/0")
        routes = self.routes(port)
        paused = "Windmill is down for a planned update and will be back shortly."
        (self.maintenance / "on").write_text("roadmap cutover 1-1\n")

        self.assertEqual(self.routes(port), {request: (503, paused) for request in routes})
        for host, path in (("app.localhost", "/"), ("app.localhost", "/roadmap"), ("app.localhost", "/mcp"), ("api.localhost", "/robots.txt")):
            self.assertEqual(self.answer(port, host, "GET", path), (503, paused))
        headers = subprocess.run(["curl", "-sk", "--max-time", "5", "-o", "/dev/null", "-D", "-", "--resolve",
                                  f"app.localhost:{port}:127.0.0.1", "-H", "CF-Connecting-IP: 17.58.0.1",
                                  f"https://app.localhost:{port}/v1/sync/hello"], capture_output=True, text=True, timeout=30).stdout.lower()
        self.assertIn("\nretry-after: 600\n", headers)
        self.assertIn("\ncache-control: no-store\n", headers)
        self.assertEqual(self.answer(port, "app.localhost", "GET", "/.well-known/acme-challenge/token")[0], 404)
        outside = self.edge("192.0.2.0/24")
        self.assertEqual(set(self.routes(outside).values()), {(403, "")})

        (self.maintenance / "on").unlink()
        self.assertEqual(self.routes(port), routes)

    def test_the_association_file_answers_as_json_from_the_web_root_paused_or_not_and_its_neighbours_answer_as_before(self):
        association = '{"applinks": {"details": [{"appIDs": ["ABCDE12345.works.windmill.app"]}]}}\n'
        (self.web / ".well-known").mkdir()
        (self.web / ".well-known/apple-app-site-association").write_text(association)
        (self.web / "404.html").write_text("not found\n")
        served = (200, "application/json", association)
        missing = (404, "text/html; charset=utf-8", "not found\n")
        paused = (503, "text/plain; charset=utf-8", "Windmill is down for a planned update and will be back shortly.")
        proxied = (200, "text/plain; charset=utf-8", "server:8080")

        def answers(port):
            typed = {}
            for host, path in (("app.localhost", "/.well-known/apple-app-site-association"), ("app.localhost", "/.well-known/"),
                               ("app.localhost", "/.well-known/assetlinks.json"),
                               ("app.localhost", "/.well-known/oauth-protected-resource"),
                               ("api.localhost", "/.well-known/apple-app-site-association")):
                result = subprocess.run(["curl", "-sk", "--max-time", "5", "--resolve", f"{host}:{port}:127.0.0.1",
                                         "-H", "CF-Connecting-IP: 17.58.0.1", "-w", "\n%{http_code}\n%{content_type}",
                                         f"https://{host}:{port}{path}"], capture_output=True, text=True, timeout=30)
                body, status, content_type = result.stdout.rsplit("\n", 2)
                typed[host, path] = (int(status), content_type, body)
            return typed

        port = self.edge("0.0.0.0/0 ::/0")
        self.assertEqual(answers(port), {
            ("app.localhost", "/.well-known/apple-app-site-association"): served,
            ("app.localhost", "/.well-known/"): missing,
            ("app.localhost", "/.well-known/assetlinks.json"): missing,
            ("app.localhost", "/.well-known/oauth-protected-resource"): proxied,
            ("api.localhost", "/.well-known/apple-app-site-association"): proxied})

        (self.maintenance / "on").write_text("planned\n")
        self.assertEqual(answers(port), {
            ("app.localhost", "/.well-known/apple-app-site-association"): served,
            ("app.localhost", "/.well-known/"): paused,
            ("app.localhost", "/.well-known/assetlinks.json"): paused,
            ("app.localhost", "/.well-known/oauth-protected-resource"): paused,
            ("api.localhost", "/.well-known/apple-app-site-association"): proxied})
        self.assertEqual(set(answers(self.edge("192.0.2.0/24")).values()), {(403, "", "")})

        (self.maintenance / "on").unlink()
        (self.web / ".well-known/apple-app-site-association").unlink()
        self.assertEqual(answers(port), {
            ("app.localhost", "/.well-known/apple-app-site-association"): missing,
            ("app.localhost", "/.well-known/"): missing,
            ("app.localhost", "/.well-known/assetlinks.json"): missing,
            ("app.localhost", "/.well-known/oauth-protected-resource"): proxied,
            ("api.localhost", "/.well-known/apple-app-site-association"): proxied})

    def test_every_shelf_page_s_short_address_redirects_onto_its_file(self):
        port = self.edge("0.0.0.0/0 ::/0")
        pages = ("pricing", "privacy", "terms", "refunds", "changelog", "connect", "support")
        located = {}
        for page in pages:
            result = subprocess.run(["curl", "-sk", "--max-time", "5", "--resolve", f"app.localhost:{port}:127.0.0.1",
                                     "-H", "CF-Connecting-IP: 17.58.0.1", "-o", "/dev/null",
                                     "-w", "%{http_code} %{redirect_url}", f"https://app.localhost:{port}/{page}"],
                                    capture_output=True, text=True, timeout=30)
            located[page] = result.stdout
        self.assertEqual(located, {page: f"301 https://app.localhost:{port}/{page}.html" for page in pages})

    def test_unhashed_root_scripts_and_styles_revalidate_and_hashed_assets_are_kept_for_good(self):
        (self.web / "assets").mkdir()
        for name in ("sw.js", "appearance.js", "chrome.css", "assets/app-1a2b3c.js", "pricing.html"):
            (self.web / name).write_text("file\n")
        port = self.edge("0.0.0.0/0 ::/0")
        policy = {}
        for path in ("/sw.js", "/appearance.js", "/chrome.css", "/assets/app-1a2b3c.js", "/pricing.html"):
            result = subprocess.run(["curl", "-sk", "--max-time", "5", "--resolve", f"app.localhost:{port}:127.0.0.1",
                                     "-H", "CF-Connecting-IP: 17.58.0.1", "-o", "/dev/null",
                                     "-w", "%{http_code} %header{cache-control}", f"https://app.localhost:{port}{path}"],
                                    capture_output=True, text=True, timeout=30)
            policy[path] = result.stdout
        self.assertEqual(policy, {"/sw.js": "200 no-cache", "/appearance.js": "200 no-cache", "/chrome.css": "200 no-cache",
                                  "/assets/app-1a2b3c.js": "200 public, max-age=31536000, immutable",
                                  "/pricing.html": "200 "})

    def test_the_app_store_door_answers_apple_s_subnet_alone(self):
        port = self.edge("0.0.0.0/0 ::/0")
        path = "/v1/stores/app-store/notifications"

        answers = {client: self.answer(port, "app.localhost", "POST", path, client)
                   for client in ["17.0.0.1", "17.255.255.254", "170.1.2.3", "18.0.0.1", "117.0.0.1",
                                  "17.1.2.3, 203.0.113.9", "2620:149::1", ""]}

        self.assertEqual(answers, {
            "17.0.0.1": (200, "subscriptions:8082"),
            "17.255.255.254": (200, "subscriptions:8082"),
            "170.1.2.3": (403, ""),
            "18.0.0.1": (403, ""),
            "117.0.0.1": (403, ""),
            "17.1.2.3, 203.0.113.9": (403, ""),
            "2620:149::1": (403, ""),
            "": (403, "")})
        self.assertEqual(self.answer(port, "api.localhost", "POST", path, "203.0.113.9"), (403, ""))
        self.assertEqual(self.answer(port, "app.localhost", "GET", "/v1/stores/play-store/notifications", "203.0.113.9"),
                         (200, "subscriptions:8082"))

    def test_the_cloudflare_gate_answers_before_the_store_doors(self):
        port = self.edge("192.0.2.0/24")

        self.assertEqual(set(self.routes(port).values()), {(403, "")})

    def test_ai_credentials_cross_only_the_intended_boundary_and_error_logs_omit_them(self):
        port = self.edge("0.0.0.0/0 ::/0")
        marker = "PRIVATE_AI_EDGE_MARKER"
        result = subprocess.run(["curl", "-sk", "--max-time", "5", "--resolve", f"app.localhost:{port}:127.0.0.1",
            "-H", "Cookie: session=" + marker, "-H", "X-Windmill-Installation: " + marker,
            "-H", "Authorization: Bearer " + marker, "-H", "Sec-WebSocket-Protocol: wm-live.v1," + marker,
            f"https://app.localhost:{port}/v1/pictures/headers"], capture_output=True, text=True, timeout=10, check=True)
        self.assertEqual(json.loads(result.stdout), {"Cookie": None, "X-Windmill-Installation": None,
            "Authorization": "Bearer " + marker, "Sec-WebSocket-Protocol": "wm-live.v1," + marker})
        self.docker("stop", self.ai_container)
        result = subprocess.run(["curl", "-sk", "--max-time", "5", "--resolve", f"app.localhost:{port}:127.0.0.1",
            "-H", "Cookie: session=" + marker, "-H", "Authorization: Bearer " + marker,
            "-H", "Sec-WebSocket-Protocol: wm-live.v1," + marker, "-w", "\n%{http_code}",
            f"https://app.localhost:{port}/v1/calls/{marker}/transcription"], capture_output=True, text=True, timeout=10, check=True)
        self.assertEqual(result.stdout.rsplit("\n", 1)[1], "502")
        self.assertNotIn(marker, self.docker("logs", self.edges[port]))
        # Caddy downgrades handled errors to DEBUG; exercise the same runtime encoder at ERROR too.
        adapted = json.loads(self.docker("exec", self.edges[port], "caddy", "adapt",
            "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"))
        for server in adapted["apps"]["http"]["servers"].values():
            server.pop("errors", None)
        with tempfile.TemporaryDirectory(prefix="ai-caddy-error-proof-") as directory:
            config = Path(directory) / "error-proof.json"
            config.write_text(json.dumps(adapted))
            self.docker("cp", str(config), self.edges[port] + ":/tmp/error-proof.json")
            self.docker("exec", self.edges[port], "caddy", "reload", "--config", "/tmp/error-proof.json")
        result = subprocess.run(["curl", "-sk", "--max-time", "5", "--resolve", f"api.localhost:{port}:127.0.0.1",
            "-H", "Cookie: session=" + marker, "-H", "Authorization: Bearer " + marker,
            "-H", "Sec-WebSocket-Protocol: wm-live.v1," + marker, "-w", "\n%{http_code}",
            f"https://api.localhost:{port}/v1/calls/{marker}/transcription"], capture_output=True, text=True, timeout=10, check=True)
        self.assertEqual(result.stdout.rsplit("\n", 1)[1], "502")
        for _ in range(30):
            logs = self.docker("logs", self.edges[port])
            self.assertNotIn(marker, logs)
            entries = [json.loads(line) for line in logs.splitlines() if line.startswith("{")]
            errors = [entry for entry in entries if entry.get("level") == "error"]
            if errors:
                break
            time.sleep(0.1)
        self.assertTrue(errors, logs)
        self.assertTrue(all("request" not in entry for entry in errors))

    def test_ai_websocket_upgrade_and_frame_pass_through(self):
        port = self.edge("0.0.0.0/0 ::/0")
        context = ssl._create_unverified_context()
        with socket.create_connection(("127.0.0.1", int(port)), timeout=5) as connection:
            with context.wrap_socket(connection, server_hostname="app.localhost") as stream:
                stream.sendall((f"GET /v1/calls/example/transcription HTTP/1.1\r\nHost: app.localhost:{port}\r\n"
                    "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n"
                    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                    "Sec-WebSocket-Protocol: wm-live.v1,wm-pass.v1.test.canary.signature\r\n\r\n").encode())
                response = b""
                while b"\r\n\r\n" not in response:
                    response += stream.recv(4096)
                headers, frame = response.split(b"\r\n\r\n", 1)
                self.assertIn(b" 101 ", headers)
                self.assertIn(b"sec-websocket-protocol: wm-live.v1", headers.lower())
                while len(frame) < 20:
                    chunk = stream.recv(4096)
                    if not chunk:
                        break
                    frame += chunk
                self.assertEqual(frame, b'\x81\x12{"type":"started"}')


if __name__ == "__main__":
    unittest.main()
