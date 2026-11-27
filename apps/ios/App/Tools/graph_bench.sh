#!/usr/bin/env bash
# The Graph's budget (Roadmap on iOS §5) at 5,000 steps, inside an iOS simulator: `GraphBenchmarks` hosted in the app
# (the picture's time and a frame's time at five cameras) and `RoadmapGraphBenchmarks` on its screen (the switch to the
# first frame, and the frames a scripted pan and pinch are given). Both run on a Release-configuration build that
# compiles the Roadmap room and its simulator boards in, which no release carries. Each measure prints one `bench`
# line beside its budget, and a measure over its budget fails the run.
# Run:  bash apps/ios/App/Tools/graph_bench.sh [xcodebuild settings…]
# Env:  SIM=<udid> uses a booted simulator; otherwise the run makes one and deletes it when it ends.
#       DERIVED_DATA=<path> builds there and leaves the build, which is not a release's; otherwise a folder of the run's own.
#       GRAPH_BENCH_LOG=<path> keeps xcodebuild's whole output.
set -uo pipefail

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
cd "$(cd "$(dirname "$0")/.." && pwd)"

WORK=""
MADE=""
cleanup(){
  [ -n "$WORK" ] && rm -rf "$WORK"
  if [ -n "$MADE" ]; then xcrun simctl shutdown "$MADE" >/dev/null 2>&1; xcrun simctl delete "$MADE"; fi
}
trap cleanup EXIT

derived="${DERIVED_DATA:-}"
if [ -z "$derived" ]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/graph-bench.XXXXXX")"
  derived="$WORK/derived"
fi
sim="${SIM:-}"
if [ -z "$sim" ]; then
  MADE="$(xcrun simctl create "GraphBench" "iPhone 17")"
  sim="$MADE"
  xcrun simctl boot "$sim"
  xcrun simctl bootstatus "$sim" >/dev/null
fi

python3 Tools/generate_project.py >/dev/null || exit 1
# The whole run has forty minutes: a build from nothing takes most of them, the measures about three.
env IOS_SENTRY_DSN="${IOS_SENTRY_DSN:-https://nonproduction@example.invalid/1}" TEST_RUNNER_WM_GRAPH_BENCH=1 \
  perl -e 'alarm shift; exec @ARGV' 2400 xcodebuild test -project Windmill.xcodeproj -scheme Windmill -configuration Release \
  ONLY_ACTIVE_ARCH=YES ENABLE_TESTABILITY=YES WM_ROADMAP_ROOM_ENABLED=YES 'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) DEBUG' \
  -destination "platform=iOS Simulator,id=$sim" -derivedDataPath "$derived" -parallel-testing-enabled NO \
  -only-testing:WindmillTests/GraphBenchmarks -only-testing:WindmillUITests/RoadmapGraphBenchmarks "$@" 2>&1 \
  | tee "${GRAPH_BENCH_LOG:-/dev/null}" \
  | grep --line-buffered -E '^bench |: error: |^✘|Test Case .* (passed|failed)|Test run with|\*\* TEST|\*\* BUILD'
exit "${PIPESTATUS[0]}"
