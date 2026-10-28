import contextlib
import io
import json
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory
import textwrap
import unittest
from unittest.mock import patch


class DomainDiagnosticsTests(unittest.TestCase):
    workflow = Path(__file__).parents[5] / ".github/workflows/ios.yml"

    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.temporary = self.root / "temporary"
        self.temporary.mkdir()
        marker = self.temporary / "domain-tests-start"
        marker.touch()
        os.utime(marker, (100, 100))
        self.home = self.root / "home"
        self.reports = self.home / "Library/Logs/DiagnosticReports"
        self.reports.mkdir(parents=True)

    def report(self, name, process="WindmillDomainPackageTests", at=200, **fields):
        path = self.reports / name
        value = {"procName": process, "exception": {"type": "EXC_BAD_ACCESS", "signal": "SIGBUS"},
                 "faultingThread": 0, "threads": [{"triggered": True, "frames": [{"symbol": "domainFrame", "imageIndex": 0}]}],
                 "usedImages": [{"path": "/build/WindmillDomainPackageTests.xctest/Contents/MacOS/WindmillDomainPackageTests"}],
                 **fields}
        path.write_text(json.dumps({"bug_type": "309"}) + "\n" + json.dumps(value))
        os.utime(path, (at, at))
        return path

    def collect(self):
        block = self.workflow.read_text().split("- name: Collect failed Domain test diagnostics", 1)[1]
        script = textwrap.dedent(re.search(r"python3 - <<'PY'\n(.*?)\n          PY", block, re.S)[1])
        with patch.dict(os.environ, {"RUNNER_TEMP": str(self.temporary)}), \
             patch.object(Path, "home", return_value=self.home), patch("time.sleep") as sleep, \
             contextlib.redirect_stdout(io.StringIO()):
            exec(compile(script, str(self.workflow), "exec"), {})
        self.output = self.temporary / "domain-test-diagnostics"
        return json.loads((self.output / "summary.json").read_text()), sleep

    def test_only_fresh_domain_crashes_export_stack_fields(self):
        self.report("WindmillDomainPackageTests-current.ips", asi={"log": "secret"}, environment={"TOKEN": "secret"}, crashReporterKey="device")
        self.report("WindmillDomainPackageTests-old.ips", at=50)
        self.report("WindmillDomainPackageTests-other.ips", process="AnotherApp")
        self.report("xctest-other.ips", process="xctest", usedImages=[{"path": "/build/OtherTests.xctest/Contents/MacOS/OtherTests"}])
        self.report("UnrelatedApp.ips")
        self.report("WindmillDomainPackageTests-large.ips", payload="x" * (8 * 1024 * 1024))
        (self.reports / "WindmillDomainPackageTests-link.ips").symlink_to(self.reports / "WindmillDomainPackageTests-current.ips")
        summary, sleep = self.collect()
        self.assertEqual(["domain-crash-1.json"], summary["reports"])
        self.assertEqual({"procName", "exception", "faultingThread", "threads", "usedImages"},
                         set(json.loads((self.output / "domain-crash-1.json").read_text())))
        self.assertEqual("domainFrame", json.loads((self.output / "domain-crash-1.json").read_text())["threads"][0]["frames"][0]["symbol"])
        self.assertNotIn("secret", (self.output / "domain-crash-1.json").read_text())
        sleep.assert_not_called()

    def test_xctest_requires_the_domain_bundle_and_output_is_bounded(self):
        for index in range(5):
            self.report(f"xctest-{index}.ips", process="xctest", at=200 + index)
        limit = 8 * 1024 * 1024
        (self.temporary / "domain-tests.log").write_bytes(b"old-prefix" + b"x" * limit)
        summary, sleep = self.collect()
        self.assertEqual(["domain-crash-1.json", "domain-crash-2.json", "domain-crash-3.json"], summary["reports"])
        self.assertEqual(b"x" * limit, (self.output / "domain-tests.log").read_bytes())
        self.assertEqual(5, len(list(self.output.iterdir())))
        sleep.assert_not_called()

    def test_missing_or_partial_reports_wait_only_the_bounded_window(self):
        (self.reports / "WindmillDomainPackageTests-partial.ips").write_text('{"bug_type":"309"}\n{')
        (self.reports / "WindmillDomainPackageTests-invalid.ips").write_text('[]\n{}')
        summary, sleep = self.collect()
        self.assertEqual([], summary["reports"])
        self.assertEqual(4, sleep.call_count)
        self.assertEqual([(4,)] * 4, [call.args for call in sleep.call_args_list])
        self.assertEqual(["summary.json"], [path.name for path in self.output.iterdir()])
