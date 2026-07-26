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
```

Each product depends on `WindmillPlatform`, never on another product — the same one-directional
rule the backend and web follow (`STRUCTURE.md`).

## Build

```sh
cd apps/ios && swift build && swift run
# → Windmill superapp — mounted products: Roadmap, Notes, Gym
```

Status: **compilable SwiftPM scaffold** — the module boundaries are real and build today. The
SwiftUI app wrapper (a `TabView` over the modules), Info.plist, asset catalog, entitlements, and
the API client against the shared backend are the next native wave.
