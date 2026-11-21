import base64
import hashlib
import http.client
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


SERVER = sys.argv.pop(1)
ORIGIN = "http://localhost:5173"
# A roadmap id no row holds, and text a request carries that no line may repeat.
TREE = "t_0123456789abcdef"
PRIVATE = "PRIVATE-ROADMAP-TEXT"
RETIRED_BODY = {"code": "client-update-required", "error": "This version of the app can no longer save; update it."}
# The rooms' routes (roadmap-on-the-engine.md §7): each by its method, a path it matches and the operation it is logged under.
ROOM_ROUTES = [
    ("GET", "/v1/trees", "roadmap.GET.v1.trees"),
    ("POST", "/v1/trees", "roadmap.POST.v1.trees"),
    ("GET", f"/v1/trees/{TREE}", "roadmap.GET.v1.trees.id"),
    ("PATCH", f"/v1/trees/{TREE}", "roadmap.PATCH.v1.trees.id"),
    ("DELETE", f"/v1/trees/{TREE}", "roadmap.DELETE.v1.trees.id"),
    ("PUT", f"/v1/trees/{TREE}/steps/s_bow/subtree", "roadmap.PUT.v1.trees.tree.steps.step.subtree"),
    ("GET", f"/v1/trees/{TREE}/guides", "roadmap.GET.v1.trees.id.guides"),
    ("GET", f"/v1/trees/{TREE}/diagnostics", "roadmap.GET.v1.trees.id.diagnostics"),
]
# The routes the move keeps (§7): the fork, the activity and progress reads, the cards, tending, reminders, the share page,
# the gallery and compose.
KEPT_ROUTES = [
    ("POST", f"/v1/trees/{TREE}/fork"), ("GET", f"/v1/trees/{TREE}/activity"), ("GET", f"/v1/trees/{TREE}/progress"),
    ("PUT", f"/v1/trees/{TREE}/og-image"), ("PUT", f"/v1/trees/{TREE}/og-video"), ("GET", f"/v1/trees/{TREE}/og-video"),
    ("POST", f"/v1/trees/{TREE}/tend"), ("GET", "/v1/tend/r_0123456789abcdef"), ("GET", "/v1/tending"),
    ("GET", "/v1/reminders"), ("PATCH", "/v1/reminders"), ("POST", "/v1/reminders/pause"),
    ("POST", "/v1/reminders/unsubscribe"), ("POST", "/v1/admin/reminders/sweep"), ("GET", f"/t/{TREE}"),
    ("GET", "/gallery"), ("GET", "/v1/gallery"), ("GET", f"/og/{TREE}.png"), ("POST", "/v1/compose"),
]
WRITE_LINE = re.compile(r"\bwrite (\{.*?\}) - ")


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@unittest.skipUnless(os.environ.get("WM_PG_TEST"), "SKIP: set WM_PG_TEST and DATABASE_URL for Postgres cases")
class RoadmapRoutesTest(unittest.TestCase):
    # The real server under each state of ROADMAP_ENGINE_ENABLED, asked roadmap's routes with a body none can parse.

    def sql(self, statement):
        result = subprocess.run(["psql", self.database, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", statement],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr[:300])
        return result.stdout.strip()

    def setUp(self):
        self.database = os.environ.get("DATABASE_URL")
        self.assertTrue(self.database, "WM_PG_TEST requires DATABASE_URL")
        self.user = str(uuid.uuid4())
        self.secret = "routes-" + uuid.uuid4().hex
        self.sql(f"insert into users (id, email) values ('{self.user}', 'routes-{self.user[:12]}@example.test')")
        digest = hashlib.sha256(self.secret.encode()).hexdigest()
        self.sql(f"insert into sessions (token_hash, user_id, expires_ms) values ('{digest}', '{self.user}', "
                 "(extract(epoch from now()) * 1000)::bigint + 3600000)")
        self.servers = []

    def tearDown(self):
        for server, _, log in self.servers:
            if server.poll() is None:
                server.kill()
                server.wait(timeout=10)
            log.close()
        for tree in self.sql(f"select id from trees where owner_id = '{self.user}'").split():
            for table in ("node_progress", "tree_ops", "tree_edges", "tree_nodes", "tree_kinds"):
                self.sql(f"delete from {table} where tree_id = '{tree}'")
            self.sql(f"delete from trees where id = '{tree}'")
        self.sql(f"delete from sessions where user_id = '{self.user}'")
        self.sql(f"delete from users where id = '{self.user}'")

    def start(self, engine):
        port = free_port()
        log = tempfile.NamedTemporaryFile(prefix="roadmap-routes-", suffix=".log", delete=False)
        environment = {"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/"), "DATABASE_URL": self.database,
                       "PORT": str(port), "WINDMILL_HOST": "127.0.0.1", "WINDMILL_ALLOWED_ORIGINS": ORIGIN}
        if engine:
            environment["ROADMAP_ENGINE_ENABLED"] = "1"
        server = subprocess.Popen([SERVER], stdout=log, stderr=subprocess.STDOUT, env=environment)
        self.servers.append((server, port, log))
        until = time.time() + 120
        while time.time() < until:
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
                return port
            except OSError:
                self.assertIsNone(server.poll(), f"the server ended before it listened; its log is {log.name}")
                time.sleep(0.1)
        self.fail(f"the server did not listen within 120 s; its log is {log.name}")

    # The server's write lines, once it has stopped and written them all out.
    def stopped(self):
        server, _, log = self.servers[-1]
        server.terminate()
        self.assertEqual(server.wait(timeout=30), 0, f"the server's log is {log.name}")
        with open(log.name, errors="replace") as text:
            lines = text.read()
        return lines, [json.loads(match) for match in WRITE_LINE.findall(lines)]

    def ask(self, port, method, path, signed):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        headers = {"Origin": ORIGIN, "Content-Type": "application/json"}
        if signed:
            headers["Cookie"] = f"wm_session={self.secret}"
        connection.request(method, path, body=None if method == "GET" else "{malformed " + PRIVATE, headers=headers)
        response = connection.getresponse()
        answer = (response.status, {name.lower(): value for name, value in response.getheaders()}, response.read())
        connection.close()
        return answer

    # An upgrade of /v1/socket on a connection of its own: its status line, its headers and its body. Drogon writes a
    # WebSocket close frame after the answer to every upgrade it refuses, the sync socket's included, which is not read.
    def upgrade(self, port, signed):
        cookie = f"Cookie: wm_session={self.secret}\r\n" if signed else ""
        key = base64.b64encode(os.urandom(16)).decode()
        with socket.create_connection(("127.0.0.1", port), timeout=10) as connection:
            connection.sendall((f"GET /v1/socket HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
                                f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
                                f"Origin: {ORIGIN}\r\n{cookie}\r\n").encode())
            received = b""
            while b"\r\n\r\n" not in received:
                chunk = connection.recv(4096)
                self.assertTrue(chunk, "the server closed the upgrade before its answer")
                received += chunk
            head, body = received.split(b"\r\n\r\n", 1)
            lines = head.decode().split("\r\n")
            headers = {name.lower(): value.strip() for name, value in (line.split(":", 1) for line in lines[1:])}
            length = int(headers.get("content-length", "0"))
            while len(body) < length:
                chunk = connection.recv(4096)
                self.assertTrue(chunk, "the server closed the upgrade before its body")
                body += chunk
            return lines[0], headers, body[:length]

    def test_with_the_switch_unset_the_rooms_routes_and_socket_answer_through_their_handlers_as_before_the_move(self):
        port = self.start(engine=False)
        today = {("GET", "/v1/trees"): (401, 200), ("POST", "/v1/trees"): (401, 200), ("GET", f"/v1/trees/{TREE}"): (404, 404),
                 ("PATCH", f"/v1/trees/{TREE}"): (401, 400), ("DELETE", f"/v1/trees/{TREE}"): (401, 404),
                 ("PUT", f"/v1/trees/{TREE}/steps/s_bow/subtree"): (401, 400),
                 ("GET", f"/v1/trees/{TREE}/guides"): (404, 404), ("GET", f"/v1/trees/{TREE}/diagnostics"): (404, 404),
                 ("GET", "/v1/socket"): (404, 404)}
        answered = {(method, path): tuple(self.ask(port, method, path, signed)[0] for signed in (False, True))
                    for method, path in today}
        self.assertEqual(answered, today)
        self.assertEqual([self.upgrade(port, signed)[0] for signed in (False, True)],
                         ["HTTP/1.1 101 Switching Protocols", "HTTP/1.1 101 Switching Protocols"])
        _, lines = self.stopped()
        self.assertEqual([line for line in lines if line["outcome"] == "client-update-required"], [])

    def test_with_the_engine_serving_roadmap_every_room_route_and_the_old_socket_answer_410_before_authentication(self):
        port = self.start(engine=True)
        for method, path, _ in ROOM_ROUTES + [("GET", "/v1/socket", "roadmap.GET.v1.socket")]:
            for signed in (False, True):
                status, headers, body = self.ask(port, method, path, signed)
                self.assertEqual((status, json.loads(body), headers["content-type"], headers.get("access-control-allow-origin"),
                                  headers.get("access-control-allow-credentials")),
                                 (410, RETIRED_BODY, "application/json; charset=utf-8", ORIGIN, "true"), f"{method} {path}")
        for signed in (False, True):
            status_line, headers, body = self.upgrade(port, signed)
            self.assertEqual((status_line, json.loads(body), "upgrade" in headers), ("HTTP/1.1 410 Gone", RETIRED_BODY, False))
        text, lines = self.stopped()
        refusals = {}
        for line in lines:
            if line["outcome"] != "client-update-required":
                continue
            self.assertEqual((line["product"], line["door"]), ("roadmap", "rest"))
            refusals[line["operation"]] = refusals.get(line["operation"], 0) + 1
        self.assertEqual(refusals, {**{operation: 2 for _, _, operation in ROOM_ROUTES}, "roadmap.GET.v1.socket": 4})
        self.assertEqual([marker for marker in (TREE, PRIVATE, self.secret, self.user) if marker in text], [])
        self.assertEqual(self.sql(f"select count(*) from trees where owner_id = '{self.user}'"), "0")

    def test_the_routes_the_move_keeps_answer_alike_under_both_switch_states_and_none_as_retired(self):
        answers = []
        for engine in (False, True):
            port = self.start(engine=engine)
            answered = {}
            for method, path in KEPT_ROUTES:
                status, _, body = self.ask(port, method, path, signed=False)
                answered[(method, path)] = (status, body.decode(errors="replace") if status == 410 else "")
            answers.append(answered)
            self.stopped()
        self.assertEqual(answers[1], answers[0])
        self.assertEqual([route for route, (status, _) in answers[1].items() if status == 410], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
