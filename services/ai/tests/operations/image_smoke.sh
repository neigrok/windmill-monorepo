#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || -z "$1" ]]; then
  printf 'Usage: image_smoke.sh IMAGE\n' >&2
  exit 2
fi
image=$1
scratch=$(mktemp -d "${TMPDIR:-/tmp}/wm-ai-image.XXXXXX")
name=${scratch##*/}
app=$name-app
ledger=$name-ledger
marker=PRIVATE_${name//./_}_MARKER
deadline=$(($(date +%s) + 540))
stage='prerequisites'

docker() {
  python3 - "$deadline" "$@" <<'PY'
import subprocess
import sys
import time

remaining = int(sys.argv[1]) - time.time()
if remaining <= 0:
    raise SystemExit("FAIL image smoke: deadline reached")
try:
    result = subprocess.run(["docker", *sys.argv[2:]], timeout=min(120, remaining))
except subprocess.TimeoutExpired:
    raise SystemExit("FAIL image smoke: Docker command timed out")
raise SystemExit(result.returncode)
PY
}

cleanup() {
  status=$?
  trap - EXIT
  set +e
  deadline=$(($(date +%s) + 45))
  logs_ok=1
  docker logs "$app" > "$scratch/app.log" 2>&1 || logs_ok=0
  docker logs "$ledger" > "$scratch/ledger.log" 2>&1 || logs_ok=0
  if [[ $logs_ok == 0 ]]; then
    if [[ $status == 0 ]]; then
      status=1
      stage='container-logs'
    fi
  fi
  if grep -Fq -e "$marker" -e 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' "$scratch/app.log" "$scratch/ledger.log"; then
    status=1
    stage='log-privacy'
    printf 'FAIL image smoke: private marker appeared in container logs; logs withheld\n' >&2
  elif [[ $status != 0 ]]; then
    cat "$scratch/app.log" "$scratch/ledger.log" >&2
  fi
  cleanup_ok=1
  docker rm -f "$app" "$ledger" > /dev/null 2>&1 || cleanup_ok=0
  docker network rm "$name" > /dev/null 2>&1 || cleanup_ok=0
  if [[ $cleanup_ok == 0 && $status == 0 ]]; then
    status=1
    stage='resource-cleanup'
  fi
  rm -rf "$scratch"
  if [[ $status != 0 ]]; then
    printf 'FAIL image smoke: %s\n' "$stage" >&2
  else
    printf 'PASS AI image: dark admission, isolated listeners, hardening, log privacy and graceful exit\n'
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker image inspect "$image" > /dev/null
if ! docker image inspect postgres:16 > /dev/null 2>&1; then
  docker pull postgres:16 > "$scratch/pull.log" 2>&1
fi
stage='ledger-start'
docker network create --internal "$name" > /dev/null
docker run -d --pull never --name "$ledger" --network "$name" --network-alias ledger \
  -e POSTGRES_PASSWORD="${marker}_database" postgres:16 > "$scratch/ledger-start.log" 2>&1
for _ in $(seq 1 30); do
  [[ $(date +%s) -lt "$deadline" ]]
  docker exec "$ledger" pg_isready -U postgres > /dev/null 2>&1 && break
  sleep 1
done
docker exec "$ledger" pg_isready -U postgres > /dev/null
docker exec "$ledger" psql -U postgres -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE windmill_ai LOGIN PASSWORD '${marker}_database'" \
  -c 'CREATE DATABASE windmill_ai OWNER windmill_ai' > "$scratch/provision.log" 2>&1

stage='service-start'
docker run -d --pull never --name "$app" --network "$name" --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 --ulimit core=0:0 --cap-drop ALL \
  --security-opt no-new-privileges --stop-timeout 720 \
  -e AI_ENVIRONMENT=production -e AI_PASS_KEYS='{}' \
  -e AI_DATABASE_URL="postgresql://windmill_ai:${marker}_database@ledger:5432/windmill_ai" \
  -e AI_CARRY_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
  -e AI_FUNDING_SECRET="${marker}_funding_secret_000000000000000000000000" \
  -e AI_OPERATOR_SECRET="${marker}_operator_secret_00000000000000000000000" \
  "$image" > "$scratch/service-start.log" 2>&1
for _ in $(seq 1 60); do
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$app")
  [[ "$health" == healthy || "$health" == unhealthy || "$health" == exited ]] && break
  sleep 1
done
[[ "$health" == healthy ]]

stage='listeners-and-admission'
for port in 8084 8085; do
  [[ "$(docker exec "$app" curl --max-time 5 -fsS "http://127.0.0.1:$port/health")" == '{"status":"ready"}' ]]
done
[[ "$(docker exec "$app" curl --max-time 5 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8084/internal/v1/budgets)" == 404 ]]
[[ "$(docker exec "$app" curl --max-time 5 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8084/v1/allowance)" == 401 ]]
[[ "$(docker exec "$app" curl --max-time 5 -sS -D /tmp/smoke-headers -o /tmp/smoke-body -w '%{http_code}' \
  -X PUT -H 'Content-Type: application/json' -H "Authorization: Bearer $marker" \
  -H "Cookie: session=$marker" -H "X-Windmill-Installation: $marker" \
  --data-raw "{\"messages\":[{\"role\":\"user\",\"content\":\"$marker\"}]}" \
  "http://127.0.0.1:8084/v1/calls/$marker/text")" == 401 ]]
docker exec "$app" grep -Eiq '^cache-control:.*no-store' /tmp/smoke-headers

stage='runtime-hardening'
uid=$(docker exec "$app" id -u)
[[ "$uid" =~ ^[0-9]+$ && "$uid" -gt 0 ]]
docker exec "$app" sh -eu -c '
  test "$(ulimit -c)" = 0
  awk '\''$2 == "/tmp" && $4 ~ /(^|,)noexec(,|$)/ && $4 ~ /(^|,)nosuid(,|$)/ { found = 1 } END { exit !found }'\'' /proc/mounts
  test ! -e /src
  test ! -e /app/crates
  test ! -e /usr/local/cargo
  test -z "$(find /app -type f \( -name "*.rs" -o -name Cargo.toml -o -name ".env*" \) -print -quit)"
'
[[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.Config.StopTimeout}}' "$app")" == 'true 720' ]]
[[ "$(docker port "$app")" == '' ]]

stage='graceful-exit'
docker stop --time 30 "$app" > /dev/null
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$app")" == 0 ]]
