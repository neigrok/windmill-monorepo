# Before the first pull, nothing counts or claims from partial history

**Status:** 🚀 On main (`63844df3`), in Android 0.14.0: the record page, the shared *new best* rule and 05.18, the log before the first pull. Routines keeps *No routines yet.* before the first pull, by the owner's ruling (ledger 11u).

**Figma:** 05.18 The log, reading before the first pull (🚀 In production; ledger 11u): [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1767-27118) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1767-27204).

**Context:** a phone signed in to an account it has not pulled yet holds partial history. Rule: device-local data can support leaving something out, never asserting it. PR #43 gated the receipt's record and the record page's tiles. Native e2e on 2026-10-31 found three more places.

**Current implementation**
- **Record page:** on an unread account the record page leaves out the tiles, the *Estimated strength* card (its latest estimate and its workout count) and *Nothing logged for this movement yet*, under the same completeness flag (`Record.page`). It lists the sets the phone holds. The left-out lines appear once the first pull lands.
- **Log:** on an unread account the log lists the workouts and weigh-ins this phone holds and leaves out the new-best dots and moments and the weekly line, under the record page's completeness flag (`StatsProgress.isComplete`, read by `logTimeline`), and a weigh-in's change since, on the same first-pull flag (`HistoryReads.historyRead`, read by `LogReadout.weight`).
- **Log foot:** on an unread account a short or unanswered page's foot is reading (`Older.Reading`, `HistoryReads.footAfter`): once the wait passes 400 ms it shows *Reading your log…* over an M3 indeterminate linear indicator, with no button, one polite live region that carries the bar (`LogScreen` `LogFoot`). It claims no first workout. The sync runtime numbers its pulls and says when none can be attempted (`SyncRuntime.pulls`, `Pulls`: offline, an upgrade required, no seat, every scope stopped at this version's digest). When no pull can run, or the latest failed with none in flight since Retry asked, the foot becomes **Retry** · *That read failed.*, a polite live region (`HistoryReads.older`, `Pulls.stalled`). Retry asks for the pull again (`HistoryReads.retryLog`, `SyncRuntime.pullAgain`), or is refused while no pull can run; the foot reads again while a pull is in flight. The log reads itself when the pull lands, and the usual foot returns, a walked log's included. `gym_action` `log` / `first_pull` sends `state: shown` when the bar shows and then `read` or `failed`.
- **New best:** the log row and the record page read one shared rule, `ProgressRecords`. A slight workout (fewer than 4 sets) sets new bests and record steps like any other; slightness silences only its receipt. The log states each new best once: by its woven moment, or by the row's dot when the week's moment is another best. So a slight workout's best can show as the moment and not as a dot. Slight-workout vectors in `packages/api-contract/gym/domain/training-reads.json` pin this on all three surfaces.

**Done when**
- Before the first pull, the log matches the approved 05.18.
- The log and the record page agree on slight-workout bests.

**Depends on:** 21, 22.
