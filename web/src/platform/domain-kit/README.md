# Domain kit

The web implementation of [the domain kit](../../../../docs/foundation/domain-kit.md): the pure-logic
layer a product's feature domains are declared on, beside the Swift `DomainKit` and the Kotlin
`:domain-kit`. It names no product. Every behaviour §15 lists reproduces the shared vectors under
`packages/api-contract/domain-kit/` byte for byte (`test/platform/domain-kit/corpus.test.js`).

## The layer rule

A kit file imports the shared `packages/api-contract/sync/reference/core/<name>.js` by relative
path, the web's `sync/core/encoding.js` and `content.js`, and kit files; a product domain
(`src/products/<p>/domain/`, and its feature folders such as gym's `coach/`) imports the same core modules, the kit,
`platform/sync/schema.js` and its own domain, never above it. No clock, randomness, platform global, console, locale, rounding (the quantum's is
`core/values.js`) or concurrency; `runner.js`, the one impure file, alone awaits the engine. Every
file opts into `tsc --checkJs` with `// @ts-check`. `npm run check:domain` first runs
`test/domain-layering.test.js`, which parses every file with acorn and enforces these rules with a
fixture per rule, then type-checks the files using `tsconfig.domain.json`.

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
| `acts.js` | §9.5 | `ActPlan`, `ScopedPlan`, `ActDecision`, `ActReader`, `ActIDSource`: an act over several scopes |
| `drafts.js` | §10 | `Draft`, `Saved`, `SaveResult`, `SaveDraft` (`ofDraft`, `creating`) |
| `standardActions.js` | §11 | `Remove`, `Move` |
| `refusals.js` | §12 | `Refused`, `commandSubject`, `DomainNotice` |
| `runner.js` | §9.2 | `ActionRunner` over a replica port; `EngineReplica`, the port over `platform/sync/engine.js` |

## Spellings

An entity is a value with `id` (an `Id`) and `fields()`; its declaration is `new EntityType({ type,
scope, decode, checks, heldRemoval, orderField, savesGuarded, savesReversibly, timestampField })`, each
protocol a declared member; `savesReversibly` runs every save of the type as a reversible act. Decisions, outcomes and save results are tagged objects (`kind`), built by
`Decision.write(plan, result)`, `Outcome.committed(result, receipt)`, `SaveResult.saved(receipt)` and
their siblings. A draft is immutable: `Draft.new(blank, placement)`, `Draft.opening(value)`,
`draft.edit(fn)` and `draft.rebased(theirs)` return the next draft, and `runner.save(draft, refusals)`
answers `{ result, draft }`. `run` and `save` are `async` because the browser engine's commit resolves
after its IndexedDB transaction; the body that loads, decides and translates runs synchronously inside
it, and a decider that returns a Promise is a `Fault`.
Nested `run` and `save` calls fault before queueing a transaction, including calls through another
runner in that synchronous execution context. Independent queued runs remain allowed. The persisted
web runner tests cover load, decide and refusal mapping: §15.2's pipeline vectors have no nested-call operation and use a
loader that does nothing.

`Reader.replica` names the replica a run's commit writes to (its `rp_` id, §7.1), which `EngineReplica` reads from the
engine's `readMetadata` and the vectors name `rp_00000000000000000000000000000001`. `Reader.confirmed(type, id)` reads the confirmed record below pending predictions; the port hands the confirmed rows as
a lookup (`get(key)`), so a read copies only the rows it asks for, each keeping its row's `seq`. `Repository.spentBorn(id)`
answers the born of a record the device keeps only by its spent id (engine §7.5), which a revival takes (§9.2 step 5), and
`spentSeq(id)` the `seq` of the dead row it came from (engine §2.5), null where it keeps none (§7.2). `EngineReplica.read` lets go of
the observation hold it takes, so a read keeps no scope observed that the app does not; it answers the device's rows
of a scope nothing holds all the same, since every engine publication reads every scope whole (engine §7.8), and a
snapshot that is not loaded is a `Fault`, never an empty answer. `devices(prefix)`,
`commands()`, `checkpoint()`, `actor` and `isAnonymous` carry the scope's reconciliation inputs;
`IDSource.opaqueID()` mints a durable command identity through the engine's CSPRNG edge.
`Plan.supersede(gestureIds)` replaces whole, never-numbered anonymous gestures in the same transaction
as the new command and device writes. A receipt includes `superseded` when any were replaced. Device
writes keep plan order; command text predictions carry `from: null` because they have no merge base. A `Prediction`
names its scope when it is not the plan's (E-7): translation then groups every prediction in `scopedPredict`, the
plan's scope first, and `EngineReplica` hands it to the engine.

## Binding

A declaration sets `scope` to null for tree and overlay records. Callers supply the
actual scope to `runner.mint(type, scope)`, `open(type, id, scope)` and
`openOrNew(type, id, blank, scope)`. `Draft.new(blank, placement, scope)`,
`Draft.opening(value, scope)`, `SaveDraft.creating(value, refusals, placement, scope)`,
`Remove(id, refusals, scope)` and `Move(id, below, refusals, scope)` take the same explicit binding.
Fixed declarations keep their existing calls through the scope default. A draft retains its binding
through edits, rebasing and saves; `runner.save(draft, refusals, scope)` rejects any different scope.
Readers and plan translation check both the registry's scope kind and any fixed declaration.

`new ActionRunner(new EngineReplica(engine), engine.registry, zone)`, where `engine` is the shell's
`BrowserSyncEngine`. The runner mints the gesture id through `engine.newGestureId()` and passes it as
`opts.gestureId`, so a `too-large` refusal names the notice the commit wrote and the runner dismisses it;
a held removal's receipt reads `releaseAt` from the gesture's entry. `runAct(act, {binding})` and
`runComposed(parts, {binding})` hand `commitAct` the `engine.activeBinding()` a product planned the act under, so
a sign-in or a sign-out in between rejects the run with the engine's `ReplicaChanged` and writes nothing. Reads
outside a run come from `engine.observe(scope).getSnapshot()` and `engine.readMetadata(scope)`. Inside a run, confirmed rows,
device rows, commands, actor, anonymity and checkpoint are loaded from the commit's own transaction.
The checkpoint exposes `cleanSeq` only for a complete, same-epoch live cursor with no staging,
lagging pull, digest reset or digest stop. `firstPullComplete` retains the engine's separate first-boot
meaning; it does not establish that a command's result has been pulled in the current epoch.

Persisted runner tests cover stale-tab transactional reads, predictions over confirmed records,
checkpoint rejection states, opaque identities and anonymous supersession across an aborted commit
and reopening.

## Ability catalogs

`abilities.js` reads plain catalog data with `Ability` and `Catalog`; `JsonSchema` implements the
same recursive subset as Kotlin's domain-kit `Abilities.kt`. Required fields keep their declared
order; object members use canonical key order. String lengths count Unicode scalars and patterns
match the whole value. Unknown schema keywords pass. Platform tests load the shared gym catalog as
data, with no product-code dependency.
