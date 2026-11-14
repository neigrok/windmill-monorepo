#!/usr/bin/env python3
import argparse
import base64
import concurrent.futures
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import select
import signal
import socket
import socketserver
import struct
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.parse
import uuid


ROOT = Path(__file__).resolve().parents[2]
SOURCE = os.environ.get("AI_TEST_DATABASE_URL", "postgresql://ai_test@127.0.0.1:19440/postgres")
FUNDING = "f" * 32
OPERATOR = "o" * 32
PUBLIC_KEY = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def wait_for(check, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(0.05)
    raise AssertionError("bounded condition did not become true")


def receive_frame(connection):
    def take(length):
        data = bytearray()
        while len(data) < length:
            chunk = connection.recv(length - len(data))
            if not chunk:
                raise EOFError("fixture websocket closed")
            data.extend(chunk)
        return bytes(data)
    first, second = take(2)
    length = second & 127
    if length == 126:
        length = struct.unpack("!H", take(2))[0]
    if length == 127:
        length = struct.unpack("!Q", take(8))[0]
    mask = take(4) if second & 128 else None
    data = take(length)
    if mask:
        data = bytes(value ^ mask[index % 4] for index, value in enumerate(data))
    return first & 15, data


def send_frame(connection, opcode, data, masked=False):
    flag = 128 if masked else 0
    length = len(data)
    head = bytes([128 | opcode, flag | (length if length < 126 else 126 if length <= 65535 else 127)])
    if length >= 126:
        head += struct.pack("!H" if length <= 65535 else "!Q", length)
    if masked:
        mask = b"test"
        head += mask
        data = bytes(value ^ mask[index % 4] for index, value in enumerate(data))
    connection.sendall(head + data)


class LiveProvider(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(20)
        header = bytearray()
        while not header.endswith(b"\r\n\r\n"):
            header.extend(self.request.recv(1))
        key = next(line.split(":", 1)[1].strip() for line in header.decode().splitlines() if line.lower().startswith("sec-websocket-key:"))
        accepted = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.request.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accepted + "\r\n\r\n").encode())
        _, data = receive_frame(self.request)
        config = json.loads(data)
        send_frame(self.request, 1, json.dumps({"type": "session.updated", "session": config["session"]}).encode())
        while True:
            opcode, data = receive_frame(self.request)
            if opcode == 8:
                send_frame(self.request, 8, data)
                return
            value = json.loads(data)
            if value["type"] == "input_audio_buffer.append":
                self.server.audio.set()
            if value["type"] == "input_audio_buffer.commit":
                for event in ({"type": "input_audio_buffer.committed", "item_id": "turn-fixture", "previous_item_id": None},
                              {"type": "conversation.item.input_audio_transcription.completed", "item_id": "turn-fixture", "transcript": "Fixture"}):
                    send_frame(self.request, 1, json.dumps(event).encode())


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path.endswith("count_tokens"):
            self.server.count_started.set()
            self.server.count_release.wait(45)
            data = b'{"input_tokens":10}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.server.dispatches += 1
        self.server.started.set()
        self.server.release.wait(90)
        events = [
            {"type": "message_start", "message": {"id": "provider-fixture", "role": "assistant", "content": [], "usage": {"input_tokens": 10, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Fixture"}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}},
            {"type": "message_stop"},
        ]
        data = "".join("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n" for event in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


class Capture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.server.envelopes.append(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        self.send_response(200)
        self.end_headers()


class DatabaseProxy(socketserver.BaseRequestHandler):
    def handle(self):
        with socket.create_connection(self.server.destination, timeout=5) as upstream:
            upstream.settimeout(5)
            self.request.settimeout(5)
            while not self.server.stopping.is_set():
                if self.server.paused.is_set():
                    self.server.stopping.wait(0.05)
                    continue
                try:
                    readable, _, _ = select.select([self.request, upstream], [], [], 0.1)
                    for connection in readable:
                        data = connection.recv(65536)
                        if not data:
                            return
                        (upstream if connection is self.request else self.request).sendall(data)
                except OSError:
                    return


class ProcessReview(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="case-", dir="/private/tmp/wm-ai-review-ops")
        self.scratch = Path(self.folder.name)
        self.database_name = "ai_ops_" + uuid.uuid4().hex
        self.database = SOURCE.rsplit("/", 1)[0] + "/" + self.database_name
        self.sql("CREATE DATABASE " + self.database_name, admin=True)
        self.provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        for name in ("started", "release", "count_started", "count_release"):
            setattr(self.provider, name, threading.Event())
        self.provider.count_release.set()
        self.provider.dispatches = 0
        threading.Thread(target=self.provider.serve_forever, daemon=True).start()
        self.capture = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Capture)
        self.capture.envelopes = []
        threading.Thread(target=self.capture.serve_forever, daemon=True).start()
        self.processes = []
        self.logs = []
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)
        self.account = "ops-fixture"
        self.token = self.sign()

    def tearDown(self):
        self.provider.release.set()
        self.provider.count_release.set()
        for process in self.processes:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
        self.executor.shutdown(wait=True, cancel_futures=True)
        self.provider.shutdown()
        self.capture.shutdown()
        self.provider.server_close()
        self.capture.server_close()
        self.sql("ALTER DATABASE " + self.database_name + " ALLOW_CONNECTIONS true", admin=True)
        self.sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='" + self.database_name + "'", admin=True)
        self.sql("DROP DATABASE " + self.database_name, admin=True)
        self.folder.cleanup()

    def sql(self, query, admin=False):
        return subprocess.run(["psql", "-XAtq", "-v", "ON_ERROR_STOP=1", SOURCE if admin else self.database, "-c", query], capture_output=True, text=True, timeout=10, check=True).stdout.strip()

    def sign(self, kid="test-rfc8032", seed=None):
        seed = seed or bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        key = self.scratch / (kid + ".der")
        key.write_bytes(bytes.fromhex("302e020100300506032b657004220420") + seed)
        instant = int(time.time() * 1000)
        payload = {"aud": "ai", "env": "development", "iat": instant, "exp": instant + 600000, "sub": {"account": self.account}, "plan": "one", "ownerGrant": True, "client": "web"}
        signed = "wm-pass.v1." + kid + "." + b64(json.dumps(payload, separators=(",", ":")).encode())
        source = self.scratch / "signed"
        source.write_bytes(signed.encode())
        signature = subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(key), "-keyform", "DER", "-in", str(source)], capture_output=True, timeout=5, check=True).stdout
        return signed + "." + b64(signature)

    def start(self, changes=None, ready=True):
        public, internal = port(), port()
        env = {"PATH": os.environ["PATH"], "AI_ENVIRONMENT": "development", "AI_DATABASE_URL": self.database,
               "AI_PUBLIC_ADDRESS": "127.0.0.1:" + str(public), "AI_INTERNAL_ADDRESS": "127.0.0.1:" + str(internal),
               "AI_PASS_KEYS": json.dumps({"test-rfc8032": PUBLIC_KEY}), "AI_CARRY_KEY": b64(bytes(32)),
               "AI_FUNDING_SECRET": FUNDING, "AI_OPERATOR_SECRET": OPERATOR, "AI_ANTHROPIC_KEY": "fixture",
               "AI_ANTHROPIC_URL": "http://127.0.0.1:" + str(self.provider.server_port),
               "SENTRY_DSN": "http://public@127.0.0.1:" + str(self.capture.server_port) + "/1"}
        env.update(changes or {})
        log = self.scratch / (str(len(self.processes)) + ".log")
        with log.open("wb") as output:
            process = subprocess.Popen([BINARY], cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT)
        self.processes.append(process)
        self.logs.append(log)
        if ready:
            wait_for(lambda: self.request(public, "/health")[0] == 200)
        return process, public, internal

    def request(self, port_number, path, method="GET", value=None, token=None, timeout=85):
        connection = http.client.HTTPConnection("127.0.0.1", port_number, timeout=timeout)
        headers = {"Authorization": "Bearer " + token} if token else {}
        body = None if value is None else json.dumps(value)
        if body:
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body, headers)
        response = connection.getresponse()
        data = response.read().decode()
        status = response.status
        connection.close()
        try:
            return status, json.loads(data)
        except json.JSONDecodeError:
            return status, data

    def text(self, public, caller):
        return self.request(public, "/v1/calls/" + caller + "/text", "PUT", {"model": "small", "system": ["fixture"], "messages": [{"role": "user", "parts": [{"text": "fixture"}]}], "output": {"maxTokens": 20}, "cache": False}, self.token)

    def test_listener_separation_header_deadline_and_lock(self):
        process, public, internal = self.start()
        self.assertEqual(self.request(public, "/health"), (200, {"status": "ready"}))
        self.assertEqual(self.request(internal, "/health"), (200, {"status": "ready"}))
        self.assertEqual(self.request(public, "/internal/v1/budgets", token=OPERATOR)[0], 404)
        self.assertEqual(self.request(internal, "/v1/allowance", token=self.token)[0], 404)
        self.assertEqual(self.request(public, "/v1/allowance")[1]["code"], "pass_missing")
        second, _, _ = self.start(ready=False)
        self.assertEqual(second.wait(timeout=10), 1)
        self.assertIn("windmill-ai: already_running", self.logs[-1].read_text())
        with socket.create_connection(("127.0.0.1", public), timeout=15) as slow:
            slow.sendall(b"GET /health HTTP/1.1\r\nHost: fixture\r\n")
            start = time.monotonic()
            self.assertEqual(slow.recv(4096), b"")
            self.assertGreaterEqual(time.monotonic() - start, 9)
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=10), 0)
        for listener in (public, internal):
            with self.assertRaises(OSError):
                socket.create_connection(("127.0.0.1", listener), timeout=1)

    def test_runbook_fund_close_reopen_inspect_and_correct(self):
        _, public, internal = self.start()
        instant = int(time.time() * 1000)
        path = "/internal/v1/grants/subscription-fixture"
        grant = {"accountId": "funded-fixture", "plan": "one", "period": {"start": instant - 1000, "end": instant + 86400000}}
        self.assertEqual(self.request(internal, path, "PUT", grant, FUNDING), (200, {"outcome": "ok"}))
        self.assertEqual(self.request(internal, path, "PUT", grant, FUNDING), (200, {"outcome": "replay"}))
        self.assertEqual(self.request(internal, path + "/close", "POST", {"closedAt": instant}, FUNDING), (200, {"outcome": "ok"}))
        self.assertEqual(self.request(internal, path + "/reopen", "POST", token=FUNDING), (200, {"outcome": "ok"}))
        self.assertEqual(self.request(internal, "/internal/v1/budgets", token=FUNDING)[0], 401)
        pending = self.executor.submit(self.text, public, "operations-correction-fixture")
        self.assertTrue(self.provider.started.wait(10))
        process = self.processes[0]
        process.kill()
        process.wait(timeout=10)
        self.provider.release.set()
        try:
            pending.result(timeout=10)
        except (OSError, http.client.HTTPException):
            pass
        _, _, internal = self.start()
        calls = self.request(internal, "/internal/v1/calls?callId=operations-correction-fixture", token=OPERATOR)[1]
        self.assertEqual(len(calls["calls"]), 1)
        call = calls["calls"][0]
        self.assertEqual(call["state"], "assumed")
        corrected = self.request(internal, "/internal/v1/calls/" + str(call["id"]) + "/correct", "POST", {"charged": "0.000001"}, OPERATOR)
        self.assertEqual(corrected, (200, {"state": "assumed", "charged": "0.000001", "replay": False}))
        corrected = self.request(internal, "/internal/v1/calls/" + str(call["id"]) + "/correct", "POST", {"charged": "0.000001"}, OPERATOR)
        self.assertEqual(corrected, (200, {"state": "assumed", "charged": "0.000001", "replay": True}))
        inspected = self.request(internal, "/internal/v1/calls/" + str(call["id"]), token=OPERATOR)[1]
        self.assertEqual(inspected["originalCharge"], call["charged"])
        self.assertEqual(self.request(internal, "/internal/v1/principals/account/" + self.account, token=OPERATOR)[0], 200)
        self.assertEqual(self.request(internal, "/internal/v1/budgets", token=OPERATOR)[0], 200)

    def test_sigterm_finishes_text_and_closes_pending_count_admission(self):
        process, public, _ = self.start()
        active = self.executor.submit(self.text, public, "operations-active-fixture")
        self.assertTrue(self.provider.started.wait(10))
        self.provider.count_release.clear()
        self.provider.count_started.clear()
        pending = self.executor.submit(self.text, public, "operations-count-fixture")
        self.assertTrue(self.provider.count_started.wait(10))
        body = json.dumps({"model": "small", "messages": [{"role": "user", "parts": [{"text": "fixture"}]}], "output": {"maxTokens": 20}})
        body_pending = http.client.HTTPConnection("127.0.0.1", public, timeout=10)
        body_pending.putrequest("PUT", "/v1/calls/operations-body-pending-fixture/text")
        body_pending.putheader("Authorization", "Bearer " + self.token)
        body_pending.putheader("Content-Length", str(len(body)))
        body_pending.endheaders()
        time.sleep(0.2)
        process.send_signal(signal.SIGTERM)
        time.sleep(0.2)
        self.provider.count_release.set()
        self.assertEqual(pending.result(timeout=10)[1]["code"], "busy")
        body_pending.send(body.encode())
        response = body_pending.getresponse()
        self.assertEqual((response.status, json.loads(response.read())["code"]), (503, "busy"))
        body_pending.close()
        self.assertEqual(self.request(public, "/v1/calls/operations-active-fixture", token=self.token)[1]["state"], "dispatched")
        self.provider.release.set()
        status, events = active.result(timeout=10)
        self.assertEqual(status, 200)
        self.assertIn('"charged":"0.000015"', events)
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertEqual(self.sql("SELECT caller_id||':'||state FROM ai_calls"), "operations-active-fixture:settled")

    def test_reserved_kill_releases_and_dispatched_kill_assumes(self):
        process, public, _ = self.start()
        self.sql("CREATE FUNCTION pause_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='dispatched' THEN PERFORM pg_sleep(30); END IF; RETURN NEW; END $$; CREATE TRIGGER pause_dispatch BEFORE UPDATE ON ai_calls FOR EACH ROW EXECUTE FUNCTION pause_dispatch()")
        pending = self.executor.submit(self.text, public, "operations-reserved-fixture")
        wait_for(lambda: self.sql("SELECT state FROM ai_calls") == "reserved")
        process.kill()
        process.wait(timeout=10)
        try:
            pending.result(timeout=10)
        except (OSError, http.client.HTTPException):
            pass
        self.sql("DROP TRIGGER pause_dispatch ON ai_calls; DROP FUNCTION pause_dispatch()")
        _, _, internal = self.start()
        call = self.request(internal, "/internal/v1/calls?callId=operations-reserved-fixture", token=OPERATOR)[1]["calls"][0]
        self.assertEqual((call["state"], call["charged"]), ("unconsumed", "0"))
        self.assertEqual(self.provider.dispatches, 0)

    def test_database_loss_returns_null_then_retries_settlement(self):
        _, public, internal = self.start()
        active = self.executor.submit(self.text, public, "operations-database-fixture")
        self.assertTrue(self.provider.started.wait(10))
        self.sql("ALTER DATABASE " + self.database_name + " ALLOW_CONNECTIONS false", admin=True)
        self.sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='" + self.database_name + "'", admin=True)
        self.provider.release.set()
        status, events = active.result(timeout=50)
        self.assertEqual(status, 200)
        self.assertIn('"charged":null', events)
        self.assertEqual(self.request(public, "/v1/allowance", token=self.token)[1]["code"], "accounting_unavailable")
        self.sql("ALTER DATABASE " + self.database_name + " ALLOW_CONNECTIONS true", admin=True)
        wait_for(lambda: self.sql("SELECT state FROM ai_calls WHERE caller_id='operations-database-fixture'") == "settled", seconds=80)
        call = self.request(internal, "/internal/v1/calls?callId=operations-database-fixture", token=OPERATOR)[1]["calls"][0]
        self.assertEqual(call["charged"], "0.000015")
        self.assertEqual(self.provider.dispatches, 1)

    def test_startup_database_failure_emits_an_issue(self):
        process, _, _ = self.start({"AI_DATABASE_URL": "postgresql://fixture@127.0.0.1:" + str(port()) + "/missing"}, ready=False)
        self.assertEqual(process.wait(timeout=15), 1)
        self.assertIn("windmill-ai: database_unavailable", self.logs[-1].read_text())
        time.sleep(1)
        self.assertTrue(self.capture.envelopes, "unexpected startup database failure delivered no Sentry envelope")

    def test_internal_read_failure_emits_an_issue(self):
        _, _, internal = self.start()
        self.sql("ALTER TABLE ai_calls RENAME TO ai_calls_unavailable")
        self.assertEqual(self.request(internal, "/internal/v1/calls", token=OPERATOR), (503, {"code": "accounting_unavailable", "allowance": None}))
        time.sleep(1)
        self.assertTrue(self.capture.envelopes, "unexpected internal read storage failure delivered no Sentry envelope")

    def test_call_and_principal_pagination(self):
        _, public, internal = self.start()
        self.provider.release.set()
        self.assertEqual(self.text(public, "operations-pagination-fixture")[0], 200)
        self.sql("INSERT INTO ai_calls SELECT (jsonb_populate_record(NULL::ai_calls, to_jsonb(c)||jsonb_build_object('id',nextval('ai_calls_id_seq'),'caller_id','operations-page-fixture-'||g.n))).* FROM ai_calls c CROSS JOIN generate_series(1,1001) g(n) WHERE c.caller_id='operations-pagination-fixture'")
        expected_ids = [int(value) for value in self.sql("SELECT id FROM ai_calls ORDER BY id DESC").splitlines()]
        for route in ("/internal/v1/calls", "/internal/v1/principals/account/" + self.account):
            first = self.request(internal, route, token=OPERATOR)[1]
            self.assertEqual(len(first["calls"]), 1000)
            self.assertEqual(first["nextBeforeId"], first["calls"][-1]["id"])
            second = self.request(internal, route + "?before=" + str(first["nextBeforeId"]), token=OPERATOR)[1]
            self.assertEqual(len(second["calls"]), 2)
            self.assertIsNone(second["nextBeforeId"])
            ids = [call["id"] for call in first["calls"] + second["calls"]]
            self.assertEqual(ids, expected_ids)

    def test_rotation_overlap_and_configuration_rejection(self):
        alternate = self.sign("rotation-next")
        process, public, _ = self.start()
        self.assertEqual(self.request(public, "/v1/allowance", token=self.token)[0], 200)
        self.assertEqual(self.request(public, "/v1/allowance", token=alternate)[1]["code"], "pass_signature")
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=10), 0)
        process, public, _ = self.start({"AI_PASS_KEYS": json.dumps({"test-rfc8032": PUBLIC_KEY, "rotation-next": PUBLIC_KEY})})
        for token in (self.token, alternate):
            self.assertEqual(self.request(public, "/v1/allowance", token=token)[0], 200)
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=10), 0)
        process, public, _ = self.start({"AI_PASS_KEYS": json.dumps({"rotation-next": PUBLIC_KEY})})
        self.assertEqual(self.request(public, "/v1/allowance", token=self.token)[1]["code"], "pass_signature")
        self.assertEqual(self.request(public, "/v1/allowance", token=alternate)[0], 200)
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=10), 0)
        for changes, code in (({"AI_ENVIRONMENT": "production", "AI_PASS_KEYS": json.dumps({"rotation-next": PUBLIC_KEY})}, "AI_PASS_KEYS"),
                              ({"AI_OPERATOR_SECRET": FUNDING}, "AI_INTERNAL_SECRETS"),
                              ({"AI_ANTHROPIC_URL": "http://example.invalid"}, "AI_ANTHROPIC_URL"),
                              ({"AI_CARRY_KEY": "invalid"}, "AI_CARRY_KEY")):
            process, _, _ = self.start(changes, ready=False)
            self.assertEqual(process.wait(timeout=10), 1)
            self.assertEqual(self.logs[-1].read_text().strip(), "windmill-ai: " + code)

    def test_database_blackhole_cannot_hold_shutdown_before_drain(self):
        destination = urllib.parse.urlsplit(self.database)
        proxy = socketserver.ThreadingTCPServer(("127.0.0.1", 0), DatabaseProxy)
        proxy.daemon_threads = True
        proxy.destination = (destination.hostname, destination.port)
        proxy.paused = threading.Event()
        proxy.stopping = threading.Event()
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        proxy_url = urllib.parse.urlunsplit(destination._replace(netloc=destination.username + "@127.0.0.1:" + str(proxy.server_address[1]), query="application_name=ops-blackhole"))
        try:
            process, public, _ = self.start({"AI_DATABASE_URL": proxy_url})
            self.assertEqual(self.request(public, "/v1/allowance", token=self.token)[0], 200)
            holder_url = self.database + "?application_name=ops-lock-holder"
            holder = subprocess.Popen(["psql", "-XAtq", holder_url, "-c", "BEGIN; LOCK TABLE ai_calls IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(35); COMMIT"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.processes.append(holder)
            wait_for(lambda: self.sql("SELECT count(*) FROM pg_locks WHERE relation='ai_calls'::regclass AND mode='AccessExclusiveLock' AND granted") == "1")
            request = self.executor.submit(self.text, public, "operations-blackhole-fixture")
            wait_for(lambda: self.sql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='ops-blackhole' AND wait_event_type='Lock'") == "1")
            proxy.paused.set()
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.fail("SIGTERM remained blocked with no admitted calls after 15s; lifecycle lock precedes the DRAIN timer while DB reply is blackholed")
            self.assertEqual(process.returncode, 0)
        finally:
            proxy.paused.clear()
            self.sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='ops-lock-holder'")
            proxy.stopping.set()
            proxy.shutdown()
            proxy.server_close()

    def test_sigterm_cuts_and_settles_live_audio(self):
        provider = socketserver.ThreadingTCPServer(("127.0.0.1", 0), LiveProvider)
        provider.daemon_threads = True
        provider.audio = threading.Event()
        threading.Thread(target=provider.serve_forever, daemon=True).start()
        try:
            process, public, _ = self.start({"AI_OPENAI_KEY": "fixture", "AI_OPENAI_URL": "ws://127.0.0.1:" + str(provider.server_address[1]) + "/v1/realtime?intent=transcription"})
            with socket.create_connection(("127.0.0.1", public), timeout=20) as connection:
                connection.sendall(("GET /v1/calls/operations-live-shutdown-fixture/transcription HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: wm-live.v1\r\nAuthorization: Bearer " + self.token + "\r\n\r\n").encode())
                headers = bytearray()
                while not headers.endswith(b"\r\n\r\n"):
                    headers.extend(connection.recv(1))
                self.assertIn(b"101 Switching Protocols", headers)
                self.assertEqual(json.loads(receive_frame(connection)[1])["type"], "started")
                send_frame(connection, 2, bytes(48000), masked=True)
                self.assertTrue(provider.audio.wait(10))
                process.send_signal(signal.SIGTERM)
                while True:
                    opcode, data = receive_frame(connection)
                    if opcode != 1:
                        continue
                    event = json.loads(data)
                    if event["type"] == "ended":
                        break
                self.assertEqual((event["stop"], event["code"], event["seconds"], event["charged"]), ("cut", "restarting", 1, "0.000283334"))
            self.assertEqual(process.wait(timeout=15), 0)
            self.assertEqual(self.sql("SELECT state||':'||charged FROM ai_calls"), "settled:283334")
        finally:
            provider.shutdown()
            provider.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    arguments, tests = parser.parse_known_args()
    BINARY = str(Path(arguments.binary).resolve())
    unittest.main(argv=[__file__, *tests])
