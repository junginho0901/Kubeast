#!/usr/bin/env bash
# Switch the kind dev install between the shapes the fault tests run in (e2e/fault/README.md "Install shapes") and
# back to where it started.
#
#   scripts/kind-fault-shape.sh start        # note the release's revision and the hashes of its values (changes nothing)
#   scripts/kind-fault-shape.sh s1           # one pod per service, mcp.enabled
#   scripts/kind-fault-shape.sh s2           # k8s-service, ai-service and tool-server on 2 pods (needs autoscaling.* in the chart, #867)
#   scripts/kind-fault-shape.sh s2-gateway   # s2 with 2 gateway pods
#   scripts/kind-fault-shape.sh s3           # streams.enabled, one pod per service (needs streams.* in the chart, #825)
#   scripts/kind-fault-shape.sh back         # roll back to the noted revision and check its hashes
#   scripts/kind-fault-shape.sh status       # revision, hashes, the shape's values and ready pods
#
# A shape sets every key it is about (replicas.k8sService, aiService, toolServer, gateway, streams.enabled when the
# chart has it, mcp.enabled), so it is the same whichever shape came before. The first switch notes the start when
# `start` was not run. Every upgrade and rollback keeps all revisions (--history-max 0), so the noted one is still there
# to go back to. Each step prints the revision and two hashes, of the values given (helm get values) and of all computed
# values (--all), never the values themselves (they hold passwords). A shape is first rendered on the server
# (--dry-run=server) and nothing changes if the chart refuses it; a helm error, a failed check or an interrupt during the
# upgrade rolls back to the revision before it (Ctrl-C cannot cut that rollback) and checks that its hashes are back,
# else it stops with ROLLBACK_BROKEN.
#
# Other scripts' helm upgrades (kind-model-subscription.sh, rebuild-kind.sh) keep helm's default of 10 revisions and
# can drop the noted one; `back` then rolls back to the newest revision whose two hashes equal the noted ones.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"
MAIN="${KIND_CLUSTER_NAME:-kubeast}"
NAMESPACE="${NAMESPACE:-kubeast}"
RELEASE="${RELEASE:-kubeast}"
CHART="${CHART:-$ROOT/helm/kubeast}"
TIMEOUT="${FAULT_SHAPE_TIMEOUT:-10m}"
MCP="${FAULT_SHAPE_MCP:-true}"
S2_TOOL_SERVER="${S2_TOOL_SERVER:-2}"
STATE="${FAULT_SHAPE_STATE:-$ROOT/.kind-data/fault-shape-$MAIN-$RELEASE.start}"

h() { helm --kubeconfig "$KUBECONFIG_PATH" --kube-context "kind-$MAIN" -n "$NAMESPACE" "$@"; }
k() { kubectl --kubeconfig "$KUBECONFIG_PATH" --context "kind-$MAIN" -n "$NAMESPACE" "$@"; }
die() { echo "$*" >&2; exit 1; }

sha() { shasum -a 256 | cut -d' ' -f1; }
release_status() { h status "$RELEASE" -o json | jq -r '.info.status'; }
revision() { h status "$RELEASE" -o json | jq -r '.version'; }
given_hash() { h get values "$RELEASE" ${1:+--revision "$1"} -o json | sha; }
all_hash() { h get values "$RELEASE" ${1:+--revision "$1"} --all -o json | sha; }
chart_has() { grep -qE "^$1:" "$CHART/values.yaml"; }
short() { echo "${1:0:16}"; }
show() { echo "  $1: revision $2 · values $(short "$3") · all values $(short "$4")"; }

shape_sets() {
  local sets
  case "$1" in
    s1) sets="replicas.k8sService=1,replicas.aiService=1,replicas.toolServer=1,replicas.gateway=1" ;;
    s2) sets="replicas.k8sService=2,replicas.aiService=2,replicas.toolServer=$S2_TOOL_SERVER,replicas.gateway=1" ;;
    s2-gateway) sets="replicas.k8sService=2,replicas.aiService=2,replicas.toolServer=$S2_TOOL_SERVER,replicas.gateway=2" ;;
    s3) sets="replicas.k8sService=1,replicas.aiService=1,replicas.toolServer=1,replicas.gateway=1" ;;
  esac
  if chart_has streams; then
    if [ "$1" = s3 ]; then sets="$sets,streams.enabled=true"; else sets="$sets,streams.enabled=false"; fi
  fi
  echo "$sets,mcp.enabled=$MCP"
}

