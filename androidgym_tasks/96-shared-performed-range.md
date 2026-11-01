# Every surface states what was lifted, every set counted

**Status:** Domain and backend can start. The iOS receipt's change waits for its board: design brief item QW8. Android's own receipt already reads ranges.

**Figma:** the iOS receipt board QW8 names, once ✅ Ready for dev ([design brief](design-brief-quality-wave.md)). Android's receipt is 03.15/03.36 (🚀 In production).

**Context:** Android's receipt and workout page now count every set and print ranges (*3 × 6–8 · 75–80*). The shared domain read, the backend and iOS still count only the sets at the top load, so iOS and the server describe a workout as *1 × 8 · 80* where Android reads all three sets.

**Current implementation**
- Android: `store/EngineTraining.kt:915-917` builds the effort from every set (cadb48f6), and `FinishScreenTests.kt:46` pins it.
- Shared read: `sets.count { it.weightKg == top.weightKg }` (Kotlin `TrainingReads.kt:386-387`). Backend `topSetOf` (`Review.cpp:138,179`). iOS `Effort.reading` (`apps/ios/App/Sources/Gym/Workout/WorkoutReceipt.swift:99-103`).
- `training-reads.json` pins the top-set shape.

**Change**
- Agree an all-set read in the contract: set count, rep range and load range, with nullable derived metrics, signed loads and the historical equipment basis kept. Add vectors.
- Kotlin, Swift, web and the backend's review read it. Android's app-local copy in `EngineTraining` gives way to the shared read.
- Once QW8 is ready, iOS prints the range as drawn.

**Done when**
- The vectors pass on all three surfaces and the server, with nothing pending.
- Android's receipt is unchanged (its tests still pass), and its local copy is gone.
- The iOS receipt matches QW8.

**Depends on:** 23, design brief QW8 for the iOS screen. Tree: `gym-review-shared-performed-range`.
