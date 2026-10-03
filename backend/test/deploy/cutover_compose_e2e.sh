#!/usr/bin/env bash
set -euo pipefail
# Local Docker host only. Python 3, Git and Docker Buildx/Compose v2 are required.
# --dry-run validates the layout, build inputs and failure injector without Docker.
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec python3 "$directory/cutover_compose_e2e.py" "$@"
