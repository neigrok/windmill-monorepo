import argparse
from dataclasses import dataclass
from pathlib import Path
import re


SOURCE_ROOTS = ("Sources", "WorkoutActivityWidget", "WorkoutActivityShared")
COLOUR_TYPES = {"Color", "UIColor", "NSColor", "CGColor", "CIColor"}
COMPONENTS = {"red", "displayP3Red", "green", "blue", "white", "gray", "hue", "saturation", "brightness", "components"}
TOKEN = re.compile(r"0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:[0-9][0-9_]*(?:\.[0-9_]+)?|\.[0-9]+)(?:[eE][+-]?[0-9_]+)?|[A-Za-z_][\w]*|\$[0-9]+|\S")
COLOUR_NAME = re.compile(r"color|colour|palette|ramp|tint|accent|canvas|ink|lamp", re.IGNORECASE)


@dataclass(frozen=True)
class Token:
    value: str
    line: int
    number: bool = False


def tokens(source):
    result = []
    index = 0
    line = 1
    while index < len(source):
        if source.startswith("//", index):
            end = source.find("\n", index)
            index = len(source) if end == -1 else end
            continue
        if source.startswith("/*", index):
            depth = 1
            index += 2
            while depth and index < len(source):
                if source.startswith("/*", index):
                    depth += 1
                    index += 2
                elif source.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    line += source[index] == "\n"
                    index += 1
            continue
        literal = re.match(r'(#+)?("""|")', source[index:])
        if literal:
            hashes = literal.group(1) or ""
            quote = literal.group(2)
            end_marker = quote + hashes
            index += len(literal.group())
            while index < len(source):
                if source.startswith("\\" + hashes, index):
                    escaped = len(hashes) + 2
                    line += source[index:index + escaped].count("\n")
                    index += escaped
                elif source.startswith(end_marker, index):
                    index += len(end_marker)
                    break
                else:
                    line += source[index] == "\n"
                    index += 1
            result.append(Token('"string"', line))
            continue
        if source[index].isspace():
            line += source[index] == "\n"
            index += 1
            continue
        match = TOKEN.match(source, index)
        value = match.group()
        result.append(Token(value, line, value[0].isdigit() or (value.startswith(".") and len(value) > 1)))
        index = match.end()
    return result


def expressions(items):
    groups = []
    start = 0
    depth = 0
    for index, item in enumerate(items):
        if item.value in ("(", "[", "{"):
            depth += 1
        elif item.value in (")", "]", "}"):
            depth -= 1
        elif item.value == "," and depth == 0:
            groups.append(items[start:index])
            start = index + 1
    groups.append(items[start:])
    return groups


def violations(source):
    items = tokens(source)
    bindings = {}
    colour_types = set(COLOUR_TYPES)
    issues = set()
    for index, item in enumerate(items):
        if item.value == "typealias" and index + 3 < len(items) and items[index + 2].value == "=":
            target = items[index + 3:index + 6]
            if any(token.value in colour_types for token in target):
                colour_types.add(items[index + 1].value)
        if item.value not in ("let", "var") or index + 2 >= len(items):
            continue
        name = items[index + 1].value
        end = index + 2
        while end < len(items) and items[end].line == item.line and items[end].value not in ("=", "{", ";"):
            end += 1
        if end == len(items) or items[end].value != "=":
            continue
        start = end + 1
        end = start
        depth = 0
        while end < len(items):
            token = items[end]
            if depth == 0 and (token.value in (";", "}") or (end > start and token.line > items[end - 1].line)):
                break
            if token.value in ("(", "[", "{"):
                depth += 1
            elif token.value in (")", "]", "}"):
                depth -= 1
            end += 1
        bindings[name] = items[start:end]
        if COLOUR_NAME.search(name):
            for token in bindings[name]:
                if token.value.lower().startswith("0x"):
                    issues.add((token.line, "hex colour ramp belongs in Sources/Theme"))

    def contains_number(expression, seen=frozenset()):
        for token in expression:
            if token.number:
                return True
            if token.value in bindings and token.value not in seen:
                if contains_number(bindings[token.value], seen | {token.value}):
                    return True
        return False

    for index, item in enumerate(items):
        if item.value == "colorLiteral" and index and items[index - 1].value == "#":
            issues.add((item.line, "#colorLiteral belongs in Sources/Theme"))
        if item.value != "(" or index == 0:
            continue
        end = index + 1
        depth = 1
        while end < len(items) and depth:
            depth += (items[end].value == "(") - (items[end].value == ")")
            end += 1
        arguments = expressions(items[index + 1:end - 1])
        labels = {argument[0].value for argument in arguments if len(argument) >= 2 and argument[1].value == ":"}
        name = items[index - 1].value
        colour_constructor = name in colour_types or (name == "init" and index >= 3 and items[index - 3].value in colour_types)
        component_signature = {"green", "blue"}.issubset(labels) or {"hue", "saturation"}.issubset(labels) or ("white" in labels and bool({"alpha", "opacity"} & labels))
        if "hex" in labels and (colour_constructor or name == "init" or COLOUR_NAME.search(name)):
            issues.add((items[index - 1].line, "hex colour construction belongs in Sources/Theme"))
        if colour_constructor or component_signature or (name == "init" and labels & COMPONENTS):
            for argument in arguments:
                if len(argument) >= 2 and argument[1].value == ":" and argument[0].value in COMPONENTS and contains_number(argument[2:]):
                    issues.add((items[index - 1].line, "numeric colour components belong in Sources/Theme"))
        if COLOUR_NAME.search(name):
            for argument in arguments:
                if any(token.value.lower().startswith("0x") for token in argument):
                    issues.add((items[index - 1].line, "hex colour construction belongs in Sources/Theme"))
    return sorted(issues)


def check(source):
    failures = []
    for directory in SOURCE_ROOTS:
        root = source / directory
        if not root.is_dir():
            raise ValueError(f"Missing shipped source directory: {root}")
        for path in sorted(root.rglob("*.swift")):
            if path.is_relative_to(source / "Sources/Theme"):
                continue
            for line, message in violations(path.read_text()):
                failures.append(f"{path}:{line}: error: {message}; use a named palette role")
    if failures:
        raise ValueError("\n".join(failures))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        check(args.source.resolve())
    except (OSError, ValueError) as error:
        raise SystemExit(str(error))
    print("Theme colour literal check passed: 0 literals outside Sources/Theme.")
