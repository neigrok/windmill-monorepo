# What Coach read counts only weeks it can show

**Status:** Not started. Backend first, then Android and web. The receipt keeps its drawing and only the number becomes true. The numberless wording on Android waits for the designer's confirmation: design brief item QW10.

**Context:** *What Coach read* says, for example, *Read 12 workouts · 5 weeks*. The server counts weeks that no observation names: every week `get_stats` returned, empty ones included. No client can list the weeks behind the number. iOS stopped printing it for that reason; Android and web still print it.

**Current implementation**
- `backend/products/gym/adapters/mcp/GymTools.cpp:315-316` adds every week from `get_stats`. `domain/ReadReceipt.cpp:76` (`sawWeek`) inserts them, and `tally()` counts the whole set (`:84-87`).
- iOS counts weeks from the workouts *What Coach read* lists (ledger 10g).
- Android shows the server's number in `coach/CoachSources.kt` (the 48 dp row of task 64).

**Change**
- The server counts only weeks named by a workout or set the receipt lists, or carries the week list beside the number. Choose one, and record it in `docs/gym-coach-contract.md`.
- Android and web print the provable count, as iOS does. A `get_stats`-only answer reads *Read your movement history* with no number, the iOS wording.
- The model servers follow if they produce receipts.

**Done when**
- Backend tests cover a `get_stats`-only answer and an answer with listed workouts.
- On the local stack, Android, web and iOS show the same receipt text for the same answer.
- The backend half ships through the production deploy; plan it with the owner.

**Depends on:** 37. Tree: `coach-receipt-weeks-provable`.
