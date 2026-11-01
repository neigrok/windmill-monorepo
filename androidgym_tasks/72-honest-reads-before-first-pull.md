# Before the first pull, nothing counts or claims from partial history

**Status:** On main (`33848694`): the record page, the log foot's Retry, the foot's unread state and the shared *new best* rule are built. The log foot's waiting copy waits for 05.18 to be approved; Routines' empty line before the first pull waits for a design.

**Figma:** 05.18 The log, reading before the first pull (🚧 In progress, awaiting owner approval; ledger 11u): [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1767-27118) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1767-27204). Build the log-foot part only once it is ✅ Ready for dev.

**Context:** a phone signed in to an account it has not pulled yet holds partial history. Rule: device-local data can support leaving something out, never asserting it. PR #43 gated the receipt's record and the record page's tiles. Native e2e on 2026-10-31 found three more places.

**Current implementation**
- **Record page:** on an unread account the record page leaves out the tiles, the *Estimated strength* card (its latest estimate and its workout count) and *Nothing logged for this movement yet*, under the same completeness flag (`Record.page`). It lists the sets the phone holds. The left-out lines appear once the first pull lands.
- **Log foot:** the unread log's foot reads *That read failed. Retry*, but nothing failed; it is waiting for the first pull. It keeps that foot when the phone holds workouts logged here: on an unread account, under the record page's completeness flag, a short page claims no first workout (`TrainingStore.footAfter`). Retry reads the phone's copy again and asks the sync runtime for the first pull (`TrainingStore.retryLog`, `SyncRuntime.pullAgain`); the log reads itself when the pull lands, and the usual foot returns.
- **New best:** the log row and the record page read one shared rule, `ProgressRecords`. A slight workout (fewer than 4 sets) sets new bests and record steps like any other; slightness silences only its receipt. The log states each new best once: by its woven moment, or by the row's dot when the week's moment is another best. So a slight workout's best can show as the moment and not as a dot. Slight-workout vectors in `packages/api-contract/gym/domain/training-reads.json` pin this on all three surfaces.

**Change**
- **Log foot:** the designer gives the waiting state its own copy, for example "Reading your log…". File it in `docs/design/consistency.md` and build it once approved.
- **Routines' empty line before the first pull:** Routines reads *No routines yet.* on an account it has not pulled. The owner decides what it shows while it waits (ledger 11u); build it once drawn.

**Done when**
- Before the first pull, the log's foot matches the approved 05.18.
- The log and the record page agree on slight-workout bests.

**Depends on:** 21, 22.
