# After Apply: receipts, one tap from Start

**Figma:**
- 01.8 routines saved, signed in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32583) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39546)
- 01.16 routines saved, signed out: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-32725) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39578)
- 01.9 the routine, one tap from Start: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-33374) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39613)
- Components (Design System library, Android page):
  - `Android / Button` `210:181`: Filled *Start workout*, Text *Edit routine*, Text *Keep it*
  - `Android / Chat bubble` `337:2761`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Each created routine gets its own card (`coach/CoachAnswer.kt:134-141`): *Routine created*, the name, and **Open routine** (:137, :139).
- The routine sheet `RoutineSheet` (`ui/RoutinesScreen.kt:274`) has **Start workout** (:343) and **Edit routine** (:347).
  - Targets print `Readout.target` plus a bare *kg* (:329).
- Signed out, nothing says the routines are only on this phone.

**Change**
- After Apply, the drafts card (41) becomes one receipts card, as M3 list items:
  - leading check in the accent
  - *Full body A* over *Routine created · 3 movements*
  - trailing `chevron_forward`
  - the same for B and C
- Each row opens the routine sheet over the thread (01.9). The sheet keeps the scrim, top radius 28 and handle, and shows:
  - *Full body A*
  - *1 Back Squat* *3 × 5 · 60 kg total*
  - *2 Bench Press* *3 × 5 · 50 kg total*
  - *3 Dumbbell Row* *3 × 10 · 22 kg each* (units from 08)
  - **Start workout** (Filled), which starts the routine's workout
  - **Edit routine** (Text)
- Signed out (01.16): under the card, *Only on this phone ·* and a text button **Keep it** that opens the sign-in door. After sign-in, Add / Discard adopts the routines (`app/MainActivity.kt:248`).
- Delete the per-routine *Routine created* card and **Open routine**.

**Out of scope:** the routine sheet's own layout and its units on Routines (08, 17); the sign-in decision (25).

**Done when**
- Screenshots of 01.8, 01.16 and 01.9 match in Dark and Daylight. The rig (01) adds `01.8-routines-saved-signed-in-dark` / `-light`, `01.16-routines-saved-signed-out-dark` / `-light` and `01.9-routine-start-dark` / `-light`.
- Events:
  - `gym_setup_step` adds `open_routine`, `keep_routines` and `sign_in`.
  - `gym_session_started` fires on **Start workout**.
  - `gym_screen_viewed` `routine` fires when the sheet opens.
- Tests: `coach/CoachAnswerTests.kt` (receipts replace the drafts; Keep it shows only signed out) and `ui/RoutineSheetTests.kt` (units by equipment).

**Depends on:** 08, 41.

**Ledger:** 11h, 6p; dogfood `android-gym-target-page`.
