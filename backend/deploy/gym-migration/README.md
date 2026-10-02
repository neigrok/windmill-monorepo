# One gym + journal cutover

Run the manual **Gym and journal production backup** (`.github/workflows/gym-backup.yml`) first, then
**Gym and journal migration rehearsal** (`.github/workflows/gym-rehearsal.yml`) from GitHub Actions → Run
workflow, on a revision carrying these workflows. Both use the same `SSH_KEY`, `SSH_HOST`,
`SSH_USER` and optional `SSH_PORT` as `deploy.yml`, and serialize with VPS deployment. They have
only `workflow_dispatch`; a push never runs either workflow.

The backup runs custom-format `pg_dump` inside `~/windmill`'s compose `db` container, verifies
`pg_restore --list`, and publishes a timestamped `~/windmill/backups/products-*.dump` only after that
check. It prints the path, byte size and SHA-256 checksum. No dump or production data leaves the
box. The backup directory and files are private to the SSH user.

The rehearsal selects the newest completed dump, restores it into a uniquely named disposable
database in the same Postgres, and uses the running server container's exact image to run this
rehearsal. That image must carry both products’ `windmill_{gym,journal}_backfill` and
`windmill_{gym,journal}_snapshot` binaries, Python, both adoption schemas and this script. Adoption is applied between the
frozen snapshots via `--apply-adoption`. Production keeps running: only the disposable database
must have no other clients. Output contains pass/fail and counts; detailed snapshots and logs stay
in a container tmpfs and disappear when it exits. A trap force-drops the disposable database on
success, failure or a received termination signal. The production database is never migrated by
this workflow. A failed rehearsal must be resolved before production rollout; these workflows
do not change the running service's engine-write or freeze switches.

Appendices C.8 and D.8 are executable together here. Run the same commands against a restored production copy before
rollout and against production during its write freeze. The binaries are built by backend CMake;
the workflow also needs Python 3 and `psql`. Keep this directory, `db/{gym,journal}_sync.sql`, `db/schema.sql`, and
`products/{gym,journal}/routes.cpp` together when copying the backend source to a server: the script checks
the snapshot's route inventory against the served GET routes.

Stop every process that can write this database first: REST, MCP, Coach, journal echo queues,
echo and nudge sweeps, import/repair tools, schema bootstrap jobs, maintenance and replicas.
Drain in-flight echo derivations and sweeps before collecting the immutable manifest. Keep them stopped for the whole workflow. The script refuses another client
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

`--apply-adoption` applies C.1/D.1's idempotent `db/gym_sync.sql` and `db/journal_sync.sql` after the first read snapshot. Omit it
when that schema is already present. The backfill refuses a database missing the adoption schema.
`--output` must be new; failures preserve all evidence collected so far. `--now-ms` optionally sets
the one clock value used by both read snapshots. By default the script records its startup time.
Set `WINDMILL_APP_URL` to the deployed app origin when collecting its read responses.

The workflow checks, in order:

1. Snapshot all accounts' gym and journal reads, using the target engine's journal HLC/day ordering,
   and prove that the snapshot changed no table or sequence.
2. Check every REST GET in `gym/routes.cpp` and `journal/routes.cpp` is in the snapshot inventory.
3. Run both backfills with `--dry-run`, and prove that it changed no table or sequence.
4. Migrate gym, then pause a new journal account inside its page UPDATE with a temporary
   rehearsal trigger. Terminate the tool before commit, remove the trigger and prove every table
   row/xmin and sequence remains unchanged. Adopt one journal account and audit it, then run the
   complete journal migration: the recorded account resumes unchanged. An already adopted
   database has no new account to interrupt, so its result records that gate as not exercised.
5. Snapshot the reads again, prove that reading changed no table or sequence, compare every
   response file byte for byte, then run `--audit` against the immutable per-account raw source and
   recorded migration clock in `gym_sync_adoptions` and `journal_sync_adoptions`. Every adopted row and required spent id is
   reconciled independently: envelope stamps equal `M:0:srv`, sequence and receipt times equal
   the frozen derivation, and legacy values, receipts, revisions and projections are preserved.
   The feed digest and greatest sequence are checked separately. Missing sources, missing scopes
   and incomplete or corrupted envelopes fail the audit. Gym reconciles an existing empty scope; journal refuses a scope without its
   required adoption marker.
   `--audit --test-corruptions` then deliberately changes field, born, life and spent stamps,
   sequences, receipt times, revisions and receipt hashes, recomputes each candidate's digest,
   requires audit rejection, and rolls every mutation back. A complete table comparison proves
   that these negative checks changed no stored row or sequence.
6. Run both migrations again: require `changed: 0` for every account and compare every non-system
   table's complete rows and every sequence's value and `is_called` byte for byte.

`result.json` records combined and per-product account, response, route, tool, scope and table
counts. `{gym,journal}-{migration,dry-run,audit,corruption-audit,second-run}.jsonl` hold reports.
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
/path/to/build/windmill_journal_rehearsal_seed
python3 backend/deploy/gym-migration/rehearse.py \
  --bin-dir /path/to/build --output /private/tmp/gym-local-rehearsal --apply-adoption
