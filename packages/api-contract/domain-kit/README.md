# Domain kit corpus

The shared vectors of the domain kit ([domain-kit.md](../../../docs/foundation/domain-kit.md) §15). Every
implementation of the kit (Swift `DomainKit`, Kotlin `:domain-kit`, web `platform/domain-kit`) reproduces each `expect` byte for byte.
A runner written from this README alone needs no other file than `../sync/probe.registry.json`.

## Conventions

- A `.json` file is an array of vectors `{name, input, expect}`. Names are unique within a file and say what
  the vector tests. A file without a handler fails the run.
- Runners compare `expect` by JCS (RFC 8785): key presence matters, key order and number spelling do not.
- `{error: true}` expects a failure: a thrown error (`PlanError`, a `LocalDay` that does not parse) or a
  trap (a `NumberSpec` with both `integer` and `quantum`). `{trap: true}` is a trap in a script step.
- **Registry.** Every vector reads the probe registry, `../sync/probe.registry.json`. Its product is
  `probe`; its scopes here are `self/probe`, `tree/b_00000001` and `self/overlay/b_00000001`.
- **Records** are engine §9.1 rows (`{t, id, seq, life?, born?, f?, x?, v?, rc?, ru?}`, registers
  `[value, stamp]`, texts `{text, rev, merged}`), listed per view: `drawn` and `stored`. A row becomes
  the engine's `Record` by the registry: `values` are its registers' values, `texts` its texts,
  `serials` its `v`, and it is visible by engine §7.6 (a singleton always; a type with life while
  alive; otherwise a `visibleWhen` field holding neither null nor `""`, or any field set). A reader's
  `drawn(t)` and `stored(t)` list the visible records of that view; `drawn(t, id)` and `stored(t, id)`
  return the row of that view, visible or not, or nothing.
- **Spent ids** are engine §2.5 `SpentId`s of the vector's scope, `{t, id, born}`: what the device keeps of a derived
  record deleted elsewhere once its row is gone (engine §7.5). An input that names none (`spent` absent) holds none. A
  reader's `spentBorn(t, id)` returns the born of the scope's spent id of that record, or nothing.
- **Defaults.** `scope` is `self/probe`, `now` is `1800000000000` (2027-01-15T08:00:00Z) and
  `offsetSeconds` is `0` unless a vector gives them. The moment is `Moment(now, FixedZone(offsetSeconds))`.
- **Order.** Ids compare by the UTF-8 bytes of their JCS. An order key absent or null sorts as `""`.
- **Paths.** A path is dotted text: `Path("entries") + 1 + "reps"` is `entries.1.reps`. A value vector
  applies its spec at `at`, by default the last dotted component of the spec's `path`.

## JSON forms