# the shape keys of the computed values and the pods each Deployment has ready (no other value is printed)
shape_now() {
  h get values "$RELEASE" --all -o json | jq -r '"  replicas: k8sService \(.replicas.k8sService) · aiService \(.replicas.aiService) · toolServer \(.replicas.toolServer) · gateway \(.replicas.gateway) · streams.enabled \(if .streams == null then "not in the chart" else .streams.enabled end) · mcp.enabled \(.mcp.enabled)"'
  local d line
  for d in k8s-service k8s-service-stream ai-service tool-server gateway; do
    line=$(k get deploy "$d" -o jsonpath='{.spec.replicas} {.status.readyReplicas}' 2>/dev/null) || { echo "  $d: none"; continue; }
    set -- $line
    echo "  $d: ${2:-0}/$1 ready"
  done
}

# a Deployment's ready pods equal the count the shape set (1 = it is not)
ready_as_set() {
  local want ready
  want=$(echo "$3" | tr ',' '\n' | awk -F= -v key="$2" '$1 == key {print $2}')
  ready=$(k get deploy "$1" -o jsonpath='{.status.readyReplicas}')
  [ "${ready:-0}" = "$want" ] && return 0
  echo "$1 has ${ready:-0} ready pods, the shape set $2=$want" >&2
  return 1
}

note_start() {
  [ "$(release_status)" = deployed ] || die "release $RELEASE is $(release_status), not deployed: finish or roll back that operation first"
  mkdir -p "$(dirname "$STATE")"
  local rev given all
  rev=$(revision); given=$(given_hash); all=$(all_hash)
  printf 'REV=%s\nGIVEN=%s\nALL=%s\nAT=%s\n' "$rev" "$given" "$all" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE"
  echo "═══ start noted in $STATE ═══"
  show start "$rev" "$given" "$all"
  shape_now
}

# the noted start, read as data (the file is not sourced)
load_start() {
  [ -f "$STATE" ] || return 1
  START_REV=$(sed -n 's/^REV=\([0-9]*\)$/\1/p' "$STATE")
  START_GIVEN=$(sed -n 's/^GIVEN=\([0-9a-f]*\)$/\1/p' "$STATE")
  START_ALL=$(sed -n 's/^ALL=\([0-9a-f]*\)$/\1/p' "$STATE")
  [ -n "$START_REV" ] && [ -n "$START_GIVEN" ] && [ -n "$START_ALL" ] || die "$STATE is not a start this script noted: remove it and run start"
}

PRE_REV="" PRE_GIVEN="" PRE_ALL="" SHAPE="" SWITCHING=""
# Runs on every exit (an error under set -e, helm failing, Ctrl-C or TERM turned into an exit): while a switch is under
# way it rolls back. An EXIT trap, not ERR, since bash would run an inherited ERR trap in command substitutions too.
on_exit() {
  local rc=$?
  [ -n "$SWITCHING" ] || return "$rc"
  SWITCHING=""
  roll_back_to_pre
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

roll_back_to_pre() {
  trap '' INT TERM
  echo "═══ switching to $SHAPE stopped: rolling back to revision $PRE_REV ═══" >&2
  if ! h rollback "$RELEASE" "$PRE_REV" --history-max 0 --wait --timeout "$TIMEOUT" >&2; then
    echo "ROLLBACK_BROKEN: helm rollback to $PRE_REV failed; the install is not in a known shape. Fix it by hand (helm history $RELEASE)." >&2
    exit 3
  fi
  local given all
  given=$(given_hash); all=$(all_hash)
  show "after the rollback" "$(revision)" "$given" "$all" >&2
  if [ "$given" != "$PRE_GIVEN" ] || [ "$all" != "$PRE_ALL" ]; then
    echo "ROLLBACK_BROKEN: the values after the rollback differ from revision $PRE_REV's" >&2
    exit 3
  fi
  echo "back at revision $PRE_REV's values; shape $SHAPE was not applied" >&2
  exit 1
}

switch() {
  SHAPE="$1"
  case "$SHAPE" in
    s2|s2-gateway)
      chart_has autoscaling || die "$SHAPE needs the chart of #867 (more than one k8s-service and tool-server pod, autoscaling.*): $CHART has no autoscaling values and refuses replicas.k8sService above 1. Nothing changed." ;;
    s3)
      chart_has streams || die "s3 needs the chart of #825 (streams.enabled): $CHART has no streams values. Nothing changed." ;;
  esac
  [ "$(release_status)" = deployed ] || die "release $RELEASE is $(release_status), not deployed: finish or roll back that operation first"
  local auto
  auto=$(h get values "$RELEASE" --all -o json | jq -r '(.autoscaling // {}) | to_entries[] | select(.value.enabled == true) | .key' | tr '\n' ' ')
  [ -z "$auto" ] || die "autoscaling is on for: $auto— their HPAs set the pod count, not replicas. Turn them off first. Nothing changed."
  load_start || note_start
  load_start

  local sets err
  sets=$(shape_sets "$SHAPE")
  echo "═══ $SHAPE: --set $sets ═══"
  PRE_REV=$(revision); PRE_GIVEN=$(given_hash); PRE_ALL=$(all_hash)
  show before "$PRE_REV" "$PRE_GIVEN" "$PRE_ALL"

  # the server renders it first: a refused shape changes nothing (stdout holds the manifests, Secrets too: dropped)
  err=$(mktemp)
  if ! h upgrade "$RELEASE" "$CHART" --reset-then-reuse-values --history-max 0 --set "$sets" --dry-run=server --hide-secret >/dev/null 2>"$err"; then
    echo "the chart refuses $SHAPE (nothing changed):" >&2
    grep -E '^(Error|error)' "$err" >&2 || head -5 "$err" >&2
    rm -f "$err"
    exit 1
  fi
  rm -f "$err"

  # the release notes are not printed: only its revision and status
  local out
  out=$(mktemp)
  SWITCHING=1
  h upgrade "$RELEASE" "$CHART" --reset-then-reuse-values --history-max 0 --set "$sets" --wait --timeout "$TIMEOUT" >"$out"
  grep -E '^(REVISION|STATUS):' "$out" || true
  rm -f "$out"
  local given all
  given=$(given_hash); all=$(all_hash)
  show after "$(revision)" "$given" "$all"
  shape_now
  ready_as_set k8s-service replicas.k8sService "$sets"
  ready_as_set gateway replicas.gateway "$sets"
  SWITCHING=""
  show start "$START_REV" "$START_GIVEN" "$START_ALL"
}

