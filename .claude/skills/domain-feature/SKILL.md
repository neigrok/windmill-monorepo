---
name: domain-feature
description: Build or change a gym or journal feature's domain logic on iOS, on the Windmill domain kit in Swift (apps/ios/Domain, GymDomain or JournalDomain) — entities, value specs, rules and the product refusal, reads, actions, drafts and their one save, moves, held deletes and Undo, Coach executors, and their harness tests and shared vectors. Pure logic, no UI. Use when asked to add or change a gym or journal feature's entities, rules, actions, drafts or saves on iOS.
---

# A feature domain on the domain kit

The kit's spec, `docs/foundation/domain-kit.md` (§n below), is normative; the engine's is
`docs/foundation/engine.md` (engine §n). This skill gives the build order, the checks that fail you and
the traps, and restates neither. Copy the shape of the reference feature, gym Notes:
`apps/ios/Domain/Sources/GymDomain/{Notes,GymRules}.swift`, its tests
`apps/ios/Domain/Tests/GymDomainTests/{NotesTests,GymRulesTests}.swift`, and its vectors
`packages/api-contract/gym/domain/{rules,values,actions}.json` with the `README.md` stating their forms.

**Use it** for any entity, spec, rule, action, save, reorder, delete or Coach executor in `GymDomain` or
`JournalDomain`. **Not** for screens, view models or copy (the `Windmill<P>` UI modules, §2.1), the
engine or a registry (`apps/ios/Sync`, `packages/api-contract/sync`), or roadmap, which is web only.

## Non-negotiables

`LayeringTests`, part of every `swift test` of `apps/ios/Domain`, fails on each:

- A product domain imports, and depends on, only `DomainKit`, `SyncCore`, `SyncAPI` and `SyncSchema`
  (§2.1): no `Foundation`, UI framework, Combine name or import attribute; no engine runtime, test
  support or other product's domain.
- Its settings are exactly `[.enableUpcomingFeature("MemberImportVisibility")]`, language mode 6 (§2.4).
- §2.3's source rules reject tokens such as `print`, `Task`, `async`, `await`, `MainActor`, `random`,
  `@unchecked`, `#if` and identifiers beginning `_`. Time comes only from a `Moment`; ids only from
  `IDSource.mint`, `runner.mint`, a natural key or the action's input (INV-11).
- A test target never depends on a platform or UI module; `<P>DomainTests` takes the domain, the kit,
  `DomainKitTesting`, `SyncCore`, `SyncAPI`, `SyncSchema` and `SyncTesting` (§2.1).

`JournalDomain` has its layering row and no target yet: add its library, target and test target to
`apps/ios/Domain/Package.swift` exactly as `GymDomain`'s are. Before handing back, run everything:

```sh
cd apps/ios/Domain
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --explicit-target-dependency-import-check error
```

## Build order

### 1. Read what the registry already declares

Read the type in `packages/api-contract/sync/<product>.registry.json` and its binding in engine Appendix
A.2 (gym) or A.3 (journal); `SyncSchema` generates its names (`Gym.Types.note`, `Gym.scope`).

| The registry or binding says | The entity declares |
|---|---|
| `identity: minted` | ids from `runner.mint` as a draft opens, or from `IDSource.mint` or the call in an action |
| `identity: keyed` or `singleton` | its natural id (`ID(day)` for a local-date key); drafts open with `open(_:orNew:)` |
| `life: true`, and the binding lets a client delete it | `Removable`; `heldRemoval = true` iff Appendix A lists that delete as held |
| a client `lww` field with a `fracKey` domain | `Ordered`, naming it `orderField` |
| "Editor save guards the fields it writes" | `Draftable` with `savesGuarded = true`, and so no `text` field |
| the `writer: client` fields it writes, with bounds, enum, `quantum` | `fields`, and a spec no looser than the registry |

A type or field the registry lacks is an engine change first (the registry file, engine Appendix A, then
`swift run SyncSchemaGen` in `apps/ios/Sync`), never a domain workaround.

### 2. The entity and its specs (§3, §4)

