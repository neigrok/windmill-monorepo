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

main() {
  cd "${1:-$HOME/windmill}"
  operation=${2:-adopt}
  case "$operation" in adopt|--upgrade-v5) ;; *) printf 'FAIL unknown cutover operation\n' >&2; return 1 ;; esac
  umask 077
  mkdir -p migration-evidence
  chmod 700 migration-evidence
  exec 9> migration-evidence/cutover.lock
  # The inherited descriptor holds the lock even when the Python child exits.
  python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 2>/dev/null || {
    printf 'FAIL another cutover is running\n'
    return 1
  }
  evidence=$(mktemp -d "$PWD/migration-evidence/products-cutover-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
  active="$PWD/migration-evidence/active-cutover"
  previous=
  recovering=0
  [ ! -f "$active" ] || previous=$(cat "$active")
  if [ "$operation" = --upgrade-v5 ] && [ -n "$previous" ] && [ "$(cat "$previous/phase")" = complete ]; then
    previous=
  fi
  if [ -n "$previous" ] && [ -f "$previous/operation" ] && [ "$(cat "$previous/phase")" != rolled-back ] && [ "$(cat "$previous/operation")" != "$operation" ]; then
    printf 'FAIL interrupted cutover must resume with the same operation\n' >&2
    return 1
  fi
  printf '%s\n' "$operation" > "$evidence/operation"
  phase=preconditions
  started=$(date +%s)
  stopped_at=0
  stopping=0
  mutated=0
  forward_only=0
  backup=
  image=
  project=
  db=
  server=
  writers=()
  services=()
  runner=windmill-products-cutover
  exec 3>&1
  exec > "$evidence/control.log" 2>&1

  # A surviving Docker client must not retain the wrapper's lock after a parent-only SIGKILL.
  docker() ( exec 9>&-; exec docker "$@"; )
  python3() ( exec 9>&-; exec python3 "$@"; )

  db_sql() {
    docker compose exec -T db sh -ec \
      'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" -XAtq -v ON_ERROR_STOP=1'
  }

  db_tools() {
    docker run --rm --restart=no --name "$runner" --network "$network" \
      --env-file "$evidence/database.env" -i "$database_image" "$@"
  }

  remove_runner() {
    docker rm -f "$runner" > /dev/null 2>&1 || {
      local remaining
      remaining=$(docker ps -aq --filter "name=^/${runner}$") || return 1
      [ -z "$remaining" ]
    }
  }

  adopted() {
    db_sql <<< "SELECT to_regclass('public.gym_sync_adoptions') IS NOT NULL OR to_regclass('public.journal_sync_adoptions') IS NOT NULL;"
  }

  no_fixtures() {
    [ "$(db_sql <<< "SELECT (SELECT count(*) FROM pg_trigger WHERE tgname ~ '^wm_(gym|journal)_rehearsal_pause_') + (SELECT count(*) FROM pg_proc WHERE proname ~ '^wm_(gym|journal)_rehearsal_pause_') + (SELECT count(*) FROM pg_class WHERE relname ~ '^wm_(gym|journal)_rehearsal_pause_');")" = 0 ]
  }

  record_phase() {
    phase=$1
    python3 - "$evidence" "$active" "$phase" <<'PY'
import os
from pathlib import Path
import sys
evidence, active, phase = sys.argv[1:]
for path, value in ((Path(evidence) / "phase", phase), (Path(active), evidence)):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as output:
        output.write(value + "\n")
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    os.fsync(descriptor)
    os.close(descriptor)
PY
  }

  inventory() {
    local container found
    found=$(docker ps -aq --no-trunc --filter "label=com.docker.compose.project=$project") || return 1
    writers=()
    while IFS= read -r container; do
      [ -z "$container" ] || [ "$container" = "$db" ] || writers+=("$container")
    done <<< "$found"
    [ "${#writers[@]}" -gt 0 ]
  }

  stopped() {
    inventory || return 1
    docker inspect "${writers[@]}" > "$evidence/stopped.json" || return 1
    python3 - "$evidence/stopped.json" <<'PY'
import json
import sys
containers = json.load(open(sys.argv[1]))
if any(row["State"]["Running"] or row["HostConfig"]["RestartPolicy"]["Name"] != "no" for row in containers):
    raise SystemExit("compose services must be stopped with restart disabled")
PY
  }

  stop_services() {
    inventory || return 1
    docker update --restart=no "${writers[@]}" || return 1
    docker stop --time 60 "${writers[@]}" || return 1
    stopped
  }

  rows() {
    db_sql <<'SQL'
SET timezone='UTC';
SELECT format('SELECT jsonb_build_object(''table'', %L, ''rows'', coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"), ''[]''::jsonb))::text FROM %I.%I t;',
              schemaname || '.' || tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%'
ORDER BY schemaname, tablename
\gexec
SELECT format('SELECT jsonb_build_object(''sequence'', %L, ''last_value'', last_value, ''is_called'', is_called)::text FROM %I.%I;',
              sequence_schema || '.' || sequence_name, sequence_schema, sequence_name)
FROM information_schema.sequences WHERE sequence_schema NOT IN ('pg_catalog','information_schema')
ORDER BY sequence_schema, sequence_name
\gexec
SQL
  }

  verify_backup() {
    test -s "$backup" && test -s "$backup.sha256" && test -s "$evidence/rollback.rows" || return 1
    sha256sum -c "$backup.sha256" || return 1
    db_tools pg_restore --list < "$backup" > /dev/null
  }

  restore_backup() {
    stopped || return 1
    verify_backup || return 1
    # --create removes adoption-only objects too: --clean alone only drops objects in the old dump.
    db_tools pg_restore --dbname=postgres --create --clean --if-exists --exit-on-error \
      < "$backup" || return 1
    rows > "$evidence/restored.rows" || return 1
    cmp "$evidence/rollback.rows" "$evidence/restored.rows" || return 1
    [ "$(adopted)" = "$(cat "$evidence/rollback.adopted")" ]
  }

  start_old() {
    if [ "$operation" = adopt ]; then cp "$evidence/previous.env" .env || return 1; fi
    # These are the original containers, so recovery never runs schema.sql or changes their image.
    python3 - "$evidence/writers-before.json" "$server" <<'PY'
import json
import subprocess
import sys
resumed = []
for row in json.load(open(sys.argv[1])):
    policy = row["HostConfig"]["RestartPolicy"]
    restart = policy["Name"]
    if restart == "on-failure" and policy.get("MaximumRetryCount", 0):
        restart += ":" + str(policy["MaximumRetryCount"])
    subprocess.run(["docker", "update", "--restart=" + restart, row["Id"]], check=True)
    if row["State"]["Running"] or row["Id"] == sys.argv[2]:
        subprocess.run(["docker", "start", row["Id"]], check=True)
        resumed.append(row["Id"])
containers = json.loads(subprocess.check_output(["docker", "inspect", *resumed]))
if any(not row["State"]["Running"] for row in containers):
    raise SystemExit("old configuration did not stay running")
PY
  }

  recover() {
    if [ "$mutated" -eq 1 ]; then record_phase restoring || return 1; fi
    remove_runner || return 1
    stop_services || return 1
    if [ "$mutated" -eq 1 ]; then
      restore_backup || return 1
    fi
    if [ "$operation" = adopt ]; then cp "$evidence/previous.env" .env || return 1; fi
    # Legacy writes may resume at the next command. This backup is no longer eligible for automatic restore.
    record_phase rolled-back || return 1
    start_old
  }

  finish() {
    local status=$? recovery=unchanged elapsed outage failed_phase=$phase
    trap - EXIT HUP INT TERM
    set +e
    if [ "$status" -ne 0 ] && [ "$stopping" -eq 1 ] && [ "$forward_only" -eq 0 ]; then
      recovery='unchanged; old configuration running'
      [ "$mutated" -eq 0 ] || recovery='restored; old configuration running'
      if ! recover; then
        recovery='recovery-failed; verify services stopped; inspect private evidence before recovery'
        stop_services
        # A partial old startup can already have admitted legacy writes. Never revive its retired backup.
        [ "$phase" = rolled-back ] || record_phase recovery-failed
      fi
    fi
    elapsed=$(($(date +%s) - started))
    outage=0
    [ "$stopped_at" -eq 0 ] || outage=$(($(date +%s) - stopped_at))
    if [ "$status" -eq 0 ]; then
      printf 'PASS gym and journal cutover (%s); forward-only; automatic restore disabled\n' "$operation" >&3
      cat "$evidence/counts.json" >&3
    elif [ "$forward_only" -eq 1 ]; then
      printf 'FAIL %s; forward-only; automatic restore disabled; repair the adopted database forward\n' "$phase" >&3
    else
      printf 'FAIL %s; %s\n' "$failed_phase" "$recovery" >&3
    fi
    printf 'duration_seconds=%s stopped_seconds=%s\n' "$elapsed" "$outage" >&3
    if [ -n "$backup" ] && [ -s "$backup.sha256" ]; then
      printf 'backup=%s sha256=%s\n' "$backup" "$(cut -d' ' -f1 "$backup.sha256")" >&3
    fi
    exit "$status"
  }
  trap finish EXIT
  trap 'exit 1' HUP INT TERM

  # A saved startup boundary retires the archive even if interrupted startup removed the server.
  if [ -n "$previous" ]; then
    test -d "$previous" && test -f "$previous/phase"
    case $(cat "$previous/phase") in
      forward-only|complete)
        backup="$previous/rollback.dump"
        forward_only=1
        phase='already started; cutover rerun refused'
        return 1
        ;;
    esac
  fi

  # 1. Preconditions leave the live environment, services and database untouched.
  [ "${GYM_ENGINE_WRITES:-}" = 1 ]
  [ "${JOURNAL_ENGINE_WRITES:-}" = 1 ]
  [ "${GYM_WRITE_FREEZE:-}" = 0 ]
  [ "${JOURNAL_WRITE_FREEZE:-}" = 0 ]
  sync_enabled=${SYNC_ENABLED:-0}
  case "$sync_enabled" in 0|1) ;; *) return 1 ;; esac
  if [ "$operation" = adopt ]; then [ "$sync_enabled" = 0 ]; fi
  # Compose must read the live .env until prepare; exported workflow inputs otherwise override it.
  unset GYM_ENGINE_WRITES JOURNAL_ENGINE_WRITES GYM_WRITE_FREEZE JOURNAL_WRITE_FREEZE SYNC_ENABLED
  test -f .env
  db=$(docker compose ps -q db)
  server=$(docker compose ps -aq server)
  test -n "$db" && test -n "$server"
  docker inspect "$server" "$db" > "$evidence/runtime.json"
  docker compose config --format json > "$evidence/compose.json"
  python3 - "$evidence" "$operation" "$sync_enabled" <<'PY'
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit
evidence = Path(sys.argv[1])
server, database = json.loads((evidence / "runtime.json").read_text())
config = json.loads((evidence / "compose.json").read_text())
project = server["Config"]["Labels"].get("com.docker.compose.project", "")
if not database["State"]["Running"] or not project or database["Config"]["Labels"].get("com.docker.compose.project") != project or \
        server["Config"]["Labels"].get("com.docker.compose.service") != "server" or \
        database["Config"]["Labels"].get("com.docker.compose.service") != "db":
    raise SystemExit("server and database must belong to one running compose database")
