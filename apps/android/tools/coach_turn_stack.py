#!/usr/bin/env python3
"""Gym Coach on a local stack for CoachTurnsLiveWireTests: the backend signing passes, the AI service, a provider the
test plays, and one origin in front of both, then the live-wire suite against it. It creates its databases, starts its
listeners on the ports given, and removes both when it finishes. It never reads a provider credential or calls one."""
import argparse
import base64
import getpass
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import threading
import time
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parents[3]


def wait_for(check, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(0.1)
    raise SystemExit("a listener did not come up in time")


def status(port, path):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("GET", path)
        return connection.getresponse().status
    finally:
        connection.close()


def question(body):
    """The question a round's first content ends with, which names the story the provider plays."""
    content = body["messages"][0]["content"]
    texts = [block.get("text", "") for block in content if block.get("type") == "text"]
    return texts[-1] if texts else ""


class Provider(http.server.BaseHTTPRequestHandler):
    """Anthropic's streaming Messages API as each story plays it, by the words after `wire` in the question."""

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        if self.path.endswith("count_tokens"):
            return self.json({"input_tokens": 10})
        stack = self.server.stack
        asked = question(body)
        story = asked.split()[1] if asked.startswith("wire ") else "question"
        rounds = sum(1 for message in body["messages"] if message["role"] == "assistant") + 1
        stack.log("provider", story, rounds)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.events([{"type": "message_start", "message": {"id": "msg_local", "role": "assistant", "content": [],
            "usage": {"input_tokens": 10, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}}])
        arguments = dict(part.split("=", 1) for part in asked.split()[2:] if "=" in part)
        play = getattr(self, "play_" + story, None)
        if play is None:
            return self.answer(0, "Done, " + story + ".")
        play(rounds, arguments, body)

    def play_write(self, rounds, arguments, body):
        if rounds == 1:
            return self.tool(0, "create_routine", {"id": "the-model-names-this", "name": "Wire day", "position": 0, "entries": [{"exerciseId": "bench-press"}]})
        self.answer(0, "Done, write.")

    def play_proposal(self, rounds, arguments, body):
        if rounds == 1:
            return self.tool(0, "propose_routine_change", {"id": "x", "routineId": arguments["routine"], "name": None,
                "entries": [{"exerciseId": "back-squat"}], "summary": "Squat"})
        self.answer(0, "Done, proposal.")

    def play_share(self, rounds, arguments, body):
        if rounds == 1:
            return self.tool(0, "share_session", {"sessionId": arguments["session"]})
        self.answer(0, "Done, share.")

    def play_picture(self, rounds, arguments, body):
        pictures = [block for block in body["messages"][0]["content"] if block.get("type") == "image"]
        seen = len(pictures) == 1 and pictures[0]["source"].get("data")
        self.answer(0, "Done, picture." if seen else "No picture.")

    def play_stop(self, rounds, arguments, body):
        self.text(0, "Checking.")
        time.sleep(3)
        self.tool(1, "list_notes", {})

    def play_cut(self, rounds, arguments, body):
        self.text(0, "Part one. ")
        time.sleep(0.5)
        self.text_more(0, "Part two.")
        self.finish("end_turn", closed=True)

    def play_killed(self, rounds, arguments, body):
        if rounds == 1:
            return self.tool(0, "list_notes", {})
        self.text(0, "Almost. ")
        stack = self.server.stack
        stack.holding.set()
        if not stack.release.wait(90):
            raise SystemExit("the held round was never released")
        self.text_more(0, "Done, killed.")
        self.finish("end_turn", closed=True)

    def answer(self, index, words):
        self.text(index, words)
        self.finish("end_turn")

    def text(self, index, words):
        self.events([{"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}},
                     {"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": words}}])

    def text_more(self, index, words):
        self.events([{"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": words}},
                     {"type": "content_block_stop", "index": index}])

    def tool(self, index, name, arguments):
        if index > 0:
            self.events([{"type": "content_block_stop", "index": index - 1}])
        self.events([{"type": "content_block_start", "index": index, "content_block": {"type": "tool_use", "id": "toolu_" + secrets.token_hex(6), "name": name, "input": {}}},
                     {"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": json.dumps(arguments)}},
                     {"type": "content_block_stop", "index": index}])
        self.finish("tool_use", closed=True)

    def finish(self, reason, closed=False):
        if not closed and reason == "end_turn":
            self.events([{"type": "content_block_stop", "index": 0}])
        self.events([{"type": "message_delta", "delta": {"stop_reason": reason}, "usage": {"output_tokens": 10}}, {"type": "message_stop"}])

    def events(self, events):
        for event in events:
            self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()

    def json(self, value):
        data = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Origin(http.server.BaseHTTPRequestHandler):
    """The one origin the phone talks to: the AI service's public routes to it, every other route to the backend, and
    `/__stack/<action>` for the test to steer the stack (cut the next stream after its first text, release a held
    round, use up every installation's allowance)."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def do_PUT(self):
        self.forward()

    def do_DELETE(self):
        self.forward()

    def forward(self):
        stack = self.server.stack
        path = urllib.parse.urlsplit(self.path).path
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if path.startswith("/__stack/"):
            return self.steer(path.removeprefix("/__stack/"))
        ai = path.startswith(("/v1/calls/", "/v1/pictures/")) or path == "/v1/allowance"
        headers = {key: value for key, value in self.headers.items() if key.lower() not in ("host", "connection", "content-length")}
        if ai and any(key.lower() in ("cookie", "x-windmill-installation") for key in headers):
            raise SystemExit("the phone sent a backend credential to the AI service")
        stack.requests.append(self.command + " " + path)
        upstream = http.client.HTTPConnection("127.0.0.1", stack.ai_port if ai else stack.backend_port, timeout=120)
        try:
            upstream.request(self.command, self.path, body or None, headers)
            response = upstream.getresponse()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in ("connection", "transfer-encoding", "content-length"):
                    self.send_header(key, value)
            self.send_header("Connection", "close")
            if "text/event-stream" not in (response.getheader("Content-Type") or ""):
                data = response.read()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.end_headers()
            frame = bytearray()
            while line := response.readline():
                frame.extend(line)
                self.wfile.write(line)
                self.wfile.flush()
                if line.strip():
                    continue
                if stack.cut_next and b"event: text" in frame:
                    stack.cut_next = False
                    stack.log("origin", "cut", path)
                    self.close_connection = True
                    return
                frame.clear()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()
            self.close_connection = True

    def steer(self, action):
        stack = self.server.stack
        if action == "cut-next-stream":
            stack.cut_next = True
        elif action == "release":
            stack.release.set()
        elif action == "holding":
            return self.reply(200 if stack.holding.wait(60) else 504)
        elif action == "exhaust-installations":
            stack.sql(stack.ai_database, "UPDATE ai_budgets SET spent = limit_nanos, held = 0 WHERE kind = 'installation'")
        else:
            return self.reply(404)
        self.reply(204)

    def reply(self, code):
        self.send_response(code)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()


class Stack:
    def __init__(self, args):
        self.args = args
        self.scratch = args.scratch.resolve()
        self.scratch.mkdir(parents=True, exist_ok=True)
        self.processes, self.servers, self.databases = [], [], []
        self.requests = []
        self.cut_next = False
        self.release, self.holding = threading.Event(), threading.Event()
        self.backend_port, self.ai_port, self.provider_port, self.internal_port, self.origin_port = args.ports
        self.session = secrets.token_hex(24)
        self.account = str(uuid.uuid4())
        self.owner = "gact-" + secrets.token_hex(4) + "@example.com"
        self.lines = open(self.scratch / "stack.log", "a")

    def log(self, *parts):
        self.lines.write(" ".join(str(part) for part in parts) + "\n")
        self.lines.flush()

    def sql(self, database, query):
        result = subprocess.run(["psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-h", "/tmp", "-d", database], input=query, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            raise SystemExit("SQL failed on " + database + ": " + result.stderr[-400:])
        return result.stdout.strip()

    def database(self, suffix):
        name = "wm_gact_" + suffix
        self.sql("postgres", "DROP DATABASE IF EXISTS " + name)
        self.sql("postgres", "CREATE DATABASE " + name + " ENCODING 'UTF8' TEMPLATE template0")
        self.databases.append(name)
        return name

    def start_process(self, command, env, name, cwd):
        log = (self.scratch / (name + ".log")).open("ab")
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.processes.append(process)
        return process

    def serve(self, handler, port):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
        server.stack = self
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.servers.append(server)

    def start(self):
        rest, sync = self.database("rest"), self.database("sync")
        self.ai_database = self.database("ai")
        for database in (rest, sync):
            self.sql(database, (ROOT / "backend/db/schema.sql").read_text())
        now = int(time.time() * 1000)
        self.sql(rest, "INSERT INTO users(id,email) VALUES ('" + self.account + "','" + self.owner + "'); INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('"
                 + hashlib.sha256(self.session.encode()).hexdigest() + "','" + self.account + "'," + str(now + 3_600_000) + ")")
        self.serve(Provider, self.provider_port)
        self.serve(Origin, self.origin_port)
        origin = "http://127.0.0.1:" + str(self.origin_port)
        vectors = json.loads((ROOT / "packages/api-contract/ai/passes/vectors.json").read_text())
        common = {"PATH": os.environ["PATH"], "TZ": "UTC"}
        socket = lambda name: "postgresql:///" + name + "?host=/tmp"
        self.start_process([str(self.args.backend_binary.resolve())], {**common, "DATABASE_URL": socket(rest), "WM_SYNC_DATABASE_URL": socket(sync),
            "PORT": str(self.backend_port), "WINDMILL_HOST": "127.0.0.1", "WINDMILL_APP_URL": origin, "WINDMILL_ALLOWED_ORIGINS": origin,
            "WINDMILL_OWNER_EMAILS": self.owner, "AI_ALLOWANCES_ENABLED": "true", "AI_ALLOWANCE_ALERT_EMAIL": self.owner, "RESEND_API_KEY": "local-fixture",
            "RESEND_FROM": "Windmill <local@example.com>", "AI_INSTALLATIONS_ENABLED": "true", "AI_INSTALLATION_PROXY_MODE": "direct",
            "AI_INSTALLATION_IP_HMAC_KEY": "k" * 40, "AI_PASS_PRIVATE_SEED": vectors["privateSeed"], "AI_PASS_KID": vectors["kid"],
            "AI_PASS_ENVIRONMENT": "development", "AI_PASS_MIN_VERSIONS": '{"gym.coach":1}', "REMINDERS_ENABLED": "false", "TENDING_ENABLED": "false"},
            "backend", ROOT / "backend")
        wait_for(lambda: status(self.backend_port, "/v1/me") == 401)
        self.start_process([str(self.args.ai_binary.resolve())], {**common, "AI_ENVIRONMENT": "development", "AI_DATABASE_URL": "postgres://" + getpass.getuser() + "@localhost/" + self.ai_database + "?host=/tmp",
            "AI_PUBLIC_ADDRESS": "127.0.0.1:" + str(self.ai_port), "AI_INTERNAL_ADDRESS": "127.0.0.1:" + str(self.internal_port),
            "AI_PASS_KEYS": json.dumps({vectors["kid"]: vectors["publicKey"]}), "AI_CARRY_KEY": base64.urlsafe_b64encode(bytes(32)).decode().rstrip("="),
            "AI_FUNDING_SECRET": "f" * 32, "AI_OPERATOR_SECRET": "o" * 32, "AI_ANTHROPIC_KEY": "local-fixture",
            "AI_ANTHROPIC_URL": "http://127.0.0.1:" + str(self.provider_port)}, "ai", ROOT / "services/ai")
        wait_for(lambda: status(self.ai_port, "/health") == 200)

    def run_suite(self):
        env = {**os.environ, "WM_ANDROID_TURN_WIRE_TEST": "1", "WM_WIRE_BASE": "http://127.0.0.1:" + str(self.origin_port),
               "WM_WIRE_BEARER": self.session, "WM_WIRE_EVIDENCE": str(self.scratch / "evidence")}
        command = ["./gradlew", "--console=plain", ":gym:testDebugUnitTest", "--tests", "*CoachTurnsLiveWireTests", "--max-workers=4"]
        with (self.scratch / "suite.log").open("ab") as log:
            suite = subprocess.Popen(command, cwd=ROOT / "apps/android", env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                return suite.wait(timeout=self.args.suite_seconds)
            except subprocess.TimeoutExpired:
                os.killpg(suite.pid, signal.SIGKILL)
                raise SystemExit("the suite ran past its time; see " + str(self.scratch / "suite.log"))

    def close(self):
        self.release.set()
        for process in reversed(self.processes):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for name in reversed(self.databases):
            self.sql("postgres", "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='" + name + "'")
            self.sql("postgres", "DROP DATABASE IF EXISTS " + name)

    def check_logs(self):
        for name in ("backend.log", "ai.log"):
            log = (self.scratch / name).read_text(errors="replace")
            if self.session in log or "wire " in log:
                raise SystemExit(name + " holds a session or a question")
        if "ai.pass.sign" not in (self.scratch / "backend.log").read_text(errors="replace"):
            raise SystemExit("the backend logged no pass it signed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend-binary", type=Path, required=True)
    parser.add_argument("--ai-binary", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--ports", type=int, nargs=5, default=[8475, 8476, 8477, 8478, 8479],
                        help="backend, AI service, provider, AI service internal, the phone's origin")
    parser.add_argument("--suite-seconds", type=int, default=1500)
    args = parser.parse_args()
    stack = Stack(args)
    try:
        stack.start()
        code = stack.run_suite()
    finally:
        stack.close()
    stack.check_logs()
    print("suite exit", code, "; requests through the origin:", len(stack.requests))
    raise SystemExit(code)


if __name__ == "__main__":
    main()
