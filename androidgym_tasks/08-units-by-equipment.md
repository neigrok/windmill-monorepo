# Loads read kg each / kg total / kg added, with the equipment icon

**Approved flow:** [Routine editor](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) — ✅ Ready for dev, human-approved 2026-10-25. The four drawn equipment examples do not exhaust the stored domain.

**Figma:**
- 02.2 Routine summary: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28969) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44488)
- 02.5 Routine editor, always sortable: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30313) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44882)
- Components (Design System library, Android page): `Android / Equipment icon` `337:2025` (Barbell, Dumbbells, Bodyweight, Machine; Machine is `343:2377`, the Material Symbol `table_rows`).

**Implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Pure `sync.Readout.loadUnit` reads resolved equipment and load count. Matching Kotlin, Swift and web runners claim the nine shared `training-reads.json` cases; no iOS/web screen calls change.
- The two-argument app `Readout.targetWithUnit` puts a space before the equipment unit. Routine summary, editor, finish receipt and workout detail pass the resolved exercise. Missing or unknown equipment reads plain *kg*.
- The one-argument formatter remains the compact line used by the rack and Coach review. Coach draft/action presentation keeps its existing strings.
- `ui/EquipmentIcon.kt` draws only the four approved 24 dp variants from exact Figma exports in `design-assets/equipment/`, packaged as one theme-tinted xxxhdpi image per variant. Cable, kettlebell and unknown values do not borrow another glyph. Later tasks place the component.
- The dragged routine row uses the raised role, a 12 dp corner and M3 level 3 (6 dp) shadow. Handles remain visible.
- All six stored equipment values, resolved dumbbell counts, raw weights and volume survive name-only edits. The four-value creation menu stays separate from stored-record support.
- `apps/android/tools/capture-recipes/equipment-units.json` and its companion fixture reproduce the approved routine targets through the isolated MCP/database stack, including the native held-row state.

**Change**
- One load rule in the domain, next to `Readout` (with tests and shared vectors):
  - Dumbbells, two: *kg each*. Dumbbells, one: *kg*.
  - Barbell and Machine: *kg total*.
  - Bodyweight: *kg added*. A negative number is band help and still reads *kg added* (e.g. *−10 kg added*).
  - Always a space before the unit.
- Use a shared equipment-aware formatter outside Coach action cards: `targetWithUnit` takes the exercise; migrate routine summary, editor and receipt callers without losing supported cable/kettlebell behavior. Coach draft/action text retains its current formatting in this release under the owner's postponement of action-presentation changes. Apply the approved basis wording above to its drawn equipment only; preserve current wording for the two pending visual variants.
  - 02.2: *3 × 8 · 75 kg total* (barbell, machine), *3 × 10 · 24 kg each* (dumbbells).
  - 02.5: the same strings under each movement in the editor.
- Use *Barbell*, *Dumbbells*, *Bodyweight* and *Machine* for the four approved examples; preserve the existing *Cable* and *Kettlebell* values/labels for stored and seeded records. A name-only edit must retain equipment and load count exactly. Do not relabel cable as machine, kettlebell as dumbbell, or default an unlisted selection to barbell.
- Designer-owned gate `android-gym-equipment-variants-design` supplies Cable/Kettlebell icons, chooser states and load-basis wording with human approval before those visual additions: the four drawn variants do not approve those additions. Until that follow-up is approved, retain the existing supported-record presentation and semantics for those values; do not force the four-example formatter onto them. Keep the narrower new-movement menu distinct from stored-record support.
- Build `ui/EquipmentIcon.kt` from `Android / Equipment icon`. Machine draws `table_rows` (a weight stack). Later tasks place it (09, 10, 19, 20, 21, 23).
- 02.5: the lifted row is raised with a shadow (`Modifier.shadow`, M3 level 3); handles stay always shown.

**Out of scope:** the rack (09); Create movement (19); Edit movement (20); the picker rows (02.4 matches today); *· yours* on the summary's rows (50).

**Done when**
- Screenshots of 02.2 and 02.5 match in Dark and Daylight; the rig (01) adds `02.2-routine-summary-dark/light`, `02.5-editor-sortable-dark/light`.
- No new events: copy only. `gym_screen_viewed` `routine` and `routine_editor` still fire.
- `domain/ReadoutTests.kt` covers all six supported equipment values and the two dumbbell counts. Include seeded cable/kettlebell reads and name-only edits that leave equipment, raw weights and volume unchanged. Routine summary and editor tests assert full strings; Coach draft tests preserve the current strings. New visual variants stay gated until drawn and approved.

**Depends on:** 02.

**Ledger:** 11e; dogfood `android-gym-target-page`.
