# A proposal over a dead routine reads as out of date instead of failing to decode

**Status:** On main; checked on the local stack: a routine proposed over MCP and then deleted by another replica's sync push leaves Routines on the phone with neither the routine nor its proposal, the server drops the proposal with the routine, and logcat and Sentry show no decode failure. The deleting surface was a second sync replica driven by script, not the web app in a browser.

**Context:** when a reader serves a pending proposal's confirmed routine as a dead row with no fields, decoding threw, so the proposal could not be read, applied or turned down. This is item 1 of the PR #19 review's follow-ups.

**Reproduction:** the shared vector reproduced the throw on Kotlin, Swift and web (`DecodeError routine.name: absent`), each from `ProposalState`'s read. On web the corpus reader first had to serve confirmed rows as Kotlin's and Swift's do, the scene's `stored` rows. No engine reproduced it: every engine deletes a confirmed row when a dead row arrives, so `confirmed()` never returns a dead row from a pull, and the log kills a routine's proposals with the routine. `EngineTrainingTests.aProposalOverARoutineDeletedElsewhereLeavesWithItAndApplyIsGone` drives that path through the Kotlin engine and the model server; it passed before the fix and stays as a guard.

**Current implementation**
- `ProposalState` reads a confirmed routine only when the row is visible; a dead row is no confirmed copy (Kotlin `apps/android/gym/domain/…/sync/Proposals.kt`, Swift `apps/ios/Domain/Sources/GymDomain/Proposals.swift`, web `web/src/products/gym/domain/proposals.js`).
- `proposals-actions.json` holds *applying over a routine whose confirmed row is dead is gone* (Apply refused `gone` on the routine) and *dismissing over a routine whose confirmed row is dead still turns it down*. Both pass on Kotlin, Swift and web, with nothing pending.
- The web product corpus reads confirmed rows from the scene's `stored` rows (`web/test/platform/domain-kit/productCorpus.js`), as `VectorReader` does on Kotlin and Swift.

**Change**
- Reproduce it first, with a vector: a pending proposal over a deleted routine whose confirmed row is dead.
- `ProposalState` treats a dead confirmed routine as no confirmed copy: with the routine gone the proposal is out of date, and Apply is refused with the existing gone refusal. Swift and web do the same.
- Add the case to `proposals-actions.json`.

**Done when**
- The vector passes on Kotlin, Swift and web, with nothing pending.
- On the local stack: propose a change over MCP, delete the routine on another surface, then open Routines on the phone. Neither the routine nor its proposal shows, since the log kills a routine's proposals with it, and nothing reports a decode failure to Sentry.

**Depends on:** none. Tree: `gym-proposal-state-followups`.
