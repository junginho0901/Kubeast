#!/usr/bin/env bash
# Argo CD on kind: the core install (application controller, repo server, ApplicationSet controller and
# Redis — no API server or UI) in the second cluster (kubeast-b) with one real Application
# (deploy/kind/argocd-app.yaml: the podinfo chart synced into e2e-argo). e2e/tests/argocd-real.spec.ts
# checks what Argo CD itself writes: the tracking annotation, the refused write and gitops_status.
#
#   scripts/kind-argocd.sh up
#   scripts/kind-argocd.sh down
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="${ARGOCD_CLUSTER:-kubeast-b}"
ARGOCD_VERSION="v3.5.6"
MANIFEST="https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/core-install.yaml"

store_kubectl() { kubectl --kubeconfig <(kind get kubeconfig --name "$STORE") "$@"; }

case "${1:-}" in
  up)
    store_kubectl create namespace argocd --dry-run=client -o yaml | store_kubectl apply -f -
    # the install's CRDs are larger than client-side apply's annotation allows (Argo CD docs: server-side)
    store_kubectl apply -n argocd --server-side --force-conflicts -f "$MANIFEST" >/dev/null
    store_kubectl -n argocd rollout status statefulset/argocd-application-controller --timeout=300s
    store_kubectl -n argocd rollout status deploy/argocd-repo-server --timeout=300s
    store_kubectl apply -f "$ROOT/deploy/kind/argocd-app.yaml"
    store_kubectl -n argocd wait application/e2e-podinfo --for=jsonpath='{.status.sync.status}'=Synced --timeout=300s
    store_kubectl -n argocd wait application/e2e-podinfo --for=jsonpath='{.status.health.status}'=Healthy --timeout=300s
    echo "═══ Argo CD ${ARGOCD_VERSION} core on ${STORE}: Application e2e-podinfo Synced, Healthy ═══"
    ;;
  down)
    store_kubectl delete -f "$ROOT/deploy/kind/argocd-app.yaml" --ignore-not-found
    store_kubectl delete namespace e2e-argo --ignore-not-found
    store_kubectl delete -n argocd -f "$MANIFEST" --ignore-not-found >/dev/null
    store_kubectl delete namespace argocd --ignore-not-found
    ;;
  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
