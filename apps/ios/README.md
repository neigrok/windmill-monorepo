# Windmill iOS

One Swift superapp for the whole brand. `roadmap`, `notes`, and `gym` are module libraries
mounted by a single app over a shared `WindmillPlatform` — the native mirror of `web/`
(shell + design-system + products). One sign-in, one subscription. Modules stay independently
mountable, so any product can later graduate into its own focused app.

## Layout

```
Package.swift
Sources/
  WindmillPlatform/    shared core (Account, the ProductModule seam, Superapp composition)
  WindmillRoadmap/     product module  (RoadmapModule : ProductModule)
  WindmillNotes/       product module
  WindmillGym/         product module
  Windmill/            the app — the only target that knows all three products exist
Tests/
  WindmillGymTests/    the weight ladder against packages/api-contract/gym-ladder.json
```

Each product depends on `WindmillPlatform`, never on another product — the same one-directional
rule the backend and web follow (`STRUCTURE.md`).

## Build

```sh
cd apps/ios && swift build && swift run
# → Windmill superapp — mounted products: Roadmap, Notes, Gym

cd apps/ios && swift test
```

`swift test` needs XCTest, which ships with Xcode and not with the Command Line Tools. If it
answers `error: XCTest not available`, point the toolchain at Xcode for the run:
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test`. CI is already there.

Status: **a scaffold with its first real product logic.** The module boundaries are real and build
today, and `WindmillGym` now carries the weight ladder (`Ladder.swift`) — the rule that moves a
lifter's weight by a tap. It has a twin in `web/`, so neither file is the truth: both run
`packages/api-contract/gym-ladder.json` as a test, and `.github/workflows/ios.yml` makes drift
between them fail CI. The SwiftUI app wrapper (a `TabView` over the modules), Info.plist, asset
catalog, entitlements, and the API client against the shared backend are the next native wave.
