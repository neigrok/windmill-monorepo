# Android A2 verification

Worktree `android-a2`, based on `origin/main`; all changes are local commits. The app and
notification receiver share the gym engine, durable SQLite replica and one runtime. Coach,
threads, attachments, shares, connected-log links and exports keep their REST doors. Gym data
reads and writes use the engine and `:gym:domain`.

## Migration and review observations

- A source archive is written durably before migration. Each item and its journal entry commit
  together; restarting resumes without repeating committed work. The completed fence prevents
  old anonymous shelves from returning after Add, Discard or Keep.
- Finished workouts use atomic strict imports. Validation, future times, overlaps, unavailable or
  changed frozen plans and unrepresentable source fields retain the original instead of changing
  history. Settings explains the refusal and offers explicit correction and retry. An unrelated
  edit preserves unrecognized kinds and closure metadata; explicit corrections name what changes.
  Unknown future authored fields remain intact and require an update.
- Frozen plans carry their exact name/entries guards and original routine birth in the atomic
  import. Edits or deletion during admission refuse the whole workout. A born-only prerequisite
  does not edit the routine, and the final encoded byte limit rolls back both work and journal.
- Owned cached history waits for the first complete pull before validating dependencies. A lost
  legacy finish reply can resume against an exactly matching confirmed session and complete set
  collection; predicted rows or extra remote children cannot count as confirmation.
- A joined start rewrites the effective target of owed operations while preserving the exact
  attempted source payload. Dormant account journals use distinct keys so Add cannot overwrite
  retained anonymous work. Folded dependent imports become visible refusals in the same transaction.
- Account changes first flush accepted rack controls into the replica. Add/Discard decisions pin
  real counts and revisions, including retained source work. Keep leaves account work dormant.
  Authentication seals the verified credential before presenting a decision; sign-out fences
  credential removal across crashes.
- A proposed sign-in has a separate sealed credential and does not publish the account until the
  engine completes. Cancelling it preserves anonymous work; a late hello cannot select that account,
  and a completed selection wins a late cancellation. Offline and update refusals retain the
  previous authority.
- The shipping coroutine adapter copies nesting into children, retains it across dispatcher hops
  and isolates independent entries. Application foreground tracking handles overlapping activities;
  connectivity wakes the existing runtime. Engine telemetry uses static labels through `Telemetry`.
- Offline set and history labels follow pending replica records until server confirmation. Proposal
  receipts wait for confirmed state or a refusal instead of displaying predicted success.

## Installed app

`Pixel_API34_Root`, emulator port 5562, local backend port 8096, database `wm_android_a2`.
The database was initialized with `schema.sql`, `gym_sync.sql`, `journal_sync.sql` and
`gym_sync_v5.sql`; `SYNC_ENABLED=1`, `GYM_ENGINE_WRITES=1`, `JOURNAL_ENGINE_WRITES=1`.
The backend was rebuilt from this worktree. The APK used
`-Pwindmill.apiBase=http://10.0.2.2:8096`.

The previous app was built from release tag `android-v0.10.0` with the same debug signing key.
This verifies a data upgrade from the previous release source; it does not verify the published
release signing key. Its UI created a finished four-set workout, a four-target routine and a live
one-set workout before installation of A2 over its data.

The upgraded UI retained the live workout and set, finished history and routine. Networking was
disabled; one more set was logged and the live workout finished. After reconnect, an authenticated
`/v1/me` restore with a throwaway local-account credential presented **1 routine · 2 workouts ·
6 sets** against a server containing one workout. Add uploaded both phone workouts through
`/v1/sync`, preserving their session and set IDs and timestamps. The server then held three
finished workouts and seven sets:

| Workout | Started ms | Finished ms | Sets |
| --- | ---: | ---: | ---: |
| Server seed `ses_androida2_server` | 1790963562195 | 1790964162195 | 1 |
| Finished source `ses_8ed592a5132a1adc` | 1791216564416 | 1791216621100 | 4 |
| Live source `ses_2a24a66c0eaac0b7` | 1791216914577 | 1791225228688 | 2 |

The five original set IDs remained `set_34c955880b70c375`, `set_0656abd5ee1aed7a`,
`set_f0f2660b7b63ce90`, `set_f082b0de672a36b9`, `set_8efd28c61ba6364e`; the extra offline
set was `set_273ee4e474baaa4f`. SQL confirmed every original completed timestamp unchanged.
The live workout and its extra set survived force-stop and restart while offline before finish.

A second signed-in workout was logged offline (two sets at 20 kg × 5), survived force-stop and
restart while offline, and finished locally. Reconnect produced `ses_4d536d5dbc579858`, start
1791225742145, finish 1791225846833, with `set_a5b6a49cc3002d01` and `set_48e25f1a76e2f4e3`.
The account held **four finished workouts and nine sets**; device-only labels cleared on confirmation.

Keep sign-out showed an empty signed-out log. A new signed-out workout and set produced
**1 workout · 1 set**; Discard and its second confirmation left the same four server workouts and
nine sets. The bound routine returned without uploading the discarded workout.
After the cancellation fix, Keep followed by force-stop/restart stayed signed out with no routines
or sessions. The completed migration fence did not resurrect the original anonymous shelves.

