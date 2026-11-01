# Coach shows that its proposal is still arriving

**Status:** Waits for its board: design brief item QW2.

**Figma:** none yet. The state comes from QW2 ([design brief](design-brief-quality-wave.md)), beside the existing proposal card boards.

**Context:** Coach can answer before its proposal reaches the phone. Until the miss settles, Android draws nothing in the card's place, because no board draws a waiting state (ledger 11w). The answer can mention a change that is not visible yet.

**Current implementation**
- `coach/AskScreen.kt:440-496` re-reads an unseen proposal on every replica change and calls it gone only after a 10 s wait plus a later read, or a pull asked after the wait that landed caught up. Nothing is drawn meanwhile (`:275-277`). The settled miss reads *This proposal is no longer available.*
- `gym_proposal_missing` counts only answers this visit waited for.

**Change**
- Once QW2 is ✅ Ready for dev, draw the waiting state in the card's place from the answer until the proposal arrives or the miss settles. When the proposal arrives, the card replaces it in place.
- If the board adds a step a person can see, emit an event for it, and list it in `docs/ANDROID_OBSERVABILITY.md`.

**Done when**
- The waiting state matches QW2 in Dark and Daylight.
- A test drives a proposal that arrives 3 s after its answer: the waiting state, then the card, with no gap.
- Coach's existing action cards are otherwise unchanged (the owner's freeze).

**Depends on:** 28, design brief QW2. Tree: `android-coach-proposal-arriving-state`.
