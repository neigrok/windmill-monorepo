#!/usr/bin/env bash
set -euo pipefail

if ! command -v python3 > /dev/null 2>&1; then
  printf 'FAIL required host command missing: python3\n' >&2
  exit 1
fi
if ! docker compose version > /dev/null 2>&1; then
  printf 'FAIL required host command unavailable: docker compose\n' >&2
  exit 1
fi

# Run from ~/windmill. All candidate files are uploaded under separate names so a rejected
# image/configuration cannot change the live environment or recreate any old container.
candidate_env=.env.next
trap 'rm -f "$candidate_env"' EXIT
prior_pg=
if [[ -f .env ]]; then
  prior_pg=$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | head -1)
fi
if [[ -n "$prior_pg" ]]; then
  sed '/^POSTGRES_PASSWORD=/d' rendered.env > "$candidate_env"
  printf 'POSTGRES_PASSWORD=%s\n' "$prior_pg" >> "$candidate_env"
else
  cp rendered.env "$candidate_env"
fi
candidate=(docker compose --env-file "$candidate_env" -f docker-compose.next.yml)
"${candidate[@]}" config -q
"${candidate[@]}" pull

# Only a valid candidate whose images pulled crosses this point. Preserve the initialized DB password.
[[ ! -f .env ]] || cp .env .env.bak
mv "$candidate_env" .env
mv docker-compose.next.yml docker-compose.yml
if cmp -s Caddyfile.next Caddyfile; then
  rm Caddyfile.next
else
  mv Caddyfile.next Caddyfile
fi
verification=$(mktemp -d)
trap 'rm -f "$candidate_env"; rm -rf "$verification"' EXIT
# A prior deploy may have promoted the file before recreating Caddy. Inspect the
# running mount so retrying the same candidate also repairs that interrupted deploy.
caddy_changed=1
if docker compose exec -T caddy cat /etc/caddy/Caddyfile > "$verification/Caddyfile.before" 2>/dev/null &&
   cmp -s Caddyfile "$verification/Caddyfile.before"; then
  caddy_changed=0
fi
docker compose up -d --pull never
# A single-file bind mount retains its inode across mv. Recreate to bind the new file.
if [[ "$caddy_changed" == 1 ]]; then
  docker compose up -d --no-deps --force-recreate --pull never caddy
fi
# Recreated containers may not have opened their admin listener when up returns.
caddy_ready=0
for ((attempt=0; attempt<30; attempt++)); do
  if docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile > "$verification/reload.log" 2>&1; then
    caddy_ready=1
    break
  fi
  sleep 1
done
if [[ "$caddy_ready" != 1 ]]; then
  cat "$verification/reload.log" >&2
  printf 'FAIL Caddy did not load the deployed configuration\n' >&2
  exit 1
fi
# Prove both the mount and the active admin configuration match the intended file.
docker compose exec -T caddy cat /etc/caddy/Caddyfile > "$verification/Caddyfile"
cmp Caddyfile "$verification/Caddyfile"
docker compose exec -T caddy caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile > "$verification/expected.json"
docker compose exec -T caddy wget -qO- http://127.0.0.1:2019/config/ > "$verification/active.json"
python3 - "$verification/expected.json" "$verification/active.json" <<'PY'
import json
import sys
if json.load(open(sys.argv[1])) != json.load(open(sys.argv[2])):
    raise SystemExit("FAIL running Caddy configuration differs from Caddyfile")
PY
rm -f .env.bak rendered.env
printf 'PASS deployed: environment rendered, DB password preserved, stack running\n'
