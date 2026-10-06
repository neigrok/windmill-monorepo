# Domain kit

The web implementation of [the domain kit](../../../../docs/foundation/domain-kit.md): the pure-logic
layer a product's feature domains are declared on, beside the Swift `DomainKit` and the Kotlin
`:domain-kit`. It names no product. Every behaviour §15 lists reproduces the shared vectors under
`packages/api-contract/domain-kit/` byte for byte (`test/platform/domain-kit/corpus.test.js`).

## The layer rule

A kit file imports `../sync/core/<name>.js` and kit files, nothing else; a product domain
(`src/products/<p>/domain/`) imports the kit, `platform/sync/core`, `platform/sync/schema.js` and
itself. No clock, randomness, platform global, console, locale, rounding (the quantum's is
`core/values.js`) or concurrency; `runner.js`, the one impure file, alone awaits the engine. Every
file opts into `tsc --checkJs` with `// @ts-check` and `npm run check:domain` type-checks them
(`tsconfig.domain.json`). `test/domain-layering.test.js` parses every file with acorn and enforces
all of it, with a fixture per rule.

## Files

| File | Spec | Holds |
|---|---|---|
| `values.js` | §4 | `Path`, `Violation`, `TextSpec`, `NumberSpec`, `ChoiceSpec`, `CountSpec`, `firstNul`; `Fault` and `precondition`, the kit's programming faults |
| `time.js` | §5 | `Instant`, `LocalDay`, `FixedZone`, `Moment` |
| `entities.js` | §3 | `EntityType` (an entity's declaration and protocols), `Id`, `Fields`, `DecodeError` |
| `validation.js` | §4.5 | `Check`, `Valid`, the only constructor of a validated entity, and `isValid`, its brand |
| `rules.js` | §6.3 | `Rule`, `RuleBook` |
| `reading.js` | §7 | `Views` (what a reader reads), `Reader`, `Repository`, `Capacity`, `Placement` |
| `plans.js` | §8.1, §8.4 | `Plan`, `Operation`, `Prediction`, `PlanError` |
| `translation.js` | §8.2, §8.3 | `translate(plan, scope, registry)` → the engine gesture, `recordIdOf` |
| `actions.js` | §9.1, §9.2 | `Decision`, `Outcome`, `IDSource`, `decision`, `firstGone`, `refusalSubject` |
| `drafts.js` | §10 | `Draft`, `Saved`, `SaveResult`, `SaveDraft` (`ofDraft`, `creating`) |
| `standardActions.js` | §11 | `Remove`, `Move` |
| `refusals.js` | §12 | `Refused`, `commandSubject`, `DomainNotice` |
| `runner.js` | §9.2 | `ActionRunner` over a replica port; `EngineReplica`, the port over `platform/sync/engine.js` |

## Spellings

An entity is a value with `id` (an `Id`) and `fields()`; its declaration is `new EntityType({ type,
scope, decode, checks, heldRemoval, orderField, savesGuarded, timestampField })`, each protocol a
declared member. Decisions, outcomes and save results are tagged objects (`kind`), built by
`Decision.write(plan, result)`, `Outcome.committed(result, receipt)`, `SaveResult.saved(receipt)` and
their siblings. A draft is immutable: `Draft.new(blank, placement)`, `Draft.opening(value)`,
`draft.edit(fn)` and `draft.rebased(theirs)` return the next draft, and `runner.save(draft, refusals)`
answers `{ result, draft }`. `run` and `save` are `async` because the browser engine's commit resolves
after its IndexedDB transaction; the body that loads, decides and translates runs synchronously inside
it, and a decider that returns a Promise is a `Fault`.

## Binding

`new ActionRunner(new EngineReplica(engine), engine.registry, zone)`, where `engine` is the shell's
`BrowserSyncEngine`. The runner mints the gesture id through `engine.newGestureId()` and passes it as
`opts.gestureId`, so a `too-large` refusal names the notice the commit wrote and the runner dismisses it;
a held removal's receipt reads `releaseAt` from the gesture's entry. Reads outside a run come from
`engine.observe(scope).getSnapshot()` and the product's device rows.
