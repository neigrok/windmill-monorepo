import argparse
from dataclasses import dataclass
from pathlib import Path
import sys

# domain-kit.md §10.1: the app and WindmillKit build with warnings as errors but deprecations (§2.4 item 3). A warning that
# survives is one a `@preconcurrency` declaration or import downgraded, which warnings as errors leave a warning; on Swift 6.4
# that is how a closure off the main actor reaches a held draft with no error and no runtime check. So the gate reads the
# compiler's serialized diagnostics and refuses every warning from our sources but a deprecation.
KEPT_GROUPS = {"DeprecatedDeclaration"}
OUR_SOURCES = [Path(__file__).resolve().parents[1], Path(__file__).resolve().parents[2] / "WindmillKit"]

SEVERITY_WARNING = 2
BLOCK_INFO, BLOCK_DIAGNOSTICS = 0, 9
RECORD_SET_BLOCK, RECORD_DIAGNOSTIC, RECORD_CATEGORY, RECORD_FILENAME = 1, 2, 5, 6
CHAR6 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._"


@dataclass(frozen=True, order=True)
class Diagnostic:
    file: str
    line: int
    column: int
    severity: int
    group: str
    message: str

    def __str__(self):
        return f"{self.file}:{self.line}:{self.column}: [{self.group or 'no group'}] {self.message}"


class Bitstream:
    def __init__(self, data):
        self.data, self.position = data, 0

    def fixed(self, width):
        value = 0
        for index in range(width):
            bit = self.position + index
            value |= ((self.data[bit >> 3] >> (bit & 7)) & 1) << index
        self.position += width
        return value

    def vbr(self, width):
        value, shift = 0, 0
        while True:
            piece = self.fixed(width)
            value |= (piece & ((1 << (width - 1)) - 1)) << shift
            shift += width - 1
            if not piece >> (width - 1):
                return value

    def align(self):
        self.position = (self.position + 31) & ~31

    def blob(self, size):
        self.align()
        start = self.position >> 3
        self.position += size * 8
        value = self.data[start:start + size]
        self.align()
        return value

    def exhausted(self):
        return self.position >= len(self.data) * 8


# The records of an LLVM bitstream file, as (block, code, operands, blob), with each block's abbreviations applied.
def records(data):
    bits = Bitstream(data)
    shared = {}
    blocks = [(2, [], None)]
    described = None
    while not bits.exhausted() and blocks:
        width, abbreviations, block = blocks[-1]
        code = bits.fixed(width)
        if code == 0:
            bits.align()
            blocks.pop()
        elif code == 1:
            entered, entered_width = bits.vbr(8), bits.vbr(4)
            bits.align()
            bits.fixed(32)
            blocks.append((entered_width, list(shared.get(entered, [])), entered))
        elif code == 2:
            definition = abbreviation(bits)
            (shared.setdefault(described, []) if block == BLOCK_INFO else abbreviations).append(definition)
        elif code == 3:
            record, count = bits.vbr(6), bits.vbr(6)
            operands = [bits.vbr(6) for _ in range(count)]
            if block == BLOCK_INFO and record == RECORD_SET_BLOCK:
                described = operands[0]
            yield block, record, operands, None
        else:
            values, blob = abbreviated(bits, abbreviations[code - 4])
            yield block, values[0], values[1:], blob


def abbreviation(bits):
    operands = []
    for _ in range(bits.vbr(5)):
        if bits.fixed(1):
            operands.append(("literal", bits.vbr(8)))
            continue
        encoding = bits.fixed(3)
        width = bits.vbr(5) if encoding in (1, 2) else None
        operands.append(({1: "fixed", 2: "vbr", 3: "array", 4: "char6", 5: "blob"}[encoding], width))
    return operands


def abbreviated(bits, operands):
    def scalar(kind, width):
        if kind == "literal":
            return width
        if kind == "fixed":
            return bits.fixed(width)
        if kind == "vbr":
            return bits.vbr(width)
        return CHAR6[bits.fixed(6)]

    values, blob, index = [], None, 0
    while index < len(operands):
        kind, width = operands[index]
        if kind == "array":
            element = operands[index + 1]
            values.extend(scalar(*element) for _ in range(bits.vbr(6)))
            index += 2
        elif kind == "blob":
            blob = bits.blob(bits.vbr(6))
            index += 1
        else:
            values.append(scalar(kind, width))
            index += 1
    return values, blob


# One .dia file: [severity, file, line, column, offset, category, flag, size] per diagnostic, the category naming its group.
def diagnostics(path):
    data = path.read_bytes()
    if data[:4] != b"DIAG":
        raise ValueError(f"{path} is not a serialized diagnostics file")
    files, groups = {}, {}
    for block, record, operands, blob in records(data[4:]):
        if block != BLOCK_DIAGNOSTICS:
            continue
        if record == RECORD_FILENAME:
            files[operands[0]] = blob.decode()
        elif record == RECORD_CATEGORY:
            groups[operands[0]] = blob.decode().split("@", 1)[0]
        elif record == RECORD_DIAGNOSTIC:
            severity, file, line, column, _, category = operands[:6]
            yield Diagnostic(files.get(file, ""), line, column, severity, groups.get(category, ""), blob.decode())


def kept_warnings(roots, sources):
    files = sorted(path for root in roots for path in ([root] if root.is_file() else root.rglob("*.dia")))
    found = set()
    for path in files:
        for diagnostic in diagnostics(path):
            source = Path(diagnostic.file).resolve()
            ours = any(source.is_relative_to(directory) for directory in sources)
            if ours and diagnostic.severity == SEVERITY_WARNING and diagnostic.group not in KEPT_GROUPS:
                found.add(diagnostic)
    return len(files), sorted(found)


def main():
    parser = argparse.ArgumentParser(description="Fail on any warning but a deprecation that a build kept from our sources.")
    parser.add_argument("builds", nargs="+", type=Path, help="Derived data, a .build directory or .dia files.")
    parser.add_argument("--sources", action="append", type=Path, help="A directory whose files count as ours; the app and WindmillKit by default.")
    arguments = parser.parse_args()
    sources = [directory.resolve() for directory in arguments.sources or OUR_SOURCES]
    read, found = kept_warnings(arguments.builds, sources)
    if read == 0:
        raise SystemExit(f"No serialized diagnostics under {', '.join(map(str, arguments.builds))}.")
    for diagnostic in found:
        print(diagnostic)
    if found:
        raise SystemExit(f"{len(found)} warning(s) kept from our sources, in {read} diagnostics files.")
    print(f"No warning kept from our sources, in {read} diagnostics files.")


if __name__ == "__main__":
    sys.exit(main())
