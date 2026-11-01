# The Best tile follows the stated rule the records follow

**Status:** Not started. A shared domain rule and the backend; nothing visual changes.

**Context:** the log, Earlier records and the server's receipt all call something a new best only when it beats the best before it as stated, to 0.1 kg. The Best e1RM tile still picks the best by exact score. A later workout with the same stated e1RM can take the tile's date, so the tile and the records can disagree about when the best was set.

**Current implementation**
- Stated rule: `ProgressRecords` and `MovementProgress.records` (Kotlin `TrainingReads.kt:268,295-322`); Android's Earlier records (`presentation/Progress.kt:35`); the server receipt (`backend/products/gym/domain/Review.cpp:81-88`, `Progress.cpp:136`).
- Exact score: `MovementProgress.best` (Kotlin `TrainingReads.kt:257`; backend `Progress.cpp:113-119`). It feeds Android's Best e1RM tile (`presentation/Record.kt:47-52`) and web's Best line (`web/src/products/gym/progress/progress.js:62`).

**Change**
- `MovementProgress.best` is the first workout that reached the best stated value, so its date matches the record that names it. Apply this on Kotlin, Swift, web and the backend projection.
- Add a vector to `training-reads.json`: two workouts with the same stated e1RM on different days, where the tile dates the first.

**Done when**
- The vector passes on all three surfaces and the server, with nothing pending.
- On the emulator, a movement whose best was matched later keeps the earlier date on the tile and in Earlier records.

**Depends on:** 72. Tree: `gym-stated-best-everywhere`.
