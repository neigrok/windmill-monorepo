import base64
import hashlib
import http.client
import json
import os
import re
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid


SERVER = sys.argv.pop(1)
# RoomRegistry::kShutdownSaveBudget and ProcessStop::kExitFlushLimit, in seconds: a stop is over within their sum.
BUDGET = 5.0
EXIT_FLUSH = 3.0
ORIGIN = "http://localhost:5173"
CRASHED = re.compile(r"Segmentation|Abort trap|terminate called|libc\+\+abi|pure virtual|CRASHED")


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def masked(text):
    payload = text.encode()
    head = bytes([0x81])
    if len(payload) < 126:
        head += bytes([0x80 | len(payload)])
    elif len(payload) < 65536:
        head += bytes([0x80 | 126]) + struct.pack(">H", len(payload))
    else:
        head += bytes([0x80 | 127]) + struct.pack(">Q", len(payload))
    key = os.urandom(4)
    return head + key + bytes(byte ^ key[index % 4] for index, byte in enumerate(payload))


@unittest.skipUnless(os.environ.get("WM_PG_TEST"), "SKIP: set WM_PG_TEST and DATABASE_URL for Postgres cases")
class ServerStopTest(unittest.TestCase):
    """The real server told to stop: what it exits with, by when, and what it took after the signal."""

    def sql(self, statement):
        result = subprocess.run(["psql", self.database, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", statement],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr[:300])
        return result.stdout.strip()

    def setUp(self):
        self.database = os.environ.get("DATABASE_URL")
        self.assertTrue(self.database, "WM_PG_TEST requires DATABASE_URL")
        self.user = str(uuid.uuid4())
        self.cookie = "stop-" + uuid.uuid4().hex
        self.tag = uuid.uuid4().hex[:12]
        self.sql(f"insert into users (id, email) values ('{self.user}', 'stop-{self.tag}@example.test')")
        digest = hashlib.sha256(self.cookie.encode()).hexdigest()
        self.sql(f"insert into sessions (token_hash, user_id, expires_ms) values ('{digest}', '{self.user}', "
                 "(extract(epoch from now()) * 1000)::bigint + 3600000)")
        self.port = free_port()
        self.log = tempfile.NamedTemporaryFile(prefix="server-stop-", suffix=".log", delete=False)
        self.holders = []
        self.triggers = []
        self.trees = []
        self.server = subprocess.Popen(
            [SERVER], stdout=self.log, stderr=subprocess.STDOUT,
            env={"PATH": os.environ["PATH"], "HOME": os.environ.get("HOME", "/"), "DATABASE_URL": self.database,
                 "PORT": str(self.port), "WINDMILL_HOST": "127.0.0.1", "WINDMILL_ALLOWED_ORIGINS": ORIGIN,
                 "WINDMILL_MCP_TOKEN": "stop-test-token", "WINDMILL_MCP_USER": self.user})
        until = time.time() + 30
        while time.time() < until:
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.5).close()
                break
            except OSError:
                self.assertIsNone(self.server.poll(), "the server ended before it listened")
                time.sleep(0.1)
        else:
            self.fail("the server did not listen within 30 s")
        self.session = self.mcp_session()

    def tearDown(self):
        if self.server.poll() is None:
            self.server.kill()
            self.server.wait(timeout=10)
        for holder in self.holders:
            if holder.poll() is None:
                holder.kill()
            holder.wait(timeout=10)
        for table, name in self.triggers:
            self.sql(f"drop trigger if exists {name} on {table}; drop function if exists {name}()")
        for tree in self.trees:
            for table in ("node_progress", "tree_ops", "tree_edges", "tree_nodes", "tree_kinds"):
                self.sql(f"delete from {table} where tree_id = '{tree}'")
            self.sql(f"delete from trees where id = '{tree}'")
        self.sql(f"delete from sessions where user_id = '{self.user}'")
        self.sql(f"delete from users where id = '{self.user}'")
        self.log.close()
        os.unlink(self.log.name)

    # ---- the doors

    def connection(self, timeout=30):
        return http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)

    def mcp_headers(self):
        return {"Authorization": "Bearer stop-test-token", "content-type": "application/json"}

    def mcp_session(self):
        conn = self.connection()
        conn.request("POST", "/mcp", json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "stop", "version": "0"}}}),
            self.mcp_headers())
        response = conn.getresponse()
        response.read()
        return response.getheader("mcp-session-id")

    def tool_body(self, name, arguments):
        return json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                           "params": {"name": "roadmap_" + name, "arguments": arguments}})

    def tool(self, name, arguments, timeout=30):
        conn = self.connection(timeout)
        conn.request("POST", "/mcp", self.tool_body(name, arguments), {**self.mcp_headers(), "Mcp-Session-Id": self.session})
        response = conn.getresponse()
        body = json.loads(response.read())
        return json.loads(body["result"]["content"][0]["text"])

    def tree(self, steps):
        tree = self.tool("create_tree", {"title": "Stop"})["treeId"]
        self.trees.append(tree)
        self.tool("import_subgraph", {"treeId": tree, "nodes": [{"id": step, "label": step} for step in steps]})
        return tree

    def slow(self, table, when, seconds, event="update"):
        name = f"wm_stop_{self.tag}_{len(self.triggers)}"
        self.triggers.append((table, name))
        self.sql(f"create function {name}() returns trigger language plpgsql as $$ begin perform pg_sleep({seconds}); "
                 f"return new; end $$; create trigger {name} before {event} on {table} for each row when ({when}) "
                 f"execute function {name}()")

    def refuse(self, table, when):
        name = f"wm_stop_{self.tag}_{len(self.triggers)}"
        self.triggers.append((table, name))
        self.sql(f"create function {name}() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$; "
                 f"create trigger {name} before update on {table} for each row when ({when}) execute function {name}()")

    def hold(self, statement, seconds):
        holder = subprocess.Popen(["psql", self.database, "-XAtq", "-c", f"begin; {statement}; select pg_sleep({seconds}); rollback;"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.holders.append(holder)
        time.sleep(0.5)

    def in_flight(self, call):
        outcome = {}

        def run():
            try:
                outcome["answer"] = call()
            except Exception as error:  # the caller's view: no answer, and how the connection ended
                outcome["unanswered"] = type(error).__name__
        thread = threading.Thread(target=run)
        thread.start()
        return thread, outcome

    def stop(self, within):
        told = time.time()
        self.server.send_signal(signal.SIGTERM)
        try:
            code = self.server.wait(timeout=within + 20)
        except subprocess.TimeoutExpired:
            self.fail(f"the server was still running {within + 20:.0f} s after the signal")
        return code, time.time() - told

    def logged(self):
        self.log.flush()
        with open(self.log.name, errors="replace") as log:
            return log.read()

    def assert_clean_exit(self, code, took, within):
        log = self.logged()
        self.assertEqual(code, 0, "the server did not exit 0: " + "; ".join(CRASHED.findall(log))[:200])
        self.assertLessEqual(took, within)
        self.assertIsNone(CRASHED.search(log))
        self.assertNotIn("%00", log)
        self.assertNotIn("\x00", log)

    # ---- the cases

    def test_a_stop_that_loses_a_room_exits_0_and_says_how_many(self):
        tree = self.tree(["a"])
        self.hold(f"select id from trees where id = '{tree}' for update", 12)
        writer, told = self.in_flight(lambda: self.tool("update_nodes", {"treeId": tree, "updates": [{"nodeId": "a", "label": "held"}]}))
        time.sleep(0.5)

        code, took = self.stop(BUDGET + EXIT_FLUSH)
        writer.join(timeout=30)

        self.assert_clean_exit(code, took, BUDGET + EXIT_FLUSH)
        self.assertEqual(re.findall(r"roadmap_tree_save outcome=lost-at-shutdown rooms=(\d+)", self.logged()), ["1"])
        self.assertEqual(self.sql(f"select label from tree_nodes where tree_id = '{tree}' and node_id = 'a'"), "a")

    def test_a_stop_that_loses_a_room_to_a_store_that_refuses_ends_by_itself_and_exits_0(self):
        tree = self.tree(["a"])
        self.refuse("trees", f"new.id = '{tree}'")
        held = self.tool("update_nodes", {"treeId": tree, "updates": [{"nodeId": "a", "label": "held"}]})
        self.assertIs(held.get("saved"), False)

        code, took = self.stop(2.0)

        self.assert_clean_exit(code, took, 2.0)
        log = self.logged()
        self.assertEqual(re.findall(r"roadmap_tree_save outcome=lost-at-shutdown rooms=(\d+)", log), ["1"])
        self.assertNotIn("cut-at-deadline", log)

    def test_a_stop_with_a_request_still_running_exits_by_the_deadline_and_that_request_is_not_answered(self):
        tree = self.tree(["a", "b", "c"])
        self.slow("node_progress", f"new.tree_id = '{tree}'", 4, event="insert or update")
        marks = {"treeId": tree, "updates": [{"nodeId": step, "status": "complete"} for step in ("a", "b", "c")]}
        caller, told = self.in_flight(lambda: self.tool("update_nodes", marks, timeout=40))
        time.sleep(0.4)

        code, took = self.stop(BUDGET + EXIT_FLUSH)
        caller.join(timeout=30)

        self.assert_clean_exit(code, took, BUDGET + EXIT_FLUSH)
        self.assertGreaterEqual(took, BUDGET - 0.5)
        self.assertNotIn("answer", told)
        self.assertIn(told.get("unanswered"), ("RemoteDisconnected", "ConnectionResetError", "IncompleteRead", "BrokenPipeError"))
        self.assertEqual(len(re.findall(r"server_stop outcome=cut-at-deadline budget_ms=5000", self.logged())), 1)

    def test_no_frame_lands_once_the_server_is_told_to_stop(self):
        tree = self.tree(["a"])
        self.slow("trees", f"new.id = '{tree}'", 0.25)
        tab = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        tab.sendall((f"GET /v1/socket HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                     f"Sec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode()}\r\nSec-WebSocket-Version: 13\r\n"
                     f"Origin: {ORIGIN}\r\nCookie: wm_session={self.cookie}\r\n\r\n").encode())
        self.assertIn(b" 101 ", tab.recv(4096).split(b"\r\n")[0])
        tab.sendall(masked(json.dumps({"t": "subscribe", "treeId": tree, "vector": {}})))
        time.sleep(0.3)
        # Thirty frames in one write: the server reads them together and lands them one save at a time.
        now = int(time.time() * 1000)
        burst = b"".join(masked(json.dumps({
            "t": "subgraph", "v": 1, "treeId": tree, "frameId": f"burst-{index}", "actor": "r_stoptest", "intent": "live",
            "nodes": [{"id": f"burst{index}", "createdAt": f"{now}:{index}:r_stoptest", "label": "Burst",
                       "labelAt": f"{now}:{index}:r_stoptest"}], "edges": [], "kinds": []})) for index in range(30))
        tab.sendall(burst)
        time.sleep(0.9)

        code, took = self.stop(2.0)
        tab.close()

        self.assert_clean_exit(code, took, 2.0)
        landed = int(self.sql(f"select count(*) from tree_nodes where tree_id = '{tree}' and node_id like 'burst%'"))
        self.assertGreaterEqual(landed, 1, "no frame landed before the signal: the case proves nothing")
        self.assertLessEqual(landed, 6)

    def test_a_request_that_reaches_the_server_once_it_is_stopping_is_answered_a_bare_503_after_the_one_ahead_of_it(self):
        tree = self.tree(["a"])
        self.slow("trees", f"new.id = '{tree}'", 1.0)
        write = self.tool_body("update_nodes", {"treeId": tree, "updates": [{"nodeId": "a", "label": "in flight"}]})
        # Two requests in one write on one connection: the second is read with the first and reached after it.
        both = (f"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nAuthorization: Bearer stop-test-token\r\n"
                f"Mcp-Session-Id: {self.session}\r\ncontent-type: application/json\r\nContent-Length: {len(write.encode())}\r\n\r\n{write}"
                f"GET /v1/trees/{tree} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nCookie: wm_session={self.cookie}\r\n\r\n")
        caller = socket.create_connection(("127.0.0.1", self.port), timeout=20)
        caller.sendall(both.encode())
        time.sleep(0.3)

        told = time.time()
        self.server.send_signal(signal.SIGTERM)
        received = b""
        try:
            while chunk := caller.recv(65536):
                received += chunk
        except OSError:
            pass
        caller.close()
        code = self.server.wait(timeout=20)

        self.assert_clean_exit(code, time.time() - told, 3.0)
        self.assertEqual(re.findall(rb"HTTP/1\.1 (\d+)", received), [b"200", b"503"])
        unavailable = received[received.rindex(b"HTTP/1.1 503"):].lower()
        self.assertIn(b"content-length: 0\r\n", unavailable)
        self.assertTrue(unavailable.endswith(b"\r\n\r\n"), "the 503 carries no body")
        self.assertEqual(self.sql(f"select label from tree_nodes where tree_id = '{tree}' and node_id = 'a'"), "in flight")

    def test_a_request_a_worker_answers_after_the_loops_stopped_is_logged_by_its_route(self):
        self.hold("lock table sync_scopes in access exclusive mode", 1.5)
        headers = {"Cookie": f"wm_session={self.cookie}", "Origin": ORIGIN, "content-type": "application/json",
                   "Sync-Schema": "2147483647"}

        def pull():
            conn = self.connection(20)
            conn.request("POST", "/v1/sync/pull", json.dumps({"scopes": [{"scope": "self/gym", "cursor": None}]}), headers)
            return conn.getresponse().status
        caller, told = self.in_flight(pull)
        time.sleep(0.4)

        code, took = self.stop(BUDGET + EXIT_FLUSH)
        caller.join(timeout=30)

        self.assert_clean_exit(code, took, BUDGET + EXIT_FLUSH)
        after = self.logged()
        self.assertRegex(after, r"http POST /v1/sync/pull \d+ ", "the pull was not in flight at the signal: the case proves nothing")


if __name__ == "__main__":
    unittest.main()
