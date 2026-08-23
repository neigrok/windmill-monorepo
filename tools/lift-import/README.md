# lift-import

Carries training history out of **Lift**, a standalone iOS training log, into the Windmill gym log.
A plain Node script speaking the public API — no backend surface, no importer in the app.

```sh
node tools/lift-import/import.js --export ~/Downloads/lift-export.json \
     --base-url https://windmill.works --token "$WINDMILL_SESSION" --dry-run
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

## The export

Lift writes one JSON file out of the SwiftData store and hands it to the iOS share sheet. AirDrop it
to the Mac, or *Save to Files*, and point `--export` at it.

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
`fixtures/example-export.json` holds every awkward case and is what the tests run on.

## Re-running is safe

Every Windmill id is derived from the Lift UUID — `ses_` / `set_` + the UUID lowercased with dashes
stripped — and gym's write path is idempotent by client-minted id, so a replayed `POST` no-ops and
hands back the stored row. An interrupted run can simply be run again.

Per session: start, append the sets in `completedAt` order, then finish. Appending a new set to a
finished session is refused `409`.

If the account has a workout open, a start would join it and every set would land in the wrong
workout, so the tool stops before writing anything and names the session to finish first.

## The names

Windmill's catalog has a stable slug id per movement; Lift's exercise is free text. Names fold by
one normal form (case, punctuation, spacing, plurals) onto `GET /v1/gym/exercises`, and exactly one
match resolves. A name that matches nothing or matches two is written to `mapping.json` with the
candidates that were considered, and the run stops having written nothing:

```json
"exercises": { "Bench Press": "bench-press", "Calf Raises": null }
```

Put a catalog id where the `null` is and run it again; a mapping in that file wins over the
automatic match.

## What it refuses, and what it repairs

Rows the training log's domain would refuse are dropped up front, and every one is counted in the
summary.

Refused (counted, listed row by row):

- reps outside `1..500`, weight outside `-500..500`, an instant of zero or past year 9999
- a session with no sets
- a session whose every set was refused
- a session or set id that is not a Lift UUID, or that the export holds twice

Repaired (counted, and said out loud):

- a session with `finishedAt: null` is closed at its last set's instant, mirroring gym's own
  auto-close rule. A finish running backwards against its own start gets the same treatment.
- a weight with more than two decimals rounds in the `numeric(6,2)` column.

Not carried: the session's `name` and `templateId`. There is no column for them.

## Tests

```sh
cd tools/lift-import && node --test test/
```

Dependency-free — Node's built-in `fetch` and `node:test`. `plan.js` carries the pure logic;
`client.js` carries the retry rule (4xx terminal, 5xx and a dropped connection retried).
`.github/workflows/tools.yml` runs the suite.
