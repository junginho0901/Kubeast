#!/usr/bin/env bash
# Upgrade rehearsal: the published chart of the release before (FROM_VERSION, 0.7.7) installed the way a user installs
# it, on a kind cluster of the rehearsal's own (kubeast-reh: one control-plane, one worker that only a drain test pod
# may use), data made through its API, then upgraded to the chart and images of this checkout the way
# docs/getting-started.md "Upgrade" says (`helm upgrade --reset-then-reuse-values`). Prints a table of checks and
# deletes its cluster at the end.
#
#   scripts/upgrade-rehearsal.sh                       # images kubeast/<name>:$IMAGE_TAG already built on the host
#   scripts/upgrade-rehearsal.sh --build               # build the seven images from this checkout first
#   SCENARIO=existing-secret scripts/upgrade-rehearsal.sh
#   SCENARIO=external-db scripts/upgrade-rehearsal.sh
#   REPLICAS=3 scripts/upgrade-rehearsal.sh            # after the upgrade, every service at 3 replicas
#   KEEP=1 scripts/upgrade-rehearsal.sh                # leave the cluster (scripts/upgrade-rehearsal.sh --delete removes it)
#   REQUIRE=all scripts/upgrade-rehearsal.sh --build   # a release run: a check waiting for a change not in the checkout fails
#   scripts/upgrade-rehearsal.sh --plan                # no cluster: which change each check waits for, and the render stops
#
# Scenarios:
#   default          the chart's own Secrets, PostgreSQL and Redis.
#   existing-secret  secrets.existingSecret (a Secret made beforehand from the chart's render). The upgrade must keep
#                    Redis on one password; then the Redis users' keys go into that Secret with
#                    redis.acl.existingSecretHasKeys=true; then the same keys from a Secret of their own with
#                    redis.acl.existingSecret.
#   external-db      postgresql.enabled=false: a PostgreSQL in namespace rehearsal-db behind PgBouncer (POOLER_MODE
#                    session, or transaction; POOLER=0 connects to PostgreSQL directly).
#
# What it checks after the upgrade: the migrations reach the newest file of services/pkg/dbmigrate/migrations; what
# was made on FROM_VERSION reads back the same (users, teams, custom roles, grants, API keys, access requests,
# conversations, recordings, the audit chain) and the old passwords and key still sign in; custom roles whose names a
# built-in or an older role has in other letters or with spaces around (stored straight into the table, with a grant,
# a pending access request and an account level " PENDING ") renamed <name>-renamed-<id>, their grant removed, their
# request ended role_renamed, that account at the built-in Pending, one audit row by system/migration for each, and a
# new role of such a name refused; readiness and liveness probes,
# preStop and the rollout strategy of each Deployment; the requests sent every second during the upgrade (non-2xx and
# hangs, apart from the bundled PostgreSQL's restart); that `--reuse-values` and a values file copied from FROM_VERSION
# stop with the --reset-then-reuse-values hint, values setting pdb.minAvailable stop with what replaces it, and auth,
# session and ai at 4 replicas stop at the database connection sum while 3 render; a drain running during the upgrade;
# a second upgrade to the same chart with one value changed; and, with REPLICAS, more than one replica.
#
# A check whose change is not in this checkout (chart values, a check template or a migration's schema; never a
# migration file number, which changes at merge) is a SKIP row naming that change's PR. REQUIRE lists the changes a
# run must hold ("856 858 865 866 867 868 901", commas or spaces, or "all"): the run stops before making its cluster
# when the checkout lacks one, and a SKIP of one is a FAIL row. --plan prints that list against the checkout and runs
# the render stops with `helm template` on the install's values, without a cluster.
#
# Inputs (environment): SCENARIO, FROM_VERSION (0.7.7), RC_TAG (the tag the release workflow's chart edits run with,
# v0.7.8-rc.1), IMAGE_TAG (rc-<HEAD, 8>), REPLICAS (1), HOST_PORT (30392), REH_CLUSTER (kubeast-reh), REH_OUT
# (.rehearsal/<scenario>-<time>), KIND_NODE_HOOK (a command that gets a node container's name, run on each node once
# the cluster is made — behind a TLS-inspecting proxy, one that makes the node trust its CA and restarts containerd,
# as CALICO_NODE_HOOK), DOCKER_BUILD_ARGS (with --build), PROBE_TIMEOUT (10 s: a request
# that has no answer by then is a hang), PG_GRACE (20 s after the bundled PostgreSQL is ready again), POOLER_IMAGE,
# POOLER_MODE, POOLER, EXTRA_VALUES (a values file of no secret added to the FROM_VERSION install, e.g.
# migrations.mode: job with SCENARIO=external-db), REQUIRE, KEEP, ALLOW_DIRTY, ALLOW_PARALLEL.
#
# Safety: every kubectl and helm call names the rehearsal's kubeconfig file ($REH_OUT/kubeconfig) and its context;
# the current context is never read. Cluster names must start with kubeast-reh. Passwords, tokens and keys are read
# from the cluster's Secrets into variables and never printed or written to a file (one exception: SCENARIO=external-db
# writes the database password into a 0600 values file that is removed right after the install). Tokens reach curl
# through a header file descriptor and bodies through stdin, so they are not in the process list.
set -uo pipefail
export PATH=/opt/homebrew/bin:$PATH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCENARIO="${SCENARIO:-default}"
FROM_VERSION="${FROM_VERSION:-0.7.7}"
RC_TAG="${RC_TAG:-v0.7.8-rc.1}"
REPLICAS="${REPLICAS:-1}"
CLUSTER="${REH_CLUSTER:-kubeast-reh}"
CTX="kind-$CLUSTER"
CP="$CLUSTER-control-plane"
WORKER="$CLUSTER-worker"
NS=kubeast
SEED_NS=rehearsal-seed
DRAIN_NS=rehearsal-drain
DB_NS=rehearsal-db
NODE_PORT=30333
HOST_PORT="${HOST_PORT:-30392}"
GW="http://127.0.0.1:$HOST_PORT"
CHART_OCI=oci://ghcr.io/junginho0901/charts/kubeast
CLUSTER_ID=default
DOMAIN=rehearsal.local
PROBE_TIMEOUT="${PROBE_TIMEOUT:-10}"
PG_GRACE="${PG_GRACE:-20}"
POOLER="${POOLER:-1}"
POOLER_MODE="${POOLER_MODE:-session}"
POOLER_IMAGE="${POOLER_IMAGE:-docker.io/edoburu/pgbouncer:v1.25.2-p0}"
DB_IMAGE=docker.io/library/postgres:18-alpine
BLOCKER_IMAGE=docker.io/library/busybox:1.38.0
IMAGES="auth-service k8s-service session-service tool-server ai-service frontend model-config-controller-go"
MIGRATIONS="$ROOT/services/pkg/dbmigrate/migrations"
HEAD8="$(git -C "$ROOT" rev-parse --short=8 HEAD)"
IMAGE_TAG="${IMAGE_TAG:-rc-$HEAD8}"
PLAN=0
[ "${1:-}" = --plan ] && PLAN=1
OUT="${REH_OUT:-$ROOT/.rehearsal/$([ "$PLAN" = 1 ] && echo plan || echo "$SCENARIO")-$(date +%Y%m%d-%H%M%S)}"
KC="$OUT/kubeconfig"
RES="$OUT/results.tsv"
CHART="$OUT/chart-rc"
CHART_VALUES="$OUT/chart-values.json"
APP_SECRET=kubeast-secrets
LOOKALIKE='rehearsal: stored before the name rule'
REQUIRE_LIST=" $(printf '%s' "${REQUIRE:-}" | tr ',#' '  ') "
CREATED=0
BG_PIDS=""
FG_PID=""
TMP_VALUES=""
CALL_TIMEOUT=60
TOKEN_REFRESH=240

now() { date '+%H:%M:%S'; }
say() { echo "$(now) $*"; }
warn() { echo "$(now) WARN: $*"; }
stop() { echo "$(now) STOP: $*"; exit 1; }
mask() { sed -E 's/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]+/<jwt>/g; s/kbk_[A-Za-z0-9_-]{8,}/kbk_<masked>/g'; }

kc() { kubectl --kubeconfig "$KC" --context "$CTX" --request-timeout=60s "$@"; }
hc() { helm --kubeconfig "$KC" --kube-context "$CTX" -n "$NS" "$@"; }
psql_q() {
  if [ "$SCENARIO" = external-db ]; then
    kc -n "$DB_NS" exec deploy/pg -c pg -- psql -U kubeast -d kubeast -v ON_ERROR_STOP=1 -At -c "$1"
  else
    kc -n "$NS" exec deploy/postgres -c postgres -- psql -U kubeast -d kubeast -v ON_ERROR_STOP=1 -At -c "$1"
  fi
}

# --- results: one row per check, printed as a table at the end ---
row() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$(printf '%s' "$4" | tr '\t\n' '  ' | cut -c1-220 | mask)" >> "$RES"; }
check() { # check AREA NAME WANT GOT
  if [ "$3" = "$4" ]; then row "$1" "$2" PASS "$4"; else row "$1" "$2" FAIL "want $3, got $4"; fi
}
check_code() { # check_code AREA NAME "CODES" — CODE is one of CODES
  case " $3 " in *" $CODE "*) row "$1" "$2" PASS "HTTP $CODE" ;;
    *) row "$1" "$2" FAIL "want HTTP $3, got $CODE $(jqb '.detail? // empty' | head -c 160)" ;; esac
}
none_bad() { # none_bad AREA NAME BAD PASS_DETAIL FAIL_PREFIX — PASS when BAD (the names that fail) is empty
  if [ -z "$3" ]; then row "$1" "$2" PASS "$4"; else row "$1" "$2" FAIL "$5 $3"; fi
}
skip() { # skip AREA NAME CHANGE WHY — the check waits for that change (a PR number); with the change in REQUIRE, a FAIL
  if required "$3"; then row "$1" "$2" FAIL "REQUIRE names #$3, not in the candidate: $4"
  else row "$1" "$2" SKIP "waits for #$3: $4"; fi
}
info() { row "$1" "$2" INFO "$3"; }

print_table() {
  [ -s "$RES" ] || return 0
  echo
  awk -F'\t' '{ printf "%-10s %-62s %-5s %s\n", $1, substr($2, 1, 62), $3, $4 }' "$RES"
  local p f s
  p=$(awk -F'\t' '$3 == "PASS"' "$RES" | wc -l | tr -d ' ')
  f=$(awk -F'\t' '$3 == "FAIL"' "$RES" | wc -l | tr -d ' ')
  s=$(awk -F'\t' '$3 == "SKIP"' "$RES" | wc -l | tr -d ' ')
  echo
  if [ "$PLAN" = 1 ]; then
    echo "plan of checkout $HEAD8 (no cluster; renders of helm/kubeast on the default scenario's install values) · REQUIRE ${REQUIRE:-none}"
  else
    echo "scenario $SCENARIO · from $FROM_VERSION · candidate $HEAD8 (chart ${RC_TAG#v}, images $IMAGE_TAG) · replicas $REPLICAS · REQUIRE ${REQUIRE:-none}"
  fi
  echo "PASS $p · FAIL $f · SKIP $s · results $RES"
  [ "$s" = 0 ] || echo "each SKIP names the change it waits for (not in this checkout); REQUIRE=<those numbers> makes them fail"
  [ "$s" = 0 ] || [ -n "${REQUIRE:-}" ] || warn "$s checks skipped and REQUIRE is not set: a release run sets REQUIRE=all, so that a skipped check fails"
  local word=RESULT verdict=FAIL
  [ "$PLAN" = 1 ] && word=PLAN
  if [ "$f" = 0 ] && [ "${COMPLETE:-0}" = 1 ]; then verdict=PASS; [ "$s" = 0 ] || verdict="PASS (SKIP $s)"; fi
  echo "$word: $verdict" | tee "$OUT/verdict.txt"
}

