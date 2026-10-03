#!/usr/bin/env bash
set -euo pipefail

for required in python3 sha256sum; do
  if ! command -v "$required" > /dev/null 2>&1; then
    printf 'FAIL required host command missing: %s\n' "$required" >&2
    exit 1
  fi
done
if ! docker compose version > /dev/null 2>&1; then
  printf 'FAIL required host command unavailable: docker compose\n' >&2
  exit 1
fi

# Run from ~/windmill. All candidate files are uploaded under separate names so a rejected
# image/configuration cannot change the live environment or recreate any old container.
if [[ -f migration-evidence/active-cutover ]]; then
  cutover_evidence=$(cat migration-evidence/active-cutover)
  cutover_phase=$(cat "$cutover_evidence/phase")
  case "$cutover_phase" in
    complete|rolled-back|forward-only) ;;
    *)
      printf 'FAIL interrupted production cutover (%s); keep services stopped and rerun products-cutover.yml for recovery instructions. Old configuration remains unchanged.\n' "$cutover_phase" >&2
      exit 1
      ;;
  esac
fi
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
config=$("${candidate[@]}" config --format json)
image=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["migrate"]["image"])' <<< "$config")
server_image=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["server"]["image"])' <<< "$config")
gym_writes=$(python3 -c 'import json,sys; print(int(json.load(sys.stdin)["services"]["server"].get("environment",{}).get("GYM_ENGINE_WRITES","0") in ("1","true","on")))' <<< "$config")
journal_writes=$(python3 -c 'import json,sys; print(int(json.load(sys.stdin)["services"]["server"].get("environment",{}).get("JOURNAL_ENGINE_WRITES","0") in ("1","true","on")))' <<< "$config")
"${candidate[@]}" pull

adopted=f
schemas_present=f
if [[ -f docker-compose.yml && -f .env ]] && [[ -n $(docker compose ps -aq db) ]]; then
  status=$(docker compose exec -T db bash -seuo pipefail <<'DATABASE'
psql -w -XAtq -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SELECT to_regclass('public.gym_sync_adoptions') IS NOT NULL AS gym,
       to_regclass('public.journal_sync_adoptions') IS NOT NULL AS journal \gset
SELECT :'gym'::boolean OR :'journal'::boolean;
SELECT :'gym'::boolean AND :'journal'::boolean;
SQL
DATABASE
  )
  IFS=$'\n' read -r -d '' adopted schemas_present < <(printf '%s\n\0' "$status") || true
fi
if [[ "$gym_writes" == 1 || "$journal_writes" == 1 ]] && [[ "$schemas_present" != t ]]; then
  printf 'FAIL engine writes require complete product adoption; run products-cutover.yml. Old configuration remains running.\n' >&2
  exit 1
fi
if [[ "$adopted" == t ]]; then
  if [[ "$gym_writes" != 1 || "$journal_writes" != 1 ]]; then
    printf 'FAIL adopted database requires both GYM_ENGINE_WRITES and JOURNAL_ENGINE_WRITES on. Old configuration remains running.\n' >&2
    exit 1
  fi
  for compatible_image in "$image" "$server_image"; do
    compatibility=$(docker image inspect --format '{{ index .Config.Labels "io.windmill.schema-adoption-compatibility" }}' "$compatible_image")
    if [[ "$compatibility" != gym-journal-v1 ]]; then
      printf 'FAIL adopted database requires an adoption-compatible image. Old configuration remains running.\n' >&2
      exit 1
    fi
    docker run --rm --network none "$compatible_image" bash /app/deploy/gym-migration/schema-compatibility.sh check-image
  done
  for product in gym journal; do
    # The products audit eligible and fresh accounts themselves; empty users need no migration marker.
    if ! "${candidate[@]}" run --rm --no-deps -T --pull never --entrypoint "windmill_${product}_backfill" server --audit-current; then
      printf 'FAIL engine writes require complete %s adoption; current audit failed. Old configuration remains running.\n' "$product" >&2
      exit 1
    fi
  done
fi

# Only validated, compatible candidates cross this point. Preserve the initialized DB password.
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
