import argparse
from dataclasses import dataclass
from pathlib import Path
import re


SOURCE_ROOTS = ("Sources", "WorkoutActivityWidget", "WorkoutActivityShared")
THEME = "Sources/Theme"
PALETTES = "Sources/Theme/Palettes.swift"
COLOUR_TYPES = {"Color", "UIColor", "NSColor", "CGColor", "CIColor"}
COMPONENTS = {"red", "displayP3Red", "green", "blue", "white", "gray", "hue", "saturation", "brightness", "components"}
TOKEN = re.compile(r"0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:[0-9][0-9_]*(?:\.[0-9_]+)?|\.[0-9]+)(?:[eE][+-]?[0-9_]+)?|[A-Za-z_][\w]*|\$[0-9]+|\S")
COLOUR_NAME = re.compile(r"color|colour|palette|ramp|tint|accent|canvas|ink|lamp|rgb|hex|brand", re.IGNORECASE)
NAMED_COLOURS = {"red", "orange", "yellow", "green", "mint", "teal", "cyan", "blue", "indigo", "purple", "pink",
                 "brown", "gray", "grey", "black", "white", "darkGray", "lightGray", "magenta"}
SEMANTIC_COLOUR = re.compile(r"(secondary|tertiary|quaternary)?[sS]ystem[A-Z]\w*$")
LABEL_STYLES = {"primary", "secondary", "tertiary", "quaternary", "quinary"}
STYLE_TYPES = {"Color", "HierarchicalShapeStyle", "ShapeStyle"}
UIKIT_ROLES = {"label", "secondaryLabel", "tertiaryLabel", "quaternaryLabel", "placeholderText", "separator",
               "opaqueSeparator", "link", "lightText", "darkText"}
SHAPE_STYLE_ROLES = {"placeholder", "separator"}
FADES = {"opacity", "withAlphaComponent"}
NUMBER = re.compile(r"(0[xX][0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9_]+)?|\.[0-9]+)$")
FRACTION = re.compile(r"([0-9][0-9_]*)?\.[0-9_]+$")
SPECIMENS = "OnboardingSpecimen"
# A fade is a role (ios-redesign §2): these rules hold in Sources/Theme too, where only Palettes.swift makes fades.
FADE = "a faded colour belongs in Palettes.swift or OnboardingSpecimen as a named role"
MIX = "a mixed colour belongs in Palettes.swift as a named role"
LEVEL = "a hierarchical level of a role or the tint is a fade; name it in Palettes.swift"
FADE_RULES = {FADE, MIX, LEVEL}

# Each entry is a source path, a line fragment and why that line may keep a colour, or a fade, where it stands.
ALLOWED = [
    ("Sources/AccountSheet.swift", "foregroundStyle(colorScheme == .dark ? .black : .white).background(colorScheme == .dark ? .white : .black",
     "Apple's own Continue with Apple control keeps its black and white"),
    ("Sources/AccountSheet.swift", "signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)",
     "Apple's own Continue with Apple control keeps its black and white"),
    ("Sources/OnboardingGlimpses.swift", 'Color("onboarding/',
     "the glimpse's specimen roles stay private to it, as asset colours"),
    ("Sources/Gym/Coach/CoachTransport.swift", "if !png { UIColor.white.setFill()",
     "a JPEG has no alpha, so a photo is flattened onto white before encoding"),
    ("Sources/Gym/Coach/CoachFixtures.swift", "UIColor.white.setFill(); UIRectFill(",
     "the simulator fixture's program screenshot draws another app's page, black on white, in either appearance"),
    ("Sources/Gym/Coach/CoachFixtures.swift", ".foregroundColor: UIColor.black])",
     "the simulator fixture's program screenshot draws another app's page, black on white, in either appearance"),
    ("Sources/Theme/RoomControls.swift", ".opacity(enabled ? 1 : 0.5)",
     "a card's decision dims whole while it cannot be taken, as the boards draw Applying… over a disabled Reject (08.30)"),
    ("WorkoutActivityWidget/WorkoutActivityWidget.swift", ".foregroundStyle(.secondary)",
     "the same view draws on the Island's black and on the lock screen in either appearance; only the system's hierarchy reads on both"),
    ("Sources/Theme/RoomControls.swift", "AnyShapeStyle(room.onAccent) : AnyShapeStyle(.secondary)",
     "a disabled primary takes the system's .secondary label, since on-accent would stand white on the system's disabled fill; WCAG 1.4.3 exempts an inactive control"),
    ("Sources/Theme/RoomControls.swift", ".foregroundStyle(room.ink.tertiary)",
     "DoorChevron is the ink's .tertiary, as the system draws a NavigationLink's chevron"),
    ("Sources/Theme/RoomControls.swift", "Text(subtitle).font(.caption).foregroundStyle(.secondary)",
     "the iOS 18 bar's subtitle keeps the system's label hierarchy, where the system owns the ground"),
    ("Sources/Gym/Coach/CoachTab.swift", ".opacity(dimmed ? 0.4 : 1)",
     "the composer's send circle at 40 % is the one control the room dims while it cannot send; WCAG 1.4.3 exempts an inactive control"),
    ("Sources/AccountSheet.swift", ".disabled(offline).opacity(offline ? 0.4 : 1)",
     "Apple's own Continue with Apple control draws no disabled state, so it dims while offline disables it; WCAG 1.4.3 exempts an inactive control"),
    ("Sources/OnboardingGlimpses.swift", ".stroke(OnboardingSpecimen.openEdge, lineWidth: 2).opacity(reduceMotion ? 0.5 + travel * 0.5 : 1)",
     "the glimpse's one beat: the open edges light as the dot travels, and stand at 1 at rest"),
    ("Sources/OnboardingGlimpses.swift", ".opacity(reduceMotion ? 0.28 : breathing ? 0.18 : 0.28)",
     "the glimpse's one loop: the completed step's halo breathes between 18 % and 28 %"),
    ("Sources/OnboardingGlimpses.swift", ".opacity(index == 1 ? 0.5 + ignition * 0.5 : 1)",
     "the glimpse's one beat: the next step ignites as the dot arrives, and stands at 1 at rest"),
    ("Sources/OnboardingGlimpses.swift", "static let journalPastLine = JournalPalette.inkDim.opacity(0.45)",
     "a specimen role, private to the glimpse: the journal card's written lines in the rooms miniature"),
    ("Sources/OnboardingGlimpses.swift", "static let halo = completed.opacity(0.28)",
     "a specimen role, private to the glimpse: the completed step's halo"),
    ("Sources/OnboardingGlimpses.swift", "static let unasked = JournalPalette.inkFaint.opacity(0.55)",
     "a specimen role, private to the glimpse: the mood and energy scales nobody has answered"),
]