entries = server["Config"]["Env"]
environment = {}
for entry in entries:
    if "\n" in entry or "\r" in entry or not re.match(r"^[A-Za-z_][A-Za-z_0-9]*=", entry):
        raise SystemExit("runtime environment cannot be represented as an env-file")
    key, value = entry.split("=", 1)
    if key in environment:
        raise SystemExit("duplicate runtime environment key")
    environment[key] = value
switches = {"GYM_ENGINE_WRITES": "1", "JOURNAL_ENGINE_WRITES": "1",
            "GYM_WRITE_FREEZE": "0", "JOURNAL_WRITE_FREEZE": "0", "SYNC_ENABLED": "0"}
if sys.argv[2] == "--upgrade-v5":
    switches["SYNC_ENABLED"] = sys.argv[3]
    if any(environment.get(key, "0") != value for key, value in switches.items()):
        raise SystemExit("live upgrade switches must match the validated deployment switches")
elif environment.get("SYNC_ENABLED", "0") != "0":
    raise SystemExit("base adoption requires SYNC_ENABLED=0")
(evidence / "switches.json").write_text(json.dumps(switches) + "\n")
(evidence / "environment-matches").write_text(str(all(environment.get(key) == str(value) for key, value in config["services"]["server"].get("environment", {}).items())) + "\n")
db_environment = dict(entry.split("=", 1) for entry in database["Config"]["Env"])
address = urlsplit(environment.get("DATABASE_URL", ""))
if address.scheme not in ("postgres", "postgresql") or address.port not in (None, 5432) or \
        unquote(address.path.lstrip("/")) != db_environment.get("POSTGRES_DB") or \
        unquote(address.username or "") != db_environment.get("POSTGRES_USER") or \
        unquote(address.password or "") != db_environment.get("POSTGRES_PASSWORD"):
    raise SystemExit("runtime database does not match compose Postgres")
