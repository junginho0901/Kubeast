#!/usr/bin/env bash
#
# Kubeast Installer — installs the released chart from ghcr.io (OCI) at CHART_VERSION.
#
# Usage — download a tagged copy, read it, then run it (do not pipe an
# unreviewed script into bash):
#   curl -fsSLo install.sh https://raw.githubusercontent.com/junginho0901/Kubeast/v0.7.4/install.sh
#   less install.sh
#   bash install.sh
#
#   # Options:
#   bash install.sh --node-port 30080
#   bash install.sh --load-balancer
#   bash install.sh --namespace my-ns
#   bash install.sh --version 0.7.4
#   bash install.sh --local        # the chart of this checkout (development)
#
set -euo pipefail

# Defaults
NAMESPACE="kubeast"
RELEASE_NAME="kubeast"
CHART_VERSION="0.7.4"   # the release this script belongs to (deploy/dependencies.yaml: kubeast)
CHART_REF="oci://ghcr.io/junginho0901/charts/kubeast"
USE_LOCAL=false
SERVICE_TYPE="NodePort"
NODE_PORT="30333"

# Colors (off when the output is not a terminal or NO_COLOR is set)
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'
  BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
  TTY=true
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; DIM=''; NC=''
  TTY=false
fi

TOTAL_STEPS=4
step()  { printf "\n${BOLD}${CYAN}[%s/%s]${NC} ${BOLD}%s${NC}\n" "$1" "$TOTAL_STEPS" "$2"; }
ok()    { printf "  ${GREEN}✔${NC} %s\n" "$1"; }
info()  { printf "  ${DIM}•${NC} %s\n" "$1"; }
warn()  { printf "  ${YELLOW}!${NC} %s\n" "$1"; }
fail()  { printf "\n  ${RED}✘ %s${NC}\n\n" "$1" >&2; exit 1; }

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
    *) fail "Unknown option: $1 (see --help)" ;;
  esac
done

# Shows the admin password in plain text: kubectl decodes it, so no base64 binary is needed
# and the same line works in PowerShell.
PW_CMD="kubectl -n $NAMESPACE get secret kubeast-secrets -o go-template='{{.data.DEFAULT_ADMIN_PASSWORD | base64decode | println}}'"

printf "\n${CYAN}  ┌──────────────────────────────────────────┐${NC}\n"
printf "${CYAN}  │${NC}  ${BOLD}Kubeast installer${NC}                       ${CYAN}│${NC}\n"
printf "${CYAN}  │${NC}  ${DIM}Kubernetes dashboard + AI assistant${NC}     ${CYAN}│${NC}\n"
printf "${CYAN}  └──────────────────────────────────────────┘${NC}\n"

# ─── 1. Pre-flight checks ───
step 1 "Checking prerequisites"

command -v kubectl >/dev/null 2>&1 || fail "kubectl not found. Install it first: https://kubernetes.io/docs/tasks/tools/"
ok "kubectl found"
command -v helm >/dev/null 2>&1 || fail "helm not found. Install it first: https://helm.sh/docs/intro/install/"
ok "helm found"

kubectl cluster-info --request-timeout=5s >/dev/null 2>&1 || fail "Cannot connect to Kubernetes cluster. Check your kubeconfig."
ok "Cluster reachable (context: $(kubectl config current-context 2>/dev/null || echo unknown))"

