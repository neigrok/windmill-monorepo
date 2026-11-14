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
# A reporter that cannot reach its host: an unroutable address.
UNREACHABLE_REPORTS = {"SENTRY_DSN": "https://k@10.255.255.1/1"}
CRASHED = re.compile(r"Segmentation|Abort trap|terminate called|libc\+\+abi|pure virtual|CRASHED")


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def server_frames(data):
    """The text frames a server sent, in order, out of the bytes read off a socket; an unfinished last frame is left."""
    frames = []
    at = 0
    while at + 2 <= len(data):
        opcode = data[at] & 0x0F
        size = data[at + 1] & 0x7F
        head = 2
        if size == 126:
            if at + 4 > len(data):
                break
            size = struct.unpack(">H", data[at + 2:at + 4])[0]
            head = 4
        elif size == 127:
            if at + 10 > len(data):
                break
            size = struct.unpack(">Q", data[at + 2:at + 10])[0]
            head = 10
        if at + head + size > len(data):
            break
        if opcode == 1:
            frames.append(data[at + head:at + head + size].decode(errors="replace"))
        at += head + size
    return frames


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
    """The real server told to stop: what it exits with, by when, and what it took after the signal.

    A case waits for what it needs to be true — a statement waiting on a lock, a store asleep in a write, the listener
    refusing — and never for a length of time, and bounds what it measures only by the server's own deadline.
    """

    # What a case's server is started with beside the usual.
    ENVIRONMENT = {"test_a_stop_whose_reports_cannot_be_sent_ends_inside_the_deadline_uncut": UNREACHABLE_REPORTS}

    def sql(self, statement):
        result = subprocess.run(["psql", self.database, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", statement],
                                capture_output=True, text=True, timeout=60)
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
                 "WINDMILL_MCP_TOKEN": "stop-test-token", "WINDMILL_MCP_USER": self.user,
                 **self.ENVIRONMENT.get(self._testMethodName, {})})
        until = time.time() + 120
        while time.time() < until:
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.5).close()
                break
            except OSError:
                self.assertIsNone(self.server.poll(), "the server ended before it listened")
                time.sleep(0.1)
        else:
            self.fail("the server did not listen within 120 s")
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

    def backends(self, state):
        return int(self.sql(f"select count(*) from pg_stat_activity where datname = current_database() and {state}"))

    def await_backends(self, state, what, more_than=0):
        until = time.time() + 60
        while time.time() < until:
            if self.backends(state) > more_than:
                return
            time.sleep(0.05)
        self.fail(f"no statement was {what} within 60 s")

    def await_a_statement_waiting_on_a_lock(self):
        self.await_backends("wait_event_type = 'Lock'", "waiting on a lock")

    def await_the_store_asleep_in_a_write(self):
        # The slow trigger's sleep, in a backend of the server's: the write is with the store.
        self.await_backends("wait_event = 'PgSleep' and query not like 'begin;%'", "asleep in a write")

    def hold(self, statement, seconds):
        asleep = "wait_event = 'PgSleep' and query like 'begin;%'"
        already = self.backends(asleep)
        holder = subprocess.Popen(["psql", self.database, "-XAtq", "-c", f"begin; {statement}; select pg_sleep({seconds}); rollback;"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.holders.append(holder)
        self.await_backends(asleep, "holding its lock", more_than=already)

    def await_the_listener_refusing(self):
        until = time.time() + 30
        while time.time() < until:
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=1).close()
            except OSError:
                return
            time.sleep(0.02)
        self.fail("the server still took a connection 30 s after the signal")

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
        self.hold(f"select id from trees where id = '{tree}' for update", 20)
        writer, told = self.in_flight(lambda: self.tool("update_nodes", {"treeId": tree, "updates": [{"nodeId": "a", "label": "held"}]}))
        self.await_a_statement_waiting_on_a_lock()

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

        code, took = self.stop(BUDGET + EXIT_FLUSH)

        self.assert_clean_exit(code, took, BUDGET + EXIT_FLUSH)
        log = self.logged()
        self.assertEqual(re.findall(r"roadmap_tree_save outcome=lost-at-shutdown rooms=(\d+)", log), ["1"])
        self.assertNotIn("cut-at-deadline", log)

    def test_a_stop_whose_reports_cannot_be_sent_ends_inside_the_deadline_uncut(self):
        # The stop itself is over at once; the reports of what it lost cannot be sent. The watch on the stop ends before
        # they are tried, so it is not cut while it writes them out, and they are waited for no longer than their limit.
        tree = self.tree(["a"])
        self.refuse("trees", f"new.id = '{tree}'")
        held = self.tool("update_nodes", {"treeId": tree, "updates": [{"nodeId": "a", "label": "held"}]})
        self.assertIs(held.get("saved"), False)

        code, took = self.stop(BUDGET + EXIT_FLUSH)

        self.assert_clean_exit(code, took, BUDGET + 1.0)
        log = self.logged()
        self.assertEqual(re.findall(r"roadmap_tree_save outcome=lost-at-shutdown rooms=(\d+)", log), ["1"])
        self.assertNotIn("cut-at-deadline", log)

    def test_a_stop_with_a_request_still_running_exits_by_the_deadline_and_that_request_is_not_answered(self):
        tree = self.tree(["a", "b", "c"])
        self.slow("node_progress", f"new.tree_id = '{tree}'", 4, event="insert or update")
        marks = {"treeId": tree, "updates": [{"nodeId": step, "status": "complete"} for step in ("a", "b", "c")]}
        caller, told = self.in_flight(lambda: self.tool("update_nodes", marks, timeout=40))
        self.await_the_store_asleep_in_a_write()

        code, took = self.stop(BUDGET + EXIT_FLUSH)
        caller.join(timeout=30)

        self.assert_clean_exit(code, took, BUDGET + EXIT_FLUSH)
        self.assertGreaterEqual(took, BUDGET - 0.5)
        self.assertNotIn("answer", told)
        self.assertIn(told.get("unanswered"), ("RemoteDisconnected", "ConnectionResetError", "IncompleteRead", "BrokenPipeError"))
        self.assertEqual(len(re.findall(r"server_stop outcome=cut-at-deadline budget_ms=5000", self.logged())), 1)

    def test_no_frame_lands_once_the_server_is_told_to_stop(self):
        tree = self.tree(["a"])
        self.slow("trees", f"new.id = '{tree}'", 1.0)
        tab = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        tab.sendall((f"GET /v1/socket HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                     f"Sec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode()}\r\nSec-WebSocket-Version: 13\r\n"
                     f"Origin: {ORIGIN}\r\nCookie: wm_session={self.cookie}\r\n\r\n").encode())
        upgraded = b""
        while b"\r\n\r\n" not in upgraded:
            chunk = tab.recv(4096)
            self.assertTrue(chunk, "the server closed the connection before it answered the upgrade")
            upgraded += chunk
        self.assertIn(b" 101 ", upgraded.split(b"\r\n")[0])
        received = bytearray(upgraded.split(b"\r\n\r\n", 1)[1])

        def read():
            try:
                while chunk := tab.recv(65536):
                    received.extend(chunk)
            except OSError:
                pass
        reader = threading.Thread(target=read)
        reader.start()
        now = int(time.time() * 1000)

        def frame(kind, index):
            return masked(json.dumps({
                "t": "subgraph", "v": 1, "treeId": tree, "frameId": f"{kind}-{index}", "actor": "r_stoptest", "intent": "live",
                "nodes": [{"id": f"{kind}{index}", "createdAt": f"{now}:{index}:r_stoptest", "label": kind,
                           "labelAt": f"{now}:{index}:r_stoptest"}], "edges": [], "kinds": []}))
        tab.sendall(masked(json.dumps({"t": "subscribe", "treeId": tree, "vector": {}})))
        # Thirty frames in one write, before the signal: the server reads them together and lands them one save of a
        # second at a time, so landing them all would take six times its deadline.
        tab.sendall(b"".join(frame("early", index) for index in range(30)))
        self.await_the_store_asleep_in_a_write()

        told = time.time()
        self.server.send_signal(signal.SIGTERM)
        # The stop is observable from outside once the listener refuses. Frames sent from then on are late, whether the
        # socket still takes their bytes or not.
        self.await_the_listener_refusing()
        try:
            tab.sendall(b"".join(frame("late", index) for index in range(5)))
        except OSError:
            pass
        code = self.server.wait(timeout=BUDGET + EXIT_FLUSH + 20)
        took = time.time() - told
        reader.join(timeout=30)
        tab.close()

        self.assert_clean_exit(code, took, BUDGET + EXIT_FLUSH)
        # However many of the early frames landed before the signal, none sent after it is stored or acked, and the
        # ones the server had read stopped landing: it ended by itself, where landing them would have run to the cut.
        self.assertEqual(self.sql(f"select count(*) from tree_nodes where tree_id = '{tree}' and node_id like 'late%'"), "0")
        answered = [json.loads(text) for text in server_frames(bytes(received))]
        self.assertEqual([answer.get("frameId") for answer in answered if str(answer.get("frameId", "")).startswith("late-")], [])
        self.assertNotIn("cut-at-deadline", self.logged())
        self.assertLess(int(self.sql(f"select count(*) from tree_nodes where tree_id = '{tree}' and node_id like 'early%'")), 30)

    def test_a_request_that_reaches_the_server_once_it_is_stopping_is_answered_a_bare_503_after_the_one_ahead_of_it(self):
        tree = self.tree(["a"])
        self.slow("trees", f"new.id = '{tree}'", 1.0)
        write = self.tool_body("update_nodes", {"treeId": tree, "updates": [{"nodeId": "a", "label": "in flight"}]})
        # Two requests in one write on one connection: the second is read with the first and reached after it.
        both = (f"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nAuthorization: Bearer stop-test-token\r\n"
                f"Mcp-Session-Id: {self.session}\r\ncontent-type: application/json\r\nContent-Length: {len(write.encode())}\r\n\r\n{write}"
                f"GET /v1/trees/{tree} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nCookie: wm_session={self.cookie}\r\n\r\n")
        caller = socket.create_connection(("127.0.0.1", self.port), timeout=BUDGET + EXIT_FLUSH + 20)
        caller.sendall(both.encode())
        self.await_the_store_asleep_in_a_write()

        told = time.time()
        self.server.send_signal(signal.SIGTERM)
        received = b""
        try:
            while chunk := caller.recv(65536):
                received += chunk
        except OSError:
            pass
        caller.close()
        code = self.server.wait(timeout=BUDGET + EXIT_FLUSH + 20)

        self.assert_clean_exit(code, time.time() - told, BUDGET + EXIT_FLUSH)
        self.assertEqual(re.findall(rb"HTTP/1\.1 (\d+)", received), [b"200", b"503"])
        unavailable = received[received.rindex(b"HTTP/1.1 503"):].lower()
        self.assertIn(b"content-length: 0\r\n", unavailable)
        self.assertTrue(unavailable.endswith(b"\r\n\r\n"), "the 503 carries no body")
        self.assertEqual(self.sql(f"select label from tree_nodes where tree_id = '{tree}' and node_id = 'a'"), "in flight")

    def test_a_request_a_worker_answers_after_the_loops_stopped_is_logged_by_its_route(self):
        self.hold("lock table sync_scopes in access exclusive mode", 2.5)
        headers = {"Cookie": f"wm_session={self.cookie}", "Origin": ORIGIN, "content-type": "application/json",
                   "Sync-Schema": "2147483647"}

        def pull():
            conn = self.connection(BUDGET + EXIT_FLUSH + 20)
            conn.request("POST", "/v1/sync/pull", json.dumps({"scopes": [{"scope": "self/gym", "cursor": None}]}), headers)
            return conn.getresponse().status
        caller, told = self.in_flight(pull)
        self.await_a_statement_waiting_on_a_lock()

        code, took = self.stop(BUDGET + EXIT_FLUSH)
        caller.join(timeout=30)

        self.assert_clean_exit(code, took, BUDGET + EXIT_FLUSH)
        after = self.logged()
        self.assertRegex(after, r"http POST /v1/sync/pull \d+ ", "the pull was not in flight at the signal: the case proves nothing")


if __name__ == "__main__":
    unittest.main()
