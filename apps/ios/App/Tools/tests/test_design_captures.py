import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).parents[1]))
import export_design_captures


class DesignCaptureExportTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.exported = self.root / "exported"
        self.exported.mkdir()
        self.destination = self.root / "captures"
        self.result = self.root / "capture.xcresult"
        self.result.mkdir()
        self.attachment = {"exportedFileName": "opaque.png", "suggestedHumanReadableName": "gym-log-light_0_00000000-0000-0000-0000-000000000000.png"}
        self.manifest = [{"testIdentifier": "DesignCaptureTests/testLogScreensLight()", "attachments": [self.attachment]}]
        self.write_manifest()
        (self.exported / "opaque.png").write_bytes(b"capture pixels")

    def write_manifest(self):
        (self.exported / "manifest.json").write_text(json.dumps(self.manifest))

    def test_export_preserves_pixels_names_tests_and_existing_runs(self):
        first = export_design_captures.publish(self.exported, self.destination, self.result)
        second = export_design_captures.publish(self.exported, self.destination, self.result)
        self.assertEqual([{"file": "gym-log-light.png", "test": "DesignCaptureTests/testLogScreensLight()", "result": str(self.result)}], first)
        self.assertEqual([{**first[0], "file": "gym-log-light-2.png"}], second)
        self.assertEqual(b"capture pixels", (self.destination / "gym-log-light.png").read_bytes())
        self.assertEqual(b"capture pixels", (self.destination / "gym-log-light-2.png").read_bytes())
        self.assertEqual(first, json.loads((self.destination / "capture-manifest.json").read_text()))
        self.assertEqual(second, json.loads((self.destination / "capture-manifest-2.json").read_text()))

    def test_empty_or_ungated_suite_results_do_not_claim_capture_success(self):
        for manifest in ([], [{"testIdentifier": "GymLogFlowTests/testLogScreensLight()", "attachments": [self.attachment]}]):
            with self.subTest(manifest=manifest):
                self.manifest = manifest
                self.write_manifest()
                with self.assertRaisesRegex(ValueError, "no named DesignCaptureTests PNGs"):
                    export_design_captures.publish(self.exported, self.destination, self.result)
                self.assertFalse(self.destination.exists())

    def test_missing_attachment_or_path_escape_fails_before_publishing(self):
        for name, message in (("missing.png", "Missing capture attachment"), ("../outside.png", "inside the export directory")):
            with self.subTest(name=name):
                self.attachment["exportedFileName"] = name
                self.write_manifest()
                with self.assertRaisesRegex(ValueError, message):
                    export_design_captures.publish(self.exported, self.destination, self.result)
                self.assertFalse(self.destination.exists())

    def test_export_process_exit_and_timeout_are_propagated_without_publishing(self):
        for error in (subprocess.CalledProcessError(1, "xcrun"), subprocess.TimeoutExpired("xcrun", 120)):
            with self.subTest(error=error), patch.object(export_design_captures.subprocess, "run", side_effect=error) as command:
                with self.assertRaises(type(error)):
                    export_design_captures.export(self.result, self.destination)
                self.assertEqual(True, command.call_args.kwargs["check"])
                self.assertEqual(120, command.call_args.kwargs["timeout"])
                self.assertFalse(self.destination.exists())

    def test_missing_result_bundle_fails_before_starting_export(self):
        with patch.object(export_design_captures.subprocess, "run") as command:
            with self.assertRaisesRegex(ValueError, "Result bundle does not exist"):
                export_design_captures.export(self.root / "missing.xcresult", self.destination)
            command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
