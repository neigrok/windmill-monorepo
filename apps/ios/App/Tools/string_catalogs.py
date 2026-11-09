import sys

sys.dont_write_bytecode = True

import argparse
import json
from pathlib import Path
import plistlib
import re
import subprocess
from tempfile import TemporaryDirectory

from check_copy_literals import SYNC

APP = Path(__file__).resolve().parents[1]
# Each target, by the folder of the catalogs its sources fill and the bundle whose Info.plist they name.
TARGETS = {
    "Windmill": ("Resources", "Windmill.app"),
    "WindmillWorkoutActivity": ("WorkoutActivityWidget", "Windmill.app/PlugIns/WindmillWorkoutActivity.appex"),
}
# The Release build the catalogs come from, what ships: CI's nonproduction collector, and no copy check to stop a new string.
CONFIGURATION = "Release-iphonesimulator"
RELEASE = ["-project", str(APP / "Windmill.xcodeproj"), "-scheme", "Windmill", "-configuration", "Release",
           "-destination", "generic/platform=iOS Simulator", "ARCHS=arm64", "IOS_SENTRY_DSN=https://nonproduction@example.invalid/1",
           f"{SYNC}=YES"]
EMPTY = {"sourceLanguage": "en", "strings": {}, "version": "1.0"}
# A placeholder: its position when it names one, then `%%`, a substitution `%#@name@`, or a conversion with its length, *lld* or *@*.
PLACEHOLDER = re.compile(r"%(?:(\d+)\$)?(%|#@(\w+)@|[-+ 0#']*\d*(?:\.\d+)?((?:hh|h|ll|l|q|z|t|j)?[@dDiuUxXoOfFeEgGcCsSp]))")


def parsed(path):
    try:
        return json.loads(Path(path).read_text())
    except json.JSONDecodeError as error:
        raise SystemExit(f"error: {path} is not valid JSON: {error}")


# Builds Release for the simulator where Xcode keeps the project's builds, and answers that DerivedData folder.
def build(run=subprocess.run):
    run(["xcodebuild", "build", *RELEASE], check=True)
    settings = json.loads(run(["xcodebuild", "-showBuildSettings", "-json", *RELEASE], check=True, capture_output=True, text=True).stdout)
    root = next((target["buildSettings"].get("BUILD_ROOT") for target in settings if "buildSettings" in target), None)
    if not root:
        raise SystemExit("error: xcodebuild -showBuildSettings names no BUILD_ROOT for the Release simulator build.")
    return Path(root).parents[1]


# The .stringsdata of each source the target compiles now, so a source deleted since an earlier build adds nothing.
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


# Drops what no compiled source names any more; a hand-kept string stays.
def pruned(catalog, extracted):
    return {**catalog, "strings": {key: entry for key, entry in catalog["strings"].items()
                                   if key in extracted or entry.get("extractionState") == "manual"}}


# xcstringstool answers 0 when it cannot read a catalog or a .stringsdata and skips it, so its warning fails the sync.
def sync(path, files):
    result = subprocess.run(["xcrun", "xcstringstool", "sync", str(path), "--stringsdata", *map(str, files)],
                            check=True, capture_output=True, text=True)
    skipped = [line for line in (result.stdout + result.stderr).splitlines() if "Skipping sync" in line or "Couldn't read" in line]
    if skipped:
        raise SystemExit(f"error: xcstringstool could not read what it syncs: {skipped[0]}")


# A key that holds no word is not for translators, unless it joins by comma or colon, whose marks vary by language.
def translatable(key):
    bare = PLACEHOLDER.sub("", key)
    return any(character.isalpha() for character in bare) or "," in bare or ":" in bare


def marked(catalog):
    return {**catalog, "strings": {key: {**{field: value for field, value in entry.items() if field != "shouldTranslate"},
                                         **({} if translatable(key) else {"shouldTranslate": False})}
                                   for key, entry in catalog["strings"].items()}}


# The Info.plist strings people read: the name under the icon and each reason a permission is asked for.
def shown(info):
    return {key: value for key, value in info.items() if key == "CFBundleDisplayName" or key.endswith("UsageDescription")}


def info_plist_findings(path, catalog, info):
    kept = {key: entry.get("localizations", {}).get("en", {}).get("stringUnit", {}).get("value")
            for key, entry in catalog["strings"].items()}
    return [f"{path}: {key} reads {kept.get(key)!r}, the built Info.plist {value!r}" for key, value in shown(info).items() if kept.get(key) != value] \
        + [f"{path}: {key} names no string the built Info.plist shows" for key in kept.keys() - shown(info).keys()]


# Each Localizable catalog as its sources say it reads: the committed one pruned to what they name, then synced.
def regenerated(derived_data, directory, app=APP):
    written = {}
    for target, (folder, _) in TARGETS.items():
        files = stringsdata(derived_data, target)
        fresh, current = Path(directory) / target / "fresh/Localizable.xcstrings", Path(directory) / target / "Localizable.xcstrings"
        fresh.parent.mkdir(parents=True)
        fresh.write_text(xcode_json(EMPTY))
        sync(fresh, files)
        committed = parsed(app / folder / "Localizable.xcstrings")
        current.write_text(xcode_json(marked(pruned(committed, set(parsed(fresh)["strings"])))))
        sync(current, files)
        current.write_text(xcode_json(marked(parsed(current))))
        written[f"{folder}/Localizable.xcstrings"] = current
    return written


