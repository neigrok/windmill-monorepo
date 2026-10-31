# Before the first pull, nothing counts or claims from partial history

**Status:** Logic is ready. The log's foot copy needs a designer: it stays 🚧 until a board or copy is approved. Not started.

**Context:** a phone signed in to an account it has not pulled yet holds partial history. Rule: device-local data can support leaving something out, never asserting it. PR #43 gated the receipt's record and the record page's tiles. Native e2e on 2026-10-31 found three more places.

**Current implementation**
- **Record page:** on an unread account the record page still shows the latest estimate and "Last 12 weeks · 1 workout" while the server holds 8 (`s4-f-record-page-unread.png`).
- **Log foot:** the unread log's foot reads *That read failed. Retry*, but nothing failed; it is waiting for the first pull.
- **New-best marker:** the log's *new best* marker is missing on a one-set workout that set an e1RM (115×8, e1RM 145.7 over 133.3), though the record page lists it under earlier records. Slight workouts (fewer than 4 sets) are not record-eligible by design, so this may be intended. Check the shared rule and make the log and the record page agree.

**Change**
- **Record page:** gate the workout count and the latest estimate on the same completeness flag as the tiles. Before the first pull, leave them out.
- **Log foot:** the designer gives the waiting state its own copy, for example "Reading your log…". File it in `docs/design/consistency.md` and build it once approved.
- **New best:** the log row and the record page follow one shared rule for "new best". Add a vector for a slight workout.

**Done when**
- On the local stack, signed in with the pull blocked, the record page shows no count or estimate. They appear after the pull.
- The log and the record page agree on slight-workout bests.

**Depends on:** 21, 22.
