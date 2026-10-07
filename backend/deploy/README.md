# Deploying windmill-backend

Backend CI publishes the server and embedder images. The deploy workflow runs the stack on one
VPS under `docker compose`. That second workflow runs itself, and refuses to run on
anything but a SUCCESSFUL `push`-triggered Backend CI/CD on `main` — a red `ctest`, a branch, or a
pull request all stop at the image. It deploys the sha that passed, never `:latest`, so two pushes in
a row cannot ship each other's binary. `workflow_dispatch` deploys a chosen tag by hand, which is
also the rollback: dispatch with the older commit's sha.

```
 push to main ─▶ test (ctest in builder image)
                   └▶ build-and-push (slim runtime image ─▶ ghcr.io)
                        └▶ deploy.yml, automatically, on that run's success

 (or by hand) run deploy.yml ─▶ render ~/windmill/.env ─▶ ship compose + Caddyfile ─▶ pull + up + migrate

 VPS
 ┌──────────────────── docker compose (private network) ────────────────────┐
 │  caddy :80/:443  ─▶  server :8080   (HTTP + WebSocket + MCP at /mcp)      │
 │       │          ─▶  /srv/windmill-web (the rsynced SPA, file_server)     │
 │       │              embedder :8081  (journal echo vectors; model mount)  │
 │       │              migrate (one-shot: applies db/schema.sql)            │
 │       │              db     :5432   postgres 16  (volume: pgdata)         │
 └───────┴──────────────────────────────────────────────────────────────────┘
   only :80/:443 are exposed, and only to Cloudflare's ranges
```

## What lives where

| Piece | File |
| --- | --- |
| Build (Drogon + libpqxx, compile, `ctest`) | `backend/Dockerfile` |
| Build + test + publish the image (on push to `main`) | `/.github/workflows/backend.yml` |
| Deploy to the VPS (automatic on a green Backend CI/CD; renders `~/windmill/.env`) | `/.github/workflows/deploy.yml` |
| VPS runtime topology | `deploy/docker-compose.yml` |
| Promote the candidate files and prove Caddy loaded them (runs on the VPS) | `deploy/deploy-production.sh` |
| TLS + reverse proxy | `deploy/Caddyfile` |
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

**Variables** — same page → Variables:

| Variable | Value |
| --- | --- |
| `DOMAIN_APP` | the single origin (SPA + path-routed backend), e.g. `example.com` |
| `DOMAIN_API` | alias for the API host, e.g. `api.example.com` |
| `ACME_EMAIL` | Let's Encrypt contact address |
| `RESEND_FROM` | verified sender address |
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
  box if `DOMAIN_APP`, `DOMAIN_API`, `ACME_EMAIL`, `POSTGRES_PASSWORD` or `RESEND_FROM` is unset.
  `CF_IPS` is configured nowhere: the job fetches Cloudflare's live edge list, falls back to the
  committed default in `deploy/docker-compose.yml`, and refuses on the same guard if both come back
  empty — an empty allow-list would make Caddy 403 the whole site.
- **Logs**: `cd ~/windmill && docker compose logs -f server` (or `caddy`, `db`, `embedder`).
- **Status**: `docker compose ps`.
- **Rollback**: dispatch the deploy workflow with `image_tag` set to the chosen commit SHA. Both
  the server and `embedder-<sha>` images must exist. Only the image goes back: the run renders `.env`
  and ships `docker-compose.yml`, the Caddyfile and `deploy-production.sh` from the branch it is
  dispatched on (`main` unless another is chosen), and `migrate` applies the older image's own
  `db/schema.sql`.
- **Rollback floor**: the oldest image that is safe to run is the first one built from a commit
  containing `backend · purge the retired gym and journal cutover copies`. After the purge, use only
  that image or its descendants: earlier image schemas recreate retired cutover storage and their
  binaries depend on it. Restoring a pre-engine backup is unsupported. A restore from an engine-era
  backup must apply the current schema before starting writers and regenerate `sync_meta.epoch`
  as [the engine restore contract](../../docs/foundation/engine.md) requires.
- **Migrations**: `db/schema.sql` is idempotent and re-applied on every deploy by the `migrate`
  one-shot, a plain `psql`. It removes the retired gym and journal cutover copies while keeping
  the engine tables and current user data.
- **Native Apple sign-in**: the identity-token exchange defaults off (`APPLE_NATIVE_ENABLED=0`);
  [AUTH.md](../AUTH.md) names its audience and app configuration.
- **Backup**: the dispatch-only `gym-backup.yml` writes a custom-format dump of the whole database to
  `~/windmill/backups/` on the VPS, checks that `pg_restore` can list it, and records its sha256.
  Dumps made before the cutover-copy purge retain those copies. The repository defines no scheduled
  database backup or backup rotation; this workflow keeps each dump until it is removed manually.
  The cutover evidence purge does not touch this directory. Host-managed cron jobs and provider
  backup policies must be checked on the host and with the provider.
- **DB shell**: `docker compose exec db psql -U windmill windmill`.

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
rebootstraps. That transition retains unsent entries and returns still-pending old-epoch
acknowledgements to ready at their original commit positions.

A restore is outside the engine's INV-3 guarantee ([spec §7.5](../../docs/foundation/engine.md#75-puller-reset-and-epoch-change)).
Fully settled server writes newer than the backup are lost; rotation cannot reconstruct them.
Retained intents may replay against missing records or records recreated with a different `born`:
dependent edits/deletes can be refused or acknowledged as no-ops, so their intended effects can be
lost. A no-op acknowledgement produces no refusal notice.

Even after rotation, a push-first reconnect can lose an offline delete of a record absent from the
backup: after `409 gap`, the delete can be acknowledged as a no-op before its old acknowledged
create is replayed. The record then reappears with an empty outbox and no notice. The supplied
restore proof covers pull-first recovery of independent creates, not this dependent-delete case
or every reconnect ordering. Keeping ingress closed until rotation is verified limits exposure;
it does not remove this client recovery limitation.

## Frontend

The frontend is the `web/` half of this monorepo — a static Vite SPA, no container, no registry.
`.github/workflows/web.yml` tests, builds, and rsyncs `dist/` into `~/windmill/web/` on a push to
`main`; Caddy serves it at `DOMAIN_APP` and path-routes `/v1`, `/mcp` and `/oauth` to `server`. One
origin, so the build bakes in no API host.

`server` mounts that directory read-only as `WINDMILL_WEB_ROOT` to splice unfurl meta into the
`/t/:id` share pages, and `embedder` mounts `web/models` for its weights. **On a fresh host, run the
web deploy first** — the backend comes up either way, but the embedder's mount is empty and
`/health` reports the missing path.

## Notes

- The image carries every service binary; `command:` in compose selects one. Only `windmill_server`
  is run — one process serves REST, the collab socket and MCP against a single `RoomRegistry`.
- `windmill_server` has no health route, so its container health check only confirms the port answers
  HTTP.
