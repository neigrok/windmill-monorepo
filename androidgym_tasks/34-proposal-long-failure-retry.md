# Proposal: a very long card, apply failed, retry in flight

**Figma:**
- 08.27 a very long proposal, expanded: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38014) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41815)
- 08.29 apply failed, no connection: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38166) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41876)
- 08.30 retry, applying: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38211) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-41894)
- Components: `Android / Change row` `1247:2908`, `Android / Diff field` `1247:2753`, `Android / Button` `656:6699` (Primary, Tonal, disabled).

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- While deciding, the sheet's Apply drops to 40 % with its label unchanged (`ui/ReviewSheet.kt:446-457`); *Turn this down* is disabled (`:489`).
- A failure is one line in the sheet (`ui/ReviewSheet.kt:163-165`):
  - *the log didn’t answer — nothing was applied*
  - for a removal still in flight, *Still waiting for the log. Retry to check this removal.*
- Store: `decide` reports `gym.applyProposal` and maps the outcome to *decided*, *moved*, *gone*, *settled* or *failed* (`store/TrainingStore.kt:974-1001`).

**Change**
- Long card, expanded (08.27): every block in model order (*Renamed*, *Moved*, *Changed*, *Removed*, *Added*), then *Show less*, then the buttons. The buttons follow the list; they are not pinned.
  - Board copy: *Rebuild Push A for strength* · *Here is a new plan for Push A. It has 9 changes.* · *9 changes*.
- Failed (08.29):
  - One line in the error role (02) above the buttons, with the `error` icon: *No connection. Not applied.*
  - For a server refusal, show its sentence instead.
  - **Apply** reads **Try again**; **Reject** stays. Nothing was written.
- Applying (08.30): the primary shows *Applying…* (*Removing…* for a removal) with a small `CircularProgressIndicator`; **Reject** is disabled at 38 %.
- Delete *the log didn’t answer — nothing was applied* and *Still waiting for the log. Retry to check this removal.* with the sheet.

**Out of scope:** out of date (30), the card shell (29).

**Done when**
- Screenshots of 08.27, 08.29 and 08.30 match in Dark and Daylight on the emulator; the rig (01) adds `08.27-proposal-long-dark` / `-light`, `08.29-proposal-apply-failed-dark` / `-light`, `08.30-proposal-applying-dark` / `-light`.
- **Try again** emits `gym_proposal_outcome` `{screen: coach, action: retry, outcome: decided | failed}`. Add `retry` to the row in `docs/ANDROID_OBSERVABILITY.md`.
- An unexpected failure reports under `gym.applyProposal`; no connection is an event, not a Sentry Issue.
- Tests to update: `coach/AskScreenTests.kt` (failed and applying states), `store/TelemetryTests.kt`.

**Depends on:** 29, 30.

**Ledger:** 11k, 10v; dogfood `android-gym-target-page`.
