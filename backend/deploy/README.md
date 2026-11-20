# Deploying windmill-backend

Backend CI publishes the server, embedder, subscription and AI service images. The deploy workflow runs
the stack on one VPS under `docker compose`. That second workflow runs itself, and refuses to run on
anything but a SUCCESSFUL `push`-triggered Backend CI/CD on `main` — a red `ctest`, a branch, or a
pull request all stop at the image. It deploys the sha that passed, never `:latest`, so two pushes in
a row cannot ship each other's binary. A manual dispatch runs from `main` and requires a full image
commit SHA. The server, migration, subscription and AI services are pinned to the inspected Docker
content IDs before promotion.
Every candidate carries `sync-compatibility.json`, generated from the same composed registries as its
binary. A missing manifest or unreadable live hello stops deployment before migration, environment
promotion or container replacement. Any change to the minimum accepted schema needs the manual
acknowledgement described below; ordinary backend batches cannot make that cutoff.

Deploys, Web Deploy on `main`, the production backup, the digest resum and the roadmap copy run one at a
time under the `deploy-vps` lock; a pull request's runs never take it. GitHub keeps one waiting run per
lock and cancels it when another arrives. A newer backend deploy replaces an older one safely, but a
waiting Web Deploy cancelled by a backend deploy is not replaced: after merges that land close together,
check the Web Deploy run of the last merge that touched the web and re-run it if it was cancelled.

```
 push to main ─▶ test (ctest in builder image)
                   └▶ build-and-push (server, embedder, subscriptions and AI images ─▶ ghcr.io)
                        └▶ deploy.yml, automatically, on that run's success

 (or by hand) run deploy.yml ─▶ render ~/windmill/.env ─▶ ship compose + Caddyfile ─▶ prune + pull + up + migrate

 VPS
 ┌──────────────────── docker compose (private network) ────────────────────┐
 │  caddy :80/:443  ─▶  server :8080   (HTTP + WebSocket + MCP at /mcp)      │
 │       │          ─▶  subscriptions :8082 (/v1/stores/* only)              │
 │       │          ─▶  ai :8084 (/v1/calls/* and /v1/allowance)               │
 │       │          ─▶  /srv/windmill-web (the rsynced SPA, file_server)     │
 │       │              subscriptions :8083 (internal-doors: server only)    │
 │       │              ai :8085 (internal; this network only)               │
 │       │              embedder :8081  (journal echo vectors; model mount)  │
 │       │              migrate (one-shot: applies db/schema.sql)            │
 │       │              subscriptions-db, then ai-db (one-shot ledgers)     │
 │       │              db     :5432   postgres 16  (volume: pgdata)         │
 └───────┴──────────────────────────────────────────────────────────────────┘
   only :80/:443 are exposed, and only to Cloudflare's ranges
```

## What lives where

| Piece | File |
| --- | --- |
| Build (Drogon + libpqxx, compile, `ctest`) | `backend/Dockerfile` |
| Build + test + publish the images (on push to `main`) | `/.github/workflows/backend.yml` |
| The AI service image and its own checks | `/services/ai/Dockerfile`, `/.github/workflows/ai.yml` |
| The subscription service's image and its own checks | `/services/subscriptions/Dockerfile`, `/.github/workflows/subscriptions.yml` |
| Deploy to the VPS (automatic on a green Backend CI/CD; renders `~/windmill/.env`) | `/.github/workflows/deploy.yml` |
| VPS runtime topology | `deploy/docker-compose.yml` |
| Promote the candidate files, prove Caddy loaded them, verify both ledger databases and start their services (runs on the VPS) | `deploy/deploy-production.sh` |
| Disk report, and by choice a clean of unused images, build cache and the journal beyond 200 MB (by hand) | `/.github/workflows/ops-disk.yml` |
| Count how the roadmap's pointers between trees meet one owned subtree per step (by hand, never during a deploy; reads only) | `/.github/workflows/ops-subtree-inventory.yml` |
| Copy roadmap's rows for a rehearsal of its cutover, encrypted to the owner (by hand, with the owner's approval; reads only), and the test of what it prints | `/.github/workflows/ops-roadmap-copy.yml`, `test/deploy/ops_roadmap_copy_test.py` |
| Generate image metadata, guard the cutoff and verify sync admission | `deploy/sync_compatibility.py` |
| TLS + reverse proxy, and the test that drives it against stand-ins for all public upstreams | `deploy/Caddyfile`, `test/deploy/caddyfile_routes_test.py` |
| The subscription service's database, its role and its `pg_hba.conf` rules (the `subscriptions-db` one-shot; shipped as `subscriptions-db.next` and promoted with the compose file) | `deploy/subscriptions-db/` |
| The AI ledger's database, role and HBA rules, serialized after subscription provisioning | `deploy/ai-db/` |
| Env keys the deploy renders | `deploy/.env.example` |

## One-time VPS bootstrap

1. **Install Docker + compose v2**:
   ```sh
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker "$USER"   # log out/in so the deploy user can run docker
   ```
2. **Open the firewall**: inbound `22` from anywhere, and `80`/`443` from Cloudflare only.
   ```sh
   sudo ufw allow 22/tcp
   for cidr in $(curl -sf https://api.cloudflare.com/client/v4/ips \
                 | jq -r '(.result.ipv4_cidrs + .result.ipv6_cidrs)[]'); do
     sudo ufw allow proto tcp from "$cidr" to any port 80,443
   done
   sudo ufw --force enable && sudo ufw status numbered
   ```
   Caddy refuses non-Cloudflare traffic with a 403 too (the `(cloudflare_only)` gate in
   `deploy/Caddyfile`); the firewall is the layer that survives a Caddyfile mistake.

   A visitor from a range not in the list gets a connection timeout — the site is up for most people
   and dead for some. Re-run the loop whenever a deploy logs a changed list, and prune old rules with
   `sudo ufw status numbered` / `sudo ufw delete <n>`.

   Port 22 is deliberately not restricted, so a bad list is recoverable over SSH:
   `sudo ufw allow 80,443/tcp`, fix, re-tighten (`sudo ufw disable` from the provider's serial
   console if SSH is gone too). Certificate issuance direct to the origin needs 80 wide open — a
   non-issue while DNS is proxied, but re-open 80 on a grey-clouded record until the cert issues.
3. **DNS**: point `DOMAIN_APP` and `DOMAIN_API` A records at the VPS IP. Certs will not issue until
   this resolves.
4. **Authorize the CI key**: append the deploy public key to the SSH user's `~/.ssh/authorized_keys`.

The deploy job creates `~/windmill/` and everything under it.

## GitHub configuration

**Secrets** — Settings → Secrets and variables → Actions → Secrets:

