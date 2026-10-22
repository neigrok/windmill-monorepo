# Allowance used: signed out, signed in (interim), Windmill One

**Figma:**
- 01.10 signed out: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-35870) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39675)
- 01.11 signed in, interim: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-35979) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39698)
- 01.12 Windmill One: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-36078) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39721)
- Components (Design System library, Android page):
  - `Android / Chat notice` `337:2764`
  - `Android / Chat bubble` `337:2761`
  - `Android / Button` `210:181`: Tonal *Sign in*

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/` unless they start with `backend/`)
- Android reads only two cap codes (`coach/CoachStore.kt:397-411`):
  - `ask-daily-limit` → *The next question frees up in a couple of hours.* (`coach/Ask.kt:180`)
  - `ask-out-of-budget` → *This account has reached its AI ceiling for the last 30 days. …*
  - Both take the composer down for `CapDoors` (`coach/AskScreen.kt:339-343`: *Connect own agent*, *Ask something new*).
- The allowance refusal is a 429 with code `subject_exhausted`, reason `allowance_exhausted`, *Your AI allowance is fully used or reserved.* and an `allowance` object carrying `resetsAtMs` (`backend/products/gym/adapters/http/AskApi.cpp:25-43`).
  - Android falls through to a generic refusal with that sentence. It never reads `resetsAtMs`.
- Signed out there is no Coach (38). *You have used all of your AI allowance.* exists nowhere.
- Android has no paid-plan gate. Checkout is closed: `paidPlansOpen()` in `web/src/shell/billing/checkout.js` returns `false`.

**Change**
- After the refused message, a centred `Android / Chat notice` above the composer: *You have used all of your AI allowance.*
- The refused text stays in the composer with **Send**. Board draft: *Swap chin-ups for pulldowns*.
- Signed out (01.10):
  - The notice adds *Sign in to continue.* and a tonal **Sign in**, which opens the sign-in door.
  - Trigger: a signed-out onboarding result whose `errorCode` is `subject_exhausted` (38).
- Signed in (01.11):
  - The notice adds *You can use Coach again on Nov 1, 12:00 AM.*
  - The date and time come from `allowance.resetsAtMs`, in the phone's locale, medium date and short time.
  - No button. No Windmill One entry.
  - Trigger: 429 `subject_exhausted`. Add `AskCap.Allowance` beside `Daily` and `Ceiling` (`coach/Ask.kt:149-151`).
  - No reset time in the reply: show the first line only.
- Windmill One (01.12): *Windmill One gives you $7 of AI use each billing period.* + **Upgrade**. Do not build it now: checkout is closed, and the board waits for it. Build nothing behind a flag either.
- Other budget codes (`free_day_exhausted`, `free_month_exhausted`, `concurrency_exhausted`, `funding_required`) keep showing the server's sentence, as today.

**Out of scope:** the day's cap and the 30-day ceiling (36), signed-out transport (38).

**Done when**
- Screenshots of 01.10 and 01.11 match in Dark and Daylight. The rig (01) adds `01.10-allowance-used-signed-out-dark` / `-light` and `01.11-allowance-used-signed-in-dark` / `-light`.
- 01.12 is not built.
- Events:
  - `gym_ask_outcome` fires with `outcome=capped` and `cap=allowance`. The signed-out version also carries `state=anonymous`.
  - **Sign in** emits `gym_setup_step` `sign_in`.
  - A 429 is an expected refusal, not a Sentry Issue.
  - No amounts or dates in events.
- Tests:
  - `coach/AskOutcomeTests.kt`: `subject_exhausted` maps to the allowance cap, with and without `resetsAtMs`.
  - `coach/AskScreenTests.kt`: the notice, and the draft kept.

**Depends on:** 28, 38.

**Ledger:** 11j, 10v; dogfood `android-gym-target-page`.
