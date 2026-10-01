import argparse
import tempfile
import sys
import unittest
from unittest.mock import MagicMock, patch
from pathlib import Path

sys.dont_write_bytecode = True
from gym_write_differential import Differential


class TimestampComparisonTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.diff = Differential(argparse.Namespace(mode="off-vs-on"), Path(self.directory.name))

    def test_seeded_timestamps_are_exact(self):
        left = '{"id":"note_seed","updatedAt":1767225600000}'
        right = '{"id":"note_seed","updatedAt":1767225600001}'
        self.assertNotEqual(self.diff.normalise(left, 0), self.diff.normalise(right, 1))

    def test_opposite_timestamp_changes_are_rejected(self):
        self.diff.discover({"id": "note", "updatedAt": 10000}, {"id": "note", "updatedAt": 10000})
        with self.assertRaises(AssertionError):
            self.diff.discover({"id": "note", "updatedAt": 11000}, {"id": "note", "updatedAt": 9000})

    def test_backwards_timestamps_are_rejected(self):
        self.diff.normalise('{"id":"note","updatedAt":10000}', 0)
        with self.assertRaises(AssertionError):
            self.diff.normalise('{"id":"note","updatedAt":9000}', 0)

    def test_main_comparison_keeps_both_switches_off(self):
        self.diff.args = argparse.Namespace(mode="main-vs-off", image=None, bin_dir=Path("/build"))
        self.diff.main_binary = Path("/main-build/windmill_server")
        response = MagicMock(status=401)
        connection = MagicMock()
        connection.getresponse.return_value = response
        with patch("gym_write_differential.http.client.HTTPConnection", return_value=connection), \
                patch("gym_write_differential.subprocess.Popen") as launch:
            for side in range(2):
                self.diff.start(side, "postgresql:///plain", 18900 + side)
                self.assertEqual(launch.call_args.kwargs["env"]["GYM_ENGINE_WRITES"], "0")
                self.assertEqual(launch.call_args.kwargs["env"]["GYM_WRITE_FREEZE"], "0")
                self.assertEqual(launch.call_args.args[0][0], str(self.diff.main_binary if side == 0 else
                                 self.diff.args.bin_dir / "windmill_server_test_clock"))


if __name__ == "__main__":
    unittest.main()
