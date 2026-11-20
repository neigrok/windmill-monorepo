#!/usr/bin/env bash
# Roadmap's cutover onto the sync engine on the host, one stage a call, run from ~/windmill by roadmap-cutover.yml and
# ops-roadmap-restore.yml (README.md, "Roadmap's cutover onto the sync engine"). Every line a stage prints is a count or
# a verdict. What the move read and wrote, and what Postgres says of a failed restore, stay in the run's folder, which
# only `record` writes out, for the runner to seal.
set -euo pipefail

stage=${1:-}
run=${2:-}
if [[ ! "$run" =~ ^[0-9]{1,20}-[0-9]{1,5}$ ]]; then
  printf 'FAIL usage: roadmap-cutover.sh <stage> <run id>-<attempt> [image commit]\n' >&2
  exit 2
fi
work="roadmap-cutover/$run"
tool="windmill-roadmap-adopt-$run"
probe="windmill-roadmap-probe-$run"
moved="windmill_cutover_${run//-/_}"
demo=t_9e407a96b5330ebe

fail() {
  printf 'FAIL %s: %s\n' "$stage" "$1" >&2
  exit 1
}

sql() {
  docker compose exec -T db psql --username=windmill --dbname="$1" -XAtq -v ON_ERROR_STOP=1 -c "$2"
}

# A server's answer from inside its container, its status on the last line: the live server's, or the probe's in check.
asking=(docker compose exec -T server)
ask() {
  "${asking[@]}" curl --silent --max-time 5 --write-out '\n%{http_code}' -X "$1" \
    -H 'Sync-Schema: 2147483647' "http://127.0.0.1:8080$2"
}

