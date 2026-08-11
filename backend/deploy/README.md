# Deploying windmill-backend

CI builds one Docker image and publishes it, and a second workflow puts it on the single VPS that
runs the whole stack under `docker compose`. **Since 2026-08-11 that second workflow runs itself**:
a backend commit on `main` whose CI goes green deploys, with no hand on it. It is still a separate
workflow, and it still refuses to run on anything but a SUCCESSFUL `push`-triggered Backend CI/CD
on `main` — a red `ctest`, a branch, or a pull request all stop at the image.

It deploys the sha that passed, never `:latest`, so two pushes in a row cannot cross and ship each
other's binary. `workflow_dispatch` remains for deploying a chosen tag by hand — which is also how a
rollback is done: dispatch with the older commit's sha.

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
   only :80/:443 are exposed to the internet
```

## What lives where

| Piece | File |
| --- | --- |
| Build (Drogon + libpqxx-from-source, compile, `ctest`) | `/Dockerfile` |
| Build + test + publish the image (on push to `main`) | `/.github/workflows/backend.yml` |
| Deploy to the VPS (**automatic** on a green Backend CI/CD; renders `~/windmill/.env`) | `/.github/workflows/deploy.yml` |
| VPS runtime topology | `deploy/docker-compose.yml` |
| TLS + reverse proxy | `deploy/Caddyfile` |
| Env keys the deploy renders | `deploy/.env.example` |

## One-time VPS bootstrap

1. **Install Docker + compose v2** (skip if present):
   ```sh
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker "$USER"   # log out/in so the deploy user can run docker
   ```
2. **Open the firewall**: inbound `22`, `80`, `443`.
3. **DNS**: point `DOMAIN_APP` (and the transitional `DOMAIN_API`, if still used) A records
   at the VPS IP. Certs won't issue until this resolves.
4. **Authorize the CI key**: append the deploy public key to
   `~/.ssh/authorized_keys` for the SSH user.

That's all — the deploy job creates `~/windmill/` and everything under it.

## GitHub configuration

**Secrets** (sensitive) — Settings → Secrets and variables → Actions → Secrets:

| Secret | Value |
| --- | --- |
| `SSH_HOST` | VPS IP or hostname |
| `SSH_USER` | deploy user (must be in the `docker` group) |
| `SSH_PORT` | SSH port (e.g. `22`) |
| `SSH_KEY` | CI deploy **private** key (whole PEM) |
| `POSTGRES_PASSWORD` | Postgres password (pick anything strong) |

**Variables** (not sensitive) — same page → Variables:

| Variable | Value |
| --- | --- |
| `DOMAIN_APP` | the single origin (SPA + path-routed backend), e.g. `example.com` |
| `DOMAIN_API` | transitional alias for the old API host, e.g. `api.example.com` (retire once unused) |
| `ACME_EMAIL` | Let's Encrypt contact address |
| `WINDMILL_MCP_ALLOWED_ORIGINS` | comma-separated Origins, or empty for all |

Those two tables are the minimum that makes the deploy run, not the whole set. Every other
key — the Resend/Anthropic/OpenAI/Paddle/Google/Sentry credentials, the admin bearers, the
reminder and nudge arming pairs — is read by `deploy.yml`'s `env:` block and written by its
hand-maintained key list. **That file is the authority**, and it warns why: a name in `env:`
but missing from the list is never written and is unsettable from GitHub, no matter what the
operator configures. Add a key in both places, and describe it in `deploy/.env.example`.

`GITHUB_TOKEN` (auto-provided) pushes the image to GHCR and logs the VPS in to pull it —
no extra token needed.

## Day-to-day

- **Deploy**: Actions → Deploy to VPS → Run workflow (optionally pinning `image_tag`). It is
  `workflow_dispatch` only, so the first run of a change is always watched. It rewrites
  `~/windmill/.env` wholesale from GitHub secrets + variables — only `POSTGRES_PASSWORD` is
  preserved from the host — and refuses before touching the box if `DOMAIN_APP`, `DOMAIN_API`,
  `ACME_EMAIL`, `POSTGRES_PASSWORD` or `RESEND_FROM` is unset.
- **Logs**: `cd ~/windmill && docker compose logs -f server` (or `caddy`, `db`, `embedder`).
- **Status**: `docker compose ps`.
- **Rollback**: the image is tagged per commit — set `IMAGE_TAG=<old-sha>` in `~/windmill/.env`
  and `docker compose up -d server`, or re-run the workflow pinning `image_tag` to that sha.
- **Migrations**: `db/schema.sql` is idempotent (`create … if not exists`) and re-applied by
  the `migrate` one-shot on every deploy.
- **DB shell**: `docker compose exec db psql -U windmill windmill`.

## Frontend

The frontend is the `web/` half of this same monorepo — a static Vite SPA, no container and
no registry. `.github/workflows/web.yml` runs the tests, builds, and rsyncs `dist/` into
`~/windmill/web/` on a push to `main`; the Caddy here serves it at `DOMAIN_APP` and
path-routes `/v1`, `/mcp` and `/oauth` to `server`. One origin, so the build bakes in no API
host at all.

Two consequences of that shared directory: `server` mounts it read-only as
`WINDMILL_WEB_ROOT` to splice unfurl meta into the `/t/:id` share pages, and `embedder`
mounts `web/models` for its weights. **On a fresh host, run the web deploy first** — the
backend comes up either way, but the embedder's mount is empty and `/health` reports the
missing path.

## Notes

- The image carries every service binary; `command:` in compose selects one. Today only
  `windmill_server` is run — the standalone `mcp` service is retired, since one process now
  serves REST, the collab socket and MCP against a single `RoomRegistry`.
- `windmill_server` has no dedicated health route yet, so the container health check just
  confirms the port answers HTTP. Adding `GET /health` would make it a true readiness probe.