A `struct` of values conforming to what step 1 found (`Note: Draftable, Removable, Ordered`). Its
`init(_ r: Fields) throws(DecodeError)` is lenient (a default for what may be absent, `r.text(f)` for a
`text` field) and decodes what `fields` builds. `fields` lists every client-written field it writes, a
nil as `.null`, never the order field or a serial. `checks` holds a `Check` per written field with a
spec, in the order violations are reported, each normalising its own field only. Specs are data, each
named by its registry path and listed as the feature's rules:

```swift
public static let checks: [Check<Note>] = [
  Check("title") { n, _ in n.title = try NoteRules.title.apply(n.title, at: "title") },
  Check("body") { n, _ in n.body = try NoteRules.body.apply(n.body, at: "body") },
]

public enum NoteRules {
  public static let title = TextSpec("note.title", unit: .chars, min: 1, max: 60, trim: true, nfc: true)
  public static let body = TextSpec("note.body", unit: .bytes, min: 0, max: 500, trim: true, nfc: true)
  static let rules: [Rule] = [.local(title), .local(body)]
}
```

A nested value is a `ValueObject` whose `validated(at:)` applies its specs, and a list of them takes a
`CountSpec` (Appendix A). A LOCAL rule written as code throws a `Violation` with reason `.custom(_:)`
and is declared `.local(name, subject:)`. A field saved while the person may still type takes no `trim`.

### 3. The product refusal and the rule book (§6.3, §12)

One refusal type per product, shared by its features: gym's is `GymRefusal`; journal declares its own
once (Appendix C). `init(_ r: Refused)` is one total mapping of the code, subject, path and, for `cap`,
the detail; an unexpected code maps to the one case whose `isGeneric` is true:

```swift
public init(_ r: Refused) {
  switch (r.code, r.subject, r.cap) {
  case (.stale, let s?, _): self = .stale(s, r.path)
  case (.unknownRecord, let s?, _), (.recordDead, let s?, _): self = .gone(s, r.path)
  case (.idTaken, let s?, _), (.idSpent, let s?, _): self = .taken(s, r.path)
  case (.cap, _, let c?): self = .full(type: c.type, cap: c.cap, r.path)
  default: self = .other(r)
  }
}
```

Every case keeps the path: `.predicted` means nothing was written; `.notice` means a write committed on
this phone was refused by the server, and `DomainNotice.values(of:)` holds its words. Add the entity to
the book's `entities:` and its rules to `rules:` (`GymRules.book`). The book adds each entity's standard
rules: `<type>.gone` for a type with life, `.taken` for a minted type, `.stale` for a guarded save,
`.cap` for a capped type, `.size` for a type with a `text` field. Declare only the feature's own: its
specs and code rules, and a SERVER-DECIDED rule for every other code the server refuses its writes with,
each code with a case of its own in the refusal. `RefusalCode` names only the engine's codes, so a
product's (engine Appendix A, "Codes") is spelled out:
`.serverDecided("routine.movement", codes: [RefusalCode("unknown-exercise")], subject: Routine.type)`.

### 4. Reads and positions (§7)

A `Reader` exists only inside `load` and inside `runner.read(scope) { … }`; its `repository(E.self)`
gives `find(_:in:)`, `all(in:)`, `children(of:via:in:)` and `capacity()`, as in
`try runner.read(Note.scope) { try $0.repository(Note.self).capacity() }`. The view is always named:
**`.stored` decides** (caps, positions, anchors, stale checks) and **`.drawn` draws** (what the person
sees and acts on); they differ only in records a held delete names. A derived read is a pure static
function over decoded entities, and a moment when it depends on time, so the UI, actions and Coach share
it (`Note.position(of:stored:)`). A read that asserts absence also takes `firstPullComplete`.

### 5. Actions (§8, §9)

Name the standard deciders with type aliases (`SaveNote = SaveDraft<Note, GymRefusal>`, `DeleteNote`
over `Remove`, `MoveNote` over `Move`). A custom action is a `struct` conforming to `Action`, its stored
properties its input, shaped as `SaveNoteCall` is (step 8):

- `load(_ read: Reader)` reads through the reader only, `read.moment` included; when one read depends on
  another, load calls a pure domain function between them.
