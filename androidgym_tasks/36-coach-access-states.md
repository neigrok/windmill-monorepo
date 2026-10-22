# Coach access states: no seat, the day's cap, a change needs an account

**Figma:**
- 08.6 Coach, no seat: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28737) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41279)
- 08.8 the day's cap: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28820) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41310)
- 08.31 signed out, a change needs an account: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38214) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41909)
- Components: `Android / Chat bubble` `1247:2983`, `Android / Chat notice` `1247:2986`, `Android / Button` `656:6699`, `Android / Top app bar` `1260:2948`.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Signed out, `AskSignedOutStance` (`coach/AskScreen.kt:268-278`): *Coach reads your log, so it needs you signed in.* at body 26 Bold at the top (`coach/Ask.kt:216`), then a primary *Sign in* at the bottom.
- Day's cap (429 `ask-daily-limit`, `coach/CoachStore.kt:405`):
  - The server's sentence, lower case and with no period: *the next question frees up in a couple of hours* (`backend/products/gym/adapters/http/AskApi.cpp:74`); the client fallback is *The next question frees up in a couple of hours.* (`coach/Ask.kt:180`).
  - It is drawn as body 15 ink after the thread (`coach/AskScreen.kt:221-227`).
  - The composer is replaced by `CapDoors` (`coach/AskScreen.kt:244-246`, `:339-345`): *Ask something new* and a *Connect own agent* / *Use your own AI tool* row (`:318-336`).
- The 30-day ceiling (429 `ask-out-of-budget`, `coach/CoachStore.kt:406`) reads *This account has reached its AI ceiling for the last 30 days. Coach will answer again as that window rolls on.* (`coach/Ask.kt:184-186`).
- There is no signed-out conversation, so no signed-out change request.

**Change**
- No seat (08.6): shown when there is no account and the signed-out Coach (38) is not available.
  - Centred body 18 in `inkDim`: *Coach needs your workout log. Please sign in.*
  - **Sign in** (primary) at the bottom. The seat shows *•*. No History, no More, no composer.
- Day's cap (08.8):
  - The refused question stays in the composer, with Send.
  - The server's sentence becomes a centred `ChatNotice` above the composer. Capitalise it and end it with a period on the client: *The next question frees up in a couple of hours.*
  - One `TextButton` under it: *Connect your agent* (opens Connected log).
  - Board copy: *Bench has stalled for three weeks. Is Push A still doing anything?* · *Your Bench Press has not gone up in 3 weeks. You did 5 × 5 at 82.5 kg nine times.* · composer *What should Thursday look like?*
  - The ceiling uses the same notice with its own sentence.
  - Delete `CapDoors`, `ConnectDoor`'s *Use your own AI tool* and the cap's *Ask something new*.
- A change needs an account (08.31), signed out:
  - Lifter: *Make Push A harder*. Coach: *I need your account to change a routine. Sign in, then ask again.*
  - One primary **Sign in** under the bubble opens the sign-in door.
  - Draw it when the signed-out reply says the request needs an account (38 pins the field). Signed-out Coach only drafts routines.

**Out of scope:**
- 08.7 *Coach isn’t part of this Windmill* matches today in Dark; its Daylight twin is 02.
- Allowance used (43).
- The chat parts (28).

**Done when**
- Screenshots of 08.6, 08.8 and 08.31 match in Dark and Daylight on the emulator; the rig (01) adds `08.6-coach-no-seat-dark` / `-light`, `08.8-coach-day-cap-dark` / `-light`, `08.31-coach-change-needs-account-dark` / `-light`.
- `gym_ask_outcome` outcomes `capped` (with `cap`), `refused` and `absent` are unchanged.
- The Sign in buttons open the sign-in door as today (`auth_code_requested` and `auth_sign_in_started` still fire there); *Connect your agent* opens Connected log (`gym_screen_viewed` `connections`), and a browser failure still reports under `gym.openConnections`.
- Tests to update: `coach/AskScreenTests.kt`, `coach/AskOutcomeTests.kt`, `ui/StanceReadsTheAccountTests.kt`.

**Depends on:** 28, 38.

**Ledger:** 11k, 10v; dogfood `android-gym-target-page`.
