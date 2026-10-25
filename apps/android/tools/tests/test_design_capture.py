import importlib.util
from pathlib import Path
import tempfile
import json
import threading
import urllib.request
import unittest


spec = importlib.util.spec_from_file_location("design_capture", Path(__file__).parents[1] / "design_capture.py")
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class DesignCaptureTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
