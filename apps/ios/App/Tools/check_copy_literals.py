import argparse
import json
import os
from pathlib import Path
import re

from swift_tokens import PLACEHOLDER, tokens


# Each bundle's catalog, by the folders its target compiles.
CATALOGS = {
    "Resources/Localizable.xcstrings": ("Sources", "WorkoutActivityShared"),
    "WorkoutActivityWidget/Localizable.xcstrings": ("WorkoutActivityWidget", "WorkoutActivityShared", "Sources/Theme"),
}
SOURCE_ROOTS = ("Sources", "WorkoutActivityShared", "WorkoutActivityWidget")
# The build setting string_catalogs.py builds with, so a string not yet in its catalog can reach the catalog.
SYNC = "WM_STRING_CATALOG_SYNC"
# Files that serve the simulator, never a person: launch fixtures seed what a person would type, Verification holds the
# launch boards and scenarios, JournalModelTransport talks to the local model server.
DEV_FILES = re.compile(r"Fixtures?\.swift$|^Sources/Verification\.swift$|^Sources/JournalModelTransport\.swift$")
SPECIFIER = re.compile(r"%(?:\d+\$)?(?:#@\w+@|[-+ 0#']*\d*(?:\.\d+)?(?:hh|h|ll|l|q|z|t|j)?[@dDiuUxXoOfFeEgGcCsSp])")
INTEGER = re.compile(r"%(?:\d+\$)?(?:ll|l|q)?[dDiuU]")
WORD = re.compile(r"[^\W\d_]{2}")
# Text that names rather than says: one lowercase word or a joined identifier, a constant, a camelCase or dotted name, a
# path, a URL, a file or a font.
IDENTIFIER = re.compile(r"^[a-z0-9]+(?:[-_.:/@+][a-zA-Z0-9]+)*[-_.:/]?$|^[A-Z0-9]*[0-9_][A-Z0-9_]*$|^\S*[a-z][A-Z]\S*$"
                        r"|^[A-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$|^[A-Z][a-z]+-[A-Z]\S*$|^\S+/\S+$|^[/.]|://"
                        r"|^[\w-]+\.(?:swift|json|png|jpg|ttf|plist|xcstrings)$")
# Calls whose strings no person reads: identifiers and assets, telemetry and logs, URLs, keys, formats and text matching.
NOT_COPY_CALLS = {
    "accessibilityIdentifier", "Image", "UIImage", "Color", "UIColor", "custom", "UIApplicationShortcutIcon", "event",
    "failure", "report", "reportBoundary", "Logger", "log", "print", "debugPrint", "fatalError", "precondition",
    "preconditionFailure", "assert", "assertionFailure", "info", "debug", "notice", "warning", "fault", "URL", "URLRequest",
    "appending", "appendingPathComponent", "NSPredicate", "hasPrefix", "hasSuffix", "contains", "components", "split",
    "replacingOccurrences", "range", "trimmingCharacters", "UserDefaults", "Name", "UTType", "Bundle", "RecordID", "ID",
    "LocalDay", "Decimal", "DateFormatter", "member", "value", "setValue", "object", "string", "bool", "integer", "double",
    "data", "removeObject", "set", "SessionToken", "AnyHashable", "JSONSerialization", "BGAppRefreshTaskRequest", "Data",
    "CharacterSet", "Regex", "NSRegularExpression", "Selector", "setenv", "getenv", "TimeZone", "Locale", "Calendar",
}
# Argument labels, dictionary and property names whose strings no person reads.
NOT_COPY_LABELS = {
    "identifier", "accessibilityIdentifier", "systemImage", "systemName", "forKey", "properties", "kind", "screen", "action",
    "outcome", "door", "operation", "code", "type", "table", "bundle", "comment", "defaultValue", "path", "method",
    "httpMethod", "scheme", "host", "subsystem", "category", "mediaType", "key", "id", "format", "dateFormat", "extension",
    "prefix", "suiteName", "forHTTPHeaderField", "withExtension", "forResource", "ofType", "room", "reason", "field", "source",
    "mode", "debugDescription", "forInfoDictionaryKey",
}
# Tokens after which a `[` opens an array or dictionary, not a subscript.
OPENS_LITERAL = {"=", "(", ",", ":", "[", "{", "?", "??", "return", "in", "case", "else", "+", "&&", "||", "throw"}
# Tokens that close the statement a `case` pattern could stand in.
STATEMENT_ENDS = {":", "{", "}", ";", "return", "let", "var", "func", "in", "else", "guard", "if"}

