import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def snapshot(process, api):
    result = {"state": int(process.GetState()), "exitStatus": process.GetExitStatus(), "threads": [], "images": []}
    for index in range(min(process.GetNumThreads(), 128)):
        thread = process.GetThreadAtIndex(index)
        frames = []
        for index in range(min(thread.GetNumFrames(), 64)):
            frame = thread.GetFrameAtIndex(index)
            line = frame.GetLineEntry()
            frames.append({"pc": frame.GetPC(), "function": (frame.GetFunctionName() or "")[:512],
                           "image": (frame.GetModule().GetFileSpec().GetFilename() or "")[:256],
                           "file": (line.GetFileSpec().GetFilename() or "")[:256], "line": line.GetLine()})
        reason = thread.GetStopReason()
        result["threads"].append({"index": thread.GetIndexID(), "stopReason": int(reason),
                                  "stopData": [thread.GetStopReasonDataAtIndex(index)
                                               for index in range(min(thread.GetStopReasonDataCount(), 8))],
                                  "frames": frames})
    target = process.GetTarget()
    for index in range(min(target.GetNumModules(), 512)):
        module = target.GetModuleAtIndex(index)
        result["images"].append({"name": (module.GetFileSpec().GetFilename() or "")[:256],
                                 "uuid": (module.GetUUIDString() or "")[:64]})
    result["outcome"] = "stopped" if process.GetState() in (api.eStateStopped, api.eStateCrashed) else "exited"
    return result


def terminate_children(parent):
    try:
        rows = subprocess.run(["ps", "-axo", "pid=,ppid="], check=True, capture_output=True,
                              text=True, timeout=5).stdout.splitlines()
        if len(rows) > 8192:
            return {"complete": False}
        pairs = [tuple(map(int, row.split())) for row in rows]
        if any(len(pair) != 2 for pair in pairs):
            return {"complete": False}
        parents = {parent}
        children = []
        for _ in range(32):
            found = [pid for pid, owner in pairs if owner in parents and pid != parent]
            if not found:
                break
            if len(children) + len(found) > 512:
                return {"complete": False}
            children.extend(found)
            parents = set(found)
        else:
            return {"complete": False}
        for pid in reversed(children):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return {"complete": True, "children": len(children)}
    except (OSError, subprocess.SubprocessError, ValueError):
        return {"complete": False}


