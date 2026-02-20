#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${REGISTRY:-}"
TAG="${TAG:-}"

if [[ -z "$REGISTRY" || -z "$TAG" ]]; then
  echo "Usage: REGISTRY=... TAG=... scripts/deploy-prod.sh" >&2
  exit 1
fi

declare -a SERVICES=(
  "auth-service services/auth-service"
  "ai-service services/ai-service"
  "k8s-service services/k8s-service"
  "session-service services/session-service"
  "frontend frontend"
  "model-config-controller-go services/model-config-controller-go"
)

for item in "${SERVICES[@]}"; do
  name=$(echo "$item" | awk '{print $1}')
  context=$(echo "$item" | awk '{print $2}')
  image="$REGISTRY/$name:$TAG"
  docker build -t "$image" "$ROOT/$context"
  docker push "$image"
done

kubectl apply -k "$ROOT/k8s"

kubectl -n kube-assistant set image deploy/auth-service auth-service="$REGISTRY/auth-service:$TAG"
kubectl -n kube-assistant set image deploy/ai-service ai-service="$REGISTRY/ai-service:$TAG"
kubectl -n kube-assistant set image deploy/k8s-service k8s-service="$REGISTRY/k8s-service:$TAG"
kubectl -n kube-assistant set image deploy/session-service session-service="$REGISTRY/session-service:$TAG"
kubectl -n kube-assistant set image deploy/frontend frontend="$REGISTRY/frontend:$TAG"
kubectl -n kube-assistant set image deploy/model-config-controller-go controller="$REGISTRY/model-config-controller-go:$TAG"
