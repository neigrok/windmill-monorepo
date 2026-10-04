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

Exit codes: `0` clean · `1` an import failed, a workout exceeded 200 sets, or setup failed (named in the summary or error) ·
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
stripped. Each planned workout sends one `POST /v1/gym/sessions/import` with
`{id, startedAt, finishedAt, sets}`; sets are ordered by `completedAt`. The entire finished workout
is written atomically, leaving an open workout untouched. `201 {session, sets}` confirms a new
import; the identical body again returns `200 {session, sets}` with the workout's current rows.
The summary counts new imports separately from replays, including any later corrections or deletions.

A timeout, dropped connection (including during the reply body), or `5xx` retries the exact same
serialized body, up to four attempts with a 15-second deadline per attempt. A run interrupted while
using the atomic import door can be run again with the unchanged export and mapping. Changing an
accepted workout's body under its derived id is refused `409`; a deleted workout stays deleted.

`409 session-id-taken` is reported as "already exists from an earlier, interrupted import — not
re-imported", with the derived session id and start date. The workout is left untouched, other workouts
continue, and the run exits `1` with a summary for the owner to review. This code also covers a changed
payload or an id reserved elsewhere: for this refusal, the supported doors cannot establish ownership,
inspect the existing sets, or distinguish those cases. They cannot repair a partial workout left by the old importer.
Rerunning that refused workout will not resolve the conflict; review the existing workout instead.

`4xx` refusals are terminal for that workout and the run continues. A span crossing a finished
workout returns `409 session-overlap`, naming the conflicting session. Future times and sets outside
the workout's start/finish interval are refused. A workout with more than 200 source sets is reported
and skipped in its entirety, before filtering rows; it is never split or trimmed to fit. Transport
failures can leave a committed import without a received reply, so the summary says "not confirmed"
and an unchanged rerun resolves it safely. The only other API call is `GET /v1/gym/exercises`.

## The names

Windmill's catalog has a stable slug id per movement; Lift's exercise is free text. Names from workouts
within the 200-set limit fold by
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
- a workout with more than 200 source sets (the whole workout is skipped)

Repaired (counted, and said out loud):

- a session with `finishedAt: null` is closed at its last set's instant, mirroring gym's own
  auto-close rule. A finish running backwards against its own start gets the same treatment.
- a weight with more than two decimals is explicitly rounded to two decimals before import,
  matching the store's rounding, including negative half-cent ties.

Not carried: the session's `name` and `templateId`; this importer does not map them to Windmill fields.

## Tests

```sh
cd tools/lift-import && node --test test/
```

Dependency-free — Node's built-in `fetch` and `node:test`. `plan.js` carries the pure logic;
`client.js` carries the retry rule and deadlines. The suite covers stalled headers and bodies,
disconnections, exhausted retries, terminal refusals, reserved-id reporting, workout continuation, replay counts,
the 200-set boundary, and CLI output draining before exit.
`.github/workflows/tools.yml` runs the suite.
