# Coach asks with choice chips, and a draft written signed out waits as Draft kept on this phone

**Status:** On draft pull request [#41](https://github.com/neigrok/windmill-monorepo/pull/41), not on main. Its boards are ✅ Ready for dev; the captures for 01.17/01.18 remain.

**Figma:**
- 01.17 Coach asks a choice, signed in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40111) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40235)
- 01.18 Draft kept on this phone, signed in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40674) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1283-40774)
- System parts: M3 kit Filter chips, the kit text button; `Android / Chat bubble` `337:2761`.
- The shared wire authority is `backend/products/gym/domain/Thread.cpp:41` (`validClarification`) and `backend/products/gym/adapters/json/GymJson.cpp` (`clarificationFromJson`).

**Current implementation**
- Android retains optional clarification metadata through live answers, persisted generations and History. Invalid optional metadata leaves the normal answer readable and emits no Issue.
- Clarifications use one or two unique `days`/`equipment` groups, up to six unique options each, a 500-byte question, 80-byte labels and bounded IDs. Days is single choice; equipment follows the server's `multiple` flag, including its valid single-choice mode.
- Choices and kept drafts live under the existing owner/chat identity in the same atomic Coach document. A draft includes text, a photo reference and its setup purpose. Selected chips write ordinary composer text; only Send requests an answer.
- Sign-in moves the phone draft only after a copied photo and its account reference are durable. An existing account draft or pending request holds the complete phone draft separately. Source removal and destination publication share one document write, preventing repeated adoption after restart or account cycling.
- Continue swaps complete drafts. The approved card displays text only; a photo-only held draft omits the text row and restores its photo through the existing composer. Kept photos participate in reference cleanup.
- Draft publication reconciles a thrown post-rename write against the actual document. An unreadable result retains attachments and its pending operation; recovery publishes that operation before a stale Continue or chip callback can flush or toggle again. Technical failures use static boundaries.
- Native captures and installed-event acceptance for these four frames remain pending. Source/JVM acceptance is separate from native acceptance.

**Change**
- 01.17, choices:
  - Under Coach's question bubble, each group's label (*Days each week*, *Equipment*) over a row of kit Filter chips that wraps (*2 days* · *3 days* · *4 days*; *Barbell* · *Dumbbells* · *Bodyweight*).
  - `days` takes one choice; `equipment` uses the server’s single/multiple mode (the approved example allows several). Selected: check, `color/brand-soft` fill, `color/brand` outline and label; unselected: `border/default` outline, `text/primary` label. Each chip is a 48 dp target and says *selected* to TalkBack.
  - Choosing writes the answer into the composer (*3 days. Dumbbells, Bodyweight.*); Send sends it like any question.
  - The question and labels are the model's words; drop a clarification that breaks the shared backend limits and draw the question as plain text.
- 01.18, a kept draft:
  - When a draft written signed out on this phone meets an account that already has its own draft, the phone's draft waits in the thread as a card: overline *Draft kept on this phone*, the draft's text, and the text button **Continue saved draft**. The composer keeps the account's draft (*Swap chin-ups for pulldowns*).
  - **Continue saved draft** swaps the two: the kept draft goes into the composer and the composer's draft becomes the kept card.
  - With no account draft, the phone's draft simply becomes the composer's draft.
- Store kept drafts and chosen chips under 37's stable owner/chat identity, so recreation and fresh Coach entry retain them in the correct History row. Do not overwrite another account's draft or cancel an older chat's pending reply.

**Out of scope:** signed-out Coach itself (38); the greeting (39); drafts decided on their card (41).

**Done when**
- Screenshots of 01.17 and 01.18 match in Dark and Daylight; the rig (01) adds `01.17-coach-choices-dark/light`, `01.18-draft-kept-dark/light` (the deterministic Coach stand-in from 01 returns the clarification).
- Events: `gym_action` with `screen=coach`, `action=choose` when a chip is chosen and `action=continue_draft` on **Continue saved draft**; no chip label or draft text in any property. List them in `docs/ANDROID_OBSERVABILITY.md`.
- A clarification the client cannot read is dropped without a Sentry report: it is the model's output, not a failure.
- Tests: `coach/AskTests.kt` (parse and limits), `coach/AskScreenTests.kt` (chips, one choice for days, several for equipment, composer text), and a kept-draft test across sign-in.

**Depends on:** 28, 37, 38.

**Ledger:** 12i; dogfood `android-gym-target-page`.
