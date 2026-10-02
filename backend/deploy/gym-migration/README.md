# Gym migration rehearsal

Run the manual **Gym production backup** (`.github/workflows/gym-backup.yml`) first, then
**Gym migration rehearsal** (`.github/workflows/gym-rehearsal.yml`) from GitHub Actions → Run
workflow, on a revision carrying these workflows. Both use the same `SSH_KEY`, `SSH_HOST`,
`SSH_USER` and optional `SSH_PORT` as `deploy.yml`, and serialize with VPS deployment. They have
only `workflow_dispatch`; a push never runs either workflow.

The backup runs custom-format `pg_dump` inside `~/windmill`'s compose `db` container, verifies
`pg_restore --list`, and publishes a timestamped `~/windmill/backups/gym-*.dump` only after that
check. It prints the path, byte size and SHA-256 checksum. No dump or production data leaves the
box. The backup directory and files are private to the SSH user.

The rehearsal selects the newest completed dump, restores it into a uniquely named disposable
database in the same Postgres, and uses the running server container's exact image to run this
rehearsal. That image must carry `windmill_gym_backfill`, `windmill_gym_snapshot`, Python, the
adoption schema, and this script (the current Dockerfile does). Adoption is applied between the
frozen snapshots via `--apply-adoption`. Production keeps running: only the disposable database
must have no other clients. Output contains pass/fail and counts; detailed snapshots and logs stay
in a container tmpfs and disappear when it exits. A trap force-drops the disposable database on
success, failure or a received termination signal. The production database is never migrated by
this workflow. A failed rehearsal must be resolved before production rollout; these workflows
do not turn either switch on.

Appendix C.8 is executable here. Run the same commands against a restored production copy before
rollout and against production during its write freeze. The binaries are built by backend CMake;
the workflow also needs Python 3 and `psql`. Keep this directory, `db/gym_sync.sql`, and
`products/gym/routes.cpp` together when copying the backend source to a server: the script checks
the snapshot's route inventory against the served GET routes.

Stop every process that can write this database first: REST, MCP, Coach workers, other maintenance,
and replicas. Keep them stopped for the whole workflow. The script refuses another client
connection to its database before and between phases. This check catches a running service; the
owner must also prevent a stopped service from restarting during the freeze (C.7). The snapshot
process mounts no listener or write door. Its existing `TrainingService` uses a repository that
suppresses lazy close, and its auth repository resolves an in-memory credential without refreshing
sessions. Its only pooled connection sets PostgreSQL's default transactions read-only, so an
unexpected database write fails the snapshot.

```sh
export DATABASE_URL='postgresql:///windmill_rehearsal?host=/tmp'
python3 backend/deploy/gym-migration/rehearse.py \
  --bin-dir /path/to/build \
  --output /private/tmp/gym-rehearsal-evidence \
  --apply-adoption
```

`--apply-adoption` applies C.1's idempotent `db/gym_sync.sql` after the first read snapshot. Omit it
when that schema is already present. The backfill refuses a database missing the adoption schema.
`--output` must be new; failures preserve all evidence collected so far. `--now-ms` optionally sets
the one clock value used by both read snapshots. By default the script records its startup time.
Set `WINDMILL_APP_URL` to the deployed app origin when collecting its read responses.

The workflow checks, in order:

1. Snapshot all accounts' gym reads, and prove that the snapshot changed no table or sequence.
2. Check every REST GET in `gym/routes.cpp` is in the snapshot inventory.
3. Run the backfill with `--dry-run`, and prove that it changed no table or sequence.
4. Run the migration.
5. Snapshot the reads again, prove that reading changed no table or sequence, compare every
   response file byte for byte, then run `--audit` against the immutable per-account raw source and
   recorded migration clock in `gym_sync_adoptions`. Every adopted row and required spent id is
   reconciled independently: envelope stamps equal `M:0:srv`, sequence and receipt times equal
   the frozen derivation, and legacy values, receipts, revisions and projections are preserved.
   The feed digest and greatest sequence are checked separately. Missing sources, missing scopes
   and incomplete or corrupted envelopes fail the audit; an existing empty scope is repaired.
   `--audit --test-corruptions` then deliberately changes field, born, life and spent stamps,
   sequences, receipt times, revisions and receipt hashes, recomputes each candidate's digest,
   requires audit rejection, and rolls every mutation back. A complete table comparison proves
   that these negative checks changed no stored row or sequence.
6. Run the migration again: require `changed: 0` for every account and compare every non-system
   table's complete rows and every sequence's value and `is_called` byte for byte.

