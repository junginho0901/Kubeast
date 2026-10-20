#!/usr/bin/env bash
# VictoriaMetrics on kind: a single-node VM and a VM cluster (vmagent → vminsert → vmstorage ← vmselect) in the second
# cluster (kubeast-b, Kubeast id "default"), both scraping with the second cluster's Prometheus scrape config
# (deploy/kind/victoriametrics.yaml). Their NodePorts (30428 single, 30481 vmselect) are in the dev
# features.prometheus.egressCIDRs; which store a cluster reads stays as it is — e2e/tests/victoriametrics.spec.ts
# points cluster "default" at each and puts it back.
#
#   scripts/kind-victoriametrics.sh up
#   scripts/kind-victoriametrics.sh down
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${VM_STORE_CLUSTER:-kubeast-b}"
VERSION="v1.154.0"
IMAGES=("victoriametrics/victoria-metrics:$VERSION" "victoriametrics/vmagent:$VERSION"
  "victoriametrics/vmstorage:$VERSION-cluster" "victoriametrics/vminsert:$VERSION-cluster" "victoriametrics/vmselect:$VERSION-cluster")

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
    echo "═══ VictoriaMetrics $VERSION in $STORE ═══"
    for image in "${IMAGES[@]}"; do import_image "$STORE" "$image"; done
    store_kubectl apply -f "$ROOT/deploy/kind/victoriametrics.yaml"
    for d in vmsingle-kubeast vmstorage-kubeast vminsert-kubeast vmselect-kubeast vmagent-kubeast; do
      store_kubectl -n monitoring rollout status "deploy/$d" --timeout=180s
    done
    ;;
  down)
    store_kubectl delete -f "$ROOT/deploy/kind/victoriametrics.yaml" --ignore-not-found
    ;;
  *) echo "usage: $0 up | down" >&2; exit 2 ;;
esac
