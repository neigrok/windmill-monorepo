# Create movement in a routine draft or an active workout

**Design status:** The paired 02.9/02.14 creation states and their captions are 🚀 In production on the canonical Android page (`56:2`). The shared editor and equipment control are also in production.

**Approved flow:** [Routine editor](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) — human-approved 2026-10-25. The live-workout picker/custom-create return is covered by the approved [Workout flow](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036).

**Figma:**
- 02.9 Create movement: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29027) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45281)
- Components (Design System library, Android page):
  - `Android / Equipment icon` `337:2025` (Machine is Kind=Machine `343:2377`)
  - `Android / Menu` `342:2725` (the Equipment options)
  - `Android / Number stepper` `337:2514`
  - `Android / Keyboard` `337:2403`
  - `Android / Button` `210:181`

**Shared equipment control:** [Canonical Android section](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-7642), 🚀 In production, human-approved 2026-10-26. The existing creation drawings use this approved shared control, with no One/Two selector or Name/Equipment hint. Their form and return-flow composition is retained.

**Current implementation**
- Routine creation uses the existing combined movement form and stages identity, equipment, load count and targets only in the outer routine draft. Its Add performs no catalogue write; the existing outer Save owns the atomic plan.
- Live creation uses the same Name/Equipment fields with the approved three choices and no routine targets. The creation operation belongs to the application scope and pins the account, replica and workout. It reconciles the same identity before retrying and retains a known created movement separately from a failed insertion.
- Typed values, request identity, submitted details and known creation survive activity recreation. Cancel returns to the picker; successful creation and insertion return to the preserved rack. Sheet windows reuse native keyboard handling and system insets.
- Focused tests cover explicit load counts, NFC-normalized creation/retry, create and insertion failures, retained results, cancellation, stale workout/account boundaries and separate creation-completion versus catalogue-selection callbacks. The retained focused receipts cover 39 gym cases and 10 telemetry cases. The final callback/dismissal/mint gate passed all 13 cases with zero failures, errors or skips. Native acceptance is complete with the qualifications below.

**Change**
- Reuse the combined Name/Equipment/Targets form from 18 for routine creation. Name is an M3 `OutlinedTextField`; Equipment is an exposed dropdown with the existing approved icons. The three choices are *Barbell*, *Dumbbells* and *Other*, with implicit multipliers 1/2/1 and shared values `barbell`, `dumbbell`, `other`. Existing catalogue records keep their raw equipment/count on selection and name-only edits.
- There is no One/Two selector, multiplier label, or Name/Equipment help/warning. A new Dumbbells movement uses two; Other uses one and supports signed load through the native keyboard. Number/Decimal input follows 07/18. Existing one-dumbbell data is preserved, displayed as Other by the shared choice control, and is never coerced by opening this form.
- Routine context: **Add** stages new identity, equipment, load count and targets in the outer routine draft. No `store.create` / `CreateExercise` call occurs here. Only outer **Save** invokes the existing `SaveRoutinePlan` (18). Cancelling custom creation returns to the picker; cancelling the outer routine leaves no created movement or metadata write.
- Live-workout context is separate: enter via movement name → **This workout** → **Add movement** (11). This context has no outer routine Save. **Create and add** owns its existing create/append boundary, passes the category’s implicit load count through the store/engine adapter into `CreateExercise`, then adds/selects the movement in the current workout and returns to the preserved rack. Do not stage this work in an unrelated routine draft or modify the source routine’s targets.
- Persist the creation identity and known result across recreation/retry, and distinguish catalogue creation from workout insertion. An uncertain receipt is not a known success or a safe fresh create: reconcile the same identity/result before retrying or reporting an outcome. If creation succeeds but insertion refuses, retain that known result and retry only the remaining insertion; never claim nothing was created or create a duplicate on retry. Before a successful create, Cancel writes nothing. Custom-create Cancel returns to the picker; picker Cancel returns to This workout. Existing workout ID, sets and rack drafts survive every return path.
- Use the error role for validation and retain typed values after refusal. Fix sheet presentation and navigation so selection/creation never leads to a grey screen. Respect status/navigation insets after mode switch or activity recreation (`WindmillSheet`/`contentWindowInsets`), and keep the focused field, error and primary action reachable above the IME.
- No separate Cable/Kettlebell choices are added. Their existing stored metadata and history remain intact.

**Out of scope:** the outer routine write implementation (18); standalone Record editing (20); the This workout management sheet (11).

**Done when**
- Capture the approved routine form and live custom-create/return states in Dark and Daylight, including keyboard, validation and recreation. Existing catalogue selection, custom Cancel and picker Cancel all return to their stated parent without a blank surface.
- Routine Add → outer Cancel yields no new catalogue/alias/routine writes. Outer Save persists the chosen count and targets atomically through 18. Test all three categories with correct volume and signed Other loads; preserve existing one-dumbbell, cable and kettlebell records on selection/name-only edits.
- Live creation → insertion succeeds once and preserves the rack. Verify refusal before creation, creation succeeded/insertion refused, retry, recreation and cancellation; the routine remains unchanged. Reuse existing domain creation/load-count vectors rather than duplicating the action.
- Track content-free `gym_action` steps separately: routine staging is `stage`, live creation/add has actual `ok|refused|failed` outcomes. No create-success event on routine Add. Document bounded labels in `docs/ANDROID_OBSERVABILITY.md`; no names, search text, equipment, targets or IDs. Unexpected creation failures retain `gym.create`; insertion failures use their static store boundary operation.
- Update `CreateMovementTargetTests`, picker navigation, planning-write and engine-adapter tests for context-specific write ownership and loadCount propagation.

**Depends on:** 04, 08, 11, 18.

**Ledger:** 11e; dogfood `android-gym-target-page`, `android-sheets-after-recreation`.

**Native acceptance:** The paired routine/live forms, three equipment choices, native keyboard, blank-name gating and appearance replacement passed on API 37 with schema/minimum 11. Staged Add then outer Cancel retained catalogue/routine/workout facts and created no identity; a separate outer Save persisted one Dumbbells movement with implicit count 2 and three 10-rep targets at 12.5 kg. Live Other creation added one identity/order entry while preserving the workout, logged set, source routine definition and two rack drafts. Native picker Back and Cancel return to This workout; a further Back returns to the rack. Keyboard-first Back hides the IME without dismissing the picker. The corrected build emits one open/cancel transition across recreation and one create/add pair for its successful creation, with bounded labels only.

**Evidence and limits:** The broad native freeze is source `95d4016f`, APK `5d2978d65`; the accepted five-file callback/telemetry delta is patch `38ccc11ac263`, same-key APK `0ab7cc1a`. `/private/tmp/android-task19-50-native-20261030/NATIVE_REVIEW.md` and `final-manifest.json` retain the exact source, tests, captures, read-only replica copies, authenticated GET/SQL, events and Sentry SDK receipts. Known-result technical retry, injected storage failures and stale-owner races remain source-test coverage; no native unexpected-failure Issue is claimed. The fixture's unrelated AI installation bind returns 503 without an installation secret. The postponed Target-summary layout is unchanged.

**Engineering observations:** The logger creates its reused Material sheet with native dismissal disabled and routes Assembly, Picker and Fix Back through their current explicit dispatcher. This preserves keyboard priority and avoids the Material dialog's captured initial native callback. Live-create cancellation shares one guarded callback for button, Back, handle and scrim; repeated dismissal cannot emit a second event. Native fixture routines represent an open target by omitting the sets field, and separate accounts use globally distinct custom movement IDs.
