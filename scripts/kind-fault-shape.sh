#!/usr/bin/env bash
# Switch the kind dev install between the shapes the fault tests run in (e2e/fault/README.md "Install shapes") and
# back to where it started.
#
#   scripts/kind-fault-shape.sh start        # note the start: revision, values' hashes, the chart's files, a copy of the values
#   scripts/kind-fault-shape.sh s1           # one pod per service, mcp.enabled
#   scripts/kind-fault-shape.sh s2           # k8s-service, ai-service and tool-server on 2 pods (needs autoscaling.* in the chart, #867)
#   scripts/kind-fault-shape.sh s2-gateway   # s2 with 2 gateway pods
#   scripts/kind-fault-shape.sh s3           # streams.enabled, one pod per service (needs streams.* in the chart, #825)
#   scripts/kind-fault-shape.sh back         # roll back to the noted revision and check its hashes
#   scripts/kind-fault-shape.sh back-values  # put the start's values back with this chart instead (helm upgrade --reset-values -f)
#   scripts/kind-fault-shape.sh status       # revision, hashes, the shape's values, ready pods, what changed since the start
#
# A shape sets every key it is about (replicas.k8sService, aiService, toolServer, gateway, streams.enabled when the
# chart has it, mcp.enabled), so it is the same whichever shape came before. The first switch notes the start when
# `start` was not run. Each step prints the revision and two hashes, of the values given (helm get values) and of all
# computed values (--all), never the values themselves (they hold passwords; the copy kept for back-values is a 0600
# file next to the start, under the git-ignored .kind-data/).
#
# `start` also stops when this checkout's chart does not render what is installed (the release's manifest against a
# server dry run of the same upgrade, Secrets left out; FAULT_SHAPE_ACCEPT_CHART=1 to start anyway), and prints the
# installed chart's name, version and app version.
#
# Every upgrade and rollback keeps all revisions (--history-max 0), and every upgrade is described
# "kind-fault-shape <shape> chart=<files hash>". Between start and back nothing else may change the release:
# a switch and `back` stop when a revision after the start was made by something else (another script's helm upgrade
# — kind-model-subscription.sh, rebuild-kind.sh — would be undone by the rollback, and keeps only 10 revisions), when
# the noted revision is no longer the one noted (pruned, or the release installed again), and a switch also when this
# checkout's chart files differ from the start's (it would change the templates too). back-values is the way back then:
# it needs only the start file and its values copy, and the chart files of the start.
#
# A shape is first rendered on the server (--dry-run=server) and nothing changes if the chart refuses it. helm runs in
# the background and this shell waits for it, so Ctrl-C, TERM or a closed terminal (HUP) reaches the trap at once: it
# stops helm, then rolls back to the revision before the switch and checks the hashes (ROLLBACK_BROKEN, exit 3, when
# they differ). The rollbacks, here and in `back`, ignore those signals. After a closed terminal the rollback writes
# to <start file>.log. Each revision this script makes is listed before helm runs, so a release it left pending-*
# (its shell killed outright) is put back with `back`; one left so by anything else is refused like any other.
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
VALUES="$STATE.values.yaml"
MADE="$STATE.made"
TAG="kind-fault-shape"

h() { helm --kubeconfig "$KUBECONFIG_PATH" --kube-context "kind-$MAIN" -n "$NAMESPACE" "$@"; }
k() { kubectl --kubeconfig "$KUBECONFIG_PATH" --context "kind-$MAIN" -n "$NAMESPACE" "$@"; }
die() { echo "$*" >&2; exit 1; }

