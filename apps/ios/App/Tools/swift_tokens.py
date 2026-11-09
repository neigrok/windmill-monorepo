from dataclasses import dataclass
from typing import Optional
import re


TOKEN = re.compile(r"0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:[0-9][0-9_]*(?:\.[0-9_]+)?|\.[0-9]+)(?:[eE][+-]?[0-9_]+)?|[A-Za-z_][\w]*|\$[0-9]+|\S")
ESCAPES = {"0": "\0", "\\": "\\", "t": "\t", "n": "\n", "r": "\r", '"': '"', "'": "'"}
# Where a literal's interpolation stands in its text: `"\(count) sets"` reads "\x00 sets".
PLACEHOLDER = "\x00"


# A Swift token. A string literal's value is `"string"`; its text holds the literal as written out, each interpolation a
# placeholder, and `inside` the tokens of each interpolation, in order.
@dataclass(frozen=True)
class Token:
    value: str
    line: int
    text: Optional[str] = None
    inside: tuple = ()


def literal(source, index, line, hashes, quote):
    end, escape = quote + hashes, "\\" + hashes
    text, inside, start = [], [], line
    while index < len(source):
        if source.startswith(end, index):
            index += len(end)
            break
        if source.startswith(escape + "(", index):
            parts, index, line = tokens(source, index + len(escape) + 1, line, closing=True)
            inside.append(tuple(parts))
            text.append(PLACEHOLDER)
            continue
        if source.startswith(escape, index):
            index += len(escape)
            if source.startswith("u{", index):
                close = source.index("}", index)
                text.append(chr(int(source[index + 2:close], 16)))
                index = close + 1
            elif source[index] == "\n":
                line += 1
                index += 1
            else:
                text.append(ESCAPES.get(source[index], source[index]))
                index += 1
            continue
        line += source[index] == "\n"
        text.append(source[index])
        index += 1
    written = "".join(text)
    if quote == '"""':
        lines = written.split("\n")
        indent = lines[-1] if not lines[-1].strip() else ""
        written = "\n".join(part[len(indent):] if part.startswith(indent) else part for part in lines[1:-1])
    return Token('"string"', start, written, tuple(inside)), index, line


# The tokens of `source` from `index`, comments dropped. With `closing`, the tokens of an interpolation: up to the parenthesis
# that closes it, answered with the index and line after it.
def tokens(source, index=0, line=1, closing=False):
    result, depth = [], 0
    while index < len(source):
        if source.startswith("//", index):
            end = source.find("\n", index)
            index = len(source) if end == -1 else end
            continue
        if source.startswith("/*", index):
            nesting = 1
            index += 2
            while nesting and index < len(source):
                if source.startswith("/*", index):
                    nesting += 1
                    index += 2
                elif source.startswith("*/", index):
                    nesting -= 1
                    index += 2
                else:
                    line += source[index] == "\n"
                    index += 1
            continue
        opening = re.match(r'(#*)("""|")', source[index:index + 16])
        if opening:
            token, index, line = literal(source, index + len(opening.group()), line, opening.group(1), opening.group(2))
            result.append(token)
            continue
        if source[index].isspace():
            line += source[index] == "\n"
            index += 1
            continue
        match = TOKEN.match(source, index)
        if closing and match.group() in ("(", ")"):
            depth += 1 if match.group() == "(" else -1
            if depth < 0:
                return result, match.end(), line
        result.append(Token(match.group(), line))
        index = match.end()
    return (result, index, line) if closing else result