| Value | Form |
|---|---|
| text spec | `{path, kind: "text", unit: "chars"\|"bytes", min, max, trim, nfc}` |
| number spec | `{path, kind: "number", min, max, integer, quantum?}` (`quantum` absent or null: none) |
| choice spec | `{path, kind: "choice", values}` |
| count spec | `{path, kind: "count", min, max}` |
| violation | `{rule, path, reason, …}`, the reason's members as keys: `blank`, `nul`, `notANumber`, `notInteger`, `notOneOf` carry none; `tooShort` `{min, unit}`; `tooLong` `{max, unit, measured}`; `below` `{min}`; `above` `{max}`; `tooFew` `{min}`; `tooMany` `{max}`; `custom` `{custom: <text>}` |
| refused | `{code, subject: {t, id} \| null, detail: <json> \| null, path: "predicted" \| "notice"}` |
| refusal | the probe refusal: `{violation: <violation>}` or `{refused: <refused>}` |
| decision | `{write: {gesture, result}}`, `{unchanged: {result}}` or `{refuse: <refusal>}` |
| outcome | `{committed: {result, receipt}}`, `{unchanged: {result}}` or `{refused: <refusal>}` |
| receipt | `{gestureId, localIds, retired, releaseAt}` (`releaseAt` null when not held) |
| gesture | `{changes, atomic, hold, guards, retire, cmd, predict, local}`, all eight keys always |
| change | `{op, t, id}`, plus `f` (values) and `x` (texts, `{field: {text, from}}`) when non-empty, `present` (`true`, `false` or `null`) on a `put` only, `anchor` (`{field, below}`) when set. `op` is `create`, `update`, `delete`, `put`, `write` or `move`; a create's id is the given id |
| guard | `{t, id, field}`; `guards` sorted by type, id, then field bytes |
| retire entry | `{t, id}`; sorted by type, then id |
| cmd | `{name, args}` or null |
| device write | `{key, value}` (`value` null deletes) |
| saved | `{values, exists}`: the fields the draft takes, as stored |
| draft | `{id, base, current, isNew, placement}`: `base` and `current` as the entity's `fields`; placement null, `"top"`, `"bottom"` or `{below: <id>}` |
| subject | `{t, id}` or null |
| notice | `{id, scope, code, detail?, content: {d: [<delta>], cmd?, dependents?: [<content>]}, at}` (the engine corpus's form) |

A `Void` result is `null`.

## The probe declarations

Each runner declares these entities, commands and refusal over the probe registry. They are test code,
not kit content. `f` in an input lists field values; a field it leaves out takes its default by decoding.

| Entity | Type, scope | Kit protocols | Fields (default) | Checks, in order |
|---|---|---|---|---|
| `Card` | `card`, `self/probe` | `Draftable` (`savesGuarded` true), `Removable` (`heldRemoval` true), `Ordered` (`ord`) | `title` (`""`), `body` (`""`), `size` (null), `claim` (null), `tier` (`"draft"`) | `title`: text `card.title` chars 1–12 trim nfc; `body`: text `card.body` bytes 0–24 trim nfc; `size`: number `card.size` −500…500 quantum 0.01; `claim`: text `card.claim` chars 0–12 trim nfc; `tier`: choice `card.tier` `draft`, `review`, `done`, `dropped` |
| `Day` | `day`, `self/probe` | `Draftable` (`savesGuarded` false), `Removable` (`heldRemoval` true) | `score` (null) | key check `day.notFuture`: the id's local day after the moment's `today` → `{rule: "day.notFuture", path: "id", reason: "custom", custom: "future"}`; `score`: number `day.score` 0–10 integer |
| `Fact` | `fact`, `self/probe` | `Draftable` (`savesGuarded` false), `Removable` (`heldRemoval` true), `Timestamped` (`at`) | `value` (null), `at` (null, epoch ms) | `value`: number `fact.value` 0–500 quantum 0.1; then `at` takes the moment's `now` when named |
| `Mark` | `mark`, dynamic overlay | `Draftable` (`savesGuarded` false) | `done` (null), `memo` (`""`, a text field) | `memo`: text `mark.memo` bytes 0–40, no trim, no nfc |
| `Meta` | `meta`, dynamic tree | `Draftable` (`savesGuarded` false) | `title` (`""`) | `title`: text `meta.title` chars 0–12 trim nfc |
| `Lap` | `lap`, `self/probe` | `Writable`, `Removable` (`heldRemoval` false) | `runId` (`""`), `at` (null), `weight` (null) | `weight`: number `lap.weight` −500…500 quantum 0.01 |
| `Run` | `run`, `self/probe` | `Writable`, `Removable` (`heldRemoval` false) | `startedAt` (null), `label` (null) | `label`: text `run.label` chars 0–12 trim nfc |
| `Link` | `link`, dynamic tree | `Writable`, `Removable` (`heldRemoval` true) | `strength` (null) | `strength`: number `link.strength` 0–9 integer |
| `Tag` | `tag`, dynamic tree | `Writable`, `Removable` (`heldRemoval` false) | `label` (`""`) | `label`: text `tag.label` chars 0–24, no trim or NFC |

Every entity's `fields` holds every field of its row above, a nil value as `null`; `Mark.memo` decodes by
`Fields.text`. They are vector declarations, not a product's: a card writes `claim: null` and a blank `title`, which the
registry's domains refuse at a server. Commands: `ProbeStart` (`probe.start`, specs: text `probe.start.label` chars 0–12
trim nfc), `ProbeEnd` (`probe.end`, no specs) and `ProbeCopy` (`probe.copy`, no specs); a vector gives a command as
`{name, args}`. `ProbeRefusal` maps a `Violation` and a `Refused` to the refusal forms above.

Translation writes minted, derived, keyed and singleton types. Derived operations keep the supplied
ID. A `—` cell of §8.2's table (a removal of a type without life, a move of a singleton), a revival of a
non-revivable type and a type the registry does not hold fail translation like a §8.3 rule: `{error: true}`.
A minted or derived create leaves a nil `time` field out of `f`, so the engine
stamps it with the commit's now; the save of such a create takes that now as the field's stored value.

Beyond its checks, `Valid` refuses a U+0000 in a field it names that no check caught, with the rule `<type>.<field>`,
and `Plan(running:)` one in an argument no spec covers, with the rule `<command>.<argument>`: the engine refuses it in
every string it sends. The path is the string's, through objects by key and arrays by index.