sha() { shasum -a 256 | cut -d' ' -f1; }
release_status() { h status "$RELEASE" -o json | jq -r '.info.status'; }
revision() { h history "$RELEASE" -o json --max 1 | jq -r '.[-1].revision'; }
history_json() { h history "$RELEASE" -o json --max 256; }
given_hash() { h get values "$RELEASE" -o json | sha; }
all_hash() { h get values "$RELEASE" --all -o json | sha; }
chart_has() { grep -qE "^$1:" "$CHART/values.yaml"; }
# every file of the chart directory, by path and content
chart_hash() { (cd "$CHART" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) | sha; }
short() { echo "${1:0:16}"; }
show() { echo "  $1: revision $2 · values $(short "$3") · all values $(short "$4")"; }
clean_state() { rm -f "$STATE" "$VALUES" "$MADE"; }

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

# The documents that differ between the release's manifest and what this checkout's chart renders with the release's
# values — a server dry run of the same upgrade, so lookup reads what is installed — Secrets left out of both. Empty
# when the checkout's chart is the installed one; "not rendered" when the chart refuses the values, with helm's error
# lines (as a switch's dry run prints them).
manifest_diff() {
  local live rendered err
  live=$(mktemp); rendered=$(mktemp); err=$(mktemp)
  h get manifest "$RELEASE" > "$live"
  if ! h upgrade "$RELEASE" "$CHART" --reset-then-reuse-values --dry-run=server --hide-secret 2>"$err" \
      | awk '/^MANIFEST:$/ {on=1; next} /^NOTES:$/ {on=0} on' > "$rendered" || [ ! -s "$rendered" ]; then
    echo "not rendered: $CHART refuses the release's values"
    { grep -E '^(Error|error)' "$err" || head -5 "$err"; } | sed 's/^/  helm: /'
    rm -f "$live" "$rendered" "$err"
    return
  fi
  rm -f "$err"
  python3 - "$live" "$rendered" <<'PY'
import hashlib, re, sys
def docs(path):
    out = {}
    for doc in re.split(r'(?m)^---\s*$', open(path).read()):
        lines = [l.rstrip() for l in doc.splitlines() if l.strip()]
        body = [l for l in lines if not l.startswith('#')]
        # a Secret, or what --hide-secret leaves in its place (comments only)
        if not body or 'kind: Secret' in body:
            continue
        src = next((l for l in lines if l.startswith('# Source:')), body[0])
        out.setdefault(hashlib.sha256('\n'.join(body).encode()).hexdigest(), src)
    return out
live, mine = docs(sys.argv[1]), docs(sys.argv[2])
for h in sorted(set(live) ^ set(mine)):
    print(('installed only: ' if h in live else 'this checkout only: ') + (live.get(h) or mine.get(h)))
PY
  rm -f "$live" "$rendered"
}

note_start() {
  [ "$(release_status)" = deployed ] || die "release $RELEASE is $(release_status), not deployed: finish or roll back that operation first"
  h get metadata "$RELEASE" -o json | jq -r 'def v: if . == null or . == "" then "-" else tostring end; "  installed: chart \(.chart | v) \(.version | v), app \(.appVersion | v), revision \(.revision | v)"'
  local diff
  diff=$(manifest_diff)
  if [ -n "$diff" ] && [ -z "${FAULT_SHAPE_ACCEPT_CHART:-}" ]; then
    echo "$diff" | sed 's/^/  /' >&2
    die "the chart in $CHART does not render what is installed (above): the shapes would change the templates too. Run from the checkout the release was installed from, or FAULT_SHAPE_ACCEPT_CHART=1 to start anyway. Nothing changed."
  fi
  [ -z "$diff" ] || { echo "  accepted (FAULT_SHAPE_ACCEPT_CHART): the checkout's chart differs from the installed one in:"; echo "$diff" | sed 's/^/    /'; }
  mkdir -p "$(dirname "$STATE")"
  local rev given all updated
  rev=$(revision); given=$(given_hash); all=$(all_hash)
  updated=$(history_json | jq -r --argjson r "$rev" '.[] | select(.revision == $r) | .updated')
  (umask 077 && h get values "$RELEASE" -o yaml > "$VALUES")
  : > "$MADE"
  printf 'REV=%s\nUPDATED=%s\nGIVEN=%s\nALL=%s\nCHART=%s\nAT=%s\n' "$rev" "$updated" "$given" "$all" "$(chart_hash)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE"
  echo "═══ start noted in $STATE ═══"
  show start "$rev" "$given" "$all"
  echo "  chart files $(short "$(chart_hash)") ($CHART)"
  shape_now
}

