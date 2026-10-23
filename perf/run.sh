#!/usr/bin/env bash
# Usage: perf/run.sh <scenario> [options]. Runs under Xvfb without a display.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
client="$here/../client"
[[ -d "$client/node_modules" ]] || (cd "$client" && npm ci)
[[ -f "$client/dist/main.js" ]] || (cd "$client" && npm run build >/dev/null)
node "$here/build.mjs"
if [[ -z "${DISPLAY:-}" ]]; then
  exec xvfb-run -a -s "-screen 0 1920x1080x24 -nolisten tcp" node "$client/.perf/run.js" "$@"
fi
exec node "$client/.perf/run.js" "$@"
