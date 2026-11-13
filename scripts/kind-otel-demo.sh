#!/usr/bin/env bash
# The OpenTelemetry demo (Astronomy Shop) on kind for the hard AI cases (scripts/ai-eval.py, evals/ai/README.md "Hard
# cases"): a dozen services calling each other, a load generator and the demo's failure flags (flagd), in namespace
# astronomy-shop of the second cluster (kubeast-b, Kubeast id "default"). The pinned chart is rendered with
# deploy/kind/otel-demo-values.yaml and applied server-side, so the cluster keeps no Helm release. Its collector writes
# traces to the Tempo of scripts/kind-tracing.sh and logs to the Loki of scripts/kind-logsearch.sh: run those up
# first. The demo takes some 6 GB more of Docker's memory.
#
#   scripts/kind-otel-demo.sh up
#   DEMO_METRICS=1 scripts/kind-otel-demo.sh up    # the demo's metrics written to the dev Prometheus too
#   scripts/kind-otel-demo.sh down
#
# A node that cannot pull an image (a proxy) gets it from the host's docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${DEMO_CLUSTER:-kubeast-b}"
NS="${DEMO_NAMESPACE:-astronomy-shop}"
DEMO_CHART_VERSION="0.42.6"

case "${1:-}" in
  up|down) ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
KC="$(mktemp)"
MANIFEST="$(mktemp)"
trap 'rm -f "$KC" "$MANIFEST"' EXIT
kind get kubeconfig --name "$STORE" > "$KC"
k() { kubectl --kubeconfig "$KC" "$@"; }

# Docker Hub images by their short name first, the others (ghcr.io) by their full reference.
import_image() {
  docker exec "$STORE-control-plane" crictl pull "$1" >/dev/null 2>&1 && return
  docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null
  docker save "$1" | docker exec --privileged -i "$STORE-control-plane" \
    ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
}

render() {
  local metrics=()
  if [ "${DEMO_METRICS:-0}" = 1 ]; then
    metrics=(--set 'opentelemetry-collector.config.service.pipelines.metrics.exporters={prometheus_remote_write}')
  fi
  helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts >/dev/null 2>&1 || true
  helm repo update open-telemetry >/dev/null
  helm template "$NS" open-telemetry/opentelemetry-demo --version "$DEMO_CHART_VERSION" -n "$NS" \
    --kube-version "$(k version -o json | jq -r .serverVersion.gitVersion)" \
    -f "$ROOT/deploy/kind/otel-demo-values.yaml" ${metrics[@]+"${metrics[@]}"} > "$MANIFEST"
}

case "${1:-}" in
  up)
    for need in tempo/tempo loki/loki; do
      k -n "${need%/*}" get deploy "${need#*/}" >/dev/null 2>&1 \
        || { echo "no ${need#*/} in $STORE: run scripts/kind-logsearch.sh up and scripts/kind-tracing.sh up first" >&2; exit 1; }
    done
    render
    echo "═══ images ═══"
    for image in $(sed -n "s/^[ -]*image: *[\"']\{0,1\}\([^\"']*\)[\"']\{0,1\}$/\1/p" "$MANIFEST" | sort -u); do
      import_image "$image"
    done
    echo "═══ OpenTelemetry demo $DEMO_CHART_VERSION in $STORE/$NS ═══"
    k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
    k apply --server-side --force-conflicts -n "$NS" -f "$MANIFEST" >/dev/null
    k -n "$NS" rollout status ds/otel-collector-agent --timeout=180s
    k -n "$NS" wait --for=condition=Available deploy --all --timeout=600s
    ;;
  down)
    render
    k delete -n "$NS" -f "$MANIFEST" --ignore-not-found --wait=false >/dev/null
    k delete namespace "$NS" --ignore-not-found
    ;;
esac
