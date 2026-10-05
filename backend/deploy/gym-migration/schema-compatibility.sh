#!/usr/bin/env bash
set -euo pipefail

compatibility=gym-journal-v1
marker="-- windmill-schema-adoption-compatibility: $compatibility"
mode=${1:?usage: schema-compatibility.sh check-image [schema] | check-v5-image [schema] | apply DATABASE_URL [schema]}
shift

check_image() {
  if [[ ! -f "$schema" ]] || ! grep -Fxq -- "$marker" "$schema"; then
    echo "schema is not adoption-compatible ($compatibility): $schema" >&2
    exit 1
  fi
}

case "$mode" in
  check-image|check-v5-image)
    schema=${1:-/app/db/schema.sql}
    check_image
    if [[ "$mode" == check-v5-image ]] && ! grep -Fxq -- '-- windmill-gym-sync-metadata-version: 5' "$schema"; then
      echo "schema is not gym metadata v5-compatible: $schema" >&2
      exit 1
    fi
    ;;
  apply)
    database=${1:?DATABASE_URL is required}
    schema=${2:-/app/db/schema.sql}
    state=$(psql "$database" -XAtq -v ON_ERROR_STOP=1 -c \
      "SELECT to_regclass('public.gym_sync_adoptions') IS NOT NULL OR to_regclass('public.journal_sync_adoptions') IS NOT NULL,
              to_regclass('public.gym_sync_metadata_upgrade_runs') IS NOT NULL OR to_regclass('public.gym_sync_metadata_upgrades') IS NOT NULL;")
    IFS='|' read -r adopted metadata_v5 <<< "$state"
    if [[ "$adopted" == t ]]; then
      check_image
    fi
    if [[ "$metadata_v5" == t ]] && ! grep -Fxq -- '-- windmill-gym-sync-metadata-version: 5' "$schema"; then
      echo "schema is not gym metadata v5-compatible; upgraded database requires a v5 image" >&2
      exit 1
    fi
    psql "$database" -Xq -v ON_ERROR_STOP=1 -f "$schema"
    ;;
  *)
    echo "unknown schema compatibility operation: $mode" >&2
    exit 1
    ;;
esac