stop_bg() {
  local p
  for p in $BG_PIDS; do kill "$p" 2>/dev/null; done
  BG_PIDS=""
}
# fg_run CMD... — a long command (helm --wait, kind create, docker build) as a child the signal trap can stop: bash runs
# a trap only once a foreground command has ended, but a `wait` it interrupts.
fg_run() {
  "$@" &
  FG_PID=$!
  wait "$FG_PID"
  local rc=$?
  FG_PID=""
  return "$rc"
}
stop_fg() { # TERM to that command (and to its own child, when CMD was a function such as hc), then up to 10 s for it to end
  [ -n "$FG_PID" ] || return 0
  pkill -TERM -P "$FG_PID" 2>/dev/null
  kill -TERM "$FG_PID" 2>/dev/null
  local i
  for i in $(seq 1 10); do kill -0 "$FG_PID" 2>/dev/null || break; sleep 1; done
  [ "$i" = 10 ] && kill -KILL "$FG_PID" 2>/dev/null
  FG_PID=""
}
on_signal() { # on_signal CODE [log]
  # A closed terminal sends HUP to the whole process group, the tee of run.log too, and a CI cancel or `timeout` sends
  # TERM to it the same way: from here the output goes to run.log alone, so the cleanup's lines are kept and none is left
  # in bash's buffer to come out in the next pipe (verdict.txt). Ctrl-C's INT leaves the tee, which bash started
  # ignoring INT.
  if [ "${2:-}" = log ]; then trap '' HUP; exec >> "$OUT/run.log" 2>&1; fi
  stop_fg
  exit "$1"
}
begin_output() { # the run's output on screen and in run.log, and the traps that end it
  mkdir -p "$OUT"; : > "$RES"
  exec > >(tee -a "$OUT/run.log") 2>&1
  # a write to the tee once it has ended (before the trap below has run) fails instead of ending the script; set after
  # the tee starts, so the tee keeps the default
  trap '' PIPE
  trap cleanup EXIT
  trap 'on_signal 130' INT
  trap 'on_signal 143 log' TERM
  trap 'on_signal 129 log' HUP
}
delete_cluster() {
  case "$CLUSTER" in kubeast-reh*) ;; *) echo "not deleting $CLUSTER: not a rehearsal cluster name"; return 1 ;; esac
  kind delete cluster --name "$CLUSTER" --kubeconfig "$KC" > /dev/null 2>&1 || return 1
  rm -f "$KC"
}
cleanup() {
  local rc=$?
  trap '' PIPE HUP
  stop_fg
  stop_bg
  [ -n "$TMP_VALUES" ] && rm -f "$TMP_VALUES"
  print_table
  # the exit status says the verdict too
  [ "$rc" = 0 ] && [ -s "$OUT/verdict.txt" ] && grep -q ': FAIL' "$OUT/verdict.txt" && rc=1
  if [ "$CREATED" = 1 ]; then
    if [ "${KEEP:-0}" = 1 ]; then
      say "KEEP=1: cluster $CLUSTER stays (kubeconfig $KC; REH_OUT=$OUT scripts/upgrade-rehearsal.sh --delete)"
    elif delete_cluster; then
      say "deleted kind cluster $CLUSTER; kind clusters left: $(kind get clusters 2>/dev/null | tr '\n' ' ')"
    else
      warn "kind cluster $CLUSTER was not deleted"
    fi
  fi
  exit "$rc"
}

# guard: the names are the rehearsal's, its kubeconfig holds its one context, and that context points at its node.
guard() {
  case "$CLUSTER" in kubeast-reh*) ;; *) stop "cluster name $CLUSTER does not start with kubeast-reh" ;; esac
  [ "$CTX" = "kind-$CLUSTER" ] || stop "context $CTX is not kind-$CLUSTER"
  [ -f "$KC" ] || stop "no $KC"
  local ctxs srv port
  ctxs=$(kubectl --kubeconfig "$KC" config get-contexts -o name 2>/dev/null | tr '\n' ' ')
  [ "$ctxs" = "$CTX " ] || stop "$KC holds other contexts than $CTX: '$ctxs'"
  [ "$(docker inspect -f '{{.State.Running}}' "$CP" 2>/dev/null)" = true ] || stop "node container $CP is not running"
  srv=$(kubectl --kubeconfig "$KC" config view -o jsonpath="{.clusters[?(@.name==\"$CTX\")].cluster.server}")
  port=$(docker port "$CP" 6443/tcp 2>/dev/null | head -1 | sed 's/.*://')
  [ -n "$port" ] || stop "no published API port on $CP"
  case "$srv" in *":$port") ;; *) stop "context $CTX points at $srv, not at $CP (port $port)" ;; esac
}

# busy_guard: one heavy job at a time on the laptop (a full e2e, a spec run or a load test).
busy_guard() {
  [ "${ALLOW_PARALLEL:-0}" = 1 ] && { warn "ALLOW_PARALLEL=1: not checking for e2e or load runs"; return 0; }
  local p
  p=$(pgrep -fl 'playwright test|ms-playwright|e2e-run.sh|loadkit|kind-footprint' 2>/dev/null | head -3 | cut -c1-90 | tr '\n' ';')
  [ -z "$p" ] || stop "a test or load run is going ($p) — run when it has ended (ALLOW_PARALLEL=1 to go on anyway)"
}

# --- API calls: call METHOD PATH TOKEN [JSON] sets CODE and BODY (no subshell, so the caller sees both) ---
hdr() { [ -n "$1" ] && printf 'Authorization: Bearer %s\n' "$1"; [ -n "$2" ] && printf 'Content-Type: application/json\n'; return 0; }
call() {
  local m=$1 p=$2 t=$3 b=${4:-} tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/reh.XXXXXX")
  if [ -n "$b" ]; then
    CODE=$(printf '%s' "$b" | curl -s -m "$CALL_TIMEOUT" -o "$tmp" -w '%{http_code}' -X "$m" -H @<(hdr "$t" json) --data-binary @- "$GW$p")
  else
    CODE=$(curl -s -m "$CALL_TIMEOUT" -o "$tmp" -w '%{http_code}' -X "$m" -H @<(hdr "$t" "") "$GW$p")
  fi
  BODY=$(cat "$tmp"); rm -f "$tmp"
  [ -n "$CODE" ] || CODE=000
}
jqb() { printf '%s' "$BODY" | jq -r "$1" 2>/dev/null; }
LIST='(if type == "array" then . else (.items // .recordings // .users // .roles // []) end)'
expect() { # expect "CODES" WHAT — stops unless CODE is one of CODES
  case " $1 " in *" $CODE "*) return 0 ;; esac
  stop "$2: HTTP $CODE $(jqb '.detail? // empty' | head -c 200 | mask)"
}
login() { # login EMAIL PASSWORD — sets TOKEN (empty on failure) and CODE; the answer is dropped
  call POST /api/v1/auth/login "" "$(printf '{"email":"%s","password":"%s"}' "$1" "$2")"
  TOKEN=""
  [ "$CODE" = 200 ] && TOKEN=$(jqb '.access_token // empty')
  BODY=""
}
secret_key() { kc -n "$NS" get secret "$1" -o "jsonpath={.data.$2}" | base64 -d; }
admin_login() {
  local pw
  pw=$(secret_key "$APP_SECRET" DEFAULT_ADMIN_PASSWORD); login admin "$pw"; pw=""
  [ -n "$TOKEN" ] || stop "admin sign-in with the password in $APP_SECRET: HTTP $CODE"
  ATOK=$TOKEN
}
# The test accounts' passwords and the API key: Secret rehearsal-seed/seed-creds in the rehearsal cluster.
seed_get() { kc -n "$SEED_NS" get secret seed-creds -o "jsonpath={.data.$1}" | base64 -d; }
seed_write() { # seed_write NAME... — writes those shell variables as the whole Secret (create, not apply)
  local n v
  kc create namespace "$SEED_NS" --dry-run=client -o yaml | kc apply -f - > /dev/null || stop "namespace $SEED_NS"
  kc -n "$SEED_NS" delete secret seed-creds --ignore-not-found > /dev/null
  {
    printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: seed-creds\n  namespace: %s\ntype: Opaque\nstringData:\n' "$SEED_NS"
    for n in "$@"; do v=${!n}; printf '  %s: "%s"\n' "$n" "$v"; done
  } | kc create -f - > /dev/null || stop "write Secret $SEED_NS/seed-creds"
}
newpw() { # 24 letters and digits, none of the password policy's weak fragments
  local p
  while :; do
    p="Rh$(openssl rand -base64 33 | tr -dc 'A-Za-z0-9' | cut -c1-22)"
    [ ${#p} -ge 20 ] || continue
    case "$(printf '%s' "$p" | tr '[:upper:]' '[:lower:]')" in *kubeast*|*passw*|*qwerty*|*letmein*|*changeme*|*12345678*) continue ;; esac
    printf '%s' "$p"; return 0
  done
}

# --- what the candidate holds: each change a check waits for, by what in the checkout shows it (a SKIP row names it) ---
CHANGES="856 858 865 866 867 868 901"
change_says() { # change_says CHANGE — the checks that wait for it
  case $1 in
    856) echo "preStop sleep and grace period; the second upgrade (B)" ;;
    858) echo "a drain whose server was replaced reads interrupted (B)" ;;
    865) echo "role names one per group: renames, removed grants, ended requests, audit rows" ;;
    866) echo "Redis users" ;;
    867) echo "more than one replica of every service (C)" ;;
    868) echo "PostgreSQL max_connections and restart; the connection sum stops a render" ;;
    901) echo "probe paths, rollout strategy, PDBs; values setting pdb.minAvailable stop" ;;
  esac
}
in_checkout() { # in_checkout CHANGE
  case $1 in
    856) chart_has podShutdown.preStopSeconds ;;
    858) migrations_have 'CREATE TABLE[^(]*node_drains' ;;
    865) migrations_have 'roles_name_group_key' ;;
    866) chart_has redis.acl.enabled ;;
    867) chart_has autoscaling ;;
    868) chart_has postgresql.maxConnections && [ -f "$ROOT/helm/kubeast/templates/checks/db-connections.yaml" ] ;;
    901) chart_has pdb.maxUnavailable ;;
    *) return 1 ;;
  esac
}
required() { case "$REQUIRE_LIST" in *" all "*|*" $1 "*) return 0 ;; esac; return 1; }
require_names() { # REQUIRE names only changes some check waits for
  local c
  for c in $REQUIRE_LIST; do
    case " all $CHANGES " in *" $c "*) ;; *) stop "REQUIRE: no check waits for #$c (the changes: $CHANGES, or all)" ;; esac
  done
}
require_held() { # before a run makes its cluster: the checkout holds every change REQUIRE names
  local c missing=""
  for c in $CHANGES; do required "$c" && ! in_checkout "$c" && missing="$missing #$c"; done
  [ -z "$missing" ] || stop "REQUIRE names changes this checkout does not hold:$missing (--plan lists what each check waits for)"
}
plan() { # --plan: the changes against the checkout, and the render stops on the default scenario's install values
  local c
  for c in $CHANGES; do
    if in_checkout "$c"; then info plan "#$c $(change_says "$c")" "in this checkout"
    else skip plan "$(change_says "$c")" "$c" "not in this checkout"; fi
  done
  write_values_from
  removed_value_checks render
  db_connection_checks render
}
# The checkout chart's values.yaml as JSON, as Helm reads it (scripts/values-paths.sh of #908 does the same).
chart_values() {
  local c="$OUT/values-json-chart" t
  for t in helm jq; do command -v "$t" > /dev/null || stop "$t is not installed"; done
  mkdir -p "$c/templates"
  printf 'apiVersion: v2\nname: values-json\nversion: 0.0.0\n' > "$c/Chart.yaml"
  printf '# {{ toJson .Values }}\n' > "$c/templates/values.yaml"
  helm template values-json "$c" -f "$ROOT/helm/kubeast/values.yaml" 2>/dev/null | sed -n 's/^# {/{/p' > "$CHART_VALUES"
  rm -rf "$c"
  [ -s "$CHART_VALUES" ] || stop "helm/kubeast/values.yaml did not render as JSON"
}
chart_has() { jq -e --arg p "$1" 'getpath($p | split(".")) != null' "$CHART_VALUES" > /dev/null; }
chart_value() { jq -r --arg p "$1" 'getpath($p | split(".")) // empty' "$CHART_VALUES"; }
migrations_have() { grep -qE "$1" "$MIGRATIONS"/*.sql 2>/dev/null; }
value_of() { hc get values -a -o json 2>/dev/null | jq -r --arg p "$1" 'getpath($p | split(".")) // empty'; }
newest_migration() { local f n=""; for f in "$MIGRATIONS"/[0-9][0-9][0-9][0-9][0-9]_*.sql; do n=${f##*/}; done; printf '%s' "${n%%_*}"; }
db_version() { psql_q "SELECT version_id FROM goose_db_version WHERE is_applied ORDER BY id DESC LIMIT 1" 2>/dev/null; }