# the noted start, read as data (the file is not sourced); back-values needs no more than this
read_start() {
  [ -f "$STATE" ] || return 1
  field() { sed -n "s/^$1=\\(.*\\)$/\\1/p" "$STATE"; }
  START_REV=$(field REV); START_UPDATED=$(field UPDATED); START_GIVEN=$(field GIVEN); START_ALL=$(field ALL)
  START_CHART=$(field CHART); START_AT=$(field AT)
  case "$START_REV$START_GIVEN$START_ALL$START_CHART" in *[!0-9a-f]*|'') die "$STATE is not a start this script noted: remove $STATE* and run start" ;; esac
  [ -f "$VALUES" ] && [ -f "$MADE" ] || die "$STATE has lost its values copy or its list of revisions: remove $STATE* and run start"
}

# read_start, and the noted revision still the one noted (a switch and back build on it)
load_start() {
  read_start || return 1
  local updated
  updated=$(history_json | jq -r --argjson r "$START_REV" '.[] | select(.revision == $r) | .updated')
  [ -n "$updated" ] && [ "$updated" = "$START_UPDATED" ] || die "the start noted $START_AT names revision $START_REV of $START_UPDATED, which the release no longer has as it was (pruned, or the release installed again): it is not this release's start. Use back-values if the values copy is still the one you want, else remove $STATE* and start again."
}

# revisions after the start that this script did not make (listed in $MADE; its finished upgrades also carry its description)
foreign_after() {
  history_json | jq -r --argjson r "$START_REV" --arg tag "$TAG" --rawfile made "$MADE" '
    ($made | split("\n") | map(select(. != "") | tonumber)) as $mine
    | .[] | select(.revision > $r and ((.description // "") | startswith($tag) | not) and (.revision as $v | $mine | index($v) | not))
    | "\(.revision) (\(.description // ""))"'
}

# The revision the next helm upgrade or rollback will make (helm takes the latest + 1), listed as this script's before
# it runs: a pending or failed one (helm describes those itself) and one left by a shell killed outright count too.
CLAIMED=""
claim_next() { CLAIMED=$(( $(revision) + 1 )); echo "$CLAIMED" >> "$MADE"; }
# after helm: a claimed number helm did not use (it failed before making a revision) comes off the list, or another
# tool's next revision would take it and count as this script's. A history that cannot be read, or reads empty, says
# nothing of it: the number stays (helm got as far as the cluster, so it most likely made it), and the reason is printed
settle_claim() {
  [ -n "$CLAIMED" ] || return 0
  local hist made why
  hist=$(history_json) || hist=""
  made=$(jq -r --argjson r "$CLAIMED" 'if length == 0 then "empty" else any(.[]; .revision == $r) end' <<<"$hist" 2>/dev/null) || made=""
  case "$made" in
    true) ;;
    false) { grep -vx "$CLAIMED" "$MADE" || true; } > "$MADE.tmp" && mv "$MADE.tmp" "$MADE" ;;
    *)
      if [ "$made" = empty ]; then why="read empty"; else why="could not be read"; fi
      echo "revision $CLAIMED stays listed as $TAG's in $MADE: helm history $why, so whether helm made it is not known. If helm history shows no revision $CLAIMED, take the line out of $MADE, or another tool's revision of that number counts as this script's." >&2 ;;
  esac
  CLAIMED=""
}

