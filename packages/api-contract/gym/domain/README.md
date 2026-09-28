# Gym domain corpus

The gym's shared vectors ([domain-kit.md](../../../../docs/foundation/domain-kit.md) §15.3). Every
implementation of the gym domain (Swift `GymDomain`, Kotlin `:gym:domain`) reproduces each `expect` byte for byte,
over the gym registry, `../../sync/gym.registry.json`. The conventions and JSON forms are the kit corpus's
([`../../domain-kit/README.md`](../../domain-kit/README.md)); this file states the gym's own.

## Files

| File | `input` → `expect` |
|---|---|
| `rules.json` | the gym rule book and entity facts, pinned (§6.3) |
| `values.json` | a spec case: a kit value vector whose spec is one of the book's; an entity case: `{entity, id, fields, now, offsetSeconds}` → `{fields}` or `{violation}`, every field validated |
| `notes-actions.json`, `bodyweight-actions.json` | each feature's actions and draft saves: `{action, input, records: {drawn, stored?}, ids, now, offsetSeconds}` → `{decision}`: the action's `load` and `decision` over the records (`stored` defaults to `drawn`) at the moment, minting `ids` in order; a draft save's decision over the draft its editor opens there |
| `../rules/bodyweight.json` | the room's read: `{read, input?, records: {drawn, stored?}, firstPullComplete?, now, offsetSeconds}` → `{result}`, over the records at the moment, the first pull complete unless the case says otherwise |

## Forms

- An entity: `{id, fields}`. A note's fields are `title` and `body`. A weigh-in's id is its local day, `YYYY-MM-DD`, and
  its fields are `kg` and `recordedAt`.
- A decision: the kit's, its `result` the action's and its `refuse` the gym refusal.
- The gym refusal: `{invalid: <violation>}`, `{stale: {subject, path}}`, `{gone: {subject, path}}`,
  `{taken: {subject, path}}`, `{full: {type, cap, path}}`, `{future: {subject, path}}` or `{other: <refused>}`.

## Actions

| `action` | `input` | Result |
|---|---|---|
| `SaveNoteCall` | `{note: <entity>}` | a note's id: the call's, or that of the stored note holding the same words |
| `SaveWeighIn` | `{day, kg}`, `kg` null while the field holds no number: the sheet's save, the day's draft opened over the records (the drawn weigh-in, or a new one), `kg` set on it | the weigh-in as saved, `{id, fields}` |
| `DeleteWeighIn` | `{day}` | none, `null` |

## Reads

| `read` | `input` | Result |
|---|---|---|
| `Bodyweight` | `{from?, to?}`, local days bounding `list`, each inclusive and either open | `{stance, today, reading, recent, all, list}`: `stance` `"unknown"`, `"empty"` or `"holding"`; `reading` `{entry, daysAgo}` or null; `recent` and `all` the charts `{dots, gaps}`, a gap `{after, before}`; `list` the entries within the bounds; an entry `{day, kg}` |