## Files

### `value/text.json`, `value/number.json`, `value/choice.json`

| `input` | `expect` |
|---|---|
| `{spec, value, at?}` (`value` null: the optional overload) | `{value}` or `{violation}` |
| `{spec, measure: <text>}` (text only) | `{measured}` |
| `{isBlank: <text>}` (text only) | `{isBlank}` |
| `{spec, value, as: "int", at?}` (number only: the `Int` overload) | `{value}` or `{violation}` |

A number `value` that is not finite is written `"NaN"`, `"Infinity"` or `"-Infinity"`. A number spec with
both `integer` and `quantum` expects `{error: true}`.

### `value/count.json`

`{spec, items, itemSpec?, at?}` → `{items}` or `{violation}`. Each item is a value object holding one raw
value (a string or a number); its `validated(at: p)` applies `itemSpec` to the value at `p`, and returns the
normalised value. So item `i` validates at `at + i`.

### `time/day.json`

| `input` | `expect` |
|---|---|
| `{op: "fromInstant", ms, offsetSeconds}` | `{day}` |
| `{op: "parse", text}` | `{day}` (its `text`) or `{error: true}` |
| `{op: "adding", day, days}` | `{day}` |
| `{op: "daysUntil", day, other}` | `{days}` |
| `{op: "weekday", day}` | `{weekday}` |

### `order/list.json`

`{t, records: {drawn, stored}, …}`, one of:

| also in `input` | `expect` |
|---|---|
| `view: "drawn" \| "stored"` | `{ids}`: `Repository.all(in:)` |
| `children: {of, via, view}` | `{ids}`: `Repository.children(of:via:in:)` |
| `placement: "top" \| "bottom" \| {below}` | `{anchor}`: `Repository.anchor` (an id or null) |
| `move: {id, below}` | `{decision}`: the standard `Move` action's `load` and `decide` |
| `remove: {id}` | `{decision}`: the standard `Remove` action's `load` and `decide` |

### `capacity/count.json`

`{t, records: {drawn, stored}}` → `{used, cap, full}`.

### `plan/translate.json`