- `decide(_:ids:)` is pure: it validates with `Valid(value, at: moment)` or `Valid(value, fields:at:)`,
  predicts what it can from `stored`, and returns `.write(plan, result)`, `.unchanged(result)` or
  `.refuse(refusal)`. A `Violation` it throws becomes `.refuse` in `decision(_:ids:)`, the one channel
  the runner and every composer read.
- A `Plan` takes only `Valid` values: `create`, `create(_:fields:)` (keyed or singleton),
  `insert(_:below:)` (ordered), `update(_:fields:)` naming only the fields its caller set, `remove`,
  `move`, `guardRead`, `device`. Breaking §8.3 (two operations on one record, another scope, a held
  removal beside any write but device rows) is a `PlanError`, a programming fault.
- `Result` is `Sendable` and the action's own. `runner.run` returns `.committed(result, receipt)` (on
  this phone, not yet accepted by the account), `.unchanged(result)` or `.refused(refusal)`.

### 6. Drafts and their one save (§10)

An editor holds one `Draft` of one record, opened as
`Draft(new: Note(id: runner.mint(Note.self)), placed: .bottom)` for a new ordered record (`Draft(new:)`
unordered), `runner.open(id)` for one the person sees (nil when `drawn` lacks it), or
`runner.open(ID(day), orNew: Page(id: ID(day)))` for a keyed or singleton one. Edits go to
`draft.current`; a prefill is an edit. `runner.save(&draft, SaveNote.self)` is its only door:
synchronous and never throwing, it validates and writes the touched fields (a new minted draft: every
field), writes nothing when nothing changed, and leaves the draft holding the values as stored. Read it
with a `switch` and no `default`:

```swift
switch runner.save(&draft, SaveNote.self) {
case .saved: close()
case .refused(let refusal): show(refusal)
case .failed(let error): showNotSaved(error)
}
```

`.stale` (a guarded type) offers *Keep mine*, `draft.rebased(onto:)` the drawn record, so the next save
writes only this phone's touched fields, and *Take theirs*, `Draft(opening:)` of it. `.gone` abandons
the draft, or starts `Draft(new:)` and sets its values (§10.3).

### 7. Order, held deletes and Undo (§7.5, §8.1, §11)

A new member's placement resolves against `stored`: `.bottom` goes below the last stored member, a held
one included. A move names the member it lands below, `nil` for the top, and writes the moved key alone;
a drop in place is `.unchanged` and writes nothing, so it never reverts another phone's reorder.
`Remove` of a record `drawn` lacks is `.unchanged`. Of a `heldRemoval` type it hides the record from
`drawn` at once, while `stored` keeps it, its cap slot and its place until the hold releases after
`Constants.holdMs`; `runner.undo(receipt.gestureId)` is true only while it lasts.

### 8. Coach executors (§9.3, §11)

A Coach call on the phone composes `SaveDraft(creating:)` (`creating:placed:` for an ordered type): the
call's record under the id its turn gave it, every field touched. `SaveNoteCall` is the pattern:

```swift
public func decide(_ loaded: Loaded, ids: IDSource) -> Decision<ID<Note>, GymRefusal> {
  switch save.decision(loaded.save, ids: ids) {
  case .refuse(.taken), .unchanged: return .unchanged(note.id)
  case .refuse(let refusal): return .refuse(refusal)
  case .write(let plan, let saved):
    if let same = loaded.stored.first(where: { $0.fields == saved.values }) { return .unchanged(same.id) }
    if let full = loaded.slots.refusal(growing: 1, subject: note.id.ref) { return .refuse(GymRefusal(full)) }
    return .write(plan, note.id)
  }
}
```

`.taken` is done: a replay finds its own record, stored or inside its delete window; once that delete
has landed, the replay returns as a `.taken` notice the UI dismisses undrawn. Reading `decision`, it
gets a thrown violation as `.refuse` too, as a turn composing it does (`NotesTests.Recording`). A
refusal at commit records nothing, so it hears the cap in decide, by the growth rule.

### 9. Tests (§14, §15.3)