# ─── 2. Locate chart ───
# The released chart from ghcr.io carries the image tags of its release. The chart in a git checkout
# does not (the release workflow sets them when it packages), so --local is for development only.
step 2 "Settings"
if [[ "$USE_LOCAL" == true ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || pwd)"
  CHART_PATH="$SCRIPT_DIR/helm/kubeast"
  [ -f "$CHART_PATH/Chart.yaml" ] || fail "No chart at $CHART_PATH (run --local from a Kubeast checkout)."
  VERSION_ARGS=()
  info "Chart:        $CHART_PATH (local)"
else
  CHART_PATH="$CHART_REF"
  VERSION_ARGS=(--version "$CHART_VERSION")
  info "Chart:        $CHART_REF $CHART_VERSION"
fi
info "Namespace:    $NAMESPACE"
info "Service type: $SERVICE_TYPE"
if [[ "$SERVICE_TYPE" == "NodePort" ]]; then
  info "Node port:    $NODE_PORT"
fi

# ─── 3. Install ───
step 3 "Installing — pulling images and starting pods (usually 2–5 minutes)"

HELM_LOG="$(mktemp)"
trap 'rm -f "$HELM_LOG"' EXIT

# Ctrl-C reaches Helm too and it cancels, but this script would return before Helm has marked the release failed: a
# terminal closed then, or a rerun, finds it pending-install ("another operation is in progress"). Wait for Helm, and
# pass TERM on when only this script gets it.
HELM_PID=""
stop_helm() {
  trap - INT TERM
  [[ "$TTY" == true ]] && printf "\r\033[2K"
  if [[ -n "$HELM_PID" ]] && kill -0 "$HELM_PID" 2>/dev/null; then
    printf "\n  Interrupted — stopping Helm...\n"
    kill -TERM "$HELM_PID" 2>/dev/null || true
    wait "$HELM_PID" 2>/dev/null || true
  fi
  exit "$1"
}
trap 'stop_helm 130' INT
trap 'stop_helm 143' TERM

helm upgrade --install "$RELEASE_NAME" "$CHART_PATH" ${VERSION_ARGS[@]+"${VERSION_ARGS[@]}"} \
  --namespace "$NAMESPACE" --create-namespace \
  --set gateway.service.type="$SERVICE_TYPE" \
  --set gateway.service.nodePort="$NODE_PORT" \
  --set auth.cookieSecure=false \
  --wait --timeout 5m \
  >"$HELM_LOG" 2>&1 &
HELM_PID=$!

# "<ready> <total>" over the pods still meant to run (finished jobs are left out).
pod_progress() {
  { kubectl -n "$NAMESPACE" get pods --no-headers 2>/dev/null || true; } | awk '
    $3 == "Completed" || $3 == "Terminating" { next }
    { total++; split($2, r, "/"); if ($3 == "Running" && r[1] == r[2]) ready++ }
    END { printf "%d %d", ready + 0, total + 0 }'
}

FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
START=$(date +%s)
TICK=0
LAST=""
while kill -0 "$HELM_PID" 2>/dev/null; do
  read -r READY TOTAL <<<"$(pod_progress)"
  ELAPSED=$(( $(date +%s) - START ))
  if [[ "$TTY" == true ]]; then
    FILLED=0
    (( TOTAL > 0 )) && FILLED=$(( READY * 20 / TOTAL ))
    BAR="$(printf '%*s' "$FILLED" '' | tr ' ' '#')$(printf '%*s' $(( 20 - FILLED )) '' | tr ' ' '.')"
    printf "\r\033[2K  ${CYAN}%s${NC} [%s] pods ready %s/%s  ${DIM}%dm %02ds${NC}" \
      "${FRAMES[TICK % 10]}" "$BAR" "$READY" "$TOTAL" $(( ELAPSED / 60 )) $(( ELAPSED % 60 ))
    TICK=$(( TICK + 1 ))
    sleep 1
  else
    if [[ "$READY/$TOTAL" != "$LAST" ]]; then
      info "pods ready $READY/$TOTAL"
      LAST="$READY/$TOTAL"
    fi
    sleep 5
  fi
done
[[ "$TTY" == true ]] && printf "\r\033[2K"

set +e
wait "$HELM_PID"
HELM_RC=$?
set -e

if (( HELM_RC != 0 )); then
  printf "  ${RED}✘ Install failed.${NC} Helm said:\n\n"
  tail -n 20 "$HELM_LOG" | sed 's/^/    /'
  printf "\n  Pods that are not ready:\n\n"
  kubectl -n "$NAMESPACE" get pods 2>/dev/null | awk '
    NR == 1 { print "    " $0; next }
    $3 == "Completed" { next }
    { split($2, r, "/"); if ($3 != "Running" || r[1] != r[2]) print "    " $0 }' || true
  printf "\n  Look closer with: ${BOLD}kubectl -n %s describe pod <name>${NC}\n\n" "$NAMESPACE"
  exit 1
fi
ok "All pods ready"

# ─── 4. Access info ───
step 4 "Looking up the address and the admin password"

URL=""
if [[ "$SERVICE_TYPE" == "NodePort" ]]; then
  NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || echo "")
  URL="http://${NODE_IP:-localhost}:${NODE_PORT}"
  # Docker Desktop, kind on macOS/Windows and the like publish NodePorts on localhost, and
  # their node IP is not reachable from this machine: print the address that answers.
  if command -v curl >/dev/null 2>&1; then
    ANSWERED=false
    for HOST in ${NODE_IP:+"$NODE_IP"} localhost; do
      if curl -s -o /dev/null --max-time 3 "http://${HOST}:${NODE_PORT}/"; then
        URL="http://${HOST}:${NODE_PORT}"
        ANSWERED=true
        break
      fi
    done
    [[ "$ANSWERED" == true ]] || warn "Neither the node IP nor localhost answered from here. If the address does not open, run: kubectl -n $NAMESPACE port-forward svc/gateway 8000:8000 and open http://localhost:8000"
  fi
