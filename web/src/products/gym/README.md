# Web gym sync

The signed-in gym observes `self/gym` through the shell's browser engine, and every gym write goes
through it: `useGymApi()` answers the engine API, or nothing before the engine is bound. Sessions and
their sets are read-only live mirrors; backfills use `gym.importSession`. Routine and note editors
retain their opening values and guard touched fields through kit drafts. A routine name, movement
name or note title is written NFC-normalised, trimmed and at most 60 code points, and a blank one is
refused before it is written;
a rename to the name the store holds writes nothing. Deletes commit durable held deaths, and the engine owns
their release and restart. The room draws their Undo from the engine's `undoOffers`, so a delete
still held when the room is drawn again is offered with the deadline it already had. Coach and the
workout and log shares use their REST doors in `gymApi.js`; a Coach conversation delete is held on the
room's own clock, and when the room unmounts or the document hides it is dropped unsent and the
conversation stays. The account gate remains in `GymApp`.

Notes, catalogue, routines, bodyweight and preferences use the domain kit through `gymRuntime.js`.
Catalogue reads combine `domain/seedExercises.js` with custom movements and seed-name overrides.
Routine drafts preserve target absences and order; saved-workout routines and frozen plans use the
values in `domain/routines.js`. The plan decoder refuses malformed shapes; the projection reports
`gym-projection` and omits that plan while retaining the workout's recorded facts and stored data.
Notes mask pending deletes from the kit's `drawn` list and close an editor when its note is hidden.
Undo restores the row. Capacity and empty-room stance come from `stored`. Their guarded drafts save only
touched fields, with character and byte bounds declared in `domain/notes.js`. Moves write only the
selected note's order key; a drop in its drawn place writes nothing. Coach saves reuse a stored
note with the same normalised words and count held deletes against capacity.
The bodyweight stance reads
`stored`; its reading, dots and gaps read `drawn`, with the room's pending deletes hidden before storage
settles. Reads refresh on render, at local midnight and when the tab resumes. Bodyweight labels and fields
take the current preference unit directly; changing units preserves the amount in an open field.
Its saves validate the local day and kilograms, stamp
the commit moment and retire a held delete of that day. Preference saves write only touched client fields
(units, confirmation haptic and sound); rest settings are read-only.

Other reads project the engine's stored view, so a held delete never changes what a screen says about the
account. The window decides what is drawn through the room's `log.hidden`: rows, the screen of the
held record itself, the count heading the log and the live session's sets. Records, last times and
progress keep counting a held delete until its release. A write the log refuses before
storing it is a `GymRefusal` (`errors.js`) carrying the engine's code, the sentence a screen shows
and, for an overlap, the crossed session; `failureReason` finishes the sentence for any failure,
naming this device when its store could not keep the write and the network only for a REST door.

`syncProjections.js` maps records to the REST reads' presentation shapes, using the domain reads for
notes, catalogue, routines, bodyweight and preferences. The global seed catalogue
is outside sync and is checked against `schema.sql` in CI. Observation updates refresh local reads
and preserve history depth and editor drafts.
Creation and proposal chronology use the engine observation's authoritative `rc` envelope. Command
predictions persist per-exercise set numbers, correction removals and replacement numbers, and
routine deaths from removal proposals through offline restart.
The composition is schema v6 with minimum v4. Routine `revision` and `createdEntries`, proposal
`baseRevision`, `baseName` and `changeCount`, and note `updatedAt` come from server-authored registers.
Editors never write them. Note positions are zero-based; a move writes the moved note's `ord` alone,
right after the row drawn above it. The independent `routineCreation.snapshot` record is read-only
and survives routine deletion.

## Observability

`gymRuntime.js` owns the gym telemetry boundary. Engine-backed writes emit first-party `gym_action` events with allowlisted `operation` and
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
The gym domain claims eight of 13 corpus files: the rule book and 212 vectors across values (122),
bodyweight actions (10), preference actions and reads (8), notes (20), catalogue (24), routines (22)
and bodyweight reads (6), compared by JCS and with reversed record order.
The remaining five files are listed explicitly in the corpus runner.
Screen tests run over a real browser engine for a signed-in account (`gymAccount` in
`test/products/gym/harness.mjs`) and assert what the account still owes the server. The REST parity
fixture captures an actual disposable backend account and persisted browser-engine observations.
The ordinary CI gate and the strict local-stack gate compare complete responses across all 36
comparisons. Chromium acceptance has nine checks: a phone replica's `gym.start`, set and `gym.finish`
pushes arrive live; web routine edits, backfills, weigh-ins and unit changes converge; a held weigh-in delete can be
undone; the cached log survives an offline reload. Product events reach intake and sync writes emit their log.
Run strict parity and local-stack Playwright with:

```
node web/test/products/gym/stack.mjs /absolute/backend/build
```

The runner uses ports 8094/5181 and a unique database, applies `schema.sql`, and starts the server.
`WM_E2E_PORT`, `WM_E2E_WEB_PORT` and `WM_E2E_DB_PREFIX` select isolated backend/web ports and a database prefix.
It seeds the fixture through the doors production uses: MCP under a personal key for the custom
movement, the agent's routine and both proposals, and a phone replica for everything else. It
stops owned listeners by port and drops the database even on failure. A full-stack workflow
invocation requires CI configuration outside web; fixture and stalled-request/exit/crash/timeout/
shutdown tests already run in ordinary CI.
