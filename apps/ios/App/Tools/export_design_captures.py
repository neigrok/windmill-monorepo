import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory


CAPTURE_NAME = re.compile(r"[0-9a-z][0-9a-z.-]*-(dark|daylight)")
# xcresulttool puts _<index>_<uuid> before a name's first dot: 02_0_<uuid>.1-routines-dark, gym-log-dark_0_<uuid>.png.
XCRESULT_TOKEN = re.compile(r"_\d+_[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")


def publish(exported, destination, result):
    manifest = json.loads((exported / "manifest.json").read_text())
    if not isinstance(manifest, list):
        raise ValueError("The attachment manifest must be an array.")
    captures = {}
    for test in manifest:
        if not test["testIdentifier"].split("/")[0].endswith("Captures"):
            continue
        for attachment in test["attachments"]:
            original = attachment["exportedFileName"]
            if Path(original).name != original:
                raise ValueError("Attachment filename must stay inside the export directory.")
            name = XCRESULT_TOKEN.sub("", attachment["suggestedHumanReadableName"], count=1).removesuffix(".png")
            if not CAPTURE_NAME.fullmatch(name) or Path(original).suffix.lower() != ".png":
                continue
            source = exported / original
            if not source.is_file():
                raise ValueError(f"Missing capture attachment: {original}")
            if name in captures:
                raise ValueError(f"Two captures share the name {name}: {captures[name][1]} and {test['testIdentifier']}")
            captures[name] = (source, test["testIdentifier"])
    if not captures:
        raise ValueError("The result contains no named design captures. Check WM_DESIGN_CAPTURE and the test results.")
    destination.mkdir(parents=True, exist_ok=True)
    entries = []
    for name, (source, test) in sorted(captures.items()):
        shutil.copyfile(source, destination / f"{name}.png")
        entries.append({"file": f"{name}.png", "test": test, "result": str(result)})
    (destination / "capture-manifest.json").write_text(json.dumps(entries, indent=2) + "\n")
    return entries


def export(result, destination):
    if not result.is_dir():
        raise ValueError(f"Result bundle does not exist: {result}")
    with TemporaryDirectory(prefix="windmill-design-export-") as directory:
        exported = Path(directory)
        subprocess.run(["xcrun", "xcresulttool", "export", "attachments", "--path", str(result),
                        "--output-path", str(exported)], check=True, timeout=120, capture_output=True)
        return publish(exported, destination, result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--result", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        captures = export(args.result.resolve(), args.output.resolve())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        raise SystemExit("error: " + str(error))
    print(f"Exported {len(captures)} named captures to {args.output.resolve()}")