# Each entry is a source path, a line fragment and why that line may keep English that no catalog holds.
ALLOWED = [
    ("WorkoutActivityShared/WorkoutIntents.swift", '"Log a set in \\(.applicationName)"',
     "App Shortcut phrases localize through an AppShortcuts catalog, which comes with a second language"),
    ("WorkoutActivityShared/WorkoutIntents.swift", '"Start a workout in \\(.applicationName)"',
     "App Shortcut phrases localize through an AppShortcuts catalog, which comes with a second language"),
    ("Sources/AppRuntime.swift", '"Simulator Apple sign-in requires the local model server."',
     "the simulator's Apple sign-in, which no person meets"),
]


def shape(text):
    return SPECIFIER.sub(PLACEHOLDER, text)


def copy_like(text):
    return bool(WORD.search(text.replace(PLACEHOLDER, " "))) and not IDENTIFIER.search(text.replace(PLACEHOLDER, "x").strip())


# The lines a shipped build leaves out, inside `#if DEBUG` or `#if targetEnvironment(simulator)`.
def dev_lines(source):
    lines, stack = set(), []
    for number, text in enumerate(source.split("\n"), 1):
        directive = text.strip()
        dev = ("DEBUG" in directive or "targetEnvironment(simulator)" in directive) and "!" not in directive
        if directive.startswith("#if "):
            stack.append(dev)
        elif directive.startswith("#elseif") and stack:
            stack[-1] = dev
        elif directive.startswith("#else") and stack:
            stack[-1] = False
        elif directive.startswith("#endif") and stack:
            stack.pop()
        if any(stack):
            lines.add(number)
    return lines


# The bracket a token at `index` stands in, by index, and the label of the argument or dictionary entry it belongs to.
def enclosing(items, index):
    depth, start = 0, None
    for back in range(index - 1, -1, -1):
        value = items[back].value
        if value in (")", "]", "}"):
            depth += 1
        elif value in ("(", "[", "{") and depth:
            depth -= 1
        elif value in ("(", "[", "{"):
            start = back + 1 if start is None else start
            labelled = start < index and items[start + 1].value == ":"
            return back, (items[start].text or items[start].value) if labelled else None
        elif value == "," and depth == 0 and start is None:
            start = back + 1
    return None, None


def callee(items, opener):
    return items[opener - 1].value if opener and items[opener].value == "(" else None


def handed_to_a_name(items, opener, label):
    return opener is not None and (callee(items, opener) in NOT_COPY_CALLS or label in NOT_COPY_LABELS)


# Whether the literal at `index` names rather than says: it is handed to a call or a label that names, directly or inside
# a collection, it is a key of a dictionary or a subscript, a side of a comparison, a `case` pattern or raw value, or a
# value set to a property that names.
def names(items, index):
    opener, label = enclosing(items, index)
    if handed_to_a_name(items, opener, label):
        return True
    if opener is not None and items[opener].value == "[":
        subscript = opener > 0 and items[opener - 1].value not in OPENS_LITERAL
        key = items[index - 1].value in ("[", ",") and index + 1 < len(items) and items[index + 1].value == ":"
        if subscript or key or handed_to_a_name(items, *enclosing(items, opener)):
            return True
    before = [item.value for item in items[max(0, index - 2):index]]
    after = [item.value for item in items[index + 1:index + 3]]
    if before[-2:] in (["=", "="], ["!", "="], ["~", "="]) or after in (["=", "="], ["!", "="]):
        return True
    if before[-1:] == ["="] and index > 1 and items[index - 2].value in NOT_COPY_LABELS:
        return True
    depth = 0
    for back in range(index - 1, -1, -1):
        value = items[back].value
        depth += (value in (")", "]")) - (value in ("(", "["))
        if depth < 0 or (depth == 0 and value in STATEMENT_ENDS):
            return False
        if depth == 0 and value == "case":
            return True
    return False