# --- 1. cluster ---
make_cluster() {
  busy_guard
  local t
  for t in kind kubectl helm docker jq curl openssl python3 git; do command -v "$t" > /dev/null || stop "$t is not installed"; done
  case "$CLUSTER" in kubeast-reh*) ;; *) stop "REH_CLUSTER must start with kubeast-reh" ;; esac
  case "$HOST_PORT" in 30080|30081|30390) stop "host port $HOST_PORT belongs to another cluster" ;; esac
  kind get clusters 2>/dev/null | grep -x "$CLUSTER" > /dev/null && stop "kind cluster $CLUSTER exists already (--delete with its REH_OUT, or another REH_CLUSTER)"
  lsof -nP -iTCP:"$HOST_PORT" -sTCP:LISTEN > /dev/null 2>&1 && stop "port $HOST_PORT is in use (HOST_PORT=<another>)"
  local total
  total=$(docker info --format '{{.MemTotal}}' 2>/dev/null)
  say "docker memory $(( ${total:-0} / 1073741824 )) GiB; kind clusters before: $(kind get clusters 2>/dev/null | tr '\n' ' ')"
  cat > "$OUT/kind.yaml" <<EOF
# kind cluster of the upgrade rehearsal: Kubeast on the control-plane, the worker only for the drain test pod
apiVersion: kind.x-k8s.io/v1alpha4
kind: Cluster
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: $NODE_PORT
        hostPort: $HOST_PORT
        listenAddress: "127.0.0.1"
        protocol: TCP
  - role: worker
    labels:
      rehearsal/role: drain
EOF
  local t0; t0=$(date +%s)
  CREATED=1
  fg_run kind create cluster --name "$CLUSTER" --config "$OUT/kind.yaml" --kubeconfig "$KC" --wait 180s > "$OUT/kind-create.log" 2>&1 \
    || { tail -5 "$OUT/kind-create.log"; stop "kind create cluster (kind-create.log)"; }
  chmod 600 "$KC"
  say "cluster $CLUSTER made in $(( $(date +%s) - t0 ))s"
  if [ -n "${KIND_NODE_HOOK:-}" ]; then
    local node
    for node in $(kind get nodes --name "$CLUSTER"); do
      # shellcheck disable=SC2086 # a command with its arguments, as CALICO_NODE_HOOK
      $KIND_NODE_HOOK "$node" >> "$OUT/kind-node-hook.log" 2>&1 || { tail -3 "$OUT/kind-node-hook.log"; stop "KIND_NODE_HOOK on $node"; }
    done
  fi
  guard
  # a hook that restarts containerd takes the API server away for a moment
  for _ in $(seq 1 60); do kc get --raw /readyz > /dev/null 2>&1 && break; sleep 2; done
  kc wait --for=condition=Ready node --all --timeout=180s > /dev/null || stop "nodes not Ready"
  # Kubeast on the control-plane (kind keeps its NoSchedule taint when there is a worker); the worker takes only
  # the drain test pod, which tolerates its taint.
  kc taint node "$CP" node-role.kubernetes.io/control-plane:NoSchedule- > /dev/null 2>&1
  kc taint node "$WORKER" rehearsal/drain=only:NoSchedule --overwrite > /dev/null || stop "taint $WORKER"
  local v; v=$(kc get node "$CP" -o jsonpath='{.status.nodeInfo.kubeletVersion}')
  say "nodes $v"
  case "$v" in v1.2[0-9].*) stop "kubelet $v: the chart's preStop sleep needs Kubernetes 1.30 or later" ;; esac
  info cluster "kind nodes" "$v · $(kind version | cut -d' ' -f1-2) · $(helm version --short)"
}

# --- 2. external database (SCENARIO=external-db) ---
make_external_db() {
  local pw
  pw=$(openssl rand -hex 24)
  kc create namespace "$DB_NS" > /dev/null || stop "namespace $DB_NS"
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: pg-auth\n  namespace: %s\ntype: Opaque\nstringData:\n  password: "%s"\n' "$DB_NS" "$pw" \
    | kc create -f - > /dev/null || stop "Secret $DB_NS/pg-auth"
  cat > "$OUT/external-db.yaml" <<EOF
apiVersion: apps/v1
kind: Deployment
metadata: {name: pg, namespace: $DB_NS}
spec:
  replicas: 1
  strategy: {type: Recreate}
  selector: {matchLabels: {app: pg}}
  template:
    metadata: {labels: {app: pg}}
    spec:
      containers:
        - name: pg
          image: $DB_IMAGE
          args: ["-c", "max_connections=300"]
          env:
            - {name: POSTGRES_USER, value: kubeast}
            - {name: POSTGRES_DB, value: kubeast}
            - name: POSTGRES_PASSWORD
              valueFrom: {secretKeyRef: {name: pg-auth, key: password}}
          ports: [{containerPort: 5432}]
          readinessProbe: {exec: {command: ["pg_isready", "-U", "kubeast"]}, periodSeconds: 2}
          volumeMounts: [{name: data, mountPath: /var/lib/postgresql}]
      volumes: [{name: data, emptyDir: {}}]
---
apiVersion: v1
kind: Service
metadata: {name: pg, namespace: $DB_NS}
spec: {selector: {app: pg}, ports: [{port: 5432, targetPort: 5432}]}
EOF
  if [ "$POOLER" = 1 ]; then
    cat >> "$OUT/external-db.yaml" <<EOF
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: pgbouncer, namespace: $DB_NS}
spec:
  replicas: 1
  selector: {matchLabels: {app: pgbouncer}}
  template:
    metadata: {labels: {app: pgbouncer}}
    spec:
      containers:
        - name: pgbouncer
          image: $POOLER_IMAGE
          env:
            - {name: DB_HOST, value: pg.$DB_NS.svc.cluster.local}
            - {name: DB_PORT, value: "5432"}
            - {name: DB_USER, value: kubeast}
            - name: DB_PASSWORD
              valueFrom: {secretKeyRef: {name: pg-auth, key: password}}
            - {name: AUTH_TYPE, value: scram-sha-256}
            - {name: POOL_MODE, value: $POOLER_MODE}
            - {name: MAX_CLIENT_CONN, value: "600"}
            - {name: DEFAULT_POOL_SIZE, value: "250"}
            - {name: LISTEN_PORT, value: "5432"}
          ports: [{containerPort: 5432}]
          readinessProbe: {tcpSocket: {port: 5432}, periodSeconds: 2}
---
apiVersion: v1
kind: Service
metadata: {name: pgbouncer, namespace: $DB_NS}
spec: {selector: {app: pgbouncer}, ports: [{port: 5432, targetPort: 5432}]}
EOF
  fi
  kc apply -f "$OUT/external-db.yaml" > /dev/null || stop "external database objects"
  kc -n "$DB_NS" rollout status deploy/pg --timeout=300s > /dev/null || stop "external PostgreSQL not ready"
  local host=pg
  if [ "$POOLER" = 1 ]; then
    kc -n "$DB_NS" rollout status deploy/pgbouncer --timeout=300s > /dev/null || stop "PgBouncer ($POOLER_IMAGE) not ready"
    host=pgbouncer
  fi
  TMP_VALUES=$(mktemp "$OUT/.db-values.XXXXXX"); chmod 600 "$TMP_VALUES"
  printf 'postgresql:\n  enabled: false\n  externalHost: %s.%s.svc.cluster.local\n  externalPort: 5432\n  password: "%s"\n' "$host" "$DB_NS" "$pw" > "$TMP_VALUES"
  pw=""
  info external-db "database" "$DB_IMAGE max_connections 300$([ "$POOLER" = 1 ] && echo " behind $POOLER_IMAGE pool_mode $POOLER_MODE" || echo ", no pooler")"
}

