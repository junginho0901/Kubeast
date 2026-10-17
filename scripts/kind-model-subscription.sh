#!/usr/bin/env bash
# Point the kind install's default model at a Claude subscription (provider claude-code) for an e2e run of the AI
# specs: the chat goes through Claude Code with a `claude setup-token` value instead of an API key. Personal use
# only — the token is the owner's subscription. The ai-service image must be built with Claude Code:
#   DOCKER_BUILD_ARGS="--build-arg WITH_CLAUDE_CODE=true" scripts/rebuild-kind.sh ai-service
# The token is read from a file and never printed or placed on a command line.
#
#   scripts/kind-model-subscription.sh up <token-file>   # Secret kubeast-ai-keys (CLAUDE_CODE_OAUTH_TOKEN), chart
#                                                         # ai.apiKeysSecret + ai.providers.claudeCode.enabled, ModelConfig
#                                                         # claude-subscription as the default; the Ollama one stays, not default
#   scripts/kind-model-subscription.sh down              # the Ollama ModelConfig default again; claude-subscription, the chart
#                                                         # values and the Secret removed — run this when the e2e is over
#
# rebuild-kind.sh loads that image under the plain local tag, so the provider is turned on without the chart's
# -claude-code tag suffix (deploy/kind/values.yaml clears it too; this keeps an older release's values right).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"
MAIN="${KIND_CLUSTER_NAME:-kubeast}"
NAMESPACE="${NAMESPACE:-kubeast}"
RELEASE="${RELEASE:-kubeast}"
MODEL="${SUBSCRIPTION_MODEL:-claude-haiku-5-5}"
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
    TOKEN_FILE="${2:?usage: kind-model-subscription.sh up <token-file>}"
    [ -s "$TOKEN_FILE" ] || { echo "token file is empty: $TOKEN_FILE" >&2; exit 1; }
    k exec deploy/ai-service -- python -c "import claude_agent_sdk" 2>/dev/null || {
      echo "the ai-service image has no Claude Code: rebuild it with DOCKER_BUILD_ARGS=\"--build-arg WITH_CLAUDE_CODE=true\"" >&2
      exit 1
    }
    echo "═══ Secret $SECRET (token from $TOKEN_FILE, $(tr -d '[:space:]' < "$TOKEN_FILE" | wc -c | tr -d ' ') chars) ═══"
    k create secret generic "$SECRET" --dry-run=client -o yaml \
      --from-file=CLAUDE_CODE_OAUTH_TOKEN=<(tr -d '[:space:]' < "$TOKEN_FILE") | k apply -f - >/dev/null
    echo "═══ Kubeast: ai.apiKeysSecret=$SECRET, ai.providers.claudeCode.enabled=true ═══"
    helm_up --set ai.apiKeysSecret="$SECRET" --set ai.providers.claudeCode.enabled=true \
      --set-string ai.providers.claudeCode.imageTagSuffix=
    echo "═══ ModelConfig claude-subscription ($MODEL) as the default ═══"
    set_default "$OLLAMA_MC" false
    k apply -f - <<EOF
apiVersion: ai.kubeast.io/v1alpha1
kind: ModelConfig
metadata:
  name: claude-subscription
  namespace: $NAMESPACE
spec:
  provider: claude-code
  model: $MODEL
  apiKeyEnv: CLAUDE_CODE_OAUTH_TOKEN
  enabled: true
  isDefault: true
EOF
    k get modelconfig
    ;;
  down)
    k delete modelconfig claude-subscription --ignore-not-found
    set_default "$OLLAMA_MC" true
    echo "═══ Kubeast: ai.apiKeysSecret cleared, ai.providers.claudeCode.enabled=false ═══"
    helm_up --set ai.apiKeysSecret="" --set ai.providers.claudeCode.enabled=false
    k delete secret "$SECRET" --ignore-not-found
    k get modelconfig
    ;;
  *)
    echo "usage: $0 up <token-file> | down" >&2
    exit 2
    ;;
esac
