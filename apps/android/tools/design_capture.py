#!/usr/bin/env python3
import argparse
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import secrets
import signal
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[3]
PACKAGE = "works.windmill.app"
MODEL_FALLBACK = [{"type": "text", "text": "Your three training days are ready. Start with Push A, and keep the logged loads comfortable."}]
SCENARIOS = [
    {"board": "02.7", "name": "empty-routines", "account": "empty", "steps": [{"tap": "Routines"}, {"wait": "No routines yet."}]},
    {"board": "02.1", "name": "routines", "account": "fixture", "steps": [{"tap": "Routines"}, {"wait": "Push A"}]},
    {"board": "05.1", "name": "log", "account": "fixture", "steps": [{"tap": "The log"}, {"wait": "Back Squat · new best"}]},
    {"board": "08.1", "name": "coach", "account": "fixture", "steps": [{"tap": "Coach"}, {"wait": "Question"}]},
    {"board": "08.1", "name": "coach-answer", "account": "fixture", "responses": [
        [{"type": "text", "text": "Your three training days are ready."}]],
     "steps": [{"tap": "Question"}, {"text": "Summarize my training days"}, {"tap": "Send"},
               {"wait": "Your three training days are ready."}, {"wait": "Send"}]},
]


def local_origin(value, emulator=False):
    parsed = urllib.parse.urlsplit(value)
    hosts = {"127.0.0.1", "localhost", "10.0.2.2"} if emulator else {"127.0.0.1", "localhost"}
    if parsed.scheme != "http" or parsed.hostname not in hosts or parsed.username or parsed.password or \
            parsed.path not in ("", "/") or parsed.query or parsed.fragment or not parsed.port or parsed.port < 1024:
        raise ValueError("Capture requires an explicit local HTTP origin and an unprivileged port.")
    return value.rstrip("/")


def checked_build_config(android, expected):
    local_origin(expected, emulator=True)
    files = list((android / "app/build/generated/source/buildConfig/debug").rglob("BuildConfig.java"))
    if len(files) != 1:
        raise RuntimeError("The debug BuildConfig was not generated exactly once.")
    match = re.search(r'WM_API_BASE_URL\s*=\s*("[^"\n]*")\s*;', files[0].read_text())
    if not match or json.loads(match[1]) != expected:
        raise RuntimeError("Generated debug API origin differs from the requested local stack; refusing install.")


