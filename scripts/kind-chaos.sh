#!/usr/bin/env bash
# Chaos Mesh on kind for the hard AI cases (scripts/ai-eval.py, evals/ai/README.md "Hard cases"): kills pods, delays,
# cuts or drops traffic, breaks DNS and loads CPU or memory in the second cluster (kubeast-b, Kubeast id "default"),
# where Loki, Tempo and Prometheus are. The pinned chart is rendered with deploy/kind/chaos-mesh-values.yaml and
# applied server-side, as the Kyverno add-on is (scripts/add-kind-cluster.sh), so the cluster keeps no Helm release.
#
#   scripts/kind-chaos.sh up       # again after a change; each render makes new certificates, so the pods restart
#   scripts/kind-chaos.sh down     # every experiment first (the controller removes their finalizers), then Chaos Mesh
#
# A node that cannot pull an image (a proxy) gets it from the host's docker.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${CHAOS_CLUSTER:-kubeast-b}"
NS="chaos-mesh"
CHAOS_MESH_CHART_VERSION="2.8.7"
# PodChaos pod-failure swaps containers for this image (the chart's default is an unpinned :latest).
PAUSE_IMAGE="registry.k8s.io/pause:3.10"

case "${1:-}" in
  up|down) ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
KC="$(mktemp)"
MANIFEST="$(mktemp)"
trap 'rm -f "$KC" "$MANIFEST"' EXIT
kind get kubeconfig --name "$STORE" > "$KC"
k() { kubectl --kubeconfig "$KC" "$@"; }

# These images are not on Docker Hub, so the node pulls the full reference.
import_image() {
  docker exec "$STORE-control-plane" crictl pull "$1" >/dev/null 2>&1 && return
  docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null
  docker save "$1" | docker exec --privileged -i "$STORE-control-plane" \
    ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
}

render() {
  helm repo add chaos-mesh https://charts.chaos-mesh.org >/dev/null 2>&1 || true
  helm repo update chaos-mesh >/dev/null
  helm template chaos-mesh chaos-mesh/chaos-mesh --version "$CHAOS_MESH_CHART_VERSION" -n "$NS" --include-crds \
    --kube-version "$(k version -o json | jq -r .serverVersion.gitVersion)" \
    -f "$ROOT/deploy/kind/chaos-mesh-values.yaml" \
    --set controllerManager.podChaos.podFailure.pauseImage="$PAUSE_IMAGE" > "$MANIFEST"
}

case "${1:-}" in
  up)
    render
    echo "═══ images ═══"
    for image in $(sed -n "s/^[ -]*image: *[\"']\{0,1\}\([^\"']*\)[\"']\{0,1\}$/\1/p" "$MANIFEST" | sort -u) "$PAUSE_IMAGE"; do
      import_image "$image"
    done
    echo "═══ Chaos Mesh $CHAOS_MESH_CHART_VERSION in $STORE ═══"
    running=0
    k -n "$NS" get deploy chaos-controller-manager >/dev/null 2>&1 && running=1
    k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
    k apply --server-side --force-conflicts -n "$NS" -f "$MANIFEST" >/dev/null
    if [ "$running" = 1 ]; then
      k -n "$NS" rollout restart deploy/chaos-controller-manager deploy/chaos-dns-server ds/chaos-daemon >/dev/null
    fi
    k -n "$NS" rollout status deploy/chaos-controller-manager --timeout=180s
    k -n "$NS" rollout status deploy/chaos-dns-server --timeout=180s
    k -n "$NS" rollout status ds/chaos-daemon --timeout=180s
    ;;
  down)
    if k get crd podchaos.chaos-mesh.org >/dev/null 2>&1; then
      for kind in $(k api-resources --api-group=chaos-mesh.org -o name); do
        k delete "$kind" --all -A --ignore-not-found --timeout=120s >/dev/null \
          || echo "some $kind still there: look at their finalizers" >&2
      done
    fi
    render
    k delete -n "$NS" -f "$MANIFEST" --ignore-not-found --wait=false >/dev/null
    k delete namespace "$NS" --ignore-not-found
    ;;
esac
