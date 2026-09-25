#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-kubeast}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"

export KUBECONFIG="$KUBECONFIG_PATH"

if ! kind get clusters | grep -qx "$KIND_CLUSTER_NAME"; then
  mkdir -p "$ROOT/.kind-data/postgres"
  KIND_CONFIG="$(mktemp)"
  sed "s#__KUBEAST_ROOT__#${ROOT}#g" "$ROOT/kind-config.yaml" > "$KIND_CONFIG"
  kind create cluster --name "$KIND_CLUSTER_NAME" --config "$KIND_CONFIG"
  rm -f "$KIND_CONFIG"
fi

declare -a IMAGES=(
  "kubeast/auth-service:local services/auth-service"
  "kubeast/ai-service:local services/ai-service"
  "kubeast/k8s-service:local services/k8s-service"
  "kubeast/tool-server:local services/tool-server"
  "kubeast/session-service:local services/session-service"
  "kubeast/frontend:local frontend"
  "kubeast/model-config-controller-go:local services/model-config-controller-go"
)

for item in "${IMAGES[@]}"; do
  image=$(echo "$item" | awk '{print $1}')
  context=$(echo "$item" | awk '{print $2}')
  docker build ${DOCKER_BUILD_ARGS:-} -t "$image" "$ROOT/$context"
  kind load docker-image "$image" --name "$KIND_CLUSTER_NAME"
done

kubectl kustomize --load-restrictor LoadRestrictionsNone "$ROOT/k8s" | kubectl apply -f -

if [[ -f "$ROOT/k8s/secret.local.yaml" ]]; then
  kubectl -n kubeast apply -f "$ROOT/k8s/secret.local.yaml"
fi

kubectl -n kubeast rollout restart deploy/model-config-controller-go || true
kubectl -n kubeast rollout restart deploy/k8s-service deploy/frontend || true
