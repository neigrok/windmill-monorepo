#!/usr/bin/env python3
# Prints the range table of domain-kit's Collation.kt from https://www.unicode.org/Public/<version>/ucd/extracted/DerivedCombiningClass.txt.
import sys


def combining_scalars(lines):
    for line in lines:
        fields = line.split("#")[0].split(";")
        if len(fields) == 2 and int(fields[1]) != 0:
            first, _, last = fields[0].strip().partition("..")
            yield from range(int(first, 16), int(last or first, 16) + 1)


def ranges(scalars):
    merged = []
    for scalar in sorted(scalars):
        if merged and merged[-1][1] == scalar - 1:
            merged[-1][1] = scalar
        else:
            merged.append([scalar, scalar])
    return merged


def main(path):
    with open(path, encoding="utf-8") as ucd:
        literals = [f"0x{first:04X}..0x{last:04X}" for first, last in ranges(combining_scalars(ucd))]
    for at in range(0, len(literals), 6):
        print("        " + ", ".join(literals[at:at + 6]) + ",")


if __name__ == "__main__":
    main(sys.argv[1])
