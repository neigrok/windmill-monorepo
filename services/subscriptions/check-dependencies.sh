#!/usr/bin/env bash
# Fails, naming each offending edge, unless the crates keep the dependency rule in ARCHITECTURE.md.
set -euo pipefail

# Every edge allowed between the service's own crates, counting normal and build dependencies.
ALLOWED_EDGES='app_store -> domain
storage -> domain
server -> domain
server -> app_store
server -> storage'

# Crates domain may depend on outside its tests, one per line. Each addition is a reviewed decision.
DOMAIN_ALLOWED_CRATES=''

# Run from the workspace so rustup picks the pinned toolchain and cargo finds the manifest.
cd "$(dirname "${BASH_SOURCE[0]}")"
metadata="$(cargo metadata --format-version 1 --no-deps)"

if ! jq -e 'any(.packages[]; .name == "domain")' <<<"$metadata" >/dev/null; then
  echo "check-dependencies.sh: the workspace has no crate named domain, so the rule checks nothing" >&2
  exit 1
fi

# dev-dependencies build tests only, never the service, so neither rule counts them.
workspace_edges="$(jq -r '
  [.packages[].name] as $crates
  | [.packages[] | .name as $crate
     | .dependencies[] | select(.kind != "dev" and (.name | IN($crates[])))
     | "\($crate) -> \(.name)"]
  | unique[]' <<<"$metadata")"

domain_dependencies="$(jq -r '
  [.packages[] | select(.name == "domain")
   | .dependencies[] | select(.kind != "dev") | .name]
  | unique[]' <<<"$metadata")"

broken=0

while IFS= read -r edge; do
  [[ -n "$edge" ]] || continue
  if ! grep -qxF "$edge" <<<"$ALLOWED_EDGES"; then
    echo "check-dependencies.sh: $edge is not an allowed edge between the service's crates" >&2
    broken=1
  fi
done <<<"$workspace_edges"

while IFS= read -r dependency; do
  [[ -n "$dependency" ]] || continue
  if ! grep -qxF "$dependency" <<<"$DOMAIN_ALLOWED_CRATES"; then
    echo "check-dependencies.sh: domain -> $dependency, but domain depends only on the crates in DOMAIN_ALLOWED_CRATES" >&2
    broken=1
  fi
done <<<"$domain_dependencies"

if (( broken )); then
  exit 1
fi
echo "check-dependencies.sh: the dependency rule holds"
