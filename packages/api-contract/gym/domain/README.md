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
| `actions.json` | `{action, input, records: {drawn, stored?}, ids, now, offsetSeconds}` → `{decision}`: the action's `load` and `decision` over the records (`stored` defaults to `drawn`) at the moment, minting `ids` in order |

## Forms

- An entity: `{id, fields}`. A note's fields are `title` and `body`.
- A decision: the kit's, its `result` the action's and its `refuse` the gym refusal.
- The gym refusal: `{invalid: <violation>}`, `{stale: {subject, path}}`, `{gone: {subject, path}}`,
  `{taken: {subject, path}}`, `{full: {type, cap, path}}` or `{other: <refused>}`.

## Actions

| `action` | `input` | Result |
|---|---|---|
| `SaveNoteCall` | `{note: <entity>}` | a note's id: the call's, or that of the stored note holding the same words |
