# The web share page counts sets 1..N in logged order

**Status:** Not started. Web only. The owner's ruling (ledger 11u, 2026-11-01) settles the numbers; the row's drawing does not change.

**Context:** the owner ruled that each set row on a workout page leads with the set's position within its movement, counted 1..N in logged order, never the server's set number, which can read *2, 3, 1*. Android and iOS follow the rule. The public share page still prints the server's number.

**Current implementation**
- `web/src/products/gym/share/SharedSession.jsx:60` prints `{set.setNumber}`, and `:59` uses it as the row key.
- The ledger records this drift (`docs/design/consistency.md`, Native and web differences).
- Android counts in `ui/SessionScreen.kt` (`Performed.Row.position`). iOS counts in `SetRow.marker` (`apps/ios/App/Sources/Gym/Components/GymRows.swift:236-237`) over sets sorted by `completedAt`, then id (`Training.swift:233-235`).

**Change**
- The share page numbers each movement's sets 1..N by `completedAt`, then id, the same order the phones use. Key rows by set id.
- Remove the drift line from the ledger in the same change.

**Done when**
- A web test renders a shared workout whose server set numbers read 2, 3, 1 and shows 1, 2, 3.
- On the local stack, a workout shared from the phone reads the same numbers on its public page as on the phone's workout page.

**Depends on:** none. Tree: `web-share-page-set-count`.
