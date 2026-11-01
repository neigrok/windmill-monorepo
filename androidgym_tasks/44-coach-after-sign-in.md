# After sign-in, the conversation continues and proposes a change

**Release status:** Postponed from this release at user request; preserve existing Coach action visuals. Its proposal and draft-action integration depends on postponed tasks.

**Figma:**
- 01.13 after sign-in and Add, signed in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-36454) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39744)
- Components (Design System library, Android page):
  - `Android / Change row` `337:2686`: Removed, Added
  - `Android / Diff field` `337:2531`: Gone, New
  - `Android / Button` `210:181`: Filled *Apply*, Tonal *Reject*
  - `Android / Chat bubble` `337:2761`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/` unless they start with `app/` or `platform/`)
- There is no signed-out conversation to continue (38).
- After sign-in, the Add / Discard decision (`app/MainActivity.kt:248`) adopts this phone's training. Coach then starts from an empty thread.
- A proposal is the card *Proposal · Full body B* with **Review** (`coach/CoachAnswer.kt:327-341`), the line `Ask.promise` (`coach/AskScreen.kt:391`), and a review sheet with *Turn this down*.

**Change**
- After sign-in and **Add**, the same thread stays on screen.
  - The signed-out turns and retained draft/photo stay under the adopted chat identity defined by 37. Returning from sign-in is continuation, not a deliberate fresh Coach entry.
  - The next question goes to account Coach, after the installation is bound (38).
- Next turn on the board:
  - lifter *Swap chin-ups for pulldowns*
  - Coach *Here is a change for Full body B.*
  - then a proposal card:
    - **CHANGES TO FULL BODY B** · *2 changes*
    - REMOVED *Chin-up*: *Sets 3*, *Reps 8*, all struck
    - ADDED *Lat Pulldown*: *Sets 3*, *Reps 8*, *Load 45 kg*
    - **Apply** / **Reject**
- No *Signed in* notice and no line between the two halves of the thread.
- Discard in the sign-in decision deletes the signed-out thread with the rest of the phone's signed-out training.

**Out of scope:** the card (29), swap rendering (32), the sign-in decision dialog (25), binding (38).

**Done when**
- The 01.13 screenshot matches in Dark and Daylight. The rig (01) adds `01.13-after-sign-in-dark` / `-light`.
- Events:
  - `gym_ask_started` / `gym_ask_outcome` fire without `state=anonymous` after sign-in.
  - `gym_sign_in_decision` still fires.
  - `gym_proposal_outcome` fires on Apply or Reject (30).
- Failures: a send failure reports at the transport boundary (`gym.ask`); a bind failure under `ai_installation`.
- Tests:
  - `coach/AskScreenTests.kt`: the thread continues after sign-in and Add, and goes on Discard.
  - `store/GymEngineSessionTests.kt`: the thread joins adoption.

**Depends on:** 29, 32, 37, 38, 39.

**Ledger:** 11h, 6p, 10v; dogfood `android-gym-target-page`.