def wait_for_result(process, api, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        state = process.GetState()
        if state in (api.eStateCrashed, api.eStateExited, api.eStateDetached):
            return snapshot(process, api)
        if state == api.eStateStopped:
            count = process.GetNumThreads()
            reasons = [process.GetThreadAtIndex(index).GetStopReason() for index in range(min(count, 128))]
            if count > 128 or any(reason not in (api.eStopReasonInvalid, api.eStopReasonNone, api.eStopReasonExec)
                                  for reason in reasons):
                return snapshot(process, api)
            process.Continue()
        time.sleep(.1)
    return {"outcome": "timed_out", "seconds": seconds}


def capture(debugger, executable, arguments, directory, platform, output, seconds):
    import lldb

    result = {"outcome": "launch_failed"}
    process = None
    try:
        debugger.SetAsync(True)
        target = debugger.CreateTarget(executable)
        launch = lldb.SBLaunchInfo(arguments)
        launch.SetWorkingDirectory(directory)
        environment = ["NO_COLOR=1"]
        for key, suffix in (("DYLD_FRAMEWORK_PATH", "Developer/Library/Frameworks"), ("DYLD_LIBRARY_PATH", "Developer/usr/lib")):
            paths = [os.environ.get(key, ""), str(Path(platform) / suffix)]
            environment.append(key + "=" + ":".join(path for path in paths if path))
        launch.SetEnvironmentEntries(environment, True)
        launch.AddOpenFileAction(0, os.devnull, True, False)
        launch.AddOpenFileAction(1, os.devnull, False, True)
        launch.AddOpenFileAction(2, os.devnull, False, True)
        error = lldb.SBError()
        process = target.Launch(launch, error)
        if error.Success():
            result = wait_for_result(process, lldb, seconds)
        else:
            result["errorCode"] = error.GetError()
    except Exception:
        result = {"outcome": "debugger_error"}
    finally:
        if process and process.IsValid() and process.GetState() not in (lldb.eStateExited, lldb.eStateDetached):
            process.Stop()
            result["childCleanup"] = terminate_children(process.GetProcessID())
            process.Kill()
        data = (json.dumps(result, indent=2) + "\n").encode()
        if len(data) > 8 * 1024 * 1024:
            data = b'{"outcome":"output_limit"}\n'
        Path(output).write_bytes(data)


def reproduce(package, output, seconds=300):
    output.mkdir(parents=True, exist_ok=True)
    result_path = output / "debugger.json"
    result_path.unlink(missing_ok=True)
    summary = {"outcome": "unavailable", "seconds": seconds, "entryPoint": "swift-testing",
               "maximumThreads": 128, "maximumFramesPerThread": 64, "maximumImages": 512}
    binary = package / ".build/debug/WindmillDomainPackageTests.xctest/Contents/MacOS/WindmillDomainPackageTests"
    if not binary.is_file():
        summary["reason"] = "domain_bundle_missing"
    else:
        try:
            swift = Path(subprocess.run(["xcrun", "--find", "swift"], check=True, capture_output=True,
                                        text=True, timeout=15).stdout.strip())
            helper = swift.parent.parent / "libexec/swift/pm/swiftpm-testing-helper"
            if not helper.is_file():
                summary["reason"] = "testing_helper_missing"
            else:
                for name, command in (("swift", ["xcrun", "swift", "--version"]), ("lldb", ["xcrun", "lldb", "--version"])):
                    summary[name] = subprocess.run(command, check=True, capture_output=True, text=True, timeout=15).stdout[:2048].strip()
                platform = subprocess.run(["xcrun", "--sdk", "macosx", "--show-sdk-platform-path"],
                                          check=True, capture_output=True, text=True, timeout=15).stdout.strip()
                arguments = ["--test-bundle-path", str(binary.resolve()), "--testing-library", "swift-testing"]
                script = Path(__file__).resolve()
                invocation = (f"script domain_ci_debugger.capture(lldb.debugger, {str(helper)!r}, {arguments!r}, "
                              f"{str(package.resolve())!r}, {platform!r}, {str(result_path.resolve())!r}, {seconds})")
                command = ["xcrun", "lldb", "--no-lldbinit", "--batch", "--no-use-colors",
                           "-o", "command script import " + json.dumps(str(script)), "-o", invocation]
                with subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True) as runner:
                    try:
                        summary["debuggerExit"] = runner.wait(timeout=seconds + 30)
                    except subprocess.TimeoutExpired:
                        summary["watchdogChildCleanup"] = terminate_children(runner.pid)
                        os.killpg(runner.pid, signal.SIGKILL)
                        runner.wait()
                        summary["outcome"] = "watchdog_timeout"
                    finally:
                        summary["debuggerChildCleanup"] = terminate_children(runner.pid)
                        try:
                            os.killpg(runner.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                if result_path.is_file() and result_path.stat().st_size <= 8 * 1024 * 1024:
                    summary["outcome"] = json.loads(result_path.read_text())["outcome"]
                elif summary["outcome"] != "watchdog_timeout":
                    summary["outcome"] = "no_report"
        except (OSError, subprocess.SubprocessError, ValueError, KeyError):
            summary["outcome"] = "setup_failed"
    (output / "debugger-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def main():
    parser = argparse.ArgumentParser(description="Capture one bounded, failure-only Domain test stack without changing the CI test result.")
    parser.add_argument("--package", type=Path, default=Path(__file__).resolve().parents[2] / "Domain")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print("Domain debugger reproduction: " + reproduce(args.package, args.output)["outcome"])


if __name__ == "__main__":
    main()
