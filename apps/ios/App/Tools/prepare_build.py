import os
from pathlib import Path
import plistlib
import re
import subprocess
from urllib.parse import urlsplit


def configuration(settings):
    source = Path(settings["SRCROOT"])
    release = settings.get("CONFIGURATION") == "Release"
    dsn = settings.get("IOS_SENTRY_DSN", "").strip()
    if release or dsn:
        try:
            parsed = urlsplit(dsn)
            valid = (
                len(dsn) <= 2048
                and parsed.scheme in (("https",) if release else ("https", "http"))
                and parsed.hostname
                and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", parsed.username or "")
                and parsed.password is None
                and re.fullmatch(r"(?:/[^/]+)*/[0-9]+", parsed.path)
                and not parsed.query
                and not parsed.fragment
                and (parsed.port is None or 1 <= parsed.port <= 65535)
            )
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("Release requires a valid HTTPS IOS_SENTRY_DSN for the iOS project."
                             if release else "IOS_SENTRY_DSN must be a valid collector DSN.")

    apple_enabled = settings.get("WM_APPLE_SIGN_IN_ENABLED", "NO")
    debug_enabled = settings.get("WM_DEBUG_TELEMETRY", "NO")
    if apple_enabled not in ("YES", "NO") or debug_enabled not in ("YES", "NO"):
        raise ValueError("Capability and debug telemetry switches must be YES or NO.")
    environment = settings.get("WM_TELEMETRY_ENVIRONMENT", "") or ("production" if release else "development")
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", environment):
        raise ValueError("WM_TELEMETRY_ENVIRONMENT must be a bounded environment label.")
    revision = settings.get("WM_SOURCE_REVISION", "") or settings.get("GITHUB_SHA", "")
    if not revision:
        revision = subprocess.check_output(
            ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
        ).strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", revision):
        raise ValueError("WM_SOURCE_REVISION must be a bounded source revision.")

    return {
        "WMSentryDSN": dsn,
        "WMSourceRevision": revision,
        "WMTelemetryEnvironment": environment,
        "WMDebugTelemetry": debug_enabled,
        "WMAppleSignInEnabled": apple_enabled,
    }


def prepare(settings):
    metadata = configuration(settings)
    source = Path(settings["SRCROOT"])
    destination = Path(settings["DERIVED_FILE_DIR"])
    with (source / "Generated/Info.plist").open("rb") as handle:
        info = plistlib.load(handle)
    info.update(metadata)
    destination.mkdir(parents=True, exist_ok=True)
    with (destination / "Windmill.Info.plist").open("wb") as handle:
        plistlib.dump(info, handle)


if __name__ == "__main__":
    try:
        prepare(os.environ)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit("error: " + str(error))
