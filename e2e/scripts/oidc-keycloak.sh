#!/usr/bin/env bash
# OIDC sign-in through a real Keycloak (the version the company Keycloak runs) for oidc-keycloak.spec.ts: a
# container on the host with the realm in deploy/kind/keycloak-realm.json, and Kubeast pointed at it with
# deploy/kind/keycloak-oidc-values.yaml (helm values; the client secret goes into the Secret kubeast-oidc-keycloak).
#
#   e2e/scripts/oidc-keycloak.sh up
#   e2e/scripts/oidc-keycloak.sh down    # OIDC off again, the container removed
#
# auth-service (in kind) and the browser both reach Keycloak as host.docker.internal:8180, so the issuer is one
# string on both sides: the spec maps that name to 127.0.0.1 in Chromium; to sign in from your own browser, let
# Docker Desktop add the *.docker.internal names to /etc/hosts (Settings → General).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"
MAIN="${KIND_CLUSTER_NAME:-kubeast}"
NAMESPACE="${NAMESPACE:-kubeast}"
RELEASE="${RELEASE:-kubeast}"
BASE_URL="${E2E_BASE_URL:-http://localhost:30080}"
IMAGE="quay.io/keycloak/keycloak:26.8.1"
NAME="kubeast-keycloak"
SECRET="kubeast-oidc-keycloak"
REALM_FILE="$ROOT/deploy/kind/keycloak-realm.json"

main_kubectl() { kubectl --kubeconfig "$KUBECONFIG_PATH" --context "kind-$MAIN" -n "$NAMESPACE" "$@"; }
upgrade() { helm --kubeconfig "$KUBECONFIG_PATH" --kube-context "kind-$MAIN" -n "$NAMESPACE" upgrade "$RELEASE" "$ROOT/helm/kubeast" --reset-then-reuse-values "$@" --wait --timeout 5m | grep -E "REVISION|STATUS"; }

case "${1:-}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p 8180:8080 \
      -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=kubeast-dev \
      -v "$REALM_FILE:/opt/keycloak/data/import/kubeast-realm.json:ro" \
      "$IMAGE" start-dev --import-realm --hostname=http://host.docker.internal:8180 >/dev/null
    for _ in $(seq 1 90); do
      curl -fs http://localhost:8180/realms/kubeast/.well-known/openid-configuration >/dev/null && break
      sleep 2
    done
    curl -fs http://localhost:8180/realms/kubeast/.well-known/openid-configuration | jq -r '"issuer: " + .issuer'
    jq -j '.clients[] | select(.clientId == "kubeast") | .secret' "$REALM_FILE" \
      | main_kubectl create secret generic "$SECRET" --from-file=client_secret=/dev/stdin --dry-run=client -o yaml \
      | main_kubectl apply -f - >/dev/null
    upgrade -f "$ROOT/deploy/kind/keycloak-oidc-values.yaml"
    curl -fs "$BASE_URL/api/v1/auth/oidc/config" | jq -c .
    ;;
  down)
    upgrade --set auth.oidc.enabled=false
    main_kubectl delete secret "$SECRET" --ignore-not-found >/dev/null
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
