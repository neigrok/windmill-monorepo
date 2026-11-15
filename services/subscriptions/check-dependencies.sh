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

# What the tests build serializes as the binary does: serde_json resolves with the same features in the binary and in
# `cargo test` across the workspace, so a body built as a Value keeps one key order in both.
serde_json_features() {
  cargo tree --locked "$@" -i serde_json 2>/dev/null | grep -o 'serde_json feature "[a-z_]*"' | sort -u
}
in_the_binary="$(serde_json_features -p server -e features,normal)"
in_the_tests="$(serde_json_features --workspace -e features)"
if [[ "$in_the_binary" != "$in_the_tests" ]]; then
  echo "check-dependencies.sh: serde_json's features differ between the binary and the tests:" >&2
  diff <(echo "$in_the_binary") <(echo "$in_the_tests") >&2 || true
  broken=1
fi

if (( broken )); then
  exit 1
fi
echo "check-dependencies.sh: the dependency rule holds"
