import json
from pathlib import Path
import re
import unittest


APP = Path(__file__).resolve().parents[2]
REPOSITORY = APP.parents[2]
THEME = APP / "Sources/Theme/Theme.xcassets"


def contract_rows():
    contract = (REPOSITORY / "docs/design/ios/ios-redesign.md").read_text()
    return {f"{room}/{role}": (dark, light) for room, role, dark, light in
            re.findall(r"\| `(gym|journal|shell)/([\w-]+)` \| ([^|]+) \| ([^|]+) \|", contract)
            if re.search(r"#[0-9A-F]{6}", dark)}


def luminance(cell):
    hex_colour = re.search(r"#([0-9A-F]{6})", cell)[1]
    channels = [int(hex_colour[index:index + 2], 16) / 255 for index in (0, 2, 4)]
    linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


class ThemeAssetsTests(unittest.TestCase):
    def test_colour_assets_match_the_design_contract_in_both_appearances(self):
        rows = contract_rows()
        assets = sorted(path.parent.name + "/" + path.name.removesuffix(".colorset") for path in THEME.glob("*/*.colorset")
                        if not path.name.startswith("mood-"))
        self.assertTrue(assets)
        for name in assets:
            self.assertIn(name, rows, f"{name} has no row in the design contract")
            entries = json.loads((THEME / (name + ".colorset/Contents.json")).read_text())["colors"]
            self.assertEqual(len(entries), 2, name)
            for appearance, expected in zip(["dark", "light"], rows[name]):
                with self.subTest(role=name, appearance=appearance):
                    entry = next(item for item in entries if
                                 (any(a["value"] == "dark" for a in item.get("appearances", []))) ==
                                 (appearance == "dark"))
                    components = entry["color"]["components"]
                    actual = "#" + "".join(f"{int(components[channel], 16):02X}"
                                            for channel in ["red", "green", "blue"])
                    self.assertEqual(actual, re.search(r"#[0-9A-F]{6}", expected)[0])
                    alpha = re.search(r"(\d+) %", expected)
                    self.assertEqual(float(components["alpha"]), int(alpha[1]) / 100 if alpha else 1)

    def test_each_room_accent_and_the_danger_text_read_at_four_and_a_half_to_one_on_their_grounds(self):
        rows = contract_rows()
        for accent, grounds in [("gym/accent", ["canvas", "card", "raised", "on-accent"]),
                                ("shell/brand", ["canvas", "card", "raised", "on-brand"]),
                                ("shell/danger", ["canvas", "card", "raised"]),
                                ("journal/lamp", ["canvas", "card"])]:
            room = accent.split("/")[0]
            for ground in grounds:
                for appearance, column in [("dark", 0), ("light", 1)]:
                    with self.subTest(accent=accent, ground=ground, appearance=appearance):
                        lighter, darker = sorted([luminance(rows[accent][column]),
                                                  luminance(rows[f"{room}/{ground}"][column])], reverse=True)
                        ratio = (lighter + 0.05) / (darker + 0.05)
                        self.assertGreaterEqual(ratio, 4.5, f"{accent} on {room}/{ground} in {appearance}: {ratio:.2f}:1")

    def test_palettes_name_exactly_the_theme_colour_sets(self):
        palettes = (APP / "Sources/Theme/Palettes.swift").read_text()
        named = set(re.findall(r'Color\("((?:gym|journal|shell)/[\w-]+)"\)', palettes))
        named |= {f"journal/mood-{step}" for step in range(11)} if "journal/mood-\\(" in palettes else set()
        assets = {path.parent.name + "/" + path.name.removesuffix(".colorset") for path in THEME.glob("*/*.colorset")}
        self.assertEqual(named, assets)

    def test_alpha_is_a_normalized_decimal_instead_of_a_byte(self):
        for catalogue in (THEME, APP / "Resources/Assets.xcassets"):
            for path in catalogue.rglob("*.colorset/Contents.json"):
                for entry in json.loads(path.read_text())["colors"]:
                    with self.subTest(asset=str(path)):
                        self.assertRegex(entry["color"]["components"]["alpha"], r"^(0\.\d+|1\.0+)$")

    def test_launch_uses_the_shell_canvas_and_widget_compiles_only_the_theme(self):
        project = (APP / "project.yml").read_text()
        self.assertIn("UIColorName: shell/canvas", project)
        widget = project.split("  WindmillWorkoutActivity:\n", 1)[1].split("  WindmillTests:\n", 1)[0]
        self.assertIn("      - path: Sources/Theme\n", widget)
        self.assertNotIn("Resources", widget)
        groups = lambda catalogue: sorted(path.name for path in catalogue.iterdir() if path.is_dir() and not path.suffix)
        self.assertEqual(["gym", "journal", "shell"], groups(THEME))
        self.assertEqual(["onboarding"], groups(APP / "Resources/Assets.xcassets"))
