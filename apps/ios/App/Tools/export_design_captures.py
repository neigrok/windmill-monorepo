import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory


def publish(exported, destination, result):
    manifest = json.loads((exported / "manifest.json").read_text())
    if not isinstance(manifest, list):
        raise ValueError("The attachment manifest must be an array.")
    captures = []
    for test in manifest:
        if "DesignCaptureTests/" not in test["testIdentifier"]:
            continue
        for attachment in test["attachments"]:
            original = attachment["exportedFileName"]
            if Path(original).name != original:
                raise ValueError("Attachment filename must stay inside the export directory.")
            name = attachment["suggestedHumanReadableName"]
            if not name.startswith(("gym-", "journal-", "shell-")) or Path(original).suffix.lower() != ".png":
                continue
            source = exported / original
            if not source.is_file():
                raise ValueError(f"Missing capture attachment: {original}")
            name = re.sub(r"_\d+_[0-9A-Fa-f-]{36}(?=\.png$)", "", name)
            clean = re.sub(r"[^A-Za-z0-9._-]", "-", name)
            if not clean.lower().endswith(".png"):
                clean += ".png"
            captures.append((source, clean, test["testIdentifier"]))
    if not captures:
        raise ValueError("The result contains no named DesignCaptureTests PNGs. Check WM_DESIGN_CAPTURE and the test results.")
    destination.mkdir(parents=True, exist_ok=True)
    entries = []
    for source, name, test in captures:
        target = destination / name
        suffix = 2
        while target.exists():
            target = destination / f"{Path(name).stem}-{suffix}.png"
            suffix += 1
        with source.open("rb") as incoming, target.open("xb") as outgoing:
            shutil.copyfileobj(incoming, outgoing)
        entries.append({"file": target.name, "test": test, "result": str(result)})
    index = destination / "capture-manifest.json"
    suffix = 2
    while index.exists():
        index = destination / f"capture-manifest-{suffix}.json"
        suffix += 1
    with index.open("x") as handle:
        json.dump(entries, handle, indent=2)
        handle.write("\n")
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
