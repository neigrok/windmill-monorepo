#!/usr/bin/env python3
import argparse
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import signal
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.parse import urlsplit, urlunsplit


BACKEND = Path(__file__).resolve().parents[2]
ACCOUNT = "10000000-0000-4000-8000-000000000001"
OTHER = "10000000-0000-4000-8000-000000000002"
TIMES = {"createdAt", "updatedAt", "settledAt", "expiresAt", "asOf", "eventAt"}
DECODER = json.JSONDecoder()


def command(args, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        raise RuntimeError(Path(args[0]).name + ": " + result.stderr.decode())
    return result.stdout


def database_url(maintenance, name):
    parts = urlsplit(maintenance)
    if not parts.netloc:
        return parts.scheme + ":///" + name + ("?" + parts.query if parts.query else "")
    return urlunsplit(parts._replace(path="/" + name))


class Differential:
    def __init__(self, args, directory):
        self.args, self.directory = args, directory
        self.processes, self.containers, self.databases, self.connections = [], [], [], []
        self.minted = [{}, {}]
        self.observed_times = [{}, {}]
        self.baseline_worktree = None
        self.baseline_repository = None
        self.main_binary = None
        self.clock_file = directory / "clock-ms"
        self.sessions = [None, None]
        self.clock_clients = []
        self.count = self.writes = self.reads = self.exceptions = 0
        self.tools, self.routes, self.read_routes = set(), set(), set()
        self.caller_ids = {"routine_seed", "note_seed", "thread_seed"}
        self.now = int(time.time() * 1000) - 60000
        self.clock_ms = self.now + 120000
        self.clock_file.write_text(str(self.clock_ms))
        self.legacy_import = {"id": "session_adopted", "routineId": "routine_seed",
            "startedAt": self.now - 259200000, "finishedAt": self.now - 259190000,
            "sets": [{"id": "set_adopted_" + suffix, "exerciseId": "back-squat", "weightKg": 50.25,
                      "reps": 5, "completedAt": self.now - 259195000 + offset}
                     for suffix, offset in (("a", 0), ("b", 1000))]}
        self.legacy_correction = {"requestId": "correction_adopted", "startedAt": self.legacy_import["startedAt"],
            "finishedAt": self.legacy_import["finishedAt"], "routineName": "Corrected adopted day",
            "sets": [{**row, "setNumber": index + 1, "reps": 6}
                     for index, row in enumerate(self.legacy_import["sets"])]}

    def sql(self, database, sql):
        return command(["psql", database, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", sql]).decode().strip()

    def advance_clock(self):
        self.clock_ms += 1000
        next_clock = self.clock_file.with_suffix(".next")
        next_clock.write_text(str(self.clock_ms))
        next_clock.replace(self.clock_file)
        if not self.clock_clients:
            for side, (_, database) in enumerate(self.databases):
                with (self.directory / f"sql-clock-{side}.log").open("wb") as log:
                    client = subprocess.Popen(["psql", database, "-XAtq", "-v", "ON_ERROR_STOP=1"],
                                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
                self.clock_clients.append(client)
                self.processes.append(client)
        for client in self.clock_clients:
            client.stdin.write(f"UPDATE differential_clock SET ms={self.clock_ms};\n\\echo clock-ready\n")
            client.stdin.flush()
            assert client.stdout.readline().strip() == "clock-ready", "SQL test clock update failed"

    def binary(self, name, environment, *arguments):
        if self.args.image:
            env = [item for key, value in environment.items() for item in ("-e", key + "=" + value)]
            return command(["docker", "run", "--rm", "--network", "host", *env,
                            self.args.image, str(self.args.bin_dir / name), *arguments])
        return command([str(self.args.bin_dir / name), *arguments], env={**os.environ, **environment})

    def build_main(self):
        self.baseline_repository = self.directory / "baseline.git"
        command(["git", "-c", "safe.directory=" + str(BACKEND.parent), "clone", "--mirror", "--shared",
                 str(BACKEND.parent), str(self.baseline_repository)])
        worktree = self.directory / "origin-main"
        command(["git", "-C", str(self.baseline_repository), "worktree", "add", "--detach",
                 str(worktree), "origin/main"])
        self.baseline_worktree = worktree
        baseline = self.baseline_worktree / "backend"
        # Identical, test-only clock instrumentation; no gym/application sources are patched.
        clock = Path("platform/adapters/clock/SystemClock.h")
        (baseline / clock).write_bytes((BACKEND / clock).read_bytes())
        with (baseline / "CMakeLists.txt").open("a") as output:
            output.write("\ntarget_compile_definitions(windmill_server PRIVATE WM_TEST_CLOCK=1)\n")
        (self.directory / "origin-main-sha.txt").write_bytes(command(
            ["git", "-C", str(self.baseline_worktree), "rev-parse", "HEAD"]))
        (self.directory / "origin-main-clock.patch").write_bytes(command(
            ["git", "-C", str(self.baseline_worktree), "diff"]))
        build = self.directory / "origin-main-build"
        configure = ["cmake", "-S", str(baseline), "-B", str(build)]
        if self.args.drogon_prefix:
            configure.append("-DWM_DROGON_PREFIX=" + str(self.args.drogon_prefix))
        with (self.directory / "origin-main-build.log").open("wb") as log:
            for invocation in (configure, ["cmake", "--build", str(build), "-j" + str(self.args.jobs),
                                           "--target", "windmill_server"]):
                result = subprocess.run(invocation, stdout=log, stderr=subprocess.STDOUT)
                if result.returncode:
                    raise RuntimeError("origin/main build failed: " + str(self.directory / "origin-main-build.log"))
        self.main_binary = build / "windmill_server"

    def start(self, side, database, port):
        engine = side if self.args.mode == "off-vs-on" else 0
        environment = {"DATABASE_URL": database, "PORT": str(port), "GYM_ENGINE_WRITES": str(engine),
                       "WM_TEST_CLOCK_FILE": str(self.clock_file), "PGOPTIONS": "-c search_path=public,pg_catalog -c timezone=UTC",
                       "WINDMILL_HOST": "127.0.0.1",
                       "GYM_WRITE_FREEZE": "0", "WINDMILL_APP_URL": "http://gym.test",
                       "WINDMILL_API_URL": "http://gym.test", "ANTHROPIC_API_KEY": "",
                       "RESEND_API_KEY": "", "SENTRY_DSN": "", "AMPLITUDE_API_KEY": "",
                       "WINDMILL_MCP_TOKEN": "", "WINDMILL_COOKIE_DOMAIN": ""}
        log = self.directory / ("server-" + str(side) + ".log")
        if self.args.image:
            name = "gym-diff-" + str(os.getpid()) + "-" + str(side)
            self.containers.append(name)
            env = [item for key, value in environment.items() for item in ("-e", key + "=" + value)]
            command(["docker", "run", "-d", "--name", name, "--network", "host",
                     "-v", str(self.directory) + ":" + str(self.directory) + ":ro", *env,
                     self.args.image, str(self.args.bin_dir / "windmill_server_test_clock")])
        else:
            handle = log.open("wb")
            binary = self.main_binary if side == 0 and self.main_binary else self.args.bin_dir / "windmill_server_test_clock"
            process = subprocess.Popen([str(binary)], cwd=self.directory,
                                       env={**os.environ, **environment}, stdout=handle, stderr=handle)
            handle.close()
            self.processes.append(process)
        for attempt in range(100):
            try:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                connection.request("GET", "/v1/gym/preferences")
                response = connection.getresponse()
                response.read()
                assert response.status == 401
                self.connections.append(connection)
                return
            except (OSError, http.client.HTTPException):
                time.sleep(0.1)
        raise AssertionError("server did not start: " + str(log))

    def setup(self):
        if self.args.mode == "main-vs-off":
            self.build_main()
        ports = []
        for port in range(18900, 18950):
            with socket.socket() as probe:
                try:
                    probe.bind(("127.0.0.1", port))
                    ports.append(port)
                except OSError:
                    continue
            if len(ports) == 2:
                break
        assert len(ports) == 2, "need two free loopback ports in 18900–18949"
        stamp = str(time.time_ns())
        cookie_hash = hashlib.sha256(b"gym-differential").hexdigest()
        key_hash = hashlib.sha256(b"gym-differential-mcp").hexdigest()
        seed = f"""
          INSERT INTO users(id,email,name) VALUES ('{ACCOUNT}','gym-diff@example.com','Gym'),
            ('{OTHER}','gym-other@example.com','Other');
          INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('{cookie_hash}','{ACCOUNT}',99999999999999);
          INSERT INTO mcp_keys(token_hash,user_id,name,created_ms,scope,id) VALUES
            ('{key_hash}','{ACCOUNT}','Differential',1,'gym:read gym:write gym:delete','20000000-0000-4000-8000-000000000001');
          INSERT INTO gym_routines(id,user_id,name,position,created_at) VALUES
            ('routine_seed','{ACCOUNT}','Adopted',0,'2026-01-01');
          INSERT INTO gym_routine_entries(routine_id,position,exercise_id) VALUES ('routine_seed',1,'back-squat');
          INSERT INTO gym_notes(id,user_id,position,title,body,created_at,updated_at) VALUES
            ('note_seed','{ACCOUNT}',0,'Goal','Train steadily','2026-01-01','2026-01-01');
          INSERT INTO gym_ask_threads(id,user_id,title,created_at,asked_at) VALUES
            ('thread_seed','{ACCOUNT}','Question','2026-01-01','2026-01-01');
          INSERT INTO gym_ask_generations(id,thread_id,user_id,request_id,payload,created_at) VALUES
            ('generation_seed','thread_seed','{ACCOUNT}','request_seed',
             '{{"id":"generation_seed","requestId":"request_seed","question":"Question","status":"running","answer":"","steps":[],"results":[],"revision":0,"at":1767225600000}}',
             '2026-01-01');
        """
        for side in range(2):
            name = "wm_gym_diff_" + stamp + "_" + str(side)
            command(["createdb", "--maintenance-db=" + self.args.maintenance_db, name])
            database = database_url(self.args.maintenance_db, name)
            self.databases.append((name, database))
            self.sql(database, f"CREATE TABLE differential_clock(ms bigint NOT NULL); INSERT INTO differential_clock VALUES ({self.clock_ms}); "
                     "CREATE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE AS "
                     "'SELECT to_timestamp(ms / 1000.0) FROM public.differential_clock';")
            command(["psql", database, "-Xq", "-v", "ON_ERROR_STOP=1", "-f", str(BACKEND / "db/schema.sql")],
                    env={**os.environ, "PGOPTIONS": "-c search_path=public,pg_catalog -c timezone=UTC"})
            self.sql(database, seed)
            if side:
                imported = command(["pg_dump", self.databases[0][1], "--data-only", "--no-owner", "--no-privileges",
                    *["--table=" + table for table in ("gym_sessions", "gym_sets", "gym_write_receipts",
                                                       "gym_correction_receipts", "gym_set_revisions")]])
                command(["psql", database, "-Xq", "-v", "ON_ERROR_STOP=1"], input=imported)
                if self.args.mode == "off-vs-on":
                    command(["psql", database, "-Xq", "-v", "ON_ERROR_STOP=1", "-f", str(BACKEND / "db/gym_sync.sql")])
                    report = self.binary("windmill_gym_backfill", {"DATABASE_URL": database}).decode()
                    (self.directory / "backfill.jsonl").write_text(report)
                    self.binary("windmill_gym_backfill", {"DATABASE_URL": database}, "--audit")
                    assert sum(json.loads(line)["changed"] for line in report.splitlines()) > 0
            self.start(side, database, ports[side])
            if not side:
                for target, body, status in (("/sessions/import", self.legacy_import, 201),
                    ("/sessions/session_adopted/corrections", self.legacy_correction, 200)):
                    response = self.request(0, "POST", "/v1/gym" + target, body)
                    assert response[0] == status, response
                response = self.request(0, "DELETE", "/v1/gym/sessions/session_adopted/sets/set_adopted_b", None)
                assert response[0] == 204, response
        self.pair("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                  "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                             "clientInfo": {"name": "gym-differential", "version": "1"}}}, rpc=True)
        listed = self.pair("POST", "/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, rpc=True)[0]
        self.declared_tools = {row["name"] for row in listed["result"]["tools"]}

    def request(self, side, method, target, body, rpc=False, headers=None):
        def caller_ids(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key in {"id", "sessionId", "routineId", "requestId", "exerciseId"} and isinstance(item, str):
                        self.caller_ids.add(item)
                    caller_ids(item)
            elif isinstance(value, list):
                for item in value: caller_ids(item)
        caller_ids(body)
        for original, label in self.minted[side].items():
            target = target.replace(label, original)
        payload = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        if payload and not isinstance(body, bytes):
            for original, label in self.minted[side].items():
                payload = payload.replace(label.encode(), original.encode())
        fields = {"Content-Type": "application/json", "Cookie": "wm_session=gym-differential",
                  "X-Request-Id": "gym-diff-" + str(self.count)}
        if rpc:
            fields["Authorization"] = "Bearer gym-differential-mcp"
            if self.sessions[side]: fields["Mcp-Session-Id"] = self.sessions[side]
        fields.update(headers or {})
        self.connections[side].request(method, target, payload, fields)
        response = self.connections[side].getresponse()
        data = response.read()
        fields = {key.lower(): value for key, value in response.getheaders()}
        if "mcp-session-id" in fields: self.sessions[side] = fields["mcp-session-id"]
        return response.status, fields, data

    def normalise(self, text, side, identity="response"):
        def walk(at, key="", owner=identity):
            start = at
            while text[at].isspace(): at += 1
            value, end = DECODER.raw_decode(text, at)
            prefix = text[start:at]
            if isinstance(value, dict):
                owner = str(value.get("id", value.get("sessionId", value.get("dateLocal", owner))))
                if value.get("kind") in ("created", "proposal") and "at" in value:
                    owner += "/history/" + str(value.get("proposal", {}).get("id", value["kind"]))
                owner = self.minted[side].get(owner, owner)
                result, cursor = prefix + "{", at + 1
                while True:
                    stop = cursor
                    while text[stop].isspace(): stop += 1
                    result += text[cursor:stop]
                    if text[stop] == "}": return result + "}", stop + 1
                    field, after = DECODER.raw_decode(text, stop)
                    colon = text.index(":", after)
                    result += text[stop:colon + 1]
                    timestamp_field = "eventAt" if field == "at" and value.get("kind") in ("created", "proposal") else field
                    rendered, cursor = walk(colon + 1, timestamp_field, owner)
                    result += rendered
                    stop = cursor
                    while text[stop].isspace(): stop += 1
                    result += text[cursor:stop]
                    if text[stop] == "}": return result + "}", stop + 1
                    assert text[stop] == ","
                    result += ","
                    cursor = stop + 1
            if isinstance(value, list):
                result, cursor = prefix + "[", at + 1
                while True:
                    stop = cursor
                    while text[stop].isspace(): stop += 1
                    if text[stop] == "]": return result + text[cursor:stop] + "]", stop + 1
                    rendered, cursor = walk(cursor, key, owner)
                    result += rendered
                    stop = cursor
                    while text[stop].isspace(): stop += 1
                    result += text[cursor:stop]
                    if text[stop] == "]": return result + "]", stop + 1
                    assert text[stop] == ","
                    result += ","
                    cursor = stop + 1
            if key in TIMES and isinstance(value, int):
                if key != "asOf":
                    previous = self.observed_times[side].get((owner, key), value)
                    assert value >= previous, ("timestamp moved backwards", owner, key, previous, value)
                    self.observed_times[side][owner, key] = value
                return text[start:end], end
            if isinstance(value, str):
                changed = value
                if key == "text" and value.startswith(("{", "[")):
                    changed = self.normalise(value, side, owner)
                for original, label in self.minted[side].items(): changed = changed.replace(original, label)
                if changed != value: return prefix + json.dumps(changed, ensure_ascii=False), end
            return text[start:end], end
        rendered, end = walk(0)
        return rendered + text[end:]

    def discover(self, left, right):
        if isinstance(left, dict) and isinstance(right, dict):
            for key in left.keys() & right.keys():
                a, b = left[key], right[key]
                if key in TIMES and isinstance(a, int) and isinstance(b, int):
                    assert a == b, ("timestamp differs", key, a, b)
                if key == "at" and left.get("kind") in ("created", "proposal"):
                    assert isinstance(a, int) and isinstance(b, int) and a == b, (key, a, b)
                if key in {"id", "token"} and isinstance(a, str) and isinstance(b, str) and a != b:
                    assert key == "token" or (a.startswith("note_") and b.startswith("note_") and
                        a not in self.caller_ids and b not in self.caller_ids), ("unexpected differing id", a, b)
                    assert len(a) == len(b), ("generated identity length differs", a, b)
                    if a not in self.minted[0]:
                        assert b not in self.minted[1], ("generated identity lost its pairing", a, b)
                        label = "@mint" + str(len(self.minted[0]))
                        self.minted[0][a], self.minted[1][b] = label, label
                    assert self.minted[0][a] == self.minted[1][b]
                if key == "text" and isinstance(a, str) and a.startswith(("{", "[")) and isinstance(b, str) and b.startswith(("{", "[")):
                    self.discover(json.loads(a), json.loads(b))
                else: self.discover(a, b)
        elif isinstance(left, list) and isinstance(right, list):
            for a, b in zip(left, right): self.discover(a, b)

    def pair(self, method, target, body=None, rpc=False, expected=None, headers=None, difference=None):
        self.advance_clock()
        responses = [self.request(side, method, target, body, rpc, headers) for side in range(2)]
        self.count += 1
        data = [json.loads(row[2]) if row[2].startswith((b"{", b"[")) else None for row in responses]
        label = f"{self.count}: {method} {target}" + (" " + body.get("params", {}).get("name", "") if rpc else "")
        if expected is not None:
            for side, row in enumerate(responses):
                status = expected[side] if isinstance(expected, tuple) else expected
                assert row[0] == status, (label, side, row)
        if difference:
            difference(data)
            self.exceptions += 1
        else:
            assert responses[0][0] == responses[1][0], (label, responses)
            for side in range(2):
                session = responses[side][1].get("mcp-session-id")
                if session: self.minted[side][session] = "@mcp-session"
            try:
                self.discover(*data)
                rendered = [self.normalise(row[2].decode(), side) if data[side] is not None else row[2]
                            for side, row in enumerate(responses)]
            except (AssertionError, ValueError) as error:
                for side in range(2): (self.directory / f"failure-{side}.txt").write_bytes(responses[side][2])
                raise AssertionError(label + ": " + str(error) + "; see " + str(self.directory)) from error
            if rendered[0] != rendered[1]:
                for side in range(2): (self.directory / f"failure-{side}.txt").write_text(str(rendered[side]))
                raise AssertionError(label + ": body differs; see " + str(self.directory))
        for status, fields, body_bytes in responses:
            if "content-length" in fields and status != 304:
                assert int(fields["content-length"]) == len(body_bytes), (label, "invalid Content-Length")
        ignored = {"date", "connection", "keep-alive"}
        fields = [{key: value for key, value in row[1].items() if key not in ignored} for row in responses]
        for side in range(2):
            for original, alias in self.minted[side].items():
                fields[side] = {key: value.replace(original, alias) for key, value in fields[side].items()}
        if difference and responses[0][0] != responses[1][0]:
            assert fields[0].pop("content-type", "").startswith("text/html" if responses[0][0] == 204 else "application/json")
            assert fields[1].pop("content-type", "").startswith("application/json")
        if difference:
            fields[0].pop("content-length", None)
            fields[1].pop("content-length", None)
        assert fields[0] == fields[1], (label, "headers", fields)
        if "etag" in fields[0]: self.etag = fields[0]["etag"]
        if method == "GET":
            self.reads += 1
            self.read_routes.add(target.split("?", 1)[0])
        elif rpc and body.get("method") == "tools/call":
            self.tools.add(body["params"]["name"])
        elif target.startswith("/v1/gym/"):
            self.routes.add((method, target))
        return data

    def tool(self, name, arguments, retry=True, error=False, retry_error=None):
        name = "gym_" + name
        body = {"jsonrpc": "2.0", "id": "request_" + str(self.count), "method": "tools/call",
                "params": {"name": name, "arguments": arguments}}
        headers = {"X-Request-Id": body["id"]}
        result = self.pair("POST", "/mcp", body, rpc=True, expected=200, headers=headers)
        for row in result:
            assert bool(row["result"].get("isError", False)) == error, (name, row)
        if retry:
            replay = self.pair("POST", "/mcp", body, rpc=True, expected=200, headers=headers)
            for row in replay:
                assert bool(row["result"].get("isError", False)) == (error if retry_error is None else retry_error), (name, row)
        if name not in {"gym_list_exercises", "gym_list_sessions", "gym_list_routines", "gym_get_stats", "gym_list_notes",
                        "gym_list_bodyweight", "gym_get_session", "gym_get_sessions", "gym_last_time", "gym_get_last_times"}:
            self.readback()
        return result

    def write(self, method, target, body=None, expected=200, headers=None):
        self.writes += 1
        headers = {"X-Request-Id": "write_" + str(self.writes), **(headers or {})}
        result = self.pair(method, "/v1/gym" + target, body, expected=expected, headers=headers)
        self.pair(method, "/v1/gym" + target, body, headers=headers)
        self.readback()
        return result

    def readback(self):
        for target in ("routines", "exercises", "sessions", "notes", "bodyweight", "preferences", "proposals", "stats", "history?projection=progress", "threads", "log-shares"):
            rows = self.pair("GET", "/v1/gym/" + target, expected=200)[0]
            if target in {"routines", "proposals", "threads", "sessions"}:
                for row in rows[target]:
                    id = row["id"]
                    self.pair("GET", "/v1/gym/" + target + "/" + id, expected=200)
                    if target == "sessions":
                        self.pair("GET", "/v1/gym/sessions/" + id + "/review")
        for target in ("exercises/last", "exercises/back-squat/record", "last?exercise=back-squat"):
            self.pair("GET", "/v1/gym/" + target)

    def sequence(self):
        self.readback()
        self.write("POST", "/sessions/import", self.legacy_import)
        self.write("POST", "/sessions/session_adopted/corrections", self.legacy_correction)
        self.tool("import_session", self.legacy_import)
        for tool, args in [("list_exercises", {}), ("list_sessions", {}), ("list_routines", {}),
                           ("get_stats", {}), ("list_notes", {}), ("list_bodyweight", {})]:
            self.tool(tool, args, retry=False)
        exercise = {"id": "exercise_diff", "name": "Custom squat", "pattern": "squat", "equipment": "barbell"}
        self.write("POST", "/exercises", exercise)
        self.tool("create_exercise", {**exercise, "id": "exercise_tool", "name": "Tool squat"})
        for id in ("exercise_diff", "back-squat"):
            for name in ("First name", "Second name", "Third name", "Back Squat" if id == "back-squat" else "Custom squat"):
                self.write("PATCH", "/exercises/" + id, {"name": name})
        entries = [{"exerciseId": "back-squat", "sets": [{"reps": 5, "weightKg": 60}, {"reps": 3, "weightKg": 80}], "restSeconds": 90},
                   {"exerciseId": "exercise_diff"}]
        routine = {"id": "routine_diff", "name": "Day A", "position": 1, "entries": entries}
        self.write("POST", "/routines", routine)
        self.tool("create_routine", {**routine, "id": "routine_tool", "name": "Day B", "position": 2})
        self.write("PUT", "/routines/routine_diff", {**routine, "position": 4})
        self.write("PUT", "/routines/routine_diff", {**routine, "name": "Day A edited", "entries": entries[::-1]})
        self.write("PUT", "/routines/routine_diff", {**routine, "revision": 1}, expected=409)
        for id in ("note_diff_a", "note_diff_b"):
            self.write("PUT", "/notes/" + id, {"title": id, "body": "User context π"})
        self.write("PUT", "/notes/note_diff_a", {"title": "Edited", "body": "Edited context"})
        self.tool("save_note", {"id": "notesave_diff", "title": "Tool insight", "body": "User said this"})
        notes = self.pair("GET", "/v1/gym/notes")[0]["notes"]
        order = [self.minted[0].get(row["id"], row["id"]) for row in notes][::-1]
        self.write("PUT", "/notes", {"order": order})
        self.write("PUT", "/notes", {"order": []}, expected=400)
        self.write("DELETE", "/notes/note_diff_b", expected=204)
        self.write("PUT", "/preferences", {"units": "lb", "restSeconds": 120, "restSound": True, "confirmHaptic": False, "confirmSound": True})
        self.write("PUT", "/preferences", {})
        self.write("PUT", "/preferences", {"units": "stone"}, expected=400)
        day = time.strftime("%Y-%m-%d", time.gmtime(self.now / 1000 - 86400))
        for value in [{"weightKg": 80.25, "recordedAt": self.now}, {"weightKg": 81.5, "recordedAt": self.now + 1},
                      {"weightKg": 79, "recordedAt": self.now - 1}]:
            self.write("PUT", "/bodyweight/" + day, value)
        self.write("DELETE", "/bodyweight/" + day, expected=204)
        self.write("PUT", "/bodyweight/" + day, {"weightKg": 82, "recordedAt": self.now + 2})
        session = {"id": "session_diff", "startedAt": self.now, "routineId": "routine_diff", "joinOpenSession": False}
        self.write("POST", "/sessions", session)
        self.tool("start_session", {"id": "session_join", "startedAt": self.now, "routineId": "routine_tool"})
        self.write("POST", "/sessions", {"id": "session_refuse", "startedAt": self.now, "joinOpenSession": False}, expected=409)
        def set_row(id, offset=1000):
            return {"id": id, "exerciseId": "back-squat", "weightKg": 60.25, "reps": 5, "completedAt": self.now + offset, "note": "Set π", "rpe": 7.5}
        self.write("POST", "/sessions/session_diff/sets", set_row("set_rest"))
        self.tool("log_set", {"sessionId": "session_diff", **set_row("set_tool", 2000)})
        self.tool("log_sets", {"sessionId": "session_diff", "sets": [set_row("set_batch_a", 3000), {**set_row("set_batch_b", 4000), "kind": "warmup"}]})
        self.write("PATCH", "/sessions/session_diff/sets/set_rest", {"weightKg": 65, "reps": 6, "rpe": None, "note": "Corrected"})
        self.write("DELETE", "/sessions/session_diff/sets/set_batch_b", expected=204)
        self.write("POST", "/sessions/session_diff/finish", {"finishedAt": self.now + 10000})
        self.tool("finish_session", {"sessionId": "session_diff", "finishedAt": self.now + 11000})
        self.write("POST", "/sessions/session_diff/sets", set_row("set_finished_new", 6000), expected=409)
        self.write("POST", "/sessions/session_diff/sets", set_row("set_rest"))
        self.write("PATCH", "/sessions/session_diff/sets/set_rest", {"weightKg": 67.5, "reps": 7, "note": "Finished correction"})
        self.write("DELETE", "/sessions/session_diff/sets/set_tool", expected=204)
        self.write("POST", "/sessions/session_diff/sets", set_row("set_tool"), expected=409)
        self.tool("log_sets", {"sessionId": "session_diff", "sets": [set_row("set_batch_a", 3000), {**set_row("set_batch_b", 4000), "kind": "warmup"}]})
        for tool, args in [("get_session", {"sessionId": "session_diff", "review": True}),
                           ("get_sessions", {"sessionIds": ["session_diff", "session_missing"], "review": True}),
                           ("last_time", {"exerciseId": "back-squat"}), ("get_last_times", {"exerciseIds": ["back-squat", "exercise_missing"]})]:
            self.tool(tool, args, retry=False)
        self.pair("GET", "/v1/gym/sessions/session_diff", expected=200)
        self.pair("GET", "/v1/gym/sessions/session_diff", expected=304,
                  headers={"If-None-Match": self.etag})
        old_tag = self.etag
        self.write("PATCH", "/sessions/session_diff/sets/set_rest", {"reps": 9})
        self.pair("GET", "/v1/gym/sessions/session_diff", expected=200,
                  headers={"If-None-Match": old_tag})
        assert self.etag != old_tag
        self.write("POST", "/sessions/session_diff/share")
        self.tool("share_session", {"sessionId": "session_diff"})
        shares = self.pair("POST", "/v1/gym/sessions/session_diff/share")[0]
        token = self.minted[0].get(shares["token"], shares["token"])
        self.pair("GET", "/v1/gym/shared/" + token, expected=200)
        self.tool("revoke_share", {"sessionId": "session_diff"}, retry_error=True)
        self.write("POST", "/sessions/session_diff/share")
        self.write("DELETE", "/sessions/session_diff/share", expected=204)
        for mode in ("snapshot", "live"):
            shared = self.write("POST", "/log-shares", {"id": "logshare_" + mode, "mode": mode, "scope": "all"}, expected=201)[0]
            self.pair("GET", "/v1/gym/shared-logs/" + self.minted[0].get(shared["token"], shared["token"]), expected=200)
            self.write("DELETE", "/log-shares/" + shared["id"], expected=204)
        imported = {"id": "session_import", "startedAt": self.now - 86400000, "finishedAt": self.now - 86390000,
                    "routineId": "routine_diff", "sets": [{**set_row("set_import"), "completedAt": self.now - 86395000}]}
        self.write("POST", "/sessions/import", imported, expected=201)
        self.tool("import_session", {**imported, "id": "session_toolimp", "startedAt": self.now - 172800000,
                  "finishedAt": self.now - 172790000, "sets": [{**set_row("set_toolimp"), "completedAt": self.now - 172795000}]})
        correction = {"requestId": "correction_diff", "startedAt": imported["startedAt"], "finishedAt": imported["finishedAt"],
                      "routineName": "Corrected past day", "sets": [{**imported["sets"][0], "setNumber": 1, "reps": 8},
                      {**set_row("set_correct_new"), "completedAt": self.now - 86394000, "setNumber": 2}]}
        self.write("POST", "/sessions/session_import/corrections", correction)
        self.write("POST", "/sessions/session_import/corrections", {**correction, "routineName": "Conflict"}, expected=409)
        for index, padded in enumerate(("  Trimmed day  ", " " * 241 + "Trimmed day" + " " * 241)):
            normalised = {**correction, "requestId": "correction_padded_" + str(index), "routineName": padded,
                          "sets": [{**row, "weightKg": 60.25000000001, "rpe": 7.50000000001}
                                   for row in correction["sets"]]}
            corrected = self.write("POST", "/sessions/session_import/corrections", normalised)
            for row in corrected:
                assert row["session"]["routineName"] == "Trimmed day", row
        self.write("POST", "/sessions/import", imported)
        self.tool("discard_session", {"sessionId": "session_toolimp"}, retry_error=True)
        self.write("DELETE", "/sessions/session_import", expected=204)
        self.write("POST", "/sessions/import", imported, expected=409)
        self.tool("propose_routine_change", {"id": "proposal_old", "routineId": "routine_diff", "entries": entries, "summary": "Restore order"})
        self.tool("propose_routine_change", {"id": "proposal_new", "routineId": "routine_diff", "entries": entries, "name": "Proposed day", "summary": "New name"})
        for decision in ("apply", "dismiss"):
            self.write("POST", "/proposals/proposal_old/" + decision, expected=409)
        self.write("POST", "/proposals/proposal_new/apply")
        self.write("POST", "/proposals/proposal_new/dismiss", expected=409)
        self.tool("propose_routine_removal", {"id": "proposal_dismiss", "routineId": "routine_tool", "summary": "Remove day"})
        self.write("POST", "/proposals/proposal_dismiss/dismiss")
        self.write("POST", "/proposals/proposal_dismiss/apply", expected=409)
        self.tool("propose_routine_change", {"id": "proposal_moved", "routineId": "routine_tool", "entries": entries[::-1]})
        self.write("PUT", "/routines/routine_tool", {**routine, "id": "routine_tool", "name": "Moved day"})
        self.write("POST", "/proposals/proposal_moved/apply", expected=409)
        self.tool("propose_routine_removal", {"id": "proposal_remove", "routineId": "routine_tool"})
        self.write("POST", "/proposals/proposal_remove/apply")
        self.write("DELETE", "/routines/routine_diff", expected=204)
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
        self.write("PUT", "/threads/thread_seed/attachments/image_diff", png, headers={"Content-Type": "image/png"})
        self.pair("GET", "/v1/gym/threads/thread_seed/attachments/image_diff", expected=200)
        self.write("POST", "/threads/thread_seed/generations/request_missing/stop", expected=404)
        stopped = self.write("POST", "/threads/thread_seed/generations/request_seed/stop")
        for row in stopped:
            assert row["generation"]["status"] == "stopped" and row["generation"]["stopRequested"]
        self.write("POST", "/ask", {"threadId": "thread_seed", "requestId": "request_unconfigured", "question": "Hello"}, expected=404)
        self.write("DELETE", "/threads/thread_seed", expected=204)
        self.write("POST", "/ask", {"threadId": "thread_missing", "requestId": "request_missing", "question": "Hello"}, expected=404)
        assert self.tools == self.declared_tools, ("tool coverage", self.declared_tools - self.tools)
        routes = re.findall(r'app\.registerHandler\(\s*"([^"]+)"(?:(?!app\.registerHandler).)*?\{drogon::(Post|Put|Patch|Delete)\}\)', (BACKEND / "products/gym/routes.cpp").read_text(), re.S)
        missing = [(method, route) for route, method in routes if not any(verb == method.upper() and re.fullmatch(re.sub(r'\{[^}]+\}', '[^/]+', route), target) for verb, target in self.routes)]
        assert not missing, ("write route coverage", missing)
        read_routes = re.findall(r'app\.registerHandler\(\s*"([^"]+)"(?:(?!app\.registerHandler).)*?\{drogon::Get\}\)', (BACKEND / "products/gym/routes.cpp").read_text(), re.S)
        missing_reads = [route for route in read_routes if not any(re.fullmatch(re.sub(r'\{[^}]+\}', '[^/]+', route), target) for target in self.read_routes)]
        assert not missing_reads, ("read route coverage", missing_reads)
        self.intended_differences(routine)
        if self.args.mode == "off-vs-on":
            self.binary("windmill_gym_backfill", {"DATABASE_URL": self.databases[1][1]}, "--audit-current")
        return {"passed": True, "mode": self.args.mode, "pairedRequests": self.count, "restWriteScenarios": self.writes,
                "restReads": self.reads, "mcpTools": len(self.tools), "writeRoutes": len(routes), "readRoutes": len(read_routes),
                "intendedDifferenceChecks": self.exceptions, "D3": "requires a replica; no replica exists in this test"}

    def intended_differences(self, routine):
        if self.args.mode == "main-vs-off":
            for retry in range(2):
                self.pair("POST", "/v1/gym/routines", routine, expected=200,
                          headers={"X-Request-Id": "d1_routine"})
            self.pair("DELETE", "/v1/gym/routines/routine_diff", expected=204)
            for retry in range(2):
                self.pair("PUT", "/v1/gym/notes/note_diff_b", {"title": "New", "body": "New"}, expected=200,
                          headers={"X-Request-Id": "d1_note"})
            self.pair("DELETE", "/v1/gym/notes/note_diff_b", expected=204)
            self.readback()
            self.write("POST", "/sessions", {"id": "session_d2_a", "startedAt": self.now + 20000})
            joined = {"id": "session_d2_join", "startedAt": self.now + 20000}
            self.write("POST", "/sessions", joined)
            self.write("POST", "/sessions/session_d2_a/finish", {"finishedAt": self.now + 21000})
            current = self.write("POST", "/sessions", {"id": "session_d2_b", "startedAt": self.now + 22000})
            for retry in range(2):
                result = self.pair("POST", "/v1/gym/sessions", joined, expected=200,
                                   headers={"X-Request-Id": "d2_start"})
                assert result == current, result
            self.readback()
            return
        def spent(rows):
            assert rows[0]["id"] == routine["id"] and rows[1] == {"code": "routine-id-taken", "error": "that routine id is taken"}, rows
        for retry in range(2):
            self.pair("POST", "/v1/gym/routines", routine, expected=(200, 409), difference=spent,
                      headers={"X-Request-Id": "d1_routine"})
        def cleanup_routine(rows):
            assert rows == [None, {"error": "no such routine"}], rows
        self.pair("DELETE", "/v1/gym/routines/routine_diff", expected=(204, 404), difference=cleanup_routine)
        def note_spent(rows):
            assert rows[0]["note"]["id"] == "note_diff_b" and rows[1] == {"code": "note-id-taken", "error": "that note id is already in use"}, rows
        for retry in range(2):
            self.pair("PUT", "/v1/gym/notes/note_diff_b", {"title": "New", "body": "New"}, expected=(200, 409), difference=note_spent,
                      headers={"X-Request-Id": "d1_note"})
        self.pair("DELETE", "/v1/gym/notes/note_diff_b", expected=204)
        self.readback()
        self.write("POST", "/sessions", {"id": "session_d2_a", "startedAt": self.now + 20000})
        joined = {"id": "session_d2_join", "startedAt": self.now + 20000}
        self.write("POST", "/sessions", joined)
        original = self.write("POST", "/sessions/session_d2_a/finish", {"finishedAt": self.now + 21000})
        current = self.write("POST", "/sessions", {"id": "session_d2_b", "startedAt": self.now + 22000})
        def replay(rows):
            assert rows == [current[0], original[1]], rows
        for retry in range(2):
            self.pair("POST", "/v1/gym/sessions", joined, expected=200, difference=replay,
                      headers={"X-Request-Id": "d2_start"})
        self.readback()

    def cleanup(self):
        failures = []
        for connection in self.connections: connection.close()
        for process in self.processes:
            process.terminate()
            try: process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for name in self.containers:
            log = subprocess.run(["docker", "logs", name], stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout
            (self.directory / (name + ".log")).write_bytes(log)
            try: command(["docker", "rm", "-f", name])
            except RuntimeError as error: failures.append(str(error))
        for name, database in reversed(self.databases):
            try: command(["dropdb", "--force", "--maintenance-db=" + self.args.maintenance_db, name])
            except RuntimeError as error: failures.append(str(error))
        if self.baseline_worktree:
            try: command(["git", "-C", str(self.baseline_repository), "worktree", "remove", "--force", str(self.baseline_worktree)])
            except RuntimeError as error: failures.append(str(error))
        if self.baseline_repository and self.baseline_repository.exists() and not failures:
            shutil.rmtree(self.baseline_repository)
        if failures: raise RuntimeError("cleanup failed: " + "; ".join(failures))


def main():
    parser = argparse.ArgumentParser(description="Real gym REST/MCP legacy vs admitted write differential; owns and drops its databases and servers")
    parser.add_argument("--bin-dir", type=Path, default=BACKEND / "build")
    parser.add_argument("--image", help="CI builder image; start both servers and backfill with docker --network host")
    parser.add_argument("--mode", choices=("main-vs-off", "off-vs-on"), default="off-vs-on")
    parser.add_argument("--drogon-prefix", type=Path, help="reuse the pinned Drogon for the origin/main build")
    parser.add_argument("--jobs", type=int, default=8)
    parser.add_argument("--maintenance-db", default=os.environ.get("DATABASE_URL", "postgresql:///postgres?host=/tmp"))
    args = parser.parse_args()
    if args.image and args.mode == "main-vs-off": parser.error("main-vs-off requires local builds, not --image")
    if not args.image: args.bin_dir = args.bin_dir.resolve()
    directory = Path(tempfile.mkdtemp(prefix="gym-write-differential-"))
    differential = Differential(args, directory)
    def stop(signum, frame):
        raise KeyboardInterrupt("termination requested")
    signal.signal(signal.SIGTERM, stop)
    try:
        differential.setup()
        report = differential.sequence()
        (directory / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    finally:
        differential.cleanup()
    print(json.dumps({**report, "evidence": str(directory)}, sort_keys=True))


if __name__ == "__main__":
    main()