dropdb -h /tmp windmill_gym_rehearsal
```

The gym seed refuses any existing account or adoption schema. It creates five accounts: three with
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
on each. Its early-switch case starts the production server with both engine writes enabled before
backfill, requires 503 `gym-not-adopted`, 503 `journal-not-adopted` and zero new scopes, stops the server, then inserts the
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

The journal seed reuses the gym fixture accounts and adds an empty sixth account. Three accounts
have written pages and derive all four first-run fields as retired; one has only a blank page and
one only invisible revisions, and both retain pending defaults. It includes 1,001 additional pages
sharing a content stamp to cross the HLC-since limits, null and zero scores, spoken and normalized
legacy source, a future content stamp, an oversized historical body, expired and duplicate-body
revisions with archive-time ties and sub-millisecond receipts. Echo spans, echoes, dismissals,
offer dismissals, signals, curation, nudge settings, decisions, secrets and suppression stay intact.

`windmill_journal_snapshot` collects every GET route for every account: each page, range and
all-pages, export, HLC-since at every distinct stored content stamp and limits 1, 2, 499, 500, 999,
1,000 and 1,001, echoes, nudge settings and every page's operator explanation. Invalid limits and
missing resources retain their existing replies; every read route also exercises missing owner
credentials, and the operator route missing admin authority. The diagnostic composition uses the
rule segmenter and unwired embedding/curation boundaries, makes no vendor call and writes nothing.
Nudge arming and owner exemption use the supplied deployment environment; ticker threads remain
unstarted. Both snapshot connections enforce read-only transactions.

The journal snapshot process selects `JOURNAL_ENGINE_WRITES=1` and `JOURNAL_WRITE_FREEZE=1`
internally before constructing its repositories. Both snapshots therefore execute the target
engine's HLC-since query, with day as the equal-HLC tie-break, through the existing REST serializer.
The inventory records `sinceOrder: "hlc-day"`. This verifies response bytes across adoption under
the target engine read order. The legacy query orders only by HLC, so adoption's page UPDATEs can
change its physical tie order. The separate pre-merge `journal_write_differential.py --mode
main-vs-off` gate proves that both switches off retain origin/main's REST responses on identical
data, including reverse-inserted and later-updated equal-HLC cohorts.

Journal's independent audit derives expected rows from `journal_sync_adoptions.frozen_input`,
recorded M, policy and exact frozen receipt strings. It checks every field register is exactly
`M:0:srv`, the legacy HLC value, head body/rev/merged, row seq/rc/ru, state derivation, retained
revision identity/body/outgoing HLC/archive time, empty claim receipts and content clock, and
scope lifecycle, counters and spent ids. The separate feed digest/greatest-seq check includes the
reserved revision prefix. A real `SyncService` null-cursor boot must reach the advertised head and
sum to the stored digest, including revisions-only scopes; it mounts no `/v1/sync` listener.
`--audit --test-corruptions` changes page and state envelopes to a future stamp, heads, merged
flags, row seq/rc/ru, legacy receipt precision and retained revision content/stamps/times. It
recomputes each candidate digest and seq, proves the current digest check passes, requires the
independent frozen audit to reject it and rolls every mutation back. After the immutable second
runs, repeating `schema.sql` must leave every adopted page and its xmin unchanged and the journal
audit must still pass. Adoption requires the current nullable score schema before writing any row:
that makes the legacy non-null scale conversion guard in `schema.sql` inapplicable after adoption.

The two product-specific backfills preserve product independence, registry ownership and each
Appendix's derivation rules. The operator uses one backup, one restored-snapshot rehearsal and one
freeze window; the combined script and the following runbook coordinate both tools.

## Production cutover in one window

1. Run the dispatch-only backup and restored-snapshot rehearsal successfully on the exact target
   image. Retain the completed full database dump, checksum and combined gate result on the VPS.
2. Set `GYM_WRITE_FREEZE=1` and `JOURNAL_WRITE_FREEZE=1` while both engine-write switches remain
   off. New writes answer 503 `gym-frozen`/`journal-frozen`. Stop other page writers and bootstrap
   jobs; let in-flight echo/nudge work finish, then stop the server, queues, sweeps, MCP, Coach,
   replicas and every maintenance process. Prevent automatic restart for the whole window.
3. Run `rehearse.py --apply-adoption` against production using the same target image, environment,
   credentials and one frozen snapshot clock. It checks offline ownership between phases, both
   read inventories and bytes with the target engine's journal HLC/day ordering, immutable dry-runs,
   both migrations, independent digest/envelope
   and corruption audits, journal boot, before-commit interruption and recorded-account resume, unchanged second runs and
   the journal bootstrap guard. Preserve its output directory privately on the VPS.
4. Only after both products' gates pass, install the target admitted writers with
   `GYM_ENGINE_WRITES=1` and `JOURNAL_ENGINE_WRITES=1`, keeping both freeze switches on. Run the
   relevant contract and differential acceptance on the target build. The old SQL page writer
   must remain disabled; do not start native replicas in this window.
5. Release both freeze switches together, start the server and deferred workers, and inspect
   current digest audits and watcher notifications on accepted page writes. Keep the original
   backup and frozen evidence. After admissions, use each tool's `--audit-current` for current
   digest/head checks; `--audit` intentionally validates only the immutable migration base.

If any production gate fails before the freeze is released, keep both products frozen and every
writer stopped. A stopped run resumes account by account with each recorded manifest/M; a marker
without its scope, a scope without its marker, malformed legacy HLC/date or different policy
requires investigation. Do not erase a marker or create an empty journal scope to bypass failure.
Before any admitted write, rollback can restore the completed full database backup and the old
image while writers remain stopped. After admitted writes, restore would lose new writes: keep the
admitted image frozen and repair forward, or arrange an owner-approved recovery of those writes.