# Each literal a person could read that is no key of `keys`, and each String(localized:) that interpolates an Int outside
# `Locale.copy`: (line, problem).
def violations(source, keys, integer_keys, skip=frozenset()):
    found = []

    def scan(items):
        for index, item in enumerate(items):
            for inner in item.inside:
                scan(inner)
            if item.text is None or item.line in skip or not copy_like(item.text) or names(items, index):
                continue
            written = shape(item.text).replace(PLACEHOLDER, "%@")
            if shape(item.text) not in keys:
                found.append((item.line, f"{written!r} is no key of its bundle's String Catalog; localize it and run "
                                         f"python3 Tools/string_catalogs.py"))
                continue
            opener, label = enclosing(items, index)
            if label == "localized" and callee(items, opener) == "String" and shape(item.text) in integer_keys:
                depth, arguments = 0, []
                for token in items[opener:]:
                    depth += (token.value == "(") - (token.value == ")")
                    arguments.append(token.value)
                    if depth == 0:
                        break
                if not any(arguments[at:at + 4] == ["locale", ":", ".", "copy"] for at in range(len(arguments))):
                    found.append((item.line, f"{written!r} interpolates an Int: resolve it with locale: .copy"))

    scan(tokens(source))
    return found


def check(app):
    for root in SOURCE_ROOTS:
        if not (app / root).is_dir():
            raise ValueError(f"Missing shipped source directory: {app / root}")
    catalogs = {path: list(json.loads((app / path).read_text())["strings"]) for path in CATALOGS}
    failures, allowed, used = [], [], set()
    for root in SOURCE_ROOTS:
        for path in sorted((app / root).rglob("*.swift")):
            relative = path.relative_to(app).as_posix()
            if DEV_FILES.search(relative):
                continue
            bundles = [catalogs[catalog] for catalog, folders in CATALOGS.items() if any(relative.startswith(folder + "/") for folder in folders)]
            keys = set.intersection(*({shape(key) for key in strings} for strings in bundles))
            written = [key for strings in bundles for key in strings]
            integer_keys = {shape(key) for key in written if INTEGER.search(key)} - {shape(key) for key in written if not INTEGER.search(key)}
            text = path.read_text()
            lines = text.split("\n")
            for line, problem in violations(text, keys, integer_keys, frozenset(dev_lines(text))):
                allowance = next((entry for entry in ALLOWED if relative == entry[0] and entry[1] in lines[line - 1]), None)
                if allowance:
                    used.add(allowance)
                    allowed.append(f"{relative}:{line}: allowed: {allowance[2]}")
                    continue
                failures.append(f"{path}:{line}: error: {problem}")
    for entry in ALLOWED:
        if entry not in used and (app / entry[0]).is_file():
            failures.append(f"{app / entry[0]}: error: allowlisted English no longer appears: {entry[1]}")
    if failures:
        raise ValueError("\n".join(failures))
    return list(dict.fromkeys(allowed))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    if os.environ.get(SYNC) == "YES":
        print("Copy literal check skipped: string_catalogs.py syncs the catalogs from this build.")
        return
    try:
        allowed = check(args.source.resolve())
    except (OSError, ValueError) as error:
        raise SystemExit(str(error))
    for line in allowed:
        print(line)
    print("Copy literal check passed: every literal a person reads is a key of its bundle's String Catalog.")


if __name__ == "__main__":
    main()
