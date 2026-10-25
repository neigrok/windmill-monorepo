# The rack: compact headerless ledger, visual movement position and preserved draft

**Approved flow:** [Workout](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) — ✅ Ready for dev, human-approved 2026-10-25.

**Figma:**
- 03.1 Rack, Dumbbells, kg each: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34026)
- 03.12 Rack, Bodyweight, kg added: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28687) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34230)
- 03.13 Rack, Barbell, kg total: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28829) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-34284)
- Components (Design System library, Android page):
  - `Android / Number stepper` `337:2514` (the load field is the Display size)
  - `Android / Equipment icon` `337:2025`
  - `Android / Button` `210:181` (Log set)

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `MovementHead` (`ui/LoggerScreen.kt:571`): *‹* / *›* step keys (:588, :609), the name auto-sized 28 → 20 sp (:600-601), the pager *Exercise {i} / {n}*, spoken *Exercise {i} of {n}* (`domain/LiveSession.kt:134-135`). No equipment icon.
- `Rack` (`ui/LoggerScreen.kt:836-868`): a `surface` panel with an accent top edge.
  - *Weight* label (:860), `WeightReadout` (:873) auto-sized 40–96 sp (:887) with plain *kg* (:891). A tap opens the keypad.
  - `LadderRow` (:898): four 56 dp pills from `Ladder.labels` (`domain/Ladder.kt:52-56`): *−2.5 −1 +1 +2.5* under 20 kg, *−5 −2.5 +2.5 +5* from 20 to 50, *−10 −2.5 +2.5 +10* above.
  - `RepsRow` (:931): *Reps*, 56 dp − / +, the number.
  - **Log set**, 64 dp accent (:991).
- Ledger header *Set / kg / Reps* (:692-694). Warm-ups are indexed *W* (06 removes them).

**Change**
- Movement head: equipment icon (08), wrapping movement name at no less than 22 sp, and a minimum 48 dp name target opening **This workout** (11). Remove visible previous/next arrows and *Movement X of Y*.
- Use the approved decorative position markers: current movement is an elongated accent capsule; at most seven markers, with small end markers for continuation; no markers for one movement. The markers are not tiny interactive targets. Horizontal movement switching preserves each movement draft; TalkBack announces exact position/count and exposes Previous/Next actions. Test one, two, seven and many movements and long names.
- Remove the standalone **Add movement** button/row from the main rack. Name → **This workout** → **Add movement** remains the entry (11/19). Remove its reserved gap; retain target and elapsed/since-last-set clock context. Remove the duplicate sets/kg-total/bullet summary strip.
- Load: `NumberStepper` (04, Display size) with the label *Load*, the numeral, and the unit by equipment (08):
  - 03.1 Dumbbells: **16** *kg each*.
  - 03.13 Barbell: **60** *kg total*.
  - 03.12 Bodyweight: **10** *kg added*; a negative number is band help.
  - − / + nudge by the movement's step.
- The plate ladder stays under the load with the same bands. It edits the same draft.
- Reps: the same stepper, Regular size, labelled *Reps* with the unit *reps*.
- **Log set** stays the 64 dp primary and stays silent.
- Ledger: no *Set / kg / Reps* header. Show up to three 48 dp rows (144 dp maximum viewport), with the current/recent rows visible and older rows scrollable. Each row is self-explanatory: set number, equipment-aware inline load unit and × reps; ✓ distinguishes logged rows and accent identifies the current row. A newly added movement shows its single current row without reserving three empty rows. No *W*.
- Apply this headerless layout to all rack-bearing states: units, focus/pressed/changed, Fix set/This workout backdrops, picker/custom-create returns and onboarding (52). Compact heights collapse flexible space, while controls and **Log set** remain reachable above the IME.
- Delete the *Weight* label and `WeightReadout`.

**Out of scope:** the stepper itself, keyboard, pressed and changed states (07); Fix set (10); This workout (11).

**Done when**
- Screenshots of 03.1, 03.12 and 03.13 match in Dark and Daylight; the rig (01) adds `03.1-rack-dumbbells-dark/light`, `03.12-rack-bodyweight-dark/light`, `03.13-rack-barbell-dark/light` (the fixture gains a bodyweight movement with added load).
- `gym_set_logged` fires once per **Log set**. A rack refusal still reports under `gym.editRack` / `gym.acceptSet` only when unexpected.
- Tests verify no visible header, text pager, arrows, duplicate summary strip or main Add button; spoken position remains exact after reorder/add/remove. Check at most three ledger rows, 48 dp interaction bounds, inline units and preserved per-movement drafts. On small phones, IME and 200 % font, scroll/focus keeps the edited field and **Log set** reachable. Capture long-name/many-movement, single-movement and keyboard variants in both appearances.
- Add content-free navigation steps to `gym_action` (`screen=workout`, bounded actions for movement switch and opening This workout); log no movement name, position, load, reps or IDs. Keep native paging cancellations separate from completed switches. Record the chosen labels in `docs/ANDROID_OBSERVABILITY.md`.

**Depends on:** 06, 07, 08.

**Ledger:** 11d, 11e, 9c, 9z; dogfood `android-gym-target-page`.