HELM_PID="" GOT_HUP=""
# helm in the background, started as itself (not through the h function, which would background a subshell and give
# its pid): a signal to this shell interrupts the wait and reaches its trap at once, and the trap signals helm
run_helm() {
  local rc=0
  helm --kubeconfig "$KUBECONFIG_PATH" --kube-context "kind-$MAIN" -n "$NAMESPACE" "$@" & HELM_PID=$!
  wait "$HELM_PID" || rc=$?
  HELM_PID=""
  return "$rc"
}
# helm ends an upgrade on SIGINT as failed ("context canceled"); on SIGTERM it stops where it is and leaves the revision
# pending-upgrade (both roll back the same). INT first, TERM if it is still there 30 s later.
on_signal() {
  [ "$1" = 129 ] && GOT_HUP=1
  if [ -n "$HELM_PID" ]; then
    kill -INT "$HELM_PID" 2>/dev/null || true
    local i=0
    while kill -0 "$HELM_PID" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done
    kill -TERM "$HELM_PID" 2>/dev/null || true
    wait "$HELM_PID" 2>/dev/null || true
    HELM_PID=""
  fi
  exit "$1"
}
quiet_signals() { trap '' INT TERM HUP; }

PRE_REV="" PRE_GIVEN="" PRE_ALL="" SHAPE="" SWITCHING=""
# Runs on every exit (an error under set -e, helm failing, a signal turned into an exit): while a switch is under way
# it rolls back. An EXIT trap, not ERR, since bash would run an inherited ERR trap in command substitutions too.
on_exit() {
  local rc=$?
  [ -n "$SWITCHING" ] || return "$rc"
  SWITCHING=""
  roll_back_to_pre
}
trap on_exit EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP

roll_back_to_pre() {
  quiet_signals
  if [ -n "$GOT_HUP" ]; then exec >>"$STATE.log" 2>&1; echo "$(date -u +%FT%TZ) terminal closed during $SHAPE"; fi
  echo "═══ switching to $SHAPE stopped: rolling back to revision $PRE_REV ═══" >&2
  settle_claim
  claim_next
  if ! h rollback "$RELEASE" "$PRE_REV" --history-max 0 --wait --timeout "$TIMEOUT" >&2; then
    settle_claim
    echo "ROLLBACK_BROKEN: helm rollback to $PRE_REV failed; the install is not in a known shape. Fix it by hand (helm history $RELEASE)." >&2
    exit 3
  fi
  settle_claim
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

refuse_foreign() {
  local foreign
  foreign=$(foreign_after)
  [ -z "$foreign" ] && return 0
  echo "revisions after the start (revision $START_REV) that $TAG did not make:" >&2
  echo "$foreign" | sed 's/^/  /' >&2
  die "$1 would undo or build on them. Run other helm upgrades of the release before start or after back; to put the start's values back on this chart, back-values."
}

switch() {
  SHAPE="$1"
  case "$SHAPE" in
    s2|s2-gateway)
      chart_has autoscaling || die "$SHAPE needs the chart of #867 (more than one k8s-service and tool-server pod, autoscaling.*): $CHART has no autoscaling values and refuses replicas.k8sService above 1. Nothing changed." ;;
    s3)
      chart_has streams || die "s3 needs the chart of #825 (streams.enabled): $CHART has no streams values. Nothing changed." ;;
  esac
  [ "$(release_status)" = deployed ] || die "release $RELEASE is $(release_status), not deployed: run back (or finish that operation) first"
  local auto
  auto=$(h get values "$RELEASE" --all -o json | jq -r '(.autoscaling // {}) | to_entries[] | select(.value.enabled == true) | .key' | tr '\n' ' ')
  [ -z "$auto" ] || die "autoscaling is on for: ${auto}— their HPAs set the pod count, not replicas. Turn them off first. Nothing changed."
  load_start || note_start
  load_start
  [ "$(chart_hash)" = "$START_CHART" ] || die "the chart files in $CHART differ from the ones noted at start ($(short "$START_CHART")): a switch from here would change the templates too. Run it from the checkout of the start, or back and start again. Nothing changed."
  refuse_foreign "switching to $SHAPE"

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
  claim_next
  run_helm upgrade "$RELEASE" "$CHART" --reset-then-reuse-values --history-max 0 --set "$sets" --wait --timeout "$TIMEOUT" \
    --description "$TAG $SHAPE chart=$(short "$START_CHART")" >"$out"
  settle_claim
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

