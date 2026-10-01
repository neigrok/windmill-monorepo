# Gym migration rehearsal

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
   response file byte for byte, then run `--audit` to compare each scope's stored digest and
   sequence with its TypeStore feed and spent ids.
6. Run the migration again: require `changed: 0` for every account and compare every non-system
   table's complete rows and every sequence's value and `is_called` byte for byte.

`result.json` records exact account, response, route, tool, scope and table counts. `migration.jsonl`,
`dry-run.jsonl`, `audit.jsonl` and `second-run.jsonl` hold the tool's reports. `reads-before` and
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

Owner handoff (C.5): the backfill preserves legacy import receipts and their original request
hashes and `sync_kind`. Wave 1's `PgGymState` reads a null `sync_kind` as a start receipt, and
`GymRules` import hashing differs from the legacy repository's raw-argument hash. The write-door
bridge must recognize legacy imports and compare a replay using their legacy hash; rewriting
these receipts during migration would violate C.5.

The offline read composition interprets C.7 as suppressing the lazy-close write while returning
the existing rows, using the same read services and serializers. Freezing one snapshot clock also
keeps expiry, rolling statistics and record windows identical between the two readings; C.8 tests
the migration's effect rather than elapsed wall time.
