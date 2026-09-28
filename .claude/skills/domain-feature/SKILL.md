---
name: domain-feature
description: Build or change a gym or journal feature's domain logic on iOS, on the Windmill domain kit in Swift (apps/ios/Domain, GymDomain or JournalDomain) — entities, value specs, rules and the product refusal, reads, actions, drafts and their one save, keyed records saved whole, moves, held deletes and Undo, Coach executors, and their harness tests and shared vectors. Pure logic, no UI. Use when asked to add or change a gym or journal feature's entities, rules, actions, drafts or saves on iOS.
---

# A feature domain on the domain kit

This skill carries a feature's common path end to end; the kit's spec, `docs/foundation/domain-kit.md` (§n below), and
the engine's, `docs/foundation/engine.md` (engine §n), are normative for the rest. The reference shapes are gym
**Notes** (minted, ordered, capped, guarded) and gym **Bodyweight** (keyed by day, one fact saved whole):
`apps/ios/Domain/Sources/GymDomain/{Notes,Bodyweight,GymRules}.swift`, tests in `apps/ios/Domain/Tests/GymDomainTests/`,
vectors in `packages/api-contract/gym/`.

**Not** for screens, view models or copy (the `Windmill<P>` UI modules), the engine or a registry (`apps/ios/Sync`,
`packages/api-contract/sync`), or roadmap, which is web only.

## Non-negotiables

`LayeringTests`, part of every `swift test` of `apps/ios/Domain`, fails on each:

- A product domain imports only `DomainKit`, `SyncCore`, `SyncAPI` and `SyncSchema` (a file naming `.stored` or
  `.drawn` imports `SyncAPI`, which declares `ViewMode`), and its settings are exactly
  `[.enableUpcomingFeature("MemberImportVisibility")]`, language mode 6. No `Foundation`, UI framework, Combine name,
  import attribute, engine runtime, test support or other product's domain.
- Source rules reject tokens such as `print`, `Task`, `async`, `await`, `MainActor`, `random`, `@unchecked`, `#if` and
  identifiers beginning `_`. Time comes only from a `Moment`; ids only from `IDSource.mint`, `runner.mint`, a natural
  key or the action's input.
- `<P>DomainTests` takes the domain, `DomainKit`, `DomainKitTesting`, `SyncCore`, `SyncAPI`, `SyncSchema` and
  `SyncTesting`. `JournalDomain` has its layering row and no target yet: add its library, target and test target to
  `apps/ios/Domain/Package.swift` exactly as `GymDomain`'s are. Before handing back, run everything:

```sh
cd apps/ios/Domain
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --explicit-target-dependency-import-check error
```

## Build order

### 1. Read the registry, the binding and the canon

Read the type in `packages/api-contract/sync/<product>.registry.json`, its binding in engine Appendix A.2 (gym) or A.3
(journal), and the feature's brief in `docs/design/<product>/briefs/`. `SyncSchema` generates the names: `Gym.scope`,
`Gym.Types.weighin`, product refusal codes `Gym.Codes.badInstant`, defaults `Gym.Defaults.Prefs.units`.

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

A type or field the registry lacks is an engine change first (registry, engine Appendix A, `swift run SyncSchemaGen` in
`apps/ios/Sync`), never a domain workaround.

### 2. The entity, its checks and specs (§3, §4)

A `struct` of values. `init(_ r: Fields) throws(DecodeError)` is lenient (a default or an optional for what may be
absent, `r.text(f)` for a `text` field, any id the registry admits) and decodes what `fields` builds. `fields` lists
every client field it writes, a nil as `.null` (`.of(x)`), never the order field or a serial. `checks` run in the order
violations are reported: a `Check("f")` normalises its own field only; a `.key` check is a rule on the natural key,
reading only the id and the moment, on every write. Specs are data named by their registry path. The keyed whole shape:

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

`Valid` gives a `Timestamped` field the moment's now, so any write of it, the sheet's or an action's, records the
commit's now. `apply` has plain and optional overloads, so a result assigned to an optional needs `as Double`. No `trim`
on a field saved while the person may still type. A nested value is a `ValueObject` whose `validated(at:)` applies its
specs, a list of them a `CountSpec`. A LOCAL rule written as code throws `.custom(_:)`, declared `.local(name, subject:)`
with a `backstop:` of the product code the server refuses the same thing with (`bad-instant`: past its UTC tomorrow).

### 3. The product refusal and the rule book (§6.3, §12)

