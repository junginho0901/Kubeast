#!/usr/bin/env bash
# Fake GPUs on the dev cluster test2 for the DRA screens' number check (e2e/tests/number-check-dra.spec.ts):
# the DRA example driver v0.5.0 (deploy/kind/dra-example-driver.yaml — eight mock GPUs on the node as a ResourceSlice
# of gpu.example.com, the DeviceClass gpu.example.com; pods that claim one run with it injected through CDI, which
# kind's containerd 2 enables).
#
#   scripts/kind-gpu.sh up
#   scripts/kind-gpu.sh down
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER="${GPU_CLUSTER:-test2}"
DRA_IMAGE="registry.k8s.io/dra-example-driver/dra-example-driver:v0.5.0"

k() { kubectl --kubeconfig <(kind get kubeconfig --name "$CLUSTER") --context "kind-$CLUSTER" "$@"; }

import_image() {
  docker exec "$CLUSTER-control-plane" crictl pull "$1" >/dev/null 2>&1 && return
  docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null
  docker save "$1" | docker exec --privileged -i "$CLUSTER-control-plane" \
    ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
}

case "${1:-}" in
  up)
    echo "═══ DRA example driver in $CLUSTER ═══"
    import_image "$DRA_IMAGE"
    k create namespace dra-example-driver --dry-run=client -o yaml | k apply -f - >/dev/null
    k apply --server-side --force-conflicts -f "$ROOT/deploy/kind/dra-example-driver.yaml" >/dev/null
    k -n dra-example-driver rollout status ds/dra-example-driver-kubeletplugin --timeout=180s
    # the plugin publishes its devices once registered with the kubelet
    for _ in $(seq 1 60); do
      [ "$(k get resourceslices -o jsonpath='{range .items[?(@.spec.driver=="gpu.example.com")]}{.metadata.name}{"\n"}{end}' | grep -c .)" -gt 0 ] && break
      sleep 2
    done
    k get resourceslices -o custom-columns='NAME:.metadata.name,NODE:.spec.nodeName,DRIVER:.spec.driver,DEVICES:.spec.devices[*].name'
    ;;
  down)
    k delete --ignore-not-found -f "$ROOT/deploy/kind/dra-example-driver.yaml"
    k delete namespace dra-example-driver --ignore-not-found
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
