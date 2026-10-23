#!/usr/bin/env bash
# Usage: perf/ci.sh [out dir]. Each scenario runs PERF_CI_REPEATS times (default 2).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/results/ci-$(date +%Y%m%d-%H%M%S)}"
reps="${PERF_CI_REPEATS:-2}"
mkdir -p "$out"
run() { # label, args...
  local label="$1"; shift
  for r in $(seq 1 "$reps"); do
    echo "::group::$label #$r"
    "$here/run.sh" "$@" --label "$label" --out "$out/$label-r$r.json" || echo "run $label #$r failed"
    echo "::endgroup::"
  done
}
run idle-tray idle-tray --duration 30 --warmup 10
run idle-chat idle-chat --duration 30 --warmup 10
run voice2 voice --clients 2 --duration 40 --warmup 15
run voice2-back voice --clients 2 --window back --duration 40 --warmup 15
node "$here/check.mjs" "$here/baseline/ci-linux.json" "$out"
