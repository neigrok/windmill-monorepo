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


if __name__ == "__main__":
    unittest.main()
