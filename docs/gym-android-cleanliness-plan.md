# Gym Android · cleanliness build plan

Builds the graduated Android canon on `Android · Screens` in Windmill · Gym (`vdmdiKWrmZoS1FtcvJRf6O`).
The written canon is `docs/design/gym/briefs/15-the-routine.md`, `18-progress.md`, `11-bodyweight.md`
and `android-delivery.md`. The five drift entries filed 24 September 2026 in
`docs/design/consistency.md` are the acceptance list: each wave closes its entries.

Scope is Android only (`apps/android`, module `:gym`). iOS and web keep their current screens; the
phones diverge on these points by the owner's ruling, recorded in the ledger.

## Key decisions

1. **No backend change.** Every wave is a client change. Wire fields that Android stops showing —
   `restSeconds`, `restSound`, routine history — stay on the wire, because the web, iOS and MCP still
   read them. Android stops reading or writing them. It never rewrites them to null.
2. **Delete, don't hide.** Removed features leave no flag, no dormant code and no preference key
   behind. A value already stored on a device is ignored. It is not migrated.
3. **Rest leaves the phone entirely.** That covers the Settings row and sheet, rest alerts, the
   exact-alarm permission request, the notification's rest target line and alert, and the
   `Rest m:ss` line under routine entries. The ongoing workout notification keeps the routine,
   movement, rack line and set counter.
4. **A routine is the plan and nothing else.** Tapping a routine opens a `ModalBottomSheet` over the
   list, not a pushed screen. The sheet holds the name, the plan, `Start workout` and
   `Edit routine`. The routine sheet and the editor never call `routineHistory`. Past workouts and
   progress are reachable only from the Log.
5. **Moments are derived, not stored.** The woven timeline is one pure domain function. It takes the
   sessions, the `StatsProgress` the app already reads and the bodyweight entries, and returns an
   ordered list of `Session | Moment`. No new endpoint and no persistence, and the same inputs
   always give the same list.
6. **The moment rule is fixed in code and unit-tested.** A moment is one of: a new best for a
   movement (a new standing e1RM best from `MovementProgress.records`), a weigh-in, or a calendar
   month trained in full. At most one moment per week. When two compete, the priority is best,
   then month, then weigh-in. A moment is dated to the day it happened, and it sits in the list by
   that date.
7. **A moment expands in place.** An expanded moment shows the chart, window line, best and heaviest,
   with `Open record ›` to the existing Record screen. A weigh-in moment opens Bodyweight. Only one
   moment is open at a time.
8. **The Log head carries no numbers.** The loaded line, `Trained N of the last 4 weeks`, the
   bodyweight reading row and the `ProgressCard` strip are deleted. The `Weigh in` chip stays
   pinned as the one write door.
9. **A movement's record stays reachable without a moment.** A lifter on a plateau gets no cards, so
   movement names in a session readback open that movement's Record. This already exists at
   `SessionScreen.kt:428`; the wave keeps it and tests it.
10. **Create movement adds the target on the same sheet, on the routine path only.** The create sheet
    returns the exercise together with its scheme. The builder adds both in one draft step, so the
    movement lands on the routine with its target and never passes through the `Open` state. The
    quick path used mid-workout stays name and equipment.
11. **The target control is one composable behind a stable seam.** Both the create sheet and the
    editor's target sheet use a single `TargetBlock(scheme, onChange)`. It reads and writes the
    existing `Scheme` / `SetTarget` model. It is first built as the drawn stepper rows (`Android /
    Stepper row`, 3 × 10 prefill, kg blank, Ramp up, Vary by set). When the owner decides concern 03,
    only the inside of `TargetBlock` changes.

## Waves

Each wave goes through the gauntlet: adversarial review of the diff, one fix pass, e2e on the local
stack and emulator, then push. The waves touch different files (disjoint territories), so waves 1–3
can run in parallel across developer agents.

| Wave | Closes | Territory | Notes |
|---|---|---|---|
| 1 · Rest out | rest-timer drift | `SettingsScreen`, `WorkoutNotification*`, `notification/`, `Preferences`, the rest line in `RoutinesScreen` | Delete the manifest's exact-alarm permission. Run a notification regression on the emulator. |
| 2 · Routine is a sheet | routine-sheet and editor-history drift | `RoutinesScreen`, `RoutineBuilder` (history block only) | Row meta names the first movements. Delete `routineHistory` from the store if nothing else calls it on Android. |
| 3 · Woven Log | Log drift | `LogScreen`, a new timeline in `domain/`, `SessionScreen` (door test only) | The domain function and its tests land first, then the UI. `ProgressCard` and the head readouts are deleted. |
| 4 · Target on create | create-movement drift | `MovementPicker`, `RoutineBuilder` (add path), `Program`, the new `TargetBlock` | Starts after wave 2 merges, because both touch `RoutineBuilder`. The editor's target sheet moves onto `TargetBlock` in the same wave. |

After the waves comes one simplification pass: delete dead strings, orphaned composables and unused
store reads. Then release through the Android release flow as one version.

## Verification

- **Domain:** full-assertion unit tests for the moment rule (each kind, the one-a-week cap, the
  priority, month boundaries and time zones) and for the scheme round trip through `TargetBlock`.
- **Emulator:** against the local stack, each canonical board is screenshotted beside its
  implementation: Routines / Detail `813:4935`, Routines / Edit `820:5572`, Create · Routine
  `814:5104` / `669:8424`, Gym settings `816:5410`, Log / History `837:14824`, Log / Moment expanded
  `837:14932`.
- **Close-out:** each wave deletes its drift entries from `consistency.md`, updates
  `android-delivery.md`, and records its node in the dogfood tree.

## Open

- **Concern 03 (target-entry control)** is an owner decision. It blocks only the inside of
  `TargetBlock`, not wave 4.
- **Moment history window.** Check that the `StatsProgress` the Log reads spans the whole list,
  not only a recent window. If it doesn't, older sessions show no moments, and that is a decision
  to surface, not to patch around.
- **iOS parity** is not planned here. The ledger records the divergence, and following it on iOS
  is a separate owner call.
