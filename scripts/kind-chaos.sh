#!/usr/bin/env bash
# Chaos Mesh on kind for the AI evaluation's fault cases (scripts/ai-eval.py): pod kill and failure, network delay,
# loss and partition, DNS errors, CPU and memory stress in the second cluster (kubeast-b, Kubeast id "default"), where
# Loki, Tempo and Prometheus are. The pinned chart is rendered with deploy/kind/chaos-values.yaml (the kind node's
# containerd runtime and socket) and applied server-side, as the Kyverno add-on is (scripts/add-kind-cluster.sh), so
# that cluster keeps no Helm release (helm-cluster-switch.spec.ts, multi-cluster-helm.spec.ts).
#
#   scripts/kind-chaos.sh up     # does nothing when this version and values are already up
#   scripts/kind-chaos.sh down   # every experiment first (the controller clears their finalizers), then what up made
#
# Behind a TLS-inspecting proxy the node must trust it before it pulls the images: set CHAOS_NODE_HOOK to a command
# that gets the cluster name (run before the images). A node that cannot pull an image gets it from the host's docker.
# The render holds the TLS keys the chart generates: it stays in a temporary file, removed on exit, and is not printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${CHAOS_CLUSTER:-kubeast-b}"
NODE="$STORE-control-plane"
NS="chaos-mesh"
CHAOS_MESH_VERSION="2.8.8"
VALUES="$ROOT/deploy/kind/chaos-values.yaml"
# What up was last run with, kept as an annotation on the namespace: the chart version and the values file.
INPUT="$( { echo "$CHAOS_MESH_VERSION"; cat "$VALUES"; } | cksum | cut -d' ' -f1)"

case "${1:-}" in
  up|down) ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac

KC="$(mktemp)"
MANIFEST="$(mktemp)"
trap 'rm -f "$KC" "$MANIFEST"' EXIT
kind get kubeconfig --name "$STORE" > "$KC" 2>/dev/null \
  || { echo "no kind cluster $STORE (CHAOS_CLUSTER names another)" >&2; exit 1; }
k() { kubectl --kubeconfig "$KC" "$@"; }

# import_image <reference> — the node pulls it; where it cannot (a proxy), it comes from the host's docker.
import_image() {
  docker exec "$NODE" crictl pull "$1" >/dev/null 2>&1 && return
  docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null
  docker save "$1" | docker exec --privileged -i "$NODE" \
    ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
}

render() {
  helm repo add chaos-mesh https://charts.chaos-mesh.org >/dev/null 2>&1 || true
  helm repo update chaos-mesh >/dev/null
  helm template chaos-mesh chaos-mesh/chaos-mesh --version "$CHAOS_MESH_VERSION" -n "$NS" --include-crds \
    --kube-version "$(k version -o json | jq -r .serverVersion.gitVersion)" -f "$VALUES" > "$MANIFEST"
}

# The images of the render and the pause image PodChaos pod-failure runs (an env value, not an image: field).
images() {
  sed -n "s/^[ -]*image: *[\"']\{0,1\}\([^\"']*\)[\"']\{0,1\}$/\1/p" "$MANIFEST"
  sed -n '/name: POD_FAILURE_PAUSE_IMAGE/{n;s/^ *value: *//p;}' "$MANIFEST"
}

ready() {
  local w
  for w in $(k -n "$NS" get deploy,ds -o name 2>/dev/null); do
    k -n "$NS" rollout status "$w" --timeout=5s >/dev/null 2>&1 || return 1
  done
  [ -n "$(k -n "$NS" get deploy chaos-controller-manager -o name 2>/dev/null)" ]
}

case "$1" in
  up)
    if [ "$(k get namespace "$NS" -o jsonpath='{.metadata.annotations.kubeast\.dev/chaos-input}' 2>/dev/null)" = "$INPUT" ] && ready; then
      echo "Chaos Mesh $CHAOS_MESH_VERSION is already up in $STORE with these values: nothing to do"
      exit 0
    fi
    if [ -n "${CHAOS_NODE_HOOK:-}" ]; then $CHAOS_NODE_HOOK "$STORE"; fi
    render
    echo "═══ images ═══"
    images | sed '/^$/d' | sort -u | while IFS= read -r image; do
      echo "  $image"
      import_image "$image"
    done
    echo "═══ Chaos Mesh $CHAOS_MESH_VERSION in $STORE ═══"
    existed=0
    k -n "$NS" get deploy chaos-controller-manager >/dev/null 2>&1 && existed=1
    k create namespace "$NS" --dry-run=client -o yaml | k apply -f - >/dev/null
    k apply --server-side --force-conflicts -n "$NS" -f "$MANIFEST" >/dev/null
    workloads="$(k -n "$NS" get deploy,ds -o name)"
    if [ "$existed" = 1 ]; then
      # Each render makes new certificates (webhook, daemon mTLS): the running pods read them on restart.
      for w in $workloads; do k -n "$NS" rollout restart "$w" >/dev/null; done
    fi
    for w in $workloads; do k -n "$NS" rollout status "$w" --timeout=180s; done
    k annotate namespace "$NS" --overwrite "kubeast.dev/chaos-input=$INPUT" >/dev/null
    echo "Chaos Mesh is up in $STORE: kubectl api-resources --api-group=chaos-mesh.org lists the experiment kinds"
    ;;
  down)
    if k get crd podchaos.chaos-mesh.org >/dev/null 2>&1; then
      echo "═══ experiments ═══"
      for r in $(k api-resources --api-group=chaos-mesh.org -o name); do
        k delete "$r" --all -A --ignore-not-found --timeout=120s >/dev/null \
          || echo "some $r are still there: look at their finalizers" >&2
      done
    fi
    echo "═══ Chaos Mesh in $STORE ═══"
    render
    k delete -n "$NS" -f "$MANIFEST" --ignore-not-found --wait=false >/dev/null
    k delete namespace "$NS" --ignore-not-found
    ;;
esac
