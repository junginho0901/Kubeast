#!/usr/bin/env bash
#
# Kubeast Installer — installs the released chart from ghcr.io (OCI) at CHART_VERSION.
#
# Usage — download a tagged copy, read it, then run it (do not pipe an
# unreviewed script into bash):
#   curl -fsSLo install.sh https://raw.githubusercontent.com/junginho0901/Kubeast/v0.7.3/install.sh
#   less install.sh
#   bash install.sh
#
#   # Options:
#   bash install.sh --node-port 30080
#   bash install.sh --load-balancer
#   bash install.sh --namespace my-ns
#   bash install.sh --version 0.7.3
#   bash install.sh --local        # the chart of this checkout (development)
#
set -euo pipefail

# Defaults
NAMESPACE="kubeast"
RELEASE_NAME="kubeast"
CHART_VERSION="0.7.3"   # the release this script belongs to (deploy/dependencies.yaml: kubeast)
CHART_REF="oci://ghcr.io/junginho0901/charts/kubeast"
USE_LOCAL=false
SERVICE_TYPE="NodePort"
NODE_PORT="30333"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[kubeast]${NC} $1"; }
ok()    { echo -e "${GREEN}[kubeast]${NC} $1"; }
warn()  { echo -e "${YELLOW}[kubeast]${NC} $1"; }
fail()  { echo -e "${RED}[kubeast]${NC} $1"; exit 1; }

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)     NAMESPACE="$2"; shift 2 ;;
    --node-port)     NODE_PORT="$2"; shift 2 ;;
    --load-balancer) SERVICE_TYPE="LoadBalancer"; shift ;;
    --cluster-ip)    SERVICE_TYPE="ClusterIP"; shift ;;
    --version)       CHART_VERSION="$2"; shift 2 ;;
    --local)         USE_LOCAL=true; shift ;;
    --help|-h)
      echo "Kubeast Installer"
      echo ""
      echo "Usage: bash install.sh [OPTIONS]   (download a tagged install.sh and read it first)"
      echo ""
      echo "Options:"
      echo "  --namespace <ns>     Namespace (default: kubeast)"
      echo "  --node-port <port>   NodePort number (default: 30333)"
      echo "  --load-balancer      Use LoadBalancer instead of NodePort"
      echo "  --cluster-ip         Use ClusterIP (for use with ingress)"
      echo "  --version <ver>      Chart version (default: $CHART_VERSION)"
      echo "  --local              Install the chart of this checkout (development; its images are not the release)"
      echo "  -h, --help           Show this help"
      exit 0
      ;;
    *) fail "Unknown option: $1" ;;
  esac
done

# ─── Pre-flight checks ───
info "Checking prerequisites..."

command -v kubectl >/dev/null 2>&1 || fail "kubectl not found. Install it first: https://kubernetes.io/docs/tasks/tools/"
command -v helm >/dev/null 2>&1 || fail "helm not found. Install it first: https://helm.sh/docs/intro/install/"

kubectl cluster-info --request-timeout=5s >/dev/null 2>&1 || fail "Cannot connect to Kubernetes cluster. Check your kubeconfig."
ok "Kubernetes cluster reachable"

# ─── Locate chart ───
# The released chart from ghcr.io carries the image tags of its release. The chart in a git checkout
# does not (the release workflow sets them when it packages), so --local is for development only.
if [[ "$USE_LOCAL" == true ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || pwd)"
  CHART_PATH="$SCRIPT_DIR/helm/kubeast"
  [ -f "$CHART_PATH/Chart.yaml" ] || fail "No chart at $CHART_PATH (run --local from a Kubeast checkout)."
  VERSION_ARGS=()
  ok "Using local chart at $CHART_PATH"
else
  CHART_PATH="$CHART_REF"
  VERSION_ARGS=(--version "$CHART_VERSION")
  info "Chart: $CHART_REF $CHART_VERSION"
fi

# ─── Install ───
echo ""
echo -e "${BOLD}Installing Kubeast...${NC}"
echo -e "  Namespace:    ${CYAN}${NAMESPACE}${NC}"
echo -e "  Service type: ${CYAN}${SERVICE_TYPE}${NC}"
if [[ "$SERVICE_TYPE" == "NodePort" ]]; then
  echo -e "  Node port:    ${CYAN}${NODE_PORT}${NC}"
fi
echo ""

helm upgrade --install "$RELEASE_NAME" "$CHART_PATH" ${VERSION_ARGS[@]+"${VERSION_ARGS[@]}"} \
  --namespace "$NAMESPACE" --create-namespace \
  --set gateway.service.type="$SERVICE_TYPE" \
  --set gateway.service.nodePort="$NODE_PORT" \
  --set auth.cookieSecure=false \
  --wait --timeout 5m \
  2>&1

echo ""
ok "Kubeast installed successfully!"
echo ""

# ─── Access info ───
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Kubeast is ready!                       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

if [[ "$SERVICE_TYPE" == "NodePort" ]]; then
  NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || echo "localhost")
  echo -e "  Open: ${BOLD}http://${NODE_IP}:${NODE_PORT}${NC}  (admin 로그인 뒤 클러스터가 없으면 /setup 으로 이동)"
elif [[ "$SERVICE_TYPE" == "LoadBalancer" ]]; then
  echo "  Waiting for LoadBalancer IP..."
  for i in $(seq 1 30); do
    LB_IP=$(kubectl get svc gateway -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
    LB_HOST=$(kubectl get svc gateway -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
    if [[ -n "$LB_IP" ]]; then
      echo -e "  Open: ${BOLD}http://${LB_IP}:8000${NC}"
      break
    elif [[ -n "$LB_HOST" ]]; then
      echo -e "  Open: ${BOLD}http://${LB_HOST}:8000${NC}"
      break
    fi
    sleep 2
  done
else
  echo -e "  Port-forward: ${BOLD}kubectl port-forward svc/gateway 8000:8000 -n ${NAMESPACE}${NC}"
  echo -e "  Then open:    ${BOLD}http://localhost:8000${NC}"
fi

echo ""
ADMIN_PW=$(kubectl -n "$NAMESPACE" get secret kubeast-secrets \
  -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
echo "  Default account:"
echo "    ID:       admin"
if [[ -n "$ADMIN_PW" ]]; then
  echo -e "    Password: ${BOLD}${ADMIN_PW}${NC}"
  echo -e "    ${YELLOW}⚠ 로그인 후 즉시 비밀번호를 변경하세요.${NC}"
else
  echo "    Password: <secret 조회 실패 — 아래 명령으로 직접 확인>"
  echo "      kubectl -n $NAMESPACE get secret kubeast-secrets \\"
  echo "        -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' | base64 -d ; echo"
fi
echo ""
echo "  Next steps:"
echo "    1. Open the URL above"
echo "    2. Connect your cluster"
echo "    3. Sign in with admin account"
echo "    4. Go to Admin > AI Models to add your AI provider"
echo ""
echo -e "  Uninstall: ${CYAN}helm uninstall kubeast -n ${NAMESPACE}${NC}"
echo ""
