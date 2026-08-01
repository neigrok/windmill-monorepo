# lift-import

Carries months of real training history out of **Lift** — a shipped standalone iOS training log
that has never sent a byte anywhere — and into the Windmill gym log, once.

Without it, gym launches empty: last-time prefill has nothing to prefill from, and the dogfood gate
("the prefill is right on set one in at least 6 of 8 sessions") cannot even run. That is the whole
reason this exists.

```sh
node tools/lift-import/import.js --export ~/Downloads/lift-export.json \
     --base-url https://windmill.pm --token "$WINDMILL_SESSION" --dry-run
```

| flag | |
| --- | --- |
| `--export <file>` | the Lift export json (required) |
| `--base-url <url>` | the Windmill API — default `$WINDMILL_BASE_URL`, else `http://localhost:8080` |
| `--token <secret>` | a session credential — default `$WINDMILL_TOKEN` |
| `--mapping <file>` | the exercise-name mapping — default `tools/lift-import/mapping.json` |
| `--dry-run` | resolve the names, print the whole summary, write nothing anywhere |

Exit codes: `0` clean · `1` the server refused a write (each one is named in the summary) ·
`2` an exercise name could not be resolved, and nothing was written.

## Getting the export off the phone

Lift's export (the other half of this bet, in the Lift repo) writes one JSON file out of the
SwiftData store and hands it to the iOS share sheet. AirDrop it to the Mac, or *Save to Files*, and
point `--export` at it. The file is the entire contract between the two halves:

```json
{ "app": "lift", "version": 1, "exportedAt": 1785000000000,
  "sessions": [
    { "id": "<lift session UUID>", "name": "Upper A", "templateId": null,
      "startedAt": 1777914000000, "finishedAt": 1777917900000,
      "sets": [ { "id": "<lift set UUID>", "exerciseName": "Bench Press",
                  "setNumber": 1, "weight": 82.5, "reps": 8,
                  "completedAt": 1777914300000 } ] } ] }
```

Every instant is epoch **milliseconds**, matching the Windmill wire — never ISO strings, never
seconds. Weight is kilograms and **may be negative**: band-assisted work logs on one number line.
`fixtures/example-export.json` is a small one holding every awkward case, and the file the tests and
the end-to-end run are built on.

## It is safe to re-run

Every Windmill id is derived from the Lift UUID — `ses_` / `set_` + the UUID lowercased with dashes
stripped — so the same row always lands under the same id. Gym's write path is idempotent by
client-minted id: a replayed `POST` no-ops and hands back the stored row. A second run therefore
changes nothing, and a run interrupted halfway can simply be run again. That is also why the
importer adds **no backend surface** — it is a plain Node script speaking the public API, the same
wire a phone speaks.

Per session it starts the session, appends the sets in `completedAt` order, then finishes it — that
order is the contract, because appending a *new* set to a finished session is refused `409` by
design.

If the account has a workout **open** (a real one, on a phone), a start would join it instead of
opening the imported session, and every set would land in the wrong workout. The tool detects that
and stops before writing anything, naming the session to finish first.

## The names — the one decision this tool refuses to make

Lift's worst decision was that an exercise is a free-text string: `Bench Press`, `Bench press` and
`bench press` are three different lifts forever, and a rename forked history. The import is where
that gets undone — Windmill's catalog has a stable slug id per movement, and every set points at
the id, so the display name is free to change afterwards.

Names fold by one normal form (case, punctuation, spacing, plurals) onto `GET /v1/gym/exercises`.
Exactly one match resolves. **Nothing else does.** A name that matches nothing (`Calf Raises` — the
catalog has a seated one and a standing one) or matches two, is written to `mapping.json` with the
candidates that were considered, and the run stops having written nothing:

```json
"exercises": { "Bench Press": "bench-press", "Calf Raises": null }
```

Put a catalog id where the `null` is and run it again; a mapping in that file wins over the
automatic match. Ambiguity surfaced beats ambiguity guessed — the integrity of the whole corpus
rests on this one decision, so a human takes it.

## What it refuses, and what it repairs

The training log's domain refuses rows Lift's coach path never clamped, so this tool drops them up
front rather than discovering it over HTTP — and **counts every one of them in the summary**. Silent
failure is Lift's house style and is explicitly not ours: nothing is quietly lost.

Refused (counted, listed row by row):

- reps outside `1..500`, weight outside `-500..500`, an instant of zero or past year 9999
- a session with **no sets** — Lift's accidental-Finish artifact is noise, not history
- a session whose every set was refused (an empty shell would claim a workout with no reps)
- a session or set id that is not a Lift UUID, or that the export holds twice

Repaired (counted, and said out loud):

- a session with `finishedAt: null` — abandoned — is closed at its **last set's** instant, mirroring
  gym's own auto-close rule: an open session ends at its last real activity, not at whenever we
  noticed. A finish the session could not have had (running backwards against its own start) gets
  the same treatment.
- a weight with more than two decimals will round in the `numeric(6,2)` column.

Not carried: the session's `name` and `templateId`. Phase-0 sessions have no name column, and the
plan snapshot is a phase-2 shape — a copied name that means nothing is worse than an absence.

## Tests

```sh
cd tools/lift-import && node --test test/
```

Dependency-free on purpose — Node's built-in `fetch` and `node:test`, nothing to install. The pure
logic (`plan.js`) carries the fold, the id derivation, the bands and the session rules; `client.js`
carries the retry rule (400 and 409 terminal, 5xx and a dropped connection retried).

## It is a one-shot tool, kept for the record

This is not a product surface and will not become one. It runs once against the author's own
history, and stays in the tree afterwards as the record of how that corpus arrived — what was
folded, what was refused, and what was repaired. There is no importer in the app, no upload button,
and nothing here is reachable from a browser.
