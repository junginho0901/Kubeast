#!/usr/bin/env bash
# The build to compare with, beside the dev install on kind (safety net e2e/guard/response-diff.spec.ts): the services
# again as <name>-before Deployments in the same namespace, with the same Secrets, ConfigMap and database and only the
# images changed. The old services call each other through hostAliases, because some of their addresses are in the code
# (ai-service's K8S_SERVICE_URL) and nginx resolves its upstreams through /etc/hosts.
#
#   scripts/before-stack.sh up v0.7.5     # ghcr.io/junginho0901/kubeast-<service>:v0.7.5 (a released tag)
#   scripts/before-stack.sh up local      # the images the dev install runs, to see a comparison of a build with itself
#   scripts/before-stack.sh status
#   scripts/before-stack.sh down          # run the usual e2e only after this: it counts what the namespace holds
#
# The gateway of the old build answers on http://localhost:$BEFORE_PORT (kubectl port-forward; kind maps no new port).
# Both builds on one database is the state of a rolling upgrade, so the old background jobs are as safe as during one.
# Two things differ from a replica: MIGRATIONS_MODE=job (the old build never migrates; it waits for the version it
# needs) and auth-service's seeding of the system roles at start, which the new auth-service puts back by restarting.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTX="${KUBE_CONTEXT:-kind-kubeast}"
NS="kubeast"
PORT="${BEFORE_PORT:-30081}"
REDIS_DB_BEFORE="${BEFORE_REDIS_DB:-7}"
REGISTRY="${BEFORE_REGISTRY:-ghcr.io/junginho0901/kubeast-}"
PIDFILE="${TMPDIR:-/tmp}/kubeast-before-stack.pid"
LABEL="kubeast.io/before-stack"
export KUBECONFIG="${KUBECONFIG:-$ROOT/.kubeconfig-kind}"

case "$CTX" in
  kind-*) ;;
  *) echo "before-stack: $CTX is not a kind context; this script only runs on a kind cluster" >&2; exit 1 ;;
esac
kc() { kubectl --context "$CTX" -n "$NS" "$@"; }

stop_forward() {
  [ -f "$PIDFILE" ] || return 0
  local pid
  pid="$(cat "$PIDFILE")"
  if ps -p "$pid" -o command= 2>/dev/null | grep -q 'port-forward svc/gateway-before'; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
}

start_forward() {
  stop_forward
  nohup kubectl --context "$CTX" -n "$NS" port-forward svc/gateway-before "$PORT:8000" >/dev/null 2>&1 &
  echo $! >"$PIDFILE"
  for _ in $(seq 1 30); do
    if curl -sf -o /dev/null "http://localhost:$PORT/api/v1/auth/jwks.json"; then
      return 0
    fi
    sleep 1
  done
  echo "before-stack: http://localhost:$PORT does not answer" >&2
  return 1
}

reseed() {
  kc rollout restart deployment/auth-service >/dev/null
  kc rollout status deployment/auth-service --timeout=180s >/dev/null
}

up() {
  local tag="$1"
  KC_NS="$NS" BEFORE_TAG="$tag" BEFORE_REGISTRY="$REGISTRY" BEFORE_REDIS_DB="$REDIS_DB_BEFORE" BEFORE_LABEL="$LABEL" \
    KC_CONTEXT="$CTX" python3 "$ROOT/scripts/before-stack-manifests.py" | kubectl --context "$CTX" apply -f -
  for d in auth-service k8s-service session-service ai-service frontend gateway; do
    kc rollout status "deployment/$d-before" --timeout=600s
  done
  reseed
  start_forward
  echo "the build to compare with: $tag on http://localhost:$PORT"
  echo "export E2E_BEFORE_URL=http://localhost:$PORT"
}

down() {
  stop_forward
  kc delete deployment,service,networkpolicy -l "$LABEL=true" --ignore-not-found
  reseed
}

status() {
  kc get deployment -l "$LABEL=true" -o custom-columns='NAME:.metadata.name,READY:.status.readyReplicas,IMAGE:.spec.template.spec.containers[0].image'
  if [ -f "$PIDFILE" ] && curl -sf -o /dev/null "http://localhost:$PORT/api/v1/auth/jwks.json"; then
    echo "answers on http://localhost:$PORT"
  else
    echo "no answer on http://localhost:$PORT"
  fi
}

case "${1:-}" in
  up)
    [ -n "${2:-}" ] || { echo "usage: $0 up <tag|local>" >&2; exit 2; }
    up "$2"
    ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up <tag|local> | status | down" >&2; exit 2 ;;
esac
