#!/usr/bin/env bash
# The subscription service's database (services/subscriptions/ARCHITECTURE.md): `windmill_subscriptions`,
# owned by a role of the same name and closed to the backend's role by the rules in pg_hba.conf beside
# this file. The compose one-shot `subscriptions-db` runs it on every `up`, before anything uses the
# database, as the cluster's OS user with the cluster's volume mounted, so it can rewrite pg_hba.conf.
# Every step can run again. While SUBSCRIPTIONS_DB_PASSWORD is unset it changes nothing.
#
# psql reaches the cluster over the network as its superuser, through PGHOST, PGUSER and PGPASSWORD.
set -euo pipefail

if [[ -z "${SUBSCRIPTIONS_DB_PASSWORD:-}" ]]; then
  printf 'SKIP subscriptions database: SUBSCRIPTIONS_DB_PASSWORD is not set, so nothing was provisioned\n'
  exit 0
fi

fail() {
  printf 'FAIL subscriptions database: %s\n' "$1" >&2
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

# 1. The rules go in first, so the database never exists without them. They lead pg_hba.conf, where
#    the first matching line decides, between markers that each run replaces.
hba=$(psql -XAtq -c 'show hba_file')
[[ -w "$hba" ]] || fail "the cluster's pg_hba.conf is not writable from this container"
begin='# BEGIN windmill_subscriptions'
end='# END windmill_subscriptions'
next=$(mktemp "$hba.next.XXXXXX")
previous=$(mktemp "$hba.previous.XXXXXX")
trap 'rm -f "$next" "$previous"' EXIT
{
  printf '%s: written by subscriptions-db on every deploy\n' "$begin"
  cat "$(dirname "$0")/pg_hba.conf"
  printf '%s\n' "$end"
  awk -v begin="$begin" -v end="$end" '
    index($0, begin) == 1 { inside = 1 }
    !inside { print }
    index($0, end) == 1 { inside = 0 }' "$hba"
} > "$next"
if cmp -s "$next" "$hba"; then
  rules=unchanged
else
  cp -p "$hba" "$previous"
  mv "$next" "$hba"
  # pg_hba_file_rules parses the file on disk; Postgres keeps the rules it loaded until the reload.
  if [[ "$(psql -XAtq -c 'select count(*) from pg_hba_file_rules where error is not null')" != 0 ]]; then
    mv "$previous" "$hba"
    fail "the rewritten pg_hba.conf does not parse, so the previous one is back in place"
  fi
  rules=installed
fi
psql -XAtq -c 'select pg_reload_conf()' > /dev/null
for _ in $(seq 50); do
  refused windmill windmill_subscriptions && break
  sleep 0.1
done
refused windmill windmill_subscriptions ||
  fail "the backend's role still reaches windmill_subscriptions"

# 2. The role takes the password the service is given on every run, so rotating the secret rotates it.
#    A statement below carries the password, so this session logs no statement on the server, even
#    one that fails, and psql reports an error by its SQLSTATE alone.
psql -XAq -v ON_ERROR_STOP=1 <<'SQL' || fail "the role or the database could not be created"
\set VERBOSITY sqlstate
set log_statement = 'none';
set log_min_error_statement = panic;
\getenv password SUBSCRIPTIONS_DB_PASSWORD
select 'create role windmill_subscriptions'
  where not exists (select from pg_roles where rolname = 'windmill_subscriptions') \gexec
alter role windmill_subscriptions
  with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password :'password';
select 'create database windmill_subscriptions owner windmill_subscriptions'
  where not exists (select from pg_database where datname = 'windmill_subscriptions') \gexec
alter database windmill_subscriptions owner to windmill_subscriptions;
revoke all on database windmill_subscriptions from public;
SQL

# 3. The service's own credentials work, and its role reaches nothing of the backend's.
PGPASSWORD=$SUBSCRIPTIONS_DB_PASSWORD \
  psql -XAtq "dbname=windmill_subscriptions user=windmill_subscriptions" -c 'select 1' > /dev/null 2>&1 ||
  fail "the role windmill_subscriptions cannot sign in to its database"
refused windmill_subscriptions windmill ||
  fail "the role windmill_subscriptions reaches the backend's database"

printf 'PASS subscriptions database: windmill_subscriptions provisioned, refused to the backend role (rules %s)\n' "$rules"
