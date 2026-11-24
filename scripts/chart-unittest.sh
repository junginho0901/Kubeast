#!/usr/bin/env bash
# The chart's unit tests: `helm unittest` of each helm/kubeast/tests/*_test.yaml (the files the plugin takes by itself;
# the chart has no subcharts), a process for each file and as many at once as there are CPUs. In one process the plugin
# runs the files one after another on one CPU, 12 to 20 minutes on a GitHub runner, nearly all of it the RSA keys
# secret.yaml makes in each render of deployments.yaml. The files share nothing: every test renders its own copy of the
# chart and none keeps a snapshot. (In one process the Kubernetes version a test sets stays for the tests after it; here
# it stays in its file.) Fails when a file's tests fail or it ran none. CI's helm job runs this.
#   scripts/chart-unittest.sh           JOBS=2 for two at once
#   scripts/chart-unittest.sh --list    the files, nothing runs
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
chart=helm/kubeast
files=()
for f in "$chart"/tests/*_test.yaml; do [ -f "$f" ] && files+=("${f##*/}"); done
[ "${#files[@]}" -gt 0 ] || { echo "no file matches $chart/tests/*_test.yaml" >&2; exit 1; }
if [ "${1:-}" = --list ]; then printf '%s\n' "${files[@]}"; exit 0; fi
jobs=${JOBS:-$(getconf _NPROCESSORS_ONLN)}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# One file: the plugin's output in $work/<file>.log, "passed" or why not in $work/<file>.result, a line when it ends.
run_file() {
  local log=$work/$1.log result=passed
  helm unittest -f "tests/$1" "$chart" > "$log" 2>&1 || result="failed (helm unittest ended with $?)"
  # The plugin passes a pattern that matches no file, with 0 suites.
  if [ "$result" = passed ] && ! grep -qE '^Test Suites: .* [1-9][0-9]* total$' "$log"; then result="ran no suite"; fi
  echo "$result" > "$work/$1.result"
  printf '%4d s  %3d tests  %s  %s\n' "$SECONDS" "$(awk '/^Tests: /{n = $(NF-1)} END {print n + 0}' "$log")" "$1" "$result"
}
export -f run_file
export work chart

echo "${#files[@]} files, $jobs at once"
# shellcheck disable=SC2016 # run_file's own $1
printf '%s\0' "${files[@]}" | xargs -0 -n 1 -P "$jobs" bash -c 'run_file "$1"' _

failed=0
for f in "${files[@]}"; do
  result=$(cat "$work/$f.result" 2>/dev/null)
  [ "$result" = passed ] && continue
  failed=$((failed + 1))
  echo "::error file=$chart/tests/$f::$f: ${result:-did not end}"
  cat "$work/$f.log" 2>/dev/null
done
cat "$work"/*.log | awk -v files="${#files[@]}" -v failed="$failed" '/^Test Suites: /{s += $(NF-1)} /^Tests: /{t += $(NF-1)}
  END {printf "%d of %d files passed: %d suites, %d tests ran\n", files - failed, files, s, t}'
echo "$SECONDS s"
[ "$failed" -eq 0 ]