# What a format takes, by position: each placeholder's conversion, *lld* or *@*, and a substitution's the one it names.
def placeholders(text, substitutions=None):
    taken, position = {}, 0
    for match in PLACEHOLDER.finditer(text):
        place, whole, name, conversion = match.groups()
        if whole == "%":
            continue
        position = int(place) if place else position + 1
        taken[position] = (substitutions or {}).get(name, {}).get("formatSpecifier") if name else conversion
    return taken


# A value as its key would read it: positions, numbered in order, dropped, and each substitution read as its other form.
# None when the positions are out of order.
def as_key(value, substitutions):
    places = [int(place) for place, whole, _, _ in PLACEHOLDER.findall(value) if place and whole != "%"]
    if places != list(range(1, len(places) + 1)):
        return None
    def written(match):
        place, whole, name, conversion = match.groups()
        if not name:
            return "%" + whole
        other = substitutions.get(name, {}).get("variations", {}).get("plural", {}).get("other", {}).get("stringUnit", {}).get("value", "")
        return other.replace("%arg", "%" + substitutions.get(name, {}).get("formatSpecifier", ""))
    return PLACEHOLDER.sub(written, value)


# The hand-kept English held to its key: its value and plural other form read as the key, every other form takes its
# placeholders, a substitution counts one of its %lld, and every plural has a one and an other form showing its number.
# An explicit key's value is its English, so it answers to no key.
def malformed(catalog):
    findings = []
    for key, entry in sorted(catalog["strings"].items()):
        if entry.get("extractionState") == "extracted_with_value":
            continue
        english = entry.get("localizations", {}).get("en", {})
        substitutions = english.get("substitutions", {})
        plurals = {"its plural": english["variations"]["plural"]} if "plural" in english.get("variations", {}) else {}
        plurals.update({f"its substitution {name!r}": substitution.get("variations", {}).get("plural", {})
                        for name, substitution in sorted(substitutions.items())})
        units = {"its value": english["stringUnit"]} if "stringUnit" in english else {}
        units.update({f"{where} {form} form": form_entry.get("stringUnit", {}) for where, plural in plurals.items() for form, form_entry in plural.items()})
        for where, unit in units.items():
            value = unit.get("value")
            if value is None:
                findings.append(f"{key!r}: {where} has no value")
            elif where.startswith("its substitution"):
                findings += [f"{key!r}: {where} {value!r} does not show its number"] if "%arg" not in value else []
            elif where in ("its value", "its plural other form") and as_key(value, substitutions) is None:
                findings.append(f"{key!r}: {where} {value!r} numbers its placeholders out of order")
            elif where in ("its value", "its plural other form") and as_key(value, substitutions) != key:
                findings.append(f"{key!r}: {where} {value!r} does not read as its key")
            elif placeholders(value, substitutions) != placeholders(key):
                findings.append(f"{key!r}: {where} {value!r} takes other placeholders than its key")
        for name, substitution in sorted(substitutions.items()):
            argument, conversion = substitution.get("argNum"), substitution.get("formatSpecifier")
            if conversion != "lld" or placeholders(key).get(argument) != "lld":
                findings.append(f"{key!r}: its substitution {name!r} counts argument {argument} as %{conversion}, no %lld of its key")
        findings += [f"{key!r}: {where} lacks its {form} form" for where, plural in plurals.items() for form in ("one", "other") if form not in plural]
    return findings


def differences(committed, regenerated):
    old, new = parsed(committed)["strings"], parsed(regenerated)["strings"]
    return ([f"+ {key!r}" for key in sorted(new.keys() - old.keys())] + [f"- {key!r}" for key in sorted(old.keys() - new.keys())]
            + [f"~ {key!r}" for key in sorted(old.keys() & new.keys()) if old[key] != new[key]])


def main():
    parser = argparse.ArgumentParser(description="Rewrite the String Catalogs from the strings a Release simulator build of the "
                                                 "app extracts; with --check, fail when a committed catalog differs.")
    parser.add_argument("--derived-data", type=Path, help="An existing Release simulator build to read instead of building.")
    parser.add_argument("--check", action="store_true", help="Change nothing; exit 1 when a catalog is not current.")
    arguments = parser.parse_args()
    malformations = [f"{folder}/Localizable.xcstrings: {line}" for folder, _ in TARGETS.values()
                     for line in malformed(parsed(APP / folder / "Localizable.xcstrings"))]
    if malformations:
        raise SystemExit("\n".join(f"error: {line}" for line in malformations))
    derived_data = arguments.derived_data or build()
    products = derived_data / "Build/Products" / CONFIGURATION
    findings = []
    for folder, bundle in TARGETS.values():
        with (products / bundle / "Info.plist").open("rb") as handle:
            info = plistlib.load(handle)
        path = f"{folder}/InfoPlist.xcstrings"
        findings += info_plist_findings(path, parsed(APP / path), info)
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
            print(f"{path}: {len(parsed(file)['strings'])} strings, {len(changes[path])} changed")
    if findings:
        print(*findings, sep="\n")
        raise SystemExit("error: keep each InfoPlist catalog's strings as the built Info.plist shows them.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, subprocess.CalledProcessError) as error:
        raise SystemExit("error: " + str(error))
