#!/usr/bin/env bash
# The CRDs the dev cluster test2 serves for the number checks (e2e/tests/number-check-*.spec.ts, e2e/actions) and that
# nothing else puts there: the Gateway API's experimental channel and the VerticalPodAutoscaler CRD. Their versions are
# in deploy/dependencies.yaml. Applied server-side as kubectl's field manager, the one that holds them on a cluster they
# were put on by hand (another name conflicts on .spec.versions). There is no `down`: the specs' objects go with a CRD.
#
#   scripts/kind-test2-crds.sh up
#   scripts/kind-test2-crds.sh versions
set -euo pipefail

CLUSTER="${TEST2_CLUSTER:-test2}"
GATEWAY_API_VERSION="v1.3.0"
VPA_VERSION="1.8.1"
GATEWAY_API_MANIFEST="https://github.com/kubernetes-sigs/gateway-api/releases/download/${GATEWAY_API_VERSION}/experimental-install.yaml"
VPA_MANIFEST="https://raw.githubusercontent.com/kubernetes/autoscaler/vertical-pod-autoscaler-${VPA_VERSION}/vertical-pod-autoscaler/deploy/vpa-v1-crd-gen.yaml"

k() { kubectl --kubeconfig <(kind get kubeconfig --name "$CLUSTER") --context "kind-$CLUSTER" "$@"; }

case "${1:-}" in
  up)
    for manifest in "$GATEWAY_API_MANIFEST" "$VPA_MANIFEST"; do
      curl -sSfL "$manifest" | k apply --server-side --field-manager=kubectl -f -
    done
    k wait --for=condition=Established --timeout=60s \
      crd/gateways.gateway.networking.k8s.io crd/verticalpodautoscalers.autoscaling.k8s.io
    ;;
  versions)
    # the Gateway API's own annotation, and what the VPA CRD's printer columns say of it (1.7.0 and later print MinReplicas)
    k get crd gateways.gateway.networking.k8s.io -o jsonpath='{.metadata.annotations.gateway\.networking\.k8s\.io/bundle-version}{"\n"}'
    k get crd verticalpodautoscalers.autoscaling.k8s.io -o jsonpath='{.metadata.annotations.controller-gen\.kubebuilder\.io/version}{" "}{.spec.versions[?(@.name=="v1")].additionalPrinterColumns[*].name}{"\n"}'
    ;;
  *)
    echo "usage: $0 up|versions" >&2
    exit 2
    ;;
esac