serving() {
  for ((attempt = 0; attempt < 60; attempt++)); do
    if [[ "$(ask GET /v1/sync/hello 2> /dev/null | tail -n 1)" == 200 ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# One check of a server: the method and path, the status it must answer and, for a refusal, its JSON code.
unexpected=0
expect() {
  local answer status code=""
  answer=$(ask "$1" "$2" 2> /dev/null) || answer=$'\n000'
  status=${answer##*$'\n'}
  if [[ -n "${4:-}" ]]; then
    code=$(python3 -c 'import json, sys
try:
    print(json.loads(sys.stdin.read()).get("code", ""))
except (ValueError, AttributeError):
    print("")' <<< "${answer%$'\n'*}")
    code=${code//[^a-z-]/}
  fi
  if [[ "$status" == "$3" && "$code" == "${4:-}" ]]; then
    printf 'PASS %s: %s %s answers %s%s\n' "$stage" "$1" "$2" "$status" "${code:+ $code}"
  else
    printf 'FAIL %s: %s %s answers %s%s, not %s%s\n' "$stage" "$1" "$2" "$status" "${code:+ $code}" "$3" "${4:+ $4}" >&2
    unexpected=1
  fi
}

case "$stage" in
  check)
    image=${3:-}
    [[ "$image" =~ ^[a-f0-9]{40}$ ]] || fail "the image commit must be a full SHA"
    [[ -f .env ]] || fail "no deployment lives here"
    [[ "$(sed -n 's/^IMAGE_TAG=//p' .env)" == "$image" ]] || fail "the live deployment runs another commit than $image"
    pinned=$(sed -n 's/^SERVER_IMAGE=//p' .env)
    container=$(docker compose ps -q server)
    [[ -n "$container" && "$(docker inspect --format '{{.Image}}' "$container")" == "$pinned" ]] ||
      fail "the server is not running its pinned image"
    docker compose exec -T server sh -c 'command -v windmill_roadmap_adopt' > /dev/null ||
      fail "the live image does not carry windmill_roadmap_adopt"
    [[ ! -s roadmap-engine.env ]] || fail "roadmap is on the sync engine here already"
    grep -q 'roadmap-engine.env' docker-compose.yml || fail "the live compose file does not read roadmap-engine.env"
    docker compose exec -T caddy test -d /srv/windmill-maintenance || fail "Caddy does not mount the maintenance folder"
    [[ ! -e maintenance/on ]] || fail "the site is paused already"
    [[ ! -e "$work" ]] || fail "this run has been here before"
    database=$(sql postgres "select pg_database_size('windmill')")
    beside_backups=$(df -Pk . | awk 'NR == 2 { print $4 }')
    beside_database=$(docker compose exec -T db df -Pk /var/lib/postgresql/data | awk 'NR == 2 { print $4 }')
    # The backup, the restored copy a stop needs, and what the move adds, each at most the database's size.
    needed=$((3 * database / 1024 + 1048576))
    printf 'disk: the database %s MB; free %s MB beside the backups and %s MB beside the database; %s MB needed\n' \
      "$((database / 1048576))" "$((beside_backups / 1024))" "$((beside_database / 1024))" "$((needed / 1024))"
    ((beside_backups >= needed && beside_database >= needed)) || fail "too little free disk for a backup and its restore"
    # The pinned image, serving roadmap's scopes over a throwaway database of its own schema, on no setting of the live
    # server's but its port: what §8.3 asks of it after the move, proven before anything pauses.
    # A probe a killed check left behind goes first: its container, its database and its settings, which name the password.
    umask 077
    mkdir -p roadmap-cutover
    probe_settings=roadmap-cutover/probe.env
    leftovers=$(docker ps -aq --filter name=windmill-roadmap-probe-)
    [[ -z "$leftovers" ]] || docker rm -f $leftovers > /dev/null
    trap 'docker rm -f "$probe" > /dev/null 2>&1 || true; rm -f "$probe_settings"
          sql postgres "drop database if exists windmill_roadmap_probe with (force)" > /dev/null 2>&1 || true' EXIT
    sql postgres "drop database if exists windmill_roadmap_probe with (force)" > /dev/null 2>&1 ||
      fail "a probe database left behind could not be dropped"
    docker compose exec -T db createdb --username=windmill --owner=windmill windmill_roadmap_probe
    docker run --rm --entrypoint cat "$pinned" /app/db/schema.sql |
      docker compose exec -T db psql --username=windmill --dbname=windmill_roadmap_probe -Xq -v ON_ERROR_STOP=1 > /dev/null 2>&1 ||
      fail "the image's schema did not apply to a throwaway database"
    printf 'DATABASE_URL=postgresql://windmill:%s@db:5432/windmill_roadmap_probe\nPORT=8080\nROADMAP_ENGINE_ENABLED=1\n' \
      "$(sed -n 's/^POSTGRES_PASSWORD=//p' .env)" > "$probe_settings"
    docker run -d --rm --name "$probe" --network windmill_default --env-file "$probe_settings" "$pinned" > /dev/null
    asking=(docker exec "$probe")
    serving || fail "the image did not answer hello within 60 s while serving roadmap's scopes"
    expect GET /v1/socket 410 client-update-required
    expect POST /v1/trees 410 client-update-required
    ((unexpected == 0)) || fail "the image does not retire roadmap's own routes when it serves roadmap's scopes"
    printf 'PASS check: the server runs %s and carries windmill_roadmap_adopt; roadmap is off the engine; the pause is mounted\n' \
      "$image"
    ;;
  pause)
    mkdir -p maintenance
    printf 'roadmap cutover %s\n' "$run" > maintenance/on.next
    mv maintenance/on.next maintenance/on
    printf 'PASS pause: maintenance/on is set\n'
    ;;
  stop)
    docker compose stop server
    for ((attempt = 0; attempt < 30; attempt++)); do
      others=$(sql postgres "select count(*) from pg_stat_activity where datname = 'windmill' and backend_type = 'client backend'")
      [[ "$others" == 0 ]] && break
      sleep 1
    done
    if [[ "$others" != 0 ]]; then
      printf 'FAIL stop: %s client sessions are still on the database after 30 s, by application:\n' "$others" >&2
      sql postgres "select coalesce(nullif(regexp_replace(split_part(application_name, ' ', 1), '[^A-Za-z0-9_.-]', '', 'g'), ''),
                      '(unnamed)') || ' ' || count(*) from pg_stat_activity
                    where datname = 'windmill' and backend_type = 'client backend' group by 1 order by 1" >&2
      exit 1
    fi
    printf 'PASS stop: the server is stopped and no client is on the database\n'
    ;;
  backup)
    umask 077
    mkdir -p backups "$work"
    chmod 700 backups "$work"
    backup="backups/roadmap-cutover-$run-$(date -u +%Y%m%dT%H%M%SZ).dump"
    trap 'rm -f "$backup.partial"' EXIT
    docker compose exec -T db pg_dump --username=windmill --dbname=windmill --format=custom > "$backup.partial"
    test -s "$backup.partial" || fail "the dump is empty"
    contents=$(docker compose exec -T db pg_restore --list < "$backup.partial")
    grep -qxF ';     dbname: windmill' <<< "$contents" || fail "the dump does not read back as a dump of windmill"
    mv "$backup.partial" "$backup"
    sha256sum "$backup" > "$backup.sha256"
    printf '%s\n' "$backup" > "$work/backup"
    printf 'PASS backup verified: %s, %s bytes\n' "$backup" "$(wc -c < "$backup" | tr -d ' ')"
    cat "$backup.sha256"
    ;;
  adopt)
    [[ -s "$work/backup" ]] || fail "this run holds no verified backup"
    umask 077
    mkdir -p "$work/record"
    [[ -f "$work/expected-ownerless" ]] || : > "$work/expected-ownerless"
    outcome=0
    docker compose run --rm --no-deps -T --name "$tool" --user "$(id -u):$(id -g)" \
      --volume "$PWD/$work/record:/adoption/record" \
      --volume "$PWD/$work/expected-ownerless:/adoption/expected-ownerless:ro" \
      --env ROADMAP_ADOPTION_PRIVATE_DIR=/adoption/record \
      --env ROADMAP_ADOPTION_EXPECTED_OWNERLESS=/adoption/expected-ownerless \
      server windmill_roadmap_adopt all > "$work/stages.jsonl" 2> "$work/record/tool.stderr" || outcome=$?
    rm -f "$work/expected-ownerless"
    # Only a stage's own line reaches the log, and only in its own shape: a stage, a verdict, a time and counts named by
    # the code's words. Anything else the tool wrote is counted and left out.
    answered=$(python3 - "$work/stages.jsonl" <<'PY'
import json
import re
import sys

word = re.compile(r"[a-z][A-Za-z0-9]*")


def counts(value):
    return isinstance(value, dict) and all(
        word.fullmatch(name) and (counts(inner) or (type(inner) is int and inner >= 0)) for name, inner in value.items())


withheld = 0
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    try:
        report = json.loads(line)
        shaped = (isinstance(report, dict) and set(report) == {"stage", "verdict", "ms", "counts"}
                  and isinstance(report["stage"], str) and re.fullmatch(r"[a-z][a-z-]*", report["stage"]) is not None
                  and isinstance(report["verdict"], str) and word.fullmatch(report["verdict"]) is not None
                  and type(report["ms"]) is int and report["ms"] >= 0 and counts(report["counts"]))
    except ValueError:
        shaped = False
    if shaped:
        print(json.dumps(report, sort_keys=True, separators=(",", ":")))
    else:
        withheld += 1
if withheld:
    print(f"WITHHELD adopt: {withheld} lines of the tool's output were not a stage's counts")
PY
)
    rm -f "$work/stages.jsonl"
    [[ -z "$answered" ]] || printf '%s\n' "$answered"
    case "$outcome" in
      0) printf 'PASS adopt: every stage passed\n' ;;
      3)
        printf 'STOP adopt: a stage did not pass, and nothing after it ran\n' >&2
        exit 3 ;;
      *)
        grep -q '^{' <<< "$answered" ||
          fail "windmill_roadmap_adopt exited $outcome before any stage answered; what it said is in the sealed record"
        fail "windmill_roadmap_adopt exited $outcome" ;;
    esac
    ;;
  record)
    [[ -d "$work" ]] || fail "this run keeps nothing on the host"
    docker rm -f "$tool" > /dev/null 2>&1 || true
    tar -C "$work" -cf - .
    ;;
  forget)
    rm -rf "$work/record" "$work/expected-ownerless" "$work/stages.jsonl" "$work/restore.log" "$work/migrate.log"
    printf 'PASS forget: what the run kept on the host is gone, but for its backup\n'
    ;;
  start)
    [[ ! -s roadmap-engine.env ]] || fail "roadmap is on the sync engine here already"
    printf '%s\n' "$(sed -n 's/^IMAGE_TAG=//p' .env)" > roadmap-engine.floor.next
    mv roadmap-engine.floor.next roadmap-engine.floor
    printf 'ROADMAP_ENGINE_ENABLED=1\n' > roadmap-engine.env.next
    mv roadmap-engine.env.next roadmap-engine.env
    docker compose up -d --no-deps --pull never server
    serving || fail "the server did not answer hello within 60 s"
    docker compose exec -T server sh -c 'grep -Fzxq ROADMAP_ENGINE_ENABLED=1 /proc/1/environ' ||
      fail "the running server does not hold ROADMAP_ENGINE_ENABLED=1"
    [[ "$(docker inspect --format '{{.Image}}' "$(docker compose ps -q server)")" == "$(sed -n 's/^SERVER_IMAGE=//p' .env)" ]] ||
      fail "the server is not running its pinned image"
    compatibility=$(ask GET /v1/sync/hello | sed '$d' | python3 -c 'import json, sys
hello = json.load(sys.stdin)
print(int(hello["schema"]), int(hello["minSchema"]))')
    printf 'PASS start: the server runs its pinned image with ROADMAP_ENGINE_ENABLED=1; hello says schema %s, minimum %s\n' \
      "${compatibility% *}" "${compatibility#* }"
    ;;
  smoke)
    expect GET /v1/sync/hello 200
    expect GET /v1/socket 410 client-update-required
    expect POST /v1/trees 410 client-update-required
    expect GET "/v1/trees/$demo/progress" 200
    expect GET "/v1/trees/$demo/activity" 200
    expect GET "/t/$demo" 200
    expect GET /gallery 200
    exit "$unexpected"
    ;;
  lift)
    rm -f maintenance/on
    printf 'PASS lift: maintenance/on is gone\n'
    ;;
  # Only beside the run it belongs to: the site paused and the server stopped, as the cutover leaves them before writes
  # resume. Run again where it stopped: once windmill holds the backup and the moved database is kept, only the start is
  # left; once it finished, it is never run again.
  restore)
    [[ -s "$work/backup" ]] || fail "this run holds no verified backup"
    [[ ! -e "$work/restored" ]] || fail "this run's backup is restored already"
    [[ ! -s roadmap-engine.env ]] || fail "roadmap's switch is written, so the cutover goes forward only"
    [[ -e maintenance/on ]] || fail "the site is not paused, so whatever runs here now is not this run's"
    [[ -z "$(docker compose ps -q server)" ]] || fail "the server is running, so whatever runs here now is not this run's"
    rm -f roadmap-engine.floor
    backup=$(cat "$work/backup")
    docker rm -f "$tool" > /dev/null 2>&1 || true
    if [[ "$(sql postgres "select count(*) from pg_database where datname = '$moved'")" == 0 ]]; then
      sha256sum --check --status "$backup.sha256" || fail "the backup no longer matches its sha256"
      contents=$(docker compose exec -T db pg_restore --list < "$backup")
      grep -qxF ';     dbname: windmill' <<< "$contents" || fail "the backup does not read back as a dump of windmill"
      sql postgres "drop database if exists windmill_restore" > /dev/null 2>&1 ||
        fail "a restored database an earlier attempt left could not be dropped"
      docker compose exec -T db createdb --username=windmill --owner=windmill windmill_restore
      docker compose exec -T db pg_restore --username=windmill --dbname=windmill_restore --single-transaction \
        --exit-on-error --no-owner --no-acl < "$backup" 2> "$work/restore.log" ||
        fail "pg_restore did not restore the backup; windmill is as the move left it, and Postgres' words go to the sealed record"
      sql postgres "select count(pg_terminate_backend(pid)) from pg_stat_activity
                    where datname = 'windmill' and pid <> pg_backend_pid()" > /dev/null
      sql postgres "alter database windmill rename to $moved; alter database windmill_restore rename to windmill" ||
        fail "the restored database could not take windmill's name"
    else
      printf 'NOTE restore: windmill holds the backup already and the moved database is kept, so only the start is left\n'
    fi
    docker compose run --rm --no-deps -T migrate > "$work/migrate.log" 2>&1 ||
      fail "the schema did not apply to the restored database; its words go to the sealed record"
    docker compose up -d --no-deps --no-recreate --pull never server
    serving || fail "the server did not answer on the restored database within 60 s, and the site stays paused"
    printf 'restored\n' > "$work/restored"
    rm -f maintenance/on
    printf 'PASS restore: windmill is %s again, its sha256 matched; the moved database is kept as %s\n' "$backup" "$moved"
    printf 'PASS restore: the server serves as before the cutover, roadmap off the engine, and the site is lifted\n'
    ;;
  undo)
    docker compose up -d --no-deps --no-recreate --pull never server
    serving || fail "the server did not answer within 60 s, and the site stays paused"
    rm -f maintenance/on
    printf 'PASS undo: the database was never changed; the server serves as before and the site is lifted\n'
    ;;
  *)
    printf 'FAIL usage: roadmap-cutover.sh <check|pause|stop|backup|adopt|record|forget|start|smoke|lift|restore|undo> <run id>-<attempt>\n' >&2
    exit 2
    ;;
esac
