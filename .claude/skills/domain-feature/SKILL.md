---
name: domain-feature
description: Build or change a gym or journal feature's domain logic on the Windmill domain kit, in Swift (apps/ios/Domain, GymDomain or JournalDomain) or Kotlin (apps/android/gym/domain) — entities, value specs, rules and the product refusal, reads, actions, drafts and their one save, keyed records saved whole, moves, held deletes and Undo, Coach executors, their harness tests and the shared vectors every implementation reproduces. Pure logic, no UI. Use when asked to add or change a gym or journal feature's entities, rules, actions, drafts or saves on iOS or Android, or to make another implementation claim a shared vector.
---

# A feature domain on the domain kit

The kit has one spec and one implementation per language; a feature's logic is declared once per implementation that
carries its product, and the shared vectors under `packages/api-contract/` are the contract between them. This skill
carries the common path end to end; the kit's spec, `docs/foundation/domain-kit.md` (§n below), and the engine's,
`docs/foundation/engine.md` (engine §n), are normative for the rest. The reference shapes are gym **Notes** (minted,
ordered, capped, guarded) and gym **Bodyweight** (keyed by day, one fact saved whole):

| | Swift | Kotlin |
|---|---|---|
| domain | `apps/ios/Domain/Sources/GymDomain/{Notes,Bodyweight,GymRules}.swift` | `apps/android/gym/domain/src/main/kotlin/works/windmill/gym/domain/sync/{Notes,Bodyweight,GymRules}.kt` |
| tests | `apps/ios/Domain/Tests/GymDomainTests/` | `apps/android/gym/domain/src/test/kotlin/works/windmill/gym/domain/sync/` |
| vectors | `packages/api-contract/gym/` — shared, written once, claimed by every runner | |

Gym is carried by Swift and Kotlin; journal by Swift only (`JournalDomain`). Web carries both products with no kit
yet: see [Web](#web--no-kit-yet). The shared path below is written in Swift, the spec's own language, with the
Kotlin name beside it where the two differ; each platform's section then gives its paths, commands and the layering
rules it enforces.

**Not** for screens, view models or copy (the `Windmill<P>` UI modules, `:gym`), the engine or a registry
(`apps/ios/Sync`, `apps/android/sync-*`, `packages/api-contract/sync`), or roadmap, which is web only.

## The rule every implementation enforces

A product domain depends on the kit and the engine API and nothing else (§2.2): no UI framework, no engine runtime,
no test support, no other product's domain. Inside it, time comes only from a `Moment`, ids only from
`IDSource.mint`, `runner.mint`, a natural key or the action's input; no randomness, no I/O, no concurrency, no
logging. Each platform's layering tests fail the build on a breach; what each one reads is in its section.

## Build order

### 1. Read the registry, the binding and the canon

Read the type in `packages/api-contract/sync/<product>.registry.json`, its binding in engine Appendix A.2 (gym) or A.3
(journal), and the feature's brief in `docs/design/<product>/briefs/`. The generated schema module (`SyncSchema`,
`:sync-schema`) names everything: `Gym.scope`, `Gym.Types.weighin`, product refusal codes `Gym.Codes.badInstant`,
defaults `Gym.Defaults.Prefs.units`.

| The registry, binding or canon says | The entity declares |
|---|---|
| `identity: minted` | ids from `runner.mint` as a draft opens, or from `IDSource.mint` or the call in an action |
| `identity: keyed` or `singleton` | its natural id (`ID(day)` for a local-date key); drafts open with `open(_:orNew:)` |
| `wholePut: true` (keyed, with life): each record is one fact | `Draftable`, `savesGuarded = false`, writing every client field |
| a field that records each save's moment (A.2 `weighin.recordedAt`) | `Timestamped`, naming it `timestampField`, with no check |
| `life: true`, and the binding lets a client delete it | `Removable` |
| the delete is in the canon's delete windows (gym: `docs/design/gym/briefs/13-gestures.md`) | `heldRemoval = true`; A.2's **Held** list must agree, else record the drift in `docs/design/consistency.md` |
| a client `lww` field with a `fracKey` domain | `Ordered`, naming it `orderField` |
| "Editor save guards the fields it writes" | `savesGuarded = true`, and so no `text` field |
| the `writer: client` fields, with bounds, enum, `quantum` | `fields`, and a spec no looser than the registry |

