#!/usr/bin/env bash
# Fake GPUs on the dev cluster test2 for the GPU screens' number checks:
# - DRA (e2e/tests/number-check-dra.spec.ts): the DRA example driver v0.5.0 (deploy/kind/dra-example-driver.yaml — eight
#   mock GPUs on the node as a ResourceSlice of gpu.example.com, the DeviceClass gpu.example.com; pods that claim one run
#   with it injected through CDI, which kind's containerd 2 enables).
# - the device plugin's resources (e2e/tests/number-check-gpu.spec.ts): the node advertises nvidia.com/gpu and the MIG
#   profile nvidia.com/mig-1g.5gb as extended resources (Kubernetes' "Advertise Extended Resources for a Node": a name
#   no device plugin registered, so the kubelet keeps it and pods asking for it run without a device), with GPU
#   Feature Discovery's labels; DCGM series from a stand-in exporter scraped by a Prometheus in `monitoring`
#   (deploy/kind/gpu-metrics.yaml), which Read users may GET through the API server proxy
#   (templates/impersonation-viewer-proxy.yaml).
# - AMD's and Intel's GPUs (e2e/tests/number-check-gpu-vendors.spec.ts): that spec makes two Node objects without a
#   kubelet for its run (label kubeast.dev/e2e-fake-gpu-node) and removes them, as number-check-gpu.spec.ts does three
#   for its GPU Pods charts; `down` removes any a stopped run left.
#
#   scripts/kind-gpu.sh up
#   scripts/kind-gpu.sh down
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER="${GPU_CLUSTER:-test2}"
NODE="$CLUSTER-control-plane"
DRA_IMAGE="registry.k8s.io/dra-example-driver/dra-example-driver:v0.5.0"
PROM_IMAGE="prom/prometheus:v3.15.1"
EXPORTER_IMAGE="busybox:1.37"
# the values number-check-gpu.spec.ts reads back
GPUS=8
MIG_1G=4
GFD_LABELS=(
  nvidia.com/gpu.product=NVIDIA-A100-SXM4-80GB nvidia.com/gpu.memory=81920 nvidia.com/gpu.count=8
  nvidia.com/gpu.family=ampere nvidia.com/gpu.compute.major=8 nvidia.com/gpu.compute.minor=0
  nvidia.com/mig.strategy=mixed
  nvidia.com/cuda.driver-version.major=580 nvidia.com/cuda.driver-version.minor=95
  nvidia.com/cuda.driver-version.revision=05 nvidia.com/cuda.driver-version.full=580.95.05
  nvidia.com/cuda.driver.major=580 nvidia.com/cuda.driver.minor=95 nvidia.com/cuda.driver.rev=05
  nvidia.com/cuda.runtime-version.major=13 nvidia.com/cuda.runtime-version.minor=0 nvidia.com/cuda.runtime-version.full=13.0
  nvidia.com/cuda.runtime.major=13 nvidia.com/cuda.runtime.minor=0
)

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

    echo "═══ $NODE: nvidia.com/gpu $GPUS, nvidia.com/mig-1g.5gb $MIG_1G, GPU Feature Discovery labels ═══"
    # a JSON patch of the status subresource, as the Kubernetes task does (~1 is the / of the resource name)
    k patch node "$NODE" --subresource=status --type=json -p "[
      {\"op\":\"add\",\"path\":\"/status/capacity/nvidia.com~1gpu\",\"value\":\"$GPUS\"},
      {\"op\":\"add\",\"path\":\"/status/capacity/nvidia.com~1mig-1g.5gb\",\"value\":\"$MIG_1G\"}]" >/dev/null
    k label node "$NODE" --overwrite "${GFD_LABELS[@]}" >/dev/null
    # the kubelet copies the capacity of a name no device plugin owns into the allocatable on its next status update
    for _ in $(seq 1 30); do
      [ "$(k get node "$NODE" -o jsonpath='{.status.allocatable.nvidia\.com/gpu}')" = "$GPUS" ] && break
      sleep 2
    done
    k get node "$NODE" -o jsonpath='{"capacity "}{.status.capacity}{"\nallocatable "}{.status.allocatable}{"\n"}'

    echo "═══ DCGM stand-in and Prometheus in $CLUSTER/monitoring ═══"
    import_image "$PROM_IMAGE"
    import_image "$EXPORTER_IMAGE"
    k apply -f "$ROOT/deploy/kind/gpu-metrics.yaml" >/dev/null
    k -n monitoring rollout status deploy/dcgm-exporter --timeout=180s
    k -n monitoring rollout status deploy/prometheus --timeout=180s
    # Read users (kubeast:viewer) may GET this Prometheus through the API server proxy, nothing else
    helm template kubeast "$ROOT/helm/kubeast" -s templates/impersonation-viewer-proxy.yaml -f "$ROOT/deploy/kind/values.yaml" \
      --set-json 'auth.impersonation.viewerProxyServices=[{"namespace":"monitoring","service":"prometheus","port":9090}]' \
      | k apply -f - >/dev/null
    ;;
  down)
    # what a stopped number-check-gpu-vendors or number-check-gpu run left: the pods on the nodes without a kubelet (no
    # kubelet confirms their deletion), then the nodes
    k delete pods -n e2e-gpu-vendors --all --grace-period=0 --force --ignore-not-found >/dev/null 2>&1 || true
    k delete pods -A -l kubeast.dev/e2e-fake-gpu-node --grace-period=0 --force --ignore-not-found >/dev/null 2>&1 || true
    k delete namespace e2e-gpu-vendors --ignore-not-found
    k delete nodes -l kubeast.dev/e2e-fake-gpu-node --ignore-not-found
    k delete --ignore-not-found -f "$ROOT/deploy/kind/gpu-metrics.yaml"
    # the kubelet drops a name from the allocatable once it is gone from the capacity
    for r in nvidia.com~1gpu nvidia.com~1mig-1g.5gb; do
      k patch node "$NODE" --subresource=status --type=json -p "[{\"op\":\"remove\",\"path\":\"/status/capacity/$r\"}]" >/dev/null 2>&1 || true
    done
    keys=("${GFD_LABELS[@]%%=*}")
    k label node "$NODE" "${keys[@]/%/-}" >/dev/null
    k delete --ignore-not-found -f "$ROOT/deploy/kind/dra-example-driver.yaml"
    k delete namespace dra-example-driver --ignore-not-found
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
