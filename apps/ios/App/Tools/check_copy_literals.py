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
# Files that serve the simulator, never a person: launch fixtures, launch boards and scenarios, the model server's transport.
DEV_FILES = re.compile(r"Fixtures?\.swift$|^Sources/Verification\.swift$|^Sources/JournalModelTransport\.swift$")
SPECIFIER = re.compile(r"%(?:\d+\$)?(?:#@\w+@|[-+ 0#']*\d*(?:\.\d+)?(?:hh|h|ll|l|q|z|t|j)?[@dDiuUxXoOfFeEgGcCsSp])")
INTEGER = re.compile(r"%(?:\d+\$)?(?:ll|l|q)?[dDiuU]")
WORD = re.compile(r"[^\W\d_]{2}")
# Words with a space between them: a raw value that reads like this is copy, not a wire value.
WORDS = re.compile(r"[^\W\d_]\s+[^\W\d_]")
# A receiver whose calls log: `logger.error(…)`, `Self.log.debug(…)`.
LOGGER = re.compile(r"(?i)^(logger|log)$")
# Text that names rather than says: a lowercase word, an identifier, a constant, a path, a URL, a file or a font.
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
    "NSLog", "os_log", "UIFont", "URLQueryItem", "dateFormat",
}
# Argument labels, dictionary and property names whose strings no person reads.
NOT_COPY_LABELS = {
    "identifier", "accessibilityIdentifier", "systemImage", "systemName", "forKey", "properties", "kind", "screen", "action",
    "outcome", "door", "operation", "code", "type", "table", "bundle", "comment", "defaultValue", "path", "method",
    "httpMethod", "scheme", "host", "subsystem", "category", "mediaType", "key", "id", "format", "dateFormat", "extension",
    "prefix", "suiteName", "forHTTPHeaderField", "withExtension", "forResource", "ofType", "room", "reason", "field", "source",
    "mode", "debugDescription", "forInfoDictionaryKey", "fromTemplate",
}
# Tokens after which a `[` opens an array or dictionary, not a subscript.
OPENS_LITERAL = {"=", "(", ",", ":", "[", "{", "?", "??", "return", "in", "case", "else", "+", "&&", "||", "throw"}
# Tokens that close the statement a `case` pattern could stand in.
STATEMENT_ENDS = {":", "{", "}", ";", "return", "let", "var", "func", "in", "else", "guard", "if"}

SHORTCUT = "an App Shortcut phrase, which localizes through an AppShortcuts catalog that comes with a second language"
# Each entry is a source path, a literal as the check writes it, and why it may stay English no catalog holds.
ALLOWED = [
    ("WorkoutActivityShared/WorkoutIntents.swift", "Log a set in %@", SHORTCUT),
    ("WorkoutActivityShared/WorkoutIntents.swift", "Log my set in %@", SHORTCUT),
    ("WorkoutActivityShared/WorkoutIntents.swift", "%@ log set", SHORTCUT),
    ("WorkoutActivityShared/WorkoutIntents.swift", "Start a workout in %@", SHORTCUT),
    ("WorkoutActivityShared/WorkoutIntents.swift", "Start my workout in %@", SHORTCUT),
    ("WorkoutActivityShared/WorkoutIntents.swift", "%@ start workout", SHORTCUT),
    ("Sources/AppRuntime.swift", "Simulator Apple sign-in requires the local model server.", "the simulator's Apple sign-in, which no person meets"),
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
            following = [item.value for item in items[start + 1:min(index, start + 4)]]
            labelled = following[:1] == [":"] or (following[:1] == ["as"] and following[2:3] == [":"])
            return back, (items[start].text or items[start].value) if labelled else None
        elif value == "," and depth == 0 and start is None:
            start = back + 1
    return None, None


def callee(items, opener):
    return items[opener - 1].value if opener and items[opener].value == "(" else None


def handed_to_a_name(items, opener, label):
    if opener is None:
        return False
    logged = items[opener].value == "(" and opener > 2 and items[opener - 2].value == "." and LOGGER.match(items[opener - 3].value)
    return bool(logged) or callee(items, opener) in NOT_COPY_CALLS or label in NOT_COPY_LABELS or (label or "").startswith(("kSec", "kCF"))


# Whether the literal at `index` names rather than says, by the call, label, collection, comparison or pattern it stands in;
# an enum's raw value names unless its words have spaces between them.
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
            return not (before[-1:] == ["="] and WORDS.search(items[index].text))
    return False


# Each literal a person could read that is no key, and each String(localized:) whose key counts an Int, alone or beside a
# twin of the same shape, outside Locale.copy: (line, the literal as written, problem).
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
                found.append((item.line, written, f"{written!r} is no key of its bundle's String Catalog; localize it and run "
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
                    found.append((item.line, written, f"{written!r} interpolates an Int: resolve it with locale: .copy"))

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
            integer_keys = {shape(key) for strings in bundles for key in strings if INTEGER.search(key)}
            text = path.read_text()
            for line, written, problem in violations(text, keys, integer_keys, frozenset(dev_lines(text))):
                allowance = next((entry for entry in ALLOWED if relative == entry[0] and written == entry[1]), None)
                if allowance:
                    used.add(allowance)
                    allowed.append(f"{relative}:{line}: allowed {written!r}: {allowance[2]}")
                    continue
                failures.append(f"{path}:{line}: error: {problem}")
    for entry in ALLOWED:
        if entry not in used and (app / entry[0]).is_file():
            failures.append(f"{app / entry[0]}: error: allowlisted English no longer appears: {entry[1]!r}")
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
