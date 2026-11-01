# Android equipment units

Routine summary, routine editor, finish receipt and workout detail format the entered load against
the resolved catalogue. The pure shared `Readout.loadUnit` maps two dumbbells to `kg each`, barbell
to `kg total`, and bodyweight to `kg added`. One dumbbell, machine, cable, kettlebell, unknown
equipment and a missing exercise read `kg`. Signed loads remain signed; no formatter changes
weights, volume, equipment or load counts. The rack and Coach draft/action/review strings use their
existing formatters. A barbell or two-dumbbell load is 0 or more (`ExerciseRules.loadFloor`, shared
with Swift and web): the rack and Fix set refuse a lower load as it is typed, the movement editor
refuses a lower target, and their steppers stop at 0. A load already recorded below 0 stands: replays
of recorded facts never meet the floor, and a kept legacy load cannot be stepped down. Every other
loading keeps its sign.

The shared training-read corpus contains nine load-unit cases claimed by Kotlin, Swift and web.
Android full-string tests cover signed/open/ranged targets, resolved one/two dumbbell counts and the
missing-exercise fallback. An engine-backed rename regression retains all recorded sets, original
equipment/counts and 896 kg volume across seven seeded movements, including Cable and Kettlebell.
Routine sheet tests assert summary and editor text and persistent reorder handles.

The approved library component is `Android / Equipment icon`, Design System `337:2025`: Barbell
`337:2013`, Dumbbells `337:2017`, Bodyweight `337:2021`, Machine `343:2377`. Exact 24×24 SVG exports
live in `apps/android/gym/design-assets/equipment/`; their unmodified 4× rasters are tinted by the
native 24 dp component. No Cable/Kettlebell substitute is drawn. Placement belongs to later tasks.
Routine rows use a 6 dp native elevation and 12 dp rounded raised background while dragged.

Simplification keeps the rule next to the existing domain readout, with one explicit equipment-aware
overload at the app boundary. The workout-detail one-use plan-line helper is folded into its caller.
No entity, wire field, save action or creation-menu choice changes. Navigation keeps the existing
first-party screen events; this read-only change adds no telemetry fields or failure boundary.

Verification on the isolated task branch: 70 focused Android app tests, 75 gym-domain tests, 24
domain-kit tests and 509 domain-kit-testing cases pass without failures or skips; corpus and Android
layering gates pass. Web corpus 658/658 and domain typecheck pass. Swift product tests, including the
nine new vectors, and source/edge layering checks pass. The unchanged b4ce8fb3 baseline reproduces the full package run’s 82 unrelated checker issues:
50 layering failures (47 fixture, three real-tree) and 32 compile-probe failures deriving the invalid
`Products15.0` target from the Swift build-product path. Product source-row and dependency-edge
checks pass. The separate dogfood follow-up is `swift-local-domain-tooling-baseline`; task08 changes
no compiler, manifest parser or layering rule. The task branch includes the accepted task27 capture rig and task02 colour roles. Matching focused
Debug and Release suites pass 98 cases each, including unchanged Coach answers and editor behavior.
Two receipt assertions use the equipment-aware full string while retaining their recovery and
large-text overflow checks. Web's full Node20 gate passes 3,179 tests and four browser checks,
domain typecheck, Vite and landing-shell generation. Node20 matches the repository's CI runtime.

The optional capture fixture creates one missing custom movement and the approved Push A targets
through the supported MCP calls in the fresh local account. The default seed stays unchanged.
Capture reuses the reviewed generic partial-sync-prefix helper and native pointer lifecycle from
task04: one operation identity across retries, strict acknowledgement checks, bounded retries,
observed control bounds and pointer release in `finally`. All 29 Android tool tests pass. The full affected Gym gate passes 1,175 cases per Debug/Release variant, with 17 opt-in LiveWireTests
skipped per variant and zero failures/errors. The missing live-wire fixture is not counted as a pass.
Native API 37 captures show 02.2 summary, 02.5 sortable editor and the lifted row in both appearances;
Cable remains plain `kg`. They use base `d5470d34` plus task08 changes and APK SHA256
`dd21fb99741148504ece01e915845dc03fbcec5c70affe4cad56cec026826650`. The initial performance tail
stopped before measurement because back navigation did not wait for the restored routine sheet.
The recipe now waits for that sheet before dismissing it. No new timing result is claimed.
The targeted navigation run on the identical APK completes with no ANR/fatal and exports seven
`gym_screen_viewed` receipts, including `routine` and `routine_editor`, through the first-party
intake. Event properties contain only the screen label and common build metadata. Backend logs
record the scoped fixture writes without movement/routine names or provider credentials. The
repeated return check waits for `Start workout` after leaving the editor, then dismisses the sheet
and waits for `Routines`; no product navigation behavior changes. Task-owned listeners, emulator and
database are cleaned. Base integration onto main `e0799e36` has the identical tree as `d5470d34`.
