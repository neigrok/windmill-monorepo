# api-contract

Wire shapes shared across backend, web and native — checked in as data and run as a test by every
surface that implements them, so drift fails CI.

## `genesis.js`

A locally-born tree's first sync converges with the server's empty tree only while this seed is
byte-equal to the backend's (`Legend::seededDefaults` + `Hlc{1,0,"genesis"}`). Read by
`web/vite.config.js`, which fails the build on drift; pinned backend-side by `TreeRegistryTest`.

## `gym-ladder.json`

- The step pair is chosen by the **magnitude** of the weight, never its sign: under 20 kg ±1 / ±2.5,
  under 50 kg ±2.5 / ±5, at or above 50 kg ±2.5 / ±10.
- A step that *reduces the magnitude* picks its band with `magnitude <= boundary` rather than `<`,
  so a step landing on a boundary is undone by its opposite (`19 +1→ 20 −1→ 19`) while a step that
  crosses one is not (`19.5 +1→ 20.5 −2.5→ 18`).
- Lightening is `direction × weight < 0`, not "going down": the ladder walks through zero into
  assisted territory. `bump(−w, −direction, big) == −bump(w, direction, big)` for every input.
- Weights are stored to two decimals, rounded **half away from zero**: `round(−x) == −round(x)`.
  JavaScript's `Math.round` is half-up, so round the magnitude and reapply the sign. The rounding is
  `round(x × 100) ÷ 100` in IEEE-754 doubles, not decimal rounding of the typed string.
- The rep floor is **1**, and it clamps into the range rather than holding: `bumpReps(0, −1)` is `1`.

Read as a test — each from this file in the repo, never a bundled copy — by:

- `web/test/products/gym/logger/ladder.test.js` → `web/src/products/gym/logger/ladder.js`
- `apps/ios/WindmillKit/Tests/WindmillGymTests/LadderTests.swift` → `apps/ios/WindmillKit/Sources/WindmillGym/Ladder.swift`
- `apps/android/gym/src/test/kotlin/works/windmill/gym/domain/LadderTests.kt` → `apps/android/gym/src/main/kotlin/works/windmill/gym/domain/Ladder.kt`
