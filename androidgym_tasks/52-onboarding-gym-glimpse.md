# The onboarding's gym glimpse draws today's rack

**Figma:**
- Shell · Android A4 Gym: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-10131) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-10203)
- The rack it copies: Gym · Android 03.13 Rack, Barbell, kg total (`1252:28829`).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ui/onboarding/OnboardingGlimpses.kt` `gym()` (:307-334) draws an old rack: *set 3 of 5* (:313), *Set 3 · target 100 × 5* as a slot target in mono (:318), *100* with *kg × 5* in mono (:319-320), *Last time · 97.5 kg × 5* (:321) and *Set 3 logged* (:331).

**Change**
- Draw the rack as the app shows it (03.13): *Squat*; the ledger header *Set / kg / Reps*, rows *1 ✓ 100 5* and *2 ✓ 100 5*, the current row *Set 3 · target 100 × 5*; the load *100* in the sans with *kg total*; *5 reps*; a full-width **Log set**.
- Remove *set 3 of 5*, the *Last time* line and the *Set 3 logged* line. The animation (press, the ✓ landing on set 3) stays.
- Colours stay on the gym skin (the pager already paints verdigris by day).

**Out of scope:** the other three pages (A1–A3 ship as drawn); the iOS glimpse (ledger 9f).

**Done when**
- Screenshots of A4 match in Dark and Daylight on the emulator (fresh install → page 4; the rig (01) adds `A4-onboarding-gym-dark/light`).
- `onboarding_page_viewed` still fires for page 4; reduced motion still draws the end state.
- `ui/onboarding/OnboardingGlimpseTests.kt` and `app/…/OnboardingFlowTests.kt` pass with the new strings.

**Depends on:** 09 (the rack it copies).

**Ledger:** 9f; dogfood `android-gym-target-page`.
