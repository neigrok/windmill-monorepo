# Web gym sync

The signed-in gym observes `self/gym` through the shell's browser engine. Sessions and their sets
are read-only live mirrors; backfills use `gym.importSession`. Routine and note editors retain their
original register guards. Deletes commit durable held deaths; Undo uses their gesture IDs.
The engine owns release and restart. Coach, shares and account exports retain their REST doors.
There is no gym REST boot, ETag or polling loop. The account gate remains in `GymApp`.

`syncProjections.js` maps records to the existing decoded REST presentation shapes. The global
seed catalogue is outside sync and is checked against `schema.sql` in CI. Observation updates
refresh local reads and preserve history depth and editor drafts.
Creation and proposal chronology use the engine observation's authoritative `rc` envelope. Command
predictions persist per-exercise set numbers, correction removals and replacement numbers, and
routine deaths from removal proposals through offline restart.
The composition is schema v5 with minimum v4. Routine `revision` and `createdEntries`, proposal
`baseRevision`, `baseName` and `changeCount`, and note `updatedAt` come from server-authored registers.
Editors never write them. Note positions are zero-based; reorder preserves the content admission
time. The independent `routineCreation.snapshot` record is read-only and survives routine deletion.

## Observability

Engine-backed writes emit first-party `gym_action` events with allowlisted `operation` and
`outcome` only. Operations cover routine create/save, exercise create/rename, preferences save,
note save/reorder, bodyweight save, set/session correction, session import, proposal apply/dismiss,
delete/Undo and refusal. Outcomes are `saved-local`, `failed`, `held`, `undone`, `closed`, `refused`.
A local save does not claim server admission. Unexpected boundary failures report a static
`gym-<operation>` to Sentry, without exceptions, IDs, names, bodies or field values. Engine
telemetry owns transport, storage, authentication and admission failures. Refusal content stays
on the device; the room announces unresolved notices.

## Gates and integration needs

Gym tests run through the existing `npm test`, `npm run test:sync` and `npm run build` scripts.
Screen fixtures keep REST response expectations only in tests. The REST parity fixture captures
an actual disposable backend account and persisted browser-engine observations. The ordinary CI
gate and the strict local-stack gate compare complete responses across all 36 comparisons.
Strict parity passes 36/36. Chromium acceptance passes all six checks: phone REST start, set and
finish arrive live; web routine edits and backfills converge; the cached log
survives an offline reload. Product events reach intake and sync writes emit their log.
Run strict parity and local-stack Playwright with:

```
node web/test/products/gym/stack.mjs /absolute/backend/build
```

The runner uses ports 8094/5181 and a unique database, applies schema.sql/gym_sync.sql/journal_sync.sql,
backfills both products, then applies gym_sync_v5.sql and runs the v5 metadata upgrade and audit
before starting any server. It enables the three engine switches, stops owned listeners by port
and drops the database even on failure. A full-stack workflow invocation requires outside-territory
CI configuration; fixture and stalled-request/exit/crash/timeout/shutdown tests already run in
ordinary CI.

Changes required outside web territory:

- `docs/foundation/engine.md` still lists the JS/web v5 carrier and strict parity as a remaining
  client handoff; its owner should record this delivery.

Whole-repository search found no shipping consumers of removed web gym methods or owner REST
share-preview. Backend routes, Android, Lift, backend differentials and rehearsal snapshots are
independent compatibility consumers; their REST doors remain intact.
