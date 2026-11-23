#!/usr/bin/env bash
# The Graph's budget (Roadmap on iOS §5) on a device's own screen: builds GraphBench in Release, installs it, runs it in
# each of its combinations (the handbook's 5,000 steps and the first 1,000 of them, under each way of keeping a pinch's
# frames), prints every `bench` line, and removes the app again.
# Run:  bash apps/ios/GraphBench/bench.sh <device>   # a phone, by its identifier in `xcrun devicectl list devices`
#       bash apps/ios/GraphBench/bench.sh            # a simulator the run makes and deletes
# Env:  SHORT=1 runs the 5,000 steps alone, at the first two cameras: every way three times in about five minutes.
#       PINCHES="<way> …" runs those ways alone (live held coarse layered).
#       RUNS=<count> runs each combination that many times (3).
#       SIM=<udid> uses a booted simulator.
#       DERIVED_DATA=<path> builds there and leaves the build; otherwise a folder of the run's own.
#       MEASURES=<folder> keeps each run's lines in a file of its own.
#       REGISTER_DEVICE=1 lets Xcode add the phone to the team's devices where it is not among them.
#       KEEP=1 leaves the app installed when the run ends, and SKIP_BUILD=1 runs the app a run before left: a phone
#       asks its owner to trust a personal team's developer in Settings before its first launch, which they can
#       only do while the app is installed.
# A phone is paired, unlocked, awake and out of Low Power Mode. Its build is signed by the keychain's one Apple
# Development identity with automatic provisioning, which makes the benchmark's own App ID and development profile on
# that team, and registers no device unless REGISTER_DEVICE is set. Neither the team nor the identity is printed.
set -uo pipefail

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
cd "$(cd "$(dirname "$0")" && pwd)"

BUNDLE="works.windmill.graphbench"
device="${1:-}"
sim="${SIM:-}"
WORK=""
MADE=""
INSTALLED=""
bounded(){ perl -e 'alarm shift; exec @ARGV' "$@"; }
cleanup(){
  if [ -n "${KEEP:-}" ]; then echo "left $BUNDLE where it was installed"
  elif [ -n "$INSTALLED" ] && [ -n "$device" ]; then
    if bounded 120 xcrun devicectl device uninstall app --device "$device" "$BUNDLE" >/dev/null 2>&1; then echo "removed $BUNDLE from $device"
    else echo "COULD NOT remove $BUNDLE from $device: xcrun devicectl device uninstall app --device $device $BUNDLE" >&2; fi
  elif [ -n "$INSTALLED" ]; then
    xcrun simctl uninstall "$sim" "$BUNDLE" >/dev/null 2>&1
  fi
  if [ -n "$MADE" ]; then xcrun simctl shutdown "$MADE" >/dev/null 2>&1; xcrun simctl delete "$MADE"; fi
  [ -n "$WORK" ] && rm -rf "$WORK"
}
trap cleanup EXIT

derived="${DERIVED_DATA:-}"
if [ -z "$derived" ]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/graph-bench.XXXXXX")"
  derived="$WORK/derived"
fi
xcodegen generate --quiet || exit 1
if [ -n "${SKIP_BUILD:-}" ]; then
  INSTALLED=1
elif [ -n "$device" ]; then
  team="$(security find-certificate -c "Apple Development" -p 2>/dev/null | openssl x509 -noout -subject -nameopt multiline 2>/dev/null \
    | awk -F'= ' '/organizationalUnitName/ {print $2; exit}')"
  [ -n "$team" ] || { echo "the keychain holds no Apple Development identity" >&2; exit 1; }
  bounded 1800 xcodebuild build -quiet -project GraphBench.xcodeproj -scheme GraphBench -configuration Release \
    -destination "platform=iOS,id=$device" -derivedDataPath "$derived" -allowProvisioningUpdates \
    ${REGISTER_DEVICE:+-allowProvisioningDeviceRegistration} \
    DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Automatic "CODE_SIGN_IDENTITY=Apple Development" 2>&1 \
    | sed -e "s/$team/<team>/g" -e 's/Apple Development: [^"]*/Apple Development: <identity>/g'
  [ "${PIPESTATUS[0]}" = 0 ] || exit 1
  INSTALLED=1
  bounded 300 xcrun devicectl device install app --device "$device" "$derived/Build/Products/Release-iphoneos/GraphBench.app" >/dev/null || exit 1
else
  if [ -z "$sim" ]; then
    MADE="$(xcrun simctl create "GraphBench" "iPhone 17")" || exit 1
    sim="$MADE"
    xcrun simctl boot "$sim" || exit 1
    xcrun simctl bootstatus "$sim" >/dev/null
  fi
  bounded 1800 xcodebuild build -quiet -project GraphBench.xcodeproj -scheme GraphBench -configuration Release \
    -destination "platform=iOS Simulator,id=$sim" -derivedDataPath "$derived" ONLY_ACTIVE_ARCH=YES || exit 1
  INSTALLED=1
  xcrun simctl install "$sim" "$derived/Build/Products/Release-iphonesimulator/GraphBench.app" || exit 1
fi

# A run takes under a minute and has five: one that does not say it is done ends the whole.
[ -n "${MEASURES:-}" ] && mkdir -p "$MEASURES"
if [ -n "${SHORT:-}" ]; then counts="5000"; short=YES; else counts="5000 1000"; short=NO; fi
for steps in $counts; do
  for pinch in ${PINCHES:-live held coarse layered}; do
    for run in $(seq "${RUNS:-3}"); do
      asked=(-steps "$steps" -pinch "$pinch" -short "$short" -quits YES)
      if [ -n "$device" ]; then
        said="$(bounded 300 xcrun devicectl device process launch --console --terminate-existing --device "$device" -- "$BUNDLE" "${asked[@]}" 2>&1)"
      else
        said="$(bounded 300 xcrun simctl launch --console --terminate-running-process "$sim" "$BUNDLE" "${asked[@]}" 2>&1)"
      fi
      echo "$said" | grep '^bench ' | tee ${MEASURES:+"$MEASURES/steps-$steps-pinch-$pinch-run-$run.txt"}
      if ! echo "$said" | grep -q '^bench .* done: '; then
        echo "the run of $steps steps, pinch $pinch, did not say it was done:" >&2
        echo "$said" | grep -v '^bench ' | tail -8 >&2
        exit 1
      fi
    done
  done
done
