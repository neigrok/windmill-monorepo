#!/usr/bin/env python3
import argparse
import base64
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import threading
import time
import urllib.parse
import uuid


ROOT = Path(__file__).resolve().parents[2]
PRIVATE_TEXT = "COACH_PRIVATE_LOCAL_PROBE"
SCENARIOS = ("two-rounds", "transient", "cut-stream", "proxy-before-event", "proxy-after-event",
             "stop", "recover-final", "recover-tools")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def wait_for(check, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError, http.client.HTTPException):
            pass
        time.sleep(0.05)
    raise AssertionError("bounded probe condition did not become true")


def available_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def json_file(path, value):
    with open(path, "w", opener=lambda name, flags: os.open(name, flags, 0o600)) as file:
        json.dump(value, file)


def request(port, path, method="GET", value=None, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        body = None if value is None else json.dumps(value)
        connection.request(method, path, body, {"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        data = response.read()
        return response.status, json.loads(data) if data else None
    finally:
        connection.close()


class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        if self.path.endswith("count_tokens"):
            data = b'{"input_tokens":10}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        fixture = self.server.fixture
        fixture.dispatches.append(body)
        round_number = len(fixture.dispatches)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        first = round_number == 1
        text = "Read. " if first else "Done."
        events = [
            {"type": "message_start", "message": {"id": "local-provider", "role": "assistant", "content": [], "usage": {"input_tokens": 10, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
            {"type": "content_block_stop", "index": 0},
        ]
        self.send_events(events)
        if fixture.hold_round == round_number:
            fixture.waiting.set()
            require(fixture.release.wait(90), "provider barrier timed out")
        elif fixture.scenario in ("stop", "cut-stream", "proxy-after-event"):
            time.sleep(0.3)
        if first:
            for index, name in enumerate(("read", "write"), 1):
                self.send_events([
                    {"type": "content_block_start", "index": index, "content_block": {"type": "tool_use", "id": "tool_" + str(index), "name": name, "input": {}}},
                    {"type": "content_block_delta", "index": index, "delta": {"type": "input_json_delta", "partial_json": json.dumps({"value": index})}},
                    {"type": "content_block_stop", "index": index},
                ])
        self.send_events([
            {"type": "message_delta", "delta": {"stop_reason": "tool_use" if first else "end_turn"}, "usage": {"output_tokens": 10}},
            {"type": "message_stop"},
        ])

    def send_events(self, events):
        for event in events:
            self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()


class Proxy(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def do_PUT(self):
        self.forward()

    def forward(self):
        fixture = self.server.fixture
        path = urllib.parse.urlsplit(self.path).path
        ai = path.startswith(("/v1/calls/", "/v1/pictures/")) or path == "/v1/allowance"
        require(not path.startswith("/internal/"), "public proxy reached an internal route")
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        headers = {key: value for key, value in self.headers.items() if key.lower() not in ("host", "connection", "content-length")}
        if ai:
            require(not any(key.lower() in ("cookie", "x-windmill-installation") for key in headers), "client sent backend credentials to AI")
            require(headers.get("Authorization", "").startswith("Bearer wm-pass."), "AI request did not carry its pass")
            fixture.passes.add(headers["Authorization"][7:])
        fixture.requests.append({"method": self.command, "path": self.path})
        if self.command == "PUT" and path.endswith("/text"):
            previous = fixture.bodies.setdefault(self.path, body)
            require(previous == body, "retry changed the serialized request")
            if fixture.scenario == "transient" and not fixture.injected:
                fixture.injected = True
                data = json.dumps({"code": "busy", "allowance": None}).encode()
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        upstream = http.client.HTTPConnection("127.0.0.1", fixture.ai_port if ai else fixture.backend_port, timeout=100)
        try:
            upstream.request(self.command, self.path, body or None, headers)
            response = upstream.getresponse()
            proxy_error = (
                (fixture.scenario == "proxy-before-event" and self.command == "PUT" and path.endswith("/text"))
                or (fixture.scenario == "proxy-after-event" and self.command == "GET" and path.endswith("/result"))
            )
            if proxy_error and not fixture.proxy_error and response.status == 200:
                fixture.proxy_error = True
                data = b"<html>Bad gateway</html>"
                self.send_response(502)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in ("connection", "transfer-encoding", "content-length"):
                    self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()
            if "text/event-stream" not in response.getheader("Content-Type", ""):
                self.wfile.write(response.read())
                return
            frame = bytearray()
            while line := response.readline():
                frame.extend(line)
                self.wfile.write(line)
                self.wfile.flush()
                if line.strip():
                    continue
                if fixture.scenario in ("cut-stream", "proxy-after-event") and not fixture.injected and b"event: text" in frame:
                    fixture.injected = True
                    self.close_connection = True
                    return
                frame.clear()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()


class Fixture:
    def __init__(self, args):
        self.args = args
        self.scratch = args.scratch.resolve()
        self.scratch.mkdir(parents=True, exist_ok=True)
        require(not any(self.scratch.iterdir()), "scratch directory must be empty")
        os.chmod(self.scratch, 0o700)
        self.processes = []
        self.servers = []
        self.databases = []
        self.admin = json.loads(args.database_admin_file.read_text())["DATABASE_URL"]
        self.prefix = "coach_probe_" + secrets.token_hex(6)
        self.backend_port, self.ai_port, self.internal_port = (available_port() for _ in range(3))
        self.passes = set()
        self.session = secrets.token_hex(24)
        self.account = str(uuid.uuid4())
        self.owner = self.prefix + "@example.com"
        self.release = threading.Event()
        self.waiting = threading.Event()
        self.reset("two-rounds")

    def reset(self, scenario):
        self.scenario = scenario
        self.dispatches, self.requests, self.bodies = [], [], {}
        self.injected = False
        self.proxy_error = False
        self.hold_round = {"recover-final": 2, "recover-tools": 1}.get(scenario)
        self.release.clear()
        self.waiting.clear()

    def sql(self, database, query):
        result = subprocess.run(["psql", "-XAtq", "-v", "ON_ERROR_STOP=1", database], input=query, capture_output=True, text=True, timeout=20)
        require(result.returncode == 0, "probe SQL failed")
        return result.stdout.strip()

    def database(self, suffix):
        name = self.prefix + "_" + suffix
        self.sql(self.admin, "CREATE DATABASE " + name + " ENCODING 'UTF8' TEMPLATE template0")
        self.databases.append(name)
        url = urllib.parse.urlsplit(self.admin)._replace(path="/" + name)
        database = urllib.parse.urlunsplit(url)
        require(self.sql(database, "SHOW server_encoding") == "UTF8", "probe requires UTF8")
        return database

    def start_process(self, command, env, name, cwd):
        log = self.scratch / (name + ".log")
        with log.open("wb") as output:
            process = subprocess.Popen(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        self.processes.append(process)
        return process

    def serve(self, handler):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server.fixture = self
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.servers.append(server)
        return server.server_port

    def start(self):
        rest, sync = self.database("rest"), self.database("sync")
        self.ai_database = self.database("ai")
        for database in (rest, sync):
            self.sql(database, (ROOT / "backend/db/schema.sql").read_text())
        now = int(time.time() * 1000)
        self.sql(rest, "INSERT INTO users(id,email) VALUES ('" + self.account + "','" + self.owner + "'); INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('" + hashlib.sha256(self.session.encode()).hexdigest() + "','" + self.account + "'," + str(now + 3600000) + ")")
        provider = self.serve(Provider)
        proxy = self.serve(Proxy)
        self.origin = "http://127.0.0.1:" + str(proxy)
        vectors = json.loads((ROOT / "packages/api-contract/ai/passes/vectors.json").read_text())
        common = {"PATH": os.environ["PATH"], "TZ": "UTC"}
        backend_env = {**common, "DATABASE_URL": rest, "WM_SYNC_DATABASE_URL": sync,
            "PORT": str(self.backend_port), "WINDMILL_HOST": "127.0.0.1", "WINDMILL_APP_URL": self.origin,
            "WINDMILL_ALLOWED_ORIGINS": self.origin, "WINDMILL_OWNER_EMAILS": self.owner,
            "AI_PASS_PRIVATE_SEED": vectors["privateSeed"], "AI_PASS_KID": vectors["kid"],
            "AI_PASS_ENVIRONMENT": "development", "AI_PASS_MIN_VERSIONS": '{"vector.coach":1}',
            "AI_INSTALLATIONS_ENABLED": "false", "REMINDERS_ENABLED": "false", "TENDING_ENABLED": "false"}
        self.start_process([str(self.args.backend_binary.resolve())], backend_env, "backend", ROOT / "backend")
        wait_for(lambda: request(self.backend_port, "/v1/me")[0] == 401)
        ai_env = {**common, "AI_ENVIRONMENT": "development", "AI_DATABASE_URL": self.ai_database,
            "AI_PUBLIC_ADDRESS": "127.0.0.1:" + str(self.ai_port), "AI_INTERNAL_ADDRESS": "127.0.0.1:" + str(self.internal_port),
            "AI_PASS_KEYS": json.dumps({vectors["kid"]: vectors["publicKey"]}),
            "AI_CARRY_KEY": base64.urlsafe_b64encode(bytes(32)).decode().rstrip("="),
            "AI_FUNDING_SECRET": "f" * 32, "AI_OPERATOR_SECRET": "o" * 32,
            "AI_ANTHROPIC_KEY": "local-fixture", "AI_ANTHROPIC_URL": "http://127.0.0.1:" + str(provider)}
        self.start_process([str(self.args.ai_binary.resolve())], ai_env, "ai", ROOT / "services/ai")
        wait_for(lambda: request(self.ai_port, "/health")[0] == 200)

    def client(self, case, config):
        config_path, output_path = self.scratch / (case + ".config.json"), self.scratch / (case + ".out.json")
        json_file(config_path, config)
        env = {**os.environ, "WM_COACH_PROBE_CONFIG": str(config_path), "WM_COACH_PROBE_OUT": str(output_path),
               "WM_COACH_PROBE_STATE": str(self.scratch / (self.scenario + ".state.json"))}
        command = json.loads(self.args.command_file.read_text())
        require(isinstance(command, list) and all(isinstance(item, str) for item in command), "command file must hold an argv array")
        return self.start_process(command, env, case, self.args.client_cwd), output_path

    def stop(self, process):
        if process.poll() is None:
            listing = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True, timeout=5, check=True)
            parents = {int(pid): int(parent) for pid, parent in (line.split() for line in listing.stdout.splitlines())}
            descendants = [process.pid]
            for parent in descendants:
                descendants.extend(pid for pid, owner in parents.items() if owner == parent)
            for pid in reversed(descendants):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        process.wait(timeout=10)

    def run_case(self, scenario):
        self.reset(scenario)
        story = json.loads((ROOT / "packages/api-contract/agent/turns/two-rounds.json").read_text())
        call_ids = [secrets.token_urlsafe(18) for _ in range(3)]
        config = {"origin": self.origin, "session": self.session, "scenario": "two-rounds" if self.hold_round else scenario,
                  "profile": story["profile"], "input": {**story["input"], "turnId": uuid.uuid4().hex, "question": PRIVATE_TEXT},
                  "runtime": {"callIds": call_ids}}
        process, output_path = self.client(scenario, config)
        first_request_count = None
        if self.hold_round:
            require(self.waiting.wait(45), "client did not reach held provider round")
            state_path = self.scratch / (scenario + ".state.json")
            state = wait_for(lambda: json.loads(state_path.read_text()) if state_path.exists() else None)
            expected_text = "Read. Done." if self.hold_round == 2 else "Read. "
            state = wait_for(lambda: (value if (value := json.loads(state_path.read_text()))["text"] == expected_text else None))
            require({"mark", "text", "state", "executions"} <= set(state) <= {"mark", "text", "state", "values", "executions"}, "host persisted working state")
            require(state["mark"]["callId"] == call_ids[self.hold_round - 1], "wrong recovery call mark")
            self.stop(process)
            self.release.set()
            wait_for(lambda: self.sql(self.ai_database, "SELECT count(*) FROM ai_calls WHERE principal_id='" + self.account + "' AND caller_id='" + call_ids[self.hold_round - 1] + "' AND state='settled'") == "1")
            first_request_count = len(self.requests)
            config["scenario"] = scenario
            process, output_path = self.client(scenario + "-relaunch", config)
        try:
            require(process.wait(timeout=60) == 0, "client process failed; inspect its local log")
        except subprocess.TimeoutExpired:
            self.stop(process)
            raise AssertionError("client process exceeded 60 seconds") from None
        output = json.loads(output_path.read_text())
        state = json.loads((self.scratch / (scenario + ".state.json")).read_text())
        expected_end = "stopped" if scenario == "stop" else "interrupted" if scenario == "recover-tools" else "completed"
        require(output["end"]["state"] == expected_end, "unexpected end state: " + str(output["end"]))
        expected_calls = 1 if scenario in ("stop", "recover-tools") else 2
        require(len(self.dispatches) == expected_calls, "provider dispatch repeated or missing")
        expected_executions = 0 if expected_calls == 1 else 2
        require(len(state["executions"]) == expected_executions and len(set(state["executions"])) == expected_executions, "abilities repeated or missing")
        require(state["mark"] is None, "terminal mark was retained")
        require(state["text"] == ("Read. " if expected_calls == 1 else "Read. Done."), "visible text was lost or duplicated")
        if first_request_count is not None:
            resumed = self.requests[first_request_count:]
            require(any(item["method"] == "GET" and "/v1/calls/" in item["path"] for item in resumed), "recovery did not read its call")
            require(not any(item["method"] == "PUT" for item in resumed), "recovery admitted another call")
        if scenario in ("cut-stream", "proxy-after-event"):
            require(self.injected and any(item["method"] == "GET" and "after=" in item["path"] for item in self.requests), "cut stream did not resume by cursor")
        if scenario in ("transient", "proxy-before-event"):
            require(sum(item["method"] == "PUT" and urllib.parse.urlsplit(item["path"]).path == "/v1/calls/" + call_ids[0] + "/text" for item in self.requests) == 2, "transient refusal did not retry identical call")
        if scenario.startswith("proxy-"):
            require(self.proxy_error, "proxy error did not replace an admitted response")
            if scenario == "proxy-after-event":
                require(sum(item["method"] == "GET" and "/result" in item["path"] for item in self.requests) >= 2, "proxy result error was not retried")
        failures = output.get("failures", []) + [item for item in output.get("telemetry", []) if "operation" in item]
        require(not failures, "expected local-service scenario reported a client failure")
        selected = ",".join("'" + value + "'" for value in call_ids)
        rows = self.sql(self.ai_database, "SELECT caller_id,state,held,applied,charged,(SELECT coalesce(sum(delta),0) FROM ai_spend_events WHERE call_id=c.id) FROM ai_calls c WHERE caller_id IN (" + selected + ") ORDER BY caller_id").splitlines()
        require(len(rows) == expected_calls, "ledger call identity duplicated")
        for row in rows:
            _, state_name, held, applied, charged, spent = row.split("|")
            require(state_name == "settled" and held == "0" and applied == charged == spent and int(charged) > 0, "call was not charged exactly once")
        return {"scenario": scenario, "end": expected_end, "providerCalls": expected_calls, "abilityCalls": expected_executions,
                "requests": self.requests, "ledger": "one settled charge per call"}

    def close(self):
        self.release.set()
        for process in reversed(self.processes):
            self.stop(process)
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for name in reversed(self.databases):
            self.sql(self.admin, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='" + name + "'")
            self.sql(self.admin, "DROP DATABASE " + name)
        for path in self.scratch.glob("*.config.json"):
            path.unlink()

    def check_logs(self):
        for name in ("backend.log", "ai.log"):
            log = (self.scratch / name).read_text()
            require(all(value not in log for value in (PRIVATE_TEXT, self.session, *self.passes)), "private content leaked into service logs")
        backend = (self.scratch / "backend.log").read_text()
        require('ai.pass.sign' in backend, "pass completion observation missing")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-admin-file", type=Path, required=True)
    parser.add_argument("--backend-binary", type=Path, required=True)
    parser.add_argument("--ai-binary", type=Path, required=True)
    parser.add_argument("--command-file", type=Path, required=True)
    parser.add_argument("--client-cwd", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--surface", choices=("web", "ios", "android"), required=True)
    parser.add_argument("--scenario", action="append", choices=SCENARIOS)
    args = parser.parse_args()
    fixture = Fixture(args)
    evidence = []
    try:
        fixture.start()
        for scenario in args.scenario or SCENARIOS:
            evidence.append(fixture.run_case(scenario))
            print(args.surface + ": " + scenario + " passed", flush=True)
    finally:
        fixture.close()
    fixture.check_logs()
    json_file(args.scratch / "evidence.json", {"surface": args.surface, "cases": evidence, "contentFreeServiceLogs": True})


if __name__ == "__main__":
    main()
