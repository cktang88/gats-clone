#!/usr/bin/env bash
# Usage: launch.sh <run-dir>   Builds the client and starts an isolated server owned by this run.
set -euo pipefail
RUN="${1:?usage: launch.sh <run-dir>}"
REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
mkdir -p "$RUN/data" "$RUN/evidence"
if [[ -f "$RUN/pid" ]] && kill -0 "$(cat "$RUN/pid")" 2>/dev/null; then
  echo "already running: pid $(cat "$RUN/pid") at http://localhost:$(cat "$RUN/port")"; exit 0
fi
(cd "$REPO" && [[ -d node_modules ]] || npm install --silent)
(cd "$REPO" && npm run --silent build >/dev/null)
PORT="$(node -e "const s=require('net').createServer().listen(0,()=>{console.log(s.address().port);s.close()})")"
cd "$REPO"
PORT="$PORT" DATA_DIR="$RUN/data" nohup node src/server/main.ts >"$RUN/server.log" 2>&1 &
echo $! >"$RUN/pid"
echo "$PORT" >"$RUN/port"
for _ in $(seq 1 50); do
  if grep -qE "(Tinwar|Skirmish) listening on" "$RUN/server.log" 2>/dev/null; then
    echo "ready: http://localhost:$PORT (pid $(cat "$RUN/pid"), data $RUN/data)"; exit 0
  fi
  sleep 0.2
done
echo "server did not become ready; log follows" >&2; cat "$RUN/server.log" >&2; exit 1
