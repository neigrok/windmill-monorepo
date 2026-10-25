#!/usr/bin/env python3
import argparse
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
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
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[3]
PACKAGE = "works.windmill.app"
SCENARIOS = [
    {"board": "02.7", "name": "empty-routines", "account": "empty", "steps": [{"wait": "No routines yet."}]},
    {"board": "02.1", "name": "routines", "account": "fixture", "steps": [{"tap": "Routines"}, {"wait": "Push A"}]},
    {"board": "05.1", "name": "log", "account": "fixture", "steps": [{"tap": "Log"}, {"wait": "Back Squat · new best"}]},
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


def validate_scenarios(scenarios):
    for scenario in scenarios:
        if not re.fullmatch(r"(?:[0-9]+(?:\.[0-9]+|[a-z])|[A-Z][0-9]+)", scenario["board"]) or \
                not re.fullmatch(r"[a-z0-9-]+", scenario["name"]) or scenario["account"] not in ("empty", "fixture"):
            raise ValueError("Recipes need a canonical board ID, a lowercase filename slug, and an empty or fixture account.")


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

    def request(self, path, body=None, token=None, headers=None):
        request_headers = {"Content-Type": "application/json", **(headers or {})}
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

    def seed(self):
        digest = hashlib.sha256(self.token.encode()).hexdigest()
        self.sql(f"INSERT INTO users(id,email) VALUES ('{self.account}','{self.email}');\n"
                 f"INSERT INTO sessions(token_hash,user_id,expires_ms) VALUES ('{digest}','{self.account}',{self.now + 86400000});")
        _, key = self.request("/v1/mcp-keys", {"name": "Android design capture"}, self.token)
        self.mcp_token = key["token"]
        headers, _ = self.request("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "android-design-capture", "version": "1"}}}, self.mcp_token)
        self.mcp_session = headers["Mcp-Session-Id"]
        prefix = "capture" + self.account.replace("-", "")[:12]
        program = [("Push A", ["bench-press", "overhead-press"]), ("Pull A", ["barbell-row", "chin-up"]),
                   ("Legs", ["back-squat", "romanian-deadlift"])]
        _, catalog = self.request("/v1/gym/exercises", token=self.token)
        exercises = catalog if isinstance(catalog, list) else catalog["exercises"]
        known = {entry["id"] for entry in exercises}
        for position, (name, movements) in enumerate(program):
            if not all(movement in known for movement in movements):
                raise RuntimeError("The seed catalogue does not contain a capture movement.")
            routine = "rt_" + prefix + str(position)
            self.routines.append(routine)
            self.mcp("gym_create_routine", {"id": routine, "name": name, "position": position, "entries": [
                {"exerciseId": movement, "sets": [{"reps": 8, "weightKg": 30}] * 3, "restSeconds": 120} for movement in movements]})
        for index in range(12):
            routine = index % 3
            started = self.now - (28 - index * 2) * 86400000
            session = "ses_" + prefix + str(index)
            self.mcp("gym_import_session", {"id": session, "startedAt": started, "finishedAt": started + 2400000,
                "routineId": self.routines[routine], "sets": [
                    {"id": f"set_{prefix}{index}_{movement}_{number}", "exerciseId": exercise,
                     "weightKg": 30 + index * 2.5, "reps": 8, "completedAt": started + (movement * 3 + number + 1) * 120000}
                    for movement, exercise in enumerate(program[routine][1]) for number in range(3)]})
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
        _, result = self.request("/v1/sync/push", {"replica": "rp_" + secrets.token_hex(16), "account": self.account,
            "ackThrough": 0, "intents": [{"n": index + 1, "scope": "self/gym", "d": [row]} for index, row in enumerate(rows)]}, self.token, {"Sync-Schema": str(hello["schema"])})
        if len(result.get("results", [])) != len(rows) or any(item.get("kind", item.get("status", "")) == "refused" or "code" in item for item in result.get("results", [])):
            raise RuntimeError("The capture fixture sync write was refused: " + str([{key: item[key] for key in ("n", "code", "kind", "status") if key in item} for item in result.get("results", [])]))
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
        content = self.server.responses.pop(0) if self.server.responses else [
            {"type": "text", "text": "Your three training days are ready. Start with Push A, and keep the logged loads comfortable."}]
        stop_reason = "tool_use" if any(block["type"] == "tool_use" for block in content) else "end_turn"
        response = {"id": "msg_capture", "type": "message", "role": "assistant", "model": body.get("model", "fixture"),
                    "content": content, "stop_reason": stop_reason, "usage": {"input_tokens": 100, "output_tokens": 25}}
        if body.get("stream"):
            events = [{"type": "message_start", "message": {**response, "content": [], "stop_reason": None}}]
            for index, block in enumerate(content):
                if block["type"] == "text":
                    start = {"type": "text", "text": ""}
                    delta = {"type": "text_delta", "text": block["text"]}
                elif block["type"] == "tool_use":
                    start = {**block, "input": {}}
                    delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
                else:
                    raise ValueError("Capture model supports text and tool_use blocks.")
                events.extend([{"type": "content_block_start", "index": index, "content_block": start},
                               {"type": "content_block_delta", "index": index, "delta": delta},
                               {"type": "content_block_stop", "index": index}])
            events.extend([{"type": "message_delta", "delta": {"stop_reason": stop_reason}, "usage": {"output_tokens": 25}},
                           {"type": "message_stop"}])
            encoded = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()
            media = "text/event-stream"
        else:
            encoded, media = json.dumps(response).encode(), "application/json"
        self.send_response(200)
        self.send_header("Content-Type", media)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class Device:
    def __init__(self, sdk, port):
        self.adb = sdk / "platform-tools/adb"
        self.serial = f"emulator-{port}"

    def run(self, *arguments, **kwargs):
        return command([self.adb, "-s", self.serial, *arguments], **kwargs)

    def tree(self):
        self.run("shell", "rm", "-f", "/data/local/tmp/design-capture.xml")
        self.run("shell", "uiautomator", "dump", "/data/local/tmp/design-capture.xml")
        try:
            return ET.fromstring(self.run("exec-out", "cat", "/data/local/tmp/design-capture.xml", check=False))
        except ET.ParseError:
            return ET.Element("unavailable")

    def find(self, value, timeout=30):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            tree = self.tree()
            for node in tree.iter("node"):
                if value in (node.get("text"), node.get("content-desc")):
                    return node
            time.sleep(.2)
        (self.output / "failure-ui.xml").write_bytes(ET.tostring(tree))
        (self.output / "failure-ui.png").write_bytes(self.run("exec-out", "screencap", "-p"))
        raise RuntimeError(f"Capture state did not expose {value!r}.")

    def settle(self):
        previous = None
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            tree = self.tree()
            current = ET.tostring(tree)
            if tree.tag != "unavailable" and current == previous:
                return
            previous = current
        raise RuntimeError("The capture screen did not settle.")

    def tap(self, value):
        bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", self.find(value).get("bounds", ""))
        if not bounds:
            raise RuntimeError("Capture control has no bounds.")
        left, top, right, bottom = map(int, bounds.groups())
        self.run("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))

    def launch(self):
        return self.run("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity", "-a", "android.intent.action.VIEW")

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

    def steps(self, steps):
        for step in steps:
            if "tap" in step:
                self.tap(step["tap"])
            elif "wait" in step:
                self.find(step["wait"])
            elif "text" in step:
                self.run("shell", "input", "text", step["text"].replace(" ", "%s"))
            elif "key" in step:
                self.run("shell", "input", "keyevent", step["key"])
            elif "swipe" in step:
                self.run("shell", "input", "swipe", *map(str, step["swipe"]))
            else:
                raise ValueError("Unknown capture step.")


def start_emulator(sdk, output, port, stack):
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
    device = Device(sdk, port)
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
    parser.add_argument("--emulator-port", type=int, default=5580)
    parser.add_argument("--scenarios", type=Path, help="JSON array of board/name/account/steps; each recipe is replayed after appearance switches.")
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
    ports = (args.backend_port, args.model_port, args.emulator_port, args.emulator_port + 1)
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
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False, mode=0o700)
    android = ROOT / "apps/android"
    scenarios = json.loads(args.scenarios.read_text()) if args.scenarios else SCENARIOS
    try:
        validate_scenarios(scenarios)
    except ValueError as error:
        parser.error(str(error))
    manifest = {"apiOrigin": app_origin, "source": command(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
                "sourceDirty": bool(command(["git", "status", "--porcelain"], cwd=ROOT)),
                "baseline": args.baseline, "captures": [], "failures": []}
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
        backend_log = stack.enter_context((args.output / "backend.log").open("wb"))
        safe_env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ") if key in os.environ}
        backend = subprocess.Popen([str(args.backend_binary.resolve())], cwd=ROOT / "backend", env={**safe_env,
            "DATABASE_URL": database_url, "PORT": str(args.backend_port), "ANTHROPIC_API_KEY": "local-capture-only",
            "ANTHROPIC_BASE_URL": model_origin, "COACH_ANTHROPIC_BASE_URL": model_origin,
            "WINDMILL_ALLOWED_ORIGINS": "http://localhost:5173"}, stdout=backend_log, stderr=subprocess.STDOUT)
        stack.callback(stop, backend)
        fixture = Fixture(origin, database_url)
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
        fixture.seed()
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
        device = start_emulator(args.sdk, args.output, args.emulator_port, stack)
        device.run("install", apk)
        manifest["sdk"] = int(device.run("shell", "getprop", "ro.build.version.sdk"))
        for account in ("empty", "fixture"):
            for mode, value in (("dark", "yes"), ("light", "no")):
                device.run("shell", "pm", "clear", PACKAGE)
                device.run("shell", "pm", "grant", PACKAGE, "android.permission.POST_NOTIFICATIONS")
                device.run("shell", "cmd", "uimode", "night", value)
                device.launch()
                if account == "fixture":
                    device.sign_in(fixture.link())
                    device.find("Push A")
                for scenario in [item for item in scenarios if item["account"] == account]:
                    model.responses = json.loads(json.dumps(scenario.get("responses", [])).replace("$routine0", fixture.routines[0]))
                    manifest["step"] = f"{scenario['board']}-{scenario['name']}-{mode}"
                    device.steps(scenario["steps"])
                    device.settle()
                    if model.responses:
                        raise RuntimeError("The capture did not consume its deterministic model responses.")
                    filename = f"{scenario['board']}-{scenario['name']}-{mode}.png"
                    (args.output / filename).write_bytes(device.run("exec-out", "screencap", "-p"))
                    manifest["captures"].append({"board": scenario["board"], "mode": mode, "file": filename})
        manifest["modelCalls"] = model.calls
        manifest["step"] = "cold-start"
        device.tap("Routines")
        device.run("shell", "run-as", PACKAGE, "touch", "files/design-capture-profile")
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
        (args.output / "workout-idle.trace").write_bytes(device.run("exec-out", "cat", trace))
        (args.output / "workout-cpu.txt").write_bytes(device.run("shell", "dumpsys", "cpuinfo"))
        logcat = device.run("logcat", "-d", "-v", "brief", "ActivityManager:I", "AndroidRuntime:E", "*:S").decode(errors="replace")
        manifest["anr"] = "ANR in " + PACKAGE in logcat or "FATAL EXCEPTION" in logcat
        (args.output / "capture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        events = fixture.sql("SELECT COALESCE(json_agg(json_build_object('name',name,'props',props) ORDER BY id),'[]'::json) FROM events;")
        (args.output / "events.json").write_text(events + "\n")
        manifest["performanceAccepted"] = manifest["coldStartToRoutinesMs"] < 3000
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        if not manifest["performanceAccepted"] and not args.baseline:
            raise RuntimeError("Cold start exceeded the 3000ms budget; see capture-manifest.json.")
        if entry_failure:
            raise RuntimeError(entry_failure)
        if manifest["anr"]:
            raise RuntimeError("The native capture run reported an ANR or fatal exception.")
        if args.acceptance_pause_seconds:
            print(json.dumps({"acceptanceReady": True, "serial": device.serial, "localDatabase": database_url,
                              "seconds": args.acceptance_pause_seconds}), flush=True)
            time.sleep(args.acceptance_pause_seconds)
        events = fixture.sql("SELECT COALESCE(json_agg(json_build_object('name',name,'props',props) ORDER BY id),'[]'::json) FROM events;")
        (args.output / "events.json").write_text(events + "\n")
        manifest["step"] = "complete"
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps({"output": str(args.output), "captures": len(manifest["captures"]),
                          "coldStartToRoutinesMs": manifest["coldStartToRoutinesMs"]}))


if __name__ == "__main__":
    main()
