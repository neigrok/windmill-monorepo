# Windmill Android

One Kotlin superapp for the whole brand — the mirror of `apps/ios` and `web/`. `roadmap`,
`journal`, and `gym` are Gradle module libraries mounted by a single `:app` over a shared
`:platform`, behind one sign-in and one subscription. Modules stay independently mountable.

## Intended layout (mirrors iOS)

```
settings.gradle.kts        includes :app :platform :roadmap :journal :gym
platform/                  shared core: Account + the ProductModule seam + Superapp composition
roadmap/ journal/ gym/     one product module each (depends on :platform, never on a sibling)
app/                       the app — the only module that knows all three products exist
```

Each product depends on `:platform`, never on another product — the same one-directional rule
the backend, web, and iOS follow (`STRUCTURE.md`).

Status: **structured scaffold, not built here** — this environment has no Gradle / Android SDK
(and only Java 8), so the module tree and this contract are documented but not yet materialized as
build files. Standing up the Gradle project (AGP + Compose) and the API client against the shared
backend is a dedicated native wave, tracked as its own node.
