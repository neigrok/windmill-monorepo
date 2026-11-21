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
if [[ ! -d subscriptions-db.next ]]; then
  printf 'FAIL candidate subscriptions-db folder is missing\n' >&2
  exit 1
fi
if [[ ! -d ai-db.next ]]; then
  printf 'FAIL candidate ai-db folder is missing\n' >&2
  exit 1
fi
# Roadmap's switch onto the sync engine is the host's own (README.md, "Roadmap's cutover onto the sync engine"): no
# deploy renders or changes roadmap-engine.env, so none can turn roadmap back to its own sync. Compose reads it into
# the server; once nothing below refuses, a missing one is created empty, which keeps roadmap's scopes withheld.
roadmap_switch=
[[ ! -e roadmap-engine.env ]] || roadmap_switch=$(cat roadmap-engine.env)
if [[ -n "$roadmap_switch" && "$roadmap_switch" != ROADMAP_ENGINE_ENABLED=1 ]]; then
  printf 'FAIL roadmap-engine.env holds something other than ROADMAP_ENGINE_ENABLED=1\n' >&2
  exit 1
fi
# The cutover's floor and the database decide too: once a cutover ran here, or the engine holds roadmap's scopes, a server
# off the engine would serve roadmap's old tables beside them, so a switch lost or emptied is refused, not recreated off.
if [[ -z "$roadmap_switch" && -s roadmap-engine.floor ]]; then
  printf 'FAIL roadmap-engine.floor says roadmap is on the sync engine here, and roadmap-engine.env does not say ROADMAP_ENGINE_ENABLED=1\n' >&2
  exit 1
fi
if [[ -z "$roadmap_switch" && -f .env ]]; then
  # A database that is down is started as it stands, as the deploy would start it anyway, so that it can answer.
  if [[ -z "$(docker compose ps -q db 2> /dev/null)" ]]; then
    docker compose up -d --no-deps --no-recreate db > /dev/null 2>&1 || true
    for ((attempt = 0; attempt < 120; attempt++)); do
      docker compose exec -T db pg_isready --username=windmill --dbname=windmill > /dev/null 2>&1 && break
      sleep 1
    done
  fi
  on_engine=$(docker compose exec -T db psql --username=windmill --dbname=windmill -XAtq -v ON_ERROR_STOP=1 \
    -c "select to_regclass('public.sync_scopes') is not null" 2> /dev/null) || on_engine=unread
  if [[ "$on_engine" == t ]]; then
    on_engine=$(docker compose exec -T db psql --username=windmill --dbname=windmill -XAtq -v ON_ERROR_STOP=1 \
      -c "select exists (select 1 from sync_scopes where kind <> 'product' or key like 'acct:%/roadmap')" 2> /dev/null) ||
      on_engine=unread
  fi
  if [[ "$on_engine" == t ]]; then
    printf 'FAIL the database holds roadmap on the sync engine, and roadmap-engine.env does not say ROADMAP_ENGINE_ENABLED=1\n' >&2
    exit 1
  fi
  if [[ "$on_engine" != f ]]; then
    printf 'FAIL whether the database holds roadmap on the sync engine could not be read\n' >&2
    exit 1
  fi
fi
[[ -e roadmap-engine.env ]] || : > roadmap-engine.env
# The site's pause, which Caddy mounts and only roadmap's cutover and Ops · maintenance set and lift (README.md,
# "Pause the site"); a deploy keeps it as it is.
mkdir -p maintenance
# Validate before pruning, pulling, changing HBA, or promoting any live file.
python3 - rendered.env <<'PYAI'
import base64
import json
import re
import sys

def refuse():
    raise SystemExit("FAIL AI service configuration is missing or invalid")

values = {}
for line in open(sys.argv[1]):
    key, separator, value = line.rstrip("\n").partition("=")
    if separator:
        if key in values or "\r" in value:
            refuse()
        values[key] = value
if not re.fullmatch(r"[0-9a-f]{64}", values.get("AI_DB_PASSWORD", "")):
    refuse()
carry = values.get("AI_CARRY_KEY", "")
if not re.fullmatch(r"[A-Za-z0-9_-]{43}", carry):
    refuse()