`{scope?, now?, offsetSeconds?, cmd?, predict?, plan}` → `{gesture}`, `{violation}` or `{error: true}`.
A vector with `cmd` builds `Plan(running:predicting:)` first (`predict`: `[{op: "create" | "update" | "write", t, id,
f, scope?}]`, `scope` naming a scope other than the plan's), then applies each operation of `plan` in order:

| Operation | Plan call |
|---|---|
| `{op: "create", t, id, f, fields?, checked?}` | `create(valid)`, or `create(valid, fields:)` when `fields` is given |
| `{op: "insert", t, id, f, below, checked?}` | `insert(valid, below:)` |
| `{op: "update", t, id, f, fields?, base?, guarded?, checked?}` | `update(valid, fields:, from:, guarded:)`; `base` is the base entity's `f` |
| `{op: "revive", t, id, f?, fields, base?, guarded?, checked?}` | `revive(valid, fields:, from:, guarded:)` |
| `{op: "remove", t, id}` | `remove(id)` |
| `{op: "move", t, id, below}` | `move(id, below:)` |
| `{op: "guardRead", t, id, fields}` | `guardRead(id, fields:)` |
| `{op: "device", key, value}` | `device(key, value)` |

`valid` is `Valid(entity, fields: checked, at: moment)`, where the entity decodes from `f` with the
operation's id and `checked` defaults to `fields`, then to every field. A violation ends the vector with it.
Translation then runs for `scope`. A translation vector may replace the probe tag's `label` declaration
with `tagField` to prove that revival rejects const, time and text edits on a revivable type, and the probe
link's fields with `linkFields` to prove that a keyed type with life and no field is created by its presence
alone. A gesture whose predictions name another scope carries them in `scopedPredict` (`[{scope, changes}]`,
the plan's scope first, then by bytes) and an empty `predict`.

### `run/pipeline.json`

`{scope?, cmd?, predict?, plan, drawn, stored?, spent?, receipt?, refused?}` → `{outcome}`. The action loads nothing and
decides `write(plan, null)` over the plan built as in `plan/translate.json`, inside `ActionRunner.run` over a
replica whose commit reads `drawn`, `stored` (by default the same records as `drawn`) and `spent` (by default none)
and answers `receipt` (`{gestureId, localIds, retired, releaseAt?}`) or `refused` (`{code, detail?}`). The gone check
(§9.2 step 5) also refuses an insert or a move whose anchor neither view lists with an order key, naming the anchor: the
engine looks the anchor up in both. A revival takes its born from the `drawn` row, or from the spent id of the record
where `drawn` holds no row; with neither it is refused.

### `draft/save.json`

`{draft | creating, drawn, stored, anchor?, now?, offsetSeconds?}` → `{decision}`: `SaveDraft`'s `decide`
over the loaded value §10.2 defines, `anchor` given (default null).
- `draft`: `{t, id, base, current, isNew, placement?}`, `base` and `current` as `f`.
- `creating`: `{t, id, f, placement?}`, `SaveDraft(creating:)` (with `placed:` when given).

A present-again create (§10.2 step 5) edits a text field from the base's text (§10.1), `""` in a blank. A draft of a
`wholePut` type (`fact`) is saved whole (§10.2 step 1): every field, its timestamp at the vector's `now` as `Valid` gives
it, whatever it touched and whatever the records hold.

A `write` decision whose plan opts into Undo also names `undo`, the plan's recipes as `translateUndo` gives them.
`ReversibleCard` (`t: "reversibleCard"`), `ReversibleDay` (`t: "reversibleDay"`) and `ReversibleMark`
(`t: "reversibleMark"`) are `Card`, `Day` and `Mark` with `savesReversibly: true` (`ReversibleCard` unguarded and
checking `title` and `body` only): a reversible save names `createdRecord` for a record it creates where no record
was and a delete can take it back, and otherwise `fields` over what it writes, a text by its `text` slot, each
defaulting to the draft base's value, with the life (default `dead`) of a record it brings back to life
(§10.2 Reversible).

### `draft/script.json`

`{t, drawn, stored, now?, offsetSeconds?, ops}` → `{steps}`, one per operation: `{draft}` (null when
there is none), `{draft, result}` after a save, or `{trap: true}`, which is a script's last step.

| Operation | Effect |
|---|---|
| `{op: "new", id, placement?}` | `Draft(new: blank)`, or `Draft(new:placed:)`; the blank decodes from `{}` with `id` |
| `{op: "open", id}` | `runner.open(id)`: the draft, or null |
| `{op: "openOrNew", id, blank?}` | `runner.open(id, orNew:)` with a blank of `blank` (default `id`) |
| `{op: "edit", f}` | `current` becomes the entity decoded from its `fields` with `f` over them |
| `{op: "save", fail?, as?, gesture?}` | `runner.save(&draft, …)`; `fail: true` makes that commit throw before it commits, whether or not its body decides a gesture. `as` first gives `current` another record's id, which traps: Swift traps at the save, Kotlin at the `edit` that makes such a draft. `gesture: true` adds the gesture the save committed, or null, to its `result` |
| `{op: "rebase", f, id?}` | `draft.rebased(onto: theirs)`, `theirs` decoded from `f` with `id` (default the draft's) |
| `{op: "records", drawn, stored}` | the replica's records become these |

The replica never changes its records by itself. Its `k`-th committed gesture (counting from 1 in the
script) answers the receipt `{gestureId: "g<k>", localIds: ["g<k>/0"], retired: []}`. A save's `result` is
`{saved: "g<k>"}`, `{saved: null}` (nothing needed writing), `{refused: <refusal>}` or `{failed: true}`.

### `refusal/subject.json`

| `input` | `expect` |
|---|---|
| `{source: "commit", plan, code, detail?}` | `{subject}`: §12.1 rule 2 for an engine refusal of that plan (built as in `plan/translate.json`) |
| `{source: "notice", notice, of?}` | `{subject, gestureId}`, and `values` (`DomainNotice.values(of:)`) when `of` (`{t, id}`) is given |

A notice's subject is its first delta's record, else the first `ref<t>` argument of its command in the
registry's argument order (the `args` object's keys in JCS order), else null. `values(of:)` folds the
content's deltas, then each dependent's in order, depth first, a later write of a field replacing an
earlier one; a text is its `text`.


### `scope/bindings.json`

Runs the `draft/script.json` operations through the same runner with `scopes`, a map from actual
scope to `{drawn, stored}` records. An `open`, `openOrNew` or `new` operation may name `scope`;
a save uses the draft's bound scope and an explicit save `scope` must equal it. `remember` stores
the current draft under `name`; `recall` restores that draft. These operations make two drafts of
the same declaration and id coexist without changing their binding. `reportScope: true` adds
`scope` to each non-null draft and the actual committed scope (or null) to a save result.
The replica remains the deterministic script double: it records the scoped gestures and does not
apply them to its input records. Existing files omit these added output fields.

`GuardedMeta` (`t: "guardedMeta"`) uses `Meta`'s registry type, fields and checks with
`savesGuarded: true`, to exercise rebasing without changing `Meta`. The script operation
`load` attempts to load the current draft's save through a reader of its explicit `scope`;
a different scope traps before the repository is read.

The declaration is dynamic for `GuardedMeta`, `Meta`, `Mark`, `Link` and `Tag`. Older vectors that omit the actual
scope explicitly use `tree/b_00000001` or `self/overlay/b_00000001` in their fixture runner; those
fixture defaults are not part of the entity declaration. Product entities keep `self/probe` fixed.

### `run/act-decisions.json`

`{loads, segments, scopes, ids?}` → `{decision}`, through `ProductCorpus.act`, the act form a product's vectors use.
The act's load reads each scope of `loads` in turn, its result the ids each draws, `{<scope>: [id]}`; its decision
builds each of `segments` (`{scope, plan}`) as in `plan/translate.json`, an operation with `mint: true` taking the
next of `ids` in its segment's scope. `scopes` holds each scope's records (`{drawn, stored?}`). The decision is
`{write: {segments: [{scope, gesture}], result}}`, `{unchanged: {result}}` when `segments` is empty, or `{refuse}` in
the probe refusal form.

### `run/acts.json`

Each input lists ordered `segments`, each with `scope` and the `plan` language above. `inspect` lists
scoped types to read after the act; `undo: true` cancels the held act once (`cancelHeld`) by its shared receipt. These
vectors run `ActionRunner.runAct` over the real local engine. The output names the outcome kind,
per-segment scopes and local-id counts, whether the whole act is held, and inspected records as
`{id, title}` (null when that type has no title). An inspected type with `detail: true` also returns
its fields, life, and `bornSegment`, the index of the segment whose stamp matches its retained born. Identity cases instead name `mint` with its type, scope,
count and whether load borrows the scope; `new` first creates its governing board. `caughtScope`
attempts and catches an invalid scope read before minting, which must still fail the act. They drive the
engine act context directly so a missing-load programming fault can be asserted without a kit trap.
A refusal keeps the ordinary product refusal form. Repeated scopes are intentional.

### `run/composed.json`

§9.7, a composed act, over the real local engine and the reference server, in `run/undo.json`'s shape (below)
with `parts` in place of `segments`. A part is `{scope, plan, undo?}`, a plan as a segment states it, or
`{scope, append: {t, id, field, suffix}, undo?}`, which loads the record through the parts before it (`drawn`),
refuses `unknown-record` when it is absent, and else updates `field` to its value with `suffix` added, or
`{scope, unchanged: true}`, which decides `unchanged`. The
outcome is `{kind, counts, held}` as `runAct`'s, or `{kind: refused, part, refusal}` in the product refusal
form. The `cancel` step cancels the held act by its gesture id (`cancelHeld`) and answers `{cancelled}`.

### `run/undo.json`

K-3, Undo of an act (domain-kit §9.6, engine §7.3). Each input lists `before`, acts committed and synced first,
and the act's `segments`, each with `scope`, the `plan` language above and `undo`, its Undo recipes:
`{kind: fields, restoreCommand, targets: [{t, id, slot, scope?, defaultValue?}]}`, `{kind: createdRecord,
restoreCommand, t, id}` or `{kind: command, command, input, evidence: {ownedFields, unchangedCreatedRecords,
unchangedCreatedScopes}}`, a target or record without `scope` living in its segment's. `reversible` (true or
false) runs the one segment as a single action through `ActionRunner.run`, with or without the action's
`reversible` declaration; without it the act runs through `runAct`. `observe` names scopes every device follows.
A segment whose `undo` is `[]` is named for evidence alone (`evidenceForUndo`). `save: {t, id, scope?, current}`
replaces `segments`: the phone opens the record's draft, edits `current` over it and saves it through
`ActionRunner.save`, the act being the save's; its outcome is `{kind}` of the `SaveResult`.
`steps` run in order over the real local engine and the reference server: `sync`, `undo` (of the act),
`redo` (of the last request), `read` (the last request's result) and `cancel` (as `run/composed.json` reads it). The output names the act's outcome, each
step's `InverseResult` without its engine-drawn ids, and inspected records as `{id, <field>}`, `field` an
inspect item's (default `title`). A plan that opts into Undo outside a reversible action is a programming fault,
`{error: true}`.
