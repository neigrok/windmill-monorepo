# A machine's load reads kg

**Status:** Waits for its boards: design brief item QW6. The owner ruled on 2026-11-01; the boards that draw a machine as *kg total* need to follow before the build.

**Figma:** the boards QW6 names, once they are ✅ Ready for dev ([design brief](design-brief-quality-wave.md)).

**Context:** the owner ruled that a machine's load reads plain *kg* on iOS, Android and web, while a barbell keeps *kg total*. Today the domain says *kg total* for a machine, so the app and the ruling disagree.

**Current implementation**
- `loadUnit` returns *kg total* for a machine on all three surfaces: Kotlin `TrainingReads.kt:469`, Swift `TrainingReads.swift:504`, web `trainingReads.js:559`.
- The shared vector expects it (`packages/api-contract/gym/domain/training-reads.json:164`). So do `packages/api-contract/gym/domain/README.md:84` and ledger 11e.
- The plan-swap rule keys on the unit (`WorkoutPlan.kt:63`; README `:164`).
- Every readout on Android (logger, Fix set, movement form, workout page) goes through `Readout.loadUnit` (`apps/android/gym/…/presentation/Readout.kt:52-53`).

**Change**
- `loadUnit` returns *kg* for a machine on Kotlin, Swift and web. Update the vector, the contract README and ledger 11e in the same change.
- Check the plan-swap rule: a machine swapped for a barbell must still compare like with like. Add a vector if the unit change moves its answer.

**Done when**
- The vectors pass everywhere, with nothing pending.
- The machine rows on the rack, Fix set, the routine summary, the receipt and the workout page read *kg* in Dark and Daylight, matching QW6's boards.

**Depends on:** 08, design brief QW6. Tree: `gym-machine-unit-kg`.
