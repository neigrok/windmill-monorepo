#!/usr/bin/env bash
# The engine's budgets (design §11 M11): the SyncBenchmarks suite in release, on this Mac or inside an iOS simulator.
# Each measure prints one `bench` line beside its budget. SYNC_BENCH_REPORT=<path> also appends each as a JSON line;
# SYNC_BENCH_PROBE_URL=http://127.0.0.1:<port> adds the boot from a probe server on a throwaway database
# (backend/RUNNING.md, windmill_server_probe), which the simulator reaches on the host's loopback.
# Run:  bash apps/ios/Sync/bench.sh [mac|simulator]      (default: mac)
# Env: SIM=<udid> uses a booted simulator; otherwise the run makes one and deletes it when it ends.
set -euo pipefail

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
cd "$(cd "$(dirname "$0")" && pwd)"

passed=()
[ -n "${SYNC_BENCH_REPORT:-}" ] && passed+=("SYNC_BENCH_REPORT=$SYNC_BENCH_REPORT")
[ -n "${SYNC_BENCH_PROBE_URL:-}" ] && passed+=("SYNC_BENCH_PROBE_URL=$SYNC_BENCH_PROBE_URL")

# Other test targets use @testable, so the release build enables testing.
mac(){
  env SYNC_BENCH=1 ${passed[@]+"${passed[@]}"} swift test -c release -Xswiftc -enable-testing --filter SyncBenchmarks
}

# The package's own scheme builds every test target, and some run exit tests iOS does not have, so a scheme of the
# benchmarks alone is written where SwiftPM keeps Xcode's schemes (.swiftpm is not tracked). The test runner takes the
# environment as TEST_RUNNER_<name>.
WORK=""
SCHEME=".swiftpm/xcode/xcshareddata/xcschemes/SyncBenchmarks.xcscheme"
MADE=""
cleanup(){
  [ -n "$WORK" ] && rm -rf "$WORK" "$SCHEME"
  if [ -n "$MADE" ]; then xcrun simctl shutdown "$MADE" >/dev/null 2>&1; xcrun simctl delete "$MADE"; fi
}

simulator(){
  trap cleanup EXIT
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/sync-bench.XXXXXX")"
  mkdir -p "$(dirname "$SCHEME")"
  cat > "$SCHEME" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1600" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
   </BuildAction>
   <TestAction buildConfiguration = "Release" shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
         <TestableReference skipped = "NO">
            <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "SyncBenchmarks"
               BuildableName = "SyncBenchmarks" BlueprintName = "SyncBenchmarks" ReferencedContainer = "container:">
            </BuildableReference>
         </TestableReference>
      </Testables>
   </TestAction>
</Scheme>
XML
  local sim="${SIM:-}"
  if [ -z "$sim" ]; then
    MADE="$(xcrun simctl create "SyncBench" "iPhone 17")"
    sim="$MADE"
    xcrun simctl boot "$sim"
    xcrun simctl bootstatus "$sim" >/dev/null
  fi
  env TEST_RUNNER_SYNC_BENCH=1 ${passed[@]+"${passed[@]/#/TEST_RUNNER_}"} xcodebuild test -scheme SyncBenchmarks \
    -destination "platform=iOS Simulator,id=$sim" -configuration Release ENABLE_TESTABILITY=YES -derivedDataPath "$WORK/derived"
}

case "${1:-mac}" in
  mac) mac ;;
  simulator) simulator ;;
  *) echo "usage: bench.sh [mac|simulator]" >&2; exit 2 ;;
esac
