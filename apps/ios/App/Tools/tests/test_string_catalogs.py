import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest


sys.path.insert(0, str(Path(__file__).parents[1]))
import string_catalogs


class StringCatalogTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_a_string_no_source_names_leaves_and_a_manual_one_stays(self):
        plural = {"en": {"variations": {"plural": {"one": {"stringUnit": {"state": "translated", "value": "%lld page"}},
                                                   "other": {"stringUnit": {"state": "translated", "value": "%lld pages"}}}}}}
        catalog = {"sourceLanguage": "en", "version": "1.0", "strings": {
            "Kept": {},
            "%lld pages": {"extractionState": "stale", "localizations": plural},
            "CFBundleDisplayName": {"extractionState": "manual", "localizations": {"en": {"stringUnit": {"state": "translated", "value": "Windmill"}}}},
        }}
        self.assertEqual(string_catalogs.pruned(catalog, {"Kept"}), {"sourceLanguage": "en", "version": "1.0", "strings": {
            "Kept": {},
            "CFBundleDisplayName": catalog["strings"]["CFBundleDisplayName"],
        }})

    def test_a_catalog_is_written_as_xcode_writes_it(self):
        catalog = {"version": "1.0", "strings": {"b": {}, "Log set  ·  %@": {"comment": "A\nB"}, "/ %@": {}}, "sourceLanguage": "en"}
        self.assertEqual(string_catalogs.xcode_json(catalog), "\n".join([
            '{', '  "sourceLanguage" : "en",', '  "strings" : {', '    "/ %@" : {', '', '    },',
            '    "Log set  ·  %@" : {', '      "comment" : "A\\nB"', '    },', '    "b" : {', '', '    }', '  },',
            '  "version" : "1.0"', '}']))

    def test_the_info_plist_catalog_names_what_the_built_info_plist_shows(self):
        def catalog(**values):
            return {"strings": {key: {"extractionState": "manual", "localizations": {"en": {"stringUnit": {"state": "translated", "value": value}}}}
                                for key, value in values.items()}}
        info = {"CFBundleDisplayName": "Windmill", "CFBundleName": "Windmill", "NSCameraUsageDescription": "Photos for Coach."}
        self.assertEqual(string_catalogs.info_plist_findings("InfoPlist.xcstrings", catalog(CFBundleDisplayName="Windmill", NSCameraUsageDescription="Photos for Coach."), info), [])
        self.assertEqual(string_catalogs.info_plist_findings("InfoPlist.xcstrings", catalog(CFBundleDisplayName="Windmil", CFBundleName="Windmill"), info), [
            "InfoPlist.xcstrings: CFBundleDisplayName reads 'Windmil', the built Info.plist 'Windmill'",
            "InfoPlist.xcstrings: NSCameraUsageDescription reads None, the built Info.plist 'Photos for Coach.'",
            "InfoPlist.xcstrings: CFBundleName names no string the built Info.plist shows",
        ])

    def test_differences_name_each_string_added_removed_or_changed(self):
        committed, regenerated = self.root / "committed.xcstrings", self.root / "regenerated.xcstrings"
        committed.write_text(json.dumps({"strings": {"Same": {}, "Gone": {}, "Commented": {}}}))
        regenerated.write_text(json.dumps({"strings": {"Same": {}, "New": {}, "Commented": {"comment": "Why"}}}))
        self.assertEqual(string_catalogs.differences(committed, regenerated), ["+ 'New'", "- 'Gone'", "~ 'Commented'"])

    def test_a_target_reads_the_strings_of_the_sources_it_compiles_now(self):
        objects = self.root / "Build/Intermediates.noindex/Windmill.build/Release-iphonesimulator/Windmill.build/Objects-normal/arm64"
        objects.mkdir(parents=True)
        for name in ("AccountSheet", "Deleted"):
            (objects / f"{name}.stringsdata").write_text("{}")
        (objects / "Windmill.SwiftFileList").write_text("/repo/apps/ios/App/Sources/AccountSheet.swift\n")
        self.assertEqual(string_catalogs.stringsdata(self.root, "Windmill"), [objects / "AccountSheet.stringsdata"])

    def test_a_target_without_strings_asks_for_the_release_build(self):
        with self.assertRaises(SystemExit) as refusal:
            string_catalogs.stringsdata(self.root, "WindmillWorkoutActivity")
        self.assertIn("build Release for the simulator first", str(refusal.exception))

    def test_hand_kept_english_is_held_to_its_key(self):
        def plural(one, other):
            return {"plural": {form: {"stringUnit": {"state": "translated", "value": value}} for form, value in (("one", one), ("other", other)) if value}}
        def counted(argument, conversion, one, other):
            return {"sets": {"argNum": argument, "formatSpecifier": conversion, "variations": plural(one, other)}}
        catalog = {"strings": {
            "%lld sets": {"localizations": {"en": {"variations": plural("%@ set", "%lld sets")}}},
            "%lld reps": {"localizations": {"en": {"variations": plural(None, "%lld reps")}}},
            "Set %lld of %lld": {"localizations": {"en": {"stringUnit": {"state": "new", "value": "Set %1$lld"}}}},
            "%@ %@": {"localizations": {"en": {"stringUnit": {"state": "new", "value": "%2$@ %1$@"}}}},
            "%@ from %lld sets": {"localizations": {"en": {"stringUnit": {"state": "translated", "value": "%1$@ from %2$#@sets@"},
                                                          "substitutions": counted(1, "lld", "%arg set", "%arg sets")}}},
            "%lld of %lld sets": {"localizations": {"en": {"stringUnit": {"state": "translated", "value": "%1$lld of %2$#@sets@"},
                                                          "substitutions": counted(2, "lld", "one set", "%arg sets")}}},
            "Kept": {"comment": "No English of its own"},
            "100%% of %lld sets": {"localizations": {"en": {"stringUnit": {"state": "translated", "value": "100%% of %1$#@sets@"},
                                                           "substitutions": counted(1, "lld", "%arg set", "%arg sets")}}},
        }}
        self.assertEqual(string_catalogs.malformed(catalog), [
            "'%@ from %lld sets': its substitution 'sets' counts argument 1 as %lld, no %lld of its key",
            "'%lld of %lld sets': its substitution 'sets' one form 'one set' does not show its number",
            "'%lld reps': its plural lacks its one form",
            "'%lld sets': its one form '%@ set' takes other placeholders than its key",
            "'Set %lld of %lld': its value 'Set %1$lld' takes other placeholders than its key",
        ])

    def test_the_committed_catalogs_hold_their_english_to_their_keys(self):
        for folder, _ in string_catalogs.TARGETS.values():
            with self.subTest(folder=folder):
                self.assertEqual(string_catalogs.malformed(string_catalogs.parsed(string_catalogs.APP / folder / "Localizable.xcstrings")), [])

    def test_a_catalog_that_is_not_json_is_named_without_a_traceback(self):
        broken = self.root / "Localizable.xcstrings"
        broken.write_text('{"strings": {')
        with self.assertRaises(SystemExit) as refusal:
            string_catalogs.parsed(broken)
        self.assertEqual(str(refusal.exception), f"error: {broken} is not valid JSON: Expecting property name enclosed in double quotes: line 1 column 14 (char 13)")

    def test_a_build_without_its_build_root_is_named_without_a_traceback(self):
        class Answer:
            stdout = json.dumps([{"target": "Windmill", "buildSettings": {}}])
        with self.assertRaises(SystemExit) as refusal:
            string_catalogs.build(run=lambda *_, **__: Answer())
        self.assertEqual(str(refusal.exception), "error: xcodebuild -showBuildSettings names no BUILD_ROOT for the Release simulator build.")

    def test_a_regenerated_catalog_takes_the_new_drops_the_gone_and_keeps_what_is_kept_by_hand(self):
        derived_data, app = self.root / "DerivedData", self.root / "App"
        sources = {"Windmill": ["Hello", "%lld sets", "%@ %@", ("echo-day.open", "Open")], "WindmillWorkoutActivity": ["Set %lld of %lld"]}
        for target, keys in sources.items():
            objects = derived_data / f"Build/Intermediates.noindex/Windmill.build/Release-iphonesimulator/{target}.build/Objects-normal/arm64"
            objects.mkdir(parents=True)
            (objects / f"{target}.SwiftFileList").write_text(f"/repo/{target}/View.swift\n")
            strings = [{"comment": "", "key": key, "location": {"startingColumn": 1, "startingLine": line}} if isinstance(key, str)
                       else {"comment": "An echo's state", "key": key[0], "value": key[1], "location": {"startingColumn": 1, "startingLine": line}}
                       for line, key in enumerate(keys, 1)]
            (objects / "View.stringsdata").write_text(json.dumps({"source": f"/repo/{target}/View.swift", "tables": {"Localizable": strings}, "version": 1}))
        plural = {"en": {"variations": {"plural": {"one": {"stringUnit": {"state": "translated", "value": "%lld set"}},
                                                   "other": {"stringUnit": {"state": "translated", "value": "%lld sets"}}}}}}
        committed = {"Resources": {"%lld sets": {"localizations": plural}, "%@ %@": {"shouldTranslate": False},
                                   "Hello": {"comment": "A greeting"}, "Gone": {}},
                     "WorkoutActivityWidget": {}}
        for folder, strings in committed.items():
            (app / folder).mkdir(parents=True)
            (app / folder / "Localizable.xcstrings").write_text(string_catalogs.xcode_json({**string_catalogs.EMPTY, "strings": strings}))
        written = string_catalogs.regenerated(derived_data, self.root / "work", app=app)
        self.assertEqual({path: string_catalogs.parsed(file)["strings"] for path, file in written.items()}, {
            "Resources/Localizable.xcstrings": {
                "%@ %@": {"shouldTranslate": False}, "%lld sets": {"localizations": plural}, "Hello": {"comment": "A greeting"},
                "echo-day.open": {"comment": "An echo's state", "extractionState": "extracted_with_value",
                                  "localizations": {"en": {"stringUnit": {"state": "new", "value": "Open"}}}},
            },
            "WorkoutActivityWidget/Localizable.xcstrings": {
                "Set %lld of %lld": {"localizations": {"en": {"stringUnit": {"state": "new", "value": "Set %1$lld of %2$lld"}}}},
            },
        })


if __name__ == "__main__":
    unittest.main()
