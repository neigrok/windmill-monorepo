# No screen keeps a callback from an earlier composition

**Status:** Not started. Nothing visual changes.

**Context:** two Kotlin references to one local function compare equal, whatever they captured. So `rememberUpdatedState`, or any element that skips an update when the new value equals the old, can keep the first composition's callback. That is why system Back from the logger once said *The workout is not ready.* e99a77c8 fixed that one place by holding `GymStage`'s `onBack` by identity, but the same trap sits in other places.

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `GymStage` holds `onBack` with `referentialEqualityPolicy` (`GymNavigator.kt:399`), fed `::goBack` (`GymRoom.kt:949`). The same function still keeps `standing` and `animate` with `rememberUpdatedState` (`:396-397`), and `keep` and `ask` too (`:284,296`).
- These counts were taken on 28c3d48a, before e99a77c8 moved lines in `GymRoom.kt`; recount before starting. 34 `::localFun` references are passed as Compose callbacks in `:gym`, and 4 in `:app`. They include:
  - several in `GymRoom.kt` (`enterCoach`, `openCoachWorkout`, `hideWorkout`);
  - `ui/NotesScreen.kt:142` (`onSettle = ::reorder`, into `rememberUpdatedState`);
  - `ui/RoutineBuilder.kt:318,343,371`;
  - seven in `ui/OnThisPhoneScreen.kt`;
  - three each in `ui/BodyweightScreen.kt` and `ui/MovementPicker.kt`;
  - `coach/ThreadsScreen.kt:177,180`;
  - `app/…/MainActivity.kt:340-352`.

**Change**
- Fix each reference whose function captures composition values: pass a lambda, or have the receiver hold the callback by identity (`referentialEqualityPolicy`), as `GymStage` will.
- Some shared components (`WindmillSheet`, `GymMenuItem`, the swipe row) may store a callback with `rememberUpdatedState`. Make each of those hold it by identity, so callers cannot fall into the trap.
- Name the rule in `apps/android/README.md`'s Kotlin traps.

**Done when**
- Each shared component has a test proving that the latest callback runs after a recomposition that passes the same local function with new captures. The pattern is `GymNavigatorTests.backReachesTheLatestCallbackEvenWhenItIsTheSameLocalFunction`.
- The full `./gradlew build` passes.

**Depends on:** the logger Back fix (e99a77c8, on main). Tree: `android-local-function-references-compare-equal`.
