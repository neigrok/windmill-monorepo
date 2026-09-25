# Gym history and log shares

The existing sessions, workout-share and statistics routes retain their wire contracts. Web reads the complete qualified progress projection from `GET /v1/gym/stats?projection=progress`; it never derives lifetime progress from a history page.

`GET /v1/gym/history` reads completed workouts. Query parameters are `from` (inclusive epoch milliseconds), `until` (exclusive epoch milliseconds), `exercise` (stable movement ID), `routine` (stable routine ID), `before` and `beforeId` (descending keyset cursor), and `limit` (1–200, default 50). Ranges apply to session starts. A movement match includes the whole workout, not just that movement's sets. Routine names are frozen workout names; routine identity survives later deletion. Historical sessions whose routine had already been deleted before identity preservation have no routine filter identity.

The response contains:

- `sessions`: `{id, startedAt, finishedAt, routineId?, routineName, setCount, workingSetCount, reps, tonnageKg, exerciseNames, movements, sets}`. `movements` contains `{exerciseId,sets,reps,tonnageKg}` totals using the same working-set rule. A set is `{id, exerciseId, exercise, setNumber, weightKg, reps, rpe?, completedAt}`. The safe history projection omits set notes, private Notes, Coach, planned targets and owner identity.
- `summary`: `{sessions, sets, reps, tonnageKg}` for the complete filtered scope, before pagination. Sets, reps and external volume count working sets; volume clamps negative load to zero. `setCount` counts all sets in that workout.
- `months`: `[{month:"2024-01", sessions}]`, month index in `timeZone` (IANA name, default UTC), newest first, for the complete filtered scope.
- `exercises` and `routines`: `[{id, name, sessions}]` for the same complete filtered scope; count means workouts containing that identity, not sets. Exercise facets also carry `equipment` when known; snapshots freeze it with the safe facts. Readers suppress estimates for bodyweight equipment or unknown equipment, without inferring equipment from a name.
- `next`: `{before, beforeId}` when another page exists, otherwise `null`.

`POST /v1/gym/log-shares` accepts `{id, mode:"snapshot"|"live", scope:"all"|"range", from?, until?}`. The client-minted `id` makes a retry a replay. All scope requires omitted range values. Range scope requires both boundaries with `from < until`. The response is `{id, token, url, mode, scope, from?, until?, createdAt, expiresAt}`. Lifetime is thirty days; `url` opens `#/gym/shared-log/{token}`. Changing the request under the same ID is a 409. Revoked IDs cannot create a replacement link.

`GET /v1/gym/log-shares` returns `{shares:[...]}` with active links only. `DELETE /v1/gym/log-shares/{id}` is idempotent and returns 204. All three routes require the owner session.

`GET /v1/gym/shared-logs/{token}` is unauthenticated and accepts the history query. It returns the same safe history page plus `share:{mode,scope,from?,until?,createdAt,expiresAt}`. Recipient filters only narrow the authorized scope. Snapshot links freeze safe workout facts and names at creation; live links read the current completed workouts. Corrections and deletions affect live links; snapshots stay frozen. Unknown, revoked and expired tokens return the same 404. No public request settles or modifies a workout. Private Notes, Coach conversations, set notes, planned targets and owner identity are absent from both persistence snapshots and public responses.

Preview reads the owner history with the proposed scope and creates no link. Single-workout sharing retains its existing endpoint and behavior.

Both history reads accept `projection=progress` to add `progress:{asOf,sessions}` using the qualified `/stats?projection=progress` contract. The series covers the complete filtered authorized scope, independently of pagination; snapshot progress derives only from frozen facts. Without that parameter the progress field is omitted.

`POST /v1/gym/sessions/{id}/corrections` atomically replaces a completed workout with `{requestId,startedAt,finishedAt,routineName,sets:[{id,exerciseId,setNumber,weightKg,reps,rpe?,note?,completedAt}]}`. It returns `{session,sets,replayed}`. Repeating a request ID with the same payload returns current stored rows without applying again; changing that payload is 409 `correction-conflict`. JSON key order and whitespace do not change a payload. Deleted sessions never reappear. A finished session holds 1–200 sets; set numbers must be positive and unique per movement, all set instants fall within the interval, and no instant lies in the future. The interval cannot overlap another finished workout (409 `session-overlap`). Existing set kinds and movement identities remain; new sets are working sets. Missing old IDs delete those rows and preserve revisions. Supplied `rpe:null` clears effort; supplied `note:""` clears a note; omitted optional fields preserve an existing row's value. Set IDs already used or deleted cannot be reused.

The correction name is a historical display override, returned as optional `session.routineName` and resolved on history rows. It does not modify the living routine or any part of the frozen `session.plan` snapshot. Readers use `session.routineName ?? session.plan?.routine`.

Progress movements also carry optional `mostReps`, a performed fact for the zero-load working set with the most reps (equal reps choose the smallest set ID). Signed heaviest and qualified estimates keep their existing meanings.
