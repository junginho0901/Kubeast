#!/usr/bin/env bash
# Traces on kind: a Jaeger in the second cluster (kubeast-b, Kubeast id "default") for the trace links
# (features.tracing) and a Tempo there for the AI's trace reads (features.traceStore,
# deploy/kind/tracing-tempo.yaml), Kubeast pointed at both (deploy/kind/tracing-values.yaml). Needs
# scripts/kind-logsearch.sh up first (the links sit on log search lines). e2e/tests/trace-links.spec.ts
# and ai-traces-tools.spec.ts run against this.
#
#   scripts/kind-tracing.sh up
#   scripts/kind-tracing.sh down   # Kubeast back to trace links and reads off; Jaeger and Tempo removed
#
# To open the links from the laptop: kubectl port-forward -n tracing svc/jaeger 16686 (kubeast-b).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"
MAIN="${KIND_CLUSTER_NAME:-kubeast}"
STORE="${LOGSEARCH_STORE_CLUSTER:-kubeast-b}"
NAMESPACE="${NAMESPACE:-kubeast}"
RELEASE="${RELEASE:-kubeast}"
JAEGER_IMAGE="jaegertracing/jaeger:2.22.0"
TEMPO_IMAGE="grafana/tempo:3.1.0"
# e2e/tests/ai-traces-tools.spec.ts sends its traces with this from the first cluster
TELEMETRYGEN_IMAGE="ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen:v0.162.0"

store_kubectl() { kubectl --kubeconfig <(kind get kubeconfig --name "$STORE") "$@"; }

# The node pulls the image itself; where it cannot (a proxy), it is imported from the host's docker.
import_image() {
  docker exec "$1-control-plane" crictl pull "docker.io/$2" >/dev/null 2>&1 && return
  docker image inspect "$2" >/dev/null 2>&1 || docker pull -q "$2" >/dev/null
  docker save "$2" | docker exec --privileged -i "$1-control-plane" \
    ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
}

case "${1:-}" in
  up)
    echo "═══ Jaeger in $STORE ═══"
    import_image "$STORE" "$JAEGER_IMAGE"
    store_kubectl apply -f "$ROOT/deploy/kind/tracing-jaeger.yaml"
    store_kubectl -n tracing rollout status deploy/jaeger --timeout=180s
    echo "═══ Tempo in $STORE ═══"
    import_image "$STORE" "$TEMPO_IMAGE"
    store_kubectl apply -f "$ROOT/deploy/kind/tracing-tempo.yaml"
    store_kubectl -n tempo rollout status deploy/tempo --timeout=180s
    import_image "$MAIN" "$TELEMETRYGEN_IMAGE"
    echo "═══ Kubeast trace links and trace reads ═══"
    helm --kubeconfig "$KUBECONFIG_PATH" --kube-context "kind-$MAIN" -n "$NAMESPACE" upgrade "$RELEASE" "$ROOT/helm/kubeast" \
      --reset-then-reuse-values -f "$ROOT/deploy/kind/tracing-values.yaml" --wait --timeout 5m | grep -E "REVISION|STATUS"
    ;;
  down)
    helm --kubeconfig "$KUBECONFIG_PATH" --kube-context "kind-$MAIN" -n "$NAMESPACE" upgrade "$RELEASE" "$ROOT/helm/kubeast" \
      --reset-then-reuse-values --set features.tracing.enabled=false --set features.traceStore.enabled=false --wait --timeout 5m | grep -E "REVISION|STATUS"
    store_kubectl delete namespace tracing tempo --ignore-not-found
    ;;
  *) echo "usage: $0 up | down" >&2; exit 2 ;;
esac
