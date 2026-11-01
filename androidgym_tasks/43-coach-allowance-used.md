# Allowance used: signed out, signed in (interim), Windmill One

**Status:** On main with pull request [#41](https://github.com/neigrok/windmill-monorepo/pull/41) (`de637b58`), not yet in a published release. Its boards are ✅ Ready for dev; 01.12 stays 🚧 In progress and unbuilt. 01.10 and 01.11 match natively in Dark, Daylight and 200 % text; `gym_ask_outcome` `capped` with `cap=allowance` (and `state=anonymous` signed out) and `gym_setup_step` `sign_in` arrive, and a 429 files no Issue. The rig cannot reach either board, because its allowances are fixed. The refused question no longer leaves an empty date header, and a reset in the current year reads *Nov 1, 12:00 AM* as the board does; both are covered by JVM tests and await native re-acceptance.

**Figma:**
- 01.10 signed out: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-35870) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39675)
- 01.11 signed in, interim: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-35979) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39698)
- 01.12 Windmill One: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-36078) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39721)
- Components (Design System library, Android page):
  - `Android / Chat notice` `337:2764`
  - `Android / Chat bubble` `337:2761`
  - `Android / Button` `210:181`: Tonal *Sign in*

**Implementation**
- `subject_exhausted` selects `AskCap.Allowance` for a signed-in 429 or the latest anonymous
  onboarding refusal. The draft stays editable. Anonymous refusals stay in their original chat.
- Reset metadata is optional raw JSON at the transport boundary. A positive numeric integer is
  formatted in the phone's locale and time zone; missing or malformed timing leaves the first
  sentence intact. Other budget codes retain their server sentence.
- Anonymous access offers the existing Sign in door; signed-in access has no action button.
  Checkout remains closed and no Windmill One entry is built.
- Native 01.10/01.11 captures and installed event receipts remain pending in the Coach cohort.

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
