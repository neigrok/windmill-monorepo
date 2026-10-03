# One gym + journal cutover

Production uses one dispatch-only **Gym and journal production cutover** workflow
(`.github/workflows/products-cutover.yml`). It shares `deploy-vps` concurrency with backend and
frontend VPS deployments, so neither can deploy while cutover runs. There is no staging environment.
The whole site, including roadmap, is unavailable while database writers are stopped: plan for a
few minutes of downtime. Today's production has three accounts and about 8,800 rows; the rehearsal
ran in about 70 seconds, but allow time for the backup, restore on failure and startup checks.

The manual **Gym and journal production backup** (`gym-backup.yml`) and **Gym and journal migration
rehearsal** (`gym-rehearsal.yml`) are optional preparation. They use the same `SSH_KEY`, `SSH_HOST`,
`SSH_USER` and optional `SSH_PORT` as `deploy.yml`, and also serialize with VPS deployment.
The preparation backup is a custom-format archive, verified with `pg_restore --list` and a SHA-256
sidecar, retained privately under `~/windmill/backups/`. It is not the cutover rollback backup:
cutover takes its own fresh rollback archive only after every compose database writer is stopped.
No production dump or data leaves the VPS.

The rehearsal restores the newest completed preparation dump into a uniquely named disposable
database in the same Postgres and uses the running server container's exact image. That image must
declare `io.windmill.schema-adoption-compatibility=gym-journal-v1` and bundle a `schema.sql` with
the matching marker, both products' backfill and snapshot binaries, Python and adoption schemas.
The disposable restore is marked `windmill-rehearsal-disposable`; interruption and corruption
fixtures run only with `--disposable-fixtures` on that marked database. A trap force-drops it on
success, failure or a received termination signal. Production keeps running throughout rehearsal.
Resolve any failed rehearsal before scheduling the cutover.

Appendices C.8 and D.8 are executable together here. Keep this directory,
`db/{gym,journal}_sync.sql`, `db/schema.sql`, and `products/{gym,journal}/routes.cpp` together when
copying backend source: the script checks the snapshots' route inventory against served GET routes.
Stop manual import/repair jobs, maintenance and any database writer outside the compose project
before cutover; keep them stopped until it completes. The wrapper stops the server and all compose
workers and confirms none runs before backup or adoption. The migration tools reject other clients
before and between phases. Production never runs fault-injection fixtures.

The snapshot process mounts no listener or write door. Its `TrainingService` uses a repository
that suppresses lazy close, and its auth repository resolves in-memory credentials without refreshing
sessions. Its pooled connection sets default transactions read-only, so unexpected writes fail.

