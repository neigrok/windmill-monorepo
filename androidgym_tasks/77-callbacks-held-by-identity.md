# No screen keeps a callback from an earlier composition

**Status:** Not started. Waits for the logger Back fix (branch `fix-back-signout`) to reach main. Nothing visual changes.

**Context:** two Kotlin references to one local function compare equal, whatever they captured. So `rememberUpdatedState`, or any element that skips an update when the new value equals the old, can keep the first composition's callback. That is why system Back from the logger once said *The workout is not ready.* The in-flight fix holds `GymStage`'s `onBack` by identity, but the same trap sits in other places.

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Main's `GymStage` keeps `onBack` with `rememberUpdatedState` (`GymNavigator.kt:397`), and it is fed `::goBack` (`GymRoom.kt:953`).
- 34 `::localFun` references are passed as Compose callbacks in `:gym`, and 4 in `:app`. They include:
  - `GymRoom.kt:524,720,874,924`;
  - `ui/NotesScreen.kt:144` (`onSettle = ::reorder`, into `rememberUpdatedState`);
  - `ui/RoutineBuilder.kt:320,343,371`;
  - seven in `ui/OnThisPhoneScreen.kt`;
  - three each in `ui/BodyweightScreen.kt` and `ui/MovementPicker.kt`;
  - `coach/ThreadsScreen.kt:176,180`;
  - `app/…/MainActivity.kt:340-352`.

**Change**
- Fix each reference whose function captures composition values: pass a lambda, or have the receiver hold the callback by identity (`referentialEqualityPolicy`), as `GymStage` will.
- Some shared components (`WindmillSheet`, `GymMenuItem`, the swipe row) may store a callback with `rememberUpdatedState`. Make each of those hold it by identity, so callers cannot fall into the trap.
- Name the rule in `apps/android/README.md`'s Kotlin traps.

**Done when**
- Each shared component has a test proving that the latest callback runs after a recomposition that passes the same local function with new captures. The pattern is `GymNavigatorTests.backReachesTheLatestCallbackEvenWhenItIsTheSameLocalFunction`.
- The full `./gradlew build` passes.

**Depends on:** the logger Back fix (`android-logger-back-refuses-hide`). Tree: `android-local-function-references-compare-equal`.
