from pathlib import Path
import plistlib
import sys
from copy import deepcopy
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).parents[1]))
import generate_project
import prepare_build


class BuildConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source = Path(self.directory.name)
        (self.source / "Generated").mkdir()
        self.template = {
            "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
            "CFBundleShortVersionString": "$(MARKETING_VERSION)",
            "WMServerBaseURL": "$(WM_SERVER_BASE_URL)",
        }
        with (self.source / "Generated/Info.plist").open("wb") as handle:
            plistlib.dump(self.template, handle)
        self.settings = {
            "SRCROOT": str(self.source),
            "DERIVED_FILE_DIR": str(self.source / "Debug"),
            "CONFIGURATION": "Debug",
            "WM_SOURCE_REVISION": "abc123",
        }

    def read(self, name="Windmill.Info.plist"):
        if name == "Windmill.entitlements":
            enabled = self.settings.get("WM_APPLE_SIGN_IN_ENABLED", "NO")
            path = Path(__file__).parents[1] / f"Windmill-{enabled}.entitlements"
        else:
            path = Path(self.settings["DERIVED_FILE_DIR"]) / name
        with path.open("rb") as handle:
            return plistlib.load(handle)

    def test_default_has_no_apple_entitlement_and_debug_telemetry_is_off(self):
        prepare_build.prepare(self.settings)
        self.assertEqual({}, self.read("Windmill.entitlements"))
        self.assertEqual({**self.template, "WMSentryDSN": "", "WMSourceRevision": "abc123",
                          "WMTelemetryEnvironment": "development", "WMDebugTelemetry": "NO",
                          "WMAppleSignInEnabled": "NO"}, self.read())

    def test_apple_entitlement_requires_explicit_yes_and_can_be_disabled_again(self):
        self.settings["WM_APPLE_SIGN_IN_ENABLED"] = "YES"
        prepare_build.prepare(self.settings)
        self.assertEqual({"com.apple.developer.applesignin": ["Default"]}, self.read("Windmill.entitlements"))
        self.settings["WM_APPLE_SIGN_IN_ENABLED"] = "NO"
        prepare_build.prepare(self.settings)
        self.assertEqual({}, self.read("Windmill.entitlements"))

    def test_release_requires_https_public_key_and_project_without_request_details(self):
        self.settings["CONFIGURATION"] = "Release"
        for invalid in ("", "http://key@localhost/1", "https://localhost/1", "https://key@localhost/x",
                        "https://key:secret@localhost/1", "https://key@localhost/1?token=secret",
                        "https://key@localhost:99999/1"):
            with self.subTest(dsn=invalid), self.assertRaises(ValueError):
                prepare_build.prepare({**self.settings, "IOS_SENTRY_DSN": invalid})
        self.settings["IOS_SENTRY_DSN"] = "https://public@example.invalid/prefix/123"
        prepare_build.prepare(self.settings)
        self.assertEqual("production", self.read()["WMTelemetryEnvironment"])
        self.assertEqual(self.settings["IOS_SENTRY_DSN"], self.read()["WMSentryDSN"])

    def test_debug_allows_local_collector_and_explicit_opt_in(self):
        self.settings.update(IOS_SENTRY_DSN="http://public@127.0.0.1:8090/1", WM_DEBUG_TELEMETRY="YES",
                             WM_TELEMETRY_ENVIRONMENT="local")
        prepare_build.prepare(self.settings)
        self.assertEqual("YES", self.read()["WMDebugTelemetry"])
        self.assertEqual("local", self.read()["WMTelemetryEnvironment"])

    def test_metadata_and_switches_reject_unbounded_values(self):
        for key, value in (("WM_SOURCE_REVISION", "contains content"),
                           ("WM_SOURCE_REVISION", "a" * 65),
                           ("WM_TELEMETRY_ENVIRONMENT", "contains content"),
                           ("WM_TELEMETRY_ENVIRONMENT", "a" * 33),
                           ("WM_DEBUG_TELEMETRY", "true"),
                           ("WM_APPLE_SIGN_IN_ENABLED", "true")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                prepare_build.prepare({**self.settings, key: value})

    def test_revision_prefers_build_setting_then_github_then_local_git(self):
        self.settings["GITHUB_SHA"] = "github123"
        prepare_build.prepare(self.settings)
        self.assertEqual("abc123", self.read()["WMSourceRevision"])
        self.settings["WM_SOURCE_REVISION"] = ""
        prepare_build.prepare(self.settings)
        self.assertEqual("github123", self.read()["WMSourceRevision"])
        self.settings.pop("GITHUB_SHA")
        with patch.object(prepare_build.subprocess, "check_output", return_value="local123\n") as git:
            prepare_build.prepare(self.settings)
        git.assert_called_once_with(["git", "-C", str(self.source), "rev-parse", "HEAD"], text=True)
        self.assertEqual("local123", self.read()["WMSourceRevision"])

    def test_derived_outputs_do_not_modify_project_template(self):
        prepare_build.prepare(self.settings)
        self.settings.update(CONFIGURATION="Release", DERIVED_FILE_DIR=str(self.source / "Release"),
                             IOS_SENTRY_DSN="https://public@example.invalid/1")
        prepare_build.prepare(self.settings)
        with (self.source / "Generated/Info.plist").open("rb") as handle:
            self.assertEqual(self.template, plistlib.load(handle))
        with (self.source / "Debug/Windmill.Info.plist").open("rb") as handle:
            self.assertEqual("development", plistlib.load(handle)["WMTelemetryEnvironment"])
        self.assertEqual("production", self.read()["WMTelemetryEnvironment"])


class ReleaseProjectTests(unittest.TestCase):
    def setUp(self):
        self.spec = {"targets": {"Windmill": {"settings": {
            "base": {"CURRENT_PROJECT_VERSION": "1", "SWIFT_VERSION": "6.0",
                     "SWIFT_TREAT_WARNINGS_AS_ERRORS": "YES", "SWIFT_DEFAULT_ACTOR_ISOLATION": "MainActor"},
            "configs": {"Release": {"CODE_SIGN_STYLE": "Automatic", "CODE_SIGN_IDENTITY": "Apple Development"}},
        }}}}
        self.settings = {"SRCROOT": "/unused", "CONFIGURATION": "Release", "WM_SOURCE_REVISION": "abc123",
                         "IOS_SENTRY_DSN": "https://public@example.invalid/1", "GITHUB_RUN_NUMBER": "72",
                         "APPLE_TEAM_ID": "ABCDEFGHIJ"}

    def test_release_sets_target_metadata_team_and_run_number_and_preserves_compiler(self):
        configured = generate_project.configured_spec(deepcopy(self.spec), self.settings, True)
        target = configured["targets"]["Windmill"]["settings"]
        self.assertEqual({"CURRENT_PROJECT_VERSION": "72", "SWIFT_VERSION": "6.0",
                          "SWIFT_TREAT_WARNINGS_AS_ERRORS": "YES", "SWIFT_DEFAULT_ACTOR_ISOLATION": "MainActor",
                          "IOS_SENTRY_DSN": "https://public@example.invalid/1", "WM_SOURCE_REVISION": "abc123",
                          "WM_TELEMETRY_ENVIRONMENT": "production", "WM_DEBUG_TELEMETRY": "NO",
                          "WM_APPLE_SIGN_IN_ENABLED": "NO"}, target["base"])
        self.assertEqual({"CODE_SIGN_STYLE": "Automatic", "CODE_SIGN_IDENTITY": "Apple Development",
                          "DEVELOPMENT_TEAM": "ABCDEFGHIJ"}, target["configs"]["Release"])

    def test_release_rejects_invalid_team_or_run_number(self):
        for key, value in (("APPLE_TEAM_ID", ""), ("APPLE_TEAM_ID", "content"),
                           ("GITHUB_RUN_NUMBER", ""), ("GITHUB_RUN_NUMBER", "0"),
                           ("GITHUB_RUN_NUMBER", "1.2")):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                generate_project.configured_spec(deepcopy(self.spec), {**self.settings, key: value}, True)

    def test_ci_sets_nonproduction_dsn_without_signing_team_or_build_number_override(self):
        settings = {**self.settings, "CONFIGURATION": "Debug", "IOS_SENTRY_DSN": "https://nonproduction@example.invalid/1"}
        configured = generate_project.configured_spec(deepcopy(self.spec), settings, False)
        target = configured["targets"]["Windmill"]["settings"]
        self.assertEqual("1", target["base"]["CURRENT_PROJECT_VERSION"])
        self.assertEqual("https://nonproduction@example.invalid/1", target["base"]["IOS_SENTRY_DSN"])
        self.assertEqual("NO", target["base"]["WM_DEBUG_TELEMETRY"])
        self.assertEqual(self.spec["targets"]["Windmill"]["settings"]["configs"], target["configs"])


if __name__ == "__main__":
    unittest.main()
