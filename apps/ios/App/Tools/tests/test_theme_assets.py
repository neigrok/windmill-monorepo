import json
from pathlib import Path
import re
import unittest


APP = Path(__file__).resolve().parents[2]
REPOSITORY = APP.parents[2]


class ThemeAssetsTests(unittest.TestCase):
    def test_colour_assets_match_the_design_contract_in_both_appearances(self):
        contract = (REPOSITORY / "docs/design/ios/ios-redesign.md").read_text()
        rows = re.findall(r"\| `(gym|journal|shell)/([\w-]+)` \| ([^|]+) \| ([^|]+) \|", contract)
        checked = 0
        for room, role, dark, light in rows:
            if not re.search(r"#[0-9A-F]{6}", dark):
                continue
            path = APP / "Resources/Assets.xcassets" / room / (role + ".colorset/Contents.json")
            entries = json.loads(path.read_text())["colors"]
            self.assertEqual(len(entries), 2, str(path))
            for appearance, expected in [("light", light), ("dark", dark)]:
                with self.subTest(role=f"{room}/{role}", appearance=appearance):
                    entry = next(item for item in entries if
                                 (any(a["value"] == "dark" for a in item.get("appearances", []))) ==
                                 (appearance == "dark"))
                    components = entry["color"]["components"]
                    actual = "#" + "".join(f"{int(components[channel], 16):02X}"
                                            for channel in ["red", "green", "blue"])
                    self.assertEqual(actual, re.search(r"#[0-9A-F]{6}", expected)[0])
                    alpha = re.search(r"(\d+) %", expected)
                    self.assertEqual(float(components["alpha"]), int(alpha[1]) / 100 if alpha else 1)
            checked += 1
        self.assertEqual(checked, 42)

    def test_launch_uses_the_shell_canvas_and_widget_compiles_the_same_theme(self):
        project = (APP / "project.yml").read_text()
        self.assertIn("UIColorName: shell/canvas", project)
        widget = project.split("  WindmillWorkoutActivity:\n", 1)[1].split("  WindmillTests:\n", 1)[0]
        self.assertIn("      - path: Sources/Theme\n", widget)
        self.assertIn("      - path: Resources/Assets.xcassets\n", widget)
        self.assertFalse((APP / "Resources/Assets.xcassets/ShellCanvas.colorset").exists())