networks = sorted(set(server["NetworkSettings"]["Networks"]) & set(database["NetworkSettings"]["Networks"]))
network = next((name for name in networks if address.hostname in (database["NetworkSettings"]["Networks"][name].get("Aliases") or [])), None)
if not network:
    raise SystemExit("runtime database must resolve on the shared network")
for name, value in {"image": server["Image"], "database-image": database["Image"], "network": network, "project": project,
                    "compose-image": config["services"]["server"]["image"]}.items():
    if not value or "\n" in value or "\r" in value:
        raise SystemExit("invalid runtime metadata")
    (evidence / name).write_text(value + "\n")
(evidence / "services").write_text("\n".join(name for name in config["services"] if name not in ("db", "migrate")) + "\n")
(evidence / "runtime.env").write_text("\n".join(entries) + "\n")
(evidence / "database.env").write_text("\n".join(key + "=" + value for key, value in {
    "PGHOST": address.hostname, "PGPORT": "5432", "PGUSER": db_environment["POSTGRES_USER"],
    "PGPASSWORD": db_environment["POSTGRES_PASSWORD"], "PGDATABASE": db_environment["POSTGRES_DB"],
    "PGCONNECT_TIMEOUT": "10"}.items()) + "\n")
PY
  image=$(cat "$evidence/image")
  database_image=$(cat "$evidence/database-image")
  network=$(cat "$evidence/network")
  project=$(cat "$evidence/project")
  while IFS= read -r service; do services+=("$service"); done < "$evidence/services"
  [ "$(docker image inspect --format '{{ index .Config.Labels "io.windmill.schema-adoption-compatibility" }}' "$image")" = gym-journal-v1 ]
  if [ "$operation" = --upgrade-v5 ]; then
    [ "$(docker image inspect --format '{{ index .Config.Labels "io.windmill.gym-sync-metadata-version" }}' "$image")" = 5 ]
    docker run --rm --network none "$image" bash /app/deploy/gym-migration/schema-compatibility.sh check-v5-image
  fi
  docker run --rm --network none "$image" bash /app/deploy/gym-migration/schema-compatibility.sh check-image
  [ "$(docker image inspect --format '{{.Id}}' "$(cat "$evidence/compose-image")")" = "$image" ]

  # A killed SSH process may leave its Docker child alive. Finish that child before deciding recovery.
  if [ -n "$previous" ]; then
    remove_runner
    backup="$previous/rollback.dump"
    case $(cat "$previous/phase") in
      restoring|recovery-failed)
        test -s "$backup.sha256" && test -s "$previous/rollback.rows"
        recovering=1
        ;;
    esac
  fi
  adoption_state=$(adopted) || { [ "$recovering" -eq 1 ] && adoption_state=f; }
  if [ "$recovering" -eq 0 ] && [ "$operation" = adopt ] && [ "$adoption_state" != f ]; then
    phase='already or partially adopted; rerun refused; keep services stopped, inspect the backup and private evidence; manually recover before traffic or repair forward after traffic'
    return 1
  fi
  if [ "$recovering" -eq 0 ] && [ "$operation" = --upgrade-v5 ]; then
    [ "$adoption_state" = t ]
  fi
  if [ "$recovering" -eq 0 ]; then
    [ "$(cat "$evidence/environment-matches")" = True ]
    no_fixtures
  fi

  inventory
  docker inspect "${writers[@]}" > "$evidence/writers-before.json"
  cp .env "$evidence/previous.env"
  # Preserve the original restart policies and switches when recovering an interrupted pre-adoption attempt.
  if [ -n "$previous" ] && [ "$(cat "$previous/phase")" != rolled-back ]; then
    cp "$previous/previous.env" "$evidence/previous.env"
    cp "$previous/writers-before.json" "$evidence/writers-before.json"
  elif [ -n "$previous" ]; then
    python3 - "$evidence/writers-before.json" "$previous/writers-before.json" <<'PY'