@dataclass(frozen=True)
class Token:
    value: str
    line: int


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
        result.append(Token(value, line))
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


def opening(items, closing):
    depth = 0
    for index in range(closing, -1, -1):
        depth += (items[index].value == ")") - (items[index].value == "(")
        if depth == 0:
            return index
    return -1


def violations(source):
    items = tokens(source)
    colour_types = set(COLOUR_TYPES)
    aliases = set()
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
        # A colour alias: a let or var typed as a colour, or set from a role, a specimen, another alias or a colour's construction.
        if any(token.value in colour_types for token in items[index + 2:end]):
            aliases.add(name)
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
        value = items[start:end]
        calls = {token.value for token, following in zip(value, value[1:]) if following.value == "("}
        if calls & colour_types or any(token.value.endswith("Palette") or token.value in aliases or token.value == SPECIMENS for token in value):
            aliases.add(name)
        if COLOUR_NAME.search(name):
            for token in value:
                if token.value.lower().startswith("0x"):
                    issues.add((token.line, "hex colour ramp belongs in Sources/Theme"))

    for index, item in enumerate(items):
        before = items[index - 1].value if index else ""
        owner = items[index - 2].value if index > 1 else ""
        after = items[index + 1].value if index + 1 < len(items) else ""
        implicit = before == "." and not (owner[:1].isalnum() or owner in (")", "]", "}", "?", "!", "_"))
        explicit = before == "." and owner in colour_types | {"UIColor", "NSColor"}
        if item.value in NAMED_COLOURS and (implicit or explicit):
            issues.add((item.line, "system named colours belong in Sources/Theme"))
        if item.value == "accentColor":
            issues.add((item.line, "the asset accent colour belongs in Sources/Theme"))
        if SEMANTIC_COLOUR.match(item.value) and (implicit or explicit) and after != "(":
            issues.add((item.line, "UIKit semantic colours belong in Sources/Theme"))
        palette_member = before == "." and index > 3 and items[index - 3].value == "." and items[index - 4].value.endswith("Palette")
        specimen = before == "." and index > 3 and items[index - 3].value == "." and items[index - 4].value == SPECIMENS
        colour_value = palette_member or specimen or (before == "." and (owner in aliases or owner in ("tint", "foreground") or bool(COLOUR_NAME.search(owner))))
        if item.value in LABEL_STYLES and after != "(" and before == "." and owner in STYLE_TYPES:
            issues.add((item.line, "the system's label hierarchy belongs in Sources/Theme"))
        elif item.value in LABEL_STYLES and after != "(" and (implicit or colour_value):
            issues.add((item.line, LEVEL))
        if item.value in UIKIT_ROLES and after != "(" and before == "." and owner in ("UIColor", "NSColor"):
            issues.add((item.line, "UIKit semantic colours belong in Sources/Theme"))
        if item.value in UIKIT_ROLES and implicit and index > 2 and items[index - 3].value == "uiColor":
            issues.add((item.line, "UIKit semantic colours belong in Sources/Theme"))
        if item.value in SHAPE_STYLE_ROLES and implicit and after != "(" and not (index > 2 and items[index - 3].value == "reason"):
            issues.add((item.line, "the system's label hierarchy belongs in Sources/Theme"))
        if item.value in FADES and after == "(" and before == ".":
            depth, end, fractions = 1, index + 2, []
            while end < len(items) and depth:
                token = items[end].value
                depth += (token in ("(", "[", "{")) - (token in (")", "]", "}"))
                if depth == 1 and FRACTION.match(token):
                    fractions.append(float(token.replace("_", "")))
                end += 1
            call = opening(items, index - 2) if owner == ")" else -1
            constructed = call > 0 and items[call - 1].value in colour_types
            if colour_value or constructed or any(0 < value < 1 for value in fractions):
                issues.add((item.line, FADE))
        if item.value == "mix" and before == "." and after == "(" and index + 2 < len(items) and items[index + 2].value == "with":
            issues.add((item.line, MIX))
        if item.value in colour_types and after == "(" and index + 2 < len(items) and items[index + 2].value == '"string"':
            issues.add((item.line, "asset colour lookups belong in Sources/Theme"))
        if item.value in ("UIColor", "NSColor") and after == "(" and index + 2 < len(items) and items[index + 2].value == "named":
            issues.add((item.line, "asset colour lookups belong in Sources/Theme"))
        if item.value in ("dark", "light") and before == "." and after == "?":
            depth, end = 0, index + 2
            while end < len(items):
                token = items[end].value
                if token in ("(", "[", "{"):
                    depth += 1
                elif token in (")", "]", "}"):
                    if depth == 0:
                        break
                    depth -= 1
                elif token == ":" and depth == 0:
                    end += 2
                    break
                end += 1
            branch = [token.value for token in items[index + 2:end]]
            if any(value in NAMED_COLOURS or value in colour_types or value.endswith("Palette") or value == "accentColor" for value in branch):
                issues.add((item.line, "appearance branches between colours belong in the asset catalogue"))
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
        if any("hex" in label.lower() or "rgb" in label.lower() for label in labels) and (colour_constructor or name == "init" or COLOUR_NAME.search(name)):
            issues.add((items[index - 1].line, "hex colour construction belongs in Sources/Theme"))
        if colour_constructor and any(len(argument) == 1 and NUMBER.match(argument[0].value) for argument in arguments):
            issues.add((items[index - 1].line, "numeric colour components belong in Sources/Theme"))
        if colour_constructor or component_signature or (name == "init" and labels & COMPONENTS):
            for argument in arguments:
                if len(argument) >= 2 and argument[1].value == ":" and argument[0].value in COMPONENTS:
                    issues.add((items[index - 1].line, "numeric colour components belong in Sources/Theme"))
        if COLOUR_NAME.search(name):
            for argument in arguments:
                if any(token.value.lower().startswith("0x") for token in argument):
                    issues.add((items[index - 1].line, "hex colour construction belongs in Sources/Theme"))
    return sorted(issues)


