#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-kube-assistant}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"

export KUBECONFIG="$KUBECONFIG_PATH"

if ! kind get clusters | grep -qx "$KIND_CLUSTER_NAME"; then
  kind create cluster --name "$KIND_CLUSTER_NAME" --config "$ROOT/kind-config.yaml"
fi

declare -a IMAGES=(
  "kube-assistant/auth-service:local services/auth-service"
  "kube-assistant/ai-service:local services/ai-service"
  "kube-assistant/k8s-service:local services/k8s-service"
  "kube-assistant/session-service:local services/session-service"
  "kube-assistant/frontend:local frontend"
  "kube-assistant/model-config-controller:local services/model-config-controller"
)

for item in "${IMAGES[@]}"; do
  image=$(echo "$item" | awk '{print $1}')
  context=$(echo "$item" | awk '{print $2}')
  docker build -t "$image" "$ROOT/$context"
  kind load docker-image "$image" --name "$KIND_CLUSTER_NAME"
done

kubectl apply -k "$ROOT/k8s"

if [[ -f "$ROOT/k8s/secret.local.yaml" ]]; then
  kubectl -n kube-assistant apply -f "$ROOT/k8s/secret.local.yaml"
fi

kubectl -n kube-assistant rollout restart deploy/model-config-controller || true