check_back() {
  local given all
  given=$(given_hash); all=$(all_hash)
  show after "$(revision)" "$given" "$all"
  shape_now
  if [ "$given" != "$START_GIVEN" ] || [ "$all" != "$START_ALL" ]; then
    echo "ROLLBACK_BROKEN: the values after $1 differ from the start's (the start's files are kept)" >&2
    exit 3
  fi
  clean_state
  echo "back at the start's values"
}

back() {
  load_start || die "no start noted ($STATE): nothing to go back to"
  local given all
  given=$(given_hash); all=$(all_hash)
  show now "$(revision)" "$given" "$all"
  show start "$START_REV" "$START_GIVEN" "$START_ALL"
  if [ "$(release_status)" = deployed ] && [ "$given" = "$START_GIVEN" ] && [ "$all" = "$START_ALL" ] && [ -z "$(foreign_after)" ]; then
    echo "already at the start's values"
    clean_state
    return
  fi
  refuse_foreign "rolling back to revision $START_REV"
  echo "═══ helm rollback $RELEASE $START_REV (Ctrl-C, TERM and HUP ignored until it ends) ═══"
  quiet_signals
  claim_next
  h rollback "$RELEASE" "$START_REV" --history-max 0 --wait --timeout "$TIMEOUT" \
    || { settle_claim; echo "ROLLBACK_BROKEN: helm rollback to $START_REV failed (helm history $RELEASE)" >&2; exit 3; }
  settle_claim
  check_back "the rollback"
}

back_values() {
  read_start || die "no start noted ($STATE): nothing to go back to"
  [ "$(chart_hash)" = "$START_CHART" ] || die "the chart files in $CHART differ from the ones noted at start: back-values would also change the templates. Run it from the checkout of the start."
  echo "═══ helm upgrade $RELEASE --reset-values -f $VALUES (Ctrl-C, TERM and HUP ignored until it ends) ═══"
  quiet_signals
  claim_next
  local out
  out=$(mktemp)
  h upgrade "$RELEASE" "$CHART" --reset-values -f "$VALUES" --history-max 0 --wait --timeout "$TIMEOUT" --description "$TAG back-values" >"$out" \
    || { rm -f "$out"; settle_claim; echo "ROLLBACK_BROKEN: helm upgrade with the start's values failed (helm history $RELEASE)" >&2; exit 3; }
  settle_claim
  grep -E '^(REVISION|STATUS):' "$out" || true
  rm -f "$out"
  check_back "back-values"
}

status() {
  local given all
  given=$(given_hash); all=$(all_hash)
  echo "release $RELEASE ($(release_status))"
  show now "$(revision)" "$given" "$all"
  if read_start; then
    show start "$START_REV" "$START_GIVEN" "$START_ALL"
    if [ "$given" = "$START_GIVEN" ] && [ "$all" = "$START_ALL" ]; then echo "  = the start's values"; else echo "  ≠ the start's values"; fi
    if [ "$(chart_hash)" = "$START_CHART" ]; then echo "  chart files = the start's"; else echo "  chart files ≠ the start's ($CHART)"; fi
    local foreign
    foreign=$(foreign_after)
    [ -z "$foreign" ] || { echo "  revisions after the start made by something else:"; echo "$foreign" | sed 's/^/    /'; }
  else
    echo "  no start noted"
  fi
  shape_now
}

case "${1:-}" in
  start)
    if [ -f "$STATE" ] && [ -z "${FORCE:-}" ]; then
      die "a start is already noted ($STATE, $(sed -n 's/^AT=//p' "$STATE")): run back (or back-values), or FORCE=1 to note the current revision instead"
    fi
    note_start ;;
  s1|s2|s2-gateway|s3) switch "$1" ;;
  back) back ;;
  back-values) back_values ;;
  status) status ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
