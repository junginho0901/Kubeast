#!/usr/bin/env bash
# Point the kind install's default model at Anthropic Claude Haiku for an e2e run, instead of the Ollama model
# on the laptop: the inference leaves the machine (no local GPU load) at the cheapest API model. The key is
# read from a file and never printed or placed on a command line.
#
#   scripts/kind-model-haiku.sh up <key-file>   # Secret kubeast-ai-keys (ANTHROPIC_API_KEY), chart ai.apiKeysSecret,
#                                               # ModelConfig anthropic-haiku as the default; the Ollama one stays, not default
#   scripts/kind-model-haiku.sh down            # the Ollama ModelConfig default again; anthropic-haiku, the chart value
#                                               # and the Secret removed — run this when the e2e is over
#
# The chat-cost probe compares against an Ollama baseline: run `down` before it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"
MAIN="${KIND_CLUSTER_NAME:-kubeast}"
NAMESPACE="${NAMESPACE:-kubeast}"
RELEASE="${RELEASE:-kubeast}"
MODEL="${HAIKU_MODEL:-claude-haiku-5-5}"
SECRET="kubeast-ai-keys"
OLLAMA_MC="${OLLAMA_MODELCONFIG:-ollama-granite}"   # deploy/kind/modelconfig-ollama.yaml

k() { kubectl --kubeconfig "$KUBECONFIG_PATH" --context "kind-$MAIN" -n "$NAMESPACE" "$@"; }
helm_up() {
  helm --kubeconfig "$KUBECONFIG_PATH" --kube-context "kind-$MAIN" -n "$NAMESPACE" upgrade "$RELEASE" "$ROOT/helm/kubeast" \
    --reset-then-reuse-values "$@" --wait --timeout 5m | grep -E "REVISION|STATUS"
}
set_default() { k patch modelconfig "$1" --type merge -p "{\"spec\":{\"isDefault\":$2}}" >/dev/null 2>&1 || true; }

case "${1:-}" in
  up)
    KEY_FILE="${2:?usage: kind-model-haiku.sh up <key-file>}"
    [ -s "$KEY_FILE" ] || { echo "key file is empty: $KEY_FILE" >&2; exit 1; }
    echo "═══ Secret $SECRET (key from $KEY_FILE, $(tr -d '[:space:]' < "$KEY_FILE" | wc -c | tr -d ' ') chars) ═══"
    k create secret generic "$SECRET" --dry-run=client -o yaml \
      --from-file=ANTHROPIC_API_KEY=<(tr -d '[:space:]' < "$KEY_FILE") | k apply -f - >/dev/null
    echo "═══ Kubeast: ai.apiKeysSecret=$SECRET ═══"
    helm_up --set ai.apiKeysSecret="$SECRET"
    echo "═══ ModelConfig anthropic-haiku ($MODEL) as the default ═══"
    set_default "$OLLAMA_MC" false
    k apply -f - <<EOF
apiVersion: ai.kubeast.io/v1alpha1
kind: ModelConfig
metadata:
  name: anthropic-haiku
  namespace: $NAMESPACE
spec:
  provider: anthropic
  model: $MODEL
  apiKeyEnv: ANTHROPIC_API_KEY
  enabled: true
  isDefault: true
EOF
    k get modelconfig
    ;;
  down)
    k delete modelconfig anthropic-haiku --ignore-not-found
    set_default "$OLLAMA_MC" true
    echo "═══ Kubeast: ai.apiKeysSecret cleared ═══"
    helm_up --set ai.apiKeysSecret=""
    k delete secret "$SECRET" --ignore-not-found
    k get modelconfig
    ;;
  *)
    echo "usage: $0 up <key-file> | down" >&2
    exit 2
    ;;
esac