# --- 3. install FROM_VERSION as a user does ---
write_values_from() {
  cat > "$OUT/values-from.yaml" <<EOF
# What install.sh sets, plus what the test data needs: access requests, custom roles that act on the cluster,
# session recording (stored in the database without a bucket).
gateway:
  service:
    type: NodePort
    nodePort: $NODE_PORT
auth:
  cookieSecure: false
  accessRequests:
    enabled: true
  impersonation:
    customRoles:
      - name: rh-ops
        clusterRoles: [view]
      - name: Write
        namespaces: [default]
        clusterRoles: [edit]
sessionRecording:
  enabled: true
EOF
}
install_from() {
  write_values_from
  local extra=()
  if [ "$SCENARIO" = existing-secret ]; then
    # The Secret a user would manage: the chart's own render of kubeast-secrets, under another name.
    APP_SECRET=rh-app-secrets
    kc create namespace "$NS" > /dev/null 2>&1
    helm template kubeast "$CHART_OCI" --version "$FROM_VERSION" -n "$NS" -f "$OUT/values-from.yaml" --show-only templates/secret.yaml 2>/dev/null \
      | python3 -I -c '
import re, sys
for d in re.split(r"(?m)^---\s*$", sys.stdin.read()):
    if re.search(r"(?m)^kind: Secret\s*$", d) and re.search(r"(?m)^  name: kubeast-secrets\s*$", d):
        sys.stdout.write(re.sub(r"(?m)^  name: kubeast-secrets\s*$", "  name: " + sys.argv[1], d, count=1))
        break
' "$APP_SECRET" | kc -n "$NS" create -f - > /dev/null || stop "Secret $APP_SECRET from the $FROM_VERSION render"
    printf 'secrets:\n  existingSecret: %s\n' "$APP_SECRET" >> "$OUT/values-from.yaml"
    info existing-secret "app Secret" "$APP_SECRET with the keys the $FROM_VERSION chart renders"
  fi
  [ -n "$TMP_VALUES" ] && extra=(-f "$TMP_VALUES")
  if [ -n "${EXTRA_VALUES:-}" ]; then
    [ -f "$EXTRA_VALUES" ] || stop "EXTRA_VALUES $EXTRA_VALUES is not a file"
    cp "$EXTRA_VALUES" "$OUT/values-extra.yaml"
    extra+=(-f "$OUT/values-extra.yaml")
    info install "values added at install (kept by every upgrade)" "$EXTRA_VALUES"
  fi
  local t0; t0=$(date +%s)
  fg_run hc install kubeast "$CHART_OCI" --version "$FROM_VERSION" --create-namespace -f "$OUT/values-from.yaml" ${extra[@]+"${extra[@]}"} \
    --wait --timeout 15m > "$OUT/install-from.log" 2>&1 || { tail -8 "$OUT/install-from.log"; stop "helm install $FROM_VERSION (install-from.log)"; }
  [ -n "$TMP_VALUES" ] && { rm -f "$TMP_VALUES"; TMP_VALUES=""; }
  say "installed $FROM_VERSION in $(( $(date +%s) - t0 ))s"
  local i
  for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$GW/healthz")" = 200 ] && break; sleep 2; done
  check install "chart $FROM_VERSION installed" "kubeast-$FROM_VERSION deployed" "$(hc list -o json | jq -r '.[] | select(.name == "kubeast") | "\(.chart) \(.status)"')"
  check install "every Kubeast image is v$FROM_VERSION" 7 "$(kc -n "$NS" get deploy -o json | jq "[.items[].spec.template.spec.containers[0].image | select(endswith(\":v$FROM_VERSION\"))] | length")"
  admin_login
  helm show values "$CHART_OCI" --version "$FROM_VERSION" > "$OUT/values-copied-from.yaml" 2>/dev/null || stop "helm show values $FROM_VERSION"
}

# --- 4. data, through FROM_VERSION's API (and the rows no API makes, straight into the database) ---
# shellcheck disable=SC2034 # the passwords and keys are read by name (${!v}) in seed_write and the sign-ins
seed() {
  admin_login
  call POST /api/v1/auth/setup "$ATOK" '{"mode":"in_cluster"}'; expect 200 "register the cluster Kubeast runs on"
  local i
  for i in $(seq 1 30); do call GET /api/v1/auth/setup/rollout-status "$ATOK"; [ "$(jqb .ready)" = true ] && break; sleep 2; done
  [ "$(jqb .ready)" = true ] || stop "k8s-service does not reach the registered cluster"
  admin_login
  call POST /api/v1/auth/admin/organizations "$ATOK" '{"type":"team","name":"rh-team-a"}'; expect 201 "team rh-team-a"
  call POST /api/v1/auth/admin/roles "$ATOK" '{"name":"rh-ops","description":"rehearsal","permissions":["menu.workloads","menu.dashboard","resource.objects.read"]}'
  expect 201 "role rh-ops"
  call POST /api/v1/auth/admin/roles "$ATOK" '{"name":"rh-reader","description":"rehearsal","permissions":["menu.*","resource.*.read"]}'
  expect 201 "role rh-reader"
  U1_PW=$(newpw); U2_PW=$(newpw); U3_PW=$(newpw); U4_PW=$(newpw); U5_PW=$(newpw)
  seed_write U1_PW U2_PW U3_PW U4_PW
  local n v body
  # rh-u5 never signs in: seed_lookalikes makes its account level a role FROM_VERSION reads as Pending
  for n in 1 2 3 4 5; do
    v="U${n}_PW"
    body=$(printf '{"name":"Rh User %s","email":"rh-u%s@%s","password":"%s","role_id":0,"team":"rh-team-a"}' "$n" "$n" "$DOMAIN" "${!v}")
    call POST /api/v1/auth/admin/users "$ATOK" "$body"; body=""; expect 201 "user rh-u$n"
    printf -v "ID$n" '%s' "$(jqb .id)"
  done
  grant() { # grant N ROLE [NAMESPACES_JSON]
    local id="ID$1" ns=""
    [ -n "${3:-}" ] && ns=",\"namespaces\":$3"
    call PUT "/api/v1/auth/admin/users/${!id}/cluster-roles/$CLUSTER_ID" "$ATOK" "{\"role\":\"$2\"$ns}"
  }
  grant 1 Read; expect 200 "grant Read to rh-u1"
  grant 2 rh-ops; expect 200 "grant rh-ops to rh-u2"
  grant 3 Write '["default"]'; expect 200 "grant Write in default to rh-u3"
  seed_lookalikes
  # The grant through the API when FROM_VERSION takes the name as that role; else (refused, or given to the
  # built-in) the row goes into the table.
  grant 4 ADMIN
  local api=$CODE
  if [ "$(psql_q "SELECT role_id FROM user_cluster_roles WHERE user_id = '$ID4' AND cluster_id = '$CLUSTER_ID'")" = "$R_ADMIN_LIKE" ]; then
    info seed "grant of the stored role ADMIN to rh-u4" "through the API (HTTP $api)"
  else
    psql_q "INSERT INTO user_cluster_roles (user_id, cluster_id, role_id) VALUES ('$ID4', '$CLUSTER_ID', $R_ADMIN_LIKE)
            ON CONFLICT (user_id, cluster_id) DO UPDATE SET role_id = EXCLUDED.role_id" > /dev/null || stop "grant row of ADMIN to rh-u4"
    info seed "grant of the stored role ADMIN to rh-u4" "API answered $api without granting that role, so the grant row went into the table"
  fi
  for n in 1 2 3 4; do v="U${n}_PW"; login "rh-u$n@$DOMAIN" "${!v}"; expect 200 "rh-u$n signs in"; printf -v "T$n" '%s' "$TOKEN"; done
  call POST /api/v1/auth/api-keys "$T1" "{\"name\":\"rh-key-u1\",\"expires_in_days\":30,\"cluster_ids\":[\"$CLUSTER_ID\"],\"role_ceiling\":\"Read\"}"
  expect 201 "API key of rh-u1"; K1=$(jqb .key); BODY=""
  call POST /api/v1/auth/api-keys "$T1" "{\"name\":\"rh-key-u1-revoked\",\"expires_in_days\":30,\"cluster_ids\":[\"$CLUSTER_ID\"],\"role_ceiling\":\"Read\"}"
  expect 201 "second API key of rh-u1"; KGONE=$(jqb .key); local kgone_id; kgone_id=$(jqb .id); BODY=""
  call DELETE "/api/v1/auth/api-keys/$kgone_id" "$T1"; expect "200 204" "revoke rh-key-u1-revoked"
  seed_write U1_PW U2_PW U3_PW U4_PW K1 KGONE
  unset K1 KGONE
  call POST /api/v1/auth/access-requests "$T1" "{\"cluster_id\":\"$CLUSTER_ID\",\"role\":\"Write\",\"duration_minutes\":480,\"reason\":\"rehearsal: approved on $FROM_VERSION\"}"
  expect 201 "access request of rh-u1"; local ar; ar=$(jqb .id)
  call POST "/api/v1/auth/admin/access-requests/$ar/approve" "$ATOK" '{"note":"rehearsal"}'; expect 200 "approve"
  call POST /api/v1/auth/access-requests "$T2" "{\"cluster_id\":\"$CLUSTER_ID\",\"role\":\"Write\",\"duration_minutes\":60,\"reason\":\"rehearsal: pending at the upgrade\"}"
  expect 201 "access request of rh-u2"
  call POST "/api/v1/sessions?cluster=$CLUSTER_ID" "$ATOK" '{"title":"rh-conversation-1"}'; expect "200 201" "the admin's conversation"
  login "rh-u2@$DOMAIN" "Wrong$(newpw)"
  # Recordings stored in the database: one uploaded, one still open (written by FROM_VERSION, no owner) at the upgrade.
  psql_q "INSERT INTO session_recordings (id, kind, user_email, cluster, namespace, target, container, storage, status, started_at, ended_at, bytes, uploaded_bytes, parts, truncated, location)
          VALUES ('rec-reh-uploaded', 'exec', 'rh-u3@$DOMAIN', '$CLUSTER_ID', 'default', 'web-1', 'app', 'database', 'uploaded', now() - interval '30 minutes', now() - interval '29 minutes', 0, 0, 0, false, ''),
                 ('rec-reh-open', 'exec', 'rh-u3@$DOMAIN', '$CLUSTER_ID', 'default', 'web-1', 'app', 'database', 'recording', now() - interval '2 minutes', NULL, 0, 0, 0, false, '')" > /dev/null \
    || stop "insert the recording rows"
  unset U1_PW U2_PW U3_PW U4_PW U5_PW
  for n in 1 2 3 4; do printf -v "T$n" '%s' ""; done
  info seed "data on $FROM_VERSION" "5 users · roles rh-ops rh-reader + stored ADMIN, ' read ', RH-OPS, ' PENDING ' (rh-u5's account level) · grants (rh-u4 ADMIN) · 2 keys (1 revoked) · 3 access requests (1 pending for RH-OPS) · 1 conversation · 2 recordings"
}

# seed_lookalikes: custom roles whose names a built-in or another role has in other letters or with spaces around.
# FROM_VERSION refuses them when made, but an install can hold them from before that rule, so they go straight into
# the table, with what an install can hold of them: a pending access request (rh-u3 for RH-OPS) and an account level
# (rh-u5 at " PENDING ", which FROM_VERSION reads ignoring case as Pending: an account waiting for approval). Needs
# ID3, ID5 and CLUSTER_ID; sets R_ADMIN_LIKE. rh-u4's grant of ADMIN is the seed's.
seed_lookalikes() {
  local v rid r_rhops="" r_pending=""
  for v in "ADMIN" " read " "RH-OPS" " PENDING "; do
    rid=$(psql_q "INSERT INTO roles (name, description) VALUES ('$v', '$LOOKALIKE') RETURNING id" | head -1)
    [ -n "$rid" ] || stop "insert role '$v'"
    psql_q "INSERT INTO role_permissions (role_id, permission) VALUES ($rid, 'menu.dashboard')" > /dev/null || stop "permission of role '$v'"
    case "$v" in ADMIN) R_ADMIN_LIKE=$rid ;; RH-OPS) r_rhops=$rid ;; " PENDING ") r_pending=$rid ;; esac
  done
  psql_q "INSERT INTO access_requests (id, user_id, cluster_id, role_id, duration_minutes, reason, status)
          VALUES ('ar-reh-lookalike', '$ID3', '$CLUSTER_ID', $r_rhops, 60, 'rehearsal: pending for the stored role RH-OPS', 'pending')" > /dev/null \
    || stop "insert the access request for RH-OPS"
  [ "$(psql_q "UPDATE auth_users SET role_id = $r_pending WHERE id = '$ID5' RETURNING id" | head -1)" = "$ID5" ] || stop "account level ' PENDING ' of rh-u5"
}

# snapshot WHEN: what the checks compare, names and states only (no secret, no row of a person's content)
snapshot() {
  local d="$OUT/$1"; mkdir -p "$d"
  admin_login
  call GET "/api/v1/auth/admin/users?limit=200" "$ATOK"
  jqb "$LIST | [.[] | select(.email | endswith(\"@$DOMAIN\")) | \"\(.email) \(.name)\"] | sort | .[]" > "$d/users.txt"
  call GET "/api/v1/auth/organizations?type=team" "$ATOK"
  jqb "$LIST | [.[] | .name | select(startswith(\"rh-\"))] | sort | .[]" > "$d/teams.txt"
  psql_q "SELECT id || ' [' || name || ']' FROM roles WHERE NOT is_system ORDER BY id" > "$d/roles.txt"
  psql_q "SELECT u.email || ' ' || g.cluster_id || ' ' || r.id || ' [' || r.name || ']' FROM user_cluster_roles g JOIN auth_users u ON u.id = g.user_id JOIN roles r ON r.id = g.role_id WHERE u.email LIKE '%@$DOMAIN' ORDER BY 1" > "$d/grants.txt"
  psql_q "SELECT role_id || ' ' || status || ' ' || coalesce(end_reason, '-') || ' ' || reason FROM access_requests WHERE reason LIKE 'rehearsal%' ORDER BY reason" > "$d/access-requests.txt"
  # the roles stored before the name rule, and what an upgrade with #865 changes for them: "<grants> <requests>
  # <accounts>" — accounts whose account level is one of them in Pending's group (ASCII names: trimmed, any case)
  psql_q "SELECT id || ' [' || name || ']' FROM roles WHERE description = '$LOOKALIKE' ORDER BY id" > "$d/lookalike-roles.txt"
  psql_q "WITH l AS (SELECT id FROM roles WHERE description = '$LOOKALIKE')
          SELECT ((SELECT count(*) FROM user_cluster_roles WHERE role_id IN (SELECT id FROM l))
                + (SELECT count(*) FROM user_cluster_roles WHERE restore_role_id IN (SELECT id FROM l) AND role_id NOT IN (SELECT id FROM l)))::text
               || ' ' || (SELECT count(*) FROM access_requests WHERE role_id IN (SELECT id FROM l) AND status IN ('pending', 'approved'))::text
               || ' ' || (SELECT count(*) FROM auth_users u JOIN roles r ON r.id = u.role_id
                          WHERE r.id IN (SELECT id FROM l) AND lower(btrim(r.name)) = 'pending')::text" > "$d/lookalike-holds.txt"
  psql_q "SELECT u.email || ' ' || u.token_version FROM auth_users u JOIN roles r ON r.id = u.role_id
          WHERE r.description = '$LOOKALIKE' AND lower(btrim(r.name)) = 'pending' ORDER BY 1" > "$d/lookalike-accounts.txt"
  psql_q "SELECT id || ' ' || storage FROM session_recordings WHERE id LIKE 'rec-reh-%' ORDER BY 1" > "$d/recordings.txt"
  psql_q "SELECT id || ' ' || status FROM session_recordings WHERE id LIKE 'rec-reh-%' ORDER BY 1" > "$d/recording-status.txt"
  psql_q "SELECT title FROM sessions WHERE title LIKE 'rh-%' ORDER BY 1" > "$d/conversations.txt"
  local pw t
  pw=$(seed_get U1_PW); login "rh-u1@$DOMAIN" "$pw"; pw=""; t=$TOKEN
  call GET /api/v1/auth/api-keys "$t"; t=""
  jqb "$LIST | [.[] | .name] | sort | .[]" > "$d/api-keys.txt"
  db_version > "$d/db-version.txt"
  BODY=""
}
# expected_after: with #865, what the before snapshot reads as once its migration has run (the migration's comment
# says it): a role stored before the name rule is "<name trimmed>-renamed-<id>", its grants are gone (none of the seed's
# is a temporary grant, which would go back to the role it restores instead) and its pending or approved requests are
# expired with end_reason role_renamed. The other lines stay as they were.
expected_after() {
  local e="$OUT/expected" ids
  rm -rf "$e"
  in_checkout 865 || return 0
  mkdir -p "$e"
  ids=$(awk '{print $1}' "$OUT/before/lookalike-roles.txt" | tr '\n' ' ')
  awk -v ids="$ids" 'BEGIN { n = split(ids, a, " "); for (i = 1; i <= n; i++) l[a[i]] = 1 }
    ($1 in l) { s = $0; sub(/^[0-9]+ \[/, "", s); sub(/\]$/, "", s); gsub(/^ +| +$/, "", s); print $1 " [" s "-renamed-" $1 "]"; next }
    { print }' "$OUT/before/roles.txt" > "$e/roles.txt"
  awk -v ids="$ids" 'BEGIN { n = split(ids, a, " "); for (i = 1; i <= n; i++) l[a[i]] = 1 } !($3 in l)' "$OUT/before/grants.txt" > "$e/grants.txt"
  awk -v ids="$ids" 'BEGIN { n = split(ids, a, " "); for (i = 1; i <= n; i++) l[a[i]] = 1 }
    ($1 in l) && ($2 == "pending" || $2 == "approved") { $2 = "expired"; $3 = "role_renamed" } { print }' "$OUT/before/access-requests.txt" > "$e/access-requests.txt"
}
compare_snapshots() {
  local f want name
  expected_after
  for f in users teams roles grants access-requests recordings conversations api-keys; do
    want="$OUT/before/$f.txt"; name="$f read back the same"
    if [ -f "$OUT/expected/$f.txt" ]; then want="$OUT/expected/$f.txt"; name="$f read back the same but for #865's changes"; fi
    if diff -q "$want" "$OUT/after/$f.txt" > /dev/null; then
      row data "$name" PASS "$(wc -l < "$OUT/after/$f.txt" | tr -d ' ') lines"
    else
      row data "$name" FAIL "$(diff "$want" "$OUT/after/$f.txt" | grep '^[<>]' | head -3 | tr '\n' ' ')"
    fi
  done
  [ -s "$OUT/before/users.txt" ] || row data "users snapshot has rows" FAIL "empty before snapshot"
  info data "recording status (before → after)" "$(paste -d' ' "$OUT/before/recording-status.txt" "$OUT/after/recording-status.txt" | awk '{print $1 ": " $2 " → " $4}' | tr '\n' ' ')"
}

