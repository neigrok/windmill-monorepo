#!/bin/zsh
# usage: shoot.sh <shot-name-without-appearance> <probe> [variant] [settle-seconds]
set -e
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
here=${0:A:h}
udid=$(cat $here/udid.txt)
appearance=$(xcrun simctl ui $udid appearance)
xcrun simctl terminate $udid dev.probe.roadmapdesign 2>/dev/null || true
xcrun simctl launch $udid dev.probe.roadmapdesign -probe "$2" -variant "${3:-}" >/dev/null
sleep ${4:-4}
xcrun simctl io $udid screenshot "$here/shots/$1-$appearance.png" 2>/dev/null
echo "$1-$appearance.png"
