# Domain kit corpus

The shared vectors of the domain kit ([domain-kit.md](../../../docs/foundation/domain-kit.md) §15). Every
implementation of the kit (Swift `DomainKit`, Kotlin `:domain-kit`) reproduces each `expect` byte for byte.
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
| `Mark` | `mark`, `self/overlay/b_00000001` | `Draftable` (`savesGuarded` false) | `done` (null), `memo` (`""`, a text field) | `memo`: text `mark.memo` bytes 0–40, no trim, no nfc |
| `Meta` | `meta`, `tree/b_00000001` | `Draftable` (`savesGuarded` false) | `title` (`""`) | `title`: text `meta.title` chars 0–12 trim nfc |
| `Lap` | `lap`, `self/probe` | `Writable`, `Removable` (`heldRemoval` false) | `runId` (`""`), `at` (null), `weight` (null) | `weight`: number `lap.weight` −500…500 quantum 0.01 |
| `Run` | `run`, `self/probe` | `Writable`, `Removable` (`heldRemoval` false) | `startedAt` (null), `label` (null) | `label`: text `run.label` chars 0–12 trim nfc |
| `Link` | `link`, `tree/b_00000001` | `Writable`, `Removable` (`heldRemoval` true) | `strength` (null) | `strength`: number `link.strength` 0–9 integer |
| `Tag` | `tag`, `tree/b_00000001` | `Writable` | `label` (`""`) | none |

Every entity's `fields` holds every field of its row above, a nil value as `null`; `Mark.memo` decodes by
`Fields.text`. They are vector declarations, not a product's: a card writes `claim: null` and a blank `title`, which the
registry's domains refuse at a server. Commands: `ProbeStart` (`probe.start`, specs: text `probe.start.label` chars 0–12
trim nfc), `ProbeEnd` (`probe.end`, no specs) and `ProbeCopy` (`probe.copy`, no specs); a vector gives a command as
`{name, args}`. `ProbeRefusal` maps a `Violation` and a `Refused` to the refusal forms above.

Translation writes minted, keyed and singleton types. A `—` cell of §8.2's table (a removal of a type
without life, a move of a singleton), a derived type (`tag`) and a type the registry does not hold fail
translation like a §8.3 rule: `{error: true}`. A minted create leaves a nil `time` field out of `f`, so the engine
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
A vector with `cmd` builds `Plan(running:predicting:)` first (`predict`: `[{op: "create" | "update", t, id,
f}]`), then applies each operation of `plan` in order:

| Operation | Plan call |
|---|---|
| `{op: "create", t, id, f, fields?, checked?}` | `create(valid)`, or `create(valid, fields:)` when `fields` is given |
| `{op: "insert", t, id, f, below, checked?}` | `insert(valid, below:)` |
| `{op: "update", t, id, f, fields?, base?, guarded?, checked?}` | `update(valid, fields:, from:, guarded:)`; `base` is the base entity's `f` |
| `{op: "remove", t, id}` | `remove(id)` |
| `{op: "move", t, id, below}` | `move(id, below:)` |
| `{op: "guardRead", t, id, fields}` | `guardRead(id, fields:)` |
| `{op: "device", key, value}` | `device(key, value)` |

`valid` is `Valid(entity, fields: checked, at: moment)`, where the entity decodes from `f` with the
operation's id and `checked` defaults to `fields`, then to every field. A violation ends the vector with it.
Translation then runs for `scope`.

### `run/pipeline.json`

`{scope?, cmd?, predict?, plan, drawn, stored?, receipt?, refused?}` → `{outcome}`. The action loads nothing and
decides `write(plan, null)` over the plan built as in `plan/translate.json`, inside `ActionRunner.run` over a
replica whose commit reads `drawn` and `stored` (by default the same records as `drawn`) and answers `receipt`
(`{gestureId, localIds, retired, releaseAt?}`) or `refused` (`{code, detail?}`). The gone check (§9.2 step 5) also
refuses an insert or a move whose anchor neither view lists with an order key, naming the anchor: the engine looks the
anchor up in both.

### `draft/save.json`

`{draft | creating, drawn, stored, anchor?, now?, offsetSeconds?}` → `{decision}`: `SaveDraft`'s `decide`
over the loaded value §10.2 defines, `anchor` given (default null).
- `draft`: `{t, id, base, current, isNew, placement?}`, `base` and `current` as `f`.
- `creating`: `{t, id, f, placement?}`, `SaveDraft(creating:)` (with `placed:` when given).

A present-again create (§10.2 step 4) edits a text field from the base's text (§10.1), `""` in a blank.

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
