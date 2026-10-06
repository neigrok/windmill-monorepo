# Web gym sync

The signed-in gym observes `self/gym` through the shell's browser engine, and every gym write goes
through it: `useGymApi()` answers the engine API, or nothing before the engine is bound. Sessions and
their sets are read-only live mirrors; backfills use `gym.importSession`. Routine and note editors
retain their original register guards. A routine name, movement name or note title is written
NFC-normalised, trimmed and at most 60 code points, and a blank one is refused before it is written;
a rename to the name the store holds writes nothing. Deletes commit durable held deaths, and the engine owns
their release and restart. The room draws their Undo from the engine's `undoOffers`, so a delete
still held when the room is drawn again is offered with the deadline it already had. Coach and the
workout and log shares use their REST doors in `gymApi.js`; a Coach conversation delete is held on the
room's own clock, and when the room unmounts or the document hides it is dropped unsent and the
conversation stays. The account gate remains in `GymApp`.

Reads project the engine's stored view, so a held delete never changes what a screen says about the
account. The window decides what is drawn through the room's `log.hidden`: rows, the screen of the
held record itself, the count heading the log and the live session's sets. Records, last times and
progress keep counting a held delete until its release. A write the log refuses before
storing it is a `GymRefusal` (`errors.js`) carrying the engine's code, the sentence a screen shows
and, for an overlap, the crossed session; `failureReason` finishes the sentence for any failure,
naming this device when its store could not keep the write and the network only for a REST door.

`syncProjections.js` maps records to the REST reads' presentation shapes. The global seed catalogue
is outside sync and is checked against `schema.sql` in CI. Observation updates refresh local reads
and preserve history depth and editor drafts.
Creation and proposal chronology use the engine observation's authoritative `rc` envelope. Command
predictions persist per-exercise set numbers, correction removals and replacement numbers, and
routine deaths from removal proposals through offline restart.
The composition is schema v5 with minimum v4. Routine `revision` and `createdEntries`, proposal
`baseRevision`, `baseName` and `changeCount`, and note `updatedAt` come from server-authored registers.
Editors never write them. Note positions are zero-based; a move writes the moved note's `ord` alone,
right after the row drawn above it. The independent `routineCreation.snapshot` record is read-only
and survives routine deletion.

## Observability

Engine-backed writes emit first-party `gym_action` events with allowlisted `operation` and
`outcome` only. Operations cover routine create/save, exercise create/rename, preferences save,
note save/reorder, bodyweight save, set/session correction, session import, proposal apply/dismiss,
delete/Undo and refusal. Outcomes are `saved-local`, `unchanged`, `failed`, `held`, `undone`,
`closed`, `refused`. A local save does not claim server admission. Unexpected boundary failures
report a static `gym-<operation>` to Sentry, without exceptions, IDs, names, bodies or field values;
a `GymRefusal` is expected and reports nothing, and a store failure is the engine's to report.
Engine telemetry owns transport, storage, authentication and admission failures. Refusal content stays on the device; the room announces
unresolved notices.

## Gates

Gym tests run through the existing `npm test`, `npm run test:sync` and `npm run build` scripts.
Screen tests run over a real browser engine for a signed-in account (`gymAccount` in
`test/products/gym/harness.mjs`) and assert what the account still owes the server. The REST parity
fixture captures an actual disposable backend account and persisted browser-engine observations.
The ordinary CI gate and the strict local-stack gate compare complete responses across all 36
comparisons. Chromium acceptance has six checks: a phone replica's `gym.start`, set and `gym.finish`
pushes arrive live; web routine edits and backfills converge; the cached log survives an offline
reload. Product events reach intake and sync writes emit their log.
Run strict parity and local-stack Playwright with:

```
node web/test/products/gym/stack.mjs /absolute/backend/build
```

The runner uses ports 8094/5181 and a unique database, applies `schema.sql`, and starts the server.
It seeds the fixture through the doors production uses: MCP under a personal key for the custom
movement, the agent's routine and both proposals, and a phone replica for everything else. It
stops owned listeners by port and drops the database even on failure. A full-stack workflow
invocation requires CI configuration outside web; fixture and stalled-request/exit/crash/timeout/
shutdown tests already run in ordinary CI.