back() {
  load_start || die "no start noted ($STATE): nothing to go back to"
  local given all target="$START_REV"
  given=$(given_hash); all=$(all_hash)
  show now "$(revision)" "$given" "$all"
  show start "$START_REV" "$START_GIVEN" "$START_ALL"
  if [ "$(release_status)" = deployed ] && [ "$given" = "$START_GIVEN" ] && [ "$all" = "$START_ALL" ]; then
    echo "already at the start's values"
    rm -f "$STATE"
    return
  fi
  if ! h history "$RELEASE" -o json | jq -e --argjson r "$START_REV" 'any(.[]; .revision == $r)' >/dev/null; then
    target=""
    local r
    for r in $(h history "$RELEASE" -o json | jq -r 'map(.revision) | sort | reverse | .[]'); do
      if [ "$(given_hash "$r")" = "$START_GIVEN" ] && [ "$(all_hash "$r")" = "$START_ALL" ]; then target=$r; break; fi
    done
    [ -n "$target" ] || die "ROLLBACK_BROKEN: revision $START_REV is gone (another script's upgrade kept only 10) and no revision left has the start's hashes. Put the values back by hand."
    echo "revision $START_REV is gone; revision $target has the start's hashes"
  fi
  echo "═══ helm rollback $RELEASE $target ═══"
  h rollback "$RELEASE" "$target" --history-max 0 --wait --timeout "$TIMEOUT" || die "ROLLBACK_BROKEN: helm rollback to $target failed"
  given=$(given_hash); all=$(all_hash)
  show after "$(revision)" "$given" "$all"
  shape_now
  if [ "$given" != "$START_GIVEN" ] || [ "$all" != "$START_ALL" ]; then
    die "ROLLBACK_BROKEN: the values after the rollback differ from the start's"
  fi
  rm -f "$STATE"
  echo "back at the start's values"
}

status() {
  local given all
  given=$(given_hash); all=$(all_hash)
  echo "release $RELEASE ($(release_status))"
  show now "$(revision)" "$given" "$all"
  if load_start; then
    show start "$START_REV" "$START_GIVEN" "$START_ALL"
    if [ "$given" = "$START_GIVEN" ] && [ "$all" = "$START_ALL" ]; then echo "  = the start's values"; else echo "  ≠ the start's values"; fi
  else
    echo "  no start noted"
  fi
  shape_now
}

case "${1:-}" in
  start)
    if load_start && [ -z "${FORCE:-}" ]; then
      show "a start is already noted" "$START_REV" "$START_GIVEN" "$START_ALL"
      die "run back first, or FORCE=1 to note the current revision instead"
    fi
    note_start ;;
  s1|s2|s2-gateway|s3) switch "$1" ;;
  back) back ;;
  status) status ;;
  *) sed -n '2,11p' "$0"; exit 2 ;;
esac
