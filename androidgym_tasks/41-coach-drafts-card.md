# Routine drafts decided on their card: Apply or Reject

**Figma:**
- 01.7 three drafts, signed out: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-8716) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39439)
- 01.14 one routine: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-8887) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39487)
- 01.15 drafts rejected: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-9021) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39521)
- Components (Gym Components page, section `🧩 Android · Material 3`):
  - `Android / Change row` `1247:2908`: Added
  - `Android / Diff field` `1247:2753`: New
  - `Android / Button` `656:6699`: Primary *Apply* and Tonal *Reject*, 56 dp, stacked
  - `Android / Chat bubble` `1247:2983`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Each pending draft is its own card (`coach/CoachAnswer.kt:84-133`):
  - *Review routine*, then the name
  - one line per movement, for example *3 × 8 · 60 kg total · Barbell · 120s rest*
    - load words at :98-105: *One dumbbell* / *Two dumbbells*, ` each`, ` assisted`, ` added`, ` total`
    - rest at :109
  - **Save routine** / *Saving…* (:116)
- Save confirms one draft at a time through `coach.confirmRoutine` (`coach/CoachStore.kt:140-154`, event `gym_coach_routine_confirm`). The request sends `routineReview` (`net/GymHttp.kt:166-171`).
- Failure lines: *This draft is no longer available.*, *This draft can’t be saved. Ask Coach for a new one.*, *Couldn’t save the routine. Try again.*, *Sign in again to save this routine.* (`coach/Ask.kt:209`).
- There is no Reject. A signed-out phone gets no drafts at all.

**Change**
- One card holds every draft of an answer, under Coach's bubble. It uses the card shell from 29.
- Eyebrow **3 NEW ROUTINES** (**1 NEW ROUTINE**).
- Each routine is a heading row: *Full body A* · *3 movements* · chevron.
  - Only one routine is open at a time. A tap on another heading opens it in place.
  - When there is only one routine, the heading has no chevron and stays open (01.14).
- An open routine lists **ADDED** blocks, every value new. Load words come from 08:
  - *Back Squat* · *Sets 3* · *Reps 5* · *Load 60 kg total*
  - *Bench Press* · *Sets 3* · *Reps 5* · *Load 50 kg total*
  - *Dumbbell Row* · *Sets 3* · *Reps 10* · *Load 22 kg each*
  - 01.14 also has *Pull-up* · *Sets 3* · *Reps 8* · *Load 5 kg added*.
- **Apply** (Primary, 56 dp) saves every routine at once:
  - Signed in: confirm each draft through the existing endpoint.
  - Signed out: one atomic import through 38.
  - The card then becomes the receipts (42).
- **Reject** (Tonal, 56 dp) drops the drafts on this phone.
  - No dialog and no server call; drafts are not saved until confirmed.
  - Keep the rejection in `coach/LocalCoach.kt` so it survives a restart.
  - The card folds to one line: close icon + *Rejected · 3 routines* (*Rejected · 1 routine*).
- Coach's copy comes from the model: *Your screenshot has 3 full-body days. Here are 3 new routines. Check them, then apply.* / *Here is 1 new routine. Check it, then apply.*
- Keep today's failure lines in the error role above the buttons. **Apply** reads **Try again** after a failure.
- Delete *Review routine*, the per-draft **Save routine** and the rest suffix.

**Out of scope:** receipts after Apply (42), the card shell and diff parts (29), signed-out transport (38).

**Done when**
- Screenshots of 01.7, 01.14 and 01.15 match in Dark and Daylight. The rig (01) adds `01.7-drafts-card-dark` / `-light`, `01.14-one-routine-dark` / `-light` and `01.15-drafts-rejected-dark` / `-light`.
- Events:
  - `gym_coach_routine_confirm` still fires signed in (`started`, then `saved` / `refused` / `failed`).
  - `gym_setup_step` adds `drafts_rejected` and `routines_saved`.
- Failures:
  - Confirm failures report as today (`gym.coachRoutineConfirm`).
  - A signed-out import failure reports under `gym.saveRoutine`.
  - No routine name or movement in events.
- Tests: `coach/CoachAnswerTests.kt` (one card, one open routine, Reject folds, Apply saves all) and `coach/LocalCoachTests.kt` (a rejection survives a restart).

**Depends on:** 08, 29, 38.

**Ledger:** 11h, 10v; dogfood `android-gym-target-page`.