```sh
export DATABASE_URL='postgresql:///windmill_gym_rehearsal?host=/tmp'
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "COMMENT ON DATABASE windmill_gym_rehearsal IS 'windmill-rehearsal-disposable'"
python3 backend/deploy/gym-migration/rehearse.py \
  --bin-dir /path/to/build \
  --output /private/tmp/gym-rehearsal-evidence \
  --apply-adoption --disposable-fixtures
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
4. Migrate gym. On the disposable restore only, pause a new journal account inside its page UPDATE with a temporary
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
   On disposable restores, `--audit --test-corruptions` then deliberately changes field, born, life and spent stamps,
   sequences, receipt times, revisions and receipt hashes, recomputes each candidate's digest,
   requires audit rejection, and rolls every mutation back. A complete table comparison proves
   that these negative checks changed no stored row or sequence.
6. Run both migrations again: require `changed: 0` for every account and compare every non-system
   table's complete rows and every sequence's value and `is_called` byte for byte.

`result.json` records combined and per-product account, response, route, tool, scope and table
counts. `{gym,journal}-{migration,dry-run,audit,second-run}.jsonl` hold reports;
disposable runs also produce corruption audits. The result includes the exact number of corruptions
rejected (zero in production, where these fixtures do not run). `reads-before` and
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
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f backend/db/schema.sql \
  -c "COMMENT ON DATABASE windmill_gym_rehearsal IS 'windmill-rehearsal-disposable'"
/path/to/build/windmill_gym_rehearsal_seed
/path/to/build/windmill_journal_rehearsal_seed
python3 backend/deploy/gym-migration/rehearse.py \
  --bin-dir /path/to/build --output /private/tmp/gym-local-rehearsal --apply-adoption --disposable-fixtures
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
ids before the audit can pass. Keep every database writer stopped throughout migration.

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
sequence without comparing live records with the frozen migration output. Online audits read one
consistent snapshot, including journal boot pagination, while writes continue. Diagnostics contain
validation categories and SQLSTATE codes without row contents. The real-server differential
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
On disposable restores, `--audit --test-corruptions` changes page and state envelopes to a future stamp, heads, merged
flags, row seq/rc/ru, legacy receipt precision and retained revision content/stamps/times. It
recomputes each candidate digest and seq, proves the current digest check passes, requires the
independent frozen audit to reject it and rolls every mutation back. After the immutable second
runs, repeating `schema.sql` must preserve gym and journal trigger/constraint catalogs and adopted
product/sync rows including `xmin` and sequences. Both products' independent digest audits must
pass after that final reapply. Adoption requires the current nullable score schema before writing
any row. Its marker also excludes the legacy scale conversion in `schema.sql` from future deployments.

The two product-specific backfills preserve product independence, registry ownership and each
Appendix's derivation rules. The operator uses one backup, one restored-snapshot rehearsal and one
stopped-service window; the combined script and the following runbook coordinate both tools.

## Production cutover in one workflow

Prepare an ordinary compatible running image while the production database is still unadopted.
Its image label must be `io.windmill.schema-adoption-compatibility=gym-journal-v1` and its bundled
schema must carry the matching declaration. Optional backup and disposable rehearsal can run at
this point. Complete external import/repair jobs and stop any writer outside this compose project.

Set GitHub Actions repository variables to `GYM_ENGINE_WRITES=1`, `JOURNAL_ENGINE_WRITES=1`,
`GYM_WRITE_FREEZE=0`, `JOURNAL_WRITE_FREEZE=0`, and `SYNC_ENABLED=0`. These are the values that
subsequent ordinary deployments will render. An ordinary deploy refuses engine writes against an
unadopted or incomplete database before changing the live environment, compose files or containers.
An adopted database requires both engine-write switches to remain on and refuses any image lacking
the declared and bundled compatibility markers. Both product audits must pass before deployment
promotes any candidate file.
Both deploy scripts require host `python3`, `sha256sum`, and Docker Compose before changing files,
services, or the database, and print a FAIL line naming any missing prerequisite.
Ordinary deployment also refuses an interrupted cutover before its saved startup boundary, even
if adoption has completed, so an automatic deploy cannot restart writers before the remaining audits.

Dispatch **Gym and journal production cutover** (`products-cutover.yml`) once, with `confirm`
exactly `cut over gym and journal`. Before changing anything, the remote script verifies the running
image's compatibility, an unadopted database, the repository switches and the absence of fixture
objects. It also requires the live `SYNC_ENABLED=0`. Then it stops every compose database writer,
including the server and workers, and confirms none remains running. **The whole site, roadmap
included, is down for the few minutes this workflow runs.**

The script now takes the rollback custom-format `pg_dump`, verifies `pg_restore --list`, and writes
its SHA-256 sidecar. Writers remain stopped from this backup until either successful startup or
completed restoration. It applies `gym_sync.sql` and `journal_sync.sql`, runs both backfills and
all read, envelope, independent digest and catalog audits, then reapplies `schema.sql` and repeats
the catalog and digest checks. Production installs no test fixtures and runs no fault injections.

On PASS, the script writes the five switches into `~/windmill/.env` with the same literal values
as `deploy.yml`, preserving other configuration and the initialized Postgres password. It starts
the services and checks health, a REST read that needs no credentials, both products'
`--audit-current`, and the disabled `/v1/sync` route's 404 response. No subsequent enable or release
deploy is part of this cutover. Actions prints pass/fail, counts, durations, and the backup path and
SHA-256; private evidence stays on the VPS.

A backup, adoption, audit or configuration failure before the persisted startup boundary triggers
a verified `pg_restore --create --clean --if-exists` of the rollback archive, restores the previous
switches and starts the old configuration. The script durably records `restoring` before automatic
restoration begins. The workflow reports FAIL. If no complete backup exists
yet, it has made no database mutation and can restart the old configuration directly.
Restoration recreates the database from the archive, removing adoption-only objects as well as
restoring every saved row and sequence; a complete comparison verifies the restored contents.

**When service startup is attempted, recovery is forward-only.** The script persists this boundary
before its first start call, because even a failed or interrupted call can already have accepted
writes. A startup or smoke-test failure reports FAIL without automatic restoration; restoration
could lose those writes. Keep the compatible engine configuration and inspect the private evidence;
repair forward before resuming external jobs. The output states this boundary explicitly.

If SSH is lost or the script is killed, rerun the same workflow. It checks the persisted phase and
adoption markers and removes the named backup/restore/migration helper first, so a surviving child
cannot race recovery. With no adoption markers and no startup boundary, it can safely repeat cutover;
an interrupted rollback finishes restoring its original verified archive before taking a new backup,
including when prepared switches or adoption objects remain. Outside a recorded recovery state,
either adoption table makes preconditions refuse the rerun with recovery instructions before
touching services or configuration. A recorded startup boundary also refuses the rerun even when
markers are missing. Inspect the recorded phase, live containers, switches and backup. Manual
restoration requires confirming that no writer has restarted since the rollback backup, including
through another deployment or operator command. Keep writers stopped and manually restore the
verified archive only before that boundary; once any engine startup was attempted, repair forward.
Never start an old SQL writer against an adopted or partially adopted
database. Never erase adoption markers or create empty scopes to bypass a failed gate.

`schema.sql` is safe to reapply after adoption: gym legacy history changes and trigger creation are
guarded by `gym_sync_adoptions`, journal legacy scale conversion is guarded by
`journal_sync_adoptions`, and journal scale constraints are created only when missing. The
real Postgres `schema_reapplication_test.py` compares complete schema dumps and catalog identities,
plus seeded adopted rows and `xmin`; a separate nonadopted catalog comparison proves that ordinary
legacy deployments retain the original schema byte for byte. `products_cutover_test.py` exercises
the production wrapper against real seeded Postgres: success, restoration and row comparison for
failures at backup/adoption/pre-start, SIGKILL recovery at each phase, fixture refusal, and both
ordinary-deploy guards with the old environment and containers preserved.

The real Docker counterpart is `backend/test/deploy/cutover_compose_e2e.sh`. Run it from this
checkout on an idle local Docker host with Python 3, Git, Buildx and Compose v2 installed and an
`origin/main` reference available:

```sh
bash backend/test/deploy/cutover_compose_e2e.sh --dry-run
bash backend/test/deploy/cutover_compose_e2e.sh
```

It builds runtime images from this checkout and `origin/main`, creates an isolated production
compose layout, and seeds two accounts' gym and journal histories through REST. Authentication
fixtures use SQL; external providers are disabled. Local test substitutions use HTTP site addresses,
a random loopback port, local image pull policies, and an inert healthy model sidecar. The database,
server, Caddy, migration commands, and deploy/cutover scripts are real. Checks cover the image
upgrade, exact rollback rows and running configuration after a forced pre-start failure, successful
adoption and unchanged reads, both audits, sync's 404, post-adoption writes, all three disabled-switch
deploy refusals, an applied Caddyfile change, and a same-candidate retry after SIGKILL between file
promotion and Caddy recreation. Each check prints PASS or FAIL. The exit handler
removes its containers, volumes, network, Buildx builder/cache and newly created or pulled images.
