#!/usr/bin/env python3
# Roadmap Coach on a local stack for a phone's suite: the backend signing passes and serving roadmap through the sync engine,
# the AI service, a provider the stack plays and one origin in front, then the suite the command file names. It creates its
# databases and listeners and removes both when it finishes; it never reads a provider credential or calls one.
import argparse
import base64
import getpass
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import threading
import time
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parents[2]


def wait_for(check, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(0.2)
    raise SystemExit("a listener did not come up in time")


def status(port, path):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("GET", path)
        return connection.getresponse().status
    finally:
        connection.close()


def texts(body):
    content = body["messages"][0]["content"]
    return [block.get("text", "") for block in content if block.get("type") == "text"]


# Anthropic's streaming Messages API, playing a story by the question the round's first content ends with: "add a subtask:
# <words>" calls update_node on the step the conversation is about, or the roadmap's first; anything else answers in words.
class Provider(http.server.BaseHTTPRequestHandler):

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        if self.path.endswith("count_tokens"):
            return self.json({"input_tokens": 10})
        parts = texts(body)
        question = parts[-1] if parts else ""
        answered = any(message["role"] == "user" and any(block.get("type") == "tool_result" for block in message["content"])
                       for message in body["messages"][1:] if isinstance(message.get("content"), list))
        self.server.stack.log("provider", "round", "answered" if answered else "first")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.events([{"type": "message_start", "message": {"id": "msg_local", "role": "assistant", "content": [],
            "usage": {"input_tokens": 10, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}}])
        context = next((json.loads(part.split("\n", 1)[1]) for part in parts if "\n{" in part), {})
        steps = context.get("steps", [])
        subtask = re.search(r"add a subtask:\s*(.+)", question, re.IGNORECASE)
        if subtask and not answered:
            step = (context.get("step") or (steps[0] if steps else {})).get("id", "")
            words = subtask.group(1).strip()
            return self.tool("update_node", {"treeId": context.get("tree", {}).get("id", ""), "nodeId": step,
                                             "subtasks": [words[:1].upper() + words[1:]]})
        if answered:
            return self.stop("end_turn", closed=True)
        frontier = [line["label"] for line in steps if line.get("state") == "available"]
        self.text(" ".join(frontier[:2]) + " are open now." if frontier else "Start at the top.")
        self.stop("end_turn")

    def text(self, words):
        self.events([{"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                     {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": words}}])

    def tool(self, name, arguments):
        self.events([{"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_" + secrets.token_hex(6), "name": name, "input": {}}},
                     {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps(arguments)}},
                     {"type": "content_block_stop", "index": 0}])
        self.stop("tool_use", closed=True)

    def stop(self, reason, closed=False):
        if not closed:
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


# The one origin the phone talks to: the AI service's public routes to it, every other route to the backend.
class Origin(http.server.BaseHTTPRequestHandler):

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
        ai = path.startswith(("/v1/calls/", "/v1/pictures/")) or path == "/v1/allowance"
        headers = {key: value for key, value in self.headers.items() if key.lower() not in ("host", "connection", "content-length")}
        if ai and any(key.lower() in ("cookie", "x-windmill-installation") for key in headers):
            stack.leaks.append(path)
        stack.requests.append(self.command + " " + path)
        if path == "/v1/events":
            stack.events += [event.get("name", "") for event in json.loads(body or b"{}").get("events", [])]
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
            while line := response.readline():
                self.wfile.write(line)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()
            self.close_connection = True


