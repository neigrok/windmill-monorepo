from collections import Counter
from pathlib import Path
import os
import re


FIXTURE_SKIPS = {
    ("GymIntegrationFlowTests", "testFiniteLoadWheelsSaveAndSyncBeyondTheOldLimitIncludingZero"):
        "requires the isolated schema10 load fixture",
}


def expected_tests(selection, sources):
    selected = re.findall(r"-only-testing:WindmillUITests/(\w+)", selection)
    assert selected and len(set(selected)) == len(selected), "Select each UI class exactly once."
    found = set()
    expected = Counter()
    for source in sources.rglob("*.swift"):
        text = source.read_text()
        classes = re.findall(r"\bclass\s+(\w+)\s*:\s*XCTestCase", text)
        if not classes or classes[0] not in selected:
            continue
        assert len(classes) == 1, f"Expected one UI test class in {source}"
        assert classes[0] not in found, f"Duplicate UI class: {classes[0]}"
        found.add(classes[0])
        expected.update((classes[0], method) for method in re.findall(r"\bfunc\s+(test\w+)\s*\(", text))
    assert found == set(selected), f"Missing UI classes: {set(selected) - found}"
    assert expected and all(count == 1 for count in expected.values()), f"Duplicate or missing UI methods: {expected}"
    return expected


def check_results(log, expected, *, load_fixture_requested=False):
    prefix = r"Test Case '-\[WindmillUITests\.(\w+) (test\w+)\]' "
    started = Counter(re.findall(prefix + r"started\.", log))
    passed = Counter(re.findall(prefix + r"passed ", log))
    skipped = Counter(re.findall(prefix + r"skipped ", log))
    failed = Counter(re.findall(prefix + r"failed ", log))
    reasons = Counter(re.findall(r"-\[WindmillUITests\.(\w+) (test\w+)\] : Test skipped - ([^\r\n]+)", log))
    assert started == expected, f"UI executions differ: expected={expected}, started={started}"
    assert not failed, f"UI failures: {failed}"
    assert passed + skipped == expected, f"UI completions differ: expected={expected}, passed={passed}, skipped={skipped}"
    assert all(test in FIXTURE_SKIPS for test in skipped), f"Unexpected skipped UI tests: {skipped}"
    assert not load_fixture_requested or not skipped, "The requested finite-load fixture must pass, never skip."
    allowed_reasons = Counter({(*test, FIXTURE_SKIPS[test]): count for test, count in skipped.items()})
    assert reasons == allowed_reasons, f"UI skip reasons differ: expected={allowed_reasons}, observed={reasons}"
    return passed, skipped


if __name__ == "__main__":
    expected = expected_tests(os.environ["UI_TEST_SELECTION"], Path(__file__).resolve().parent.parent / "UITests")
    passed, skipped = check_results(Path(os.environ["UI_TEST_LOG"]).read_text(), expected,
        load_fixture_requested=bool(os.environ.get("WM_GYM_LOAD_CASES")))
    print(f"UI results: {sum(passed.values())} passed, {sum(skipped.values())} explicitly expected fixture skips; every selected test ran exactly once.")