elif [[ "$SERVICE_TYPE" == "LoadBalancer" ]]; then
  info "Waiting for the LoadBalancer address..."
  for _ in $(seq 1 30); do
    LB_IP=$(kubectl get svc gateway -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
    LB_HOST=$(kubectl get svc gateway -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")
    if [[ -n "$LB_IP" || -n "$LB_HOST" ]]; then
      URL="http://${LB_IP:-$LB_HOST}:8000"
      break
    fi
    sleep 2
  done
  [[ -n "$URL" ]] || warn "No address yet. Check later: kubectl -n $NAMESPACE get svc gateway"
else
  URL="http://localhost:8000"
fi

ADMIN_PW=$(kubectl -n "$NAMESPACE" get secret kubeast-secrets \
  -o go-template='{{.data.DEFAULT_ADMIN_PASSWORD | base64decode}}' 2>/dev/null || echo "")
ok "Done"

LINE="════════════════════════════════════════════════════════════"
printf "\n${GREEN}%s${NC}\n" "$LINE"
printf "  ${GREEN}${BOLD}✔ Kubeast is ready${NC}\n"
printf "${GREEN}%s${NC}\n\n" "$LINE"

if [[ "$SERVICE_TYPE" == "ClusterIP" ]]; then
  printf "  ${BOLD}Port-forward${NC}  kubectl port-forward svc/gateway 8000:8000 -n %s\n" "$NAMESPACE"
  printf "  ${BOLD}Then open${NC}     ${CYAN}%s${NC}\n\n" "$URL"
elif [[ -n "$URL" ]]; then
  printf "  ${BOLD}Open${NC}          ${CYAN}%s${NC}\n\n" "$URL"
fi

printf "  ${BOLD}Sign in${NC}\n"
printf "    ID            ${BOLD}admin${NC}\n"
if [[ -n "$ADMIN_PW" ]]; then
  printf "    Password      ${BOLD}${YELLOW}%s${NC}\n" "$ADMIN_PW"
  printf "                  ${DIM}generated at install — copy it as shown, then change it after signing in${NC}\n"
else
  printf "    Password      ${YELLOW}could not be read — run the command below${NC}\n"
fi
printf "\n  ${DIM}Show the password again (bash or PowerShell):${NC}\n"
printf "    %s\n" "$PW_CMD"

printf "\n  ${BOLD}Next steps${NC}\n"
printf "    1. Open the address above and sign in as admin\n"
printf "    2. Change the admin password\n"
printf "    3. Connect a cluster — the setup screen opens by itself while none is registered\n"
printf "    4. Add an AI provider in Admin > AI Models to turn on the chat\n"

printf "\n  ${DIM}Uninstall: helm uninstall %s -n %s${NC}\n\n" "$RELEASE_NAME" "$NAMESPACE"
