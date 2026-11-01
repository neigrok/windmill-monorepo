# A proposal over a dead routine reads as out of date instead of failing to decode

**Status:** Not started. Domain only; nothing visual changes, since the out-of-date state already exists.

**Context:** when a pending proposal's confirmed routine is a dead row with no fields, the proposal cannot be read, applied or turned down: decoding throws, so Coach and Routines show nothing useful. This is item 1 of the PR #19 review's follow-ups. It comes from reading the code and has not been reproduced yet.

**Current implementation**
- `ProposalState` decodes the confirmed routine without a check (Kotlin `apps/android/gym/domain/…/sync/Proposals.kt:168`).
- The engine's `confirmed()` returns any stored row, dead rows included (`apps/android/sync-engine/…/Engine.kt:321-326`).
- `Routine.decode` requires `name` (`Routines.kt:58`; `Fields.string` throws at `domain-kit/…/Entities.kt:60`).
- Web has the same shape (`web/src/products/gym/domain/proposals.js:290-294`). Swift was not checked.

**Change**
- Reproduce it first, with a vector: a pending proposal over a deleted routine whose confirmed row is dead.
- `ProposalState` treats a dead or field-less confirmed routine as gone: the proposal is out of date, and Apply is refused with the existing gone refusal. Swift and web do the same.
- Add the case to `proposals-actions.json`.

**Done when**
- The vector passes on Kotlin, Swift and web, with nothing pending.
- On the local stack: propose a change over MCP, delete the routine on another surface, then open Routines on the phone. The proposal reads as out of date, and nothing reports a decode failure to Sentry.

**Depends on:** none. Tree: `gym-proposal-state-followups`.
