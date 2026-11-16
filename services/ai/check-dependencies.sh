#!/usr/bin/env bash
set -euo pipefail
cd "${1:-$(dirname "${BASH_SOURCE[0]}")}"
metadata=$(mktemp)
trap 'rm -f "$metadata"' EXIT
cargo metadata --format-version 1 --no-deps > "$metadata"
python3 - "$metadata" <<'PY'
import json
import sys

packages = json.load(open(sys.argv[1]))["packages"]
names = {package["name"] for package in packages}
required = {"ai-domain", "ai-providers", "ai-storage", "ai-server"}
if not required <= names:
    raise SystemExit("FAIL AI dependency rule: the workspace is incomplete")
allowed = {
    ("ai-providers", "ai-domain"), ("ai-storage", "ai-domain"),
    ("ai-server", "ai-domain"), ("ai-server", "ai-providers"), ("ai-server", "ai-storage"),
    ("ai-pass-signer", "ai-domain"),
}
failures = []
for package in packages:
    for dependency in package["dependencies"]:
        if dependency["kind"] == "dev":
            continue
        source, target = package["name"], dependency["name"]
        if source == "ai-domain" or (target in names and (source, target) not in allowed):
            failures.append(f"{source} -> {target}")
if failures:
    raise SystemExit("FAIL AI dependency rule: " + ", ".join(sorted(set(failures))))
print("PASS AI dependency rule")
PY
