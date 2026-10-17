#!/usr/bin/env bash
# Grafana on kind (deploy/kind/grafana.yaml): one Grafana in the second cluster (kubeast-b) with that
# cluster's Prometheus and the log-search Loki as data sources, and a Viewer service account whose token
# is kept in the Secret grafana/kubeast-reader there — what Kubeast needs to read the stores through
# Grafana's data source proxy. e2e/tests/grafana.spec.ts runs against this.
#
#   scripts/kind-grafana.sh up     # again after the Grafana pod restarts (its database is an emptyDir)
#   scripts/kind-grafana.sh down
#
# Nothing is printed of the admin password or the token.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${GRAFANA_CLUSTER:-kubeast-b}"
IMAGE="grafana/grafana:13.2.4"

store_kubectl() { kubectl --kubeconfig <(kind get kubeconfig --name "$STORE") "$@"; }

import_image() {
  docker exec "$1-control-plane" crictl pull "docker.io/$2" >/dev/null 2>&1 && return
  docker image inspect "$2" >/dev/null 2>&1 || docker pull -q "$2" >/dev/null
  docker save "$2" | docker exec --privileged -i "$1-control-plane" \
    ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
}

# grafana_api <curl args…> — as admin from inside the pod; the credentials go in on stdin.
grafana_api() {
  local pw
  pw="$(store_kubectl -n grafana get secret grafana-admin -o jsonpath='{.data.password}' | base64 -d)"
  printf 'user = "admin:%s"\n' "$pw" | store_kubectl -n grafana exec -i deploy/grafana -- \
    curl -sf -K - -H 'Content-Type: application/json' "$@"
}

# token_works — the stored token reads Prometheus through the proxy.
token_works() {
  local token
  token="$(store_kubectl -n grafana get secret kubeast-reader -o jsonpath='{.data.token}' 2>/dev/null | base64 -d)" || return 1
  [ -n "$token" ] || return 1
  printf 'header = "Authorization: Bearer %s"\n' "$token" | store_kubectl -n grafana exec -i deploy/grafana -- \
    curl -sf -o /dev/null -K - 'http://localhost:3000/api/datasources/proxy/uid/prometheus/api/v1/query?query=1'
}

case "${1:-}" in
  up)
    echo "═══ image ═══"
    import_image "$STORE" "$IMAGE"
    echo "═══ Grafana in $STORE ═══"
    store_kubectl create namespace grafana --dry-run=client -o yaml | store_kubectl apply -f - >/dev/null
    store_kubectl -n grafana get secret grafana-admin >/dev/null 2>&1 \
      || openssl rand -hex 16 | tr -d '\n' | store_kubectl -n grafana create secret generic grafana-admin --from-file=password=/dev/stdin >/dev/null
    store_kubectl apply -f "$ROOT/deploy/kind/grafana.yaml"
    store_kubectl -n grafana rollout status deploy/grafana --timeout=180s
    echo "═══ service account kubeast-reader (Viewer) ═══"
    if token_works; then
      echo "token in grafana/kubeast-reader still works"
    else
      id="$(grafana_api 'http://localhost:3000/api/serviceaccounts/search?query=kubeast-reader' | jq -r '.serviceAccounts[] | select(.name == "kubeast-reader") | .id')"
      [ -n "$id" ] || id="$(grafana_api -X POST --data '{"name":"kubeast-reader","role":"Viewer"}' http://localhost:3000/api/serviceaccounts | jq -r .id)"
      grafana_api -X POST --data "{\"name\":\"kubeast-$(date +%s)\"}" "http://localhost:3000/api/serviceaccounts/$id/tokens" | jq -j .key \
        | store_kubectl -n grafana create secret generic kubeast-reader --from-file=token=/dev/stdin --dry-run=client -o yaml \
        | store_kubectl apply -f - >/dev/null
      token_works && echo "new token stored in grafana/kubeast-reader"
    fi
    ;;
  down)
    store_kubectl delete namespace grafana --ignore-not-found
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
