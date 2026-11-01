# Before the first pull, nothing counts or claims from partial history

**Status:** Logic is ready. The log's foot copy needs a designer: it stays 🚧 until a board or copy is approved. Not started.

**Figma:** 05.18 The log, reading before the first pull (🚧 In progress, awaiting owner approval; ledger 11u): [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1767-27118) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1767-27204). Build the log-foot part only once it is ✅ Ready for dev.

**Context:** a phone signed in to an account it has not pulled yet holds partial history. Rule: device-local data can support leaving something out, never asserting it. PR #43 gated the receipt's record and the record page's tiles. Native e2e on 2026-10-31 found three more places.

**Current implementation**
- **Record page:** on an unread account the record page still shows the latest estimate and "Last 12 weeks · 1 workout" while the server holds 8 (sign in on a fresh install to an account with history, with the pull blocked at a proxy).
- **Log foot:** the unread log's foot reads *That read failed. Retry*, but nothing failed; it is waiting for the first pull.
- **New best:** the log row and the record page read one shared rule, `ProgressRecords`. A slight workout (fewer than 4 sets) sets new bests and record steps like any other; slightness silences only its receipt. The log states each new best once: by its woven moment, or by the row's dot when the week's moment is another best. So a slight workout's best can show as the moment and not as a dot. Slight-workout vectors in `packages/api-contract/gym/domain/training-reads.json` pin this on all three surfaces.

**Change**
- **Record page:** gate the workout count and the latest estimate on the same completeness flag as the tiles. Before the first pull, leave them out.
- **Log foot:** the designer gives the waiting state its own copy, for example "Reading your log…". File it in `docs/design/consistency.md` and build it once approved.

**Done when**
- On the local stack, signed in with the pull blocked, the record page shows no count or estimate. They appear after the pull.
- The log and the record page agree on slight-workout bests.

**Depends on:** 21, 22.