| Secret | Value |
| --- | --- |
| `SSH_HOST` | VPS IP or hostname |
| `SSH_USER` | deploy user (must be in the `docker` group) |
| `SSH_PORT` | SSH port (e.g. `22`) |
| `SSH_KEY` | CI deploy **private** key (whole PEM) |
| `POSTGRES_PASSWORD` | Postgres password |
| `AI_DB_PASSWORD` | AI database role password, 64 lowercase hex characters |
| `AI_PASS_PRIVATE_SEED` | Optional backend-only Ed25519 32-byte private seed as unpadded base64url; empty leaves its pass door unmounted |
| `AI_CARRY_KEY` | 32 random bytes encoded as unpadded base64url |
| `AI_FUNDING_SECRET`, `AI_OPERATOR_SECRET` | Distinct 32–256 character bearer secrets; ASCII letters, digits, `_`, `-` |
| `SUBSCRIPTIONS_DB_PASSWORD` | The subscription database role's password, 64 lowercase hex characters ([below](#the-subscription-database)) |

**Variables** — same page → Variables:

| Variable | Value |
| --- | --- |
| `DOMAIN_APP` | the single origin (SPA + path-routed backend), e.g. `example.com` |
| `DOMAIN_API` | alias for the API host, e.g. `api.example.com` |
| `ACME_EMAIL` | Let's Encrypt contact address |
| `RESEND_FROM` | verified sender address |
| `AI_PASS_KID`, `AI_PASS_MIN_VERSIONS` | Optional backend issuer key ID and JSON profile minimum versions; required when its seed is set. Compose fixes its environment to production |
| `AI_PASS_KEYS` | JSON object mapping key IDs to 32-byte public keys encoded as unpadded base64url; `{}` keeps public AI admission dark |
| `WINDMILL_MCP_ALLOWED_ORIGINS` | comma-separated Origins, or empty for all |

Those two tables are the minimum that makes the deploy run, not the whole set. Every other key —
vendor credentials, admin bearers, the reminder and nudge arming pairs — is read by `deploy.yml`'s
`env:` block and written by its hand-maintained key list. **That file is the authority**: a name in
`env:` but missing from the list is never written and is unsettable from GitHub. Add a key in both
places, and describe it in `deploy/.env.example`.

`GITHUB_TOKEN` publishes the images to GHCR. The VPS pulls them anonymously, so the GHCR package
must be public.

## Day-to-day

