#!/usr/bin/env bash
# Log search on kind (features.logSearch): one Loki in the second cluster (kubeast-b, Kubeast id
# "default") and an OpenTelemetry Collector in each cluster sending its container logs there over OTLP —
# a central store for several clusters, like a company Loki — then Kubeast pointed at it with
# deploy/kind/logsearch-values.yaml. e2e/tests/log-search.spec.ts runs against this.
#
#   scripts/kind-logsearch.sh up
#   scripts/kind-logsearch.sh down   # Kubeast back to log search off; Loki and the collectors removed
#
# A node that cannot pull an image (a proxy) gets it from the host's docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"
MAIN="${KIND_CLUSTER_NAME:-kubeast}"
STORE="${LOGSEARCH_STORE_CLUSTER:-kubeast-b}"
NAMESPACE="${NAMESPACE:-kubeast}"
RELEASE="${RELEASE:-kubeast}"
LOKI_IMAGE="grafana/loki:3.7.9"
COLLECTOR_IMAGE="otel/opentelemetry-collector-contrib:0.163.1"

main_kubectl() { kubectl --kubeconfig "$KUBECONFIG_PATH" --context "kind-$MAIN" "$@"; }
store_kubectl() { kubectl --kubeconfig <(kind get kubeconfig --name "$STORE") "$@"; }

# The node pulls the image itself; where it cannot (a proxy), it is imported from the host's docker.
import_image() {
  docker exec "$1-control-plane" crictl pull "docker.io/$2" >/dev/null 2>&1 && return
  docker image inspect "$2" >/dev/null 2>&1 || docker pull -q "$2" >/dev/null
  docker save "$2" | docker exec --privileged -i "$1-control-plane" \
    ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
}

# collector_manifest <k8s.cluster.name> <OTLP endpoint>
collector_manifest() {
  sed -e "s|CLUSTER_NAME|$1|" -e "s|LOKI_OTLP|$2|" "$ROOT/deploy/kind/logsearch-collector.yaml"
}

case "${1:-}" in
  up)
    echo "═══ images ═══"
    import_image "$STORE" "$LOKI_IMAGE"
    import_image "$STORE" "$COLLECTOR_IMAGE"
    import_image "$MAIN" "$COLLECTOR_IMAGE"
    echo "═══ Loki in $STORE ═══"
    store_kubectl apply -f "$ROOT/deploy/kind/logsearch-loki.yaml"
    store_kubectl -n loki rollout status deploy/loki --timeout=180s
    echo "═══ collectors ═══"
    collector_manifest "$STORE" "http://loki.loki.svc:3100/otlp" | store_kubectl apply -f -
    collector_manifest "$MAIN" "http://$STORE-control-plane:31100/otlp" | main_kubectl apply -f -
    store_kubectl -n otel rollout status ds/otel-collector --timeout=120s
    main_kubectl -n otel rollout status ds/otel-collector --timeout=120s
    echo "═══ Kubeast: features.logSearch on ═══"
    helm --kubeconfig "$KUBECONFIG_PATH" --kube-context "kind-$MAIN" -n "$NAMESPACE" upgrade "$RELEASE" "$ROOT/helm/kubeast" \
      --reset-then-reuse-values -f "$ROOT/deploy/kind/logsearch-values.yaml" --wait --timeout 5m | grep -E "REVISION|STATUS"
    ;;
  down)
    helm --kubeconfig "$KUBECONFIG_PATH" --kube-context "kind-$MAIN" -n "$NAMESPACE" upgrade "$RELEASE" "$ROOT/helm/kubeast" \
      --reset-then-reuse-values --set features.logSearch.enabled=false --wait --timeout 5m | grep -E "REVISION|STATUS"
    main_kubectl delete namespace otel --ignore-not-found
    store_kubectl delete namespace otel loki --ignore-not-found
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
