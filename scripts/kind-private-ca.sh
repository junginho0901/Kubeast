#!/usr/bin/env bash
# customCAs on kind: a throwaway CA, an HTTPS front in the second cluster signed by it
# (deploy/kind/private-ca-front.yaml), and Kubeast trusting that CA (deploy/kind/private-ca-values.yaml):
# k8s-service searches Loki and ai-service lists models through the front. Needs scripts/kind-logsearch.sh up.
# e2e/tests/custom-ca.spec.ts runs against this.
#
#   scripts/kind-private-ca.sh up     # a new CA each time
#   scripts/kind-private-ca.sh down   # back to the dev and log search values; the front and the CA Secret removed
#
# CA_DAYS (default 30): how many days the CA and the front's certificate are valid from `up`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"
MAIN="${KIND_CLUSTER_NAME:-kubeast}"
STORE="${LOGSEARCH_STORE_CLUSTER:-kubeast-b}"
NAMESPACE="${NAMESPACE:-kubeast}"
RELEASE="${RELEASE:-kubeast}"
DIR="${TMPDIR:-/tmp}/kubeast-private-ca"
SERVICES="auth-service k8s-service ai-service session-service tool-server model-config-controller-go"
CA_DAYS="${CA_DAYS:-30}"

main_kubectl() { kubectl --kubeconfig "$KUBECONFIG_PATH" --context "kind-$MAIN" "$@"; }
store_kubectl() { kubectl --kubeconfig <(kind get kubeconfig --name "$STORE") "$@"; }
upgrade() {
  helm --kubeconfig "$KUBECONFIG_PATH" --kube-context "kind-$MAIN" -n "$NAMESPACE" upgrade "$RELEASE" "$ROOT/helm/kubeast" \
    --reset-then-reuse-values "$@" --wait --timeout 5m | grep -E "REVISION|STATUS"
}

case "${1:-}" in
  up)
    case "$CA_DAYS" in
      '' | *[!0-9]* | 0*) echo "CA_DAYS must be a whole number of days above 0, not '$CA_DAYS'" >&2; exit 2 ;;
    esac
    echo "═══ CA and the front's certificate ($DIR, $CA_DAYS days) ═══"
    mkdir -p "$DIR"
    # Key identifiers and key usage as a real CA has them: Python 3.13+ verifies strictly.
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days "$CA_DAYS" -subj "/CN=Kubeast dev CA" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" -keyout "$DIR/ca.key" -out "$DIR/ca.crt" 2>/dev/null
    openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$STORE-control-plane" \
      -keyout "$DIR/tls.key" -out "$DIR/tls.csr" 2>/dev/null
    printf 'subjectAltName=DNS:%s-control-plane\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nauthorityKeyIdentifier=keyid\nsubjectKeyIdentifier=hash\n' "$STORE" > "$DIR/server.ext"
    openssl x509 -req -in "$DIR/tls.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" -CAcreateserial -days "$CA_DAYS" \
      -extfile "$DIR/server.ext" -out "$DIR/tls.crt" 2>/dev/null
    echo "═══ HTTPS front in $STORE ═══"
    store_kubectl apply -f "$ROOT/deploy/kind/private-ca-front.yaml" >/dev/null
    store_kubectl -n ca-front create secret tls ca-front-tls --cert "$DIR/tls.crt" --key "$DIR/tls.key" \
      --dry-run=client -o yaml | store_kubectl apply -f - >/dev/null
    store_kubectl -n ca-front rollout restart deploy/ca-front >/dev/null
    store_kubectl -n ca-front rollout status deploy/ca-front --timeout=120s
    echo "═══ Kubeast: customCAs ═══"
    main_kubectl -n "$NAMESPACE" create secret generic kubeast-dev-ca --from-file=dev-ca.crt="$DIR/ca.crt" \
      --dry-run=client -o yaml | main_kubectl apply -f - >/dev/null
    upgrade -f "$ROOT/deploy/kind/private-ca-values.yaml"
    # The services read the CAs at start; a new CA in the same Secret changes no pod spec.
    for s in $SERVICES; do main_kubectl -n "$NAMESPACE" rollout restart "deploy/$s" >/dev/null; done
    for s in $SERVICES; do main_kubectl -n "$NAMESPACE" rollout status "deploy/$s" --timeout=180s >/dev/null; done
    echo "services restarted"
    ;;
  down)
    upgrade -f "$ROOT/deploy/kind/values.yaml" -f "$ROOT/deploy/kind/logsearch-values.yaml" --set-json 'customCAs=[]'
    main_kubectl -n "$NAMESPACE" delete secret kubeast-dev-ca --ignore-not-found
    store_kubectl delete namespace ca-front --ignore-not-found
    ;;
  *)
    echo "usage: [CA_DAYS=30] $0 up|down" >&2
    exit 2
    ;;
esac