import json
from pathlib import Path
import sys
path = Path(sys.argv[1])
current = json.loads(path.read_text())
previous = {row["Id"]: row for row in json.load(open(sys.argv[2]))}
for row in current:
    original = previous.get(row["Id"])
    if original and row["HostConfig"]["RestartPolicy"]["Name"] == "no":
        row["HostConfig"]["RestartPolicy"] = original["HostConfig"]["RestartPolicy"]
        row["State"]["Running"] = row["State"]["Running"] or original["State"]["Running"]
path.write_text(json.dumps(current))
PY
  fi

  # 2. Stop the complete project except Postgres, including workers and orphan services.
  # Keep the interrupted attempt's recovery record active until its archive is fully restored.
  recovery_evidence=$evidence
  if [ -n "$previous" ] && [ -s "$previous/rollback.dump.sha256" ] && [ "$(cat "$previous/phase")" != rolled-back ]; then
    cp "$evidence/database.env" "$previous/database.env"
    evidence=$previous
    backup="$previous/rollback.dump"
    mutated=1
  fi
  stopping=1
  stopped_at=$(date +%s)
  if [ "$mutated" -eq 1 ]; then record_phase restoring; else record_phase stopping; fi
  stop_services
  if [ "$recovering" -eq 0 ]; then
    [ "$(db_sql <<< "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid();")" = 0 ]
  fi
  if [ "$mutated" -eq 1 ]; then
    restore_backup
    if [ "$operation" = adopt ]; then cp "$previous/previous.env" .env; fi
    mutated=0
    evidence=$recovery_evidence
  fi
  record_phase stopping
  no_fixtures

  # 3. This is the rollback point: no compose writer can run until recovery or adoption has passed.
  record_phase backup
  backup="$evidence/rollback.dump"
  rows > "$evidence/rollback.rows"
  adopted > "$evidence/rollback.adopted"
  db_tools pg_dump --format=custom --create > "$backup.partial"
  test -s "$backup.partial"
  db_tools pg_restore --list < "$backup.partial" > /dev/null
  mv "$backup.partial" "$backup"
  sha256sum "$backup" > "$backup.sha256.partial"
  mv "$backup.sha256.partial" "$backup.sha256"
  verify_backup

  # 4. Production uses the full rehearsal gates, without any disposable fault fixtures.
  record_phase migration
  mutated=1
  stopped
  if [ "$operation" = --upgrade-v5 ]; then
    db_sql <<< 'SELECT epoch FROM sync_meta;' > "$evidence/epoch-before"
    test -s "$evidence/epoch-before"
  fi
  migration_mode=--apply-adoption
  [ "$operation" != --upgrade-v5 ] || migration_mode=--upgrade-v5
  docker run --rm --restart=no --name "$runner" --network "$network" \
    --user "$(id -u):$(id -g)" --env-file "$evidence/runtime.env" \
    --mount "type=bind,src=$evidence,dst=/evidence" "$image" \
    python3 /app/deploy/gym-migration/rehearse.py --bin-dir /usr/local/bin --output /evidence/run "$migration_mode"
  python3 - "$evidence/run/result.json" <<'PY' > "$evidence/counts.json"
