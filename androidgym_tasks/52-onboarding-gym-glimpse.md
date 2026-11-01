# The onboarding's gym glimpse draws today's rack

**Status:** On main at `bb0223cb` in batch `b40dd5e0`; the shipped canonical states are 🚀 In production. Android 0.14.0 carries it.

**Approved flow:** [Workout rack](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) — human-approved 2026-10-25. The Shell frames below carry this approved headerless rack in the unchanged onboarding composition.

**Figma:**
- Shell · Android A4 Gym: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-10131) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-10203)
- The rack it copies: [Gym · Android 03.13 Barbell](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28829), under the approved current Workout flow above.

**Implementation**
- `ui/onboarding/OnboardingGlimpses.kt` draws three compact headerless rows, inline **kg total × reps**, the existing clock glyphs, a Nunito load numeral and the full-width Log action inside the unchanged Shell card. The animated check lands in row 3; reduced motion draws that completed state immediately. The other three picture routines and the pager content are unchanged.
- Source verification passes 12 gym rendering/pager cases, 11 app onboarding-flow cases and 31 capture-tool cases with no failures or skips. The new `onboarding-gym.json` recipe opts into the actual Android launcher intent on an empty install; ordinary captures retain their existing VIEW launch. Paired A4 appearance and reduced-motion/configuration restoration are accepted on `8d844b43` (APK `6d3ad11a…`), with page 4 retained and Get started enabled. A named native page-event receipt was not preserved; the eleven app onboarding/event tests cover the unchanged pipeline. The picture adds no step or failure boundary. The A4 miniature now matches the approved headerless rack in both appearances; ledger 9f retains the separate iOS drawing follow-up.

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