def check(source):
    failures = []
    allowed = []
    used = set()
    for directory in SOURCE_ROOTS:
        root = source / directory
        if not root.is_dir():
            raise ValueError(f"Missing shipped source directory: {root}")
        for path in sorted(root.rglob("*.swift")):
            relative = path.relative_to(source).as_posix()
            if relative == PALETTES:
                continue
            text = path.read_text()
            lines = text.split("\n")
            theme = path.is_relative_to(source / THEME)
            for line, message in violations(text):
                if theme and message not in FADE_RULES:
                    continue
                allowance = next((entry for entry in ALLOWED if relative == entry[0] and entry[1] in lines[line - 1]), None)
                if allowance:
                    used.add(allowance)
                    allowed.append(f"{relative}:{line}: allowed: {allowance[2]}")
                    continue
                failures.append(f"{path}:{line}: error: {message}; use a named palette role")
    for entry in ALLOWED:
        if entry not in used and (source / entry[0]).is_file():
            failures.append(f"{source / entry[0]}: error: allowlisted colour no longer appears: {entry[1]}")
    if failures:
        raise ValueError("\n".join(failures))
    return list(dict.fromkeys(allowed))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        allowed = check(args.source.resolve())
    except (OSError, ValueError) as error:
        raise SystemExit(str(error))
    for line in allowed:
        print(line)
    print("Theme colour literal check passed: 0 literals outside Sources/Theme, 0 fades outside a named role.")
