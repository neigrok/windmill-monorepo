import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def summary(bundle):
    return json.loads(subprocess.check_output(["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", str(bundle)]))


def hierarchies(bundle, test):
    exported = Path(tempfile.mkdtemp())
    subprocess.run(["xcrun", "xcresulttool", "export", "attachments", "--path", str(bundle), "--output-path", str(exported),
                    "--test-id", test], check=True, stdout=subprocess.DEVNULL)
    for entry in json.loads((exported / "manifest.json").read_text()):
        for attachment in entry["attachments"]:
            if attachment["suggestedHumanReadableName"].startswith("App UI hierarchy"):
                yield (exported / attachment["exportedFileName"]).read_text()


def row(bundle):
    if not bundle.exists():
        return f"| {bundle.name} | | no bundle: the run ended before it wrote one | | |"
    try:
        result = summary(bundle)
    except subprocess.CalledProcessError:
        return f"| {bundle.name} | | unreadable bundle | | |"
    failures = {}
    for failure in result.get("testFailures", []):
        failures.setdefault(failure["testIdentifierString"], []).append(failure["failureText"])
    for test, texts in failures.items():
        print(f"::group::{bundle.name} · {test}")
        print("\n".join(texts))
        for hierarchy in hierarchies(bundle, test):
            print(hierarchy)
        print("::endgroup::")
    device = next(iter(result.get("devicesAndConfigurations", [])), {}).get("device", {})
    return (f"| {bundle.name} | {device.get('modelName', '?')} · iOS {device.get('osVersion', '?')} "
            f"({device.get('osBuildNumber', '?')}) | {result['result']} | {result['passedTests']} | {result['failedTests']} |")


if __name__ == "__main__":
    table = ["| Result bundle | Simulator | Outcome | Passed | Failed |", "| --- | --- | --- | --- | --- |"]
    table += [row(Path(bundle)) for bundle in sys.argv[1:]]
    print("\n".join(table))
    with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a") as job_summary:
        job_summary.write("\n".join(table) + "\n")
