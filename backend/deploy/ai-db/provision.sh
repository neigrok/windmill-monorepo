#!/usr/bin/env bash
# The AI service's database (services/ai/ARCHITECTURE.md): `windmill_ai`,
# owned by a role of the same name and closed to the backend's role by the rules in pg_hba.conf beside
# this file. The compose one-shot `ai-db` runs it on every `up`, before anything uses the
# database, as the cluster's OS user with the cluster's volume mounted, so it can rewrite pg_hba.conf.
# Every step can run again. Compose starts this after subscriptions-db has finished rewriting HBA.
#
# psql reaches the cluster as the backend does: PGHOST, PGUSER (the backend's role, the cluster's
# superuser), PGPASSWORD and PGDATABASE (the backend's database) are the backend's.
set -euo pipefail

if [[ -z "${AI_DB_PASSWORD:-}" ]]; then
  printf 'FAIL AI database: AI_DB_PASSWORD is not set\n' >&2
  exit 1
fi

fail() {
  printf 'FAIL AI database: %s\n' "$1" >&2
  exit 1
}

# Whether a pg_hba.conf rule turns `role` away from `database` on the path the backend takes.
refused() {
  local answer
  if answer=$(psql -XAtq "dbname=$2 user=$1" -c 'select 1' 2>&1); then
    return 1
  fi
  [[ "$answer" == *'pg_hba.conf rejects connection'* ]]
}

# Whether a fresh connection of the backend's role reaches the backend's database.
admitted() {
  psql -XAtq -c 'select 1' > /dev/null 2>&1
}

# 1. The rules go in first, so the database never exists without them. They lead pg_hba.conf, where
#    the first matching line decides, between markers that each run replaces. A rewrite that would
#    turn the backend away is never put in force.
hba=$(psql -XAtq -c 'show hba_file') || fail "the cluster does not answer the backend's role"
[[ -w "$hba" ]] || fail "the cluster's pg_hba.conf is not writable from this container"
begin='# BEGIN windmill_ai'
end='# END windmill_ai'
next=$(mktemp "$hba.next.XXXXXX")
previous=$(mktemp "$hba.previous.XXXXXX")
trap 'rm -f "$next" "$previous"' EXIT
# `awk 1` ends every line of the rules with a newline, the last one included, so the end marker always
# stands on a line of its own. A block left open in the live file would take every line after it, so it
# stops the run instead.
{
  printf '%s: written by ai-db on every deploy\n' "$begin"
  awk 1 "$(dirname "$0")/pg_hba.conf"
  printf '%s\n' "$end"
  awk -v begin="$begin" -v end="$end" '
    index($0, begin) == 1 { inside = 1 }
    !inside { print }
    index($0, end) == 1 { inside = 0 }
    END { exit inside }' "$hba"
} > "$next" || fail "pg_hba.conf holds a windmill_ai block with no end, so it is left as it was"

# Through the session held open across the reload, from which a reload never takes the connection away.
held() {
  printf '%s\n' "$1" >&"${HELD[1]}"
  read -r -t 10 held_answer <&"${HELD[0]}"
}

# Whether the file on disk parses, and its first rule for the backend's role on its database, over the
# network and over the socket, admits it. Rules for one address are not the backend's path.
admits_backend="select not exists (select from pg_hba_file_rules where error is not null)
  and bool_and(coalesce((
    select auth_method <> 'reject' from pg_hba_file_rules
    where type = path and (path = 'local' or address = 'all')
      and (database @> '{all}' or database @> array[current_database()::text])
      and (user_name @> '{all}' or user_name @> array[current_user::text])
    order by rule_number limit 1), false))
  from unnest(array['local', 'host']) as path;"

if cmp -s "$next" "$hba" && refused windmill windmill_ai; then
  rules=unchanged
else
  coproc HELD { exec psql -XAtq -v VERBOSITY=sqlstate 2>&1; }
  held "select 'held';" && [[ "$held_answer" == held ]] ||
    fail "no session of the backend's role could be held open, so pg_hba.conf is left as it was"
  cp -p "$hba" "$previous"
  mv "$next" "$hba"
  if ! held "$admits_backend" || [[ "$held_answer" != t ]]; then
    mv "$previous" "$hba"
    fail "the rewritten pg_hba.conf would not admit the backend's role, so it is left as it was"
  fi
  if ! held 'select pg_reload_conf();'; then
    mv "$previous" "$hba"
    fail "Postgres could not be asked to reload, so pg_hba.conf is left as it was"
  fi
  for _ in $(seq 50); do
    refused windmill windmill_ai && break
    sleep 0.1
  done
  if ! refused windmill windmill_ai || ! admitted; then
    mv "$previous" "$hba"
    held 'select pg_reload_conf();' || true
    for _ in $(seq 50); do
      admitted && break
      sleep 0.1
    done
    admitted || fail "the reloaded rules turned the backend's role away, and the previous pg_hba.conf, back on disk, is not in force: follow \"Let the backend in again\" in backend/deploy/README.md"
    fail "the reloaded rules did not hold for the backend's role, so the previous pg_hba.conf is back in force"
  fi
  held_input=${HELD[1]}
  exec {held_input}>&-
  wait "$HELD_PID" || true
  rules=installed
fi

# 2. The role takes the password the service is given on every run, so rotating the secret rotates it.
#    A statement below carries the password, so this session logs no statement on the server, even
#    one that fails or runs long, and psql reports an error by its SQLSTATE alone.
psql -XAq -v ON_ERROR_STOP=1 <<'SQL' || fail "the role or the database could not be created"
\set VERBOSITY sqlstate
set log_statement = 'none';
set log_min_error_statement = panic;
set log_min_duration_statement = -1;
\getenv password AI_DB_PASSWORD
select 'create role windmill_ai'
  where not exists (select from pg_roles where rolname = 'windmill_ai') \gexec
alter role windmill_ai
  with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'password';
select 'create database windmill_ai owner windmill_ai'
  where not exists (select from pg_database where datname = 'windmill_ai') \gexec
alter database windmill_ai owner to windmill_ai;
revoke all on database windmill_ai from public;
SQL

# 3. The service's own credentials work, its role reaches nothing of the backend's, and the backend
#    still reaches its own database.
PGPASSWORD=$AI_DB_PASSWORD \
  psql -XAtq "dbname=windmill_ai user=windmill_ai" -c 'select 1' > /dev/null 2>&1 ||
  fail "the role windmill_ai cannot sign in to its database"
refused windmill_ai "$PGDATABASE" ||
  fail "the role windmill_ai reaches the backend's database"
admitted || fail "the backend's role no longer reaches its own database"

printf 'PASS AI database: windmill_ai provisioned, refused to other roles (rules %s)\n' "$rules"
