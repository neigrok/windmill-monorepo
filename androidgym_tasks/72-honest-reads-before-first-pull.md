# Before the first pull, nothing counts or claims from partial history

**Status:** The record page and the log foot's Retry are built. The log foot's waiting copy waits for 05.18 to be approved. The *new best* rule is not built.

**Figma:** 05.18 The log, reading before the first pull (🚧 In progress, awaiting owner approval; ledger 11u): [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1767-27118) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1767-27204). Build the log-foot part only once it is ✅ Ready for dev.

**Context:** a phone signed in to an account it has not pulled yet holds partial history. Rule: device-local data can support leaving something out, never asserting it. PR #43 gated the receipt's record and the record page's tiles. Native e2e on 2026-10-31 found three more places.

**Current implementation**
- **Record page:** on an unread account the record page leaves out the tiles, the *Estimated strength* card (its latest estimate and its workout count) and *Nothing logged for this movement yet*, under the same completeness flag (`Record.page`). It lists the sets the phone holds. The left-out lines appear once the first pull lands.
- **Log foot:** the unread log's foot reads *That read failed. Retry*, but nothing failed; it is waiting for the first pull. Retry reads the phone's copy again and asks the sync runtime for the first pull (`TrainingStore.retryLog`, `SyncRuntime.pullAgain`); the log reads itself when the pull lands.
- **New-best marker:** the log's *new best* marker is missing on a one-set workout that set an e1RM (115×8, e1RM 145.7 over 133.3), though the record page lists it under earlier records. Slight workouts (fewer than 4 sets) are not record-eligible by design, so this may be intended. Check the shared rule and make the log and the record page agree.

**Change**
- **Log foot:** the designer gives the waiting state its own copy, for example "Reading your log…". File it in `docs/design/consistency.md` and build it once approved.
- **New best:** the log row and the record page follow one shared rule for "new best". Add a vector for a slight workout.

**Done when**
- Before the first pull, the log's foot matches the approved 05.18.
- The log and the record page agree on slight-workout bests.

**Depends on:** 21, 22.
