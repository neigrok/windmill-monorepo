#!/usr/bin/env bash
# The replay fuzz's coverage survey (engine §11.3, corpus README "Replay coverage"): per event, the mean, least and missed fuzzes.
# Run:  bash apps/ios/Sync/coverage-survey.sh [fuzzes] [first seed]      (default: 30 fuzzes from seed 1, 1000 seeds apart)
set -euo pipefail

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
cd "$(cd "$(dirname "$0")" && pwd)"
fuzzes="${1:-30}"
first="${2:-1}"
failed="$(mktemp)"
trap 'rm -f "$failed"' EXIT

swift build --build-tests >/dev/null
for ((i = 0; i < fuzzes; i++)); do
  seed=$((first + i * 1000))
  log="$(SYNC_SEED="$seed" swift test --skip-build --filter SimulatorTests/everySeed 2>&1)" || echo "$seed" >>"$failed"
  sed -n 's/^seeds producing: //p' <<<"$log"
done | awk -v fuzzes="$fuzzes" '
  {
    n = split($0, pairs, "|")
    for (i = 1; i <= n; i++) {
      split(pairs[i], kv, "=")
      sum[kv[1]] += kv[2]
      seen[kv[1]] += 1
      if (!(kv[1] in least) || kv[2] < least[kv[1]]) least[kv[1]] = kv[2]
    }
  }
  END {
    for (event in sum) {
      missed = fuzzes - seen[event]
      fewest = missed > 0 ? 0 : least[event]
      printf "%7.1f mean %4d least %3d missed  %s\n", sum[event] / fuzzes, fewest, missed, event
    }
  }' | sort -n

if [[ -s "$failed" ]]; then
  echo "failed fuzzes, by first seed: $(paste -sd ' ' "$failed")" >&2
  exit 1
fi