A type or field the registry lacks is an engine change first (registry, engine Appendix A, `swift run SyncSchemaGen`
in `apps/ios/Sync`, `python3 tools/schema_gen.py` in `apps/android`), never a domain workaround.

### 2. The entity, its checks and specs (§3, §4)

A value type. Its decoder (Swift `init(_ r: Fields) throws(DecodeError)`; Kotlin `decode(f: Fields)` on the companion)
is lenient — a default or an optional for what may be absent, `r.text(f)` for a `text` field, any id the registry admits
— and decodes what `fields` builds. `fields` lists every client field it writes, a nil as `.null`, never the order
field or a serial. `checks` run in the order violations are reported: a `Check("f")` normalises its own field only
(Kotlin returns the `copy`); a `.key` check is a rule on the natural key, reading only the id and the moment, on every
write. Specs are data named by their registry path. The keyed whole shape, in Swift:

```swift
public struct WeighIn: Draftable, Removable, Timestamped {
  public static let type = Gym.Types.weighin
  public static let scope = Gym.scope
  public static let savesGuarded = false
  public static let heldRemoval = true
  public static let timestampField = "recordedAt"
  public let id: ID<WeighIn>
  public var kg: Double?
  public private(set) var recordedAt: Instant?
  public init(day: LocalDay, kg: Double? = nil) {
    id = ID(day)
    self.kg = kg
  }
  public init(_ r: Fields) throws(DecodeError) {
    id = ID(r.id)
    kg = try r.optionalDouble("kg")
    recordedAt = try r.optionalInstant("recordedAt")
  }
  public var fields: [String: JSON] { ["kg": .of(kg), "recordedAt": .of(recordedAt)] }
  public static let checks: [Check<WeighIn>] = [
    .key { w, moment in
      guard let day = w.id.day, day <= moment.today else {
        throw Violation(rule: WeighInRules.day, path: "id", reason: .custom("future"))
      }
    },
    Check("kg") { w, _ in
      guard let kg = w.kg else { throw Violation(rule: WeighInRules.kg.path, path: "kg", reason: .notANumber) }
      w.kg = try WeighInRules.kg.apply(kg, at: "kg") as Double
    },
  ]
}

public enum WeighInRules {
  public static let kg = NumberSpec("weighin.kg", min: 20, max: 400, quantum: 0.01)
  public static let day = "weighin.day"
  static let rules: [Rule] = [.local(kg), .local(day, subject: WeighIn.type, backstop: [Gym.Codes.badInstant])]
}
```

In Kotlin the same entity is a `data class WeighIn(override val id: Id<WeighIn>, …) : Writable<WeighIn>` whose
`companion object : DraftableType<WeighIn>, RemovableType<WeighIn>, TimestampedType<WeighIn>` holds `type`, `scope`,
the flags, `decode` and `checks`; its ids are `Id(RecordID(day.text), WeighIn)`, and `object WeighInRules` holds the
specs and `Rule.local(kg)`, `Rule.local(dayRule, WeighIn.type, listOf(RefusalCode(Gym.Codes.badInstant)))`.

`Valid` gives a `Timestamped` field the moment's now, so any write of it, the sheet's or an action's, records the
commit's now. Swift's `apply` has plain and optional overloads, so a result assigned to an optional needs `as Double`.
No `trim` on a field saved while the person may still type. A nested value is a `ValueObject` whose `validated(at:)`
applies its specs, a list of them a `CountSpec`. A LOCAL rule written as code throws `.custom(_:)`, declared
`.local(name, subject:)` with a `backstop:` of the product code the server refuses the same thing with (`bad-instant`:
past its UTC tomorrow).

