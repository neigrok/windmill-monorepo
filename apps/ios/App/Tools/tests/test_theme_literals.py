from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


sys.path.insert(0, str(Path(__file__).parents[1]))
import check_theme_literals


class ThemeLiteralTests(unittest.TestCase):
    def test_rejects_numeric_colour_construction_and_aliases(self):
        examples = [
            "let paint = Color(red: 0.3, green: 0.7, blue: 0.6)",
            "let paint = SwiftUI.Color(\n .sRGB,\n red: 19 / 255,\n green: 122 / 255,\n blue: 108 / 255\n)",
            "let paint = UIColor { _ in UIColor(red: 0, green: 0, blue: 0, alpha: 1) }",
            "let paint: Color = .init(red: 0.2, green: 0.4, blue: 0.6)",
            "let paint: UIColor = .init(white: 0.5, alpha: 1)",
            "let paint = Color.init(hue: 0.4, saturation: 0.5, brightness: 0.6)",
            "let paint = UIColor(displayP3Red: 0.1, green: 0.2, blue: 0.3, alpha: 1)",
            "let paint = CGColor(gray: 0.3, alpha: 1)",
            "let paint = CGColor(colorSpace: space, components: [0.2, 0.3, 0.4, 1])",
            "typealias Paint = SwiftUI.Color\nlet paint = Paint(red: 0.1, green: 0.2, blue: 0.3)",
            "let red = 0.3\nlet green = 0.7\nlet blue = 0.6\nlet paint = Color(red: red, green: green, blue: blue)",
            "let paint = Color(red: External.red, green: External.green, blue: External.blue)",
            "let paint: Color =\n .init(red: External.red, green: External.green, blue: External.blue)",
            "let channels = [0.2, 0.3, 0.4, 1]\nlet paint = CGColor(colorSpace: space, components: channels)",
            "let paint = #colorLiteral(red: 0, green: 0, blue: 0, alpha: 1)",
        ]
        for example in examples:
            with self.subTest(source=example):
                self.assertTrue(check_theme_literals.violations(example))

    def test_rejects_hex_calls_ramps_and_helpers(self):
        examples = [
            "let paint = Color(hex: 0x5fcdb4)",
            "let paint: Color = .init(hex: value)",
            "let paint = Color(hex: palette[index]).opacity(0.2)",
            "let paint = Color(hex: \"#5FCDB4\")",
            "let paint = palette.color(0x5fcdb4, 0x137a6c)",
            "let paint = colour(dark: 0x5fcdb4, light: 0x137a6c)",
            "let moodRamp: [UInt32] = [\n  0x5e4d2e,\n  0x6e5a34\n]",
            "let colors = [0x5fcdb4, 0x137a6c]",
        ]
        for example in examples:
            with self.subTest(source=example):
                self.assertTrue(check_theme_literals.violations(example))

    def test_allows_roles_system_styles_geometry_and_unrelated_business_values(self):
        source = '''
        let roles = [GymPalette.accent, GymPalette.ink]
        let paint = Color(uiColor: .systemBackground)
        let bridge = UIColor(GymPalette.accent)
        let native: Color = .primary
        let clear = Color.clear
        let byteMask = 0xff
        let recordID = 0x123456
        let count = 25
        let retries = [1, 2, 4]
        Rectangle().fill(GymPalette.accent).opacity(0.4).frame(width: 16)
        let text = "Color(red: 0, green: 0, blue: 0)"
        let raw = #"Color(hex: 0xffffff)"#
        let multiline = """
        #colorLiteral(red: 0, green: 0, blue: 0, alpha: 1)
        """
        // Color(hex: 0xffffff)
        /* ignored /* Color(red: 0, green: 0, blue: 0) */ still ignored */
        '''
        self.assertEqual([], check_theme_literals.violations(source))

    def test_reports_exact_lines_after_comments_and_strings(self):
        source = '/* line 1\n line 2 */\nlet text = "hello"\nlet paint = Color(red: 0, green: 0, blue: 0)\n'
        self.assertEqual([(4, "numeric colour components belong in Sources/Theme")], check_theme_literals.violations(source))

    def test_shipped_sources_and_widget_are_scanned_with_only_theme_exempt(self):
        with TemporaryDirectory() as temporary:
            source = Path(temporary)
            for root in check_theme_literals.SOURCE_ROOTS:
                (source / root).mkdir()
            theme = source / "Sources/Theme"
            theme.mkdir()
            (theme / "Palette.swift").write_text("let paint = Color(red: 0.2, green: 0.3, blue: 0.4)")
            (source / "Sources/View.swift").write_text("let paint = GymPalette.accent")
            check_theme_literals.check(source)
            for name in ("Sources/New/View.swift", "WorkoutActivityWidget/Activity.swift", "WorkoutActivityShared/Theme.swift", "Sources/ThemeCopy/Palette.swift"):
                with self.subTest(path=name):
                    path = source / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("let paint = UIColor(red: 0.2, green: 0.3, blue: 0.4, alpha: 1)")
                    with self.assertRaisesRegex(ValueError, re.escape(str(path)) + ":1: error:"):
                        check_theme_literals.check(source)
                    path.unlink()

    def test_missing_source_root_fails_closed(self):
        with TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "Missing shipped source directory"):
                check_theme_literals.check(Path(temporary))

    def test_command_exits_nonzero_for_deliberate_violation_then_passes_after_removal(self):
        with TemporaryDirectory() as temporary:
            source = Path(temporary)
            for root in check_theme_literals.SOURCE_ROOTS:
                (source / root).mkdir()
            path = source / "Sources/Violation.swift"
            path.write_text("let paint = Color(red: 0.2, green: 0.3, blue: 0.4)")
            command = [sys.executable, str(Path(check_theme_literals.__file__)), "--source", str(source)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(1, result.returncode)
            self.assertEqual(f"{path.resolve()}:1: error: numeric colour components belong in Sources/Theme; use a named palette role\n", result.stderr)
            path.unlink()
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(0, result.returncode)
            self.assertEqual("Theme colour literal check passed: 0 literals outside Sources/Theme.\n", result.stdout)


if __name__ == "__main__":
    unittest.main()
