import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


sys.path.insert(0, str(Path(__file__).parents[1]))
import check_copy_literals
from check_copy_literals import shape


class CopyLiteralTests(unittest.TestCase):
    def violations(self, source, keys=(), integer_keys=()):
        return check_copy_literals.violations(source, {shape(key) for key in keys}, {shape(key) for key in integer_keys})

    def tree(self, temporary, files, app=(), widget=()):
        source = Path(temporary).resolve()
        for path, strings in (("Resources/Localizable.xcstrings", app), ("WorkoutActivityWidget/Localizable.xcstrings", widget)):
            (source / path).parent.mkdir(parents=True, exist_ok=True)
            (source / path).write_text(json.dumps({"sourceLanguage": "en", "strings": {key: {} for key in strings}, "version": "1.0"}))
        for root in check_copy_literals.SOURCE_ROOTS:
            (source / root).mkdir(parents=True, exist_ok=True)
        for path, text in files.items():
            (source / path).parent.mkdir(parents=True, exist_ok=True)
            (source / path).write_text(text)
        return source

    def test_copy_a_person_reads_must_be_a_key_matched_by_its_placeholders(self):
        source = '\n'.join([
            'Text("Delete note")',
            'GymRow(title: "Read", meta: rows)',
            'let line = count == 1 ? "1 set" : "\\(count) sets"',
            'throw AppFailure(message: "Check the values and try again.")',
            'let title = "Log \\(name)"',
            'RoomTransient(message: "Saved \\(String(localized: "today"))")',
            'Text("\\(count == 1 ? "set" : "Sets") left")',
        ])
        self.assertEqual(self.violations(source, keys=["Delete note", "%lld sets", "Log %@"]), [
            (2, "'Read' is no key of its bundle's String Catalog; localize it and run python3 Tools/string_catalogs.py"),
            (3, "'1 set' is no key of its bundle's String Catalog; localize it and run python3 Tools/string_catalogs.py"),
            (4, "'Check the values and try again.' is no key of its bundle's String Catalog; localize it and run python3 Tools/string_catalogs.py"),
            (6, "'Saved %@' is no key of its bundle's String Catalog; localize it and run python3 Tools/string_catalogs.py"),
            (7, "'Sets' is no key of its bundle's String Catalog; localize it and run python3 Tools/string_catalogs.py"),
            (7, "'%@ left' is no key of its bundle's String Catalog; localize it and run python3 Tools/string_catalogs.py"),
        ])

    def test_names_identifiers_and_wire_values_are_not_copy(self):
        source = '\n'.join([
            'Button("x").accessibilityIdentifier("Save routine")',
            'Image(systemName: "Plus Circle")',
            'telemetry.event("Coach Opened", properties: ["screen": "Coach Tab", "method": "POST"])',
            'gym.report("Gym Read", error)',
            'if state == "Not Applied" || "Done Here" != state { }',
            'switch code { case "Not Found", "Gone Away": break; default: break }',
            'enum Kind: String { case justLog = "Just Log" }',
            'let headers = ["Content Type": value]',
            'let first = table["Row Name"]',
            'String(localized: "Open", comment: "A Plan With No Sets")',
            'String(localized: "echo-day.open", defaultValue: "Open")',
            'request.httpMethod = "POST"; formatter.dateFormat = "EEE d MMM"',
            'DecodingError.Context(codingPath: [], debugDescription: "Invalid Numbers")',
            'let ids = ["gym-log-session-", "works.windmill.app", "lastRoom", "WMSentryDSN", "https://windmill.works", "/v1/sync",',
            '           "Nunito-ExtraBold", "Inter-Regular.ttf", "%@/#/gym/shared/%@", "edit-sets-\\(id)", "saved", "", "  ·  "]',
            'print("Simulator Log Line")',
        ])
        self.assertEqual(self.violations(source, keys=["Open"]), [])

    def test_debug_and_simulator_lines_are_left_out_of_what_ships(self):
        source = '\n'.join([
            'Text("Shipped Line")',
            '#if DEBUG',
            'Text("Debug Line")',
            '#else',
            'Text("Release Line")',
            '#endif',
            '  #if DEBUG && targetEnvironment(simulator)',
            'Text("Simulator Line")',
            '  #endif',
            '#if !DEBUG',
            'Text("Not Debug Line")',
            '#endif',
        ])
        self.assertEqual(sorted(check_copy_literals.dev_lines(source)), [2, 3, 7, 8])
        self.assertEqual([line for line, _ in check_copy_literals.violations(source, set(), set(), frozenset(check_copy_literals.dev_lines(source)))],
                         [1, 5, 11])

    def test_a_message_counting_an_int_resolves_in_the_copy_locale(self):
        source = '\n'.join([
            'String(localized: "\\(count) sets", locale: .copy)',
            'String(localized: "\\(count) sets")',
            'String(localized: "\\(count) sets", locale: .current)',
            'String(localized: "Set \\(place)")',
            'Text(String(localized: "\\(count) sets")); Text(String(localized: "Done", locale: .copy))',
            'Text("\\(count) sets")',
        ])
        self.assertEqual(self.violations(source, keys=["%lld sets", "Set %@", "Done"], integer_keys=["%lld sets"]), [
            (2, "'%@ sets' interpolates an Int: resolve it with locale: .copy"),
            (3, "'%@ sets' interpolates an Int: resolve it with locale: .copy"),
            (5, "'%@ sets' interpolates an Int: resolve it with locale: .copy"),
        ])

    def test_each_folder_answers_to_the_catalogs_of_the_bundles_that_compile_it(self):
        with TemporaryDirectory() as temporary:
            source = self.tree(temporary, {
                "Sources/Screen.swift": 'Text("Only In The App")\nText("In Both")',
                "Sources/Theme/Band.swift": 'Text("Only In The App")\nText("In Both")',
                "WorkoutActivityShared/Intent.swift": 'Text("Only In The Widget")\nText("In Both")',
                "WorkoutActivityWidget/Widget.swift": 'Text("Only In The Widget")\nText("In Both")',
                "Sources/Gym/Log/LogFixtures.swift": 'let name = "Push Day"',
                "Sources/Verification.swift": 'let prose = "Long day."',
            }, app=["Only In The App", "In Both"], widget=["Only In The Widget", "In Both"])
            with self.assertRaises(ValueError) as failure:
                check_copy_literals.check(source)
            self.assertEqual(str(failure.exception).split("\n"), [
                f"{source}/Sources/Theme/Band.swift:1: error: 'Only In The App' is no key of its bundle's String Catalog; localize it and run python3 Tools/string_catalogs.py",
                f"{source}/WorkoutActivityShared/Intent.swift:1: error: 'Only In The Widget' is no key of its bundle's String Catalog; localize it and run python3 Tools/string_catalogs.py",
            ])

    def test_allowlisted_lines_pass_with_their_reasons_and_stale_entries_fail(self):
        intents = "WorkoutActivityShared/WorkoutIntents.swift"
        with TemporaryDirectory() as temporary:
            source = self.tree(temporary, {intents: 'AppShortcut(phrases: ["Log a set in \\(.applicationName)", "Log my set"])\n'
                                                    'AppShortcut(phrases: ["Start a workout in \\(.applicationName)"])\n'})
            reason = "allowed: App Shortcut phrases localize through an AppShortcuts catalog, which comes with a second language"
            self.assertEqual(check_copy_literals.check(source), [f"{intents}:1: {reason}", f"{intents}:2: {reason}"])
            (source / intents).write_text("let quiet = true\n")
            with self.assertRaises(ValueError) as failure:
                check_copy_literals.check(source)
            self.assertEqual(str(failure.exception).split("\n"), [
                f"{source / intents}: error: allowlisted English no longer appears: \"Log a set in \\(.applicationName)\"",
                f"{source / intents}: error: allowlisted English no longer appears: \"Start a workout in \\(.applicationName)\"",
            ])

    def test_command_exits_nonzero_for_english_outside_the_catalog_then_passes_after_it(self):
        with TemporaryDirectory() as temporary:
            source = self.tree(temporary, {"Sources/Screen.swift": 'GymRow(title: "Read")\n'})
            command = [sys.executable, str(Path(check_copy_literals.__file__)), "--source", str(source)]
            environment = {**os.environ, check_copy_literals.SYNC: ""}
            result = subprocess.run(command, capture_output=True, text=True, env=environment)
            self.assertEqual((result.returncode, result.stderr), (1, f"{source}/Sources/Screen.swift:1: error: 'Read' is no key of its "
                                                                      "bundle's String Catalog; localize it and run python3 Tools/string_catalogs.py\n"))
            (source / "Resources/Localizable.xcstrings").write_text(json.dumps({"strings": {"Read": {}}}))
            result = subprocess.run(command, capture_output=True, text=True, env=environment)
            self.assertEqual((result.returncode, result.stdout),
                             (0, "Copy literal check passed: every literal a person reads is a key of its bundle's String Catalog.\n"))
            result = subprocess.run(command, capture_output=True, text=True, env={**os.environ, check_copy_literals.SYNC: "YES"})
            self.assertEqual((result.returncode, result.stdout),
                             (0, "Copy literal check skipped: string_catalogs.py syncs the catalogs from this build.\n"))

    def test_missing_source_root_fails_closed(self):
        with TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "Missing shipped source directory"):
                check_copy_literals.check(Path(temporary))

    def test_the_shipped_sources_keep_their_english_in_the_catalogs(self):
        self.assertEqual(check_copy_literals.check(Path(check_copy_literals.__file__).resolve().parents[1]), [
            "Sources/AppRuntime.swift:401: allowed: the simulator's Apple sign-in, which no person meets",
            "Sources/AppRuntime.swift:409: allowed: the simulator's Apple sign-in, which no person meets",
            "WorkoutActivityShared/WorkoutIntents.swift:151: allowed: App Shortcut phrases localize through an AppShortcuts catalog, "
            "which comes with a second language",
            "WorkoutActivityShared/WorkoutIntents.swift:154: allowed: App Shortcut phrases localize through an AppShortcuts catalog, "
            "which comes with a second language",
        ])


if __name__ == "__main__":
    unittest.main()
