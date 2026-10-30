# Edit movement replaces Rename movement

**Approved flow:** [Edit movement — plain equipment choices](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-7642), on the canonical Android page `56:2` — ✅ Ready for dev, human-approved 2026-10-26. This is the standalone Record editor; routine staging remains separate.

**Figma:**
- Barbell: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-7649) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-8163)
- Dumbbells: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-7762) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-8276)
- Other: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-7874) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-8388)
- Equipment menu: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-7986) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1548-8500)

**Implementation state**

The standalone `EditExercise` action, changed-field guards, alias preservation, shared vectors, account-pinned Android save boundary, approved Android sheet and iOS compatibility read states are shipped on main in `b314d4e2`. The eight iOS native states are accepted; all twelve Android canonical/responsive captures and first-party event/database checks pass. Shared domain, migration, backend Postgres and real HTTP compatibility gates pass; the exact evidence and bounded verification limits are recorded in [the phase note](../docs/engineering/android-edit-movement.md). The user authorized coordinated Android and iOS releases. Current source carries explicit `other` support and uncapped finite loads under schema 11 / minimum 11. The deployment guard and Android delivery-readiness prerequisite are on main. Production already advertises schema 11 / minimum 11; Android 0.13.0 and the coordinated iOS replacement remain pending. The [release runbook](../backend/deploy/README.md#coordinated-client-cutoff) records verified deployment, web, digest and iOS 0.2.0 (23) availability receipts. No optional-register alias or implicit migration is used.

**Change**
- Replace `RenameSheet` with `ui/EditMovementSheet.kt`; retain the current Record trigger until task 21 provides its menu.
- Title: *Edit movement*. Native outlined *Name* and *Equipment* fields, each 56 dp high. The approved 412 dp sheet has 372 dp fields and a 56 dp **Save** action.
- Exactly three equipment choices: *Barbell*, *Dumbbells*, *Other*. Menu rows are 48 dp high, with the approved icons and selected check.
- No One/Two selector, multiplier labels, or hints/warnings under either field. Do not add compatibility or storage explanations to the UI.
- Multipliers remain domain behavior: Barbell once, Dumbbells twice, Other once. Other covers machines, kettlebells, added weight and negative assistance. Signed load entry continues through the native keyboard.
- Existing display mapping: barbell → Barbell; dumbbell with resolved count two → Dumbbells; every other stored combination, including one dumbbell → Other. Name-only saves preserve the exact stored equipment/count and all raw history.
- Save is enabled only for a changed draft; show *Saving…* while busy. Cancel writes nothing. A refused save retains the draft and shows the full refusal in the error role below the fields.
- Preserve the `RecordScreen.onDraftOpen` callback so tile navigation cannot discard an open edit draft.

**Domain and storage**

Use the `domain-feature` skill. The standalone `EditExercise` action receives the opening exercise snapshot, compares only fields the user changed, and persists one changed-field Batch. Equipment and load count are guarded together when edited; untouched concurrent values survive. Keep existing alias/stale guards and legacy RenameExercise consumers. Do not call this action during routine staging or alter SaveRoutinePlan as part of the standalone UI.

Preserve all six legacy equipment values, existing one/two counts, raw weights and history. Explicit `other` support across backend and client domains is carried by current source registry schema 11 / minimum 11. Compatibility probes confirm older readers retain the string and calculate one load, but whole-movement validation on older iOS refuses it; the coordinated upgrade is required. The deployment guard rejects unacknowledged minimum changes; further deployment must preserve the live schema 11 / minimum 11 interval. Bound clients admit new writes for delivery only after a fresh compatible hello. New iOS or web selectors need their own design approval; this Android drawing approves neither.

**Approved iOS compatibility**

[Other read states](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1572-7844) are human-approved and ✅ Ready for dev on canonical iOS page `11:2`. The eight Dark/Light frames cover the rack, load and reps wheel, Fix set and existing Other in the movement editor. Other has no equipment glyph, uses kg, and the existing load/Fix wheel spans negative through zero to positive. Name/Equipment explanatory footers are removed globally. Existing picker choices and target controls remain; no Other picker option or new target sign button is introduced. The received Other target section has no equipment help, matching the approved form. Other categories retain their existing Targets help and the open-plan hint remains.

**Observability**

Emit `gym_action` with `screen=record`, `action=edit`, and bounded `outcome=ok/refused/failed`; never names, equipment values or account/replica IDs. Report unexpected boundary failures under `gym.editExercise`. List the flow in `docs/ANDROID_OBSERVABILITY.md` and verify first-party intake against the local stack.

**Done when**
- The approved Barbell, Dumbbells, Other and menu states match in Dark and Daylight; native small-height/large-text checks prove fields, refusal and Save remain reachable.
- Selection, dirty-state Save, busy state, refusal, cancel and recreation tests pass. Name-only Cable, Kettlebell and one-dumbbell edits retain their stored loading basis and derived volume.
- A delayed Save after account/replica change refuses before writing, including anonymous adoption that retains a replica ID.
- Shared domain vectors and engine rollback/race tests pass; actual local-stack events and failure receipts are verified.
- Refactoring/simplification and adversarial correctness/privacy/observability reviews are complete.

**Out of scope:** Record menu/subhead (21), Coach movement actions (35), routine SaveRoutinePlan staging, implicit data migration, uncoordinated client cutoff, new iOS or web picker designs.

**Depends on:** 08. **Ledger:** 11e, 9z; dogfood `android-gym-target-page`.