# live_checks PHASE: the stored passwords and key sign in, grants act as before, the audit chain verifies
live_checks() {
  local a=$1 n pw k t
  for n in 1 2 3 4; do
    pw=$(seed_get "U${n}_PW"); login "rh-u$n@$DOMAIN" "$pw"; pw=""
    check "$a" "rh-u$n signs in with its $FROM_VERSION password" 200 "$CODE"
    printf -v "T$n" '%s' "$TOKEN"
  done
  k=$(seed_get K1); call POST /api/v1/auth/token "$k"; k=""
  check "$a" "rh-u1's API key exchanges for a token" 200 "$CODE"
  t=$(jqb '.access_token // empty'); BODY=""
  call GET /api/v1/auth/me "$t"; t=""
  check "$a" "that token is rh-u1's" "rh-u1@$DOMAIN" "$(jqb '.email // .user.email // empty')"
  k=$(seed_get KGONE); call POST /api/v1/auth/token "$k"; k=""; BODY=""
  check "$a" "the key revoked on $FROM_VERSION is refused" 401 "$CODE"
  call GET "/api/v1/cluster/namespaces/default/configmaps?cluster=$CLUSTER_ID" "$T1"; check_code "$a" "rh-u1 (Read) lists ConfigMaps in default" 200
  call GET "/api/v1/cluster/namespaces/default/configmaps?cluster=$CLUSTER_ID" "$T2"; check_code "$a" "rh-u2 (custom rh-ops) lists ConfigMaps in default" 200
  call GET "/api/v1/cluster/namespaces/default/configmaps?cluster=$CLUSTER_ID" "$T3"; check_code "$a" "rh-u3 (Write in default) lists ConfigMaps in default" 200
  call GET "/api/v1/cluster/namespaces/kube-system/configmaps?cluster=$CLUSTER_ID" "$T3"; check_code "$a" "rh-u3 is refused outside default" 403
  for n in 1 2 3 4; do printf -v "T$n" '%s' ""; done
  admin_login
  call GET /api/v1/recordings "$ATOK"
  check "$a" "the uploaded recording lists" yes "$(jqb '[.. | objects | .id? // empty] | if any(.[]; . == "rec-reh-uploaded") then "yes" else "no" end')"
  for n in $(seq 1 30); do
    call GET /api/v1/auth/admin/audit/integrity "$ATOK"
    [ "$(jqb '.unsealed_rows')" = 0 ] && break
    sleep 2
  done
  check "$a" "every audit row sealed" 0 "$(jqb '.unsealed_rows')"
  local oldest sealed
  oldest=$(jqb '.oldest_seq'); sealed=$(jqb '.sealed_through_seq')
  call POST /api/v1/auth/admin/audit/integrity/verify "$ATOK" "{\"from_seq\":${oldest:-0},\"to_seq\":${sealed:-0}}"
  check "$a" "the audit chain verifies (seq $oldest to $sealed)" true "$(jqb '.ok')"
  BODY=""
}

