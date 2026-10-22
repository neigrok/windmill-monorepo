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
        self.attachment = {"exportedFileName": "opaque.png", "suggestedHumanReadableName": "05_0_00000000-0000-0000-0000-000000000000.1-log-daylight"}
        self.manifest = [{"testIdentifier": "LogCaptures/testScreens()", "attachments": [self.attachment]}]
        self.write_manifest()
        (self.exported / "opaque.png").write_bytes(b"capture pixels")

    def write_manifest(self):
        (self.exported / "manifest.json").write_text(json.dumps(self.manifest))

    def test_export_names_each_capture_by_its_name_and_replaces_an_earlier_export(self):
        self.manifest[0]["attachments"].append({"exportedFileName": "second.png", "suggestedHumanReadableName": "gym-log-end-375-ax3-dark_1_11111111-1111-1111-1111-111111111111.png"})
        self.write_manifest()
        (self.exported / "second.png").write_bytes(b"end pixels")
        export_design_captures.publish(self.exported, self.destination, self.result)
        (self.exported / "opaque.png").write_bytes(b"newer pixels")
        entries = export_design_captures.publish(self.exported, self.destination, self.result)
        expected = [{"file": "05.1-log-daylight.png", "test": "LogCaptures/testScreens()", "result": str(self.result)},
                    {"file": "gym-log-end-375-ax3-dark.png", "test": "LogCaptures/testScreens()", "result": str(self.result)}]
        self.assertEqual(expected, entries)
        self.assertEqual(expected, json.loads((self.destination / "capture-manifest.json").read_text()))
        self.assertEqual(["05.1-log-daylight.png", "capture-manifest.json", "gym-log-end-375-ax3-dark.png"], sorted(path.name for path in self.destination.iterdir()))
        self.assertEqual(b"newer pixels", (self.destination / "05.1-log-daylight.png").read_bytes())
        self.assertEqual(b"end pixels", (self.destination / "gym-log-end-375-ax3-dark.png").read_bytes())

    def test_two_captures_with_one_name_fail_before_publishing(self):
        self.manifest.append({"testIdentifier": "ChromeCaptures/testFloatingLayer()", "attachments": [self.attachment]})
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "Two captures share the name 05.1-log-daylight: LogCaptures/testScreens\\(\\) and ChromeCaptures/testFloatingLayer\\(\\)"):
            export_design_captures.publish(self.exported, self.destination, self.result)
        self.assertFalse(self.destination.exists())

    def test_empty_ungated_or_unnamed_results_do_not_claim_capture_success(self):
        unnamed = {"exportedFileName": "opaque.png", "suggestedHumanReadableName": "Screenshot at failure_0_00000000-0000-0000-0000-000000000000.png"}
        light = {"exportedFileName": "opaque.png", "suggestedHumanReadableName": "05_0_00000000-0000-0000-0000-000000000000.1-log-light"}
        for manifest in ([], [{"testIdentifier": "GymLogFlowTests/testScreens()", "attachments": [self.attachment]}],
                         [{"testIdentifier": "LogCaptures/testScreens()", "attachments": [unnamed, light]}]):
            with self.subTest(manifest=manifest):
                self.manifest = manifest
                self.write_manifest()
                with self.assertRaisesRegex(ValueError, "no named design captures"):
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
