# Deploying windmill-backend

CI builds one Docker image and ships it to a single VPS that runs the whole stack under
`docker compose`. Push to `main` → GitHub Actions tests, builds, and deploys.

```
 push to main ─▶ test (ctest in builder image)
                   └▶ build-and-push (slim runtime image ─▶ ghcr.io)
                        └▶ deploy (ssh: pull + compose up + migrate)

 VPS
 ┌──────────────────── docker compose (private network) ────────────────────┐
 │  caddy :80/:443  ─▶  server :8080   (HTTP + WebSocket)                    │
 │       │          ─▶  mcp    :8090   (MCP Streamable-HTTP, /mcp)           │
 │       │              migrate (one-shot: applies db/schema.sql)            │
 │       │              db     :5432   postgres 16  (volume: pgdata)         │
 └───────┴──────────────────────────────────────────────────────────────────┘
   only :80/:443 are exposed to the internet
```

## What lives where

| Piece | File |
| --- | --- |
| Build (Drogon + libpqxx-from-source, compile, `ctest`) | `/Dockerfile` |
| Pipeline (test → build → deploy) | `/.github/workflows/ci-cd.yml` |
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

`GITHUB_TOKEN` (auto-provided) pushes the image to GHCR and logs the VPS in to pull it —
no extra token needed.

## Day-to-day

- **Deploy**: push to `main`, or run the workflow manually (Actions → CI/CD → Run workflow).
- **Logs**: `cd ~/windmill && docker compose logs -f server` (or `mcp`, `caddy`, `db`).
- **Status**: `docker compose ps`.
- **Rollback**: the image is tagged per commit — set `IMAGE_TAG=<old-sha>` in `~/windmill/.env`
  and `docker compose up -d server mcp`, or re-run the workflow from an older commit.
- **Migrations**: `db/schema.sql` is idempotent (`create … if not exists`) and re-applied by
  the `migrate` one-shot on every deploy.
- **DB shell**: `docker compose exec db psql -U windmill windmill`.

## Frontend

The frontend (the [`windmill`](https://github.com/neigrok/windmill) repo) is a static Vite
SPA. Its own deploy workflow runs `vite build` and rsyncs `dist/` into `~/windmill/web/` on
this VPS; the Caddy here serves it at `DOMAIN_APP` (no container, no registry). The build
bakes in `VITE_API_BASE_URL` (a variable in that repo) so the app talks to `DOMAIN_API`.
That repo needs the same `SSH_HOST/USER/PORT/KEY` secrets to reach this box.

## Notes

- The image carries both service binaries; `command:` in compose selects which each runs.
- `windmill_server` has no dedicated health route yet, so the container health check just
  confirms the port answers HTTP. Adding `GET /health` would make it a true readiness probe.
