#!/usr/bin/env bash
# Restart the dev server (Vite client on :5173 + node server on :8787).
#
# Detects any already-running instance — by port AND by process pattern — kills it
# cleanly (SIGTERM, then SIGKILL if it won't go), then runs `npm run dev` fresh.
#
# Usage:
#   ./restart-dev.sh            # restart in the foreground (recommended: real TTY)
#   ./restart-dev.sh --detach   # restart detached, logging to app/dev.log
#
# Why --detach sets CI=true: when launched without a TTY, Vite sees stdin EOF and
# exits immediately, and `concurrently -k` then kills the server too. CI=true makes
# Vite skip its interactive stdin shortcuts, so a backgrounded instance stays up.

set -u

# Resolve the app dir relative to this script, so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/app"

PORTS=(5173 8787)
# Process patterns that identify our dev stack (in case a process outlived its port).
PATTERNS=("npm run dev" "concurrently.*npm:server" "tsx src/server/index.ts" "node_modules/.bin/vite")

collect_pids() {
  local pids=""
  for p in "${PORTS[@]}"; do
    pids="$pids $(lsof -ti:"$p" 2>/dev/null)"
  done
  for pat in "${PATTERNS[@]}"; do
    pids="$pids $(pgrep -f "$pat" 2>/dev/null)"
  done
  # de-dupe, drop blanks, and never target this script itself
  echo "$pids" | tr ' ' '\n' | grep -E '^[0-9]+$' | grep -vx "$$" | sort -u
}

kill_running() {
  local pids
  pids="$(collect_pids)"
  if [ -z "$pids" ]; then
    echo "No running dev instance found."
    return 0
  fi

  echo "Stopping existing dev instance: $(echo "$pids" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null

  # Wait up to ~5s for a graceful exit.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    [ -z "$(collect_pids)" ] && break
  done

  # Anything still alive gets SIGKILL.
  local leftover
  leftover="$(collect_pids)"
  if [ -n "$leftover" ]; then
    echo "Force-killing stubborn pids: $(echo "$leftover" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    kill -9 $leftover 2>/dev/null
    sleep 0.5
  fi

  if [ -n "$(collect_pids)" ]; then
    echo "WARNING: some processes are still alive; ports may be busy." >&2
  else
    echo "Stopped."
  fi
}

main() {
  if [ ! -d "$APP_DIR" ]; then
    echo "ERROR: app dir not found at $APP_DIR" >&2
    exit 1
  fi
  cd "$APP_DIR" || exit 1

  kill_running

  if [ "${1:-}" = "--detach" ] || [ "${1:-}" = "-d" ]; then
    echo "Starting dev (detached) -> $APP_DIR/dev.log"
    CI=true nohup npm run dev >dev.log 2>&1 &
    disown
    sleep 3
    echo "Started (pid $!). Tail logs with: tail -f $APP_DIR/dev.log"
    echo "  client: http://localhost:5173/    server: http://localhost:8787 (ws: /ws)"
  else
    echo "Starting dev (foreground; Ctrl-C to stop)…"
    echo "  client: http://localhost:5173/    server: http://localhost:8787 (ws: /ws)"
    exec npm run dev
  fi
}

main "$@"