import json
import sys
result = json.load(open(sys.argv[1]))
if result["passed"] is not True:
    raise SystemExit("product audits did not pass")
print(json.dumps({key: result[key] for key in ("accounts", "initialTableRows", "responses", "auditedScopes", "tables")}, sort_keys=True))
PY
  if [ "$operation" = --upgrade-v5 ]; then
    [ "$(db_sql <<< 'SELECT epoch FROM sync_meta;')" = "$(cat "$evidence/epoch-before")" ]
  fi

  # 5. Validate the next environment while every writer is still stopped.
  record_phase prepare
  stopped
  if [ "$operation" = adopt ]; then
    python3 - .env <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
switches = {"GYM_ENGINE_WRITES": "1", "JOURNAL_ENGINE_WRITES": "1",
            "GYM_WRITE_FREEZE": "0", "JOURNAL_WRITE_FREEZE": "0", "SYNC_ENABLED": "0"}
lines = [line for line in path.read_text().splitlines() if line.split("=", 1)[0] not in switches]
temporary = path.with_suffix(".cutover.tmp")
temporary.write_text("\n".join(lines + [key + "=" + value for key, value in switches.items()]) + "\n")
temporary.replace(path)
PY
  else
    cmp "$evidence/previous.env" .env
  fi
  docker compose config -q
  # Persist this BEFORE any start call: a failed/interruptible start can already have accepted writes.
  record_phase forward-only
  forward_only=1
  docker compose up -d --wait --no-deps --pull never "${services[@]}"
  python3 - "$evidence/compose.json" <<'PY'