# role_checks: #865 (one role per group, its migration's comment says what it does to the roles stored before): the
# schema it adds, each stored look-alike renamed "<name trimmed>-renamed-<id>" while rh-ops (made first, through the
# API) keeps its name, their grants removed, their pending and approved requests ended role_renamed, an account level
# of Pending's group (rh-u5) moved to the built-in Pending with its tokens ended, the audit rows by system/migration
# counted per action against what the before snapshot held, and the name rule on a new role.
role_checks() {
  if ! in_checkout 865; then
    skip roles "role names one per group: renames, grants, requests, audit rows" 865 "no migration makes roles_name_group_key"
    return
  fi
  local l="(SELECT id FROM roles WHERE description = '$LOOKALIKE')" want got holds n_grants n_requests n_accounts n_renamed email tv
  holds=$(cat "$OUT/before/lookalike-holds.txt")
  read -r n_grants n_requests n_accounts <<< "$holds"
  n_renamed=$(grep -c . "$OUT/before/lookalike-roles.txt")
  check roles "the database has role_group_slug(text) and the unique index roles_name_group_key" "t t" \
    "$(psql_q "SELECT (to_regprocedure('role_group_slug(text)') IS NOT NULL)::text || ' ' || EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'roles_name_group_key')::text" | sed 's/true/t/g; s/false/f/g')"
  want=$(awk '{ s = $0; sub(/^[0-9]+ \[/, "", s); sub(/\]$/, "", s); gsub(/^ +| +$/, "", s); printf "%s%s [%s-renamed-%s]", (NR > 1 ? "," : ""), $1, s, $1 }' "$OUT/before/lookalike-roles.txt")
  check roles "the $n_renamed roles stored before the rule are <name>-renamed-<id>" "$want" \
    "$(psql_q "SELECT string_agg(id || ' [' || name || ']', ',' ORDER BY id) FROM roles WHERE id IN $l")"
  check roles "rh-ops, made first in its group, keeps its name" "$(grep ' \[rh-ops\]$' "$OUT/before/roles.txt" | tr '\n' ',' | sed 's/,$//')" \
    "$(psql_q "SELECT string_agg(id || ' [' || name || ']', ',' ORDER BY id) FROM roles WHERE role_group_slug(name) = 'rh-ops'")"
  if [ -s "$OUT/before/lookalike-accounts.txt" ]; then
    want=""; got=""
    while read -r email tv; do
      want="$want$email Pending t,"
      got="$got$(psql_q "SELECT u.email || ' ' || r.name || ' ' || (u.token_version > $tv)::text FROM auth_users u JOIN roles r ON r.id = u.role_id WHERE u.email = '$email'" | sed 's/true$/t/; s/false$/f/'),"
    done < "$OUT/before/lookalike-accounts.txt"
    check roles "accounts at ' PENDING ' are at the built-in Pending, token_version up" "$want" "$got"
  else
    row roles "accounts at ' PENDING ' are at the built-in Pending, token_version up" FAIL "no account held a role of Pending's group before the upgrade (seed_lookalikes)"
  fi
  check roles "grants of the renamed roles removed (before: $n_grants, rh-u4's ADMIN)" 0 \
    "$(psql_q "SELECT count(*) FROM user_cluster_roles WHERE role_id IN $l OR restore_role_id IN $l")"
  check roles "their pending and approved requests ended role_renamed (before: $n_requests)" "ended $n_requests · open 0" \
    "$(psql_q "SELECT 'ended ' || count(*) FILTER (WHERE status = 'expired' AND end_reason = 'role_renamed') || ' · open ' || count(*) FILTER (WHERE status IN ('pending', 'approved')) FROM access_requests WHERE role_id IN $l")"
  check roles "audit rows by system/migration, per action" \
    "admin.roles.update $n_renamed · user.cluster_role.unset $n_grants · access.request.expire $n_requests · user.role.update $n_accounts" \
    "$(psql_q "SELECT 'admin.roles.update ' || count(*) FILTER (WHERE action = 'admin.roles.update' AND target_type = 'role' AND target_id IN (SELECT id::text FROM roles WHERE description = '$LOOKALIKE') AND after->>'reason' = 'same_group')
                  || ' · user.cluster_role.unset ' || count(*) FILTER (WHERE action = 'user.cluster_role.unset' AND after->>'reason' = 'role_renamed')
                  || ' · access.request.expire ' || count(*) FILTER (WHERE action = 'access.request.expire' AND after->>'end_reason' = 'role_renamed')
                  || ' · user.role.update ' || count(*) FILTER (WHERE action = 'user.role.update' AND after->>'reason' = 'role_renamed')
               FROM auth_audit_logs WHERE actor_user_id = 'system' AND actor_email = 'migration'")"
  admin_login
  call GET /api/v1/auth/roles "$ATOK"
  check roles "GET /auth/roles: no role shares a group (same_group_as)" 0 "$(jqb "$LIST | map(select((.same_group_as // \"\") != \"\")) | length")"
  call POST /api/v1/auth/admin/roles "$ATOK" '{"name":"Rh-Ops","description":"rehearsal: refused","permissions":["menu.dashboard"]}'
  check roles "a new role Rh-Ops (group of rh-ops) is refused" "400 role_name_taken rh-ops" "$CODE $(jqb '.code // empty') $(jqb '.role // empty')"
  BODY=""
}

# --- 5. the drain test pod: one replica on the worker held by a PodDisruptionBudget, so a drain retries its
# eviction for the drain's five minutes and is still running when k8s-service is replaced ---
make_blocker() {
  kc create namespace "$DRAIN_NS" > /dev/null || stop "namespace $DRAIN_NS"
  cat <<EOF | kc apply -f - > /dev/null || stop "drain test objects"
apiVersion: apps/v1
kind: Deployment
metadata: {name: drain-blocker, namespace: $DRAIN_NS}
spec:
  replicas: 1
  selector: {matchLabels: {app: drain-blocker}}
  template:
    metadata: {labels: {app: drain-blocker}}
    spec:
      nodeSelector: {rehearsal/role: drain}
      tolerations: [{key: rehearsal/drain, operator: Equal, value: only, effect: NoSchedule}]
      containers:
        - name: sleep
          image: $BLOCKER_IMAGE
          command: ["sleep", "86400"]
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: {name: drain-blocker, namespace: $DRAIN_NS}
spec:
  minAvailable: 1
  selector: {matchLabels: {app: drain-blocker}}
EOF
  kc -n "$DRAIN_NS" rollout status deploy/drain-blocker --timeout=180s > /dev/null || stop "drain test pod not ready on $WORKER"
}
start_drain() { # start_drain — sets DRAIN_ID; the drain is "draining" when it returns
  admin_login
  call POST "/api/v1/nodes/$WORKER/drain?cluster=$CLUSTER_ID" "$ATOK"; expect 200 "start the drain of $WORKER"
  DRAIN_ID=$(jqb .drain_id)
  for _ in $(seq 1 20); do
    call GET "/api/v1/nodes/$WORKER/drain/status?cluster=$CLUSTER_ID&drain_id=$DRAIN_ID" "$ATOK"
    [ "$(jqb .status)" = draining ] && return 0
    sleep 1
  done
  stop "the drain of $WORKER is $(jqb .status), not draining"
}
cordoned() { kc get node "$WORKER" -o jsonpath='{.spec.unschedulable}'; }

# --- 6. the candidate chart, as the release workflow edits it, with the images of this checkout ---
build_images() {
  busy_guard
  [ -z "$(git -C "$ROOT" status --porcelain)" ] || [ "${ALLOW_DIRTY:-0}" = 1 ] || stop "the checkout has uncommitted changes (ALLOW_DIRTY=1 to build them anyway)"
  local entry name ctx df f t0
  for entry in "auth-service:services:auth-service-go/Dockerfile" "k8s-service:services:k8s-service-go/Dockerfile" \
               "session-service:services:session-service-go/Dockerfile" "tool-server:services:tool-server/Dockerfile" \
               "ai-service:services/ai-service:" "frontend:frontend:" "model-config-controller-go:services/model-config-controller-go:"; do
    IFS=: read -r name ctx df <<< "$entry"
    f=(); [ -n "$df" ] && f=(-f "$ROOT/$ctx/$df")
    t0=$(date +%s)
    # shellcheck disable=SC2086 # DOCKER_BUILD_ARGS is a list of words
    fg_run nice -n 10 docker build ${DOCKER_BUILD_ARGS:-} -t "kubeast/$name:$IMAGE_TAG" ${f[@]+"${f[@]}"} "$ROOT/$ctx" > "$OUT/build-$name.log" 2>&1 \
      || { tail -5 "$OUT/build-$name.log"; stop "build $name (build-$name.log)"; }
    say "built kubeast/$name:$IMAGE_TAG in $(( $(date +%s) - t0 ))s"
  done
}
prepare_candidate() {
  local name edit
  for name in $IMAGES; do
    docker image inspect "kubeast/$name:$IMAGE_TAG" > /dev/null 2>&1 || stop "no image kubeast/$name:$IMAGE_TAG (--build, or IMAGE_TAG=<tag of images built from this checkout>)"
  done
  rm -rf "$CHART"; cp -R "$ROOT/helm/kubeast" "$CHART"
  awk '/- name: Update Chart version/ {f = 1; next} f && /- name:/ {f = 0} f && /^[[:space:]]+sed -i / {sub(/^[[:space:]]+/, ""); print}' \
    "$ROOT/.github/workflows/release.yaml" > "$OUT/release-edits.txt"
  [ -s "$OUT/release-edits.txt" ] || stop "no sed line in the release workflow's Update Chart version step"
  grep -v 'helm/kubeast/' "$OUT/release-edits.txt" && stop "a release edit names a file outside helm/kubeast"
  while IFS= read -r edit; do
    edit=${edit//helm\/kubeast\//$CHART\/}
    edit="sed -i.bak${edit#sed -i}"
    # shellcheck disable=SC2034 # TAG is read by the workflow's line run through eval
    ( TAG=$RC_TAG; eval "$edit" ) || stop "release edit failed: $edit"
  done < "$OUT/release-edits.txt"
  rm -f "$CHART"/*.bak
  grep -q "^version: ${RC_TAG#v}\$" "$CHART/Chart.yaml" || stop "chart copy: version is not ${RC_TAG#v}"
  # local only: the images of this checkout (a published chart names ghcr.io and the release tag)
  sed -i.bak -e "s|^  imageTag: .*|  imageTag: \"$IMAGE_TAG\"|" -e "s|ghcr.io/junginho0901/kubeast-|kubeast/|" "$CHART/values.yaml" && rm -f "$CHART/values.yaml.bak"
  [ "$(grep -c '^  [a-zA-Z0-9]*: kubeast/' "$CHART/values.yaml")" = 7 ] || stop "chart copy: not seven kubeast/ images"
  for name in $IMAGES; do
    kind load docker-image "kubeast/$name:$IMAGE_TAG" --name "$CLUSTER" --nodes "$CP" > "$OUT/load-$name.log" 2>&1 \
      || { tail -3 "$OUT/load-$name.log"; stop "kind load kubeast/$name:$IMAGE_TAG"; }
  done
  info candidate "chart and images" "$(grep '^version:' "$CHART/Chart.yaml") · images kubeast/*:$IMAGE_TAG loaded into $CP"
}

# --- 7. the upgrade check stops what would keep FROM_VERSION's defaults ---
upgrade_values_checks() {
  local full out rc
  # a render that goes through holds the release's Secrets: kept in a variable, only its error lines are written
  full=$(hc upgrade kubeast "$CHART" --reuse-values --dry-run=client 2>&1); rc=$?
  out=$(printf '%s\n' "$full" | grep -E '^Error|execution error' | head -3); full=""
  printf '%s\n' "$out" > "$OUT/reuse-values.txt"
  if [ "$rc" != 0 ] && printf '%s' "$out" | grep -q -- '--reset-then-reuse-values'; then
    row upgrade "--reuse-values stops with the --reset-then-reuse-values hint" PASS "helm exit $rc"
  else
    row upgrade "--reuse-values stops with the --reset-then-reuse-values hint" FAIL "helm exit $rc: $out"
  fi
  full=$(hc upgrade kubeast "$CHART" -f "$OUT/values-copied-from.yaml" --dry-run=client 2>&1); rc=$?
  out=$(printf '%s\n' "$full" | grep -E '^Error|execution error' | head -3); full=""
  printf '%s\n' "$out" > "$OUT/copied-values.txt"
  if [ "$rc" != 0 ] && printf '%s' "$out" | grep -q -- '--reset-then-reuse-values\|chartVersion'; then
    row upgrade "a values file copied from $FROM_VERSION stops with the hint" PASS "helm exit $rc"
  else
    row upgrade "a values file copied from $FROM_VERSION stops with the hint" FAIL "helm exit $rc: $out"
  fi
  removed_value_checks upgrade
  db_connection_checks upgrade
  check upgrade "release left as it was by the dry runs" "kubeast-$FROM_VERSION 1" "$(hc list -o json | jq -r '.[] | select(.name == "kubeast") | "\(.chart) \(.revision)"')"
}

# render ARGS... — the candidate on the install's values with ARGS added, as the upgrade renders it: a client dry run
# of `helm upgrade --reset-then-reuse-values` (--plan: `helm template` of the checkout's chart on values-from.yaml).
# Sets RC, ERR (the error lines) and NOTES_SUM (the connection sum NOTES.txt prints for an external database); a
# render that goes through holds the release's Secrets, so the rest is not kept.
render() {
  local full
  if [ "$PLAN" = 1 ]; then
    full=$(helm template kubeast "$ROOT/helm/kubeast" -n "$NS" -f "$OUT/values-from.yaml" "$@" 2>&1); RC=$?
  else
    full=$(hc upgrade kubeast "$CHART" --reset-then-reuse-values "$@" --dry-run=client 2>&1); RC=$?
  fi
  ERR=$(printf '%s\n' "$full" | grep -E '^Error|execution error' | head -3)
  NOTES_SUM=$(printf '%s\n' "$full" | sed -n 's/.*can hold up to \([0-9][0-9]*\) connections.*/\1/p' | head -1)
  full=""
}

# removed_value_checks AREA — values that still set pdb.minAvailable stop the render with what replaces it. The message
# is read from the check template that lists the path ("pdb.minAvailable" "<instead>": #901's upgrade-values.yaml, or
# removed-values.yaml once #908 has moved it there).
removed_value_checks() {
  local a=$1 f src="" instead=""
  if ! in_checkout 901; then skip "$a" "values setting pdb.minAvailable stop" 901 "pdb.maxUnavailable not in the chart"; return; fi
  for f in "$ROOT"/helm/kubeast/templates/checks/*.yaml; do
    instead=$(sed -nE 's/.*"pdb\.minAvailable"[[:space:]]+"([^"]+)".*/\1/p' "$f" | head -1)
    [ -n "$instead" ] && { src=${f#"$ROOT/helm/kubeast/"}; break; }
  done
  if [ -z "$instead" ]; then
    row "$a" "values setting pdb.minAvailable stop" FAIL "no template in helm/kubeast/templates/checks lists pdb.minAvailable"
    return
  fi
  render --set pdb.minAvailable=1
  printf '%s\n' "$ERR" > "$OUT/pdb-minavailable.txt"
  if [ "$RC" != 0 ] && printf '%s' "$ERR" | grep -qF 'pdb.minAvailable' && printf '%s' "$ERR" | grep -qF -- "$instead"; then
    row "$a" "values setting pdb.minAvailable stop with what replaces it" PASS "helm exit $RC · message of $src: ${instead%% (*}"
  else
    row "$a" "values setting pdb.minAvailable stop with what replaces it" FAIL "helm exit $RC (want the message of $src): $ERR"
  fi
}

# db_connection_checks AREA — auth, session and ai at 4 replicas stop the render at the chart's PostgreSQL connection
# check (templates/checks/db-connections.yaml) with the sum it works out; at 3 they render. The numbers are the chart's:
# the sum from its message, the limit from postgresql.maxConnections. With an external database the chart does not
# stop and NOTES.txt prints the sum.
db_connection_checks() {
  local a=$1 k total max want set3=() set4=()
  if ! in_checkout 868; then skip "$a" "the connection sum stops a render past postgresql.maxConnections" 868 "checks/db-connections.yaml not in the chart"; return; fi
  for k in authService sessionService aiService; do set3+=(--set "replicas.$k=3"); set4+=(--set "replicas.$k=4"); done
  if [ "$SCENARIO" = external-db ] && [ "$PLAN" != 1 ]; then
    render "${set4[@]}"
    if [ "$RC" = 0 ] && [ -n "$NOTES_SUM" ]; then
      info "$a" "auth, session and ai at 4 replicas, external database" "renders; NOTES.txt: the pods can hold up to $NOTES_SUM connections"
    else
      row "$a" "auth, session and ai at 4 replicas render with an external database" FAIL "helm exit $RC, NOTES sum '${NOTES_SUM}': $ERR"
    fi
    return
  fi
  want=$(chart_value postgresql.maxConnections)
  render "${set4[@]}"
  printf '%s\n' "$ERR" > "$OUT/db-connections-4.txt"
  total=$(printf '%s' "$ERR" | sed -n 's/.*can hold up to \([0-9][0-9]*\) database connections.*/\1/p' | head -1)
  max=$(printf '%s' "$ERR" | sed -n 's/.*postgresql\.maxConnections=\([0-9][0-9]*\).*/\1/p' | head -1)
  if [ "$RC" != 0 ] && [ -n "$total" ] && [ -n "$max" ] && [ "$max" = "$want" ] && [ "$total" -gt "$max" ]; then
    row "$a" "auth, session and ai at 4 replicas stop at the connection sum" PASS "the pods can hold up to $total connections > postgresql.maxConnections $max"
  else
    row "$a" "auth, session and ai at 4 replicas stop at the connection sum" FAIL "helm exit $RC, sum '$total', limit '$max' (values.yaml $want): $ERR"
  fi
  render "${set3[@]}"
  if [ "$RC" = 0 ]; then
    row "$a" "auth, session and ai at 3 replicas render" PASS "helm exit 0"
    # the sum at 3, as the same check prints it once the limit is below it
    render "${set3[@]}" --set postgresql.maxConnections=20
    total=$(printf '%s' "$ERR" | sed -n 's/.*can hold up to \([0-9][0-9]*\) database connections.*/\1/p' | head -1)
    info "$a" "connection sum at 3 replicas of auth, session and ai" "${total:-not printed} (postgresql.maxConnections $want)"
  else
    row "$a" "auth, session and ai at 3 replicas render" FAIL "helm exit $RC: $ERR"
  fi
}

# --- 8. requests during an upgrade: every second, each target once, in parallel; a request with no answer after
# PROBE_TIMEOUT seconds is a hang. The bundled PostgreSQL and Redis pods are sampled every second beside them. Both
# loops end once the script is gone ($$ in a background subshell is the script's), also after a kill -9. ---
probe_loop() { # probe_loop FILE
  local file=$1 now tok_at=0 next_try=0 spec name path auth pw=""
  PTOK=""
  while kill -0 "$$" 2> /dev/null; do
    now=$(date +%s)
    # A new token every TOKEN_REFRESH seconds. With a token still in hand a sign-in gets 3 s and one that fails is
    # tried again 30 s later (5 s without one), so a slow or refused sign-in during the upgrade holds up the rounds
    # for a few seconds, not every second. The admin password stays in this loop's memory only.
    if [ "$now" -ge "$next_try" ] && { [ -z "$PTOK" ] || [ $((now - tok_at)) -ge "$TOKEN_REFRESH" ]; }; then
      [ -n "$pw" ] || pw=$(secret_key "$APP_SECRET" DEFAULT_ADMIN_PASSWORD 2>/dev/null)
      CALL_TIMEOUT=$PROBE_TIMEOUT; [ -n "$PTOK" ] && CALL_TIMEOUT=3
      login admin "$pw"
      if [ -n "$TOKEN" ]; then PTOK=$TOKEN; tok_at=$now
      elif [ -n "$PTOK" ]; then next_try=$((now + 30)); pw=""
      else next_try=$((now + 5)); pw=""; fi
    fi
    for spec in "gateway|/healthz|" "auth-jwks|/api/v1/auth/jwks.json|" "frontend|/|" \
                "k8s-list|/api/v1/cluster/namespaces/default/configmaps?cluster=$CLUSTER_ID|t" \
                "sessions|/api/v1/sessions?cluster=$CLUSTER_ID&limit=5|t" "auth-me|/api/v1/auth/me|t"; do
      IFS='|' read -r name path auth <<< "$spec"
      (
        tk=""; [ -n "$auth" ] && tk=$PTOK
        r=$(curl -s -o /dev/null -m "$PROBE_TIMEOUT" -w '%{http_code} %{time_total}' -H @<(hdr "$tk" "") "$GW$path"); rc=$?
        echo "$now $name ${r:-000 0} $rc" >> "$file"
      ) &
    done
    # the next round at the next second of the clock, so the rounds count the seconds
    while [ "$(date +%s)" = "$now" ]; do sleep 0.2; done
  done
}
pods_loop() { # pods_loop FILE — "<epoch> app=ready ..." for the bundled PostgreSQL and Redis
  while kill -0 "$$" 2> /dev/null; do
    echo "$(date +%s) $(kc -n "$NS" get pods -l 'app in (postgres,redis)' -o jsonpath='{range .items[*]}{.metadata.labels.app}={.status.containerStatuses[0].ready}{" "}{end}' 2>/dev/null)" >> "$1"
    sleep 1
  done
}
# probe_summary PHASE FILE PODSFILE SECONDS — rows per target; DB targets may fail while PostgreSQL is down. A target
# passes with no hang, no non-2xx outside that window, and requests sent in at least 80 % of the SECONDS the probes ran
# (a loop that stopped or stalled part way does not pass).
probe_summary() {
  python3 -I - "$2" "$3" "$PG_GRACE" "$PROBE_TIMEOUT" > "$OUT/$1-probe-summary.tsv" <<'EOF'
import sys
probe, pods, grace, timeout = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
db_targets = {"k8s-list", "sessions", "auth-me"}
down = []  # seconds where no postgres pod was ready
seen_pg = False
for line in open(pods):
    f = line.split()
    if not f:
        continue
    pg = [x for x in f[1:] if x.startswith("postgres=")]
    if pg:
        seen_pg = True
    if seen_pg and not any(x == "postgres=true" for x in pg):
        down.append(int(f[0]))
windows = []
for t in sorted(down):
    if windows and t - windows[-1][1] <= 2:
        windows[-1][1] = t
    else:
        windows.append([t, t])
def in_window(t):
    return any(a - 1 <= t <= b + grace for a, b in windows)
stats = {}
for line in open(probe):
    f = line.split()
    if len(f) < 5:
        continue
    t, name, code, took, rc = int(f[0]), f[1], f[2], float(f[3]), f[4]
    s = stats.setdefault(name, {"n": 0, "bad": 0, "expected": 0, "hang": 0, "max": 0.0, "codes": {}})
    s["n"] += 1
    s["max"] = max(s["max"], took)
    if rc == "28" or took >= timeout:
        s["hang"] += 1
    elif not code.startswith("2"):
        if name in db_targets and in_window(t):
            s["expected"] += 1
        else:
            s["bad"] += 1
            s["codes"][code] = s["codes"].get(code, 0) + 1
win = " ".join(f"{b - a + 1}s" for a, b in windows) or "none"
print(f"window\t{len(windows)}\t{win}")
for name in sorted(stats):
    s = stats[name]
    codes = ",".join(f"{c}x{n}" for c, n in sorted(s["codes"].items()))
    print(f"{name}\t{s['n']}\t{s['bad']}\t{s['expected']}\t{s['hang']}\t{s['max']:.2f}\t{codes}")
EOF
  local w name n bad exp hang mx codes secs=$4 min seen=" "
  min=$(( secs * 8 / 10 ))
  w=$(awk -F'\t' '$1 == "window" {print $2 " PostgreSQL down: " $3}' "$OUT/$1-probe-summary.tsv")
  info "$1" "bundled PostgreSQL restarts during the upgrade" "$w"
  while IFS=$'\t' read -r name n bad exp hang mx codes; do
    [ "$name" = window ] && continue
    seen="$seen$name "
    if [ "$bad" = 0 ] && [ "$hang" = 0 ] && [ "$n" -ge "$min" ]; then
      row "$1" "requests to $name answered" PASS "$n sent in ${secs}s · non-2xx $exp (in the PostgreSQL window) · hangs 0 · slowest ${mx}s"
    else
      row "$1" "requests to $name answered" FAIL "$n sent in ${secs}s (want $min or more) · non-2xx outside the window $bad ($codes) · in it $exp · hangs $hang · slowest ${mx}s"
    fi
  done < "$OUT/$1-probe-summary.tsv"
  for name in gateway auth-jwks frontend k8s-list sessions auth-me; do
    case "$seen" in *" $name "*) ;; *) row "$1" "requests to $name answered" FAIL "none sent in ${secs}s" ;; esac
  done
}

# upgrade_phase PHASE HELM_ARGS... — the upgrade with probes running; sets PHASE_T0
upgrade_phase() {
  local phase=$1; shift
  : > "$OUT/$phase-probe.txt"; : > "$OUT/$phase-pods.txt"
  local probe_t0 probe_secs
  probe_t0=$(date +%s)
  probe_loop "$OUT/$phase-probe.txt" & BG_PIDS="$BG_PIDS $!"
  pods_loop "$OUT/$phase-pods.txt" & BG_PIDS="$BG_PIDS $!"
  sleep 5
  kc -n "$NS" get pods -o wide > "$OUT/$phase-pods-before.txt"
  PHASE_T0=$(date +%s)
  say "$phase: helm upgrade $*"
  fg_run hc upgrade kubeast "$CHART" "$@" --wait --timeout 15m > "$OUT/$phase-helm.log" 2>&1
  local rc=$? d
  say "$phase: helm exit $rc after $(( $(date +%s) - PHASE_T0 ))s"
  if [ "$rc" != 0 ]; then
    tail -8 "$OUT/$phase-helm.log"; kc -n "$NS" get pods > "$OUT/$phase-pods-failed.txt" 2>&1
    stop_bg; row "$phase" "helm upgrade $*" FAIL "exit $rc ($phase-helm.log)"; stop "$phase: helm upgrade failed"
  fi
  for d in $(kc -n "$NS" get deploy -o jsonpath='{.items[*].metadata.name}'); do
    kc -n "$NS" rollout status "deploy/$d" --timeout=300s > /dev/null || { stop_bg; stop "$phase: deploy/$d did not roll out"; }
  done
  sleep 15
  probe_secs=$(( $(date +%s) - probe_t0 ))
  stop_bg
  sleep "$PROBE_TIMEOUT"
  kc -n "$NS" get pods -o wide > "$OUT/$phase-pods-after.txt"
  row "$phase" "helm upgrade $*" PASS "$(( $(date +%s) - PHASE_T0 ))s, revision $(hc list -o json | jq -r '.[] | select(.name == "kubeast") | .revision')"
  probe_summary "$phase" "$OUT/$phase-probe.txt" "$OUT/$phase-pods.txt" "$probe_secs"
}

# --- 9. pod settings after the upgrade ---
spec_checks() { # spec_checks PHASE
  local a=$1 pre json bad
  kc -n "$NS" get deploy,svc,pdb -o json > "$OUT/$a-objects.json"
  json="$OUT/$a-objects.json"
  bad=$(jq -r '[.items[] | select(.kind == "Deployment") | select((.spec.template.spec.containers[0].readinessProbe == null) or (.spec.template.spec.containers[0].livenessProbe == null)) | .metadata.name] | join(" ")' "$json")
  if [ -z "$bad" ]; then row "$a" "every Deployment has a readiness and a liveness probe" PASS "$(jq '[.items[] | select(.kind == "Deployment")] | length' "$json") Deployments"
  else row "$a" "every Deployment has a readiness and a liveness probe" FAIL "missing on: $bad"; fi
  if in_checkout 901; then
    bad=$(jq -r '[.items[] | select(.kind == "Deployment" and (.metadata.name | IN("auth-service", "k8s-service", "session-service"))) | .spec.template.spec.containers[0] | select(.readinessProbe.httpGet.path != "/readyz" or .livenessProbe.httpGet.path != "/livez") | .name] | join(" ")' "$json")
    none_bad "$a" "Go services: readiness /readyz, liveness /livez" "$bad" "auth-service k8s-service session-service" "other paths on:"
    bad=$(jq -r '[.items[] | select(.kind == "Deployment") | select(if (.metadata.name | IN("postgres", "redis")) then .spec.strategy.type != "Recreate" else (.spec.strategy.type != "RollingUpdate" or (.spec.strategy.rollingUpdate.maxUnavailable | tostring) != "0" or (.spec.strategy.rollingUpdate.maxSurge | tostring) != "1") end) | .metadata.name] | join(" ")' "$json")
    none_bad "$a" "rollouts: maxSurge 1 · maxUnavailable 0; PostgreSQL and Redis Recreate" "$bad" "every Deployment" "other strategy on:"
    bad=$(jq -r '[.items[] | select(.kind == "Deployment" and .spec.replicas > 1) | .metadata.name] as $many | [.items[] | select(.kind == "PodDisruptionBudget") | .spec.selector.matchLabels.app] as $pdb | ($many - $pdb) | join(" ")' "$json")
    none_bad "$a" "a PodDisruptionBudget for each Deployment past one replica" "$bad" "$(jq '[.items[] | select(.kind == "PodDisruptionBudget")] | length' "$json") PDBs" "none for:"
  else
    skip "$a" "probe paths, rollout strategy, PDB past one replica" 901 "pdb.maxUnavailable not in the chart"
  fi
  if in_checkout 856; then
    pre=$(value_of podShutdown.preStopSeconds)
    # every Deployment a Service selects, except the bundled PostgreSQL
    bad=$(jq -r --argjson s "${pre:-0}" '[.items[] | select(.kind == "Service" and .metadata.name != "postgres") | .spec.selector.app] as $apps
      | [.items[] | select(.kind == "Deployment" and (.spec.template.metadata.labels.app | IN($apps[]))) | .spec.template.spec as $p
         | select(($p.containers[0].lifecycle.preStop.sleep.seconds // 0) != $s or ($p.terminationGracePeriodSeconds // 30) < ($s + 30)) | .metadata.name] | join(" ")' "$json")
    none_bad "$a" "preStop sleep $pre s and grace ≥ $((pre + 30)) s behind each Service" "$bad" "every Deployment behind a Service but postgres" "not on:"
  else
    skip "$a" "preStop and grace period" 856 "podShutdown.preStopSeconds not in the chart"
  fi
}

# --- 10. Redis: one password or one user per service ---
redis_ping() { # redis_ping USER SECRET KEY — the first line of PING's answer as that user, the password through stdin
  local pw
  pw=$(secret_key "$2" "$3" 2>/dev/null)
  # shellcheck disable=SC2016 # expanded by the shell in the redis container
  printf '%s\n' "$pw" | kc -n "$NS" exec -i deploy/redis -c redis -- sh -c \
    'IFS= read -r p; if [ "$0" = default ]; then REDISCLI_AUTH="$p" redis-cli --no-auth-warning ping; else REDISCLI_AUTH="$p" redis-cli --no-auth-warning --user "$0" ping; fi' "$1" 2>&1 | head -1
  pw=""
}
redis_checks() { # redis_checks PHASE single|users USERS_SECRET
  local a=$1 want=$2 users=${3:-kubeast-redis-users} r n
  r=$(redis_ping default "$APP_SECRET" REDIS_PASSWORD)
  if [ "$want" = single ]; then
    check "$a" "Redis: one password (REDIS_PASSWORD answers PING)" PONG "$r"
  else
    if [ "$r" != PONG ]; then row "$a" "Redis: the default user is off" PASS "REDIS_PASSWORD gets '$r'"
    else row "$a" "Redis: the default user is off" FAIL "REDIS_PASSWORD still answers PONG"; fi
    check "$a" "Redis: user probe answers PING (key in $users)" PONG "$(redis_ping probe "$users" REDIS_PROBE_PASSWORD)"
  fi
  n=$(kc -n "$NS" logs deploy/k8s-service --since=10m 2>/dev/null | grep -ciE 'WRONGPASS|NOAUTH|NOPERM')
  check "$a" "k8s-service logs no Redis refusal (10 min)" 0 "${n:-0}"
  n=$(kc -n "$NS" logs deploy/tool-server --since=10m 2>/dev/null | grep -ciE 'WRONGPASS|NOAUTH|NOPERM')
  check "$a" "tool-server logs no Redis refusal (10 min)" 0 "${n:-0}"
}

# --- main ---
case "${1:-}" in
  --delete)
    [ -n "${REH_OUT:-}" ] || { echo "REH_OUT=<the run's folder> scripts/upgrade-rehearsal.sh --delete"; exit 2; }
    delete_cluster && echo "deleted $CLUSTER"; exit $? ;;
  --build|--plan|"") ;;
  *) awk 'NR > 1 && /^#/ {sub(/^# ?/, ""); print; next} NR > 1 {exit}' "$0"; exit 2 ;;
esac
case "$SCENARIO" in default|existing-secret|external-db) ;; *) stop "SCENARIO is default, existing-secret or external-db" ;; esac
case "$REPLICAS" in 1|2|3) ;; *) stop "REPLICAS is 1, 2 or 3" ;; esac
require_names
begin_output
chart_values
if [ "$PLAN" = 1 ]; then
  say "upgrade rehearsal plan: checkout $HEAD8, out $OUT"
  plan
  COMPLETE=1
  exit 0
