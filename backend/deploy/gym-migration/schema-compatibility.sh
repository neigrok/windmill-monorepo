#!/usr/bin/env bash
set -euo pipefail

compatibility=gym-journal-v1
marker="-- windmill-schema-adoption-compatibility: $compatibility"
mode=${1:?usage: schema-compatibility.sh check-image [schema] | apply DATABASE_URL [schema]}
shift

check_image() {
  if [[ ! -f "$schema" ]] || ! grep -Fxq -- "$marker" "$schema"; then
    echo "schema is not adoption-compatible ($compatibility): $schema" >&2
    exit 1
  fi
}

case "$mode" in
  check-image)
    schema=${1:-/app/db/schema.sql}
    check_image
    ;;
  apply)
    database=${1:?DATABASE_URL is required}
    schema=${2:-/app/db/schema.sql}
    adopted=$(psql "$database" -XAtq -v ON_ERROR_STOP=1 -c \
      "SELECT to_regclass('public.gym_sync_adoptions') IS NOT NULL OR to_regclass('public.journal_sync_adoptions') IS NOT NULL")
    if [[ "$adopted" == t ]]; then
      check_image
    fi
    psql "$database" -Xq -v ON_ERROR_STOP=1 -f "$schema"
    ;;
  *)
    echo "unknown schema compatibility operation: $mode" >&2
    exit 1
    ;;
esac
