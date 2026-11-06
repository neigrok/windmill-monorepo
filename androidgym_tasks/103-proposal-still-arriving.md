# Coach shows that its proposal is still arriving

**Status:** Waits for its board: design brief item QW2.

**Figma:** none yet. The state comes from QW2 ([design brief](design-brief-quality-wave.md)), beside the existing proposal card boards.

**Context:** On the phone that ran a turn its proposal commits with its call. A conversation synced from another phone can land an answer before its proposal, and the answer can mention a change that is not visible yet (ledger 11w).

**Current implementation**
- `AnsweredProposals` (`coach/AskScreen.kt`) re-reads an unseen proposal on every replica change and calls it gone only after a 10 s wait plus a later read, or a pull asked after the wait that landed caught up. Until a read misses, the room says *Reading proposal…*; until the miss settles, nothing in a routine card's place and *Reading proposal…* in a workout change's. The settled miss reads *This proposal is no longer available.*
- `gym_proposal_missing` counts only answers this visit waited for.

**Change**
- Once QW2 is ✅ Ready for dev, draw the waiting state in the card's place from the answer until the proposal arrives or the miss settles. When the proposal arrives, the card replaces it in place.
- If the board adds a step a person can see, emit an event for it, and list it in `docs/ANDROID_OBSERVABILITY.md`.

**Done when**
- The waiting state matches QW2 in Dark and Daylight.
- A test drives a proposal that arrives 3 s after its answer: the waiting state, then the card, with no gap.
- Coach's existing action cards are otherwise unchanged (the owner's freeze).

**Depends on:** 28, design brief QW2. Tree: `android-coach-proposal-arriving-state`.
