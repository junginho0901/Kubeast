#!/usr/bin/env bash
#
# Kubest Installer
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/junginho0901/Kubeast/main/install.sh | bash
#
#   # Or with options:
#   curl -sSL ... | bash -s -- --node-port 30080
#   curl -sSL ... | bash -s -- --load-balancer
#   curl -sSL ... | bash -s -- --namespace my-ns
#
set -euo pipefail

# Defaults
NAMESPACE="kubeast"
RELEASE_NAME="kubeast"
CHART_VERSION="0.1.0"
SERVICE_TYPE="NodePort"
NODE_PORT="30333"
REPO_URL="https://github.com/junginho0901/Kubeast"

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
    --help|-h)
      echo "Kubest Installer"
      echo ""
      echo "Usage: curl -sSL <url>/install.sh | bash -s -- [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --namespace <ns>     Namespace (default: kubeast)"
      echo "  --node-port <port>   NodePort number (default: 30333)"
      echo "  --load-balancer      Use LoadBalancer instead of NodePort"
      echo "  --cluster-ip         Use ClusterIP (for use with ingress)"
      echo "  --version <ver>      Chart version (default: $CHART_VERSION)"
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
# 스크립트가 clone 된 repo 안에서 실행되면 로컬 차트를 사용하고,
# `curl | bash` 처럼 단독 실행되면 원격에서 다운로드한다.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || pwd)"
LOCAL_CHART="$SCRIPT_DIR/helm/kubeast"

if [ -f "$LOCAL_CHART/Chart.yaml" ]; then
  CHART_PATH="$LOCAL_CHART"
  ok "Using local chart at $LOCAL_CHART"
else
  info "Downloading Kubest Helm chart..."

  TMPDIR=$(mktemp -d)
  trap "rm -rf $TMPDIR" EXIT

  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "v${CHART_VERSION}" "$REPO_URL.git" "$TMPDIR/kubeast" 2>/dev/null || \
    git clone --depth 1 "$REPO_URL.git" "$TMPDIR/kubeast" 2>/dev/null || \
    fail "Failed to download chart. Check your internet connection."
  else
    curl -sSL "$REPO_URL/archive/refs/heads/main.tar.gz" -o "$TMPDIR/kubeast.tar.gz" || fail "Failed to download chart."
    tar -xzf "$TMPDIR/kubeast.tar.gz" -C "$TMPDIR"
    # GitHub archive 디렉토리명은 저장소 이름과 동일 (대소문자 그대로)
    mv "$TMPDIR"/Kubeast-main "$TMPDIR/kubeast" 2>/dev/null || \
    mv "$TMPDIR"/kubeast-main "$TMPDIR/kubeast" 2>/dev/null || true
  fi

  CHART_PATH="$TMPDIR/kubeast/helm/kubeast"
  [ -f "$CHART_PATH/Chart.yaml" ] || fail "Chart not found in downloaded files."
  ok "Chart downloaded"
fi

# ─── Install ───
echo ""
echo -e "${BOLD}Installing Kubest...${NC}"
echo -e "  Namespace:    ${CYAN}${NAMESPACE}${NC}"
echo -e "  Service type: ${CYAN}${SERVICE_TYPE}${NC}"
if [[ "$SERVICE_TYPE" == "NodePort" ]]; then
  echo -e "  Node port:    ${CYAN}${NODE_PORT}${NC}"
fi
echo ""

helm upgrade --install "$RELEASE_NAME" "$CHART_PATH" \
  --namespace "$NAMESPACE" --create-namespace \
  --set gateway.service.type="$SERVICE_TYPE" \
  --set gateway.service.nodePort="$NODE_PORT" \
  --wait --timeout 5m \
  2>&1

echo ""
ok "Kubest installed successfully!"
echo ""

# ─── Access info ───
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Kubest is ready!                        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

if [[ "$SERVICE_TYPE" == "NodePort" ]]; then
  NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || echo "localhost")
  echo -e "  Open: ${BOLD}http://${NODE_IP}:${NODE_PORT}/setup${NC}"
elif [[ "$SERVICE_TYPE" == "LoadBalancer" ]]; then
  echo "  Waiting for LoadBalancer IP..."
  for i in $(seq 1 30); do
    LB_IP=$(kubectl get svc gateway -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
    LB_HOST=$(kubectl get svc gateway -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
    if [[ -n "$LB_IP" ]]; then
      echo -e "  Open: ${BOLD}http://${LB_IP}:8000/setup${NC}"
      break
    elif [[ -n "$LB_HOST" ]]; then
      echo -e "  Open: ${BOLD}http://${LB_HOST}:8000/setup${NC}"
      break
    fi
    sleep 2
  done
else
  echo -e "  Port-forward: ${BOLD}kubectl port-forward svc/gateway 8000:8000 -n ${NAMESPACE}${NC}"
  echo -e "  Then open:    ${BOLD}http://localhost:8000/setup${NC}"
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
