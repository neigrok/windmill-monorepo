# Remove set types (warm-up, drop, failure) from the Android code

**Figma:** no board draws a set type. The ledger on the rack (03.1, task 09) shows *Set / kg / Reps* with no *W*, and Fix set (03.3, task 10) has no kind control. The import boards (07.2, 07.3) belong to task 25.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Domain:
  - `enum class SetKind(val wire: String) { Warmup("warmup"), Working("working"), Drop("drop"), Failure("failure") }` and its serializer (`domain/Training.kt:17-29`).
  - `TrainingSet.kind` (:156), `SetFix.kind` (:491, :505, :511).
  - Only working sets count: volume and top set (:194-199), the slight-workout test (:385), routine-from-workout (:417). Warm-ups are left out of records and last time (:237-276, :476).
  - The sync model keeps `kind` with a choice rule `listOf("warmup", "working", "drop", "failure")` and counts volume for `"working"` only (`apps/android/gym/domain/src/main/kotlin/works/windmill/gym/domain/sync/Training.kt:32-36`, :59).
  - `TrainingStore.logSet(…, kind: SetKind = SetKind.Working)` (`store/TrainingStore.kt:749-754`).
- UI:
  - The logger indexes a warm-up *W* in faint ink and speaks *Warmup, logged, …* (`domain/LiveSession.kt:70-74`, :147-153; `ui/LoggerScreen.kt:770`, :780).
  - Workout detail prints the wire (*warmup* / *drop* / *failure*) as a set note (`ui/SessionScreen.kt:128`).
  - Record's recent sets append it: `"$effort ${set.kind.wire}"` (`domain/Record.kt:42`).
  - Fix set passes the kind through: `kind = set.kind` (`ui/FixSheet.kt:249`).
  - The finish receipt counts working sets only (`ui/FinishScreen.kt:164`, :168).
  - Saved-workout recovery offers kinds (`ui/SettingsScreen.kt:296`, :375). Task 25 removes that UI.
  - `warmupInk` (`ui/GymSkin.kt:47`).
- The shared domain vectors in `packages/api-contract/gym/domain` (`rules.json`, `values.json`, `training-actions.json`, `training-reads.json`) still mention `warmup`.

**Change**
- Every set is a working set. Delete `SetKind`, `SetKindSerializer`, `SetFix.kind`, `isWarmup`, the *W* index, the *Warmup* spoken prefix, the wire note on workout detail, the Record suffix and `warmupInk`.
- Drop every kind filter: volume, top set, records, last time, the slight test and routine-from-workout count every set.
- Keep reading the wire field on old rows, then ignore it. Write `"working"` for every new set until the schema drops the field.
- Change the shared vectors first, so iOS, web and Android follow one rule, then make the Kotlin domain pass them.

**Out of scope:** the Fix set redesign (10); the rack ledger's layout (09); the import recovery UI (25); Record's other copy (21).

**Done when**
- No `SetKind` remains in `apps/android`.
- Totals, e1RM, records, last time and the ledger count every set.
- Domain tests and the shared vectors pass: `domain/TrainingTests.kt`, `domain/LiveSessionTests.kt`, `domain/RecordTests.kt`, `domain/SetFixTests.kt`, `ui/FixSheetStateTests.kt`, `ui/SessionScreenTests.kt`.
- Existing events are unchanged: `gym_set_logged`, `gym_session_finished`.

**Depends on:** none.

**Ledger:** 9c; dogfood `android-gym-target-page`.