One refusal type per product (gym's `GymRefusal` in `GymRules.swift`; journal declares its own once, on its pattern):
`init(_ r: Refused)` is one total `switch (r.code, r.subject, r.cap)`, an unexpected code mapping to the one case whose
`isGeneric` is true. Every case keeps the path: `.predicted` means nothing was written, `.notice` that a write committed
on this phone was refused by the server (`DomainNotice.values(of:)` holds its words). A feature's code is one line:
`case (Gym.Codes.badInstant, let s?, _) where s.type == WeighIn.type: self = .future(s, r.path)`.

The book adds each entity's standard rules: `<type>.gone` for a type with life, `.taken` for a minted type, `.stale`
for a guarded save, `.cap` for a capped type, `.size` for a type with a `text` field. Declare only the feature's own:
its specs, its code rules, and a SERVER-DECIDED rule for every other code the server refuses its writes with,
`.serverDecided("routine.movement", codes: [Gym.Codes.unknownExercise], subject: Gym.Types.routine)`.

**What a feature adds to the product's shared files**, and nothing else: a case per new code and its mapping line in
`GymRefusal`; that case's JSON form in `GymRefusal.form` (`GymRulesTests.swift`) and in the refusal forms of
`packages/api-contract/gym/domain/README.md`; its entities to `GymRules.book`'s `entities:` and its rules to `rules:`,
then `rules.json` (`RuleBookParity` prints the book's JSON on a mismatch); its spec and entity cases in `values.json`.
Its actions, reads and their vectors live in its own files (step 9).

### 4. Reads (§7)

A `Reader` exists only inside `load` and `runner.read(scope) { … }`; `repository(E.self)` gives `find(_:in:)`,
`all(in:)`, `children(of:via:in:)` and `capacity()`. The view is always named: **`.stored` decides** (caps, positions,
anchors, stale checks) and **`.drawn` draws** (what the person sees and acts on); they differ only in records a held
delete names. A derived read is a pure value over decoded entities (and a moment, when it depends on time) shared by the
UI, actions and Coach; one asserting absence ("no weigh-ins yet") takes `firstPullComplete`. `Bodyweight.init(_ read:
Reader)` reads both views, the flag and the moment, so `try runner.read(WeighIn.scope, Bodyweight.init)` serves all.

### 5. Actions (§8, §9)

Name the standard deciders with type aliases: `SaveWeighIn = SaveDraft<WeighIn, GymRefusal>`, `DeleteWeighIn` over
`Remove`, `MoveNote` over `Move`. A custom action is a `struct` conforming to `Action`, its stored properties its input:

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

### 9. Tests (§14, §15)

**The harness** runs the real engine, stepped on the test's thread, over a model server shared by every phone:

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

**Staging.** A commit stays on its phone until a `sync()`, which moves every phone. For one phone's write to land first,
commit it and `sync()` before the other commits; when both commit before a `sync()`, the phone created first sends
first, and the other's write returns as a notice if the server refuses it. Per action, cover the predicted outcome, the
refusal as a notice from a race, a hold with its Undo and release, stale and Keep mine, gone, and each prediction
against the server holding the same state.

**Checks and vectors**, which every implementation reproduces. A feature's test file runs
`RegistryCheck.entity(E.self, sample:book:registry:)` per entity (its sample setting every field) and its own vectors;
`GymRulesTests.swift` runs `RuleBookCheck`, `RuleBookParity` and `values.json`. Actions and draft saves go in
`packages/api-contract/gym/domain/<feature>-actions.json`: `{name, input: {action, input, records: {drawn, stored?},
ids, now, offsetSeconds}, expect: {decision}}`, a record an engine row (`{"t", "id", "seq", "life": ["alive", stamp],
"f": {"kg": [82.4, stamp]}}`). A `switch` builds each named action:

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

## Traps

- **Saving a copy of the draft**, or a second draft of the record: the held draft stays on its old base, so its next
  guarded save refuses `.stale` against this phone's own write. Save the held draft, in place.
- **A whole type's checks bind every save**: each save validates every field, so a check refusing a value the registry
  admits blocks the record until it is retyped.
- **`creating:` is for minted types.** On a keyed type its `.taken` means only that the key has its record.
- **`RegistryCheck` fails** a client string with no spec (a pasted U+0000 would reach the engine), an enum under a
  `TextSpec`, a `quantum` at any depth without its `NumberSpec`, a spec on a field with no check, a check on a field
  `fields` leaves out, and a whole type written in part.
- **`.failed` read as saved**: no gesture was written and the draft is as it was; say "not saved".
- **`Draft` and `Saved` are not `Sendable`**: no `Action` holds a draft or returns `Saved`; domain code names no actor.
- **The wrong view**: a cap or position read from `.drawn` lets a held delete go before it lands.
- **Kit traps**: a `current` of another id at `save`; a run inside a run; `open(_:orNew:)` on a minted type; `rebased`
  on an unguarded type; `capacity()` of an uncapped type; a check throwing anything but `Violation`. And `SyncCore`
  declares a `Page` too: a file importing both names journal's `JournalDomain.Page`.

**Depth:** §2 layering · §3 entities, `RegistryCheck`'s steps · §4 specs, `Valid` · §5 time · §6 the book · §7 reads ·
§8 plans · §9 actions · §10 drafts, `SaveDraft`'s steps · §11 `Remove`, `Move`, Undo · §12 refusals · §14–§15 tests.
