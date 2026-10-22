# Targets sheet on steppers, and each set

**Figma:**
- 02.6 Targets: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-30392) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44962)
- 02.11 Targets, each set: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-29263) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-45508)
- Components (Design System library, Android page):
  - `Android / Number stepper` `337:2514`
  - `Android / Keyboard` `337:2403` (Number and Decimal)
  - `Android / Swipe row` `337:2217`
  - `Android / Button` `210:181`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- The sheet (`ui/RoutineBuilder.kt:451-491`): the movement name, *{pos} of {N} · {routine}* (:468), *Cancel*, `TargetBlock`, and the commit *Set · {summary}* (:487, `TargetEntry.commitLabel`).
- `ui/TargetBlock.kt`:
  - *Target* and the summary (:166-170); *You decide the numbers at the rack.* when open (:171).
  - Three stepper rows *Sets*, *Reps*, *kg* (:172-183): a 56 dp `raised` `−` / `+` box with radius 16 (`TargetStepKey`, :398-408) around an 88 dp mono `BasicTextField` (:368-391). Placeholders *open*, *max*, *—*, and *varies* when sets differ.
  - Bodyweight adds a `±` key, *Flip the sign — band-assisted* (:185-187, :426).
  - Caption *kg blank: pick it at the rack the first time; after that, last time fills it.* (:189).
  - *Ramp up* and *Vary by set* are `TextButton`s on `raised`, 40 dp tall (:190-209).
  - *Each set* + *Fill* (:210-219); the ladder header *Set / Reps / kg* (:222-230); each row two outlined fields; a row swipes away on `RowDeleteGround` (:264-277); *+ Add set*, 56 dp (:330-341).

**Change**
- Sets, Reps and the weight become `NumberStepper` (04): 48 dp tonal − / + around a filled field, labelled *Sets*, *Reps* and *Load*, each with its unit as the suffix.
  - 02.6 reads *Sets* 3 *sets* · *Reps* 8 *reps* · *Load* 75 *kg total*; 02.11 reads *Reps* 8 *reps* · *Load* varies *kg total*.
  - The weight row's label *kg* becomes *Load* (the rack and Coach's cards say *Load* too).
  - Sets and Reps open `KeyboardType.Number`; Load opens `KeyboardType.Decimal`. `ImeAction.Done` commits.
  - Load carries the load-basis suffix from 08: *kg total* (barbell, machine), *kg each* (two dumbbells), *kg added* (bodyweight).
  - Placeholders stay *open*, *max*, *—*; Load reads *varies* when sets differ (02.11).
  - Keep the bodyweight sign key: the boards do not draw it, and some decimal keyboards have no minus.
- The summary line reads with its unit: *Target* · *3 × 8 · 75 kg total*.
- Keep the caption *kg blank: pick it at the rack the first time; after that, last time fills it.*
- *Ramp up* and *Vary by set* become M3 `FilterChip`s (32 dp visual, 48 dp touch target). *Vary by set* shows selected while the ladder is open (02.11).
- Each set (02.11):
  - *Each set* with the *Fill* text button and its menu (*Ramp up* / *Match set 1*) as today.
  - Header *Set / Reps / kg total* (the suffix follows the movement's basis).
  - Each row: two M3 `OutlinedTextField`s; the focused one shows the accent outline.
  - *+ Add set* as today; at the ceiling *Sets, 1 to 20.*
  - A row swipes away on `DeleteSwipeRow` (04), a11y label *Remove set*. It leaves the draft at once, as today.
- Commit button (`Android / Button` Filled, 56 dp): *Set · 3 × 8 · 75 kg* (02.6) or *Set · 5 sets* (02.11).
- Delete `TargetStepKey` and the 88 dp field. Keep `TargetBlock(scheme, onChange)` as the seam (F38): the editor, Create movement (19) and Coach drafts all use it.

**Out of scope:**
- The stepper component (04), units (08), the editor list (02.5, 08).
- Create movement's own fields (19).

**Done when**
- Screenshots of 02.6 and 02.11 match in Dark and Daylight, keyboard closed and open; the rig (01) adds `02.6-targets-dark/light` and `02.11-targets-each-set-dark/light`.
- TalkBack: each stepper reads its label, value and unit, and − / + read *Decrease Sets*, *Increase Load* and so on, as today.
- `gym_routine_saved` still fires on Save (the targets sheet itself saves nothing).
- Tests: `ui/TargetSheetTests.kt`, `ui/TargetSheetLadderTests.kt`, `ui/TargetSheetLayoutTests.kt`, `ui/TargetSheetSignKeyTests.kt`, `ui/CreateMovementTargetTests.kt`, `domain/TargetEntryTests.kt` (the commit label with its unit).

**Depends on:** 04, 08.

**Ledger:** 11d, F38; dogfood `android-gym-target-page`.
