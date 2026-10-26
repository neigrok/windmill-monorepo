import importlib.util
from pathlib import Path
import tempfile
import json
import threading
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
import unittest


spec = importlib.util.spec_from_file_location("design_capture", Path(__file__).parents[1] / "design_capture.py")
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class DesignCaptureTests(unittest.TestCase):
    def test_optional_fixture_retains_explicit_targets_and_rejects_other_configuration(self):
        self.assertIsNone(capture.read_fixture(None))
        fixture = {"exercises": [{"id": "ex_cafe0801", "name": "Landmine Press", "pattern": "press", "equipment": "barbell"}],
                   "routines": [{"name": "Push A", "entries": [
                       {"exerciseId": "ex_cafe0801", "sets": [{"reps": 10, "weightKg": 20}], "restSeconds": 120},
                       {"exerciseId": "pull-up", "sets": [{"reps": 8, "weightKg": -10}]}]}]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.json"
            path.write_text(json.dumps(fixture))
            self.assertEqual(fixture, capture.read_fixture(path))
            for invalid in ({"origin": "https://example.com", **fixture}, {"exercises": [], "routines": []},
                            {"exercises": [{}], "routines": fixture["routines"]},
                            {"exercises": [], "routines": [{"name": "Push A", "entries": ["bench-press"]}]}):
                path.write_text(json.dumps(invalid))
                with self.subTest(fixture=invalid), self.assertRaises(ValueError):
                    capture.read_fixture(path)

    def test_fixture_push_retains_identity_and_advances_only_acknowledged_prefixes(self):
        requests = []
        class PushHandler(capture.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(body)
                accepted = body["intents"][:1]
                reply = {"as": body["account"], "lastN": accepted[-1]["n"],
                         "results": [{"n": intent["n"], "s": "ok", "seq": intent["n"]} for intent in accepted]}
                if len(body["intents"]) > 1:
                    reply["retry"] = {"n": body["intents"][1]["n"], "retryAfterMs": 0}
                encoded = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        server = capture.ThreadingHTTPServer(("127.0.0.1", 0), PushHandler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            fixture = capture.Fixture(f"http://127.0.0.1:{server.server_port}", "unused")
            rows = [{"t": "note", "id": f"note_{index}", "f": {"title": [f"Fixture {index}", "1:0:r_fixture0000"]}} for index in range(3)]
            fixture.push(rows, 1)
            replica = requests[0]["replica"]
            intents = [{"n": index + 1, "scope": "self/gym", "d": [row]} for index, row in enumerate(rows)]
            self.assertEqual([
                {"replica": replica, "account": fixture.account, "ackThrough": 0, "intents": intents},
                {"replica": replica, "account": fixture.account, "ackThrough": 1, "intents": intents[1:]},
                {"replica": replica, "account": fixture.account, "ackThrough": 2, "intents": intents[2:]},
            ], requests)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_fixture_push_refuses_invalid_results_and_bounds_zero_progress(self):
        requests = []
        reply_mode = "refused"
        class PushHandler(capture.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append(body)
                reply = {"as": body["account"], "lastN": 0, "results": [], "retry": {"n": 1, "retryAfterMs": 0}}
                if reply_mode == "refused":
                    reply = {"as": body["account"], "lastN": 1, "results": [{"n": 1, "s": "refused", "code": "invalid"}]}
                elif reply_mode == "gap":
                    reply = {"as": body["account"], "lastN": 2, "results": [{"n": 2, "s": "ok", "seq": 1}]}
                elif reply_mode == "malformed":
                    reply = {"as": body["account"], "lastN": 1, "results": [{"n": 1, "s": "ok"}]}
                encoded = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        server = capture.ThreadingHTTPServer(("127.0.0.1", 0), PushHandler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            fixture = capture.Fixture(f"http://127.0.0.1:{server.server_port}", "unused")
            rows = [{"t": "note", "id": "note_fixture"}]
            for reply_mode, count, message in [("refused", 1, "was refused"), ("gap", 1, "noncontiguous"),
                                               ("malformed", 1, "malformed sync result"), ("no-progress", 20, "20 attempts")]:
                requests.clear()
                with self.subTest(reply=reply_mode), self.assertRaisesRegex(RuntimeError, message):
                    fixture.push(rows, 1)
                self.assertEqual(count, len(requests))
                self.assertTrue(all(request == requests[0] for request in requests))
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_touches_use_observed_bounds_and_always_release(self):
        device = capture.Device(Path("/android-sdk"), 5582)
        calls = []
        device.run = lambda *args, **kwargs: calls.append(args)
        device.find = lambda value: capture.ET.fromstring('<node bounds="[40,80][360,136]" />')
        with self.assertRaises(ValueError):
            device.touch({"phase": "move", "at": [.2, .5]})
        try:
            device.touch({"phase": "down", "target": "Pressed stepper", "at": [.925, .5]})
            device.touch({"phase": "move", "at": [.1, .5]})
            with self.assertRaises(ValueError):
                device.touch({"phase": "move", "at": [2, .5]})
        finally:
            device.release_touch()
        device.release_touch()
        self.assertEqual([
            ("shell", "input", "motionevent", "DOWN", "336", "108"),
            ("shell", "input", "motionevent", "MOVE", "72", "108"),
            ("shell", "input", "motionevent", "UP", "72", "108"),
        ], calls)
        self.assertIsNone(device.touch_bounds)
        self.assertIsNone(device.touch_point)

    def test_specimen_viewport_is_bounded_and_resets_size_and_density(self):
        device = capture.Device(Path("/android-sdk"), 5582)
        calls = []
        device.run = lambda *args, **kwargs: calls.append(args)
        for value in ({"width": 0, "height": 426, "density": 160},
                      {"width": 1460, "height": 426, "density": 0},
                      {"width": "1460", "height": 426, "density": 160},
                      {"width": 840, "height": 1828, "density": 420, "fontScale": 3}):
            with self.assertRaises(ValueError):
                device.viewport(value)
        self.assertEqual([], calls)
        device.viewport({"width": 1460, "height": 426, "density": 160})
        device.viewport()
        self.assertEqual([
            ("shell", "wm", "size", "1460x426"), ("shell", "wm", "density", "160"),
            ("shell", "settings", "put", "system", "font_scale", "1"),
            ("shell", "wm", "size", "reset"), ("shell", "wm", "density", "reset"),
            ("shell", "settings", "put", "system", "font_scale", "1"),
        ], calls)

    def test_recipes_accept_canonical_board_ids_and_reject_unsafe_output_names(self):
        for board in ("02.7", "08.21", "15a", "15b", "15c", "27a", "27g", "A4"):
            capture.validate_scenarios([{"board": board, "name": "signed-in", "account": "fixture"}])
        for field, value in (("board", "../02.7"), ("board", "15a/extra"), ("board", "A4.png"),
                             ("board", "15 a"), ("board", "15a\n"), ("board", ""),
                             ("name", "../capture"), ("name", "Capture"), ("account", "production")):
            scenario = {"board": "02.7", "name": "signed-in", "account": "fixture", field: value}
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                capture.validate_scenarios([scenario])

    def test_origins_refuse_production_redirect_shapes_credentials_and_paths(self):
        for origin in ("", "https://windmill.works", "http://windmill.works:8098", "http://127.0.0.1:80",
                       "http://local.example:8098", "http://user@127.0.0.1:8098", "http://127.0.0.1:8098/proxy",
                       "http://127.0.0.1:8098?target=production", "http://127.0.0.1:8098#production"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                capture.local_origin(origin, emulator=True)
        self.assertEqual("http://10.0.2.2:8098", capture.local_origin("http://10.0.2.2:8098/", emulator=True))
        with self.assertRaises(ValueError):
            capture.local_origin("http://10.0.2.2:8098")

    def test_generated_origin_must_match_before_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            android = Path(temporary)
            config = android / "app/build/generated/source/buildConfig/debug/works/windmill/app/BuildConfig.java"
            config.parent.mkdir(parents=True)
            for encoded in ('""', '"https://windmill.works"', '"http://10.0.2.2:8088"'):
                config.write_text("public static final String WM_API_BASE_URL = " + encoded + ";")
                with self.assertRaises(RuntimeError):
                    capture.checked_build_config(android, "http://10.0.2.2:8098")
            config.write_text('public static final String WM_API_BASE_URL = "http://10.0.2.2:8098";')
            capture.checked_build_config(android, "http://10.0.2.2:8098")

    def test_profile_waits_for_delayed_complete_bytes_and_refuses_empty_or_partial_files(self):
        class TraceDevice(capture.Device):
            def __init__(self, replies):
                self.replies = iter(replies)
                self.calls = []
            def run(self, *arguments, **kwargs):
                self.calls.append((arguments, kwargs))
                return next(self.replies, b"")
        trace = b"*version\n3\n*end\nSLOW-complete-records"
        device = TraceDevice([b"", b"", trace[:10], trace, trace])
        self.assertEqual(trace, device.profile("trace", timeout=1, poll_seconds=0))
        self.assertEqual([(("exec-out", "cat", "trace"), {"check": False})] * 5, device.calls)
        for pending in (b"", b"*version\n3"):
            with self.subTest(pending=pending), self.assertRaisesRegex(RuntimeError, "did not finish writing"):
                TraceDevice([pending] * 50).profile("trace", timeout=.01, poll_seconds=.001)

    def test_notification_settlement_ignores_only_system_chronometer_values(self):
        def tree(clock, body="30 kg × 8", bounds="[0,0][100,100]", other="02:10"):
            root = ET.Element("hierarchy")
            ET.SubElement(root, "node", {"resource-id": "android:id/chronometer", "package": "com.android.systemui",
                "class": "android.widget.Chronometer", "text": clock, "content-desc": clock, "bounds": "[0,0][40,20]"})
            ET.SubElement(root, "node", {"text": body, "bounds": bounds})
            ET.SubElement(root, "node", {"resource-id": "android:id/chronometer", "class": "android.widget.TextView", "text": other})
            return root
        class Screens(capture.Device):
            def __init__(self, trees):
                self.trees = iter(trees)
                self.calls = 0
            def tree(self):
                self.calls += 1
                return next(self.trees)
        for changed in (tree("00:02", body="35 kg × 8"), tree("00:02", bounds="[0,0][101,100]"),
                        tree("00:02", other="02:11")):
            later = ET.fromstring(ET.tostring(changed))
            later[0].set("text", "00:03")
            device = Screens([tree("00:01"), changed, later])
            self.assertEqual(ET.tostring(later), ET.tostring(device.settle(notification_clock=True)))
            self.assertEqual(3, device.calls)
        raw = tree("00:02")
        device = Screens([tree("00:01"), raw])
        self.assertIs(raw, device.settle(notification_clock=True))
        self.assertEqual("00:02", raw[0].get("text"))
        self.assertEqual("00:02", raw[0].get("content-desc"))

    def test_model_fixture_serves_exact_tool_and_text_streams(self):
        server = capture.ThreadingHTTPServer(("127.0.0.1", 0), capture.ModelFixture)
        tool = {"type": "tool_use", "id": "tool_capture", "name": "gym_get_routines", "input": {}}
        answer = {"type": "text", "text": "Your three training days are ready."}
        server.responses = [[tool], [answer]]
        server.calls = 0
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            for block, reason in ((tool, "tool_use"), (answer, "end_turn")):
                request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/v1/messages",
                    json.dumps({"model": "fixture", "stream": True}).encode(), {"Content-Type": "application/json"})
                with urllib.request.urlopen(request) as response:
                    events = [json.loads(line[6:]) for line in response.read().decode().splitlines() if line.startswith("data: ")]
                start = {**block, "input": {}} if block["type"] == "tool_use" else {"type": "text", "text": ""}
                delta = {"type": "input_json_delta", "partial_json": "{}"} if block["type"] == "tool_use" else {"type": "text_delta", "text": block["text"]}
                self.assertEqual([
                    {"type": "message_start", "message": {"id": "msg_capture", "type": "message", "role": "assistant", "model": "fixture",
                        "content": [], "stop_reason": None, "usage": {"input_tokens": 100, "output_tokens": 25}}},
                    {"type": "content_block_start", "index": 0, "content_block": start},
                    {"type": "content_block_delta", "index": 0, "delta": delta},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": reason}, "usage": {"output_tokens": 25}},
                    {"type": "message_stop"},
                ], events)
            self.assertEqual([], server.responses)
            self.assertEqual(2, server.calls)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_mail_fixture_acknowledges_only_the_local_code_envelope(self):
        server = capture.ThreadingHTTPServer(("127.0.0.1", 0), capture.MailFixture)
        server.code, server.calls = None, 0
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        body = {"from": "Windmill <capture@example.test>", "to": "lifter@example.com",
                "template": {"id": "magic-code", "variables": {"sign_in_code": "123456"}}}
        try:
            for path, credential, payload in (("/other", "local-capture-only", body),
                    ("/emails", "wrong-key", body), ("/emails", "local-capture-only", {"template": {}})):
                request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}" + path,
                    json.dumps(payload).encode(), {"Authorization": "Bearer " + credential})
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    client.open(request)
                self.assertEqual(400, caught.exception.code)
            self.assertEqual((None, 0), (server.code, server.calls))
            request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/emails",
                json.dumps(body).encode(), {"Authorization": "Bearer local-capture-only"})
            with client.open(request) as response:
                self.assertEqual((200, {"id": "capture-mail"}), (response.status, json.load(response)))
            self.assertEqual(("123456", 1), (server.code, server.calls))
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_auth_code_input_uses_stdin_and_wrong_intent_cannot_use_the_delivered_code(self):
        calls = []
        class Device(capture.Device):
            def tap(self, value): calls.append(("tap", value))
            def run(self, *arguments, **kwargs): calls.append((arguments, kwargs))
        device = Device(Path("/unused"), 5584, auth_code=lambda: "246810")
        device.steps([{"auth_code": "wrong"}, {"auth_code": "valid"}])
        expected = []
        for code in ("135791", "246810"):
            expected.extend([("tap", "Code field"),
                (("shell", "input", "keyevent", "KEYCODE_MOVE_END", *(["KEYCODE_DEL"] * 6)), {}),
                (("shell", "-T", "sh"), {"input": f"input text {code}\n".encode()})])
        self.assertEqual(expected, calls)
        calls.clear()
        for code in (None, "12345", "123456; echo secret"):
            device.auth_code = lambda: code
            with self.assertRaises(ValueError):
                device.steps([{"auth_code": "valid"}])
        self.assertEqual([], calls)

    def test_settlement_tolerates_only_the_bounded_resend_countdown(self):
        states = ["Resend in 20s", "Resend in 19s"]
        class Device(capture.Device):
            def tree(self):
                return ET.fromstring('<hierarchy><node text="' + states.pop(0) + '" bounds="[0,0][30,30]"/></hierarchy>')
        Device(Path("/unused"), 5584).settle(resend_countdown=True)
        self.assertEqual([], states)


if __name__ == "__main__":
    unittest.main()
