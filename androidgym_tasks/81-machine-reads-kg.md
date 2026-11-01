# A machine's load reads kg

**Status:** 🚀 Built in PR [#53](https://github.com/neigrok/windmill-monorepo/pull/53) (`a2e82eb8`). Section U [`1814:13077`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1814-13077) is ✅ Ready for dev. Robolectric tests cover the Android readouts; an emulator pass has not been run.

**Figma:** Proposals section U (U.1–U.9), the boards QW6 names ([design brief](design-brief-quality-wave.md)).

**Rule:** a machine's load reads plain *kg* on iOS, Android and web; a barbell keeps *kg total* (owner ruling 2026-11-01, ledger 11e).

**Implementation**
- `loadUnit` returns *kg* for a machine in Kotlin `TrainingReads.kt`, Swift `TrainingReads.swift` and web `trainingReads.js`, pinned by `packages/api-contract/gym/domain/training-reads.json`.
- Every Android readout (logger, Fix set, movement form, workout page) goes through `Readout.loadUnit`.
- The plan swap carries targets only between movements of one unit. `workout-plan-actions.json` pins it: Leg Press → Back Squat opens its targets, and Chest Supported Row → Seated Cable Row carries them.

**Depends on:** 08, design brief QW6. Tree: `gym-machine-unit-kg`.
