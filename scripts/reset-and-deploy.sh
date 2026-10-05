#!/usr/bin/env bash
#
# reset-and-deploy.sh — start the local kind install over.
#
#   scripts/reset-and-deploy.sh          # delete the kind cluster, recreate, build, install (fresh everything)
#   scripts/reset-and-deploy.sh --keep   # keep the cluster: uninstall the release, drop the database volume,
#                                        #   rebuild the images, install again (secrets are kept, so the
#                                        #   admin password stays)
#   scripts/reset-and-deploy.sh --db     # keep everything, empty the database tables and the registered
#                                        #   clusters, restart the services (no build)
#
# The install itself is scripts/kind-deploy.sh (the Helm chart + deploy/kind/values.yaml).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-kubeast}"
NAMESPACE="${NAMESPACE:-kubeast}"
RELEASE="${RELEASE:-kubeast}"
KIND_HOST_PORT="${KIND_HOST_PORT:-30080}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"
export KUBECONFIG="$KUBECONFIG_PATH"
export KIND_CLUSTER_NAME NAMESPACE RELEASE KIND_HOST_PORT KUBECONFIG_PATH

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'
step() { echo -e "\n${CYAN}═══ $1 ═══${NC}"; }
ok()   { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

MODE="${1:-full}"

wait_for_auth() {
  step "Waiting for auth-service"
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${KIND_HOST_PORT}/api/v1/auth/setup" 2>/dev/null || echo 000)
    [[ "$code" == "200" ]] && { ok "auth-service ready (HTTP $code)"; return 0; }
    sleep 2
  done
  warn "auth-service not ready after 2 minutes (last HTTP $code)"
}

print_accounts() {
  echo ""
  echo "  URL:   http://localhost:${KIND_HOST_PORT}"
  echo "  admin: kubectl -n ${NAMESPACE} get secret kubeast-secrets -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' | base64 -d"
  echo "  demo:  read / read · write / write"
  echo ""
}

case "$MODE" in
  full)
    step "Full reset — deleting kind cluster '${KIND_CLUSTER_NAME}'"
    if kind get clusters 2>/dev/null | grep -x "$KIND_CLUSTER_NAME" >/dev/null; then
      kind delete cluster --name "$KIND_CLUSTER_NAME"
      ok "cluster deleted"
    else
      warn "no cluster named ${KIND_CLUSTER_NAME}"
    fi
    "$ROOT/scripts/kind-deploy.sh"
    wait_for_auth
    print_accounts
    ;;

  --keep)
    step "Keep the cluster — uninstall the release and drop the database volume"
    kubectl cluster-info --request-timeout=10s >/dev/null 2>&1 || fail "cannot reach the cluster at ${KUBECONFIG_PATH}"
    helm uninstall "$RELEASE" -n "$NAMESPACE" --wait 2>/dev/null && ok "release uninstalled (kubeast-secrets and the signing keys are kept)" || warn "no release to uninstall"
    kubectl -n "$NAMESPACE" delete pvc kubeast-postgres-data --ignore-not-found --wait=true && ok "database volume dropped"
    kubectl -n "$NAMESPACE" get secrets -o name 2>/dev/null | grep -E "cluster-kubeconfig-" | xargs -r kubectl -n "$NAMESPACE" delete 2>/dev/null || true
    "$ROOT/scripts/kind-deploy.sh"
    wait_for_auth
    print_accounts
    ;;

  --db)
    step "Database-only reset (no build)"
    kubectl cluster-info --request-timeout=10s >/dev/null 2>&1 || fail "cannot reach the cluster at ${KUBECONFIG_PATH}"
    PG_POD=$(kubectl -n "$NAMESPACE" get pod -l app=postgres -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    [[ -n "$PG_POD" ]] || fail "postgres pod not found in ${NAMESPACE}"
    kubectl -n "$NAMESPACE" scale deploy/auth-service deploy/ai-service deploy/k8s-service deploy/session-service deploy/tool-server --replicas=0 >/dev/null
    # Every table with application state, children first (FKs); roles and the schema stay.
    kubectl -n "$NAMESPACE" exec "$PG_POD" -- psql -U kubeast -d kubeast -v ON_ERROR_STOP=0 -c "
      DELETE FROM session_contexts; DELETE FROM messages; DELETE FROM sessions; DELETE FROM tool_approvals;
      DELETE FROM model_configs; DELETE FROM access_requests; DELETE FROM user_cluster_roles;
      DELETE FROM auth_audit_logs; DELETE FROM auth_users; DELETE FROM organizations;
      DELETE FROM clusters; DELETE FROM cluster_setup;
    " >/dev/null 2>&1 || warn "some tables may not exist yet"
    ok "tables emptied"
    kubectl -n "$NAMESPACE" get secrets -o name 2>/dev/null | grep -E "cluster-kubeconfig-" | xargs -r kubectl -n "$NAMESPACE" delete 2>/dev/null || true
    ok "registered-cluster kubeconfigs removed"
    kubectl -n "$NAMESPACE" scale deploy/auth-service deploy/ai-service deploy/k8s-service deploy/session-service deploy/tool-server --replicas=1 >/dev/null
    kubectl -n "$NAMESPACE" rollout status deploy/auth-service --timeout=180s >/dev/null 2>&1 || warn "auth-service rollout slow"
    wait_for_auth
    print_accounts
    ;;

  *)
    echo "usage: $0 [--keep|--db]" >&2; exit 1 ;;
esac