fi
require_held
say "upgrade rehearsal: scenario $SCENARIO, $FROM_VERSION -> $HEAD8 (chart ${RC_TAG#v}, images $IMAGE_TAG), out $OUT"
[ "${1:-}" = --build ] && build_images

make_cluster
[ "$SCENARIO" = external-db ] && make_external_db
install_from
seed
FROM_DB=$(db_version)
snapshot before
live_checks before
if [ "$(awk -F'\t' '$1 == "before" && $3 == "FAIL"' "$RES" | wc -l | tr -d ' ')" != 0 ]; then stop "checks failed on $FROM_VERSION itself — fix the data before upgrading"; fi
PG_UID_BEFORE=$(kc -n "$NS" get pods -l app=postgres -o jsonpath='{.items[0].metadata.uid}' 2>/dev/null)
make_blocker
prepare_candidate
upgrade_values_checks

# A: FROM_VERSION -> candidate, a drain of the worker running meanwhile
start_drain; DRAIN_A=$DRAIN_ID; DRAIN_A_T=$(date +%s)
info A "drain started on $FROM_VERSION" "$WORKER draining, held by the PodDisruptionBudget of $DRAIN_NS/drain-blocker"
upgrade_phase A --reset-then-reuse-values
WANT_DB=$((10#$(newest_migration)))
check A "migrations reach the newest file ($FROM_DB → $WANT_DB)" "$WANT_DB" "$(db_version)"
kc -n "$NS" logs deploy/auth-service --since=30m 2>/dev/null | grep -i 'dbmigrate\|migrat' | cut -c1-300 > "$OUT/A-migrations.log"
info A "auth-service migration lines" "$(wc -l < "$OUT/A-migrations.log" | tr -d ' ') (A-migrations.log)"
check A "every Kubeast image is $IMAGE_TAG" 7 "$(kc -n "$NS" get deploy -o json | jq "[.items[].spec.template.spec.containers[0].image | select(endswith(\":$IMAGE_TAG\"))] | length")"
if [ "$SCENARIO" != external-db ]; then
  PG_UID_AFTER=$(kc -n "$NS" get pods -l app=postgres -o jsonpath='{.items[0].metadata.uid}' 2>/dev/null)
  if in_checkout 868; then
    if [ "$PG_UID_BEFORE" != "$PG_UID_AFTER" ]; then
      row A "bundled PostgreSQL restarted once (#868)" PASS "new pod, restarts $(kc -n "$NS" get pods -l app=postgres -o jsonpath='{.items[0].status.containerStatuses[0].restartCount}')"
    else
      row A "bundled PostgreSQL restarted once (#868)" FAIL "same pod as before the upgrade"
    fi
    check A "PostgreSQL max_connections = postgresql.maxConnections" "$(value_of postgresql.maxConnections)" "$(psql_q 'SHOW max_connections')"
  else
    skip A "bundled PostgreSQL restart and max_connections" 868 "postgresql.maxConnections not in the chart"
  fi
else
  n=$(kc -n "$DB_NS" logs deploy/pgbouncer --since=30m 2>/dev/null | grep -ci 'unsupported startup parameter')
  [ "$POOLER" = 1 ] && check A "PgBouncer refused no startup parameter" 0 "${n:-0}"
fi
snapshot after
compare_snapshots
live_checks after
role_checks
admin_login
call GET "/api/v1/nodes/$WORKER/drain/status?cluster=$CLUSTER_ID&drain_id=$DRAIN_A" "$ATOK"
if [ $(( PHASE_T0 - DRAIN_A_T )) -lt 240 ]; then
  info A "the $FROM_VERSION drain after the upgrade" "status HTTP $CODE $(jqb '.status // .detail // empty') · $WORKER unschedulable=$(cordoned) (its progress was in the replaced pod's memory)"
else
  warn "the drain had run $(( PHASE_T0 - DRAIN_A_T ))s before the upgrade began"
  info A "the $FROM_VERSION drain after the upgrade" "not in flight at the replacement (started $(( PHASE_T0 - DRAIN_A_T ))s before)"
fi
spec_checks A
if in_checkout 866; then
  if [ "$SCENARIO" = existing-secret ]; then redis_checks A single; else redis_checks A users; fi
else
  skip A "Redis users" 866 "redis.acl not in the chart"
fi

# existing-secret: the Redis users' keys added to the app Secret, then from a Secret of their own
if [ "$SCENARIO" = existing-secret ] && in_checkout 866; then
  (
    P1=$(openssl rand -hex 24); P2=$(openssl rand -hex 24); P3=$(openssl rand -hex 24); export P1 P2 P3
    kc -n "$NS" get secret "$APP_SECRET" -o json \
      | jq 'del(.metadata.managedFields) | .data.REDIS_K8S_SERVICE_PASSWORD = (env.P1 | @base64) | .data.REDIS_PROBE_PASSWORD = (env.P2 | @base64) | .data.REDIS_TOOL_SERVER_PASSWORD = (env.P3 | @base64)' \
      | kc replace -f - > /dev/null
  ) || stop "add the Redis users' keys to $APP_SECRET"
  upgrade_phase R2 --reset-then-reuse-values --set redis.acl.existingSecretHasKeys=true
  redis_checks R2 users "$APP_SECRET"
  kc -n "$NS" get secret "$APP_SECRET" -o json \
    | jq --arg ns "$NS" '{apiVersion: "v1", kind: "Secret", metadata: {name: "rh-redis-users", namespace: $ns}, type: "Opaque",
                         data: (.data | {REDIS_K8S_SERVICE_PASSWORD, REDIS_PROBE_PASSWORD, REDIS_TOOL_SERVER_PASSWORD})}' \
    | kc create -f - > /dev/null || stop "Secret rh-redis-users"
  upgrade_phase R3 --reset-then-reuse-values --set redis.acl.existingSecret=rh-redis-users
  redis_checks R3 users rh-redis-users
  check R3 "the chart makes no kubeast-redis-users" 0 "$(kc -n "$NS" get secret kubeast-redis-users --no-headers 2>/dev/null | wc -l | tr -d ' ')"
fi

# B: candidate -> candidate with one value changed, a drain running on the candidate meanwhile
if in_checkout 856; then
  if in_checkout 858; then
    start_drain; DRAIN_B=$DRAIN_ID
    upgrade_phase B --reset-then-reuse-values --set podShutdown.preStopSeconds=$(( $(value_of podShutdown.preStopSeconds) + 1 ))
    admin_login
    # A status check, not a timing: it is read from the end of phase B (rollout done, 15 s, PROBE_TIMEOUT), up to 45
    # times 2 s apart, and the row gives the seconds since phase B's helm upgrade began; when the server running the
    # drain was replaced is not measured.
    st=""
    for _ in $(seq 1 45); do
      call GET "/api/v1/nodes/$WORKER/drain/status?cluster=$CLUSTER_ID&drain_id=$DRAIN_B" "$ATOK"
      st=$(jqb .status); [ "$st" = interrupted ] && break
      sleep 2
    done
    if [ "$st" = interrupted ]; then
      row B "a drain whose server was replaced reads interrupted (#858)" PASS "interrupted, read $(( $(date +%s) - PHASE_T0 ))s after phase B's helm upgrade began"
    else
      row B "a drain whose server was replaced reads interrupted (#858)" FAIL "want interrupted, got '$st' ($(( $(date +%s) - PHASE_T0 ))s after phase B's helm upgrade began)"
    fi
    check B "its answer names $WORKER as still cordoned" yes "$(jqb "(.cordoned_nodes // []) | if any(.[]; . == \"$WORKER\") then \"yes\" else \"no\" end")"
  else
    skip B "drain interrupted" 858 "no migration makes the table node_drains"
    upgrade_phase B --reset-then-reuse-values --set podShutdown.preStopSeconds=$(( $(value_of podShutdown.preStopSeconds) + 1 ))
  fi
  check B "migrations unchanged by the second upgrade" "$WANT_DB" "$(db_version)"
  spec_checks B
else
  skip B "second upgrade to the same chart" 856 "podShutdown.preStopSeconds not in the chart"
fi

# C: more than one replica of every service
if [ "$REPLICAS" -gt 1 ] && ! in_checkout 867; then
  skip C "$REPLICAS replicas" 867 "autoscaling not in the chart (the chart refuses k8s-service past 1 without it)"
elif [ "$REPLICAS" -gt 1 ]; then
  set_args=()
  for k in authService aiService k8sService sessionService frontend toolServer gateway; do set_args+=(--set "replicas.$k=$REPLICAS"); done
  upgrade_phase C --reset-then-reuse-values "${set_args[@]}"
  check C "k8s-service runs $REPLICAS ready pods" "$REPLICAS" "$(kc -n "$NS" get deploy k8s-service -o jsonpath='{.status.readyReplicas}')"
  check C "tool-server runs $REPLICAS ready pods" "$REPLICAS" "$(kc -n "$NS" get deploy tool-server -o jsonpath='{.status.readyReplicas}')"
  spec_checks C
  admin_login
  ok=0
  for _ in $(seq 1 30); do call GET "/api/v1/cluster/namespaces/default/configmaps?cluster=$CLUSTER_ID" "$ATOK"; [ "$CODE" = 200 ] && ok=$((ok + 1)); done
  check C "30 list requests across the replicas answer 200" 30 "$ok"
  live_checks C
fi
COMPLETE=1
say "end of the rehearsal"
