import contextlib
import importlib.util
import io
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
import textwrap
import unittest
from unittest.mock import patch


def load_gate():
    path = Path(__file__).parents[1] / "warning_gate.py"
    spec = importlib.util.spec_from_file_location("warning_gate", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@unittest.skipUnless(shutil.which("xcrun"), "the gate reads what the Xcode toolchain's compiler serializes")
class WarningGateTests(unittest.TestCase):
    source = textwrap.dedent("""\
        import Foundation

        nonisolated final class Box { var value = 0 }

        final class Model {
          var count = 0
          @available(*, deprecated) func old() {}
          func kept() { old() }
          func race() { DispatchQueue.global().async { self.count += 1 } }
          func copy() { let box = Box(); Thread { box.value += 1 }.start() }
        }
        """)

    def setUp(self):
        self.gate = load_gate()
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.build = self.root / "build"
        self.build.mkdir()

    # Compiled as the app compiles its sources: main actor by default, warnings as errors but deprecations.
    def compile(self, relative):
        source = self.root / relative
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(self.source)
        compiled = subprocess.run(["xcrun", "swiftc", "-swift-version", "6", "-parse-as-library", "-default-isolation", "MainActor",
                                   "-warnings-as-errors", "-Wwarning", "DeprecatedDeclaration", "-typecheck", str(source),
                                   "-Xfrontend", "-serialize-diagnostics-path", "-Xfrontend", str(self.build / f"{source.stem}.dia")],
                                  capture_output=True, text=True, timeout=300)
        self.assertEqual(0, compiled.returncode, f"needs the pinned Xcode's compiler (DEVELOPER_DIR):\n{compiled.stderr[-2000:]}")

    def run_gate(self, *arguments):
        output = io.StringIO()
        with patch("sys.argv", ["warning_gate.py", *map(str, arguments)]), contextlib.redirect_stdout(output):
            try:
                self.gate.main()
                return 0, output.getvalue()
            except SystemExit as exit:
                return exit.code, output.getvalue()

    def test_every_kept_warning_but_a_deprecation_from_our_sources_fails(self):
        self.compile("App/Sources/Ours.swift")
        self.compile("Other/Theirs.swift")
        status, output = self.run_gate("--sources", self.root / "App", self.build)
        ours = self.root / "App/Sources/Ours.swift"
        self.assertEqual("2 warning(s) kept from our sources, in 2 diagnostics files.", status)
        self.assertEqual([
            f"{ours}:9:53: [no group] main actor-isolated property 'count' can not be mutated from a Sendable closure",
            f"{ours}:10:43: [SendableClosureCaptures] capture of 'box' with non-Sendable type 'Box' in a '@Sendable' closure",
        ], output.splitlines())

    def test_a_build_with_only_deprecations_passes(self):
        self.compile("Other/Theirs.swift")
        status, output = self.run_gate("--sources", self.root / "App", self.build)
        self.assertEqual((0, "No warning kept from our sources, in 1 diagnostics files.\n"), (status, output))

    def test_a_folder_without_diagnostics_is_refused(self):
        status, output = self.run_gate(self.build)
        self.assertEqual((f"No serialized diagnostics under {self.build}.", ""), (status, output))

    def test_a_file_that_is_not_serialized_diagnostics_is_refused(self):
        (self.build / "broken.dia").write_bytes(b"BC\xc0\xde")
        with self.assertRaisesRegex(ValueError, "is not a serialized diagnostics file"):
            self.run_gate(self.build)


if __name__ == "__main__":
    unittest.main()
