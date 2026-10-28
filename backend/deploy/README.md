# Deploying windmill-backend

Backend CI publishes the server and embedder images. The deploy workflow runs the stack on one
VPS under `docker compose`. That second workflow runs itself, and refuses to run on
anything but a SUCCESSFUL `push`-triggered Backend CI/CD on `main` — a red `ctest`, a branch, or a
pull request all stop at the image. It deploys the sha that passed, never `:latest`, so two pushes in
a row cannot ship each other's binary. A manual dispatch runs from `main` and requires a full image
commit SHA. Both server and migration are pinned to the inspected Docker content ID before promotion.
Every candidate carries `sync-compatibility.json`, generated from the same composed registries as its
binary. A missing manifest or unreadable live hello stops deployment before migration, environment
promotion or container replacement. Any change to the minimum accepted schema needs the manual
acknowledgement described below; ordinary backend batches cannot make that cutoff.

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
| Generate image metadata, guard the cutoff and verify sync admission | `deploy/sync_compatibility.py` |
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
  Success also requires the running server's image reference and content ID to match the pulled
  image, a hello advertising that image's exact schema/minimum, and the PID 1 allowance mode and
  Coach output cap to match resolved Compose configuration. Readiness is retried up to 30 times;
  each probe has a timeout. The excluded boundary schema and every previously supported schema
  removed by the cutoff must return `426 upgrade-required` at hello, push, pull and WebSocket
  upgrade. The runtime receipt names the checks that passed. Credentials and failed command output
  are never dumped. This proves configuration reached PID 1 and the selected
  image serves HTTP; output-cap enforcement requires a binary that supports that setting.
- **Logs**: `cd ~/windmill && docker compose logs -f server` (or `caddy`, `db`, `embedder`).
- **Status**: `docker compose ps`.
- **Rollback**: dispatch the deploy workflow with `image_tag` set to the chosen commit SHA. Both
  the server and `embedder-<sha>` images must exist, and the server image must contain its compatibility
  manifest. Only the image goes back: the run renders `.env`
  and ships `docker-compose.yml`, the Caddyfile and `deploy-production.sh` from the branch it is
  dispatched on (`main` only), and `migrate` applies the selected image's own `db/schema.sql`.
  A lower minimum is a compatibility change too and requires exact manual acknowledgement. That
  acknowledgement does not make old binaries safe for data written under newer rules.
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

## Coordinated client cutoff

The repository registry is schema 10 / minimum 10 with explicit gym `other`, finite normalized loads
without a fixed kg cap, and nullable derived metrics. Production's last verified registry is schema 8 /
minimum 4; source and web versions do not prove the live backend version. Production cutoff remains
held until coordinated Android and iOS replacement artifacts and their upgrade destinations are
verified. A source merge does not authorize a minimum change.

1. Keep a schema 8 / minimum 4 maintenance image available during preparation. Automatic deployment
   refuses a candidate minimum that differs from the live server.
2. Prepare schema 10 readers on every surface. Preserve stored equipment/count values, exact zero,
   absent targets and pending writes. Web Deploy retains the complete pinned `dist`, source/file-hash
   manifest and composed compatibility artifact before checking the live anonymous hello. It holds
   promotion before mkdir/rsync unless live schema is at least the client minimum and live minimum
   accepts the client schema; incompatible or unreadable state leaves the served web files intact.
   New selectors require their own
   design approval. Each bound sender keeps writes ready until an owner/token/replica/epoch-matched
   fresh hello advertises a server schema at least the client's generated registry minimum.
3. Verify the signed Android update over the public replacement floor, including retained local work
   and delivery against the schema 8 server. Upload the exact iOS version/build through the manual
   `ios-release.yml` workflow and check processing, beta readiness and intended tester availability.
   Verify both native replacements against the schema 10 candidate, publish the Android release,
   and verify both upgrade destinations before cutoff. TestFlight status alone proves no tester access.
4. Record the full backend commit SHA and immutable Docker image ID (`docker image inspect --format
   '{{.Id}}' ghcr.io/neigrok/windmill-monorepo:<sha>`). Read the live minimum again, then dispatch
   **Deploy to VPS** from `main` with that `image_tag`, its exact `expected_old_minimum`,
   `expected_new_minimum=10` and `expected_image_id`. Both raises and lowers require exact
   acknowledgement. An interrupted attempt reads live state again. A fresh host uses old minimum 0.
5. Verify schema 10 / minimum 10 at hello and schema 9 or older `426 upgrade-required` refusals at
   hello, push, pull and WebSocket upgrade. Active Gym HTTP routes require the generated minimum
   header and return `426 client-update-required` for missing/old carriers before JSON, image or
   SSE delivery. Verify queued native/web work delivers only after a fresh compatible hello. Cached
   web and old native clients retain local work and show their existing update-required surface.
   Retry the held Web Deploy run after the backend is compatible, or dispatch the exact accepted
   main source. Each attempt retains a separate pinned web artifact; inspect its full source SHA,
   schema and file hashes. The preflight reads the current compose deployment and promotes no
   backend state. Verify the new web release and real queued delivery after promotion.
6. Keep a schema 10 / minimum 10 maintenance image available before accepting the new load range
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
