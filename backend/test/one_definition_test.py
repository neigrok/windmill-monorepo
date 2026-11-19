import os
from pathlib import Path
import re
import sys
import tempfile
import unittest

# One binary links the platform and every product, so a class defined in two files under one qualified name breaks the
# one-definition rule: the linker keeps one copy of the inline code both share (a constructor, a std::optional of it)
# and the other's callers run it on their own layout. Nothing reports it; a build that does not inline that code
# corrupts memory. Every class and struct at namespace scope, outside an anonymous namespace, is therefore defined in
# one file of the sources.

SOURCES = ("platform", "products")
NAMESPACE = re.compile(r"^\s*(?:inline\s+)?namespace\s*([\w:]*)\s*\{")
DEFINITION = re.compile(r"^\s*(?:struct|class)\s+([A-Za-z_]\w*)\s*(?:final\s*)?(?::(?!:)[^;{]*)?\{")


def definitions(backend):
    found = {}
    for top in SOURCES:
        for path in sorted((backend / top).rglob("*")):
            if path.suffix not in (".h", ".cpp"):
                continue
            scopes = []  # a namespace's name, or None for any other brace
            for line in path.read_text(errors="replace").splitlines():
                code = re.sub(r'"(?:\\.|[^"\\])*"', '""', re.sub(r"//.*", "", line))
                opened = NAMESPACE.match(code)
                defined = DEFINITION.match(code)
                if opened:
                    scopes.append(opened.group(1) or "")
                    code = code[code.index("{") + 1:]
                elif defined and scopes and all(scopes):
                    name = "::".join(scopes + [defined.group(1)])
                    found.setdefault(name, set()).add(path.relative_to(backend).as_posix())
                for brace in re.findall(r"[{}]", code):
                    if brace == "{":
                        scopes.append(None)
                    elif scopes:
                        scopes.pop()
    return {name: sorted(files) for name, files in found.items() if len(files) > 1}


class OneDefinitionTest(unittest.TestCase):
    def test_every_class_of_the_backend_is_defined_in_one_file(self):
        self.assertEqual(definitions(Path(__file__).resolve().parents[1]), {})

    def test_a_name_defined_in_two_files_is_named_with_both(self):
        with tempfile.TemporaryDirectory(prefix="one-definition-") as directory:
            backend = Path(directory)
            files = {
                "products/journal/domain/Page.h": "namespace wm {\nstruct Page {\n  int day;\n};\n}\n",
                "products/roadmap/ReadShape.h": "namespace wm {\nstruct Page {\n  long begin;\n};\n"
                                                "struct Shape { struct Page { int inner; }; };\n}\n",
                "products/roadmap/Door.cpp": "namespace wm {\nnamespace {\nstruct Page {\n  int local;\n};\n}\n"
                                             "class Door::Page final : public Base {};\n}\n",
                "platform/Pages.h": "namespace wm::sync {\nstruct Page {\n  int rows;\n};\n}\n",
            }
            for name, text in files.items():
                (backend / name).parent.mkdir(parents=True, exist_ok=True)
                (backend / name).write_text(text)
            self.assertEqual(definitions(backend),
                             {"wm::Page": ["products/journal/domain/Page.h", "products/roadmap/ReadShape.h"]})


if __name__ == "__main__":
    unittest.main()
