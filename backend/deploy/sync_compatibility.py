#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import re
import subprocess
import time


def compatibility(value):
    result = {key: value[key] for key in ("schema", "minSchema")}
    if any(type(number) is not int for number in result.values()):
        raise ValueError("invalid schema numbers")
    if not 1 <= result["minSchema"] <= result["schema"]:
        raise ValueError("invalid schema interval")
    return result


def metadata(contract):
    composition = json.loads((contract / "composition.json").read_text())
    versions = []
    for name in composition["registries"]:
        if not re.fullmatch(r"[a-z]+\.registry\.json", name):
            raise ValueError("invalid registry filename")
        registry = json.loads((contract / name).read_text())
        versions.append(compatibility({"schema": registry["version"], "minSchema": registry["minVersion"]}))
    if not versions or any(version != versions[0] for version in versions):
        raise ValueError("registry compatibility differs")
    return versions[0]


def capture(arguments):
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise ValueError("command failed")
    return result.stdout.strip()


def sync_reply(schema, path="hello"):
    arguments = ["docker", "compose", "exec", "-T", "server", "curl", "--silent", "--show-error",
                 "--max-time", "2", "--write-out", "\n%{http_code}", "-H", "Sync-Schema: " + str(schema)]
    if path == "live":
        arguments += ["--http1.1", "-H", "Connection: Upgrade", "-H", "Upgrade: websocket",
                      "-H", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "-H", "Sec-WebSocket-Version: 13"]
    if path in ("push", "pull"):
        arguments += ["-X", "POST", "-H", "Content-Type: application/json", "--data", "{}"]
    suffix = "?schema=" + str(schema) if path == "live" else ""
    arguments += ["http://127.0.0.1:8080/v1/sync/" + path + suffix]
    body, status = capture(arguments).rsplit("\n", 1)
    return int(status), json.loads(body)


def web_preflight(schema, minimum):
    client = compatibility({"schema": schema, "minSchema": minimum})
    status, hello = sync_reply(2147483647)
    if status != 200:
        raise SystemExit("HOLD web deployment: live sync compatibility is unavailable")
    current = compatibility(hello)
    if current["schema"] < client["minSchema"] or current["minSchema"] > client["schema"]:
        raise SystemExit("HOLD web deployment: live backend and candidate client are incompatible")
    print("PASS web deployment: live backend accepts the candidate sync client")


def preflight(environment, acknowledgement, receipt):
    candidate = ["docker", "compose", "--env-file", str(environment), "-f", "docker-compose.next.yml"]
    services = json.loads(capture(candidate + ["config", "--format", "json"]))["services"]
    image = services["server"]["image"]
    if services["migrate"]["image"] != image:
        raise SystemExit("FAIL candidate server and migration images differ")
    image_id = capture(["docker", "image", "inspect", "--format", "{{.Id}}", image])
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image_id):
        raise SystemExit("FAIL candidate image has no immutable content ID")
    proposed = compatibility(json.loads(capture([
        "docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--entrypoint", "cat", image_id, "/app/sync-compatibility.json"])))
    current = {"schema": 0, "minSchema": 0}
    if not Path(".env").exists() and Path("docker-compose.yml").exists():
        raise SystemExit("FAIL live deployment environment is missing")
    if Path(".env").exists():
        status, hello = sync_reply(2147483647)
        if status != 200:
            raise SystemExit("FAIL live sync compatibility is unavailable")
        current = compatibility(hello)
    change = proposed["minSchema"] != current["minSchema"]
    approval = json.loads(acknowledgement.read_text())
    supplied = any(approval.get(key) not in (None, "") for key in ("oldMinimum", "newMinimum", "imageId"))
    if change or supplied:
        expected = {"mode": "manual", "oldMinimum": str(current["minSchema"]),
                    "newMinimum": str(proposed["minSchema"]), "imageId": image_id}
        if approval != expected or not re.fullmatch(r"ghcr\.io/neigrok/windmill-monorepo:[a-f0-9]{40}", image):
            raise SystemExit("FAIL sync minimum change requires a manual immutable image and exact old/new acknowledgement")
    elif approval != {"mode": "automatic", "oldMinimum": "", "newMinimum": "", "imageId": ""} and approval != {
            "mode": "manual", "oldMinimum": "", "newMinimum": "", "imageId": ""}:
        raise SystemExit("FAIL invalid sync compatibility acknowledgement")
    receipt.write_text(json.dumps({"candidate": proposed, "current": current, "imageId": image_id}) + "\n")
    lines = [line for line in environment.read_text().splitlines() if not line.startswith("SERVER_IMAGE=")]
    environment.write_text("\n".join(lines + ["SERVER_IMAGE=" + image_id]) + "\n")
    pinned = json.loads(capture(candidate + ["config", "--format", "json"]))["services"]
    if any(pinned[service]["image"] != image_id for service in ("server", "migrate")):
        raise SystemExit("FAIL candidate composition did not pin the inspected image")


def verify(receipt):
    state = json.loads(receipt.read_text())
    expected = state["candidate"]
    for attempt in range(30):
        try:
            status, hello = sync_reply(expected["schema"])
            if status == 200 and compatibility(hello) == expected:
                break
        except (ValueError, KeyError, subprocess.SubprocessError):
            pass
        time.sleep(1)
    else:
        raise SystemExit("FAIL running server did not advertise the candidate sync compatibility")
    excluded = {expected["minSchema"] - 1}
    excluded.update(range(max(1, state["current"]["minSchema"]),
                          min(expected["minSchema"], state["current"]["schema"] + 1)))
    for schema in sorted(excluded):
        for path in ("hello", "push", "pull", "live"):
            status, refusal = sync_reply(schema, path)
            if status != 426 or refusal.get("error") != "upgrade-required":
                raise SystemExit("FAIL running server accepts an excluded sync schema")


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("metadata")
    generate.add_argument("contract", type=Path)
    generate.add_argument("output", type=Path)
    guard = commands.add_parser("preflight")
    guard.add_argument("environment", type=Path)
    guard.add_argument("acknowledgement", type=Path)
    guard.add_argument("receipt", type=Path)
    runtime = commands.add_parser("verify")
    runtime.add_argument("receipt", type=Path)
    web = commands.add_parser("web-preflight")
    web.add_argument("schema", type=int)
    web.add_argument("minimum", type=int)
    args = parser.parse_args()
    try:
        if args.command == "metadata":
            args.output.write_text(json.dumps(metadata(args.contract)) + "\n")
        elif args.command == "preflight":
            preflight(args.environment, args.acknowledgement, args.receipt)
        elif args.command == "web-preflight":
            web_preflight(args.schema, args.minimum)
        else:
            verify(args.receipt)
    except Exception:
        if args.command == "web-preflight":
            raise SystemExit("HOLD web deployment: sync compatibility could not be verified")
        raise SystemExit("FAIL sync compatibility verification could not complete")


if __name__ == "__main__":
    main()
