# The onboarding's gym glimpse draws today's rack

**Approved flow:** [Workout rack](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) — ✅ Ready for dev, human-approved 2026-10-25. Use this current approved rack for the embedded glimpse; the Shell frame links below supply the unchanged onboarding composition, not approval of the obsolete ledger header.

**Figma:**
- Shell · Android A4 Gym: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-10131) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-10203)
- The rack it copies: [Gym · Android 03.13 Barbell](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28829), under the approved current Workout flow above.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ui/onboarding/OnboardingGlimpses.kt` `gym()` (:307-334) draws an old rack: *set 3 of 5* (:313), *Set 3 · target 100 × 5* as a slot target in mono (:318), *100* with *kg × 5* in mono (:319-320), *Last time · 97.5 kg × 5* (:321) and *Set 3 logged* (:331).

**Change**
- Draw 09’s approved rack inside the existing glimpse: *Squat*, up to three compact headerless rows with set number, inline *kg total* and × reps, ✓ for logged rows and an accent current row; the load *100*, *kg total*, *5 reps* and **Log set**. Preserve the target/clock context shown by the current rack. There is no *Set / kg / Reps* header, text movement counter, previous/next arrows, duplicate sets/kg summary or standalone Add button. Use the current visual position marker only when the example contains several movements; no marker for a single-movement example.
- Remove *set 3 of 5*, the *Last time* line and the *Set 3 logged* line. The animation (press, the ✓ landing on set 3) stays.
- Colours stay on the gym skin (the pager already paints verdigris by day).

**Out of scope:** the other three pages (A1–A3 ship as drawn); the iOS glimpse (ledger 9f).

**Done when**
- Screenshots of A4 retain the Shell composition while their rack content matches the approved current 09 layout in Dark and Daylight (fresh install → page 4; rig 01 adds `A4-onboarding-gym-dark/light`). Check no obsolete header/counter/arrows/Add or ghost spacer remains, including the reduced-motion end state. Any change beyond substituting the approved rack requires its own designer follow-up; do not invent a new onboarding layout.
- `onboarding_page_viewed` still fires for page 4; reduced motion still draws the end state.
- `ui/onboarding/OnboardingGlimpseTests.kt` and `app/…/OnboardingFlowTests.kt` pass with the new strings.

**Depends on:** 09 (the rack it copies).

**Ledger:** 9f; dogfood `android-gym-target-page`.
