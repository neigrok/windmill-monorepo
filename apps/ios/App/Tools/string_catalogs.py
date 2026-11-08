import sys

sys.dont_write_bytecode = True

import argparse
import json
from pathlib import Path
import plistlib
import subprocess
from tempfile import TemporaryDirectory

APP = Path(__file__).resolve().parents[1]
# Each bundle's catalogs, by the target whose compiled sources fill its Localizable and the bundle whose Info.plist its
# InfoPlist names.
TARGETS = {
    "Windmill": ("Resources", "Windmill.app"),
    "WindmillWorkoutActivity": ("WorkoutActivityWidget", "Windmill.app/PlugIns/WindmillWorkoutActivity.appex"),
}
# The catalogs hold what ships: the Release build's strings, never a Debug fixture's. The build never ships, so it carries
# CI's nonproduction collector.
CONFIGURATION = "Release-iphonesimulator"
RELEASE = ["-project", str(APP / "Windmill.xcodeproj"), "-scheme", "Windmill", "-configuration", "Release",
           "-destination", "generic/platform=iOS Simulator", "ARCHS=arm64", "IOS_SENTRY_DSN=https://nonproduction@example.invalid/1"]
EMPTY = {"sourceLanguage": "en", "strings": {}, "version": "1.0"}


# Builds Release for the simulator where the project's builds already live, sharing their package checkouts, and answers
# that DerivedData folder.
def build():
    subprocess.run(["xcodebuild", "build", *RELEASE], check=True)
    settings = json.loads(subprocess.run(["xcodebuild", "-showBuildSettings", "-json", *RELEASE], check=True,
                                         capture_output=True, text=True).stdout)
    return Path(settings[0]["buildSettings"]["BUILD_ROOT"]).parents[1]


# The .stringsdata the compiler wrote for each source the target compiles now, so a source deleted since an earlier
# build adds nothing.
def stringsdata(derived_data, target):
    objects = derived_data / "Build/Intermediates.noindex/Windmill.build" / CONFIGURATION / f"{target}.build/Objects-normal"
    compiled = {Path(line.strip()).stem for lists in objects.glob("*/*.SwiftFileList") for line in lists.read_text().splitlines()}
    files = [file for file in sorted(objects.glob("*/*.stringsdata")) if file.stem in compiled]
    if not files:
        raise SystemExit(f"error: no .stringsdata for {target} under {objects}; build Release for the simulator first.")
    return files


# A catalog as Xcode writes it: two-space indents, `" : "`, keys in code point order, an empty object on three lines.
def xcode_json(value, depth=0):
    if not isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    indent = "  " * depth
    if not value:
        return "{\n\n" + indent + "}"
    members = (f"{indent}  {json.dumps(key, ensure_ascii=False)} : {xcode_json(value[key], depth + 1)}" for key in sorted(value))
    return "{\n" + ",\n".join(members) + "\n" + indent + "}"


# Drops what no compiled source names any more, so a deleted string leaves rather than standing stale; a hand-kept
# string stays.
def pruned(catalog, extracted):
    return {**catalog, "strings": {key: entry for key, entry in catalog["strings"].items()
                                   if key in extracted or entry.get("extractionState") == "manual"}}


def sync(catalog, files):
    subprocess.run(["xcrun", "xcstringstool", "sync", str(catalog), "--stringsdata", *map(str, files)], check=True)


# The Info.plist strings people read, the name under the icon and each reason a permission is asked for, as the built
# bundle holds them; its InfoPlist catalog keeps each by hand.
def shown(info):
    return {key: value for key, value in info.items() if key == "CFBundleDisplayName" or key.endswith("UsageDescription")}


def info_plist_findings(path, catalog, info):
    kept = {key: entry.get("localizations", {}).get("en", {}).get("stringUnit", {}).get("value")
            for key, entry in catalog["strings"].items()}
    return [f"{path}: {key} reads {kept.get(key)!r}, the built Info.plist {value!r}" for key, value in shown(info).items() if kept.get(key) != value] \
        + [f"{path}: {key} names no string the built Info.plist shows" for key in kept.keys() - shown(info).keys()]


# Each Localizable catalog as the build's sources say it should read: synced from a fresh one for the strings they
# name, then the committed one pruned to those and synced in `directory`.
def regenerated(derived_data, directory):
    written = {}
    for target, (folder, _) in TARGETS.items():
        files = stringsdata(derived_data, target)
        fresh, current = Path(directory) / target / "fresh/Localizable.xcstrings", Path(directory) / target / "Localizable.xcstrings"
        fresh.parent.mkdir(parents=True)
        fresh.write_text(xcode_json(EMPTY))
        sync(fresh, files)
        committed = json.loads((APP / folder / "Localizable.xcstrings").read_text())
        current.write_text(xcode_json(pruned(committed, set(json.loads(fresh.read_text())["strings"]))))
        sync(current, files)
        written[f"{folder}/Localizable.xcstrings"] = current
    return written


def differences(committed, regenerated):
    old, new = json.loads(committed.read_text())["strings"], json.loads(regenerated.read_text())["strings"]
    return ([f"+ {key!r}" for key in sorted(new.keys() - old.keys())] + [f"- {key!r}" for key in sorted(old.keys() - new.keys())]
            + [f"~ {key!r}" for key in sorted(old.keys() & new.keys()) if old[key] != new[key]])


def main():
    parser = argparse.ArgumentParser(description="Rewrite the String Catalogs from the strings a Release simulator build of the "
                                                 "app extracts; with --check, fail when a committed catalog differs.")
    parser.add_argument("--derived-data", type=Path, help="An existing Release simulator build to read instead of building.")
    parser.add_argument("--check", action="store_true", help="Change nothing; exit 1 when a catalog is not current.")
    arguments = parser.parse_args()
    derived_data = arguments.derived_data or build()
    products = derived_data / "Build/Products" / CONFIGURATION
    findings = []
    for folder, bundle in TARGETS.values():
        with (products / bundle / "Info.plist").open("rb") as handle:
            info = plistlib.load(handle)
        path = f"{folder}/InfoPlist.xcstrings"
        findings += info_plist_findings(path, json.loads((APP / path).read_text()), info)
    with TemporaryDirectory(prefix="windmill-catalogs-") as directory:
        written = regenerated(derived_data, directory)
        changes = {path: differences(APP / path, file) for path, file in written.items()}
        if arguments.check:
            findings += [f"{path} is not current: {change}" for path, lines in changes.items() for change in lines]
            if findings:
                print(*findings, sep="\n")
                raise SystemExit("error: run `python3 Tools/string_catalogs.py` and commit the catalogs it writes.")
            print("The String Catalogs are current.")
            return
        for path, file in written.items():
            (APP / path).write_text(file.read_text())
            print(f"{path}: {len(json.loads(file.read_text())['strings'])} strings, {len(changes[path])} changed")
    if findings:
        print(*findings, sep="\n")
        raise SystemExit("error: keep each InfoPlist catalog's strings as the built Info.plist shows them.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit("error: " + str(error))
