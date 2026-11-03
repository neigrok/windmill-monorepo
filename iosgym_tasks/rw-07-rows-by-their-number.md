# Rows by their number

**Status:** Designed (🚧, awaiting owner approval); not built.

**Figma:** Gym iOS 03.24b reps sheet: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16007) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16080); 03.25b Fix set: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16153) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16242); 02.15 per-set targets and the Coach diffs 08.22, 08.23, 08.27 and 03.32 already draw number-only rows.

**Context:** owner ruling 2026-11-03: a row is named by its number, never *Set 3*. Counts (*5 sets*) and the editor's *Sets* field keep the word. VoiceOver labels may keep *Set N*.

**Current implementation** (paths under `apps/ios/App/Sources/`)
- `Gym/Workout/WorkoutScreen.swift:99` titles the reps sheet *Set N*, with the movement as subtitle.
- `Gym/Components/SetEditor.swift:246` titles Fix set *Set N*.
- `Gym/Routines/RoutineMovementEditor.swift:184` labels each per-set row *Set N*.

**Change**
- The reps sheet and Fix set: title the movement (*Dumbbell Bench Press*), subtitle the row's place (*3 of 3*).
- Per-set target rows read *1*, *2*, *3*.
- Spoken labels keep their current words.

**Done when:** 03.24b, 03.25b and 02.15 match; the sheets read "Dumbbell Bench Press, 3 of 3" to VoiceOver.

**Depends on:** nothing. Tree: `ios-rw-07-rows-by-number`, under `ios-review-wave-parity`.