try:
    raw = base64.urlsafe_b64decode(carry + "=")
    if len(raw) != 32 or base64.urlsafe_b64encode(raw).decode().rstrip("=") != carry:
        refuse()
    keys = json.loads(values.get("AI_PASS_KEYS") or "{}")
    if not isinstance(keys, dict):
        refuse()
    for kid, key in keys.items():
        if not re.fullmatch(r"[a-z0-9-]{1,32}", kid) or kid.startswith("test-") or not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", key):
            refuse()
        if len(base64.urlsafe_b64decode(key + "=")) != 32:
            refuse()
except (ValueError, TypeError):
    refuse()
secrets = [values.get(key, "") for key in ("AI_FUNDING_SECRET", "AI_OPERATOR_SECRET")]
if any(not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", secret) for secret in secrets) or len(set([carry, *secrets])) != 3:
    refuse()
if any("$" in value for key, value in values.items() if key.startswith("AI_")):
    refuse()
PYAI
candidate_env=.env.next
verification=$(mktemp -d)
trap 'rm -f "$candidate_env"; rm -rf "$verification"' EXIT
live() {
  [[ ! -f .env ]] || sed -n "s/^$1=//p" .env
}
write_candidate() {
  sed "/^$1=/d" "$candidate_env" > "$verification/candidate.env"
  printf '%s=%s\n' "$1" "$2" >> "$verification/candidate.env"
  mv "$verification/candidate.env" "$candidate_env"
}
cp rendered.env "$candidate_env"
prior_pg=$(live POSTGRES_PASSWORD | head -1)
[[ -z "$prior_pg" ]] || write_candidate POSTGRES_PASSWORD "$prior_pg"
candidate=(docker compose --env-file "$candidate_env" -f docker-compose.next.yml)
"${candidate[@]}" config -q
# The backend starts before either ledger service; their runtime health cannot hold it back.
services=$("${candidate[@]}" config --services)
backend=()
while read -r service; do
  [[ "$service" == subscriptions || "$service" == ai || "$service" == ai-db ]] || backend+=("$service")
done <<< "$services"
# Images no container uses come back from their registry on demand; pruning them before the pull keeps the
# disk to the live images plus the candidate. Volumes are never pruned.
docker image prune -af > /dev/null
docker builder prune -af > /dev/null
# Backend CI builds every image again for each commit, so content IDs differ where nothing an image is built from did.
# A unit is unchanged when this commit leaves its inputs as the live deployment has them (image_inputs.py, rendered by
# the deploy workflow) and the image it is pinned to is still here, which the prune leaves any image a container uses.
# An unchanged unit keeps that image and nothing is pulled for it; compose recreates its container only for a value it
# reads that changed.
unchanged() {
  local inputs pinned
  inputs=$(sed -n "s/^$1=//p" "$candidate_env")
  pinned=$(live "$2")
  [[ "$inputs" =~ ^[a-f0-9]{64}$ && "$inputs" == "$(live "$1")" && "$pinned" =~ ^sha256:[a-f0-9]{64}$ ]] &&
    docker image inspect --format '{{.Id}}' "$pinned" > /dev/null 2>&1
}
# The backend's commit, BACKEND_TAG, names the embedder's image and the server's release, so an unchanged backend
# keeps it too. Its database and Caddy images are pulled only with a backend that changed.
backend_tag=$(live BACKEND_TAG)
if unchanged BACKEND_INPUTS SERVER_IMAGE && [[ "$backend_tag" =~ ^[a-f0-9]{40}$ ]]; then
  write_candidate BACKEND_TAG "$backend_tag"
  write_candidate SERVER_IMAGE "$(live SERVER_IMAGE)"
  printf 'NOTE backend: nothing it is built from changed, so it keeps its image, built at %s\n' "$backend_tag"
else
  write_candidate BACKEND_TAG "$(sed -n 's/^IMAGE_TAG=//p' "$candidate_env")"
  "${candidate[@]}" pull "${backend[@]}"
fi
python3 "$(dirname "$0")/sync_compatibility.py" preflight "$candidate_env" sync-cutover.json "$verification/sync.json"
# A subscription service that changed runs the image built for this commit, pinned to the content ID it was pulled as,
# like the server and the migration. A commit that has none, as an image built before Backend CI published the service,
# keeps the container the live service runs, untouched: recreating it under the candidate compose could start an
# older image on configuration it cannot read. Its container also keeps its image on the host through the prune.
kept_subscriptions=
if unchanged SUBSCRIPTIONS_INPUTS SUBSCRIPTIONS_IMAGE; then
  subscriptions_id=$(live SUBSCRIPTIONS_IMAGE)
  printf 'NOTE subscription service: nothing it is built from changed, so it keeps its image, %s\n' "$subscriptions_id"
elif "${candidate[@]}" pull subscriptions; then
  subscriptions_image=$("${candidate[@]}" config --format json |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["services"]["subscriptions"]["image"])')
  subscriptions_id=$(docker image inspect --format '{{.Id}}' "$subscriptions_image")
  if [[ ! "$subscriptions_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    printf 'FAIL candidate subscription image has no immutable content ID\n' >&2
    exit 1
  fi
else
  subscriptions_id=
  [[ ! -f .env ]] || kept_subscriptions=$(docker compose ps -q subscriptions 2> /dev/null || true)
  [[ -z "$kept_subscriptions" ]] || subscriptions_id=$(docker inspect --format '{{.Image}}' "$kept_subscriptions")
  if [[ ! "$subscriptions_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    printf 'FAIL no subscription service image could be pulled for this commit, and none runs here to keep\n' >&2
    exit 1
  fi
  printf 'NOTE subscription service: no image could be pulled for this commit, so its running container is kept as it is, on %s\n' \
    "$subscriptions_id"
fi
write_candidate SUBSCRIPTIONS_IMAGE "$subscriptions_id"

if unchanged AI_INPUTS AI_IMAGE; then
  ai_id=$(live AI_IMAGE)
  printf 'NOTE AI service: nothing it is built from changed, so it keeps its image, %s\n' "$ai_id"
elif "${candidate[@]}" pull ai; then
  ai_image=$("${candidate[@]}" config --format json |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["services"]["ai"]["image"])')
  ai_id=$(docker image inspect --format '{{.Id}}' "$ai_image")
  if [[ ! "$ai_id" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    printf 'FAIL candidate AI image has no immutable content ID\n' >&2
    exit 1
  fi
else
  ai_id=$(live AI_IMAGE)
  if [[ ! "$ai_id" =~ ^sha256:[a-f0-9]{64}$ ]] ||
     ! docker image inspect --format '{{.Id}}' "$ai_id" > /dev/null 2>&1; then
    printf 'FAIL no AI service image could be pulled for this commit, and none runs here to keep\n' >&2
    exit 1
  fi
  printf 'NOTE AI service: no image could be pulled for this commit, so it keeps the one it runs, %s\n' "$ai_id"
fi
write_candidate AI_IMAGE "$ai_id"

# The inspected images and sync minimum are approved before any migration or container changes.
[[ ! -f .env ]] || cp .env .env.bak
mv "$candidate_env" .env
mv docker-compose.next.yml docker-compose.yml
rm -rf subscriptions-db
mv subscriptions-db.next subscriptions-db
rm -rf ai-db
mv ai-db.next ai-db
if cmp -s Caddyfile.next Caddyfile; then
  rm Caddyfile.next
else
  mv Caddyfile.next Caddyfile
fi
# A prior deploy may have promoted the file before recreating Caddy. Inspect the
# running mount so retrying the same candidate also repairs that interrupted deploy.
caddy_changed=1
if docker compose exec -T caddy cat /etc/caddy/Caddyfile > "$verification/Caddyfile.before" 2>/dev/null &&
   cmp -s Caddyfile "$verification/Caddyfile.before"; then
  caddy_changed=0
fi
# The ledger services wait for provisioning and start after backend verification, below.
docker compose up -d --pull never "${backend[@]}"
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
python3 - <<'PY'
import json
import re
import subprocess

def capture(arguments):
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=5)
    if result.returncode:
        raise RuntimeError("runtime command failed")
    return result.stdout.strip()

try:
    server = json.loads(capture(["docker", "compose", "config", "--format", "json"]))["services"]["server"]
    mode = server["environment"]["AI_ALLOWANCES_ENABLED"]
    cap = server["environment"]["COACH_MAX_OUTPUT_TOKENS"]
    installations = server["environment"]["AI_INSTALLATIONS_ENABLED"]
    proxy = server["environment"]["AI_INSTALLATION_PROXY_MODE"]
    if installations not in ("true", "1", "false", "0") or proxy != "cloudflare":
        raise SystemExit("FAIL invalid intended installation configuration")
    if installations in ("true", "1") and (mode not in ("true", "1") or len(server["environment"].get("AI_INSTALLATION_IP_HMAC_KEY", "")) < 32):
        raise SystemExit("FAIL anonymous AI requires allowances and an installation network key")
    if mode not in ("true", "1", "false", "0") or not re.fullmatch(r"[0-9]+", cap) or not 1024 <= int(cap) <= 8000:
        raise SystemExit("FAIL invalid intended server AI configuration")
    container = capture(["docker", "compose", "ps", "-q", "server"])
    actual = json.loads(capture(["docker", "inspect", "--format",
        '{"image":{{json .Config.Image}},"id":{{json .Image}}}', container]))
    intended_id = capture(["docker", "image", "inspect", "--format", "{{.Id}}", server["image"]])
    if actual != {"image": server["image"], "id": intended_id}:
        raise SystemExit("FAIL running server image differs from intended image")
    for key, expected in (("AI_ALLOWANCES_ENABLED", mode), ("COACH_MAX_OUTPUT_TOKENS", cap),
                          ("AI_INSTALLATIONS_ENABLED", installations), ("AI_INSTALLATION_PROXY_MODE", proxy)):
        check = subprocess.run(["docker", "compose", "exec", "-T", "server", "sh", "-eu", "-c",
            'grep -Fzxq -- "$1=$2" /proc/1/environ', "sh", key, expected], capture_output=True, timeout=5)
        if check.returncode:
            raise SystemExit("FAIL running server " + key + " differs from intended configuration")
    if installations in ("true", "1"):
        check = subprocess.run(["docker", "compose", "exec", "-T", "server", "sh", "-eu", "-c",
            'grep -Ezq -- "^AI_INSTALLATION_IP_HMAC_KEY=.{32,1024}$" /proc/1/environ', "sh", "installation-key-present"],
            capture_output=True, timeout=5)
        if check.returncode:
            raise SystemExit("FAIL running server installation network key is unavailable")
    roadmap = "1" if open("roadmap-engine.env").read().strip() else ""
    if server["environment"].get("ROADMAP_ENGINE_ENABLED", "") != roadmap:
        raise SystemExit("FAIL compose does not read roadmap-engine.env into the server")
    check = subprocess.run(["docker", "compose", "exec", "-T", "server", "sh", "-eu", "-c",
        'if [ -n "$1" ]; then grep -Fzxq -- "ROADMAP_ENGINE_ENABLED=$1" /proc/1/environ; '
        'else ! grep -Ezq -- "^ROADMAP_ENGINE_ENABLED=" /proc/1/environ; fi', "sh", roadmap, "roadmap-switch"],
        capture_output=True, timeout=5)
    if check.returncode:
        raise SystemExit("FAIL running server ROADMAP_ENGINE_ENABLED differs from roadmap-engine.env")
    # An image that does not act on the switch serves roadmap's old sync beside the engine's (spec §8.3).
    if roadmap:
        retired = subprocess.run(["docker", "compose", "exec", "-T", "server", "curl", "--silent", "--output", "/dev/null",
            "--max-time", "5", "--write-out", "%{http_code}", "http://127.0.0.1:8080/v1/socket"], capture_output=True,
            text=True, timeout=10)
        if retired.stdout != "410":
            raise SystemExit("FAIL the running server does not retire roadmap's socket while roadmap is on the sync engine")
except Exception:
    raise SystemExit("FAIL server runtime verification could not complete")
PY
python3 "$(dirname "$0")/sync_compatibility.py" verify "$verification/sync.json"
rm -f .env.bak rendered.env sync-cutover.json
if [[ -n "$roadmap_switch" ]]; then
  printf 'PASS roadmap: the server runs with ROADMAP_ENGINE_ENABLED=1, kept from roadmap-engine.env\n'
fi
# The subscription database's one-shot ran with `up`, and nothing there waits on it, so its outcome is read
# here, once the backend is verified. A FAIL turns this run red while the backend stays deployed and serving,
# and leaves the subscription service as it was.
provisioning=$(docker compose ps -aq subscriptions-db)
if [[ -z "$provisioning" ]]; then
  printf 'FAIL subscription database provisioning did not run; the backend is deployed and serving\n' >&2
  exit 1
fi
for ((attempt=0; attempt<60; attempt++)); do
  outcome=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$provisioning")
  [[ "$outcome" == exited* ]] && break
  sleep 1
done
docker compose logs --no-log-prefix --tail 1 subscriptions-db
case "$outcome" in
  "exited 0") ;;
  exited*)
    printf 'FAIL subscription database provisioning exited with code %s; the backend is deployed and serving\n' \
      "${outcome#exited }" >&2
    exit 1 ;;
  *)
    printf 'FAIL subscription database provisioning was still %s after 60 s; the backend is deployed and serving\n' \
      "${outcome%% *}" >&2
    exit 1 ;;
esac
# The subscription service starts on the database its provisioning has just passed, or a kept one goes on as it
# runs. One that is not healthy on its pinned image turns this run red; it is not rolled back, and the backend stays
# deployed and serving.
if [[ -n "$kept_subscriptions" ]]; then
  subscriptions=$kept_subscriptions
else
  if ! docker compose up -d --no-deps --pull never subscriptions; then
    printf 'FAIL subscription service did not start; the backend is deployed and serving\n' >&2
    exit 1
  fi
  subscriptions=$(docker compose ps -aq subscriptions)
fi
for ((attempt=0; attempt<60; attempt++)); do
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$subscriptions")
  [[ "$health" == healthy || "$health" == unhealthy ]] && break
  sleep 1
done
if [[ "$health" != healthy ]]; then
  printf 'FAIL subscription service was %s after %s s; the backend is deployed and serving\n' "$health" "$attempt" >&2
  exit 1
fi
if [[ "$(docker inspect --format '{{.Image}}' "$subscriptions")" != "$(sed -n 's/^SUBSCRIPTIONS_IMAGE=//p' .env)" ]]; then
  printf 'FAIL running subscription service image differs from intended image; the backend is deployed and serving\n' >&2
  exit 1
fi
if [[ -n "$kept_subscriptions" ]]; then
  printf 'PASS subscription service: its running container kept, not recreated, healthy on its image\n'
else
  printf 'PASS subscription service: healthy on its pinned image\n'
fi
# This HBA writer starts only after subscriptions-db has finished. AI failure leaves the backend serving.
if ! docker compose up -d --no-deps --pull never ai-db; then
  printf 'FAIL AI database provisioning did not start; the backend is deployed and serving\n' >&2
  exit 1
fi
ai_provision=$(docker compose ps -aq ai-db)
if [[ -z "$ai_provision" ]]; then
  printf 'FAIL AI database provisioning did not run; the backend is deployed and serving\n' >&2
  exit 1
fi
for ((attempt=0; attempt<60; attempt++)); do
  outcome=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$ai_provision")
  [[ "$outcome" == exited* ]] && break
  sleep 1
done
docker compose logs --no-log-prefix --tail 1 ai-db
if [[ "$outcome" != 'exited 0' ]]; then
  printf 'FAIL AI database provisioning did not succeed; the backend is deployed and serving\n' >&2
  exit 1
fi
# Compose waits for the old process's 720-second grace before replacing it.
if ! docker compose up -d --no-deps --pull never ai; then
  printf 'FAIL AI service did not start; the backend is deployed and serving\n' >&2
  exit 1
fi
ai_container=$(docker compose ps -aq ai)
for ((attempt=0; attempt<60; attempt++)); do
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$ai_container")
  [[ "$health" == healthy || "$health" == unhealthy ]] && break
  sleep 1
done
if [[ "$health" != healthy ]]; then
  printf 'FAIL AI service was %s after %s s; the backend is deployed and serving\n' "$health" "$attempt" >&2
  exit 1
fi
if [[ "$(docker inspect --format '{{.Image}}' "$ai_container")" != "$(sed -n 's/^AI_IMAGE=//p' .env)" ]]; then
  printf 'FAIL running AI service image differs from intended image; the backend is deployed and serving\n' >&2
  exit 1
fi
printf 'PASS AI service: healthy on its pinned image\n'
printf 'PASS deployed: immutable image, sync compatibility, process environment and Caddy verified; DB password preserved\n'