`result.json` records exact account, response, route, tool, scope and table counts. `migration.jsonl`,
`dry-run.jsonl`, `audit.jsonl`, `corruption-audit.jsonl` and `second-run.jsonl` hold the tool's reports.
The result includes the exact number of corruptions rejected. `reads-before` and
`reads-after` hold per-account response bodies, status codes and headers, MCP `tools/call` result
objects, and manifests of the exact requests. Table comparisons use sorted `to_jsonb(row)` values
and each row's `xmin`, plus a fixed UTC database timezone. This detects a no-op UPDATE as a row
change and makes physical order irrelevant.

`windmill_gym_snapshot --output DIR [--account UUID] [--now-ms EPOCH_MS]` can collect the same
read evidence independently. It calls the existing REST adapters and gym MCP host in process over
today's PostgreSQL repositories. An in-memory owner credential exercises HTTP authentication
without modifying platform auth data; soft-closed accounts keep their existing HTTP 401 replies.
MCP calls use an explicit owner principal to inspect each account's repository reads. It visits
every account (including empty accounts), every visible movement, all
session/routine/proposal/thread/attachment ids, every stored share token, and all
session/history/thread/message pages. Missing resources get the same existing read-door response.
All MCP tools declared with `Access::read` are covered; an unrecognized new read tool fails the
snapshot. Both `review` forms, history progress, and snapshot/live share reads are included.
Gym's browser share pages are client-rendered: their backend doors are
`GET /v1/gym/shared/{token}` and `GET /v1/gym/shared-logs/{token}`, whose complete responses are
dumped for every stored token. Transport-generated Date and connection framing are outside the
comparison; application response bytes, content type, status and headers are inside it. The web
HTML/JS assets are static and outside this database; this backend gate does not claim frontend
screen verification. HTTP 401 from an open account, every HTTP 403, and unexpected failures of
valid MCP list reads fail the gate.

To build a realistic disposable local dataset through today's gym repositories:

```sh
createdb -h /tmp windmill_gym_rehearsal
export DATABASE_URL='postgresql:///windmill_gym_rehearsal?host=/tmp'
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f backend/db/schema.sql
/path/to/build/windmill_gym_rehearsal_seed
python3 backend/deploy/gym-migration/rehearse.py \
  --bin-dir /path/to/build --output /private/tmp/gym-local-rehearsal --apply-adoption
dropdb -h /tmp windmill_gym_rehearsal
```

The seed refuses any existing account or adoption schema. It creates five accounts: three with
training histories, one holding only a spent note receipt, and one empty account. Each rich account
holds two routines with ordered schemes and optional targets; seven completed workouts plus a stale
open workout; 35 standing sets including warm-up, assisted and drop sets; deleted sets and imports,
set revisions and a full-session correction receipt; four proposals including superseded and
dismissed rows; reordered and edited notes with receipts; fourteen weigh-ins with a correction;
preferences, renamed custom movements, a renamed seed and an aliases-only seed; Coach conversations
and PNG attachments; and workout, snapshot log and live range log shares. Fixture ids and history
values are fixed; accounts and repository creation timestamps are minted by the existing stores.

Engine writes enabled before adoption refuse with 503 `gym-not-adopted`, including the lazy
staleness settlement on reads, and leave no empty scope behind. A scope created by an older
writer is not proof of adoption: the backfill reconciles and repairs its incomplete rows and spent
ids before the audit can pass. Keep the write freeze in place throughout migration.

The backfill preserves legacy import receipts and their original request hashes and `sync_kind`
(C.5). The admitted write door compares legacy import replays using the repository's original
raw-argument hash before admission; it does not rewrite receipts during migration.

The offline read composition interprets C.7 as suppressing the lazy-close write while returning
the existing rows, using the same read services and serializers. Freezing one snapshot clock also
keeps expiry, rolling statistics and record windows identical between the two readings; C.8 tests
the migration's effect rather than elapsed wall time.

`rehearse_local.py` owns and force-drops two seeded disposable databases and runs the full workflow
on each. Its early-switch case starts the production server with engine writes enabled before
backfill, requires 503 `gym-not-adopted` and zero new scopes, stops the server, then inserts the
empty scope an older writer could leave. The full rehearsal must repair that scope, preserve all
read bytes, audit every account and remain immutable on its second run:

```sh
python3 backend/deploy/gym-migration/rehearse_local.py \
  --bin-dir /path/to/build --output /private/tmp/gym-local-gates
```

`--audit` validates the frozen migration base before admitted writes resume. After admissions,
`--audit-current` checks current envelope completeness, row/spent reconciliation, digest and greatest
sequence without comparing live records with the frozen migration output. The real-server differential
runs the frozen audit immediately after migration and the current audit after its write sequence.