**Harness tests**, as in `NotesTests.swift`, run the real engine in step mode and a model server:
`let a = Harness(registry: SyncSchema.registry, start: Instant(ms: 1_800_000_000_000))`, and
`let b = a.device()` for a second phone of the account. `a.sync()` runs every phone to quiescence,
`a.advance(ms: Constants.holdMs)` releases holds, `failNextCommit()` makes the next save `.failed`;
`drawn`, `stored`, `notices(GymRefusal.self)` and `undoOffers()` read a phone, and `saved`, `refused`,
`failed`, `committed`, `unchanged` read results. A product rule the model server enforces takes a
`ServerRules` double (`Harness(…, rules:)`); `a.server.refuse(next:code:detail:)` scripts a refusal it
does not model. Per action, cover the predicted outcome; the same refusal as a notice when two phones
race (both save, then `sync`); a hold, its Undo and its release; stale and Keep mine; gone; and each
product prediction against the server holding the same state (INV-6).

**Checks and vectors**, as in `GymRulesTests.swift`; every implementation reproduces the vectors
(INV-13). `RegistryCheck.entity(_:sample:book:registry:)` runs per entity, its sample setting every
field, and `RegistryCheck.command` per `ServerCommand`. `RuleBookCheck.check(_:refusal:vectors:)` needs
every SERVER-DECIDED code mapped to a non-generic case on both paths, and in `values.json` a spec case
per spec and an entity case whose `violation` names each LOCAL rule on an entity. `RuleBookParity` holds
the book to `rules.json` and prints the book's JSON on a mismatch. `ProductCorpus(book)` runs
`value(_:)` per `values.json` case and `decision(of:_:result:refusal:)` per `actions.json` case, the
test's `switch` building each named action from its `input`; `README.md` states each action's input and
result, and the refusal's form.

## Traps

- **Saving a copy of the draft**, or a second draft of the record: the held draft stays on its old base,
  so its next guarded save refuses `.stale` against this phone's own write. Off the main actor a copy's
  save does not compile in a UI module; on it, it does. Save the held draft, in place.
- **`creating:` is for minted types.** It refuses `id-taken` whenever the id is drawn or stored, which
  for a minted type means a replay, done. On a keyed type nothing traps, but the same refusal means only
  that the key already has its record, and the book declares no `.taken` rule for it.
- **A client-written string with no spec**: `RegistryCheck` fails it (step 10), since a pasted U+0000
  would reach the engine; likewise an enum under a `TextSpec`, a `quantum` field without its
  `NumberSpec`, a spec on a field with no check, a check on a field `fields` leaves out.
- **`.failed` read as saved**: `.failed` means no gesture was written and the draft is as it was. Say
  "not saved", keep the words; the next save retries. A `switch` missing `.failed` does not compile.
- **UI code on the main actor**: `Draft` and `Saved` are not `Sendable`, so an `Action` cannot hold a
  draft or return `Saved`, and UI code, main-actor by default with warnings as errors, cannot save a
  draft from a task or queue. Domain code names no actor.
- **The wrong view**: a missing view does not compile, a wrong one does; a cap or position read from
  `.drawn` lets a held delete go before it lands.
- **Journal's `Page`**: `SyncCore` declares a `Page` too (a pull page), so outside `JournalDomain` a
  file importing both, tests included, names the entity `JournalDomain.Page`.
- **Kit traps**: a `current` of another id at `save`, or a record of another id at `rebased(onto:)`; a
  run inside a run; `open(_:orNew:)` on a minted type; `rebased` on an unguarded type; `capacity()` of
  an uncapped type; a check throwing anything but `Violation`.

## Where to look

Code: the Notes files above. Depth: §2 layering · §3 entities, `RegistryCheck`'s steps · §4 specs,
`Valid` · §5 time · §6 rules, the book · §7 reads · §8 plans, plan rules, commands · §9 actions,
composition · §10 drafts, `SaveDraft`'s steps · §11 `Remove`, `Move`, Undo · §12 refusals, notices ·
§14–§15 tests, vectors · Appendix A (value objects), B (notes), C (a page saved as it is typed).