def model_timing(scenario):
    timing = scenario.get("model_timing", {})
    if not isinstance(timing, dict) or set(timing) - {"start_delay_ms", "chunk_chars", "chunk_delay_ms"}:
        raise ValueError("Model timing supports only start_delay_ms, chunk_chars and chunk_delay_ms.")
    for key, low, high in (("start_delay_ms", 0, 10000), ("chunk_chars", 1, 4096), ("chunk_delay_ms", 0, 1000)):
        if key in timing and (type(timing[key]) is not int or not low <= timing[key] <= high):
            raise ValueError("Model timing needs bounded integer delays and chunk sizes.")
    start, chars, delay = timing.get("start_delay_ms", 0), timing.get("chunk_chars"), timing.get("chunk_delay_ms", 0)
    if timing:
        responses = scenario.get("responses") or [MODEL_FALLBACK]
        counts = [sum(max(1, (len(block["text"]) + chars - 1) // chars) if chars else 1
                      for block in content if block["type"] == "text") for content in responses]
        if sum(counts) > 256 or len(responses) * start + sum(max(0, count - 1) * delay for count in counts) > 10000:
            raise ValueError("Model timing permits at most 256 text chunks and 10000 ms across a scenario.")
    return start, chars, delay


def validate_scenarios(scenarios):
    for scenario in scenarios:
        model_timing(scenario)
        if "launcher" in scenario and (type(scenario["launcher"]) is not bool or scenario["launcher"] and scenario["account"] != "empty"):
            raise ValueError("Launcher capture needs an empty account and a boolean choice.")
        if not re.fullmatch(r"(?:[0-9]+(?:\.[0-9]+|[a-z])|[A-Z][0-9]+)", scenario["board"]) or \
                not re.fullmatch(r"[a-z0-9-]+", scenario["name"]) or scenario["account"] not in ("empty", "fixture"):
            raise ValueError("Recipes need a canonical board ID, a lowercase filename slug, and an empty or fixture account.")
        if "frame_delay_ms" in scenario and (type(scenario["frame_delay_ms"]) is not int or
                not 0 <= scenario["frame_delay_ms"] <= 1000 or scenario.get("settle", True) is not False):
            raise ValueError("Transient frame delays need settle:false and an integer from 0 to 1000 ms.")

    empty = [scenario for scenario in scenarios if scenario["account"] == "empty"]
    if any(scenario.get("launcher", False) for scenario in empty) and len(empty) != 1:
        raise ValueError("Launcher capture must be the only empty-account scenario in its batch.")


def read_fixture(path, capture_only=False):
    if path is None:
        if capture_only:
            raise ValueError("Capture-only needs the explicit empty-training fixture.")
        return None
    fixture = json.loads(path.read_text())
    empty_training = capture_only and fixture == {"exercises": [], "routines": [], "history": []}
    if capture_only and not empty_training:
        raise ValueError("Capture-only accepts only the explicit empty-training fixture.")
    if not isinstance(fixture, dict) or not {"exercises", "routines"}.issubset(fixture) or set(fixture) - {"exercises", "routines", "history", "connections"} or \
            not isinstance(fixture["exercises"], list) or not isinstance(fixture["routines"], list) or not fixture["routines"] and not empty_training:
        raise ValueError("Capture fixtures need exercises and nonempty routines arrays.")
    if "connections" in fixture and type(fixture["connections"]) is not bool:
        raise ValueError("Capture connections choice needs a boolean.")
    for exercise in fixture["exercises"]:
        if not isinstance(exercise, dict) or not {"id", "name", "pattern", "equipment"}.issubset(exercise):
            raise ValueError("Capture exercises need explicit identity, name, pattern and equipment.")
    for routine in fixture["routines"]:
        if not isinstance(routine, dict) or set(routine) != {"name", "entries"} or \
                not isinstance(routine["name"], str) or not routine["name"].strip() or \
                not isinstance(routine["entries"], list) or not routine["entries"] or \
                any(not isinstance(entry, dict) or not isinstance(entry.get("exerciseId"), str) for entry in routine["entries"]):
            raise ValueError("Capture routines need a name and explicit movement entries.")
    if "history" in fixture:
        history = fixture["history"]
        if not isinstance(history, list) or not empty_training and not 1 <= len(history) <= 40:
            raise ValueError("Capture history needs between 1 and 40 workouts.")
        for workout in history:
            if not isinstance(workout, dict) or not {"routine", "daysAgo", "minutesAgo", "weightKg", "reps"}.issubset(workout) or \
                    set(workout) - {"routine", "daysAgo", "minutesAgo", "weightKg", "reps", "setsPerMovement"}:
                raise ValueError("Capture history needs explicit routine, daysAgo, minutesAgo, weightKg and reps.")
            if type(workout["routine"]) is not int or not 0 <= workout["routine"] < len(fixture["routines"]) or \
                    type(workout["daysAgo"]) is not int or not 0 <= workout["daysAgo"] <= 3650 or \
                    type(workout["minutesAgo"]) is not int or not 0 <= workout["minutesAgo"] < 1440 or \
                    workout["daysAgo"] * 1440 + workout["minutesAgo"] < 40:
                raise ValueError("Capture history needs an existing routine and a past, bounded 40-minute workout.")
            sets = workout.get("setsPerMovement", 3)
            if type(sets) is not int or not 1 <= sets <= 20:
                raise ValueError("Capture history needs 1 to 20 sets per movement.")
            if sets * len(fixture["routines"][workout["routine"]]["entries"]) > 20:
                raise ValueError("Capture custom history must fit all sets inside its 40-minute workout.")
            kg = workout["weightKg"]
            try:
                number = float(kg) if type(kg) in (int, float) else math.nan
            except OverflowError:
                number = math.nan
            if not math.isfinite(number) or Decimal(repr(number)).as_tuple().exponent < -2 or \
                    type(workout["reps"]) is not int or not 1 <= workout["reps"] <= 500:
                raise ValueError("Capture history needs a finite load in hundredths and 1 to 500 reps.")
    return fixture


def command(arguments, *, input=None, cwd=None, env=None, check=True):
    result = subprocess.run([str(value) for value in arguments], input=input, cwd=cwd, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if check and result.returncode:
        raise RuntimeError(f"{Path(arguments[0]).name} failed with status {result.returncode}.")
    return result.stdout


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, target):
        raise RuntimeError("The local capture stack redirected a request; refusing it.")


class Fixture:
    def __init__(self, origin, database):
        self.origin = local_origin(origin)
        self.database = database
        self.account = str(uuid.uuid4())
        self.email = f"capture-{self.account}@example.com"
        self.token = secrets.token_hex(24)
        self.now = int(time.time() * 1000)
        self.client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.mcp_token = None
        self.mcp_session = None
        self.routines = []

    def sql(self, query):
        return command(["psql", self.database, "-XAtq", "-v", "ON_ERROR_STOP=1"], input=query.encode()).decode().strip()

    def save_events(self, output):
        events = self.sql("SELECT COALESCE(json_agg(json_build_object('name',name,'props',props) ORDER BY id),'[]'::json) FROM events;")
        (output / "events.json").write_text(events + "\n")

    def request(self, path, body=None, token=None, headers=None):
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        if path.startswith("/v1/gym/"):
            request_headers["Sync-Schema"] = str(json.loads((ROOT / "packages/api-contract/sync/gym.registry.json").read_text())["version"])
        if token:
            request_headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request(self.origin + path, None if body is None else json.dumps(body).encode(), request_headers)
        try:
            with self.client.open(request, timeout=30) as response:
                return response.headers, json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"Local fixture request failed: {path} ({error.code}).") from None

    def mcp(self, name, arguments):
        _, body = self.request("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": name, "arguments": arguments}}, self.mcp_token, {"Mcp-Session-Id": self.mcp_session})
        result = body.get("result", {})
        if body.get("error") or result.get("isError"):
            raise RuntimeError(f"Local fixture MCP refused {name}.")
        return result

    def link(self):
        token = secrets.token_hex(24)
        digest = hashlib.sha256(token.encode()).hexdigest()
        now = int(time.time() * 1000)
        self.sql(f"INSERT INTO magic_links(token_hash,email,created_ms,expires_ms) VALUES ('{digest}','{self.email}',{now},{now + 900000});")
        return token

    def push(self, rows, schema):
        replica = "rp_" + secrets.token_hex(16)
        pending = [{"n": index + 1, "scope": "self/gym", "d": [row]} for index, row in enumerate(rows)]
        ack = 0
        for _ in range(20):
            if not pending:
                return
            _, response = self.request("/v1/sync/push", {"replica": replica, "account": self.account,
                "ackThrough": ack, "intents": pending}, self.token, {"Sync-Schema": str(schema)})
            results = response.get("results")
            if response.get("as") != self.account or not isinstance(results, list) or len(results) > len(pending):
                raise RuntimeError("Capture fixture received a malformed sync reply.")
            for expected, result in zip(pending, results):
                if not isinstance(result, dict) or type(result.get("n")) is not int or result["n"] != expected["n"]:
                    raise RuntimeError("Capture fixture received noncontiguous sync results.")
                if result.get("s") == "refused":
                    raise RuntimeError(f"Capture fixture sync intent {result['n']} was refused.")
                if result.get("s") != "ok" or type(result.get("seq")) is not int or result["seq"] < 0:
                    raise RuntimeError("Capture fixture received a malformed sync result.")
            acknowledged = results[-1]["n"] if results else ack
            if type(response.get("lastN")) is not int or response["lastN"] != acknowledged:
                raise RuntimeError("Capture fixture received an inconsistent sync acknowledgement.")
            pending = pending[len(results):]
            ack = acknowledged
            if not pending:
                if "retry" in response:
                    raise RuntimeError("Capture fixture received a retry after every intent was acknowledged.")
                return
            retry = response.get("retry")
            if not isinstance(retry, dict) or type(retry.get("n")) is not int or retry["n"] != pending[0]["n"] or \
                    type(retry.get("retryAfterMs")) is not int or not 0 <= retry["retryAfterMs"] <= 1000:
                raise RuntimeError("Capture fixture received an invalid sync retry.")
            time.sleep(retry["retryAfterMs"] / 1000)
        raise RuntimeError("Capture fixture sync did not acknowledge every intent within 20 attempts.")

    def seed(self, replacement=None):
        digest = hashlib.sha256(self.token.encode()).hexdigest()
        self.sql(f"INSERT INTO users(id,email) VALUES ('{self.account}','{self.email}');\n"
                 f"INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('{digest}','{self.account}',{self.now + 86400000});")
        connections = replacement.get("connections", False) if replacement is not None else False
        _, key = self.request("/v1/mcp-keys", {"name": "A static key" if connections else "Android design capture"}, self.token)
        self.mcp_token = key["token"]
        if connections:
            client = "capture-" + self.account
            self.sql(f"INSERT INTO oauth_clients(client_id,redirect_uris,client_name) "
                     f"VALUES ('{client}',ARRAY['https://example.com/oauth/callback'],'Claude Desktop');\n"
                     f"INSERT INTO oauth_grants(user_id,client_id,granted_ms,scope) "
                     f"VALUES ('{self.account}','{client}',{self.now},'gym:read gym:write');")
            _, grants = self.request("/v1/oauth/grants", token=self.token)
            _, keys = self.request("/v1/mcp-keys", token=self.token)
            if len(grants["grants"]) != 1 or len(keys["keys"]) != 1 or \
                    grants["grants"][0]["name"] != "Claude Desktop" or keys["keys"][0]["name"] != "A static key":
                raise RuntimeError("Capture connections did not retain both credential kinds.")
        headers, _ = self.request("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "android-design-capture", "version": "1"}}}, self.mcp_token)
        self.mcp_session = headers["Mcp-Session-Id"]
        prefix = "capture" + self.account.replace("-", "")[:12]
        program = [{"name": name, "entries": [
            {"exerciseId": movement, "sets": [{"reps": 8, "weightKg": 30}] * 3, "restSeconds": 120}
            for movement in movements]} for name, movements in (
                ("Push A", ["bench-press", "overhead-press"]), ("Pull A", ["barbell-row", "chin-up"]),
                ("Legs", ["back-squat", "romanian-deadlift"]))]
        if replacement is not None:
            _, existing = self.request("/v1/gym/exercises", token=self.token)
            catalog = existing if isinstance(existing, list) else existing["exercises"]
            for exercise in replacement["exercises"]:
                if any(row["id"] == exercise["id"] or row["name"].casefold() == exercise["name"].casefold() for row in catalog):
                    raise ValueError("A capture movement duplicates the existing catalogue.")
                self.mcp("gym_create_exercise", exercise)
                catalog.append(exercise)
            program = replacement["routines"]
        _, catalog = self.request("/v1/gym/exercises", token=self.token)
        exercises = catalog if isinstance(catalog, list) else catalog["exercises"]
        known = {entry["id"] for entry in exercises}
        for position, routine in enumerate(program):
            if not all(entry["exerciseId"] in known for entry in routine["entries"]):
                raise RuntimeError("The seed catalogue does not contain a capture movement.")
            routine_id = "rt_" + prefix + str(position)
            self.routines.append(routine_id)
            self.mcp("gym_create_routine", {"id": routine_id, "name": routine["name"], "position": position,
                                           "entries": routine["entries"]})
        history = replacement.get("history") if replacement is not None else None
        default_history = history is None
        if default_history:
            history = [{"routine": index % len(program), "daysAgo": 28 - index * 2, "minutesAgo": 0,
                        "weightKg": 30 + index * 2.5, "reps": 8} for index in range(12)]
        for index, workout in enumerate(history):
            routine = workout["routine"]
            sets_per_movement = workout.get("setsPerMovement", 3)
            started = self.now - workout["daysAgo"] * 86400000 - workout["minutesAgo"] * 60000
            session = "ses_" + prefix + str(index)
            duration = max(2400000, (len(program[routine]["entries"]) * 3 + 1) * 120000) if default_history else 2400000
            self.mcp("gym_import_session", {"id": session, "startedAt": started, "finishedAt": started + duration,
                "routineId": self.routines[routine], "sets": [
                    {"id": f"set_{prefix}{index}_{movement}_{number}", "exerciseId": entry["exerciseId"],
                     "weightKg": workout["weightKg"], "reps": workout["reps"], "completedAt": started + (movement * sets_per_movement + number + 1) * 120000}
                    for movement, entry in enumerate(program[routine]["entries"]) for number in range(sets_per_movement)]})
        stamp = f"{self.now}:0:r_capture00000"
        rows = []
        today = datetime.fromtimestamp(self.now / 1000, timezone.utc).date()
        for index in range(6):
            day = (today - timedelta(days=index * 5)).isoformat()
            rows.append({"t": "weighin", "id": day, "life": ["alive", stamp],
                         "f": {"kg": [80 - index * .2, stamp], "recordedAt": [self.now - index * 5 * 86400000, stamp]}})
        for index, (title, text) in enumerate([("Training week", "Three sessions each week."), ("Equipment", "Barbells and dumbbells are available.")]):
            rows.append({"t": "note", "id": f"note_{prefix}{index}", "life": ["alive", stamp], "born": stamp,
                         "f": {"title": [title, stamp], "body": [text, stamp], "ord": ["a" + str(index), stamp]}})
        schema = json.loads((ROOT / "packages/api-contract/sync/gym.registry.json").read_text())["version"]
        _, hello = self.request("/v1/sync/hello", token=self.token, headers={"Sync-Schema": str(schema)})
        self.push(rows, hello["schema"])
        _, weights = self.request("/v1/gym/bodyweight", token=self.token)
        _, notes = self.request("/v1/gym/notes", token=self.token)
        if len(weights.get("entries", [])) != 6 or len(notes.get("notes", [])) != 2:
            raise RuntimeError("Capture fixture did not retain all six weigh-ins and two notes.")


class ModelFixture(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        self.server.calls += 1
        content = self.server.responses.pop(0) if self.server.responses else MODEL_FALLBACK
        start_delay, chunk_chars, chunk_delay = getattr(self.server, "timing", (0, None, 0))
        stop_reason = "tool_use" if any(block["type"] == "tool_use" for block in content) else "end_turn"
        response = {"id": "msg_capture", "type": "message", "role": "assistant", "model": body.get("model", "fixture"),
                    "content": content, "stop_reason": stop_reason, "usage": {"input_tokens": 100, "output_tokens": 25, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}
        if body.get("stream"):
            events = [{"type": "message_start", "message": {**response, "content": [], "stop_reason": None}}]
            for index, block in enumerate(content):
                if block["type"] == "text":
                    start = {"type": "text", "text": ""}
                    chunks = [block["text"][at:at + chunk_chars] for at in range(0, len(block["text"]), chunk_chars)] if chunk_chars else [block["text"]]
                    deltas = [{"type": "text_delta", "text": chunk} for chunk in chunks or [""]]
                elif block["type"] == "tool_use":
                    start = {**block, "input": {}}
                    deltas = [{"type": "input_json_delta", "partial_json": json.dumps(block["input"])}]
                else:
                    raise ValueError("Capture model supports text and tool_use blocks.")
                events.append({"type": "content_block_start", "index": index, "content_block": start})
                events.extend({"type": "content_block_delta", "index": index, "delta": delta} for delta in deltas)
                events.append({"type": "content_block_stop", "index": index})
            events.extend([{"type": "message_delta", "delta": {"stop_reason": stop_reason}, "usage": {"output_tokens": 25}},
                           {"type": "message_stop"}])
            frames = [(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode(),
                       event.get("delta", {}).get("type") == "text_delta") for event in events]
            media = "text/event-stream"
        else:
            frames, media = [(json.dumps(response).encode(), False)], "application/json"
        encoded = b"".join(frame for frame, _ in frames)
        self.send_response(200)
        self.send_header("Content-Type", media)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        try:
            if start_delay:
                time.sleep(start_delay / 1000)
            if not chunk_delay:
                self.wfile.write(encoded)
                return
            saw_text = False
            for frame, text in frames:
                if text and saw_text:
                    time.sleep(chunk_delay / 1000)
                self.wfile.write(frame)
                self.wfile.flush()
                saw_text = saw_text or text
        except (BrokenPipeError, ConnectionResetError):
            pass


class MailFixture(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if self.path != "/emails" or self.headers.get("Authorization") != "Bearer local-capture-only" or not 0 < length <= 4096:
            self.send_error(400)
            return
        try:
            body = json.loads(self.rfile.read(length))
            code = body["template"]["variables"]["sign_in_code"]
            valid = body["template"]["id"] == "magic-code" and re.fullmatch(r"[0-9]{6}", code) and \
                body["from"] == "Windmill <capture@example.test>" and isinstance(body["to"], str)
        except (ValueError, KeyError, TypeError):
            valid = False
        if not valid:
            self.send_error(400)
            return
        self.server.code = code
        self.server.calls += 1
        encoded = b'{"id":"capture-mail"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class Device:
    def __init__(self, sdk, port, auth_code=None):
        self.auth_code = auth_code
        self.adb = sdk / "platform-tools/adb"
        self.serial = f"emulator-{port}"
        self.touch_bounds = None
        self.touch_point = None
        self.sdk = sdk
        self.notification_clock = False
        self.tile_clock = False
        self.workout_clock = False
        self.live_coach = False

    def prepare_hierarchy_capture(self):
        jdk = Path(os.environ["JAVA_HOME"]) / "bin"
        build = self.output / "hierarchy-helper"
        build.mkdir()
        sdk = self.sdk / "platforms/android-36/android.jar"
        source = ROOT / "apps/android/tools/design-capture/CaptureTree.java"
        command([jdk / "javac", "--release", "8", "-cp", sdk, "-d", build, source])
        command([jdk / "java", "-cp", self.sdk / "build-tools/36.0.0/lib/d8.jar", "com.android.tools.r8.D8",
                 "--lib", sdk, "--output", build, build / "works/windmill/capture/CaptureTree.class"])
        jar = build / "capture-tree.jar"
        with zipfile.ZipFile(jar, "w") as archive:
            archive.write(build / "classes.dex", "classes.dex")
        self.run("push", jar, "/data/local/tmp/capture-tree.jar")

    def prepare_notification_capture(self):
        self.prepare_hierarchy_capture()
        self.run("shell", "locksettings", "set-pin", "2468")
        self.run("shell", "settings", "put", "secure", "lock_screen_allow_private_notifications", "0")
        self.notification_clock = True
        self.run("shell", "input", "keyevent", "KEYCODE_SLEEP")
        self.notification_surface("unlock")
        self.notification_clock = False

    def prepare_workout_tile(self):
        self.tile_clock = True
        component = PACKAGE + "/works.windmill.gym.notification.WorkoutTileService"
        self.run("shell", "cmd", "statusbar", "add-tile", component)
        self.run("shell", "cmd", "statusbar", "set-large-tiles", "'custom(" + component + ")'")
        self.run("shell", "cmd", "statusbar", "collapse")
        self.tile_clock = False

    def quick_settings(self):
        for _ in range(3):
            self.run("shell", "cmd", "statusbar", "expand-settings")
            tree = self.settle(tile_clock=True, timeout=10)
            if any(node.get("content-desc") == "Edit order of Quick Settings." and node.get("visible-to-user") == "true"
                   for node in tree.iter("node")):
                return
        raise RuntimeError("Quick Settings did not expand.")

    def workout_tile(self, state, timeout=30):
        if state not in ("active", "off"):
            raise ValueError("Workout tile checks require active or off.")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            tree = self.tree()
            for node in tree.iter("node"):
                if node.get("resource-id") == "com.android.systemui:id/qs_tile_large" and \
                        node.get("package") == "com.android.systemui" and \
                        any(child.get("text") == "Workout" for child in node.iter("node")):
                    value = node.get("state-desc", "")
                    if (state == "off" and value == ", Off") or \
                            (state == "active" and re.fullmatch(r", .+ · [0-9]+:[0-9]{2}(?::[0-9]{2})?", value)):
                        return node
        raise RuntimeError("The workout tile did not reach the requested state.")

    def notification_surface(self, surface):
        if surface == "shade":
            self.run("shell", "cmd", "statusbar", "expand-notifications")
        elif surface == "home":
            self.run("shell", "input", "keyevent", "KEYCODE_HOME")
        elif surface == "lock":
            self.run("shell", "input", "keyevent", "KEYCODE_SLEEP")
            self.run("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        elif surface == "unlock":
            self.run("shell", "input", "keyevent", "KEYCODE_WAKEUP")
            self.find("Device locked")
            self.run("shell", "input", "swipe", "540", "2100", "540", "500", "500")
            self.find("com.android.systemui:id/pinEntry")
            self.run("shell", "input", "text", "2468")
            self.run("shell", "input", "keyevent", "KEYCODE_ENTER")
            self.find("Home")
        else:
            raise ValueError("Unknown notification capture surface.")

    def run(self, *arguments, **kwargs):
        return command([self.adb, "-s", self.serial, *arguments], **kwargs)

    def tree(self):
        self.run("shell", "rm", "-f", "/data/local/tmp/design-capture.xml")
        if self.notification_clock or self.tile_clock or self.workout_clock or self.live_coach:
            self.run("shell", "CLASSPATH=/data/local/tmp/capture-tree.jar:/system/framework/uiautomator.jar",
                     "app_process", "/system/bin", "works.windmill.capture.CaptureTree")
        else:
            self.run("shell", "uiautomator", "dump", "/data/local/tmp/design-capture.xml")
        try:
            return ET.fromstring(self.run("exec-out", "cat", "/data/local/tmp/design-capture.xml", check=False))
        except ET.ParseError:
            return ET.Element("unavailable")

    def find(self, value, timeout=30, row=False, contains=False):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            tree = self.tree()
            for node in tree.iter("node"):
                labels = (node.get("text", ""), node.get("content-desc", ""), node.get("resource-id", ""))
                if node.get("visible-to-user") != "false" and (any(value in label for label in labels) if contains else value in labels):
                    if not row:
                        return node
                    parents = {child: parent for parent in tree.iter() for child in parent}
                    while node is not None and node.get("clickable") != "true":
                        node = parents.get(node)
                    if node is None:
                        raise RuntimeError("Capture row target has no clickable ancestor.")
                    return node
            time.sleep(.2)
        (self.output / "failure-ui.xml").write_bytes(ET.tostring(tree))
        (self.output / "failure-ui.png").write_bytes(self.run("exec-out", "screencap", "-p"))
        raise RuntimeError(f"Capture state did not expose {value!r}.")

    def settle(self, *, resend_countdown=False, notification_clock=False, tile_clock=False, workout_clock=False, timeout=30):
        previous = None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            tree = self.tree()
            compared = ET.fromstring(ET.tostring(tree))
            for node in compared.iter("node"):
                if resend_countdown:
                    for key in ("text", "content-desc"):
                        if re.fullmatch(r"Resend in (?:[1-9]|[12][0-9]|30)s", node.get(key, "")):
                            node.set(key, "Resend countdown")
                if notification_clock and node.get("resource-id") == "android:id/chronometer" and \
                        node.get("class") == "android.widget.Chronometer" and node.get("package") == "com.android.systemui":
                    node.set("text", "<chronometer>")
                    node.set("content-desc", "<chronometer>")
                if workout_clock and node.get("package") == PACKAGE:
                    matched = re.fullmatch(r"(Workout time|Since start|Since last set), [0-9]+:[0-9]{2}(?::[0-9]{2})?",
                                           node.get("content-desc", ""))
                    if matched:
                        node.set("content-desc", matched[1] + ", <clock>")
                if tile_clock and node.get("resource-id") == "com.android.systemui:id/qs_tile_large" and \
                        node.get("package") == "com.android.systemui" and \
                        any(child.get("text") == "Workout" for child in node.iter("node")):
                    value = node.get("state-desc", "")
                    matched = re.fullmatch(r"(, .+ · )[0-9]+:[0-9]{2}(?::[0-9]{2})?", value)
                    if matched:
                        node.set("state-desc", matched[1] + "<clock>")
            current = ET.tostring(compared)
            if tree.tag != "unavailable" and current == previous:
                return tree
            previous = current
        raise RuntimeError("The capture screen did not settle.")

    def tap(self, value, contains=False):
        previous = None
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            node = self.find(value, timeout=max(.1, deadline - time.monotonic()), contains=contains)
            current = node.get("bounds", "")
            if current == previous:
                bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", current)
                if not bounds:
                    raise RuntimeError("Capture control has no bounds.")
                left, top, right, bottom = map(int, bounds.groups())
                self.run("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))
                return
            previous = current
        raise RuntimeError("The capture control did not stop moving.")

    def launch(self, launcher=False):
        intent = ["-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER"] if launcher else ["-a", "android.intent.action.VIEW"]
        return self.run("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity", *intent)

    def viewport(self, value=None):
        if value is None:
            self.run("shell", "wm", "size", "reset")
            self.run("shell", "wm", "density", "reset")
            self.run("shell", "settings", "put", "system", "font_scale", "1")
            return
        width, height, density = (value[key] for key in ("width", "height", "density"))
        if any(type(part) is not int for part in (width, height, density)) or \
                not 320 <= width <= 4096 or not 320 <= height <= 4096 or not 120 <= density <= 640:
            raise ValueError("Specimen viewport needs bounded integer size and density.")
        font_scale = value.get("fontScale", 1)
        if type(font_scale) not in (int, float) or not 1 <= font_scale <= 2:
            raise ValueError("Specimen text scale must be between 1 and 2.")
        self.run("shell", "wm", "size", f"{width}x{height}")
        self.run("shell", "wm", "density", str(density))
        self.run("shell", "settings", "put", "system", "font_scale", str(font_scale))

    def release_touch(self):
        if self.touch_point is None:
            return
        point = self.touch_point
        self.touch_point = None
        self.touch_bounds = None
        self.run("shell", "input", "motionevent", "UP", *map(str, point), check=False)

    def touch(self, value):
        phase = value["phase"]
        if phase == "up":
            self.release_touch()
            return
        if phase not in ("down", "move"):
            raise ValueError("Touch phase must be down, move or up.")
        position = value.get("at", [.5, .5])
        if len(position) != 2 or any(type(part) not in (int, float) or not 0 <= part <= 1 for part in position):
            raise ValueError("Touch coordinates must be fractions of observed control bounds.")
        if phase == "down":
            if self.touch_point is not None:
                raise ValueError("Release the previous touch before starting another.")
            if type(value.get("row", False)) is not bool:
                raise ValueError("Touch row selection must be a boolean.")
            target = self.find(value["target"], row=True) if value.get("row") else self.find(value["target"])
            bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", target.get("bounds", ""))
            if not bounds:
                raise RuntimeError("Capture control has no touch bounds.")
            self.touch_bounds = tuple(map(int, bounds.groups()))
        if self.touch_bounds is None:
            raise ValueError("Touch move requires an observed down target.")
        left, top, right, bottom = self.touch_bounds
        self.touch_point = (round(left + (right - left) * position[0]), round(top + (bottom - top) * position[1]))
        self.run("shell", "input", "motionevent", phase.upper(), *map(str, self.touch_point))

    def sign_in(self, token):
        self.run("shell", "-T", "run-as", PACKAGE, "dd", "of=files/design-capture-link", "bs=1", f"count={len(token)}", input=token.encode())
        self.run("shell", "am", "start", "-W", "-n", PACKAGE + "/.DesignCaptureActivity")
        end = time.monotonic() + 30
        while time.monotonic() < end:
            result = self.run("exec-out", "run-as", PACKAGE, "cat", "files/design-capture-result", check=False).decode()
            if result == "signed-in":
                return
            if result == "failed":
                raise RuntimeError("Debug fixture sign-in failed.")
            time.sleep(.2)
        raise RuntimeError("Debug fixture sign-in timed out.")

    def profile(self, path, timeout=20, poll_seconds=.2):
        deadline = time.monotonic() + timeout
        previous = b""
        while time.monotonic() < deadline:
            current = self.run("exec-out", "cat", path, check=False)
            if current and b"*end\n" in current and current == previous:
                return current
            previous = current
            time.sleep(poll_seconds)
        raise RuntimeError("Android did not finish writing the CPU profile before the capture deadline.")

    def steps(self, steps):
        for step in steps:
            if "tap" in step:
                self.tap(step["tap"])
            elif "tap_contains" in step:
                self.tap(step["tap_contains"], contains=True)
            elif "wait" in step:
                self.find(step["wait"])
            elif "wait_contains" in step:
                self.find(step["wait_contains"], contains=True)
            elif "quick_settings" in step:
                if step["quick_settings"] != "show":
                    raise ValueError("Quick Settings steps support show.")
                self.quick_settings()
            elif "workout_tile" in step:
                self.workout_tile(step["workout_tile"])
            elif "notification" in step:
                self.notification_surface(step["notification"])
            elif "absent" in step:
                tree = self.tree()
                if tree.tag == "unavailable" or any(step["absent"] in (node.get("text"), node.get("content-desc")) for node in tree.iter("node")):
                    raise RuntimeError("Private notification content was present or unreadable.")
            elif "text" in step:
                self.run("shell", "input", "text", step["text"].replace(" ", "%s"))
            elif "keyboard" in step:
                if step["keyboard"] == "show":
                    self.run("shell", "settings", "put", "secure", "show_ime_with_hard_keyboard", "1")
                elif step["keyboard"] == "hide":
                    state = self.run("shell", "dumpsys", "input_method").decode()
                    shown = re.findall(r"\bmInputShown=(true|false)\b", state)
                    if not shown:
                        raise RuntimeError("The native input-method state was unavailable.")
                    if "true" in shown:
                        self.run("shell", "input", "keyevent", "KEYCODE_BACK")
                else:
                    raise ValueError("Keyboard steps support show or hide.")
            elif "auth_code" in step:
                code = self.auth_code() if self.auth_code else None
                if step["auth_code"] not in ("valid", "wrong") or not isinstance(code, str) or not re.fullmatch(r"[0-9]{6}", code):
                    raise ValueError("Auth-code steps need a delivered local challenge and valid/wrong intent.")
                if step["auth_code"] == "wrong":
                    code = "246810" if code != "246810" else "135791"
                self.tap("Code field")
                self.run("shell", "input", "keyevent", "KEYCODE_MOVE_END", *(["KEYCODE_DEL"] * 6))
                self.run("shell", "-T", "sh", input=f"input text {code}\n".encode())
            elif "key" in step:
                self.run("shell", "input", "keyevent", step["key"])
            elif "swipe" in step:
                self.run("shell", "input", "swipe", *map(str, step["swipe"]))
            elif "touch" in step:
                self.touch(step["touch"])
            elif "specimen" in step:
                if step["specimen"] not in ("board", "phone", "long-load", "bound-load", "fit-load", "refusal"):
                    raise ValueError("Unknown native-parts specimen.")
                self.run("shell", "am", "start", "-W", "--activity-clear-top", "-n", PACKAGE + "/.NativePartsActivity",
                         "--es", "specimen", step["specimen"])
                if step["specimen"] == "board" and any(node.get("text") == "Viewing full screen" for node in self.tree().iter("node")):
                    self.tap("Got it")
            else:
                raise ValueError("Unknown capture step.")


def start_emulator(sdk, output, port, stack, auth_code=None):
    serial = f"emulator-{port}"
    if serial in command([sdk / "platform-tools/adb", "devices"]).decode().split():
        raise RuntimeError("The selected emulator port already belongs to a device; refusing install.")
    images = sorted((sdk / "system-images").glob("android-*/*/*/system.img"), reverse=True)
    image = next((value.parent for value in images if int(re.search(r"android-(\d+)", str(value))[1]) >= 36), None)
    if image is None:
        raise RuntimeError("Install an Android API 36+ emulator system image first.")
    avds = output / "avd"
    avd = avds / "WindmillCapture.avd"
    avd.mkdir(parents=True)
    (avds / "WindmillCapture.ini").write_text(f"avd.ini.encoding=UTF-8\npath={avd}\ntarget=android-36\n")
    (avd / "config.ini").write_text("\n".join([
        "AvdId=WindmillCapture", "avd.ini.displayname=Windmill Capture", "hw.device.name=pixel_8", "hw.device.manufacturer=Google", "abi.type=arm64-v8a", "hw.cpu.arch=arm64",
        "hw.cpu.ncore=4", "hw.ramSize=4096", "hw.lcd.width=1080", "hw.lcd.height=2400", "hw.lcd.density=420",
        "hw.keyboard=yes", "hw.gpu.enabled=yes", "hw.gpu.mode=host", "hw.mainKeys=no", "hw.battery=yes",
        "disk.dataPartition.size=4G", "PlayStore.enabled=false", f"image.sysdir.1={image}/", "tag.id=google_apis"]) + "\n")
    log = stack.enter_context((output / "emulator.log").open("wb"))
    process = subprocess.Popen([str(sdk / "emulator/emulator"), "-avd", "WindmillCapture", "-port", str(port),
        "-no-snapshot", "-no-audio", "-no-boot-anim", "-no-window"], env={**os.environ, "ANDROID_AVD_HOME": str(avds)},
        stdout=log, stderr=subprocess.STDOUT)
    stack.callback(stop, process)
    device = Device(sdk, port, auth_code)
    device.output = output
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("The isolated emulator failed to boot; see emulator.log.")
        if device.run("shell", "getprop", "sys.boot_completed", check=False).strip() == b"1":
            if int(device.run("shell", "getprop", "ro.build.version.sdk").strip()) < 36:
                raise RuntimeError("Capture emulator must be API 36 or later.")
            device.run("shell", "input", "keyevent", "KEYCODE_WAKEUP")
            device.run("shell", "wm", "dismiss-keyguard")
            return device
        time.sleep(1)
    raise RuntimeError("The isolated emulator did not finish booting.")


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def main():
    parser = argparse.ArgumentParser(description="Build and capture Android boards against an isolated local stack.")
    parser.add_argument("--output", type=Path, required=True, help="New output directory; captures never overwrite a run.")
    parser.add_argument("--sdk", type=Path, default=Path(os.environ.get("ANDROID_HOME", Path.home() / "Library/Android/sdk")))
    parser.add_argument("--backend-binary", type=Path, default=ROOT / "backend/build/windmill_server")
    parser.add_argument("--backend-port", type=int, default=8098)
    parser.add_argument("--model-port", type=int, default=8099)
    parser.add_argument("--mail-port", type=int, default=8101)
    parser.add_argument("--emulator-port", type=int, default=5580)
    parser.add_argument("--scenarios", type=Path, help="JSON array of board/name/account/steps; each recipe is replayed after appearance switches.")
    parser.add_argument("--fixture", type=Path, help="Optional local exercises/routines JSON; replaces only this run's seeded program.")
    parser.add_argument("--capture-only", action="store_true", help="Capture the explicit empty-training fixture; no cold-workout performance claim.")
    parser.add_argument("--fresh-mode-fixture", action="store_true", help="Seed a fresh disposable account for Light instead of retaining Dark server history.")
    parser.add_argument("--profile-seconds", type=int, default=10)
    parser.add_argument("--baseline", action="store_true", help="Record an expected over-budget baseline without passing performance acceptance.")
    parser.add_argument("--sentry-dsn", default="", help="Optional local collector DSN; no vendor endpoint is accepted.")
    parser.add_argument("--acceptance-pause-seconds", type=int, default=0,
                        help="Keep the isolated stack and emulator available after captures, up to 600 seconds.")
    args = parser.parse_args()
    if not 0 <= args.acceptance_pause_seconds <= 600 or not 1 <= args.profile_seconds <= 60:
        parser.error("Acceptance pause must be 0–600 seconds and the profile 1–60 seconds.")
    if args.sentry_dsn:
        dsn = urllib.parse.urlsplit(args.sentry_dsn)
        if dsn.scheme not in ("http", "https") or dsn.hostname not in ("10.0.2.2", "127.0.0.1", "localhost") or \
                not dsn.port or not 1024 <= dsn.port <= 65535 or not dsn.username or dsn.password or \
                not re.fullmatch(r"/[0-9]+", dsn.path) or dsn.query or dsn.fragment:
            parser.error("Sentry capture requires a local collector DSN with an explicit port.")
    ports = (args.backend_port, args.model_port, args.mail_port, args.emulator_port, args.emulator_port + 1)
    if len(set(ports)) != len(ports) or args.emulator_port % 2 or not 5554 <= args.emulator_port <= 5682:
        parser.error("Use distinct local ports and an even emulator port from 5554 through 5682.")
    for port in ports:
        with socket.socket() as available:
            try:
                available.bind(("127.0.0.1", port))
            except OSError:
                parser.error(f"Local port {port} is already in use.")
    origin = local_origin(f"http://127.0.0.1:{args.backend_port}")
    app_origin = local_origin(f"http://10.0.2.2:{args.backend_port}", emulator=True)
    model_origin = local_origin(f"http://127.0.0.1:{args.model_port}")
    mail_origin = local_origin(f"http://127.0.0.1:{args.mail_port}")
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False, mode=0o700)
    android = ROOT / "apps/android"
    scenarios = json.loads(args.scenarios.read_text()) if args.scenarios else SCENARIOS
    try:
        validate_scenarios(scenarios)
        replacement = read_fixture(args.fixture, capture_only=args.capture_only)
    except ValueError as error:
        parser.error(str(error))
    manifest = {"apiOrigin": app_origin, "source": command(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
                "sourceDirty": bool(command(["git", "status", "--porcelain"], cwd=ROOT)),
                "baseline": args.baseline, "captureOnly": args.capture_only, "captures": [], "failures": [], "authCompletions": 0}
    manifest_path = args.output / "capture-manifest.json"
    def save_manifest(kind, value, traceback):
        if kind is not None:
            manifest["failures"].append({"type": kind.__name__, "step": manifest.get("step", "setup")})
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    def stop_requested(signum, frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop_requested)
    database = "wm_android_capture_" + secrets.token_hex(6)
    database_url = f"postgresql:///{database}?host=/tmp"
    with ExitStack() as stack:
        stack.push(save_manifest)
        command(["createdb", "-h", "/tmp", database])
        stack.callback(command, ["dropdb", "-h", "/tmp", "--if-exists", database])
        command(["psql", database_url, "-Xq", "-v", "ON_ERROR_STOP=1", "-f", ROOT / "backend/db/schema.sql"])
        model = ThreadingHTTPServer(("127.0.0.1", args.model_port), ModelFixture)
        model.responses = []
        model.calls = 0
        model_thread = threading.Thread(target=model.serve_forever, daemon=True)
        model_thread.start()
        stack.callback(model.server_close)
        stack.callback(model.shutdown)
        mail = ThreadingHTTPServer(("127.0.0.1", args.mail_port), MailFixture)
        mail.code, mail.calls = None, 0
        mail_thread = threading.Thread(target=mail.serve_forever, daemon=True)
        mail_thread.start()
        stack.callback(mail.server_close)
        stack.callback(mail.shutdown)
        backend_log = stack.enter_context((args.output / "backend.log").open("wb"))
        safe_env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ") if key in os.environ}
        anonymous_coach = {"AI_ALLOWANCES_ENABLED": "true", "AI_INSTALLATIONS_ENABLED": "true",
            "AI_INSTALLATION_PROXY_MODE": "direct", "AI_INSTALLATION_IP_HMAC_KEY": secrets.token_hex(32),
            "WINDMILL_OWNER_EMAILS": "capture@example.test", "AI_ALLOWANCE_ALERT_EMAIL": "capture@example.test"} if args.capture_only else {}
        backend = subprocess.Popen([str(args.backend_binary.resolve())], cwd=ROOT / "backend", env={**safe_env, **anonymous_coach,
            "DATABASE_URL": database_url, "PORT": str(args.backend_port), "ANTHROPIC_API_KEY": "local-capture-only",
            "ANTHROPIC_BASE_URL": model_origin, "COACH_ANTHROPIC_BASE_URL": model_origin,
            "WINDMILL_ALLOWED_ORIGINS": "http://localhost:5173", "RESEND_BASE_URL": mail_origin,
            "RESEND_API_KEY": "local-capture-only", "RESEND_FROM": "Windmill <capture@example.test>"}, stdout=backend_log, stderr=subprocess.STDOUT)
        stack.callback(stop, backend)
        fixture = Fixture(origin, database_url)
        stack.callback(fixture.save_events, args.output)
        for attempt in range(60):
            if backend.poll() is not None:
                raise RuntimeError("Local backend exited; see backend.log.")
            try:
                with socket.create_connection(("127.0.0.1", args.backend_port), timeout=.5):
                    pass
                break
            except (OSError, RuntimeError):
                if attempt == 59:
                    raise RuntimeError("Local backend did not become ready.") from None
                time.sleep(.5)
        fixture.seed(replacement)
        build_log = stack.enter_context((args.output / "build.log").open("wb"))
        build = subprocess.run(["./gradlew", ":app:assembleDebug", "--max-workers=4", "-Pwindmill.apiBase=" + app_origin, "-Pwindmill.debugTelemetry=true", "-Pwindmill.sentryDsn=" + args.sentry_dsn],
            cwd=android, env={**os.environ, "ANDROID_HOME": str(args.sdk)}, stdout=build_log, stderr=subprocess.STDOUT)
        if build.returncode:
            raise RuntimeError("Debug build failed; see build.log.")
        checked_build_config(android, app_origin)
        apk = args.output / "app-debug.apk"
        shutil.copyfile(android / "app/build/outputs/apk/debug/app-debug.apk", apk)
        manifest["apkSha256"] = hashlib.sha256(apk.read_bytes()).hexdigest()
        manifest["step"] = "emulator"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        device = start_emulator(args.sdk, args.output, args.emulator_port, stack, auth_code=lambda: mail.code)
        if any(scenario.get("notification_clock") for scenario in scenarios):
            device.prepare_notification_capture()
        elif any(scenario.get("tile_clock") or scenario.get("workout_clock") or scenario.get("model_timing") for scenario in scenarios):
            device.prepare_hierarchy_capture()
        device.run("install", apk)
        if any(scenario.get("tile_clock") for scenario in scenarios):
            device.prepare_workout_tile()
        manifest["sdk"] = int(device.run("shell", "getprop", "ro.build.version.sdk"))
        for account in ("empty", "fixture"):
            for mode, value in (("dark", "yes"), ("light", "no")):
                if args.fresh_mode_fixture and account == "fixture" and mode == "light":
                    fixture = Fixture(origin, database_url)
                    fixture.seed(replacement)
                mail.code = None
                device.run("shell", "pm", "clear", PACKAGE)
                device.run("shell", "pm", "grant", PACKAGE, "android.permission.POST_NOTIFICATIONS")
                device.run("shell", "cmd", "uimode", "night", value)
                device.launch(launcher=any(item.get("launcher", False) for item in scenarios if item["account"] == account))
                if account == "fixture":
                    device.sign_in(fixture.link())
                    device.find("Hi, I’m Coach. I can help you with:" if args.capture_only else "Push A")
                for scenario in [item for item in scenarios if item["account"] == account]:
                    completions = sum(step.get("auth_code") == "valid" for step in scenario["steps"] + scenario.get("after", []))
                    sessions_before = int(fixture.sql("SELECT count(*) FROM sessions;")) if completions else 0
                    responses = json.dumps(scenario.get("responses", []))
                    if "$routine0" in responses:
                        if not fixture.routines:
                            raise ValueError("The empty-training fixture has no routine placeholder.")
                        responses = responses.replace("$routine0", fixture.routines[0])
                    model.responses = json.loads(responses)
                    model.timing = model_timing(scenario)
                    manifest["step"] = f"{scenario['board']}-{scenario['name']}-{mode}"
                    device.notification_clock = scenario.get("notification_clock", False)
                    device.tile_clock = scenario.get("tile_clock", False)
                    device.workout_clock = scenario.get("workout_clock", False)
                    device.live_coach = bool(scenario.get("model_timing"))
                    try:
                        if "viewport" in scenario:
                            device.viewport(scenario["viewport"])
                        device.steps(scenario["steps"])
                        tree = device.settle(resend_countdown=scenario.get("resend_countdown", False),
                                             notification_clock=device.notification_clock,
                                             tile_clock=device.tile_clock, workout_clock=device.workout_clock) if scenario.get("settle", True) else None
                        if model.responses:
                            raise RuntimeError("The capture did not consume its deterministic model responses.")
                        filename = f"{scenario['board']}-{scenario['name']}-{mode}.png"
                        if tree is not None:
                            (args.output / filename).with_suffix(".xml").write_bytes(ET.tostring(tree))
                        if device.notification_clock:
                            (args.output / filename).with_suffix(".notification.txt").write_bytes(device.run("shell", "dumpsys", "notification", "--noredact"))
                        time.sleep(scenario.get("frame_delay_ms", 0) / 1000)
                        (args.output / filename).write_bytes(device.run("exec-out", "screencap", "-p"))
                        manifest["captures"].append({"board": scenario["board"], "mode": mode, "file": filename,
                            **({"viewport": scenario["viewport"]} if "viewport" in scenario else {}),
                            **({"frameDelayMs": scenario["frame_delay_ms"]} if "frame_delay_ms" in scenario else {})})
                        device.steps(scenario.get("after", []))
                        if completions:
                            sessions_after = int(fixture.sql("SELECT count(*) FROM sessions;"))
                            digest = hashlib.sha256(mail.code.encode()).hexdigest()
                            spent = int(fixture.sql(f"SELECT count(*) FROM magic_links WHERE code_hash='{digest}' AND consumed_ms IS NOT NULL;"))
                            if sessions_after - sessions_before != completions or spent < 1:
                                raise RuntimeError("The native code sign-in did not commit its session and spend its challenge.")
                            manifest["authCompletions"] += completions
                    finally:
                        device.live_coach = False
                        try:
                            device.release_touch()
                        finally:
                            if "viewport" in scenario:
                                device.viewport()
        manifest["mailCalls"] = mail.calls
        device.notification_clock = False
        device.tile_clock = False
        device.workout_clock = False
        manifest["modelCalls"] = model.calls
        if args.capture_only:
            manifest["performanceAccepted"] = None
            logcat = device.run("logcat", "-d", "-v", "brief", "ActivityManager:I", "AndroidRuntime:E", "*:S").decode(errors="replace")
            (args.output / "android-runtime.log").write_text(logcat)
            manifest["anr"] = "ANR in " + PACKAGE in logcat or "FATAL EXCEPTION" in logcat
        else:
            manifest["step"] = "cold-start"
            device.tap("Routines")
            profile = json.dumps(fixture.routines).encode()
            device.run("shell", "-T", "run-as", PACKAGE, "dd", "of=files/design-capture-profile", "bs=1", f"count={len(profile)}", input=profile)
            device.run("shell", "run-as", PACKAGE, "rm", "-f", "files/design-capture-ready")
            device.run("shell", "am", "force-stop", PACKAGE)
            started = time.monotonic()
            launch = device.launch().decode()
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                ready = device.run("exec-out", "run-as", PACKAGE, "cat", "files/design-capture-ready", check=False).decode().strip()
                if re.fullmatch(r"[0-9]+ [0-9]+", ready):
                    process_start, frame = map(int, ready.split())
                    manifest["coldStartToRoutinesMs"] = frame - process_start
                    break
                time.sleep(.05)
            else:
                raise RuntimeError("The private ready-frame probe did not finish.")
            device.find("Push A")
            manifest["selectorWallTimeMs"] = round((time.monotonic() - started) * 1000)
            manifest["activityLaunch"] = {key: int(value) for key, value in re.findall(r"(TotalTime|WaitTime): (\d+)", launch)}
            device.tap("Push A")
            device.tap("Start workout")
            entry_failure = None
            try:
                device.find("Log set")
            except RuntimeError as error:
                entry_failure = str(error)
            manifest["workoutEntryFailure"] = entry_failure
            (args.output / "capture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
            manifest["step"] = "idle-profile"
            trace = "/data/local/tmp/windmill-design-capture.trace"
            device.run("shell", "am", "profile", "start", "--sampling", "1000", PACKAGE, trace)
            time.sleep(args.profile_seconds)
            device.run("shell", "am", "profile", "stop", PACKAGE)
            (args.output / "workout-idle.trace").write_bytes(device.profile(trace))
            (args.output / "workout-cpu.txt").write_bytes(device.run("shell", "dumpsys", "cpuinfo"))
            logcat = device.run("logcat", "-d", "-v", "brief", "ActivityManager:I", "AndroidRuntime:E", "*:S").decode(errors="replace")
            (args.output / "android-runtime.log").write_text(logcat)
            manifest["anr"] = "ANR in " + PACKAGE in logcat or "FATAL EXCEPTION" in logcat
            (args.output / "capture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
            manifest["performanceAccepted"] = manifest["coldStartToRoutinesMs"] < 3000
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
            if not manifest["performanceAccepted"] and not args.baseline:
                raise RuntimeError("Cold start exceeded the 3000ms budget; see capture-manifest.json.")
            if entry_failure:
                raise RuntimeError(entry_failure)
        fixture.save_events(args.output)
        if manifest["anr"]:
            raise RuntimeError("The native capture run reported an ANR or fatal exception.")
        if args.acceptance_pause_seconds:
            print(json.dumps({"acceptanceReady": True, "serial": device.serial, "localDatabase": database_url,
                              "seconds": args.acceptance_pause_seconds}), flush=True)
            time.sleep(args.acceptance_pause_seconds)
        fixture.save_events(args.output)
        manifest["step"] = "complete"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps({"output": str(args.output), "captures": len(manifest["captures"]),
                          "coldStartToRoutinesMs": manifest.get("coldStartToRoutinesMs")}))


if __name__ == "__main__":
    main()
