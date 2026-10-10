import argparse
from datetime import datetime, timezone
from pathlib import Path
import plistlib
import subprocess

APP = "works.windmill.app"
AUTOMATION = ("ApplicationAccessibilityEnabled", "AutomationEnabled")
STATUS_BAR = ("--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active", "--wifiBars", "3",
              "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "charged", "--batteryLevel", "100")


def first_boot_preferences(now):
    return {
        ".GlobalPreferences": {
            "AppleLanguages": ["en"], "AppleLocale": "en_US",
            "KeyboardAutocorrection": False, "KeyboardPrediction": False, "KeyboardContinuousPathEnabled": False,
        },
        "com.apple.Accessibility": {setting: True for setting in AUTOMATION},
        # iOS 26.5 keeps Live Activity consent outside simctl privacy's services.
        "com.apple.liveactivitiesd": {
            "AppAuthorizationRecords": {APP: True}, "FirstResponseRecords": [APP], "SecondResponseRecords": [APP],
        },
        # The first-boot Settings notifications count as delivered, so no banner takes a test's tap.
        "com.apple.generativeexperiences.corefollowup": {
            "DateOfLastAppleIntelligenceReadinessCFU": now.replace(tzinfo=None),
            "DateOfLastNotificationAutoEnablement": (now - datetime(2001, 1, 1, tzinfo=timezone.utc)).total_seconds(),
        },
    }


def seed(preferences, policies):
    preferences.mkdir(parents=True, exist_ok=True)
    for domain, settings in policies.items():
        path = preferences / f"{domain}.plist"
        current = plistlib.loads(path.read_bytes()) if path.exists() else {}
        path.write_bytes(plistlib.dumps(current | settings))


def simctl(*arguments):
    return subprocess.run(["xcrun", "simctl", *arguments], check=True, capture_output=True, text=True).stdout.strip()


def prepare(device, devices):
    seed(devices / device / "data/Library/Preferences", first_boot_preferences(datetime.now(timezone.utc)))
    subprocess.run(["defaults", "write", "com.apple.iphonesimulator", "ConnectHardwareKeyboard", "-bool", "false"], check=True)
    simctl("boot", device)
    simctl("bootstatus", device, "-b")
    # The first boot rewrites some seeded domains, so what the tests rely on is written again and read back.
    simctl("spawn", device, "launchctl", "setenv", "TZ", "UTC")
    simctl("spawn", device, "defaults", "write", "NSGlobalDomain", "AppleLanguages", "-array", "en")
    simctl("spawn", device, "defaults", "write", "NSGlobalDomain", "AppleLocale", "-string", "en_US")
    for setting in AUTOMATION:
        simctl("spawn", device, "defaults", "write", "com.apple.Accessibility", setting, "-bool", "true")
    simctl("ui", device, "appearance", "light")
    simctl("ui", device, "content_size", "large")
    simctl("status_bar", device, "override", *STATUS_BAR)
    kept = {
        "TZ": simctl("getenv", device, "TZ"),
        "AppleLocale": simctl("spawn", device, "defaults", "read", "NSGlobalDomain", "AppleLocale"),
        **{setting: simctl("spawn", device, "defaults", "read", "com.apple.Accessibility", setting) for setting in AUTOMATION},
    }
    expected = {"TZ": "UTC", "AppleLocale": "en_US", **{setting: "1" for setting in AUTOMATION}}
    if kept != expected:
        raise SystemExit(f"The simulator kept {kept}; UI tests need {expected}.")
    print(f"Prepared {device}: {kept}")


def main():
    parser = argparse.ArgumentParser(description="Prepare a new, never-booted simulator the way the iOS UI shards run on.")
    parser.add_argument("device", help="The UDID of a simulator that has not booted yet.")
    prepare(parser.parse_args().device, Path.home() / "Library/Developer/CoreSimulator/Devices")


if __name__ == "__main__":
    main()
