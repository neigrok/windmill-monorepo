#!/bin/sh
# usage: stop-port.sh <port> [<port>...]   — kills only what listens on those ports, never by name
for p in "$@"; do pids=$(lsof -ti tcp:"$p" -sTCP:LISTEN); [ -n "$pids" ] && { echo "$p: killing $pids"; echo "$pids" | xargs kill; } || echo "$p: nothing listening"; done
