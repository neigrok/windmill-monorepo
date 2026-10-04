import argparse
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.dont_write_bytecode = True
from journal_write_differential import JournalDifferential


class JournalComparisonTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.diff = JournalDifferential(argparse.Namespace(mode="off-vs-on"), Path(self.directory.name))

    def response(self, body, **headers):
        return 200, {"content-length": str(len(body)), **headers}, body

    def test_preserves_every_body_byte(self):
        for left, right in ((b'{"updatedAt":1}', b'{"updatedAt":2}'),
                            (b'{"body":"a","day":"b"}', b'{"day":"b","body":"a"}'),
                            (b'{"mood":0}', b'{"mood":0.0}'),
                            (b'{"pages":[1,2]}', b'{"pages":[2,1]}'),
                            (b'{"pages":[{"day":"2026-09-03"}]}', b'{"pages":[{"day":"2026-09-01"}]}')):
            for mode in ("off-vs-on", "main-vs-off"):
                self.diff.args.mode = mode
                with self.subTest(mode=mode, left=left, right=right), self.assertRaises(AssertionError):
                    self.diff.compare([self.response(left), self.response(right)], "regression")

    def test_ignores_only_transport_clock_and_connection_headers(self):
        self.diff.compare([self.response(b'{}', date="one", connection="close"),
                           self.response(b'{}', date="two", connection="keep-alive")], "transport")
        with self.assertRaises(AssertionError):
            self.diff.compare([self.response(b'{}', etag="one"), self.response(b'{}', etag="two")], "etag")

    def test_checks_each_content_length(self):
        with self.assertRaises(AssertionError):
            self.diff.compare([(200, {"content-length": "3"}, b'{}')] * 2, "framing")

    def test_switches_are_deterministic_on_both_real_servers(self):
        for side in range(2):
            environment = self.diff.environment(side, "postgresql:///test", 18950 + side)
            self.assertEqual(environment["JOURNAL_ENGINE_WRITES"], str(side))
            for name in ("JOURNAL_WRITE_FREEZE", "GYM_ENGINE_WRITES", "GYM_WRITE_FREEZE", "LEGACY_REST_WRITES_RETIRED"):
                self.assertEqual(environment[name], "0")
            self.assertEqual(environment["WM_TEST_CLOCK_FILE"], str(self.diff.clock_file))
            for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "JOURNAL_EMBEDDER_URL"):
                self.assertEqual(environment[name], "")
        self.diff.frozen = True
        self.assertEqual(self.diff.environment(1, "postgresql:///test", 18951)["JOURNAL_WRITE_FREEZE"], "1")

    def test_main_comparison_launches_baseline_and_keeps_both_switches_off(self):
        self.diff.args = argparse.Namespace(mode="main-vs-off", image=None, bin_dir=Path("/build"))
        self.diff.main_binary = Path("/main-build/windmill_server")
        response = MagicMock(status=401)
        connection = MagicMock()
        connection.getresponse.return_value = response
        with patch.dict("os.environ", {"LEGACY_REST_WRITES_RETIRED": "1"}), \
                patch("journal_write_differential.http.client.HTTPConnection", return_value=connection), \
                patch("journal_write_differential.subprocess.Popen") as launch:
            for side in range(2):
                self.diff.start(side, "postgresql:///plain", 18950 + side)
                environment = launch.call_args.kwargs["env"]
                for name in ("JOURNAL_ENGINE_WRITES", "JOURNAL_WRITE_FREEZE", "GYM_ENGINE_WRITES", "GYM_WRITE_FREEZE", "LEGACY_REST_WRITES_RETIRED"):
                    self.assertEqual(environment[name], "0")
                self.assertEqual(launch.call_args.args[0][0], str(self.diff.main_binary if side == 0 else
                                 self.diff.args.bin_dir / "windmill_server_test_clock"))


if __name__ == "__main__":
    unittest.main()
