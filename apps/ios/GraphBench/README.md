# GraphBench

A dev-only app that measures the Roadmap room's Graph against its budget
([Roadmap on iOS](../../../docs/foundation/roadmap-ios.md) §5: a first frame under a second and 60 frames a second, at
5,000 steps) on a device's own screen. It never ships and is in no CI job: `bench.sh` alone builds and runs it.

```sh
bash apps/ios/GraphBench/bench.sh <device>   # a phone, by its identifier in `xcrun devicectl list devices`
bash apps/ios/GraphBench/bench.sh            # a simulator the run makes and deletes
```

`bench.sh` builds the app in Release, installs it, launches it three times in each of its eight combinations (the
handbook's 5,000 steps and the first 1,000 of them, under each of the four ways the room can keep a pinch's frames),
prints every `bench` line the app writes, and removes the app again, also when a step fails. `SHORT=1` runs the 5,000
steps alone, at the first two cameras: every way three times, twelve launches of about a quarter of a minute each
after the build. `PINCHES="<way> …"` runs those ways alone, `RUNS=<count>` changes the three, `SIM=<udid>` uses a
booted simulator, `DERIVED_DATA=<path>` builds there and leaves the build, and `MEASURES=<folder>` keeps each run's
lines in a file of its own. A run that does not say it is done ends the whole. What the runs gave is in the App's
README, [The Graph's benchmark](../App/README.md#the-graphs-benchmark).

## What it draws

The app compiles the room's own Graph from where it lives, `GraphPicture`, `GraphCamera`, `GraphDrawing` and
`GraphSurface` of `../App/Sources/Roadmap/Graph/` with the room's colours (`Palettes.swift`, `Theme.xcassets`), over
`RoadmapLayout`, `RoadmapDomain` and `SyncCore`, and bundles the layout's 5,000-step fixture,
`packages/api-contract/roadmap/layout/handbook.json`. `GraphBench` holds the picture, the camera, the captions and the
pinch under way as the room's `RoadmapGraph` does: the picture made off the main actor, the camera where the layout
frames the roadmap, the captions placed again at every move of the camera and when the next of them is due.
`GraphBenchScreen` gives them to `GraphSurface`, the view the room's `RoadmapGraphCanvas` draws the picture with, so
what is measured is the room's own canvas, drawing and way of keeping a pinch's frames.

It differs from the room in two ways. The surface stands alone, so what covers it is the screen's own edges where
the room has its bars, and the layout frames the whole roadmap a little closer. And a script moves the camera where
the room has gestures: its pinch is under way from its first move to its last, as a finger's is from its first
report to its leaving.

## What it measures

A launch waits a second, makes the picture, and then runs five cameras in turn: the whole roadmap as the layout frames
it, then the step in the middle of the roadmap's order under the centre of the canvas at zooms 0.011, 0.085 and 0.65
and at the pinch ceiling, 2.5. A short launch runs the first two. At each, a display link moves the camera every
frame to where a finger would have brought it by then: three seconds of a pan in a circle of 60 pt, then three of a
pinch to twice the zoom and back, which at the ceiling is a pinch out and back. Connectors are first drawn just above
zoom 0.085, so the pinch from there draws them and the pan does not. With the whole 5,000 steps in view a way of
keeping a pinch's frames acts; at zoom 0.011 some 280 steps are in view, fewer than the 500 from which one does, so
every way draws there as `live` does.

Every line begins `bench [<model>] graph · steps=<count> pinch=<way> · `, the model a phone's own identifier or
`simulator <identifier>`:

| Line | Says |
|---|---|
| `the run` | The system's version, the screen's size, scale and highest refresh rate, Low Power Mode and the thermal state as the run begins. |
| `the picture` | The time `GraphPicture` took to seat the steps and wrap their captions, and the layout that seated them. |
| `the first frame` | The time from the start of the picture's making to the canvas's first draw of it, as the room times it from the tap that shows the Graph, beside §5's second. |
| `the canvas` | The canvas's size and what the screen's edges cover of it. |
| `<camera>` | The camera's zoom, the steps and the drawn links it holds, and the captions shown. |
| `<camera> · <pan or pinch> · frame gaps` | The gaps between the frames the display link gave the main actor: how many of the 180 that three seconds at 60 a second owe, the median, the 95th and 99th of a hundred, the longest, how many were later than a frame and a half at 60 a second, and the rate the link ticked at. More than a tenth late is over the budget, by the rule the room reports a missed budget by; so is fewer than nine tenths of the frames owed, since a link that fires less often hides the frames that would have been late. |
| `<camera> · <pan or pinch> · main actor` | Three times for each frame. `work` is the main actor's whole work in it, from its run loop waking to its resting again, its commit to the screen included, beside §5's frame; `tick` is the script's handler, the camera moved and the captions placed; `draw` is the canvas's draw closure, with how often it ran: under `held` a few times in a pinch of a crowd, at its stops, where every other way draws each frame. |
| `done` | Low Power Mode and the thermal state as the run ends, and whether the app was still in front. |

The screen shows the same lines once the run is done. A display link sees the frames the main actor was given, not
what the screen composited after them.

## Launch arguments

| Argument | Does |
|---|---|
| `-steps <count>` | Takes the first steps of the handbook's order, each following what it follows among them. Without it the roadmap is the whole 5,000. |
| `-pinch <way>` | How the surface keeps a pinch's frames: `live`, `held`, `coarse` or `layered` (`GraphPinch` in `GraphSurface.swift`). Without it the way is the room's own, `GraphPinch.room`. A word that names none of the four ends the run with `failed: noSuchPinch`. |
| `-short YES` | Runs the first two cameras alone: the whole roadmap and zoom 0.011. |
| `-quits YES` | Ends the process a second after the run has said it is done, which a launch that waits on the console needs. |

## A phone

The app's bundle id is `works.windmill.graphbench`; it has no entitlements and no extension. `bench.sh` signs it with
the keychain's one `Apple Development` identity and automatic provisioning, reading the team from the certificate and
printing neither. That needs Xcode signed in to that team's Apple Account (Settings → Accounts), which makes the
benchmark's App ID and development profile on the team, and the phone among the team's devices: `REGISTER_DEVICE=1`
lets Xcode add it. The phone is paired with the Mac, in Developer Mode, unlocked, awake and out of Low Power Mode;
each run's first and last lines say what Low Power Mode and the thermal state were.

A phone refuses the first launch of a personal team's app until its owner trusts the developer (Settings → General →
VPN & Device Management), which they can do only while the app is installed. So the first time: `KEEP=1 RUNS=1` builds
and installs the app, fails at that launch and leaves the app; the owner trusts the developer; `SKIP_BUILD=1` then
runs the app that is there and removes it. The trust goes with the developer's last app, so the next first run asks
again.

An iPhone 13 mini has run it under `live`, three runs at 5,000 steps and three at 1,000; its numbers are in
[the app's README](../App/README.md), under The Graph's benchmark. No phone has run `held`, `coarse` or `layered`.
One session settles which of them the room takes:

```sh
SHORT=1 MEASURES=<folder> bash apps/ios/GraphBench/bench.sh <device>
```