- **Deploy**: automatic on every green Backend CI/CD run on `main`; Actions → Deploy to VPS → Run
  workflow is the by-hand path. It rewrites `~/windmill/.env` wholesale from GitHub secrets +
  variables — only `POSTGRES_PASSWORD` is preserved from the host — and refuses before touching the
  box if `DOMAIN_APP`, `DOMAIN_API`, `ACME_EMAIL`, `POSTGRES_PASSWORD`, `SUBSCRIPTIONS_DB_PASSWORD` or
  `RESEND_FROM`, `AI_DB_PASSWORD`, `AI_CARRY_KEY`, `AI_FUNDING_SECRET` or `AI_OPERATOR_SECRET` is unset.
  `CF_IPS` is configured nowhere: the job fetches Cloudflare's live edge list, falls back to the
  committed default in `deploy/docker-compose.yml`, and refuses on the same guard if both come back
  empty — an empty allow-list would make Caddy 403 the whole site.
  Success also requires the running server's image reference and content ID to match the pulled
  image, a hello advertising that image's exact schema/minimum, and the PID 1 allowance mode and
  Coach output cap to match resolved Compose configuration. Readiness is retried up to 30 times;
  each probe has a timeout. The excluded boundary schema and every previously supported schema
  removed by the cutoff must return `426 upgrade-required` at hello, push, pull and WebSocket
  upgrade. The runtime receipt names the checks that passed. Last, the `subscriptions-db` one-shot must
  pass ([below](#the-subscription-database)) and the subscription service must turn healthy on its pinned
  image ([below](#the-subscription-service)). Then AI provisioning and its service must pass
  ([below](#the-ai-service)). Credentials and failed command output are never
  dumped. This proves configuration reached PID 1 and the selected
  image serves HTTP; output-cap enforcement requires a binary that supports that setting.
- **Logs**: `cd ~/windmill && docker compose logs -f server` (or `caddy`, `db`, `embedder`, `subscriptions`, `ai`).
- **Status**: `docker compose ps`.
- **Rollback**: dispatch the deploy workflow with `image_tag` set to the chosen commit SHA. The
  server and `embedder-<sha>` images must exist, and the server image must contain its compatibility
  manifest. A commit with no `subscriptions-<sha>`, as one built before Backend CI published the service,
  deploys its backend and leaves the running subscription container as it is, never recreating it, printing
  `NOTE subscription service: no image could be pulled for this commit, so its running container is kept as
  it is, on sha256:…` and `PASS subscription service: its running container kept, not recreated, healthy on
  its image`. On a host where no subscription container runs, it is refused before anything changes with
  `FAIL no subscription service image could be pulled for this commit, and none runs here to keep`. A
  `subscriptions-<sha>` built before the internal doors (`subscriptions · the backend reads the feed and each
  account behind the internal listener's secret`) cannot read the alias compose gives it in
  `SUBSCRIPTIONS_INTERNAL_ADDRESS`: rolled back to, it exits at start with `SUBSCRIPTIONS_INTERNAL_ADDRESS is
  malformed` and restarts in a loop, the run turns red at its health check, and Caddy answers `/v1/stores/*`
  with 502; dispatch with that commit or a newer one. Only the images go back: the run renders `.env` and ships `docker-compose.yml`, the Caddyfile and
  `deploy-production.sh` from the branch it is dispatched on (`main` only), and `migrate` applies the
  selected image's own `db/schema.sql`.
  A lower minimum is a compatibility change too and requires exact manual acknowledgement. That
  acknowledgement does not make old binaries safe for data written under newer rules.
- **Rollback floor**: the oldest image that is safe to run is the first one built from a commit
  containing `backend · purge the retired gym and journal cutover copies`. After the purge, use only
  that image or its descendants: earlier image schemas recreate retired cutover storage and their
  binaries depend on it. For roadmap trees the floor is `0255cb907`: `tree_nodes` holds no `pos_x`,
  `pos_y` or `pos_hlc`, an earlier image writes them on every tree save, and no image's schema puts
  them back. Restoring a pre-engine backup is unsupported. A restore from an engine-era
  backup must apply the current schema before starting writers and regenerate `sync_meta.epoch`
  as [the engine restore contract](../../docs/foundation/engine.md) requires.
- **Migrations**: `db/schema.sql` is idempotent and re-applied on every deploy by the `migrate`
  one-shot, a plain `psql`. It removes the retired gym and journal cutover copies while keeping
  the engine tables and current user data.
- **Native Apple sign-in**: the identity-token exchange defaults off (`APPLE_NATIVE_ENABLED=0`);
  [AUTH.md](../AUTH.md) names its audience and app configuration.
- **Backup**: the dispatch-only `gym-backup.yml` writes a custom-format dump of the products database,
  and separate dumps of the subscription and AI databases once provisioned, to
  `~/windmill/backups/` on the VPS, checks that `pg_restore --list` names each one's database, and
  records each sha256.
  Dumps made before the cutover-copy purge retain those copies. The repository defines no scheduled
  database backup or backup rotation; this workflow keeps each dump until it is removed manually.
  The cutover evidence purge does not touch this directory. Host-managed cron jobs and provider
  backup policies must be checked on the host and with the provider.
- **DB shell**: `docker compose exec db psql -U windmill windmill`.
- **Disk**: every deploy prunes images no container uses and the Docker build cache before it pulls,
  so the host keeps the live images plus the candidate; volumes are never pruned. Actions → Ops · VPS
  disk → `report` prints `df`, Docker usage, image and container sizes and `~/windmill` by folder;
  `clean` also prunes images and build cache and, where the deploy user has passwordless sudo, trims the
  systemd journal to 200 MB. Neither touches volumes, containers or `~/windmill/backups`.

## The AI service

The AI container serves public port 8084 and internal port 8085 on the private Compose network.
Caddy routes exactly `/v1/calls/*`, `/v1/pictures/*` and `/v1/allowance` to 8084 before the backend catch-all, and
preserves WebSocket upgrades. It strips the product session cookie and installation header. Caddy's
global runtime log encoder removes request objects and headers, including on upstream errors, so
neither passes in `Sec-WebSocket-Protocol` nor caller IDs in URLs enter those logs.

`windmill_ai` is a separate database owned by the nonsuperuser role `windmill_ai`. The `ai-db`
one-shot runs after `subscriptions-db`, giving the shared HBA file one writer at a time. Its rules
admit only that role to its ledger, reject every other role (including the backend's superuser),
and deny its role access to all other databases. Before reloading, it validates that the backend
can still connect; after reloading, it probes that path and restores the old HBA file on failure.
Both TCP and local socket paths use these rules. The AI process migrates its ledger on startup.

A deployment validates the AI credentials and pins `ai-<sha>` to its immutable image ID before
promoting any files. When that tag is absent, an existing pinned AI image may be retained; a fresh
host is refused. AI provisioning and startup happen after backend verification, so an AI startup
failure makes deployment red while the backend continues serving. The process has a read-only root,
a small memory-backed `/tmp`, no host ports, no Linux capabilities, no privilege escalation and
core dumps disabled. Its image contains the release identity used by Sentry.

Docker allows AI 720 seconds to stop, beyond its 660-second drain and 600-second text-call deadline.
The infrastructure check asserts this ordering. The deploy waits for graceful replacement and then
for ledger-backed health. `/health` is readiness of the process and ledger; it does not contact a
provider. The optional `AI_ANTHROPIC_KEY`, `AI_OPENAI_KEY` and `AI_AZURE_KEY` reach only this container.
Existing backend provider credentials remain while their feature callers have not migrated.

The new required secrets must be configured before this deployment path runs. Generate each database
and internal bearer secret separately with `openssl rand -hex 32`. Generate the carry key with
`openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'`. Keep that key stable across releases so
existing carry remains readable. `AI_PASS_KEYS={}` is the default; opening caller admission requires
production issuer public keys. Transcription also needs an active One grant and a configured
provider. Its billing verification is a deployment acceptance gate in the service runbook; no
deployment command performs a billable provider call.

The backup workflow dumps this database as its own role, verifies `pg_restore --list` identifies
`windmill_ai`, and records a checksum separately from product and subscription dumps. Recover an AI
HBA block that was edited manually by removing only the lines between `# BEGIN windmill_ai` and
`# END windmill_ai` from the cluster's HBA file as its OS user, reloading Postgres, then rerunning
`ai-db`; do not remove the subscription block.

### Restore the AI database

Replacing production accounting data needs the owner's approval. Pause deployments and persist
`AI_PASS_KEYS={}` in both the deployment configuration and the host's `.env` before restoring.
Keep the previous public-key set securely for the later decision to reopen admission. Stop AI;
the product and subscription services can keep serving.

From `~/windmill`, verify the dump's recorded checksum and `pg_restore --list` identifies
`windmill_ai`. Then restore through its own role:

```sh
set -eu
AI_RESTORE_DUMP="$PWD/backups/<ai-backup>.dump"
export PGPASSWORD=$(sed -n 's/^AI_DB_PASSWORD=//p' .env)
docker compose stop ai
docker compose exec -T db dropdb -U windmill windmill_ai
docker compose run --rm --no-deps -T ai-db
docker compose exec -T -e PGPASSWORD db pg_restore -U windmill_ai -d windmill_ai \
  --single-transaction --exit-on-error --no-owner --no-acl < "$AI_RESTORE_DUMP"
docker compose up -d --no-deps --pull never ai
docker compose exec -T ai curl -fsS http://127.0.0.1:8085/health
```

Startup migrates the restored database and ends orphan reservations conservatively. Results were
memory-only and cannot be restored. Inspect assumed calls and pinned budgets through the internal
doors in [the AI runbook](../../services/ai/RUNBOOK.md). Keep caller admission closed until the
owner has reconciled the interval after the backup with provider accounting: a backup cannot
recover missing calls or their charges, and restoring an older fuse total is not evidence of new
spending capacity. Reopening admission is a separate decision after that accounting gap is settled.

## What a deploy does to the running server

Every deploy replaces the server's container, a commit that changes only `services/subscriptions`
included: Backend CI builds and deploys every image for each commit it runs on. While the old container
stops and the new one starts, Caddy answers 502 to a request the server does not take. A deploy that
ships a changed Caddyfile also recreates Caddy, which refuses connections until it listens again. A
rehearsal of such a deploy on a stand-in server, probing the edge every 0.2 s, saw about 2 s of 502 and
then about 1 s of refused connections.

`docker compose up -d` replaces the server's container: Docker sends it `SIGTERM`, waits
`stop_grace_period`, then sends `SIGKILL`. Two numbers decide whether the server gets to finish, and
they are kept together:

| What | Value | Where |
| --- | --- | --- |
| The server's deadline for everything still running after the signal | 5 s | `RoomRegistry::kShutdownSaveBudget` |
| The time Docker gives the container to stop | 10 s | `stop_grace_period` of `server` in `docker-compose.yml` |

At the signal the server takes no new write on any door: a new connection is refused, an open one
is closed once the request on it has been answered, and a request that still reaches it is answered
a bare `503`. It saves what is in flight and what its rooms still hold. A stop that is over inside
the 5 s ends by itself. One that is not is cut there, whatever is still running: the server logs
`server_stop outcome=cut-at-deadline`, then `roadmap_tree_save outcome=lost-at-shutdown rooms=N` for
the rooms that hold a write the store does not. Either way it writes out its log and its failure
reports within 3 s more (`ProcessStop::kExitFlushLimit`), leaving reports it cannot send by then,
and exits 0 (`SPEC.md`, "The server stops in one order").
The 10 s is that deadline, the 3 s, and room to spare, rounded up; a stop cut at the deadline
with no report left to send measures 5.0 to 5.1 s. Compose's own default, were the line removed, is also 10 s, and stating it
is what keeps the two numbers together: a server killed at the end of the grace period loses what it
had acked and not stored without the `lost-at-shutdown` line, so the deadline may be raised only
with the grace period, and the `deploy_stop_grace` check in ctest fails when the grace no longer
covers both. The first deploy that carries a new `stop_grace_period` stops the old container under
the grace that container was created with, so a changed value holds from the deploy after.

## Coordinated client cutoff

The repository registry is schema 12 / minimum 11. Every schema in that interval carries explicit gym
`other`, finite normalized loads without a fixed kg cap, nullable derived metrics and sets without a kind. Production hello advertises
schema 12 / minimum 11, verified on 2026-11-01 after
[deployment 41306516632](https://github.com/neigrok/windmill-monorepo/actions/runs/41306516632).
The latest published Android release is [0.14.0 / code 277](https://github.com/neigrok/windmill-monorepo/releases/tag/android-v0.14.0),
tag `android-v0.14.0` at `3b136a3d`. iOS 0.2.0 (23) is uploaded and VALID,
with internal READY_FOR_BETA_TESTING and external READY_FOR_BETA_SUBMISSION; intended tester access
is unverified. [Digest resum 41101251226](https://github.com/neigrok/windmill-monorepo/actions/runs/41101251226)
completed across three scopes and corrected two digests. Web Deploy promotes each web push to `main`
once the live hello admits it. The last complete promotion is
[run 41325909004](https://github.com/neigrok/windmill-monorepo/actions/runs/41325909004), source `6aabcde2`.
The run before it, 41319412052, failed mid-rsync with no space left on the VPS; the host's free disk
is not monitored. Queued client delivery and final native
availability remain unverified. The deployment guard requires exact acknowledgement for any further minimum change.

1. Keep a schema 11 / minimum 11 maintenance image available. Automatic deployment
   refuses a candidate minimum that differs from the live server.
2. Prepare schema 11 readers on every surface. Preserve stored equipment/count values, exact zero,
   absent targets and pending writes. Web Deploy retains the complete pinned `dist`, source/file-hash
   manifest and composed compatibility artifact before checking the live anonymous hello. It holds
   promotion before mkdir/rsync unless live schema is at least the client minimum and live minimum
   accepts the client schema; incompatible or unreadable state leaves the served web files intact.
   New selectors require their own
   design approval. Each bound sender keeps writes ready until an owner/token/replica/epoch-matched
   fresh hello advertises a server schema at least the client's generated registry minimum.
3. Verify the signed Android update over the public replacement floor, including retained local work
   and delivery against the schema 11 server. Upload the exact iOS version/build through the manual
   `ios-release.yml` workflow and check processing, beta readiness and intended tester availability.
   Verify both native replacements against the schema 11 candidate, publish the Android release,
   and verify both upgrade destinations. TestFlight status alone proves no tester access.
4. Record the full backend commit SHA and immutable Docker image ID (`docker image inspect --format
   '{{.Id}}' ghcr.io/neigrok/windmill-monorepo:<sha>`). Read the live minimum again, then dispatch
   **Deploy to VPS** from `main` with that `image_tag`, its exact `expected_old_minimum`,
   `expected_new_minimum=11` and `expected_image_id`. Both raises and lowers require exact
   acknowledgement. An interrupted attempt reads live state again. A fresh host uses old minimum 0.
5. Verify `windmill_resum_sync_digests` completed ("Resum the scope digests" below), then verify schema 11 /
   minimum 11 at hello and schema 10 or older `426 upgrade-required` refusals at
   hello, push, pull and WebSocket upgrade. Active Gym HTTP routes require the generated minimum
   header and return `426 client-update-required` for missing/old carriers before JSON, image or
   SSE delivery. Verify queued native/web work delivers only after a fresh compatible hello. Cached
   web and old native clients retain local work and show their existing update-required surface.
   Retry the held Web Deploy run after the backend is compatible, or dispatch the exact accepted
   main source. Each attempt retains a separate pinned web artifact; inspect its full source SHA,
   schema and file hashes. The preflight reads the current compose deployment and promotes no
   backend state. Verify the new web release and real queued delivery after promotion.
6. Keep a schema 11 / minimum 11 maintenance image available before accepting the new load range
   or nullable metrics. Roll back only to a compatible image; do not reopen old parsers or numeric
   column caps. Automation resumes when candidate and live minimum match. Server and migration use
   the same pinned image ID.

The guard queries anonymous hello with a high schema header to read live metadata even during a
manually acknowledged downgrade. This is a metadata read, not a client capability claim. It neither
uses account credentials nor changes the running stack. It runs after candidate validation/pull and
before any candidate migration or promotion.

## Restore a database backup

Keep deployments paused and stop any database writers outside this Compose stack. Close client
ingress first; restore, migrate, rotate and verify the epoch with the server stopped, then restart
the server before reopening ingress. This avoids serving the restored database under its saved
epoch, but cannot force a reconnecting client to pull before pushing. Use an image compatible with
the dump and containing `windmill_rotate_sync_epoch`. From `~/windmill`, verify the backup's recorded
sha256 and `pg_restore --list` before replacing the database. Each actual restore, including another
restore of the same dump, needs a fresh random epoch.

```sh
set -eu
RESTORE_DUMP="$PWD/backups/<backup>.dump"
RESTORE_DIR=$(mktemp -d "$PWD/backups/restore-XXXXXXXX")
openssl rand -hex 16 > "$RESTORE_DIR/new-epoch"
docker compose stop caddy
docker compose stop server migrate
docker compose exec -T db dropdb -U windmill windmill
docker compose exec -T db createdb -U windmill -O windmill windmill
docker compose exec -T db pg_restore -U windmill -d windmill \
  --single-transaction --exit-on-error --no-owner --no-acl < "$RESTORE_DUMP"
docker compose run --rm migrate
docker compose exec -T db psql -U windmill -d windmill -XAt \
  -v ON_ERROR_STOP=1 -c 'select epoch from sync_meta' > "$RESTORE_DIR/old-epoch"
docker compose run --rm --no-deps -T server windmill_rotate_sync_epoch \
  "$(cat "$RESTORE_DIR/old-epoch")" "$(cat "$RESTORE_DIR/new-epoch")" \
  >> "$RESTORE_DIR/epoch.log" 2>&1
cat "$RESTORE_DIR/epoch.log"
test "$(docker compose exec -T db psql -U windmill -d windmill -XAt \
  -v ON_ERROR_STOP=1 -c 'select epoch from sync_meta')" = "$(cat "$RESTORE_DIR/new-epoch")"
docker compose up -d server
docker compose up -d caddy
```

Keep the restore directory as the receipt. If rotation times out, is interrupted or its answer is
lost, retry **only the tool command** with those same two saved epochs. It locks `sync_meta` and
commits one update; concurrent/repeated calls with the same pair return `already-applied` without
writing. An unexpected current epoch refuses with `epoch-mismatch`. Exit 0 means rotated or already
applied, 2 means invalid arguments/configuration or a mismatch, and 1 means an unexpected failure.
On any failure, keep the server stopped; inspect the completion before retrying. Do not regenerate
the receipt, read a new expected epoch, or rerun `pg_restore` as a rotation retry. Ordinary deploys
and process restarts never rotate the epoch.

The tool uses `DATABASE_URL` and the server's Sentry settings. It emits a structured
`sync.epoch.rotate` completion (`ok`, `already-applied`, or a refusal/failure) with duration, without
credentials or epoch values. Rotation changes only `sync_meta.epoch`, leaving restored rows intact.
When a client processes the epoch change, it clears cursors and staging, re-identifies and
rebootstraps. This single durable transition retains unsent entries and returns still-pending
old-epoch acknowledgements to ready at their original commit positions, ahead of dependent edits
and deletes. A validated, authenticated push success or replica conflict with a changed epoch
triggers recovery before retry, including a `409 gap`, so recovery works whether push or pull
arrives first. When no older acknowledgement needs replay, a successful changed-epoch response is
recorded atomically with that transition. Otherwise the older work replays first. A command retains
its resolved identities so its next write map moves pending dependents to the recreated record's
id and `born`, even when earlier starts joined a different session. Later retained commands that
shared that target also follow it, preventing replay from creating a second session. Successful
proposal applies have durable server receipts, so replay cannot turn an applied removal into a
refusal after its routine and proposal have been deleted. If another replica's delete arrives before
a retained create, the server stores the absent record's death so the later create cannot resurrect
it. A delete aimed at a live record with a different `born` is refused `unknown-record`, keeping the
delete in a notice.

While the client's local store survives, work still owed by its outbox survives the restore
([spec §7.5](../../docs/foundation/engine.md#75-puller-reset-and-epoch-change)). Recovery replays it
in commit order; an unreplayable intent is refused with its content retained in a notice. Fully
settled server writes newer than the backup are lost; rotation cannot reconstruct work no client
still owes. Restoring a backup also cannot recover a cleared or lost client store.
These guarantees require both the updated server and updated clients. Older clients can settle a
dependent delete before replaying its source; older servers can acknowledge an absent delete
without preserving its death or lack a successful command's durable replay receipt. Epoch rotation
alone cannot correct those implementations.

## The subscription service

`subscriptions` runs the Windmill One subscription service
([ARCHITECTURE.md](../../services/subscriptions/ARCHITECTURE.md)) from
`ghcr.io/neigrok/windmill-monorepo:subscriptions-<sha>`, the image Backend CI builds from
`services/subscriptions` for the same commit as the server's. The public listener answers `GET /health`
and the App Store notification door, `POST /v1/stores/app-store/notifications`, which trusts Apple's root
alone, and 404s every other path; no App Store Connect setting sends notifications to it yet.

- **Routing**: Caddy forwards `/v1/stores/*`, on both hosts and behind the Cloudflare gate, to the public
  port, 8082, and nothing else; the server never sees such a path. Under `/v1/stores/app-store/` it
  answers 403 to any client whose `CF-Connecting-IP` is outside 17.0.0.0/8, the one subnet Apple documents
  for App Store Server Notifications, so a probe of the door from anywhere else is refused at the edge; to
  probe the service itself, `docker compose exec -T subscriptions curl` it on its own port. The internal port,
  8083, is published nowhere and no Caddy route names it. The internal listener binds `subscriptions-internal`,
  the service's alias on `internal-doors`, an `internal: true` network only the server shares, so Caddy and
  the embedder cannot reach it; its doors also ask for `SUBSCRIPTIONS_INTERNAL_TOKEN`
  ([below](#windmill-one-the-entitlement-copy)).
- **Healthy** means the image's `HEALTHCHECK`, a `curl` of the internal listener's `/health` every 10 s,
  answers 200 `{"status":"ready"}`: the service opened and migrated its ledger before it listened, and the
  ledger answers. Three failures in a row make it `unhealthy`. Docker restarts the container when its
  process exits (`restart: unless-stopped`), never because it is unhealthy.
- **Status**: `docker compose ps subscriptions` shows `(healthy)`, and
  `docker compose exec -T subscriptions curl -s subscriptions-internal:8083/health` prints the answer.
- **Logs**: `docker compose logs -f subscriptions`, one JSON object per line: `ledger open` with the
  ledger's epoch at start, then one line per request, one `store.notification` line per App Store
  delivery with its `outcome` and `code`, and one `sweep.inbox` line for each sweep pass that met a row. Its Logs and failure reports go to the server's
  Sentry project under the same environment, with the commit the image was built from as release; the
  `operation` tag, such as `ledger.open`, names a failure.
- **Restart**: `docker compose restart subscriptions`. It stops within Docker's 10 s and exits 0.
- **In a deploy**: `deploy-production.sh` pins the service to the content ID it pulled
  (`SUBSCRIPTIONS_IMAGE` in `.env`) before anything changes and starts it with
  `docker compose up -d --no-deps --pull never subscriptions` once the backend is verified and
  `subscriptions-db` has passed. AI provisioning follows the subscription service's health check.
  It waits up to 60 s for `healthy`, checks that the container runs the
  pinned content ID, and prints `PASS subscription service: healthy on its pinned image`. Otherwise it
  prints `FAIL subscription service …; the backend is deployed and serving` and the run is red, with the
  container it started left as it is and nothing rolled back; while the service is down, Caddy answers
  `/v1/stores/*` with 502. A `subscriptions-db` FAIL ends the run before this step and leaves the running
  service as it was. A commit without its own `subscriptions-<sha>` keeps the live service's container as it runs
  ([Rollback](#day-to-day)).
- **What gates it**: Backend CI calls the service's own checks, `subscriptions.yml`, as a job its image
  publish needs, so a red check publishes no image and deploys nothing. A commit under
  `services/subscriptions` deploys the whole stack and replaces the server's container too
  ([What a deploy does](#what-a-deploy-does-to-the-running-server)).

## The subscription database

The subscription service keeps its ledger in `windmill_subscriptions`, a database of its own in this
cluster, owned by a role of the same name. The `subscriptions-db` one-shot
(`deploy/subscriptions-db/provision.sh`) provisions the database on every `docker compose up`, so on
every deploy and against the existing volume, as `migrate` applies the schema. Its `psql` connects as the
backend does, as `windmill` over the network to the backend's database.

1. It puts the rules in `deploy/subscriptions-db/pg_hba.conf` at the head of the cluster's
   `pg_hba.conf`, between lines starting `# BEGIN windmill_subscriptions` and
   `# END windmill_subscriptions` that each run replaces. A live file holding a block with no end stops
   the run with the file as it was. A rewrite that does not parse, or whose first rule for `windmill` on
   its database, over the network or the socket, rejects it, is never put in force. Otherwise it holds a
   session of `windmill` open, reloads Postgres, and waits until `windmill` is refused
   `windmill_subscriptions` while a fresh connection of `windmill` still reaches its own database; when
   either does not hold, it puts the previous file back and reloads through the held session. Unchanged
   rules already in force are not reloaded. To write the file it mounts the `pgdata` volume and runs as
   the cluster's OS user; it never starts a Postgres.
2. It creates the role and the database where they are missing, sets the role's password to
   `SUBSCRIPTIONS_DB_PASSWORD`, makes the role the database's owner and revokes the database from
   `PUBLIC`. A changed secret is the role's password from the next deploy on. That session logs no
   statement on the server, since one carries the password.
3. It signs in as the role, checks that the backend's database refuses the role, and that `windmill`
   still reaches its own database.

It ends in one line, `PASS subscriptions database: …` with `rules installed` or `rules unchanged`, or
`FAIL subscriptions database: <what failed>` on stderr with exit code 1. Only the subscription service
waits on it, so it never holds up the backend. `deploy-production.sh` reads its outcome once the backend
is verified and prints that line; a FAIL turns the deploy run red, while the backend it deployed stays up
and serving.

The GitHub secret `SUBSCRIPTIONS_DB_PASSWORD` is the role's password, generated as hex so it sits in the
service's `postgres://` URL unescaped:

```sh
openssl rand -hex 32
```

The render refuses to deploy while the secret is missing or holds anything else, naming the variable and
never its value. The first deploy with it prints `PASS … (rules installed)` and each one after it
`PASS … (rules unchanged)`; on the host `docker compose exec -T db psql -U windmill windmill_subscriptions
-c 'select 1'` fails with `pg_hba.conf rejects connection`. Run without the password, as a local compose
may be, the one-shot prints `SKIP subscriptions database: SUBSCRIPTIONS_DB_PASSWORD is not set, so
nothing was provisioned`, exits 0 and touches nothing: no rule, role or database.

- **What the rules hold**: a `pg_hba.conf` rule binds `windmill` although it is the cluster's
  superuser, so no connection as the backend's role reaches the database, from its container or over
  the cluster's own socket. The role `windmill_subscriptions` needs its password on both paths and
  reaches no other database. The rules cannot stop that superuser from reaching the database another
  way when it sets out to: by changing the role's password, by creating a role of its own, granting it
  the database and connecting as it with `dblink` or `postgres_fdw` over the socket, which trusts every
  other role, or by reading the cluster's files or running a program from SQL. Only a backend that
  does not run as a superuser closes that.
- **DB shell**: `docker compose exec db psql -U windmill_subscriptions windmill_subscriptions`, which asks
  for the role's password, `SUBSCRIPTIONS_DB_PASSWORD` in `.env`.
- **Backup**: wherever `windmill_subscriptions` exists, `gym-backup.yml` dumps it as its own role, with the
  password in `.env`, to `backups/subscriptions-<stamp>.dump`, and fails when the dump does not work or
  `pg_restore --list` does not name `windmill_subscriptions`. Where it does not exist, it prints `SKIP
  subscriptions backup: windmill_subscriptions does not exist`.

### Restore the subscription database

Verify the dump's recorded sha256 and its `pg_restore --list` first. A restored ledger takes a new
epoch, every time, so that a reader's cursor from before the restore means nothing after it (spec
§5.2). From `~/windmill`, with deployments paused; the first line stops the service, the only other
client of the database:

```sh
set -eu
RESTORE_DUMP="$PWD/backups/<backup>.dump"
export PGPASSWORD=$(sed -n 's/^SUBSCRIPTIONS_DB_PASSWORD=//p' .env)
docker compose stop subscriptions
docker compose exec -T db dropdb -U windmill windmill_subscriptions
docker compose run --rm -T subscriptions-db
docker compose exec -T -e PGPASSWORD db pg_restore -U windmill_subscriptions -d windmill_subscriptions \
  --single-transaction --exit-on-error --no-owner --no-acl < "$RESTORE_DUMP"
docker compose exec -T -e PGPASSWORD db psql -U windmill_subscriptions -d windmill_subscriptions -XAtq \
  -v ON_ERROR_STOP=1 -c 'update ledger set epoch = gen_random_uuid() returning epoch'
docker compose start subscriptions
```

`subscriptions-db` recreates the database empty, owned by its role and behind its rules; the `update`
prints the new epoch, and the service, started again, logs `ledger open` with it.

### Let the backend in again

Should `pg_hba.conf` ever turn `windmill` away from its own database, `psql` as `windmill` cannot repair
it, over the network or the socket. Write the file the image's `initdb` wrote from a container mounting
the volume, as the cluster's OS user, then have Postgres read it again. From `~/windmill`:

```sh
docker compose run --rm --no-deps -T --entrypoint sh subscriptions-db -ec '
cat > /var/lib/postgresql/data/pg_hba.conf <<HBA
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
local   replication     all                                     trust
host    replication     all             127.0.0.1/32            trust
host    replication     all             ::1/128                 trust
host    all             all             all                     scram-sha-256
HBA'
docker compose kill -s HUP db
docker compose exec -T db psql -U windmill windmill -XAtc 'select 1'
```

Until the next deploy puts the subscription rules back, `windmill` reaches `windmill_subscriptions`.

### Run it locally

The production compose runs the service from a local image when `SUBSCRIPTIONS_IMAGE` names one in
place of the published `subscriptions-<sha>`. From the repository root, with Docker running:

```sh
(
  set -eu
  REHEARSAL_ENV=$(mktemp)
  rehearse() {
    docker compose -p subscriptions-rehearsal --env-file "$REHEARSAL_ENV" -f backend/deploy/docker-compose.yml "$@"
  }
  trap 'rehearse down -v; rm -f "$REHEARSAL_ENV"' EXIT
  docker build -t windmill-subscriptions:local services/subscriptions
  printf 'POSTGRES_PASSWORD=%s\nSUBSCRIPTIONS_DB_PASSWORD=%s\nSUBSCRIPTIONS_IMAGE=%s\nSENTRY_ENVIRONMENT=local\nDOMAIN_APP=app.localhost\nDOMAIN_API=api.localhost\nACME_EMAIL=ops@example.invalid\n' \
    "$(openssl rand -hex 16)" "$(openssl rand -hex 32)" windmill-subscriptions:local > "$REHEARSAL_ENV"
  rehearse up -d --wait subscriptions
  rehearse logs subscriptions-db subscriptions
  rehearse exec -T subscriptions curl -s subscriptions-internal:8083/health
  if rehearse exec -T db psql -U windmill windmill_subscriptions -c 'select 1'; then
    echo 'FAIL the backend role reached windmill_subscriptions'
    exit 1
  fi
)
```

`up` starts only `db`, `subscriptions-db` and the service: a fresh volume, the rules installed, the
service migrating the empty ledger and answering `{"status":"ready"}`. The `psql` line is refused
with `pg_hba.conf rejects connection`, and the stack and its volume are removed however the run ends.
`test/deploy/subscriptions_db_test.py`, which Backend CI runs, drives the one-shot without its
password and over rules and live files that would lock the backend out.

## Resum the scope digests

Run `windmill_resum_sync_digests` once after any deploy whose registry drops or renames a lattice
field. A scope's stored digest is the §6.12 sum over its alive rows as `feed` returns them, and
admission only ever moves it by a difference, so such a registry change leaves every stored digest
stale: each client would hit the §7.5 digest-mismatch reset twice and then stop checking. With the
new server and schema live, dispatch **Resum production sync digests** (`sync-digest-resum.yml`), or from
`~/windmill` on the host:

```sh
docker compose run --rm --no-deps -T server windmill_resum_sync_digests
```

It uses `DATABASE_URL` and the server's Sentry settings, lists the alive scopes, and rewrites each
one's digest from its feed in a transaction of its own under that scope's row lock, leaving `seq`,
counters and `open` as they were; dead scopes are skipped. The server may keep serving meanwhile:
a write that lands between two scopes moves the digest it finds by the same difference either way.
It prints one line, `scopes seen N, digests moved M` — `N` alive scopes summed, `M` of them whose
stored digest differed from the sum — and emits a structured `sync.digest.resum` completion. A
second run prints `digests moved 0`; a run that fails midway leaves the scopes it committed right
and is simply run again. Exit 0 means every scope was summed, 2 means `DATABASE_URL` is unset, and
1 means an unexpected failure.

The [restore proof](../test/e2e/README.md) runs both pull-first and push-first reconnects against a
real dump, restore and epoch rotation. It checks durable reload before and after the epoch
transition, independent acknowledged and unsent creates, dependent offline edits/deletes, and a
replayed command whose new `born` must reach its pending delete. Other replicas delete before a
source replays and after a command without a prediction recreates its record. Bootstrap must leave
the client and server in agreement; the wrong-incarnation delete must remain in a durable refusal
notice, and all other fixture work must settle with its intended effect. Two more runs use the
production composition's test clock: two starts that joined the same session must carry their offline
delete through one changed replay target, and applied removals must retain success with and without
an older acknowledgement to replay. The proof advances the clock five hours before deleting the
joined session, and checks successful callbacks, receipt replay and durable reload.

## Count the roadmap's pointers between trees

Dispatch **Ops · subtree inventory** (`ops-subtree-inventory.yml`), never during a deploy: a deploy's
migration alters `trees`, would wait behind the inventory's read, and would hold every roadmap read
behind it. Its first step refuses to start while any workflow whose concurrency can take the
`deploy-vps` lock (Deploy to VPS, Web Deploy, the production backup, the digest resum, the roadmap copy) has a run queued
or running, a pull request's run aside, since it takes no lock and reaches no server. It then runs
`windmill_subtree_inventory` inside the live `server` container, which already holds `DATABASE_URL`;
the tool never writes, and no credential leaves the host. Its one JSON object of counts ([SPEC.md](../SPEC.md#subtree-inventory)) is
private: this repository's logs are public, and where few accounts hold pointers the counts are one
person's structure. So the runner seals them to `.github/ops/inventory-recipient.pem` as they arrive,
and the job log shows the sealed block and the tool's completion line, nothing else. The certificate is
public; its private key is the owner's and is kept out of the repository. On any failure the job prints
no block and fails; against an image that does not carry the tool, it says so.

To read the counts, save the block, from `-----BEGIN PKCS7-----` to `-----END PKCS7-----`, as
`counts.pem`, and open it with the private key that belongs to the certificate:

```sh
openssl smime -decrypt -inform PEM -inkey <key> -in counts.pem
```

From `~/windmill` on the host, the tool prints the counts in the clear:

```sh
docker compose exec -T server windmill_subtree_inventory
```

Exit 0 means the counts were printed, 2 means `DATABASE_URL` is unset, and 1 means the read failed or
stdout did not take the counts.

## Copy production's roadmaps for a rehearsal

Dispatch **Ops · roadmap copy** (`ops-roadmap-copy.yml`) only with the owner's approval of that copy, and only while
no run holds or waits for the `deploy-vps` lock: it takes that lock, and a run waiting for it is cancelled by the next
one to wait. It copies what `windmill_roadmap_adopt`, the tool of roadmap's cutover onto the sync engine, reads, for
the cutover's rehearsal against a copy of production ([§8.1](../../docs/foundation/roadmap-on-the-engine.md)).
It only reads: both of its sessions run with `default_transaction_read_only`.

- `tables.dump.enc`: a custom-format `pg_dump` of `trees`, `tree_nodes`, `tree_edges`, `tree_kinds`, `node_progress`
  and `tree_ops`.
- `ids.tsv.enc`: one `copy` of every account's id, the id of each roadmap with a share card or a share video, and the
  key of every roadmap scope `sync_scopes` holds, a label and an id a line. The move reads only that these exist, so no
  address, name, card or video leaves the host. It is read after the dump: an account erased between the two leaves
  its roadmaps ownerless in the copy.
- `key.pem`: a key made for the run, sealed to `.github/ops/inventory-recipient.pem`. The runner encrypts both files
  with it as they arrive from ssh (`openssl enc -aes-256-cbc -pbkdf2`), so no plaintext reaches its disk or the log.

The job log shows each file's size and sha256 and nothing else, and the artifact `roadmap-copy-<run id>` keeps the
three files for a day. This repository's artifacts are public: download it, check the three digests against the log,
and delete it at once (`gh api -X DELETE repos/<owner>/<repo>/actions/artifacts/<artifact id>`). Open it in a folder
only you can read, with the private key that belongs to the certificate:

```sh
ROADMAP_COPY_KEY=$(openssl smime -decrypt -inform PEM -inkey <key> -in key.pem)
export ROADMAP_COPY_KEY
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:ROADMAP_COPY_KEY -in tables.dump.enc -out tables.dump
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:ROADMAP_COPY_KEY -in ids.tsv.enc -out ids.tsv
```

The dump is Postgres 16's, so it restores with `pg_restore` 16 or later. The copy is private data: it lives only in a
throwaway local database and folder, and both are deleted when the rehearsal ends.

## Windmill One: the entitlement copy

The server follows the subscription service's feed into `account_entitlements`, its own copy of every
account's entitlement ([subscriptions.md](../../docs/foundation/subscriptions.md) §6.1), once
`SUBSCRIPTIONS_INTERNAL_URL` and `SUBSCRIPTIONS_INTERNAL_TOKEN` are both set. With neither it logs at
start that the follower is off; with one alone it refuses to start, naming the other. The same pages
record the subscription lifecycle events into `events` and forward them to Amplitude
([OBSERVABILITY.md](../OBSERVABILITY.md)); a key in `server_event_keys` is an event recorded, so a page
read again or a rebuild after a restore records none twice. Windmill One and `GET /v1/subscription` read the
copy whether or not the follower runs, so an account the feed has not reached holds Windmill One only through
`WINDMILL_OWNER_EMAILS`.

Each paid production period the feed records funds that account's AI allowance for the period, and a refund
closes it (§6.3), so the follower needs the AI ledger: with both set and `AI_ALLOWANCES_ENABLED` off the
server refuses to start, since a cursor moved past a period never funds it. A paid period left unfunded,
because another account holds it or nothing of it is left beside the grants the account holds, writes a
`subscription.fund` (or, for a reopen, `subscription.refund`) `conflict` line and files a Sentry warning of
that name; the page still applies.

Two GitHub variables, both empty by default, decide what the copy is read against. `WINDMILL_SANDBOX_EMAILS`
names the accounts whose sandbox purchases count (the team's testers and the App Review account); every
other sandbox purchase entitles no one (§6.2). `SUBSCRIPTIONS_PURCHASABLE_STORES` names the stores the paid
line is open on (`app_store`, `play_store`, `paddle`), the one switch that lets a surface offer a buy
control (INV-12); empty keeps it closed on every store. The deploy refuses to render a value that names anything but
those three, before anything reaches the host; a server given one all the same keeps that name closed, serves, and
logs and reports it at start (`subscription.paid_line`).

In production both come from one GitHub secret, `SUBSCRIPTIONS_INTERNAL_TOKEN`: 64 lowercase hex
characters (`openssl rand -hex 32`), which the deploy refuses in any other non-empty form. The deploy
renders it into `.env`, and compose hands it to the server and to the subscription service, whose
internal doors ask for it as a bearer. Compose sets the server's `SUBSCRIPTIONS_INTERNAL_URL`, to
`http://subscriptions-internal:8083`, only while the token is set. With the secret unset or empty both
containers get the variables as empty strings: the server reads an empty `SUBSCRIPTIONS_INTERNAL_URL` and
`SUBSCRIPTIONS_INTERNAL_TOKEN` as unset, so the follower stays off, and every internal door answers 401. The
deploy after the secret is set turns the follower on, and it reads the feed from zero. That deploy starts the
server before it replaces the subscription container, so until it does the follower writes `subscription follow:
the feed is unavailable (401)`; every later deploy recreates the container, and the read that meets it gone
writes `(unreachable)` once. The follower reads again 30 s after either, and files a stall Issue only past 60 s
without progress.

The subscription service reads Apple's App Store Server API with the in-app purchase key an App Store Connect
admin mints: the repository variables `SUBSCRIPTIONS_APP_STORE_API_ISSUER_ID` and
`SUBSCRIPTIONS_APP_STORE_API_KEY_ID`, and the secret `SUBSCRIPTIONS_APP_STORE_API_PRIVATE_KEY` (the `.p8` PEM). The
deploy renders the PEM onto one `.env` line with its line breaks removed, which the service reads. With any of the
three empty, a claim and a refresh answer 503 `store_api_unavailable` (the device sees `subscriptions_unavailable`)
and the hints owed to Apple wait; the service still starts (`services/subscriptions/ARCHITECTURE.md`).

**A page the backend cannot apply stops the copy for every account, by design.** A page applies whole
or not at all, and the follower skips no entry, since a skipped entry would leave someone's paid state
wrong. A page with an entry the contract does not describe, one that does not continue the cursor, or
one the service refuses is read again every 30 s and never applied. Every row stays as the last page
left it: access still lapses on time, since each row holds the instant it ends (INV-3), but no
renewal, refund or purchase reaches the copy. The way out is a fix on the service's side; nothing on
the backend's side moves the cursor past such a page. Only what decides access stops it: the shape of a
page and an entry's `environment`. A word the contract does not name yet, an event type, a store or an
offer, does not: the entry still reaches the copy, later consumers skip an event they do not know, and
the follower writes `subscription follow: the feed names a word the backend does not know (type=…)`
and files one `subscription.follow.unknown_word` Issue per word per process. Teach the backend the word.

To see the cause, read the server's log, which Sentry Logs also holds: each attempt writes
`subscription follow: the feed is unavailable (<answer>)`, and once the cursor has not moved for 60 s
the follower writes `subscription follow: the cursor has stalled (cause=…)` and files a
`subscription.follow.stalled` Issue, at most once per 5 minutes. The Issue carries no detail, so the
line is where the cause is. The answer is a bounded word: `malformed` (an entry the contract does not
describe), `out-of-order`, `epoch-changed` or `behind` (pages that do not chain), `timeout`,
`unreachable`, `network`, `tls` or `bad-reply` (the transport), or an HTTP status such as `401` (a
token the service does not take). Where the copy stands:

```sh
docker compose exec db psql -U windmill windmill -c "SELECT epoch, seq FROM subscription_feed_cursor"
```

## Frontend

The frontend is the `web/` half of this monorepo — a static Vite SPA, no container, no registry.
`.github/workflows/web.yml` tests, builds, and rsyncs `dist/` into `~/windmill/web/` on a push to
`main`; Caddy serves it at `DOMAIN_APP`, path-routes `/v1/stores/*` to `subscriptions` and the rest of
`/v1`, `/mcp` and `/oauth` to `server`. One origin, so the build bakes in no API host.

`server` mounts that directory read-only as `WINDMILL_WEB_ROOT` to splice unfurl meta into the
`/t/:id` share pages, and `embedder` mounts `web/models` for its weights. **On a fresh host, run the
web deploy first** — the backend comes up either way, but the embedder's mount is empty and
`/health` reports the missing path.

## Notes

- The image carries every service binary; `command:` in compose selects one. Only `windmill_server`
  is run — one process serves REST, the collab socket and MCP against a single `RoomRegistry`.
- `windmill_server` has no health route, so its container health check only confirms the port answers
  HTTP.

## Anonymous Coach access

`AI_INSTALLATIONS_ENABLED=true` enables server-issued installation credentials for Gym Coach
onboarding. It requires `AI_ALLOWANCES_ENABLED=true` and the GitHub secret
`AI_INSTALLATION_IP_HMAC_KEY` containing at least 32 random bytes. The deployment renderer refuses
an enabled installation mode without those prerequisites. Configure the optional
`AI_INSTALLATION_ISSUES_PER_DAY` and `AI_INSTALLATION_GENERATIONS_PER_HOUR` variables to override
10 new installation credentials per UTC day and 30 new generations per UTC hour per network.

Setting `AI_INSTALLATIONS_ENABLED=false` stops new credentials and anonymous generation. Keep
`AI_ALLOWANCES_ENABLED=true` to retain existing credential authentication, allowance reads, account
binding and saved preview recovery; these operations do not require the network secret. Signed-in
Coach can therefore finish binding a retained installation after anonymous access is turned off.

Production Compose fixes `AI_INSTALLATION_PROXY_MODE=cloudflare`. Keep the server port private,
keep the Cloudflare gate first on both Caddy hosts and maintain the Cloudflare firewall allowlist.
The backend requires one canonical `CF-Connecting-IP`; it does not trust X-Forwarded-For or fall
back to an unlimited bucket. IPv6 network budgets aggregate /64 prefixes. Local direct mode uses
the socket peer and rejects forwarded identity headers.

The deploy receipt verifies the running process's installation flag and proxy mode alongside
its image, allowance flag, output cap and schema readiness. Enabled mode also checks that a
network key is present in the running process, without printing or comparing its secret value.
Key rotation changes active network buckets; installation credentials and lifetime balances do
not change. Keep the key stable during ordinary deployment. Resetting or losing an installation
credential is not physical-device attestation and cannot be identified reliably.
