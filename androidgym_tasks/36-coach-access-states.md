# Coach access states: no seat, not on this Windmill, the day's cap, a change needs an account

**Status:** On draft pull request [#41](https://github.com/neigrok/windmill-monorepo/pull/41), not on main. Its boards are ✅ Ready for dev. Native acceptance on a local stack (2026-10-31) matches 08.58, 08.58b, 08.7, 08.8 and 08.31 in Dark, Daylight and 200 % text; the cap's deadline survives a restart and is recomputed after a time-zone change, and nothing sends on its own. Rig recipes `coach-access.json`, `coach-access-signed-out.json` and `coach-day-cap.json` cover 08.58, 08.31 and 08.8. The rig cannot capture 08.58b (its board pattern rejects the suffix, and its sign-in check fails after a sign-out) or 08.7 (it always configures a model). Open: a refused question leaves an empty date header above the cap notice.

**Figma:**
- 08.58 Coach, no seat: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28737) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41279)
- 08.58b Signed out, earlier chats retained: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49152) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49306), human-approved 2026-10-28 and ✅ Ready for dev on the Android design page.
- 08.7 not on this Windmill: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28776) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41292)
- 08.8 the day's cap: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28820) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41310)
- 08.31 signed out, a change needs an account: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38214) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41909)
- Components: `Android / Chat bubble` `337:2761`, `Android / Chat notice` `337:2764`, `Android / Button` `210:181`, `Android / Top app bar` `342:2953`.

**Implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)

`coach/CoachAccess.kt` owns the Ready no-seat, retained-History bound and absent stances, plus the
Daily/Ceiling notice. The cap keeps the native composer and uses the persisted actual retry deadline;
missing/invalid timing uses the nonnumeric fallback. `CoachStore` projects task 38's retained request
into its original anonymous chat and keeps accepted photo metadata after the composer clears.
The application injects the existing onboarding coordinator through `TrainingStore` into `CoachStore`; installation
binding and AuthStore's handoff remain separate collaborators. `AnthropicOnboarding.cpp` validates
conversation-only `errorCode:null|account_required`, preserving the public durable POST/GET shape
and existing routine decoder. Exact typed policy results use the fixed approved bubble and Sign in.
The composed schema-11 source passes App compilation, 83 domain, 43 platform and 113 focused Gym
checks. The anonymous History composer cannot cancel a retained request. Mounted HTTP verification covers
ordinary dialogue, typed account-required replies, exact replay, a complete photo, binding and
switches-off fallback. Invalid provider output reaches the backend failure reporter once under
`gym.coach.onboarding.model`; expected account-required replies create no Issue. Native visual,
installed-process recovery and device event acceptance remain pending.

**Change**
- No seat (08.58): shown when there is no account and the signed-out Coach (38) is not available.
  - Centred body 18 in `inkDim`: *Coach needs your workout log. Please sign in.*
  - **Sign in** (primary) at the bottom. The seat shows *•*; there is no anonymous Send composer. With no retained chats the board has no History. A bound installation with local chats needs the retained-History variant specified below.
- Not on this Windmill (08.7): the bar with History and the seat; centred, the kit `error` symbol and *This Windmill does not have Coach. You can still read your log.* No Notes door, no Connected log door, no composer. Delete `AskAbsentStance`'s doors and `Ask.notHere`'s old words.
- Day's cap (08.8):
  - The refused question stays in the composer, with Send.
  - A centred `ChatNotice` above the composer uses the server's actual next-question time: prefer valid `retryAtMs`; otherwise turn valid `Retry-After` into a deadline when the response arrives. Render a localized relative or absolute time in the existing notice. The board's *about 2 hours* is example content, never a constant.
  - Persist the deadline with the refusal so reopening the chat does not restart the wait. Recompute the displayed time on resume; expiration permits another user Send but never sends automatically. With missing/invalid timing, use a nonnumeric sentence such as *Coach cannot take another question yet. Try again later.*
  - One `TextButton` under it: *Use your own AI agent* (opens Connected log).
  - Board copy: *Bench has stalled for three weeks. Is Push A still doing anything?* · *Your Bench Press has not gone up in 3 weeks. You did 5 × 5 at 82.5 kg nine times.* · composer *What should Thursday look like?*
  - The ceiling uses the same notice with its own sentence.
  - Delete `CapDoors`, `ConnectDoor` and the cap's *Ask something new*.
- Bound installation, signed out: `GET /v1/ai/installations/current` reports `bound=true`, or onboarding POST returns `device_bound` (38). Keep the installation and local chat archive; use approved 08.58b with History, *Sign in to ask Coach.*, *Your earlier chats stay on this phone.* and Sign in. Do not offer anonymous Send or issue a replacement credential. Continue recovering an already submitted anonymous request through GET. Approval covers these two access screens only; the B.2 Check again recovery card remains unapproved and is not required to implement GET recovery.
- A change needs an account (08.31), signed out:
  - Lifter: *Make Push A harder*. Coach: *I need your account to change a routine. Sign in, then ask again.*
  - One primary **Sign in** under the bubble opens the sign-in door.
  - Draw it only for the durable onboarding `errorCode=account_required`. The model-only policy enum is validated in the existing adapter; unknown or contradictory documents become `invalid_result`. Signed-out Coach only drafts routines.

**Out of scope:**
- Allowance used (43).
- The chat parts (28).

**Done when**
- Screenshots of 08.58, 08.7, 08.8 and 08.31 match in Dark and Daylight on the emulator; the rig (01) adds `08.58-coach-no-seat-dark` / `-light`, `08.7-coach-absent-dark` / `-light`, `08.8-coach-day-cap-dark` / `-light`, `08.31-coach-change-needs-account-dark` / `-light`.
- Verify a refusal seconds before refill, a fully exhausted bucket, fallback `Retry-After`, invalid/missing timing, persisted refusal after restart and timezone/locale changes. No automatic send occurs on deadline expiry.
- Verify anonymous → bind → sign out → Coach, retained History, and recovery of a pre-bind pending request without anonymous POST.
- `gym_ask_outcome` outcomes `capped` (with `cap`), `refused` and `absent` remain content-free; any new bound-installation label is bounded and listed in `docs/ANDROID_OBSERVABILITY.md`. Do not log deadlines, account or installation identities.
- The Sign in buttons open the sign-in door as today (`auth_code_requested` and `auth_sign_in_started` still fire there); *Use your own AI agent* opens Connected log (`gym_screen_viewed` `connections`), and a browser failure still reports under `gym.openConnections`.
- Tests to update: `coach/AskScreenTests.kt`, `coach/AskOutcomeTests.kt`, `ui/StanceReadsTheAccountTests.kt`.

**Depends on:** 28, 38. The bound-installation access design gate is resolved by approved 08.58b; additional recovery cards retain their own approval gates.

**Ledger:** 11k, 10v, 12h; dogfood `android-gym-target-page`.
