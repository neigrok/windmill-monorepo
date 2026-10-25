# Routine drafts decided on their card: Apply or Reject

**Release status:** Postponed from this release at user request; preserve existing Coach action visuals.

**Figma:**
- 01.7 three drafts, signed out: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-8716) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39439)
- 01.14 one routine: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-8887) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39487)
- 01.15 drafts rejected: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-9021) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39521)
- Components (Design System library, Android page):
  - `Android / Change row` `337:2686`: Added
  - `Android / Diff field` `337:2531`: New
  - `Android / Button` `210:181`: Filled *Apply* and Tonal *Reject*, 56 dp, stacked
  - `Android / Chat bubble` `337:2761`

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
- **Apply** (Filled, 56 dp) requests the whole answer's draft set. Its persistence contract depends on the owner:
  - Signed out: use 38's one atomic batch import and replay receipt. Only its committed receipt turns the full card into 42's saved receipts.
  - Signed in: the existing endpoint confirms one draft at a time; do not promise an atomic multi-routine save. Persist a decision record scoped to account, thread, generation and each draft operation id before calling it. Track each draft as unsent, confirming/unknown, confirmed saved or known refused.
  - Confirm the unsaved drafts in order. After each confirmed reply preserve its routine id and saved outcome. Stop on a refusal or unknown outcome; earlier saved routines stay saved. On response loss/restart reconcile the same generation/operation before retrying, and reuse its original operation id. Never create fresh drafts/ids to recover this Apply.
  - A retry skips confirmed saved drafts and handles only the remaining ones. A missing or unavailable result is not proof that a routine was not created. This task owns replay/receipt conformance for `AskService::confirmRoutine` in `backend/products/gym/application/AskService.cpp` and its thread-repository boundary: establish fault tests in `backend/test/products/gym/application/AskServiceTest.cpp`, `adapters/postgres/PgAskThreadRepositoryTest.cpp` and `adapters/http/GymDoorApiTest.cpp` for a commit followed by response/receipt failure. Make the original operation recoverable and idempotent before enabling card-level Retry; any required backend correction belongs to this task and must land before the Android recovery wiring.
  - All-confirmed becomes 42's full receipt card. A partial outcome keeps truthful saved rows and pending/refused rows together; no whole-card “not saved” message.
- **Reject** (Tonal, 56 dp) drops only drafts known not to have been saved, locally, without a dialog/server call. Disable it while any confirmation/import has an unknown outcome.
  - Persist rejection under the same owner/chat/generation as the drafts. Before any save, the whole card can fold to *Rejected · 3 routines* (*Rejected · 1 routine*).
  - After partial signed-in success, rejection affects only the remaining known-unsaved drafts; retain saved routine receipts and do not label those routines Rejected or delete them. The partial-state design specifies the scoped action/copy.
- Coach's copy comes from the model: *Your screenshot has 3 full-body days. Here are 3 new routines. Check them, then apply.* / *Here is 1 new routine. Check it, then apply.*
- A definitive refusal or proven-not-sent failure uses its appropriate error line; **Try again** retries only the unsaved scope. Unknown outcomes use a confirmation-pending/check state rather than claiming failure.
- **Design prerequisite:** `android-coach-partial-drafts-design` supplies human-approved pending/partial/refused/saved combinations and scoped Retry/Reject states beside 01.7/01.8. The existing all-drafts/all-saved boards do not specify these cases and are not newly approved by the six-flow review.
- Delete *Review routine*, the per-draft **Save routine** and the rest suffix.

**Out of scope:** receipts after Apply (42), the card shell and diff parts (29), signed-out transport (38).

**Done when**
- Screenshots of 01.7, 01.14 and 01.15 match in Dark and Daylight. The rig (01) adds `01.7-drafts-card-dark` / `-light`, `01.14-one-routine-dark` / `-light` and `01.15-drafts-rejected-dark` / `-light`.
- Events:
  - `gym_coach_routine_confirm` still fires signed in (`started`, then `saved` / `refused` / `failed`).
  - `gym_setup_step` adds `drafts_rejected` and `routines_saved`.
- Failures:
  - Confirm failures report as today (`gym.coachRoutineConfirm`).
  - A signed-out import failure reports once at 38's import adapter under `gym.coachOnboarding`; the card consumes its outcome and does not report the same failure again.
  - No routine name or movement in events.
- Tests: card expansion and full success; failure on draft two after draft one is saved; response loss after a routine commits; restart before local saved-state persistence; repeat Apply; unknown outcome disabling Reject; reject only the remaining unsaved drafts; account switch during confirmation. Assert one routine per operation and preserved saved receipts. Anonymous import fault/replay coverage is owned by 38.
- Update `docs/ANDROID_OBSERVABILITY.md` with bounded per-attempt and card-outcome labels (`partial`, `pending_confirmation`, `saved`, `refused`); emit saved events only on proven saved outcomes and no duplicate success when restoring receipts.

**Depends on:** 08, 29, 38; visual partial/recovery states require `android-coach-partial-drafts-design`.

**Ledger:** 11h, 10v; dogfood `android-gym-target-page`.