The real share sheet minted, copied and revoked a share through REST (POST 200, DELETE 204).
Connected log rendered and read both grants and MCP keys (GET 200). No LLM credential was
configured, so real Coach generation was not exercised; its existing behavior tests remain.

Email delivery was not configured. Device sign-in exercised verified credential restore and the
real engine decisions; code sign-in remains covered by the app's unit tests.

## Gates

Run from `apps/android`:

```sh
env JAVA_HOME="$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ANDROID_HOME="$HOME/Library/Android/sdk" \
  ANDROID_SENTRY_DSN=https://ci-placeholder@telemetry.invalid/1 \
  ./gradlew build --max-workers=4 \
  -Pwindmill.apiBase=http://10.0.2.2:8096 -Pwindmill.debugTelemetry=true
```

**BUILD SUCCESSFUL in 10m 40s**: 474 actionable tasks, 82 executed, 392 up-to-date. Fresh XML
reports contain **5,627 cases: 5,603 passed, 24 environment-gated live-wire skips, zero failures**.
This total includes both Android variants and the separately repeated mandatory-property task.

| Module/task | Passed | Skipped |
| --- | ---: | ---: |
| `:app`, each debug/release variant | 38 | 0 |
| `:platform`, each variant | 108 | 0 |
| `:gym`, each variant | 1,320 | 12 |
| `:sync-engine`, each variant | 150 | 0 |
| `:sync-api` | 13 | 0 |
| `:sync-model-server` | 5 | 0 |
| `:domain-kit` | 24 | 0 |
| `:domain-kit-testing` | 507 | 0 |
| `:gym:domain` | 62 | 0 |
| `:sync-testing` | 1,494 | 0 |
| `:sync-testing:mandatoryProperties` | 258 | 0 |
| Each of the two layering tasks | 4 | 0 |

Shared gates passed: client corpus **52/52 files, 740/740 vectors**; model server **27 files,
748 cases**, plus **7/7 protocol transcripts**; kit **12/12 files, 475/475 vectors**; gym **5/5
files, 56 cases**; schema **3 files, zero stale**, generator **9/9 Python tests**. Network replay
checked **128 seeds × 128 steps, 130,425 entries**; its **30 × 60 × 60** coverage survey and the
journal **30 × 60 × 160** survey had no missing required scenarios.

Separate installed-backend gates passed in **both debug and release** with fresh isolated accounts:
live wire **12/12**, including fresh magic-link verification, and engine facade **24/24**. These
retain the shipping behavior assertions. The probe waits for each touched record's confirmed
coverage, runs the real nine-second Undo hold and checks replay without changing the engine snapshot.
Cancellation boundary gates passed **70/70 per variant** (runtime 50, transport 20), preserving
exact cancelled requests for retry while genuine exceptions, disconnects and timeouts still report.
Migration tests passed **38/38 per variant**, including crash/resume, attempted operations, exact
IDs/lineage, strict refusals, concurrent routine edits/deletion and atomic byte-limit rollback.
Release-tool Python tests passed **18/18**. An HTTP update destination was rejected at configuration;
the update action requires HTTPS without embedded credentials.

The final installed APK matched the assembly SHA-256
`ec3c68790e0c66e5c683621d71c44b6967a17c4b9aa3a0bfcc77138ed7293a1d`.

## Cleanup

The server was stopped **by port 8096**; the listener was verified absent. Database `wm_android_a2`
was dropped and its absence checked in `pg_database`. Emulator 5562 and the task's ADB server were
stopped; no device remained connected. The throwaway app session was signed out before shutdown,
and temporary credential/shared-preference/environment files were removed.
The final Gradle daemon was stopped after the successful build.

## Telemetry observations

First-party intake received the migration-completed event, account choices, connectivity, training
and engine events. Stored properties used only static allowlisted keys. A search for the test
routine name, movement name and account email in event properties returned **zero** rows.
Queued offline failures were delivered after reconnect. Reviewing their client timestamps exposed
intentional live-socket close callbacks being classified as failures; cancellation regressions
cover this boundary separately from genuine disconnects, malformed frames and stalled output.
The updated device's verified restore, Keep and restart produced **zero new client-error events**
in both first-party intake and the retained device queue. Account shelves were inspected together
so undelivered events could not hide a cancellation failure.

While idle and online the engine reports successful no-op push preparation, reconciliation and
sweeps on its one-second polling loop. The immediate event queue can therefore deliver roughly
three `/v1/events` requests per second even after sync traffic settles. This is a performance
follow-up; it did not prevent the workout, account or receipt checks.

## Consumer search and limits

Whole-repository searches cover changed account, migration, store, transport and registration
surfaces. The retired-claim description in `docs/design/consistency.md:84–92`, and the REST progress
seam in `docs/design/gym/android-delivery.md:181`, are outside this task's territory and remain for
their owners. Existing shared protocol/schema/corpus formats are unchanged.

`-Pwindmill.updateUrl` configures the public Android update destination. No public APK URL was
provided or found in the repository; the default action honestly opens Windmill. Expected 410
and 426 responses retain local work, stop incompatible sync and emit metrics without Sentry issues.
SDK/collector tests establish local telemetry behavior; production vendor receipt, hosted Linux CI
and physical power loss are not established by these local checks.