class Stack:
    def __init__(self, args):
        self.args = args
        self.scratch = args.scratch.resolve()
        self.scratch.mkdir(parents=True, exist_ok=True)
        self.processes, self.servers, self.databases = [], [], []
        self.requests, self.leaks, self.events = [], [], []
        self.backend_port, self.ai_port, self.provider_port, self.internal_port, self.origin_port = args.ports
        self.session = secrets.token_hex(24)
        self.account = str(uuid.uuid4())
        self.owner = "room-" + secrets.token_hex(4) + "@example.com"
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
        name = self.args.database_prefix + suffix
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
            "AI_PASS_ENVIRONMENT": "development", "AI_PASS_MIN_VERSIONS": '{"gym.coach":1,"roadmap.coach":1}', "ROADMAP_ENGINE_ENABLED": "1",
            "REMINDERS_ENABLED": "false", "TENDING_ENABLED": "false"},
            "backend", ROOT / "backend")
        wait_for(lambda: status(self.backend_port, "/v1/me") == 401)
        self.start_process([str(self.args.ai_binary.resolve())], {**common, "AI_ENVIRONMENT": "development", "AI_DATABASE_URL": "postgres://" + getpass.getuser() + "@localhost/" + self.ai_database + "?host=/tmp",
            "AI_PUBLIC_ADDRESS": "127.0.0.1:" + str(self.ai_port), "AI_INTERNAL_ADDRESS": "127.0.0.1:" + str(self.internal_port),
            "AI_PASS_KEYS": json.dumps({vectors["kid"]: vectors["publicKey"]}), "AI_CARRY_KEY": base64.urlsafe_b64encode(bytes(32)).decode().rstrip("="),
            "AI_FUNDING_SECRET": "f" * 32, "AI_OPERATOR_SECRET": "o" * 32, "AI_ANTHROPIC_KEY": "local-fixture",
            "AI_ANTHROPIC_URL": "http://127.0.0.1:" + str(self.provider_port)}, "ai", ROOT / "services/ai")
        wait_for(lambda: status(self.ai_port, "/health") == 200)
        self.session_file = self.scratch / "session.json"
        self.session_file.write_text(json.dumps({"account": self.account, "token": self.session, "email": self.owner}))
        os.chmod(self.session_file, 0o600)
        with (self.scratch / "seed.log").open("w") as log:
            seeded = subprocess.run(["node", str(ROOT / "tools/coach-e2e/room_seed.mjs")], env={**os.environ, "PORT": str(self.backend_port),
                                    "WM_COACH_E2E_SESSION": str(self.session_file)}, stdout=log, stderr=subprocess.STDOUT, timeout=150)
        if seeded.returncode != 0:
            raise SystemExit("the browser could not seed the account; see " + str(self.scratch / "seed.log"))

    def run_suite(self):
        command = json.loads(self.args.command_file.read_text())
        env = {**os.environ, "WM_COACH_E2E_SERVER": "http://127.0.0.1:" + str(self.origin_port), "WM_COACH_E2E_SESSION": str(self.session_file),
               "WM_COACH_E2E_EMAIL": self.owner, "TEST_RUNNER_WM_COACH_E2E_SERVER": "http://127.0.0.1:" + str(self.origin_port),
               "TEST_RUNNER_WM_COACH_E2E_SESSION": str(self.session_file), "TEST_RUNNER_WM_COACH_E2E_EMAIL": self.owner}
        with (self.scratch / "suite.log").open("ab") as log:
            suite = subprocess.Popen(command, cwd=self.args.client_cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                return suite.wait(timeout=self.args.suite_seconds)
            except subprocess.TimeoutExpired:
                os.killpg(suite.pid, signal.SIGKILL)
                raise SystemExit("the suite ran past its time; see " + str(self.scratch / "suite.log"))

    def close(self):
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

    def evidence(self):
        backend = (self.scratch / "backend.log").read_text(errors="replace")
        ai = (self.scratch / "ai.log").read_text(errors="replace")
        coach = sorted(name for name in set(self.events) if name.startswith("roadmap_coach_"))
        return {"leaks": self.leaks, "sessionLogged": self.session in backend or self.session in ai,
                "passesSigned": backend.count("ai.pass.sign"), "calls": sum(1 for request in self.requests if request.startswith("PUT /v1/calls/")),
                "requests": len(self.requests), "coachEvents": {name: self.events.count(name) for name in coach}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend-binary", type=Path, required=True)
    parser.add_argument("--ai-binary", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--command-file", type=Path, required=True, help="the suite's command, a JSON argv array")
    parser.add_argument("--client-cwd", type=Path, default=ROOT)
    parser.add_argument("--database-prefix", default="wm_coach_room_")
    parser.add_argument("--ports", type=int, nargs=5, default=[8302, 8303, 8304, 8305, 8306],
                        help="backend, AI service, provider, AI service internal, the phone's origin")
    parser.add_argument("--suite-seconds", type=int, default=1500)
    args = parser.parse_args()
    stack = Stack(args)
    try:
        stack.start()
        code = stack.run_suite()
    finally:
        stack.close()
    evidence = stack.evidence()
    (stack.scratch / "evidence.json").write_text(json.dumps(evidence, indent=1))
    print("suite exit", code, json.dumps(evidence))
    if evidence["leaks"] or evidence["sessionLogged"] or not evidence["passesSigned"]:
        raise SystemExit("the stack's evidence fails: " + json.dumps(evidence))
    raise SystemExit(code)


if __name__ == "__main__":
    main()
