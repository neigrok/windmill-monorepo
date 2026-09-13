#!/bin/sh
# Starts windmill_server on 8088 from this repo's built backend binary, with the rig's env overrides. Env comes
# from backend/.env; only two variables are overridden, never on the binary's command line.
#   usage: WM_RIG_USER=<uuid> start-backend.sh        (or: start-backend.sh --user <uuid>)
#   logs:  $WM_RIG_LOGS/backend-8088.log (default ${TMPDIR:-/tmp}/windmill-rig)
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
LOGS=${WM_RIG_LOGS:-${TMPDIR:-/tmp}/windmill-rig}
USER_ID=$WM_RIG_USER
[ "$1" = "--user" ] && USER_ID=$2
[ -n "$USER_ID" ] || { echo "the rig's browser user id is required: --user <uuid> or WM_RIG_USER"; exit 2; }
if lsof -ti tcp:8088 -sTCP:LISTEN >/dev/null; then echo "port 8088 busy: $(lsof -ti tcp:8088 -sTCP:LISTEN | tr '\n' ' ')"; exit 1; fi
mkdir -p "$LOGS"
cd "$REPO/backend" || exit 1
set -a; . ./.env; set +a
WINDMILL_MCP_USER=$USER_ID
WINDMILL_ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176,http://localhost:5177,http://localhost:5178
export WINDMILL_MCP_USER WINDMILL_ALLOWED_ORIGINS
nohup ./build/windmill_server > "$LOGS/backend-8088.log" 2>&1 &
echo "backend pid $! (log $LOGS/backend-8088.log)"
