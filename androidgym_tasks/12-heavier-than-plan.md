# Heavier than the plan

**Figma:** 03.6 Heavier than the plan: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30084) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34497)
- Component: `Android / Button` `656:6699` (Primary and Quiet).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `DeviationSheet` (`ui/DeviationSheet.kt:27`) opens when the lifter walks off a movement lifted heavier than planned.
  - Title *Heavier than the plan* (:42).
  - Body: *Today’s {movement} ran at {w} against a planned {p}. Today’s session already has it. {routine} does not.* (`domain/Deviation.kt:26-28`). The numbers carry no unit.
  - On a ladder, *set n · a → b* lines (`ui/DeviationSheet.kt:53-60`).
  - Primary *Save {w} to {routine}*, or *Save today’s sets* on a ladder (`domain/Deviation.kt:23-24`, `domain/Program.kt:103`). Quiet *Today only* (`ui/DeviationSheet.kt:86`).
- The save calls `store.save` (`ui/LoggerScreen.kt:507`) and emits no event.

**Change**
- Body: *Today’s {movement} ran at 47.5 kg against a planned 45 kg. Today’s workout already has it. {routine} does not.* Loads carry their unit by equipment (08): *kg each*, *kg total*, *kg added*.
- Primary: **Update {routine}**, for both the single load and the ladder. Delete *Save {w} to {routine}* and *Save today’s sets*.
- **Today only** stays the quiet button.
- The ladder's *set n · a → b* lines stay, with units.

**Out of scope:** the rack (09); the finish receipt (14).

**Done when**
- Screenshots of 03.6 match in Dark and Daylight; the rig (01) adds `03.6-heavier-dark/light`.
- New `gym_action` with `screen` `workout`, `action` `edit`, `outcome` `ok` / `refused` / `failed` when **Update {routine}** settles, content-free. **Today only** writes nothing and emits nothing.
- An unexpected failure still reports under `gym.save`.
- `ui/DeviationSheetTests.kt` and `domain/DeviationSheetTests.kt` assert the new sentence and button in full.

**Depends on:** 08.

**Ledger:** 9z, 11b, 11c; dogfood `android-gym-target-page`.
