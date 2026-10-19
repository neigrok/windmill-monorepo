from pathlib import Path
import plistlib
import subprocess
from tempfile import TemporaryDirectory
import unittest


class AppStoreBuildStatusTests(unittest.TestCase):
    def test_signed_read_scope_and_exact_build_status(self):
        tools = Path(__file__).parents[1]
        with TemporaryDirectory() as directory:
            binary = Path(directory) / "checks"
            subprocess.run(["xcrun", "swiftc", "-parse-as-library", "-DAPP_STORE_STATUS_TESTING",
                            str(tools / "AppStoreBuildStatus.swift"),
                            str(tools / "tests/AppStoreBuildStatusChecks.swift"), "-o", str(binary)], check=True)
            result = subprocess.run([str(binary)], check=True, capture_output=True, text=True)
            self.assertEqual(result.stdout, "App Store status checks passed: signed GET scope, exact archive match, "
                             "literal beta states, pending/failure and bounded output.\n")
            self.assertEqual(result.stderr, "")

    def test_cli_failure_does_not_echo_credentials_or_key_path(self):
        tools = Path(__file__).parents[1]
        with TemporaryDirectory() as directory:
            binary = Path(directory) / "status"
            subprocess.run(["xcrun", "swiftc", "-parse-as-library", str(tools / "AppStoreBuildStatus.swift"),
                            "-o", str(binary)], check=True)
            info = Path(directory) / "Info.plist"
            info.write_bytes(plistlib.dumps({"CFBundleIdentifier": "works.windmill.app",
                                            "CFBundleShortVersionString": "0.2.0", "CFBundleVersion": "19"}))
            result = subprocess.run([str(binary), str(info), str(Path(directory) / "status.json")],
                                    env={"ASC_KEY_PATH": str(Path(directory) / "private-key-canary"),
                                         "ASC_KEY_ID": "key-id-canary", "ASC_ISSUER_ID": "issuer-canary"},
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "::error::app_store_status outcome=unverified code=unavailable. "
                             "The upload already exists; do not upload a duplicate.\n")
            self.assertEqual(result.stderr, "")
            self.assertFalse((Path(directory) / "status.json").exists())
