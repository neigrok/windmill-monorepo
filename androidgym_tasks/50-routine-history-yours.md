# The routine editor's History, and *· yours* on a movement the lifter made

**Design status:** The paired 02.13 History states and their caption are 🚀 In production on the canonical Android page (`56:2`). The shared routine editor is also in production.

**Approved flow:** [Routine editor](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) — human-approved 2026-10-25.

**Figma:**
- 02.13 Routine editor, History: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39087) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-39184)
- 02.2 Routine summary draws the *· yours* row: *Landmine Press · yours* / *3 × 10 · 20 kg total* (board linked from 08).
- iOS ships both and is the model: History in `apps/ios/App/Sources/Gym/Routines/RoutineBuilder.swift:173-180` over `routineHistory` (`RoutinesTab.swift:262-264`); *· yours* in `RoutinesTab.swift:128-129`.

**Current implementation**
- The outer routine editor reads its last twenty finished workouts from the full local replica, filtering the routine before the limit and counting every set. It retains the outer draft while the read completes and shows no empty section for a new routine.
- History uses the approved read-only date/facts rows under Add movement. It emits no write, save or event.
- Only routine-summary movement names whose identities are outside the seed catalogue gain `· yours`.
- The 19 selected history, editor and summary tests pass with no failures, errors or skips. Paired native History and custom-summary acceptance is complete with the qualifications below.

**Change**
- 02.13, History in the outer routine editor, under **Add movement**: a section *History* with the routine’s last 20 finished workouts, newest first. Combined movement Add/Done stages only; this read-only section must not trigger metadata writes or bypass 18’s atomic outer Save. It does not create a separate Targets route.
  - Each row: the day as its title (*Tue, Oct 20*) and its facts (*15 sets · 5 movements*). This approved wording counts every set under 06, without kind filtering.
  - Shown only once the routine has a finished workout; rows are read-only. A new routine has none.
- 02.2, *· yours*: in the routine sheet, a movement whose id is not in `SeedExercises` reads *{name} · yours*. Apply the same rule wherever iOS does (the summary), nowhere else.

**Out of scope:** the editor's rows and units (08); the picker (02.4).

**Done when**
- Screenshots of 02.13 match in Dark and Daylight, and 02.2's *Landmine Press · yours* row matches; the rig (01) adds `02.13-editor-history-dark/light` and recaptures `02.2-routine-summary-dark/light` with a custom movement in Push A.
- No new events for the read-only section and label. Routine staging and Save events remain 18’s responsibility; History must not emit a save or discard the outer draft.
- Tests: `ui/RoutineEditorTests.kt` (History hidden for a new routine, 20 rows newest first, the facts line), `ui/RoutineSheetTests.kt` (*· yours* only on a non-seed movement).

**Depends on:** 06, 08, 18.

**Ledger:** 12i; dogfood `android-gym-target-page`.

**Native acceptance:** Dark and Daylight captures show three finished workouts, each with 15 sets across five movements, and the custom Landmine Press summary marker. The editor retains the plain movement name. Authenticated GET/SQL and local replica facts agree; opening History changes no fact, outbox or device row and leaves account GET exact. At 320 dp/200% text, the final scroll position shows all three complete dates and wrapped fact rows, including the last row. The existing editor-header ellipsis remains qualified; the postponed Target-summary layout is unchanged.

**Evidence and limits:** Source `95d4016f`, APK `5d2978d65`, ran on API 37 against schema/minimum 11 backend `0d202838`. `/private/tmp/android-task19-50-native-20261030/NATIVE_REVIEW.md`, `history-readonly-assertions.json` and `final-manifest.json` retain paired captures, exact GET/SQL and read-only local evidence. The twenty-row limit, filtering before the limit, open-workout exclusion and owner-change races remain the focused source-test proof. Ordinary screen-navigation events remain; History and the summary marker add no event or write. Background replica clock metadata can advance during read-only inspection without changing training facts.

**Engineering observations:** History reads the complete owner-scoped replica before applying its routine filter and limit. The summary marker uses seed identity rather than equipment or a mutable name, so catalogue selection and historical facts retain their stored metadata.
