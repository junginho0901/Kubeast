#!/usr/bin/env bash
# Local dev loop on kind: build the images, load them into the cluster, and install (or upgrade) Kubeast
# from the Helm chart with deploy/kind/values.yaml — the same chart every real install uses, so the dev
# cluster carries the chart's defaults (security contexts, generated secrets, migrations) and there is
# no second copy of the manifests to keep in step.
#
#   scripts/kind-deploy.sh                 # create the cluster if needed, build, load, install/upgrade
#   SKIP_BUILD=true scripts/kind-deploy.sh # reuse the images already built
#   KIND_CLUSTER_NAME=kubeast-dev2 KIND_HOST_PORT=30081 scripts/kind-deploy.sh   # a second cluster
#
# After the first install: http://localhost:30080, admin password =
#   kubectl -n kubeast get secret kubeast-secrets -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' | base64 -d
# Day-to-day rebuilds of one service: scripts/rebuild-kind.sh <service>.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-kubeast}"
KIND_HOST_PORT="${KIND_HOST_PORT:-30080}"
NAMESPACE="${NAMESPACE:-kubeast}"
RELEASE="${RELEASE:-kubeast}"
IMAGE_TAG="${IMAGE_TAG:-local}"
SKIP_BUILD="${SKIP_BUILD:-false}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT/.kubeconfig-kind}"
VALUES="$ROOT/deploy/kind/values.yaml"
LOCAL_VALUES="$ROOT/deploy/kind/values.local.yaml"
export KUBECONFIG="$KUBECONFIG_PATH"

for tool in kind kubectl helm docker; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 1; }
done

# 1. The cluster (idempotent). The kubeconfig is merged into .kubeconfig-kind (other kind contexts in
# that file are kept), which rebuild-kind.sh prefers.
# (grep without -q: under pipefail, -q can close the pipe before kind has written, and the
# SIGPIPE'd kind makes the whole test fail as "no cluster".)
if ! kind get clusters 2>/dev/null | grep -x "$KIND_CLUSTER_NAME" >/dev/null; then
  KIND_CONFIG="$(mktemp)"
  sed "s#__KIND_HOST_PORT__#${KIND_HOST_PORT}#g" "$ROOT/kind-config.yaml" > "$KIND_CONFIG"
  kind create cluster --name "$KIND_CLUSTER_NAME" --config "$KIND_CONFIG" --kubeconfig "$KUBECONFIG_PATH"
  rm -f "$KIND_CONFIG"
else
  kind export kubeconfig --name "$KIND_CLUSTER_NAME" --kubeconfig "$KUBECONFIG_PATH"
fi

# 2. Service images: name, build context, Dockerfile relative to the context ("" = context default).
IMAGES=(
  "auth-service:services:auth-service-go/Dockerfile"
  "k8s-service:services:k8s-service-go/Dockerfile"
  "session-service:services:session-service-go/Dockerfile"
  "tool-server:services:tool-server/Dockerfile"
  "ai-service:services/ai-service:"
  "frontend:frontend:"
  "model-config-controller-go:services/model-config-controller-go:"
)
for entry in "${IMAGES[@]}"; do
  IFS=':' read -r name ctx dockerfile <<< "$entry"
  image="kubeast/${name}:${IMAGE_TAG}"
  if [[ "$SKIP_BUILD" != "true" ]]; then
    echo "═══ Building ${image} ═══"
    if [[ -n "$dockerfile" ]]; then
      docker build ${DOCKER_BUILD_ARGS:-} -t "$image" -f "$ROOT/$ctx/$dockerfile" "$ROOT/$ctx"
    else
      docker build ${DOCKER_BUILD_ARGS:-} -t "$image" "$ROOT/$ctx"
    fi
  fi
  kind load docker-image "$image" --name "$KIND_CLUSTER_NAME"
done

# 3. The chart's other images (postgres, redis, the gateway's nginx) and the dev tools' (S3 stand-in,
# mail catcher, webhook receiver): a kind node pulls them from the registry on its own; where it cannot
# (a proxy), take them from the host's docker. `kind load` imports with --all-platforms, which fails for
# multi-arch images that only have the host platform locally, so the saved image is imported directly.
{ helm template "$RELEASE" "$ROOT/helm/kubeast" -n "$NAMESPACE" -f "$VALUES" 2>/dev/null; cat "$ROOT/deploy/kind/devtools.yaml"; } \
  | sed -n 's/^ *image: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' | sort -u | grep -v "^kubeast/" \
  | while IFS= read -r image; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      echo "═══ Importing ${image} from the host ═══"
      docker save "$image" | docker exec --privileged -i "${KIND_CLUSTER_NAME}-control-plane" \
        ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
    else
      echo "    ${image}: not on the host, the node will pull it"
    fi
  done

# 4. The dev tools the dev audit sinks point at (deploy/kind/devtools.yaml). Before the chart: the dev-s3
# sink's Secret lives in the release namespace and auth-service mounts it.
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# the bucket Job is re-run safe; drop the finished one so a changed spec applies (a Job's template is immutable)
kubectl -n kubeast-devtools delete job s3-bucket --ignore-not-found >/dev/null 2>&1 || true
kubectl apply -f "$ROOT/deploy/kind/devtools.yaml" >/dev/null

# 5. Install or upgrade from the chart. --wait fails loudly when a pod never becomes ready.
echo "═══ helm upgrade --install ${RELEASE} (${NAMESPACE}) ═══"
helm upgrade --install "$RELEASE" "$ROOT/helm/kubeast" -n "$NAMESPACE" --create-namespace \
  -f "$VALUES" $( [[ -f "$LOCAL_VALUES" ]] && printf -- '-f %q' "$LOCAL_VALUES" ) \
  --set global.imageTag="$IMAGE_TAG" --wait --timeout 10m

echo "═══ Done ═══"
echo "  URL:   http://localhost:${KIND_HOST_PORT}"
echo "  admin: kubectl -n ${NAMESPACE} get secret kubeast-secrets -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' | base64 -d"
echo "  demo:  read / read · write / write"
