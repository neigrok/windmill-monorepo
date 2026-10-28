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
    def test_transient_frame_delay_is_explicit_and_bounded(self):
        scenario = {"board": "03.11", "name": "rack-changed", "account": "fixture", "settle": False}
        for delay in [0, 180, 1000]:
            capture.validate_scenarios([{**scenario, "frame_delay_ms": delay}])
        for delay in [-1, 1001, 1.5, True, "180"]:
            with self.subTest(delay=delay), self.assertRaises(ValueError):
                capture.validate_scenarios([{**scenario, "frame_delay_ms": delay}])
        for settle in [True, None]:
            with self.subTest(settle=settle), self.assertRaises(ValueError):
                capture.validate_scenarios([{**scenario, "settle": settle, "frame_delay_ms": 180}])

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

    def test_history_rejects_unbounded_dates_indices_and_nonfinite_loads_before_seeding(self):
        workout = {"routine": 0, "daysAgo": 1, "minutesAgo": 0, "weightKg": -5.25, "reps": 8}
        fixture = {"exercises": [], "routines": [{"name": "Push A", "entries": [{"exerciseId": "bench-press"}]}],
                   "history": [workout]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.json"
            path.write_text(json.dumps(fixture))
            self.assertEqual(fixture, capture.read_fixture(path))
            for count in [1, 3, 20]:
                explicit = {**fixture, "history": [{**workout, "setsPerMovement": count}]}
                path.write_text(json.dumps(explicit))
                self.assertEqual(explicit, capture.read_fixture(path))
            pair = {**fixture, "routines": [{"name": "Push A", "entries": [{"exerciseId": "bench-press"}, {"exerciseId": "overhead-press"}]}],
                    "history": [{**workout, "setsPerMovement": 10}]}
            path.write_text(json.dumps(pair))
            self.assertEqual(pair, capture.read_fixture(path))
            for movements, count in [(2, 11), (7, None)]:
                over = {**fixture, "routines": [{"name": "Push A", "entries": [{"exerciseId": "bench-press"}] * movements}],
                        "history": [workout if count is None else {**workout, "setsPerMovement": count}]}
                path.write_text(json.dumps(over))
                with self.subTest(movements=movements, count=count), self.assertRaises(ValueError):
                    capture.read_fixture(path)
            invalid = [[], [workout] * 41, [{**workout, "extra": 1}]]
            for key, values in {"routine": [-1, 1, 0.5, True], "daysAgo": [-1, 3651, 1.5, True],
                                "minutesAgo": [-1, 1440, 1.5, True], "weightKg": [-500.01, 500.01, .001, float("nan"), float("inf"), True],
                                "reps": [0, 501, 1.5, True], "setsPerMovement": [0, 21, 1.5, True, None, "1"]}.items():
                invalid.extend([[{**workout, key: value}] for value in values])
            invalid.append([{**workout, "daysAgo": 0, "minutesAgo": 39}])
            for history in invalid:
                path.write_text(json.dumps({**fixture, "history": history}))
                with self.subTest(history=history), self.assertRaises(ValueError):
                    capture.read_fixture(path)

    def test_history_imports_exact_past_workouts_through_the_supported_mcp_door(self):
        imports = []
        class LocalFixture(capture.Fixture):
            def sql(self, query):
                return ""

            def request(self, path, body=None, token=None, headers=None):
                replies = {"/v1/mcp-keys": {"token": "fixture-only"}, "/mcp": {},
                           "/v1/gym/exercises": [{"id": "bench-press", "name": "Bench Press"}],
                           "/v1/sync/hello": {"schema": 9}, "/v1/gym/bodyweight": {"entries": [None] * 6},
                           "/v1/gym/notes": {"notes": [None] * 2}}
                return {"Mcp-Session-Id": "fixture-session"}, replies[path]

            def mcp(self, name, arguments):
                if name == "gym_import_session":
                    imports.append(arguments)

            def push(self, rows, schema):
                pass

        fixture = LocalFixture("http://127.0.0.1:8104", "unused")
        fixture.now = 1800000000000
        program = {"exercises": [], "routines": [{"name": "Push A", "entries": [{"exerciseId": "bench-press"}]}],
                   "history": [{"routine": 0, "daysAgo": 2, "minutesAgo": 60, "weightKg": -5.25, "reps": 8, "setsPerMovement": 1},
                               {"routine": 0, "daysAgo": 0, "minutesAgo": 40, "weightKg": 20, "reps": 10}]}
        fixture.seed(program)
        prefix = "capture" + fixture.account.replace("-", "")[:12]
        expected = []
        for index, workout in enumerate(program["history"]):
            started = fixture.now - workout["daysAgo"] * 86400000 - workout["minutesAgo"] * 60000
            expected.append({"id": "ses_" + prefix + str(index), "startedAt": started, "finishedAt": started + 2400000,
                             "routineId": "rt_" + prefix + "0", "sets": [
                                 {"id": f"set_{prefix}{index}_0_{number}", "exerciseId": "bench-press",
                                  "weightKg": workout["weightKg"], "reps": workout["reps"],
                                  "completedAt": started + (number + 1) * 120000} for number in range(workout.get("setsPerMovement", 3))]})
        self.assertEqual(expected, imports)
        self.assertEqual([1, 3], [len(item["sets"]) for item in imports])
        imports.clear()
        fixture.seed({key: value for key, value in program.items() if key != "history"})
        self.assertEqual([(fixture.now - (28 - index * 2) * 86400000, 30 + index * 2.5, 8)
                          for index in range(12)], [(item["startedAt"], item["sets"][0]["weightKg"], item["sets"][0]["reps"]) for item in imports])
        self.assertEqual([3] * 12, [len(item["sets"]) for item in imports])
        imports.clear()
        maximum = {"routine": 0, "daysAgo": 0, "minutesAgo": 40, "weightKg": 50, "reps": 8, "setsPerMovement": 20}
        fixture.seed({**program, "history": [maximum]})
        started = fixture.now - 2400000
        self.assertEqual([{"id": "ses_" + prefix + "0", "startedAt": started, "finishedAt": fixture.now,
                           "routineId": "rt_" + prefix + "0", "sets": [
                               {"id": f"set_{prefix}0_0_{number}", "exerciseId": "bench-press", "weightKg": 50, "reps": 8,
                                "completedAt": started + (number + 1) * 120000} for number in range(20)]}], imports)
        self.assertEqual(imports[0]["finishedAt"], imports[0]["sets"][-1]["completedAt"])

    def test_default_history_encloses_every_set_in_short_and_long_routines(self):
        calls = []
        class RecordedFixture(capture.Fixture):
            def sql(self, query):
                return ""

            def mcp(self, name, arguments):
                calls.append((name, arguments))
                return {}

            def push(self, rows, schema):
                pass

            def request(self, path, body=None, token=None, headers=None):
                replies = {
                    "/v1/mcp-keys": ({}, {"token": "local"}),
                    "/mcp": ({"Mcp-Session-Id": "local"}, {}),
                    "/v1/gym/exercises": ({}, [{"id": f"exercise-{index}"} for index in range(10)]),
                    "/v1/sync/hello": ({}, {"schema": 9}),
                    "/v1/gym/bodyweight": ({}, {"entries": [None] * 6}),
                    "/v1/gym/notes": ({}, {"notes": [None] * 2}),
                }
                return replies[path]

        for movements in (2, 10):
            with self.subTest(movements=movements):
                calls.clear()
                fixture = RecordedFixture("http://127.0.0.1:8098", "unused")
                fixture.seed({"exercises": [], "routines": [{"name": "Walk", "entries": [
                    {"exerciseId": f"exercise-{index}"} for index in range(movements)]}]})
                sessions = [value for name, value in calls if name == "gym_import_session"]
                expected = []
                for index in range(12):
                    start = fixture.now - (28 - index * 2) * 86400000
                    expected.append((start, start + (2400000 if movements == 2 else 3720000),
                                     [start + number * 120000 for number in range(1, movements * 3 + 1)]))
                self.assertEqual(expected, [(session["startedAt"], session["finishedAt"],
                                           [row["completedAt"] for row in session["sets"]]) for session in sessions])
                self.assertTrue(all(session["startedAt"] <= row["completedAt"] <= session["finishedAt"]
                                    for session in sessions for row in session["sets"]))


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

    def test_row_touch_uses_only_the_nearest_clickable_ancestor(self):
        device = capture.Device(Path("/android-sdk"), 5582)
        tree = capture.ET.fromstring('<node clickable="true" bounds="[0,0][400,800]"><node clickable="true" bounds="[20,80][380,160]"><node clickable="false" text="Cable Fly" bounds="[80,96][180,120]" /></node><node text="Orphan" bounds="[10,10][20,20]" /></node>')
        device.tree = lambda: tree
        calls = []
        device.run = lambda *args, **kwargs: calls.append(args)
        device.touch({"phase": "down", "target": "Cable Fly", "row": True, "at": [.9, .5]})
        device.touch({"phase": "move", "at": [.15, .5]})
        device.release_touch()
        device.touch({"phase": "down", "target": "Cable Fly", "at": [.9, .5]})
        device.release_touch()
        self.assertEqual([
            ("shell", "input", "motionevent", "DOWN", "344", "120"),
            ("shell", "input", "motionevent", "MOVE", "74", "120"),
            ("shell", "input", "motionevent", "UP", "74", "120"),
            ("shell", "input", "motionevent", "DOWN", "170", "108"),
            ("shell", "input", "motionevent", "UP", "170", "108"),
        ], calls)
        tree.set("clickable", "false")
        with self.assertRaisesRegex(RuntimeError, "no clickable ancestor"):
            device.touch({"phase": "down", "target": "Orphan", "row": True})
        with self.assertRaises(ValueError):
            device.touch({"phase": "down", "target": "Cable Fly", "row": "true"})

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

    def test_workout_settlement_preserves_numeric_input_other_packages_and_clock_layout(self):
        def tree(clock, load="82.5", bounds="[0,0][100,40]", other="Workout time, 0:01"):
            root = ET.Element("hierarchy")
            for name in ("Workout time", "Since start", "Since last set"):
                ET.SubElement(root, "node", {"package": capture.PACKAGE, "content-desc": name + ", " + clock, "bounds": bounds})
            ET.SubElement(root, "node", {"package": capture.PACKAGE, "content-desc": "Load, kg", "text": load})
            ET.SubElement(root, "node", {"package": "other.app", "content-desc": other})
            return root
        class Screens(capture.Device):
            def __init__(self, trees):
                self.trees = iter(trees)
                self.calls = 0
            def tree(self):
                self.calls += 1
                return next(self.trees)
        raw = tree("0:02")
        device = Screens([tree("0:01"), raw])
        self.assertIs(raw, device.settle(workout_clock=True))
        self.assertEqual(["Workout time, 0:02", "Since start, 0:02", "Since last set, 0:02"],
                         [node.get("content-desc") for node in raw[:3]])
        for changed in (tree("0:02", load="85"), tree("0:02", bounds="[0,0][101,40]"),
                        tree("0:02", other="Workout time, 0:02"), tree("0:02", other="Weight, 0:02")):
            later = ET.fromstring(ET.tostring(changed))
            for node in later[:3]:
                node.set("content-desc", node.get("content-desc").replace("0:02", "0:03"))
            device = Screens([tree("0:01"), changed, later])
            self.assertIs(later, device.settle(workout_clock=True))
            self.assertEqual(3, device.calls)
        changed = tree("0:02")
        changed[0].set("content-desc", "Workout time, invalid")
        device = Screens([tree("0:01"), changed, changed])
        self.assertIs(changed, device.settle(workout_clock=True))
        self.assertEqual(3, device.calls)

    def test_quick_settings_expansion_rechecks_the_native_panel_and_bounds_failure(self):
        class Panels(capture.Device):
            def __init__(self, ready_after):
                self.ready_after = ready_after
                self.calls = []
            def run(self, *args):
                self.calls.append(args)
            def settle(self, **kwargs):
                root = ET.Element("hierarchy")
                ET.SubElement(root, "node", {"content-desc": "Edit order of Quick Settings.",
                    "visible-to-user": "true" if len(self.calls) >= self.ready_after else "false"})
                return root
        device = Panels(2)
        device.quick_settings()
        self.assertEqual([("shell", "cmd", "statusbar", "expand-settings")] * 2, device.calls)
        device = Panels(4)
        with self.assertRaisesRegex(RuntimeError, "did not expand"):
            device.quick_settings()
        self.assertEqual(3, len(device.calls))

    def test_tap_waits_for_the_controls_bounds_instead_of_using_an_animation_frame(self):
        class MovingControl(capture.Device):
            def __init__(self):
                self.positions = iter(["[0,0][100,100]", "[20,80][120,180]", "[20,80][120,180]"])
                self.calls = []
            def find(self, value, timeout=30):
                return ET.Element("node", {"bounds": next(self.positions)})
            def run(self, *args):
                self.calls.append(args)
        device = MovingControl()
        device.tap("Start workout")
        self.assertEqual([("shell", "input", "tap", "70", "130")], device.calls)

    def test_find_waits_for_visible_native_content_after_a_transition(self):
        class Screens(capture.Device):
            def __init__(self):
                self.calls = 0
            def tree(self):
                self.calls += 1
                root = ET.Element("hierarchy")
                ET.SubElement(root, "node", {"text": "Workout", "visible-to-user": "false", "bounds": "[0,0][0,0]"})
                if self.calls > 1:
                    ET.SubElement(root, "node", {"text": "Workout", "visible-to-user": "true", "bounds": "[0,0][100,100]"})
                return root
        device = Screens()
        self.assertEqual("[0,0][100,100]", device.find("Workout").get("bounds"))
        self.assertEqual(2, device.calls)

    def test_tile_settlement_preserves_other_tiles_names_and_layout_changes(self):
        def tree(clock, title="Push A", bounds="[0,0][100,100]", other="00:01"):
            root = ET.Element("hierarchy")
            tile = ET.SubElement(root, "node", {"resource-id": "com.android.systemui:id/qs_tile_large",
                "package": "com.android.systemui", "state-desc": ", " + title + " · " + clock, "bounds": bounds})
            ET.SubElement(tile, "node", {"text": "Workout"})
            other_tile = ET.SubElement(root, "node", {"resource-id": "com.android.systemui:id/qs_tile_large",
                "package": "com.android.systemui", "state-desc": ", Timer · " + other})
            ET.SubElement(other_tile, "node", {"text": "Timer"})
            return root
        class Screens(capture.Device):
            def __init__(self, trees):
                self.trees = iter(trees)
                self.calls = 0
            def tree(self):
                self.calls += 1
                return next(self.trees)
        for changed in (tree("00:02", title="Pull A"), tree("00:02", bounds="[0,0][101,100]"),
                        tree("00:02", other="00:02")):
            later = ET.fromstring(ET.tostring(changed))
            later[0].set("state-desc", later[0].get("state-desc").replace("00:02", "00:03"))
            device = Screens([tree("00:01"), changed, later])
            self.assertIs(later, device.settle(tile_clock=True))
            self.assertEqual(3, device.calls)
        first, later = tree("00:01"), tree("00:02")
        device = Screens([first, later])
        self.assertIs(later, device.settle(tile_clock=True))
        self.assertEqual(", Push A · 00:02", later[0].get("state-desc"))
        first[0].set("state-desc", ", Off")
        device = Screens([first, later, tree("00:03")])
        device.settle(tile_clock=True)
        self.assertEqual(3, device.calls)

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
