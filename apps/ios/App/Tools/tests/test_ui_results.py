from collections import Counter
import importlib.util
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("check_ui_results", Path(__file__).parents[1] / "check_ui_results.py")
results = importlib.util.module_from_spec(spec)
spec.loader.exec_module(results)


class UIResultChecks(unittest.TestCase):
    mandatory = ("GymIntegrationFlowTests", "testMandatoryFlow")
    fixture = next(iter(results.FIXTURE_SKIPS))
    expected = Counter({mandatory: 1, fixture: 1})

    def entry(self, test, status):
        return f"Test Case '-[WindmillUITests.{test[0]} {test[1]}]' {status} (0.1 seconds).\n"

    def started(self, test):
        return f"Test Case '-[WindmillUITests.{test[0]} {test[1]}]' started.\n"

    def skipped(self, reason=None):
        reason = results.FIXTURE_SKIPS[self.fixture] if reason is None else reason
        return (f"fixture.swift:51: -[WindmillUITests.{self.fixture[0]} {self.fixture[1]}] : Test skipped - {reason}\n"
                + self.entry(self.fixture, "skipped"))

    def complete(self, fixture=None):
        return self.started(self.mandatory) + self.entry(self.mandatory, "passed") + self.started(self.fixture) + (
            self.skipped() if fixture is None else fixture)

    def test_exact_fixture_skip_retains_every_mandatory_pass(self):
        passed, skipped = results.check_results(self.complete(), self.expected)
        self.assertEqual(Counter({self.mandatory: 1}), passed)
        self.assertEqual(Counter({self.fixture: 1}), skipped)

    def test_live_fixture_must_pass_when_it_runs(self):
        passed, skipped = results.check_results(self.complete(self.entry(self.fixture, "passed")), self.expected,
            load_fixture_requested=True)
        self.assertEqual(self.expected, passed)
        self.assertEqual(Counter(), skipped)
        with self.assertRaises(AssertionError):
            results.check_results(self.complete(), self.expected, load_fixture_requested=True)

    def test_unexpected_missing_failed_duplicate_and_unexplained_results_fail(self):
        complete = self.complete()
        invalid = [
            complete.replace(self.entry(self.mandatory, "passed"), self.entry(self.mandatory, "skipped")),
            complete.replace(self.entry(self.mandatory, "passed"), self.entry(self.mandatory, "failed")),
            complete.replace(self.started(self.fixture), ""),
            complete.replace(self.skipped(), ""),
            complete + self.started(self.mandatory),
            complete + self.entry(self.mandatory, "passed"),
            complete + self.skipped(),
            complete + self.entry(("UnexpectedTests", "testOther"), "skipped"),
            complete.replace(self.skipped(), self.entry(self.fixture, "skipped")),
            complete.replace(self.skipped(), self.skipped("some other reason")),
            complete + self.entry(self.fixture, "passed"),
            complete + self.entry(self.fixture, "failed"),
        ]
        for log in invalid:
            with self.subTest(log=log), self.assertRaises(AssertionError):
                results.check_results(log, self.expected)

    def test_selected_classes_and_methods_are_declared_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "UI.swift").write_text("final class SampleTests: XCTestCase { func testOne() {} func testTwo() {} }")
            selection = "-only-testing:WindmillUITests/SampleTests"
            self.assertEqual(Counter({("SampleTests", "testOne"): 1, ("SampleTests", "testTwo"): 1}), results.expected_tests(selection, root))
            for invalid in ("", selection + " " + selection, "-only-testing:WindmillUITests/MissingTests"):
                with self.subTest(selection=invalid), self.assertRaises(AssertionError):
                    results.expected_tests(invalid, root)
            (root / "Duplicate.swift").write_text("final class SampleTests: XCTestCase { func testOne() {} }")
            with self.assertRaises(AssertionError):
                results.expected_tests(selection, root)