import json
import subprocess
import sys
for service, settings in json.load(open(sys.argv[1]))["services"].items():
    if service in ("db", "migrate"):
        continue
    containers = subprocess.check_output(["docker", "compose", "ps", "-aq", service], text=True).split()
    if containers:
        subprocess.run(["docker", "update", "--restart=" + settings.get("restart", "no"), *containers], check=True)
PY
  docker inspect "$(docker compose ps -q server)" > "$evidence/started.json"
  python3 - "$evidence/started.json" "$image" "$evidence/switches.json" <<'PY'
import json
import sys
server, = json.load(open(sys.argv[1]))
environment = dict(entry.split("=", 1) for entry in server["Config"]["Env"])
required = json.load(open(sys.argv[3]))
if server["Image"] != sys.argv[2] or not server["State"]["Running"] or any(environment.get(key, "0") != value for key, value in required.items()):
    raise SystemExit("started server image or switches do not match the audited cutover")
PY
  docker compose exec -T server sh -ec '
    curl --silent --show-error --max-time 15 --output /dev/null http://localhost:8080/
    test "$(curl --silent --show-error --max-time 15 --output /tmp/cutover-gallery.json --write-out "%{http_code}" http://localhost:8080/v1/gallery)" = 200
    python3 -c '\''import json; json.load(open("/tmp/cutover-gallery.json"))'\''
  '
  epoch=$(db_sql <<< 'SELECT epoch FROM sync_meta;')
  if [ "$operation" = --upgrade-v5 ]; then
    [ "$epoch" = "$(cat "$evidence/epoch-before")" ]
  fi
  docker compose exec -T server sh -ec '
    status=$(curl --silent --show-error --max-time 15 --output /tmp/cutover-sync.json --write-out "%{http_code}" http://localhost:8080/v1/sync/hello)
    if [ "$SYNC_ENABLED" = 1 ]; then
      test "$status" = 400
      python3 -c '\''import json,sys; reply=json.load(open("/tmp/cutover-sync.json")); assert reply["error"] == "malformed" and reply["epoch"] == sys.argv[1]'\'' "$1"
    else
      test "$status" = 404
    fi
  ' sh "$epoch"
  for product in gym journal; do
    docker compose exec -T server "windmill_${product}_backfill" --audit-current
  done
  record_phase complete
}

main "$@" < /dev/null
