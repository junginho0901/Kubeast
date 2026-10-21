#!/usr/bin/env bash
# Node values from OpenTelemetry hostmetrics on kind (deploy/kind/hostmetrics-collector.yaml): a collector on
# the first cluster (kubeast, Kubeast id "self", which has no node-exporter) writes system_* series with
# cluster="kubeast" and k8s_node_name to the second cluster's Prometheus (remote write, NodePort 30090).
# e2e/tests/node-hostmetrics.spec.ts points cluster self at that Prometheus and reads them.
#
#   scripts/kind-hostmetrics.sh up
#   scripts/kind-hostmetrics.sh down
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"
MAIN="${KIND_CLUSTER_NAME:-kubeast}"
STORE="${HOSTMETRICS_STORE_CLUSTER:-kubeast-b}"
COLLECTOR_IMAGE="otel/opentelemetry-collector-contrib:0.163.1"

main_kubectl() { kubectl --kubeconfig "$KUBECONFIG_PATH" --context "kind-$MAIN" "$@"; }
store_kubectl() { kubectl --kubeconfig <(kind get kubeconfig --name "$STORE") "$@"; }

import_image() {
  docker exec "$1-control-plane" crictl pull "docker.io/$2" >/dev/null 2>&1 && return
  docker image inspect "$2" >/dev/null 2>&1 || docker pull -q "$2" >/dev/null
  docker save "$2" | docker exec --privileged -i "$1-control-plane" \
    ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
}

case "${1:-}" in
  up)
    echo "═══ $STORE Prometheus takes remote write ═══"
    if ! store_kubectl -n monitoring get deploy prometheus -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q enable-remote-write-receiver; then
      store_kubectl apply -f "$ROOT/deploy/kind/second-cluster.yaml" >/dev/null
      store_kubectl -n monitoring rollout status deploy/prometheus --timeout=180s
    fi
    echo "═══ collector in $MAIN ═══"
    import_image "$MAIN" "$COLLECTOR_IMAGE"
    sed -e "s|CLUSTER_NAME|$MAIN|" -e "s|STORE_WRITE|http://$STORE-control-plane:30090/api/v1/write|" \
      "$ROOT/deploy/kind/hostmetrics-collector.yaml" | main_kubectl apply -f -
    main_kubectl -n hostmetrics rollout status ds/hostmetrics --timeout=120s
    ;;
  down)
    main_kubectl delete namespace hostmetrics --ignore-not-found
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
