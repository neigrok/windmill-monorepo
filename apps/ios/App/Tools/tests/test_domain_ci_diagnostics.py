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
        self.report("swiftpm-testing-helper-other.ips", process="swiftpm-testing-helper", usedImages=[{"path": "/build/OtherTests.xctest/Contents/MacOS/OtherTests"}])
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

    def test_swift_testing_helper_requires_the_domain_bundle(self):
        self.report("swiftpm-testing-helper-current.ips", process="swiftpm-testing-helper", environment={"TOKEN": "secret"})
        summary, sleep = self.collect()
        self.assertEqual(["domain-crash-1.json"], summary["reports"])
        result = json.loads((self.output / "domain-crash-1.json").read_text())
        self.assertEqual("swiftpm-testing-helper", result["procName"])
        self.assertEqual({"procName", "exception", "faultingThread", "threads", "usedImages"}, set(result))
        self.assertNotIn("secret", json.dumps(result))
        sleep.assert_not_called()

    def test_missing_or_partial_reports_wait_only_the_bounded_window(self):
        (self.reports / "WindmillDomainPackageTests-partial.ips").write_text('{"bug_type":"309"}\n{')
        (self.reports / "WindmillDomainPackageTests-invalid.ips").write_text('[]\n{}')
        summary, sleep = self.collect()
        self.assertEqual([], summary["reports"])
        self.assertEqual(4, sleep.call_count)
        self.assertEqual([(4,)] * 4, [call.args for call in sleep.call_args_list])
        self.assertEqual(["summary.json"], [path.name for path in self.output.iterdir()])


class DomainDebuggerTests(unittest.TestCase):
    def setUp(self):
        import importlib.util
        path = Path(__file__).parents[1] / "domain_ci_debugger.py"
        spec = importlib.util.spec_from_file_location("domain_ci_debugger", path)
        self.debugger = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.debugger)

    def test_stack_output_is_bounded_and_never_reads_variable_values(self):
        from types import SimpleNamespace

        source = SimpleNamespace(GetFilename=lambda: "Probe.swift")
        module = SimpleNamespace(GetFileSpec=lambda: SimpleNamespace(GetFilename=lambda: "DomainTests"), GetUUIDString=lambda: "A1B2")
        frame = SimpleNamespace(GetPC=lambda: 123, GetFunctionName=lambda: "static Probe.run()",
                                GetModule=lambda: module,
                                GetLineEntry=lambda: SimpleNamespace(GetFileSpec=lambda: source, GetLine=lambda: 42))
        class Thread:
            def GetNumFrames(self): return 1_000_000
            def GetFrameAtIndex(self, index):
                self_assert(index < 64)
                return frame
            def GetIndexID(self): return 3
            def GetStopReason(self): return 5
            def GetStopReasonDataCount(self): return 1
            def GetStopReasonDataAtIndex(self, index): return 10

        class Target:
            def GetNumModules(self): return 1_000_000
            def GetModuleAtIndex(self, index):
                self_assert(index < 512)
                return module

        class Process:
            def GetNumThreads(self): return 1_000_000
            def GetThreadAtIndex(self, index):
                self_assert(index < 128)
                return Thread()
            def GetState(self): return 5
            def GetExitStatus(self): return -1
            def GetTarget(self): return Target()

        self_assert = self.assertTrue
        process = Process()
        result = self.debugger.snapshot(process, SimpleNamespace(eStateStopped=5, eStateCrashed=8))
        self.assertEqual({"state": 5, "exitStatus": -1, "outcome": "stopped", "threads": [
            {"index": 3, "stopReason": 5, "stopData": [10], "frames": [
                {"pc": 123, "function": "static Probe.run()", "image": "DomainTests", "file": "Probe.swift", "line": 42}
            ] * 64}] * 128, "images": [{"name": "DomainTests", "uuid": "A1B2"}] * 512}, result)
        self.assertLess(len(json.dumps(result).encode()), 8 * 1024 * 1024)

    def test_cleanup_targets_only_owned_descendants_even_with_separate_process_groups(self):
        from types import SimpleNamespace

        table = "100 1\n101 100\n102 101\n200 1\n201 200\n"
        with patch("subprocess.run", return_value=SimpleNamespace(stdout=table)) as run, patch("os.kill") as kill:
            self.assertEqual({"complete": True, "children": 2}, self.debugger.terminate_children(100))
            self.assertEqual([102, 101], [call.args[0] for call in kill.call_args_list])
            self.assertEqual(["ps", "-axo", "pid=,ppid="], run.call_args.args[0])

    def test_unreadable_or_unbounded_process_snapshot_never_guesses_a_child(self):
        from types import SimpleNamespace

        for table in ("invalid", "2 1\n" * 8193):
            with patch("subprocess.run", return_value=SimpleNamespace(stdout=table)), patch("os.kill") as kill:
                self.assertEqual({"complete": False}, self.debugger.terminate_children(100))
                kill.assert_not_called()

    def test_missing_bundle_is_reported_without_running_a_command(self):
        with TemporaryDirectory() as directory, patch("subprocess.run") as run:
            root = Path(directory)
            summary = self.debugger.reproduce(root, root / "output")
            self.assertEqual({"outcome": "unavailable", "seconds": 300, "entryPoint": "swift-testing",
                              "maximumThreads": 128, "maximumFramesPerThread": 64, "maximumImages": 512,
                              "reason": "domain_bundle_missing"}, summary)
            self.assertEqual(summary, json.loads((root / "output/debugger-summary.json").read_text()))
            run.assert_not_called()

    def test_original_full_gate_remains_authoritative_and_reproduction_is_failure_only(self):
        workflow = DomainDiagnosticsTests.workflow.read_text()
        self.assertIn('swift test --explicit-target-dependency-import-check error 2>&1 | tee "$RUNNER_TEMP/domain-tests.log"', workflow)
        block = workflow.split('- name: Reproduce failed Domain tests under LLDB', 1)[1].split('- name:', 1)[0]
        self.assertIn("if: ${{ failure() && steps.domain_tests.outcome == 'failure' }}", block)
        self.assertIn("timeout-minutes: 7", block)
        self.assertNotIn("continue-on-error", block)
        self.assertNotIn("--filter", block)
        self.assertNotIn("--no-parallel", block)
