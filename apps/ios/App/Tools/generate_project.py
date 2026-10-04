import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory

from prepare_build import configuration


def configured_spec(spec, settings, release):
    metadata = configuration(settings)
    target = spec["targets"]["Windmill"]["settings"]
    target["base"].update({
        "IOS_SENTRY_DSN": metadata["WMSentryDSN"],
        "WM_SOURCE_REVISION": metadata["WMSourceRevision"],
        "WM_TELEMETRY_ENVIRONMENT": metadata["WMTelemetryEnvironment"],
        "WM_DEBUG_TELEMETRY": metadata["WMDebugTelemetry"],
        "WM_APPLE_SIGN_IN_ENABLED": metadata["WMAppleSignInEnabled"],
    })
    if release:
        team = settings.get("APPLE_TEAM_ID", "")
        build = settings.get("GITHUB_RUN_NUMBER", "")
        if not re.fullmatch(r"[A-Z0-9]{10}", team):
            raise ValueError("APPLE_TEAM_ID must be the ten-character Apple team identifier.")
        if not re.fullmatch(r"[1-9][0-9]{0,14}", build):
            raise ValueError("GITHUB_RUN_NUMBER must be a positive build number.")
        target["base"]["CURRENT_PROJECT_VERSION"] = build
        target["configs"]["Release"]["DEVELOPMENT_TEAM"] = team
    return spec


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", action="store_true")
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[1]
    settings = {**os.environ, "SRCROOT": str(source), "CONFIGURATION": "Release" if args.release else "Debug"}
    try:
        spec = json.loads(subprocess.check_output(
            ["xcodegen", "dump", "--type", "json", "--spec", str(source / "project.yml")], text=True
        ))
        configured_spec(spec, settings, args.release)
        with TemporaryDirectory(prefix="windmill-project-") as directory:
            generated_spec = Path(directory) / "project.json"
            generated_spec.write_text(json.dumps(spec))
            subprocess.run(["xcodegen", "generate", "--spec", str(generated_spec), "--project", str(source),
                            "--project-root", str(source)], check=True)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit("error: " + str(error))
