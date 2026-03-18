#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIND_CLUSTER_NAME="${KIND_CLUSTER_NAME:-kube-assistant}"
NAMESPACE="${NAMESPACE:-kube-assistant}"
IMAGE_TAG="${IMAGE_TAG:-local}"
WAIT="${WAIT:-true}"
DEFAULT_KUBECONFIG_PATH="/tmp/kube-assistant-kubeconfig"

resolve_kubeconfig_path() {
  # Priority:
  # 1) explicit KUBECONFIG_PATH
  # 2) explicit KUBECONFIG (single file path only)
  # 3) repo-local .kubeconfig-kind
  # 4) legacy default path
  if [[ -n "${KUBECONFIG_PATH:-}" ]]; then
    printf '%s\n' "${KUBECONFIG_PATH}"
    return
  fi

  if [[ -n "${KUBECONFIG:-}" && "${KUBECONFIG}" != *:* ]]; then
    printf '%s\n' "${KUBECONFIG}"
    return
  fi

  if [[ -f "${ROOT}/.kubeconfig-kind" ]]; then
    printf '%s\n' "${ROOT}/.kubeconfig-kind"
    return
  fi

  printf '%s\n' "${DEFAULT_KUBECONFIG_PATH}"
}

KUBECONFIG_PATH="$(resolve_kubeconfig_path)"
export KUBECONFIG="${KUBECONFIG_PATH}"

usage() {
  cat <<USAGE
Usage: scripts/rebuild-kind.sh [options] <service...>

Rebuild one or more service images, load into kind, and rollout restart.

Options:
  --all                Rebuild all known services
  --list               List available services
  --tag <tag>           Image tag (default: dev)
  --cluster <name>      Kind cluster name (default: kube-assistant)
  --namespace <ns>      Kubernetes namespace (default: kube-assistant)
  --no-wait             Do not wait for rollout to finish
  -h, --help            Show this help

Examples:
  scripts/rebuild-kind.sh ai-service frontend
  scripts/rebuild-kind.sh --tag dev --cluster kube-assistant tool-server
  scripts/rebuild-kind.sh --all
USAGE
}

list_services() {
  printf '%s\n' "Available services:" \
    "  auth-service" \
    "  ai-service" \
    "  k8s-service" \
    "  session-service (Go)" \
    "  frontend" \
    "  tool-server" \
    "  model-config-controller-go"
}

if ! command -v kind >/dev/null 2>&1; then
  echo "kind is required but not installed." >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required but not installed." >&2
  exit 1
fi

if [[ ! -f "$KUBECONFIG_PATH" ]]; then
  echo "KUBECONFIG not found at ${KUBECONFIG_PATH}." >&2
  echo "Set KUBECONFIG_PATH, or export KUBECONFIG to a single file path, or place .kubeconfig-kind at repo root." >&2
  exit 1
fi

get_context() {
  case "$1" in
    auth-service) echo "services" ;;
    ai-service) echo "services/ai-service" ;;
    k8s-service) echo "services" ;;
    session-service) echo "services" ;;
    frontend) echo "frontend" ;;
    tool-server) echo "services/tool-server" ;;
    model-config-controller-go) echo "services/model-config-controller-go" ;;
    *) echo "" ;;
  esac
}

# Returns a custom Dockerfile path relative to context, if needed.
get_dockerfile() {
  case "$1" in
    auth-service) echo "auth-service-go/Dockerfile" ;;
    session-service) echo "session-service-go/Dockerfile" ;;
    k8s-service) echo "k8s-service-go/Dockerfile" ;;
    *) echo "" ;;
  esac
}

get_deploys() {
  case "$1" in
    auth-service) echo "auth-service" ;;
    ai-service) echo "ai-service" ;;
    k8s-service) echo "k8s-service" ;;
    session-service) echo "session-service" ;;
    frontend) echo "frontend" ;;
    tool-server) echo "tool-server-admin tool-server-read tool-server-write" ;;
    model-config-controller-go) echo "model-config-controller-go" ;;
    *) echo "" ;;
  esac
}

SERVICES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --list)
      list_services
      exit 0
      ;;
    --all)
      SERVICES=("auth-service" "ai-service" "k8s-service" "session-service" "frontend" "tool-server" "model-config-controller-go")
      shift
      ;;
    --tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    --cluster)
      KIND_CLUSTER_NAME="$2"
      shift 2
      ;;
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --no-wait)
      WAIT="false"
      shift
      ;;
    *)
      SERVICES+=("$1")
      shift
      ;;
  esac
done

if [[ ${#SERVICES[@]} -eq 0 ]]; then
  usage
  exit 1
fi

if ! kind get clusters | grep -qx "$KIND_CLUSTER_NAME"; then
  echo "Kind cluster '$KIND_CLUSTER_NAME' not found. Create it first." >&2
  exit 1
fi

build_and_load() {
  local svc="$1"
  local ctx
  ctx="$(get_context "$svc")"
  local image="kube-assistant/${svc}:${IMAGE_TAG}"

  if [[ -z "$ctx" ]]; then
    echo "Unknown service: $svc" >&2
    list_services
    exit 1
  fi

  local dockerfile
  dockerfile="$(get_dockerfile "$svc")"

  echo "═══ Building ${image} ═══"
  if [[ -n "$dockerfile" ]]; then
    docker build -t "$image" -f "$ROOT/$ctx/$dockerfile" "$ROOT/$ctx"
  else
    docker build -t "$image" "$ROOT/$ctx"
  fi
  echo "═══ Loading ${image} into kind (${KIND_CLUSTER_NAME}) ═══"
  kind load docker-image "$image" --name "$KIND_CLUSTER_NAME"

  echo "═══ Rolling out ${svc} ═══"
  local deploys
  deploys="$(get_deploys "$svc")"
  for dep in $deploys; do
    kubectl -n "$NAMESPACE" rollout restart "deploy/${dep}"
    if [[ "$WAIT" == "true" ]]; then
      kubectl -n "$NAMESPACE" rollout status "deploy/${dep}" --timeout=180s
    fi
  done
}

for svc in "${SERVICES[@]}"; do
  build_and_load "$svc"
done

echo "Done."