### 3. The product refusal and the rule book (§6.3, §12)

One refusal type per product (gym's `GymRefusal` in `GymRules`; journal declares its own once, on its pattern). Its
mapping from `Refused` is one total `switch` over the code, subject and cap (Kotlin: a `sealed interface` whose
`companion object : Refusals<GymRefusal>` gives `of(violation)`, `of(refused)` and `isGeneric`), an unexpected code
mapping to the one case whose `isGeneric` is true. Every case keeps the path: `.predicted` means nothing was written,
`.notice` that a write committed on this phone was refused by the server (`DomainNotice.values(of:)` holds its words).
A feature's code is one line: `case (Gym.Codes.badInstant, let s?, _) where s.type == WeighIn.type: self = .future(s, r.path)`.

The book adds each entity's standard rules: `<type>.gone` for a type with life, `.taken` for a minted type, `.stale`
for a guarded save, `.cap` for a capped type, `.size` for a type with a `text` field. Declare only the feature's own:
its specs, its code rules, and a SERVER-DECIDED rule for every other code the server refuses its writes with,
`.serverDecided("routine.movement", codes: [Gym.Codes.unknownExercise], subject: Gym.Types.routine)`.

**What a feature adds to the product's shared files**, and nothing else: a case per new code and its mapping line in
`GymRefusal`; that case's JSON form in the refusal form the tests hold (Swift `GymRefusal.form` in
`GymRulesTests.swift`, Kotlin `refusalForm` in `CorpusTests.kt`) and in the refusal forms of
`packages/api-contract/gym/domain/README.md`; its entities to `GymRules.book`'s entities and its rules to its rules,
then `rules.json` (`RuleBookParity` prints the book's JSON on a mismatch); its spec and entity cases in `values.json`.
Its actions, reads and their vectors live in its own files (step 9).

### 4. Reads (§7)

A `Reader` exists only inside `load` and `runner.read(scope) { … }`; `repository(E.self)` (Kotlin
`repository(WeighIn)`) gives `find(_:in:)`, `all(in:)`, `children(of:via:in:)` and `capacity()`. The view is always
named: **`.stored` decides** (caps, positions, anchors, stale checks) and **`.drawn` draws** (what the person sees
and acts on); they differ only in records a held delete names. A derived read is a pure value over decoded entities
(and a moment, when it depends on time) shared by the UI, actions and Coach; one asserting absence ("no weigh-ins yet")
takes `firstPullComplete`. `Bodyweight.init(_ read: Reader)` reads both views, the flag and the moment, so
`try runner.read(WeighIn.scope, Bodyweight.init)` serves all.

### 5. Actions (§8, §9)

Name the standard deciders: Swift type aliases `SaveWeighIn = SaveDraft<WeighIn, GymRefusal>`, `DeleteWeighIn` over
`Remove`, `MoveNote` over `Move`; Kotlin functions `saveWeighIn(value) = SaveDraft(value, WeighIn, GymRefusal)`,
`deleteWeighIn(id) = Remove(WeighIn, id, GymRefusal)`, `moveNote(id, below) = Move(Note, id, below, GymRefusal)`. A
custom action is a value conforming to `Action` (Kotlin `Action<Loaded, Result, GymRefusal>` with `override val scope`
and `override val refusals = GymRefusal`), its stored properties its input:

- `load(_ read: Reader)` reads through the reader only, `read.moment` included, calling a pure domain function between
  two reads when one depends on the other.
- `decide(_:ids:)` is pure: it validates with `Valid(value, at: moment)` or `Valid(value, fields:at:)`, predicts from
  `stored`, and returns `.write(plan, result)`, `.unchanged(result)` or `.refuse(refusal)`; a thrown `Violation` becomes
  `.refuse` in `decision(_:ids:)`, the one channel the runner and every composer read.
- A `Plan` takes only `Valid` values: `create`, `create(_:fields:)` (keyed, singleton), `insert(_:below:)` (ordered),
  `update(_:fields:)` naming only the fields its caller set, `remove`, `move`, `guardRead`, `device`. Two operations on
  one record, another scope, a held removal beside a write, or a whole type written in part is a `PlanError`.
- `runner.run` returns `.committed(result, receipt)` (on this phone, not yet accepted), `.unchanged` or `.refused`.

### 6. Drafts and their one save (§10)

An editor holds one `Draft` of one record: `Draft(new: Note(id: runner.mint(Note.self)), placed: .bottom)` for a new
minted ordered record (`Draft(new:)` unordered), `runner.open(id)` for one the person sees (nil when `drawn` lacks it),
or, for a keyed or singleton record, the record or a new draft of its blank:

```swift
var sheet = try runner.open(ID(day), orNew: WeighIn(day: day))
sheet.current.kg = typed
switch runner.save(&sheet, SaveWeighIn.self) {
case .saved: close()
case .refused(let refusal): show(refusal)
case .failed(let error): showNotSaved(error)
}
```

Kotlin's draft is immutable: `Draft.new(blank, placed)`, `Draft.opening(value)`, `runner.open(WeighIn, id, orNew)`,
edits by `draft.edit { it.copy(kg = typed) }`, and `runner.save(draft, WeighIn, GymRefusal) { held = it }` hands the
draft as stored back through its last argument; a draft saves on the thread that opened it.

Edits, a prefill included, go to `current`. `save` is the only door: synchronous, never throwing, leaving the draft
holding the values as stored; its `switch` has no `default`.

- **Most types** write the touched fields (a new minted draft: every field), nothing when nothing changed. On `.stale`
  (guarded) offer *Keep mine*, `draft.rebased(onto:)` the drawn record, or *Take theirs*, `Draft(opening:)` of it; on
  `.gone`, abandon the draft or start `Draft(new:)` with its values.
- **A whole type** writes every field, validated, with a fresh life on every save, touched or not: never `.unchanged`,
  `.gone` or `.stale`. A sheet left open across a pull or another phone's delete saves what it shows as the newest fact;
  a save inside this phone's delete window retires the delete. The draft holds the stamp after `.saved`.

### 7. Order, held deletes and Undo (§7.5, §11)

A new member's placement resolves against `stored`: `.bottom` goes below the last stored member, a held one included.
A move names the member it lands below, `nil` for the top, and writes the moved key alone; a drop in place writes
nothing. `Remove` of a record `drawn` lacks is `.unchanged`. Of a `heldRemoval` type it hides the record from `drawn`
at once, while `stored` keeps it, its cap slot and its place until the hold releases after `Constants.holdMs`;
`runner.undo(receipt.gestureId)` is true only while it lasts.

### 8. Coach executors (§9.3)

A Coach call composes `SaveDraft(creating:)` (`creating:placed:` if ordered): the call's record under the id its turn
gave it. A replay's `.taken` is done, and a refusal at commit records nothing, so `SaveNoteCall` hears the cap in
decide, by the growth rule:

```swift
switch save.decision(loaded.save, ids: ids) {
case .refuse(.taken), .unchanged: return .unchanged(note.id)
case .refuse(let refusal): return .refuse(refusal)
case .write(let plan, _):
  if let full = loaded.slots.refusal(growing: 1, subject: note.id.ref) { return .refuse(GymRefusal(full)) }
  return .write(plan, note.id)
}
```

### 9. Tests and the shared vectors (§14, §15)

Two levels, on every platform. **The harness** runs the real engine, stepped on the test's thread, over a model
server shared by every phone (members in each platform's section). A commit stays on its phone until a `sync()`,
which moves every phone. For one phone's write to land first, commit it and `sync()` before the other commits; when
both commit before a `sync()`, the phone created first sends first, and the other's write returns as a notice if the
server refuses it. Per action, cover the predicted outcome, the refusal as a notice from a race, a hold with its Undo
and release, stale and Keep mine, gone, and each prediction against the server holding the same state.

**Checks and vectors**, which every implementation reproduces byte for byte, compared by JCS. A feature's test file
runs `RegistryCheck.entity(E.self, sample:book:registry:)` per entity (its sample setting every field) and its own
vectors; the product's rules test runs `RuleBookCheck`, `RuleBookParity` and `values.json`. Actions and draft saves go
in `packages/api-contract/gym/domain/<feature>-actions.json`: `{name, input: {action, input, records: {drawn,
stored?}, ids, now, offsetSeconds}, expect: {decision}}`, a record an engine row (`{"t", "id", "seq", "life": ["alive",
stamp], "f": {"kg": [82.4, stamp]}}`). A `switch` builds each named action:

```swift
@Test(arguments: try Contract.vectors("gym/domain/bodyweight-actions.json"))
func action(_ vector: Vector) throws {
  let corpus = ProductCorpus(GymRules.book)
  let input = try vector.input.member("input")
  let day = try #require(LocalDay(try input.member("day").asString()))
  let result = switch try vector.input.member("action").asString() {
  case "SaveWeighIn":
    try corpus.save(SaveWeighIn.self, vector, opening: WeighIn(day: day), edit: { $0.kg = try? input.member("kg").asDouble() },
                    result: { ["id": ID<WeighIn>(day).json, "fields": .object(fields: $0.values)] }, refusal: \.form)
  case "DeleteWeighIn":
    try corpus.decision(of: DeleteWeighIn(ID(day)), vector, result: { _ in .null }, refusal: \.form)
  case let name: throw ContractError("no bodyweight action \(name)")
  }
  #expect(result == vector.expect, "\(vector)\n  got    \(result.jcsText)")
}
```

A derived read goes in `packages/api-contract/gym/rules/<read>.json`, `{name, input: {read, input?, records,
firstPullComplete?, now, offsetSeconds}, expect: {result}}`, run as
`ProductCorpus(GymRules.book).read(vector, in: WeighIn.scope) { try Bodyweight($0).form(from: from, to: to) }`, the
result's form a test extension of the read. The corpus `README.md` states each action's and read's input and result.

**One corpus, every runner.** A new vector file or case is claimed on every implementation that carries the product
in the same change: Swift's `everySharedFileHasARunner` and Kotlin's `everyProductFileIsClaimedAndEveryVectorPasses`
each list every file under `packages/api-contract/gym/` and fail on one they do not run. A case one implementation
cannot reproduce is a bug in that implementation or in the vector, settled by the spec — never a per-platform
exception, and never a vector written to one language's quirk.

## Swift (`apps/ios/Domain`)

| Where | What |
|---|---|
| `Sources/DomainKit/` | the kit; `Sources/DomainKitNFC/` its one Foundation call |
| `Sources/DomainKitTesting/` | `Harness`, `Contract`, `ProductCorpus`, the checks |
| `Sources/GymDomain/`, `Sources/JournalDomain/` | the product domains, one file per feature plus `<P>Rules.swift` |
| `Tests/GymDomainTests/`, `Tests/JournalDomainTests/` | harness tests and vector runners, one file per feature plus `<P>RulesTests.swift` |
| `Tests/LayeringTests/` | §2.4 over every package under `apps/ios`, with one fixture per rule under `Fixtures/` |

`JournalDomain` has its library, target and test target in `Package.swift`; a new product domain is added there
exactly as `GymDomain`'s are. Before handing back, run everything (about two minutes; `LayeringTests` runs
`swift package dump-package` on every package and, where `xcodegen` is installed, resolves each app project):

```sh
cd apps/ios/Domain
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --explicit-target-dependency-import-check error
```

That is CI's command (`.github/workflows/ios.yml`). A second checkout or worktree building beside the main one adds
`--scratch-path /private/tmp/<name>` so the two builds do not share `.build`; delete the path after.

**The harness**, `DomainKitTesting.Harness`:

| Member | What it does |
|---|---|
| `Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))` | a phone; also `zone:` (default UTC) and `rules:`, a `ServerRules` double |
| `a.device()` | another phone of the same account, server and clock |
| `a.runner` | that phone's `ActionRunner`: `run`, `open`, `save`, `read`, `undo`, `moment()` |
| `a.sync()` | **every** phone's sender and puller, to quiescence |
| `a.advance(ms:)` | the one clock; `advance(ms: Constants.holdMs)` releases every hold committed before |
| `a.leave()`, `a.failNextCommit()` | leaving the app; the next commit fails, so a save is `.failed` |
| `a.drawn(E.self)`, `a.stored(E.self)` | that phone's views, decoded |
| `a.notices(GymRefusal.self)` | its notices, mapped; `values(of: ref)` holds what was refused |
| `a.undoOffers()` | its open holds; an offer's `id` is the gesture id `runner.undo` takes |
| `a.server.refuse(next: 1, code: Gym.Codes.badInstant, detail: nil)` | the server refuses the next intent, for a rule no double models |
| `a.server.rows(scope, of: "acct-1")` | what the server holds |
| `saved(r)`, `refused(r)`, `failed(r)`; `committed(o)`, `unchanged(o)` | result readers |

**Layering, as `LayeringTests` reads it** (§2.3, §2.4), part of every `swift test` of the package:

- A product domain imports only `DomainKit`, `SyncCore`, `SyncAPI` and `SyncSchema` (a file naming `.stored` or
  `.drawn` imports `SyncAPI`, which declares `ViewMode`), and its settings are exactly
  `[.enableUpcomingFeature("MemberImportVisibility")]`, language mode 6. No `Foundation`, UI framework, Combine name,
  import attribute, engine runtime, test support or other product's domain.
- Source rules reject tokens such as `print`, `Task`, `async`, `await`, `MainActor`, `random`, `@unchecked`, `#if` and
  identifiers beginning `_`.
- `<P>DomainTests` takes the domain, `DomainKit`, `DomainKitTesting`, `SyncCore`, `SyncAPI`, `SyncSchema` and
  `SyncTesting`. The manifest is constant data, the package world is closed, and `swift test` runs with
  `--explicit-target-dependency-import-check error`.

## Kotlin (`apps/android`)

| Module | Where | What |
|---|---|---|
| `:domain-kit` | `domain-kit/src/main/kotlin/works/windmill/domain/kit/` | the kit (`Entities`, `Values`, `Rules`, `Reading`, `Plans`, `Actions`, `Drafts`, `Refusals`, `Time`, `Nfc`) |
| `:domain-kit-testing` | `domain-kit-testing/src/main/kotlin/works/windmill/domain/testing/` | `Contract`, `ProductCorpus`, `KitCorpus`, the checks, `withActionContext`; its tests hold `KitLayeringTests` |
| `:gym:domain` | `gym/domain/src/main/kotlin/works/windmill/gym/domain/sync/` | the gym domain, one file per feature plus `GymRules.kt`; tests beside it under `src/test/…/gym/domain/sync/` |

Kotlin has no journal domain; a new product domain is a new `jvm` module, added to `settings.gradle.kts` and to both
layering tests' module tables (below) in the same change. The app composes `ActionRunner(replica, SyncSchema.registry,
zone, context)` with a `works.windmill.domain.kit.ActionContext` (`gym/store/GymActionContext.kt`); tests take
`withActionContext { context -> … }` from `:domain-kit-testing` inside `runBlocking`.

```sh
export JAVA_HOME="$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"   # a fresh worktree has no local.properties; without it the build stops at :sync-engine
cd apps/android
./gradlew :domain-kit:test :gym:domain:test                                                    # the kit's units; every gym vector and harness test
./gradlew :domain-kit-testing:test :domain-kit-testing:corpus :domain-kit-testing:layering :sync-testing:layering   # the kit corpus and both layering tasks
```

The first prints `Gym corpus: 12/12 files, 478 cases, no unclaimed file`; the second `kit corpus: 12/12 files, 475/475
vectors` and `layering: 5 deterministic modules, … compiled classes, 0 findings`. `./gradlew build` (CI,
`.github/workflows/android.yml`) runs all of it, with `ANDROID_SENTRY_DSN` set.

**Tests.** `CorpusTests.kt` is the one vector runner: `paths` lists every file under `packages/api-contract/gym/`,
`run(vector)` switches on `vector.file`, then on the case's `action` or `read`, building each decider from the case's
`input` through `Fields(input)` (`f.ref("id", Proposal)`, `f.instant(…)`, `f.list("entries", RoutineEntry)`) and
`<E>.fromForm(json)`; `corpus.save(WeighIn, GymRefusal, vector, blank, { it.copy(kg = …) }, result, ::refusalForm)`,
`corpus.decision(deleteWeighIn(id), vector, { Json.Null }, ::refusalForm)` and `corpus.read(vector, WeighIn.scope) {
bodyweightForm(Bodyweight(it), input) }` mirror Swift's. `RegistryAndPersonalFactsTests.kt` runs
`RegistryCheck.entity(WeighIn, sample, book)` per entity; `CorpusTests` runs `RuleBookParity.check(book,
"gym/domain/rules.json")` and `RuleBookCheck.check(book, GymRefusal, "gym/domain/values.json", actionFiles)`.
`DomainTestSupport.kt` holds `testMoment`, `row(entity)`, `reader(rows)`, `decide(decider, reader)` and `writing(decision)`
for decider tests with no engine.

**The harness** is the engine's `SteppedEngine` (`:sync-testing`) with a runner over its replica; `GymServerRules`,
the server double, is `:sync-model-server`'s:

```kotlin
@Test fun aHeldDeleteReleases() = runBlocking<Unit> {
    SteppedEngine(SyncSchema.registry, testMoment.now.ms, rules = GymServerRules()).use { a ->
        withActionContext { context ->
            val runner = ActionRunner(a.replica, SyncSchema.registry, FixedZone(0), context)
            val b = a.device()
            committed(runner.run(deleteWeighIn(id)))                 // held: a.undoOffers() names its gesture
            a.advance(Constants.HOLD_MS); a.sync()                   // every device's sender and puller
            assertTrue(b.drawn(WeighIn.scope, WeighIn.type).isEmpty())
        }
    }
}
```

`a.device()`, `a.sync()`, `a.advance(ms)`, `a.leave()`, `a.failNextCommit()`, `a.drawn(scope, type)` and
`a.stored(scope, type)` (engine records; decode with `WeighIn.decode(Fields(record))`), `a.notices("gym")`,
`a.undoOffers()`, `a.server.refuse(code = …)`, `a.senderStep()` and `a.pullerStep()` for one step at a time; `saved`,
`refused`, `failed`, `committed`, `unchanged` read results as in Swift.

**Layering, as the two `layering` tasks read it** (§2.3, §2.4). `KitLayeringTests` (`:domain-kit-testing`, excluded
from its `test` task, run by `:domain-kit-testing:layering`) and `LayeringTests` (`:sync-testing:layering`, a
dependency of `check` and of every Android variant's `preBuild`) both inspect `:gym:domain` among the five
deterministic modules, as compiled and as shipped (`runtimeElements`):

- **Owners.** Every class a class file names must be the module's own package, an allowed dependency's
  (`works/windmill/domain/kit`, `works/windmill/sync/{api,core,schema}`), `kotlin/**` except `io`, `concurrent`,
  `system`, `random`, `time`, `reflect`, `uuid`, `coroutines`, the listed `java/lang` classes (`Object`, `String`,
  `StringBuilder`, `Comparable`, `Enum`, `Iterable`, `Number`, the boxes, `Math`, `Throwable`, `*Exception`, `*Error`)
  or the listed `java/util` collections (`ArrayList`, `LinkedHashMap`, `LinkedHashSet`, `Comparator`, the interfaces;
  not `HashMap`, not `Arrays`, not `java/time`). So no `java.time`, no `kotlin.random`, no coroutine in a domain.
- **Members.** `String.format`, `toUpperCase()`/`toLowerCase()` without a locale (`uppercase()` passes), `Math.pow`
  and `kotlin.math` `pow`/`exp`/`ln`/`log*`, `shuffled`/`random` on collections, `Class.*`, `Throwable.printStackTrace`,
  `Thread.*` but `currentThread`, `Object.wait`/`notify`; any `synchronized` (`monitorenter`); any `native` method.
- **The model.** The 12 projects of §2.1 and no other, each in its directory; `:gym:domain` a `jvm` module with
  exactly the Kotlin JVM plugin set, depending on `:domain-kit`, `:sync-core`, `:sync-api`, `:sync-schema` only, its
  classpaths holding those projects, `kotlin-stdlib` and `org.jetbrains:annotations` and nothing else; no included
  build; test configurations may reach anything but `:app`, `:platform`, `:gym`.

Both tests hold attack fixtures that must stay rejected; a new rule gets a fixture in each.

## Web — no kit yet

<!-- PLACEHOLDER: fill when the web domain kit exists. -->
Web gym and journal (`web/src/products/{gym,journal}/`) hand-write their rules on the browser engine
(`web/src/platform/sync/`) and run none of the shared vectors. When the web kit lands, this section states, like
the two above: where the kit, its test support and each product's domain live; the `npm` commands that run the
kit corpus, the gym corpus and the layering check; what the layering check reads (imports, tokens, dependencies);
and how a web draft, save and harness are spelled. Until then, a web change to a gym or journal rule is not a kit
change, and this skill does not cover it.

## Traps

- **Saving a copy of the draft**, or a second draft of the record: the held draft stays on its old base, so its next
  guarded save refuses `.stale` against this phone's own write. Save the held draft, in place (Kotlin: save the draft
  the editor holds and keep what `writeBack` hands back).
- **A whole type's checks bind every save**: each save validates every field, so a check refusing a value the registry
  admits blocks the record until it is retyped.
- **`creating:` is for minted types.** On a keyed type its `.taken` means only that the key has its record.
- **`RegistryCheck` fails** a client string with no spec (a pasted U+0000 would reach the engine), an enum under a
  `TextSpec`, a `quantum` at any depth without its `NumberSpec`, a spec on a field with no check, a check on a field
  `fields` leaves out, and a whole type written in part.
- **`.failed` read as saved**: no gesture was written and the draft is as it was; say "not saved".
- **`Draft` and `Saved` are not `Sendable`**: no `Action` holds a draft or returns `Saved`; domain code names no actor.
  Kotlin: a draft saves on the thread that opened it, and a run inside a run is a `check` failure.
- **The wrong view**: a cap or position read from `.drawn` lets a held delete go before it lands.
- **Kit traps**: a `current` of another id at `save`; a run inside a run; `open(_:orNew:)` on a minted type; `rebased`
  on an unguarded type; `capacity()` of an uncapped type; a check throwing anything but `Violation`. And `SyncCore`
  declares a `Page` too: a Swift file importing both names journal's `JournalDomain.Page`.
- **A vector claimed on one platform only**: both runners list every file under the product's corpus, so the other
  platform's test fails on the unclaimed file; land the runner for every implementation that carries the product.

**Depth:** §2 layering · §3 entities, `RegistryCheck`'s steps · §4 specs, `Valid` · §5 time · §6 the book · §7 reads ·
§8 plans · §9 actions · §10 drafts, `SaveDraft`'s steps · §11 `Remove`, `Move`, Undo · §12 refusals · §14–§15 tests.
