#!/bin/sh
# usage: start-vite.sh <worktree-root> <port>     e.g. start-vite.sh "$(git rev-parse --show-toplevel)" 5173
#   logs: $WM_RIG_LOGS/vite-<port>.log (default ${TMPDIR:-/tmp}/windmill-rig)
ROOT=$1; PORT=$2
LOGS=${WM_RIG_LOGS:-${TMPDIR:-/tmp}/windmill-rig}
[ -d "$ROOT/web/node_modules" ] || { echo "no node_modules in $ROOT/web — run npm ci there first"; exit 1; }
if lsof -ti tcp:"$PORT" -sTCP:LISTEN >/dev/null; then echo "port $PORT busy: $(lsof -ti tcp:$PORT -sTCP:LISTEN | tr '\n' ' ')"; exit 1; fi
mkdir -p "$LOGS"
cd "$ROOT/web" || exit 1
nohup npx vite --port "$PORT" --strictPort > "$LOGS/vite-$PORT.log" 2>&1 &
echo "vite pid $! on http://localhost:$PORT (log $LOGS/vite-$PORT.log)"
