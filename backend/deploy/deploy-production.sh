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
python3 - <<'PY'
import json
import re
import subprocess
import time

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
    for attempt in range(30):
        ready = subprocess.run(["docker", "compose", "exec", "-T", "server", "curl", "--fail", "--silent",
            "--max-time", "2", "--output", "/dev/null", "--write-out", "%{http_code}", "-H", "Sync-Schema: 6",
            "http://127.0.0.1:8080/v1/sync/hello"], capture_output=True, timeout=5)
        if ready.returncode == 0 and ready.stdout == b"200":
            break
        time.sleep(1)
    else:
        raise SystemExit("FAIL running server did not become ready for sync schema 6")
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
except Exception:
    raise SystemExit("FAIL server runtime verification could not complete")
print("PASS server runtime: image and process environment verified, AI_ALLOWANCES_ENABLED=" + mode +
      ", COACH_MAX_OUTPUT_TOKENS=" + cap + ", AI_INSTALLATIONS_ENABLED=" + installations +
      ", AI_INSTALLATION_PROXY_MODE=" + proxy + ", sync schema=6")
PY
rm -f .env.bak rendered.env
printf 'PASS deployed: environment rendered, DB password preserved, stack running\n'
