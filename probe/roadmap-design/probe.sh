#!/bin/bash
# The design probe on one booted simulator, with the Xcode, simulator and folders the environment names.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
bundle=dev.probe.roadmapdesign

usage() {
  cat >&2 <<'USAGE'
usage: probe.sh build                  generate, build and install the probe
       probe.sh shoot <name> <probe> [variant] [settle-seconds]
       probe.sh run <dark|light> [xcodebuild test options, such as -only-testing:ProbeUITests/ProbeUITests/testMenu]

DEVELOPER_DIR       the Xcode that builds and runs the probe
SIMULATOR           the UDID of a booted simulator this run owns
PROBE_DERIVED_DATA  where the build goes
PROBE_OUT           where shots/, trees/, results/ and logs/ go
USAGE
  exit 64
}

: "${DEVELOPER_DIR:?set DEVELOPER_DIR to the Xcode, such as /Applications/Xcode_26.3.app/Contents/Developer}"
: "${SIMULATOR:?set SIMULATOR to the UDID of a booted simulator}"
: "${PROBE_DERIVED_DATA:?set PROBE_DERIVED_DATA to the build folder}"
: "${PROBE_OUT:?set PROBE_OUT to the output folder}"
export DEVELOPER_DIR

# One still per line: its name, the probe, the variant ("-" for none) and, optionally, the seconds it settles.
stills() {
  cat <<'STILLS'
02-title-inline title inline
02-title-large title large
02-title-inline-long title inline-long
02-title-large-long title large-long
02-title-inline-split title inline-split
04-dialog-toolbar dialog toolbar
04-dialog-row dialog row
04-dialog-bottom dialog bottom
05-alert alert -
06-search-rest search rest
06-search-always search always
06-search-active search active
06-search-rest-large search rest-large
06-search-always-large search always-large
07-sheet-medium-list sheet list
07-sheet-medium-list-no-background-interaction sheet list-dim
07-sheet-medium-form-keyboard sheet form 6
07-sheet-large-create sheet create
07-sheet-large-create-disabled sheet create-disabled
07-sheet-large-create-role-buttons sheet create-roles
07-sheet-large-create-role-buttons-disabled sheet create-roles-disabled
08-list-inset-grouped list -
08-list-sidebar list sidebar
10-edit-delete edit delete
10-edit-select edit select
11-paste-with-text paste -
11-unavailable-empty unavailable -
11-unavailable-search unavailable search
12-glass glass -
15-edit-inactive edit inactive
15-edit-select-text-buttons edit select-text
15-alert-two-actions alert keep
15-alert-two-actions-and-cancel alert keep-cancel
15-alert-keep-as-cancel-and-discard alert keep-as-cancel
15-alert-two-plain-actions alert keep-plain
15-unavailable-buttons unavailable buttons
STILLS
}

build() {
  mkdir -p "$PROBE_OUT/logs"
  xcodegen generate --spec "$here/project.yml" --project "$here"
  xcodebuild build-for-testing -project "$here/Probe.xcodeproj" -scheme Probe \
    -destination "platform=iOS Simulator,id=$SIMULATOR" -derivedDataPath "$PROBE_DERIVED_DATA" \
    2>&1 | tee "$PROBE_OUT/logs/build.log"
  xcrun simctl install "$SIMULATOR" "$PROBE_DERIVED_DATA/Build/Products/Debug-iphonesimulator/Probe.app"
}

shoot() {
  local name=$1 probe=$2 variant=${3:-} settle=${4:-4}
  local appearance
  appearance=$(xcrun simctl ui "$SIMULATOR" appearance)
  xcrun simctl terminate "$SIMULATOR" "$bundle" 2>/dev/null || true
  xcrun simctl launch "$SIMULATOR" "$bundle" -probe "$probe" -variant "$variant" >/dev/null
  sleep "$settle"
  xcrun simctl io "$SIMULATOR" screenshot "$PROBE_OUT/shots/$name-$appearance.png" 2>/dev/null
  echo "$name-$appearance.png"
}

run() {
  local appearance=$1
  shift
  mkdir -p "$PROBE_OUT/shots" "$PROBE_OUT/trees" "$PROBE_OUT/results" "$PROBE_OUT/logs"
  xcrun simctl ui "$SIMULATOR" appearance "$appearance"
  # The first launch on a new simulator is slow, so it takes no still.
  xcrun simctl launch "$SIMULATOR" "$bundle" -probe glass >/dev/null
  sleep 10
  # Only a simulator that has never held text shows Paste dimmed.
  if [ -z "$(xcrun simctl pbpaste "$SIMULATOR")" ]; then shoot 11-paste-empty-pasteboard paste; fi
  printf 'K7Q-4RX' | xcrun simctl pbcopy "$SIMULATOR"
  stills | while read -r name probe variant settle; do
    if [ "$variant" = "-" ]; then variant=""; fi
    shoot "$name" "$probe" "$variant" "${settle:-4}" || echo "No still for $name-$appearance."
  done
  xcrun simctl terminate "$SIMULATOR" "$bundle" 2>/dev/null || true
  local result="$PROBE_OUT/results/probe-$appearance.xcresult"
  local xctestrun=("$PROBE_DERIVED_DATA"/Build/Products/*.xctestrun)
  rm -rf "$result"
  TEST_RUNNER_PROBE_OUT="$PROBE_OUT" TEST_RUNNER_PROBE_APPEARANCE="$appearance" \
    xcodebuild test-without-building -xctestrun "${xctestrun[0]}" \
    -destination "platform=iOS Simulator,id=$SIMULATOR" -resultBundlePath "$result" \
    -test-timeouts-enabled YES -default-test-execution-time-allowance 300 -maximum-test-execution-time-allowance 600 "$@" \
    2>&1 | tee "$PROBE_OUT/logs/uitests-$appearance.log" \
    || echo "Some probe UI tests failed in $appearance; their shots record what the screen held."
}

case "${1:-}" in
  build) build ;;
  shoot) [ $# -ge 3 ] || usage; shift; mkdir -p "$PROBE_OUT/shots"; shoot "$@" ;;
  run) [ "${2:-}" = dark ] || [ "${2:-}" = light ] || usage; shift; run "$@" ;;
  *) usage ;;
esac
