# Proposal: a very long card, apply failed, retry in flight

**Release status:** Postponed from this release at user request; preserve existing Coach action visuals.

**Figma:**
- 08.27 a very long proposal, expanded: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38014) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41815)
- 08.29 apply failed, no connection: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38166) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41876)
- 08.30 retry, applying: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38211) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41894)
- Components: `Android / Change row` `337:2686`, `Android / Diff field` `337:2531`, `Android / Button` `210:181` (Filled, Tonal, disabled).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- While deciding, the sheet's Apply drops to 40 % with its label unchanged (`ui/ReviewSheet.kt:446-457`); *Turn this down* is disabled (`:489`).
- A failure is one line in the sheet (`ui/ReviewSheet.kt:162-164`):
  - *the log didn’t answer — nothing was applied*
  - for a removal still in flight, *Still waiting for the log. Retry to check this removal.*
- Store: `decide` reports `gym.applyProposal` and maps the outcome to *decided*, *moved*, *gone*, *settled* or *failed* (`RoutinesStore.decide`).

**Change**
- Long card, expanded (08.27): every block in model order (*Renamed*, *Moved*, *Changed*, *Removed*, *Added*), then *Show less*, then the buttons. The buttons follow the list; they are not pinned.
  - Board copy: *Rebuild Push A for strength* · *Here is a new plan for Push A. It has 9 changes.* · *9 changes*.
- Model decision progress explicitly, per account and proposal: ready, sending, awaiting confirmation, confirmed, known refusal or known not sent. Preserve the original command/decision identity across navigation and restart.
- A known-not-sent failure can use 08.29's *No connection. Not applied.* only when the client can prove that no command was persisted/submitted. A definitive server/domain refusal uses its truthful sentence. **Try again** retries the same intended decision; **Reject** is available only once Apply is known not to have taken effect and no decision remains pending.
- A lost response, transport timeout or `TrainingUnanswered` after enqueue is **awaiting confirmation**. `EngineTraining.decideProposal` persists the command before its confirmation wait; timeout does not roll it back. Never claim *Nothing was written* or turn this into a generic not-applied state.
- In awaiting confirmation, reconcile the original command/receipt. A retry checks or resends that identity rather than creating a second decision. Apply and the opposing Reject cannot race; keep Reject disabled until the outcome is resolved. A server receipt updates the same card even if it is in History or another chat.
- Applying (08.30): the primary shows *Applying…* (*Removing…* for removal) with the native progress indicator; **Reject** is disabled at 38 %. An unknown outcome needs its own truthful notice and check/retry affordance, not endless active progress or a false failed receipt.
- Preserve the distinction currently expressed by *Still waiting for the log. Retry to check this removal.* when removing the review sheet. Replace the unsafe general *the log didn’t answer — nothing was applied*.

**Design prerequisite:** `android-coach-uncertain-apply-design` owns the awaiting-confirmation/check-again and resolved states beside 08.29/08.30. The existing failed board applies only to proven no-write failures; the six-flow approval does not approve new unknown-outcome copy or controls. Implement the state/reconciliation logic independently, then use the additional human-approved ✅ Ready for dev states for its visual work.

**Out of scope:** out of date (30), the card shell (29).

**Done when**
- Screenshots of 08.27, 08.29 and 08.30 match in Dark and Daylight on the emulator; the rig (01) adds `08.27-proposal-long-dark` / `-light`, `08.29-proposal-apply-failed-dark` / `-light`, `08.30-proposal-applying-dark` / `-light`.
- Verify response dropped after commit, confirmation delayed beyond the wait, process death while pending, repeated Retry, account switch, navigation to another chat, eventual refusal and eventual success. Assert one effective decision and no contradictory Reject.
- **Try again** emits a bounded attempt/outcome event; distinguish `pending_confirmation` from `refused` and `failed`. Emit the settled `gym_proposal_outcome` only once for the confirmed decision. Update the allowlist in `docs/ANDROID_OBSERVABILITY.md`; no proposal ids, routines or payloads in telemetry.
- An unexpected failure reports under `gym.applyProposal`; no connection is an event, not a Sentry Issue.
- Tests to update: `coach/AskScreenTests.kt` (failed and applying states), `store/TelemetryTests.kt`.

**Depends on:** 29, 30; visual work also requires `android-coach-uncertain-apply-design`.

**Ledger:** 11k, 10v; dogfood `android-gym-target-page`.
