# Coach asks with choice chips, and a draft written signed out waits as Draft kept on this phone

**Figma:**
- 01.17 Coach asks a choice, signed in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40111) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40235)
- 01.18 Draft kept on this phone, signed in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40674) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40774)
- System parts: M3 kit Filter chips, the kit text button; `Android / Chat bubble` `1247:2983`.
- iOS ships both and is the model: the chips in `CoachChoicesView` (`apps/ios/App/Sources/Gym/Coach/CoachSetup.swift:44-71`), the wire type and its limits in `CoachClarification` (`apps/ios/App/Sources/Gym/Coach/CoachWire.swift:128-148`), the kept drafts in `CoachTab.swift:163-176` and their adoption at sign-in in `CoachConversation.swift:83-101`.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/` unless they start with `backend/`)
- The server sends a clarification with a generation: `clarification` with `id`, `question` and one or two `groups` (`days` single choice, `equipment` multiple), each with options (`backend/products/gym/adapters/json/GymJson.cpp:477-514`, attached at :554 and in `backend/products/gym/adapters/http/AskApi.cpp:307`).
- Android has no clarification type: the field is dropped and only the answer's text is drawn.
- A draft is one per seat (`CoachDraft`, `coach/Ask.kt:69`); a draft written signed out is not carried into the account's Coach after sign-in.

**Change**
- 01.17, choices:
  - Under Coach's question bubble, each group's label (*Days each week*, *Equipment*) over a row of kit Filter chips that wraps (*2 days* · *3 days* · *4 days*; *Barbell* · *Dumbbells* · *Bodyweight*).
  - `days` takes one choice, `equipment` several. Selected: check, `color/brand-soft` fill, `color/brand` outline and label; unselected: `border/default` outline, `text/primary` label. Each chip is a 48 dp target and says *selected* to TalkBack.
  - Choosing writes the answer into the composer as iOS does (*3 days. Dumbbells, Bodyweight.*); Send sends it like any question.
  - The question and labels are the model's words; drop a clarification that breaks iOS's limits (`CoachClarification.valid`) and draw the question as plain text.
- 01.18, a kept draft:
  - When a draft written signed out on this phone meets an account that already has its own draft, the phone's draft waits in the thread as a card: overline *Draft kept on this phone*, the draft's text, and the text button **Continue saved draft**. The composer keeps the account's draft (*Swap chin-ups for pulldowns*).
  - **Continue saved draft** swaps the two: the kept draft goes into the composer and the composer's draft becomes the kept card.
  - With no account draft, the phone's draft simply becomes the composer's draft.
- Store the kept drafts and the chosen chips with the seat's draft, so a recreation keeps them.

**Out of scope:** signed-out Coach itself (38); the greeting (39); drafts decided on their card (41).

**Done when**
- Screenshots of 01.17 and 01.18 match in Dark and Daylight; the rig (01) adds `01.17-coach-choices-dark/light`, `01.18-draft-kept-dark/light` (the deterministic Coach stand-in from 01 returns the clarification).
- Events: `gym_action` with `screen=coach`, `action=choose` when a chip is chosen and `action=continue_draft` on **Continue saved draft**; no chip label or draft text in any property. List them in `docs/ANDROID_OBSERVABILITY.md`.
- A clarification the client cannot read is dropped without a Sentry report: it is the model's output, not a failure.
- Tests: `coach/AskTests.kt` (parse and limits), `coach/AskScreenTests.kt` (chips, one choice for days, several for equipment, composer text), and a kept-draft test across sign-in.

**Depends on:** 28, 38.

**Ledger:** 12i; dogfood `android-gym-target-page`.
