# GraphBench

A dev-only app that measures the Roadmap room's Graph against its budget
([Roadmap on iOS](../../../docs/foundation/roadmap-ios.md) §5: a first frame under a second and 60 frames a second, at
5,000 steps) on a device's own screen. It never ships and is in no CI job: `bench.sh` alone builds and runs it.

```sh
bash apps/ios/GraphBench/bench.sh <device>   # a phone, by its identifier in `xcrun devicectl list devices`
bash apps/ios/GraphBench/bench.sh            # a simulator the run makes and deletes
```

`bench.sh` builds the app in Release, installs it, launches it three times in each of its four combinations, prints
every `bench` line the app writes, and removes the app again, also when a step fails. `RUNS=<count>` changes the three,
`SIM=<udid>` uses a booted simulator, `DERIVED_DATA=<path>` builds there and leaves the build, and
`MEASURES=<folder>` keeps each run's lines in a file of its own. A run that does not say it is done ends the whole.
What the runs gave is in the App's README, [The Graph's benchmark](../App/README.md#the-graphs-benchmark).

## What it draws

The app compiles the room's own Graph from where it lives, `GraphPicture`, `GraphCamera` and `GraphDrawing` of
`../App/Sources/Roadmap/Graph/` with the room's colours (`Palettes.swift`, `Theme.xcassets`), over `RoadmapLayout`,
`RoadmapDomain` and `SyncCore`, and bundles the layout's 5,000-step fixture,
`packages/api-contract/roadmap/layout/handbook.json`. `GraphBench` holds the picture, the camera and the captions as
the room's `RoadmapGraph` does: the picture made off the main actor, the camera where the layout frames the roadmap,
the captions placed again at every move of the camera and when the next of them is due. `GraphBenchScreen` draws them
as the room's `RoadmapGraphCanvas` does, on one `Canvas` that runs under the screen's edges over the room's ground.

It differs from the room in three ways. The canvas stands alone, so what covers it is the screen's own edges where
the room has its bars, and the layout frames the whole roadmap a little closer. A script moves the camera where the
room has gestures. And the draw closure times itself and holds nothing of the main actor, so that a canvas that
renders asynchronously can call it from another thread.

## What it measures

A launch waits a second, makes the picture, and then runs five cameras in turn: the whole roadmap as the layout frames
it, then the step in the middle of the roadmap's order under the centre of the canvas at zooms 0.011, 0.085 and 0.65
and at the pinch ceiling, 2.5. At each, a display link moves the camera every frame to where a finger would have
brought it by then: three seconds of a pan in a circle of 60 pt, then three of a pinch to twice the zoom and back,
which at the ceiling is a pinch out and back. Connectors are first drawn just above zoom 0.085, so the pinch from
there draws them and the pan does not.

Every line begins `bench [<model>] graph · steps=<count> async=<on|off> · `, the model a phone's own identifier or
`simulator <identifier>`:

| Line | Says |
|---|---|
| `the run` | The system's version, the screen's size, scale and highest refresh rate, Low Power Mode and the thermal state as the run begins. |
| `the picture` | The time `GraphPicture` took to seat the steps and wrap their captions, and the layout that seated them. |
| `the first frame` | The time from the start of the picture's making to the canvas's first draw of it, as the room times it from the tap that shows the Graph, beside §5's second. |
| `the canvas` | The canvas's size and what the screen's edges cover of it. |
| `<camera>` | The camera's zoom, the steps and the drawn links it holds, and the captions shown. |
| `<camera> · <pan or pinch> · frame gaps` | The gaps between the frames the display link gave the main actor: how many, the median, the 95th and 99th of a hundred, the longest, how many were later than a frame and a half at 60 a second, and the rate the link ticked at. More than a tenth late is over the budget, by the rule the room reports a missed budget by. |
| `<camera> · <pan or pinch> · main actor` | Three times for each frame. `work` is the main actor's whole work in it, from its run loop waking to its resting again, its commit to the screen included, beside §5's frame; `tick` is the script's handler, the camera moved and the captions placed; `draw` is the canvas's draw closure, with how often it ran and how often off the main thread. |
| `done` | Low Power Mode and the thermal state as the run ends, and whether the app was still in front. |

The screen shows the same lines once the run is done.

A display link sees the frames the main actor was given, not what the screen composited after them: a canvas that
renders asynchronously can fall behind on another thread while the link ticks on time, and `draws` under `frames`
is the only sign of it these lines carry.

## Launch arguments

| Argument | Does |
|---|---|
| `-steps <count>` | Takes the first steps of the handbook's order, each following what it follows among them. Without it the roadmap is the whole 5,000. |
| `-renders-asynchronously YES` | Makes the canvas with `rendersAsynchronously`, which the room's is not. |
| `-quits YES` | Ends the process a second after the run has said it is done, which a launch that waits on the console needs. |

## A phone

The app's bundle id is `works.windmill.graphbench`; it has no entitlements and no extension. `bench.sh` signs it with
the keychain's one `Apple Development` identity and automatic provisioning, reading the team from the certificate and
printing neither. That needs Xcode signed in to that team's Apple Account (Settings → Accounts), which makes the
benchmark's App ID and development profile on the team, and the phone among the team's devices, since the script
registers none. The phone is paired with the Mac, in Developer Mode, unlocked, awake and out of Low Power Mode; each
run's first and last lines say what Low Power Mode and the thermal state were. No phone has run it: the phone's build
has gone as far as signing, on a Mac whose Xcode had no account, so its install, its launch on the console and its
removal are as written and not as observed.
