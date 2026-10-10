from datetime import datetime, timezone
from pathlib import Path
import plistlib
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).parents[1]))
import prepare_simulator


class PrepareSimulatorTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.devices = Path(self.directory.name)

    def plist(self, domain):
        return plistlib.loads((self.devices / "SIM/data/Library/Preferences" / f"{domain}.plist").read_bytes())

    def answering(self, answers):
        calls = []
        def run(command, **options):
            calls.append(command)
            return subprocess.CompletedProcess(command, 0, stdout=answers.get(tuple(command[-2:]), "") + "\n", stderr="")
        return calls, patch.object(prepare_simulator.subprocess, "run", side_effect=run)

    def test_first_boot_preferences_merge_over_what_the_device_holds(self):
        preferences = self.devices / "SIM/data/Library/Preferences"
        preferences.mkdir(parents=True)
        (preferences / ".GlobalPreferences.plist").write_bytes(plistlib.dumps({"AppleLocale": "fr_FR", "AppleKeyboards": ["fr_FR@sw=AZERTY"]}))
        now = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)
        prepare_simulator.seed(preferences, prepare_simulator.first_boot_preferences(now))
        self.assertEqual(self.plist(".GlobalPreferences"), {
            "AppleKeyboards": ["fr_FR@sw=AZERTY"], "AppleLanguages": ["en"], "AppleLocale": "en_US",
            "KeyboardAutocorrection": False, "KeyboardPrediction": False, "KeyboardContinuousPathEnabled": False,
        })
        self.assertEqual(self.plist("com.apple.Accessibility"), {"ApplicationAccessibilityEnabled": True, "AutomationEnabled": True})
        self.assertEqual(self.plist("com.apple.liveactivitiesd"), {
            "AppAuthorizationRecords": {"works.windmill.app": True},
            "FirstResponseRecords": ["works.windmill.app"], "SecondResponseRecords": ["works.windmill.app"],
        })
        self.assertEqual(self.plist("com.apple.generativeexperiences.corefollowup"), {
            "DateOfLastAppleIntelligenceReadinessCFU": datetime(2026, 10, 8, 12, 0),
            "DateOfLastNotificationAutoEnablement": 813153600.0,
        })

    def test_boots_then_writes_and_reads_back_what_the_tests_rely_on(self):
        calls, run = self.answering({("SIM", "TZ"): "UTC", ("NSGlobalDomain", "AppleLocale"): "en_US",
                                     ("com.apple.Accessibility", "ApplicationAccessibilityEnabled"): "1",
                                     ("com.apple.Accessibility", "AutomationEnabled"): "1"})
        with run, patch("builtins.print") as printed:
            prepare_simulator.prepare("SIM", self.devices)
        simctl = ["xcrun", "simctl"]
        self.assertEqual(calls, [
            ["defaults", "write", "com.apple.iphonesimulator", "ConnectHardwareKeyboard", "-bool", "false"],
            simctl + ["boot", "SIM"],
            simctl + ["bootstatus", "SIM", "-b"],
            simctl + ["spawn", "SIM", "launchctl", "setenv", "TZ", "UTC"],
            simctl + ["spawn", "SIM", "defaults", "write", "NSGlobalDomain", "AppleLanguages", "-array", "en"],
            simctl + ["spawn", "SIM", "defaults", "write", "NSGlobalDomain", "AppleLocale", "-string", "en_US"],
            simctl + ["spawn", "SIM", "defaults", "write", "com.apple.Accessibility", "ApplicationAccessibilityEnabled", "-bool", "true"],
            simctl + ["spawn", "SIM", "defaults", "write", "com.apple.Accessibility", "AutomationEnabled", "-bool", "true"],
            simctl + ["ui", "SIM", "appearance", "light"],
            simctl + ["ui", "SIM", "content_size", "large"],
            simctl + ["status_bar", "SIM", "override", "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active",
                      "--wifiBars", "3", "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "charged",
                      "--batteryLevel", "100"],
            simctl + ["getenv", "SIM", "TZ"],
            simctl + ["spawn", "SIM", "defaults", "read", "NSGlobalDomain", "AppleLocale"],
            simctl + ["spawn", "SIM", "defaults", "read", "com.apple.Accessibility", "ApplicationAccessibilityEnabled"],
            simctl + ["spawn", "SIM", "defaults", "read", "com.apple.Accessibility", "AutomationEnabled"],
        ])
        printed.assert_called_once_with("Prepared SIM: {'TZ': 'UTC', 'AppleLocale': 'en_US', "
                                        "'ApplicationAccessibilityEnabled': '1', 'AutomationEnabled': '1'}")
        self.assertEqual(self.plist("com.apple.Accessibility"), {"ApplicationAccessibilityEnabled": True, "AutomationEnabled": True})

    def test_a_device_that_kept_another_setting_fails_the_preparation(self):
        _, run = self.answering({("SIM", "TZ"): "UTC", ("NSGlobalDomain", "AppleLocale"): "en_US",
                                 ("com.apple.Accessibility", "ApplicationAccessibilityEnabled"): "0",
                                 ("com.apple.Accessibility", "AutomationEnabled"): "1"})
        with run, self.assertRaises(SystemExit) as failure:
            prepare_simulator.prepare("SIM", self.devices)
        self.assertEqual(str(failure.exception),
                         "The simulator kept {'TZ': 'UTC', 'AppleLocale': 'en_US', 'ApplicationAccessibilityEnabled': '0', "
                         "'AutomationEnabled': '1'}; UI tests need {'TZ': 'UTC', 'AppleLocale': 'en_US', "
                         "'ApplicationAccessibilityEnabled': '1', 'AutomationEnabled': '1'}.")


if __name__ == "__main__":
    unittest.main()
