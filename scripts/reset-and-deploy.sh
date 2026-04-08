#!/usr/bin/env bash
#
# reset-and-deploy.sh — 완전 초기화 + 빌드 + 배포 스크립트
#
# Kind 클러스터를 삭제하고 처음부터 다시 만듭니다.
# DB도 완전히 깨끗한 상태이며, 기본 계정(admin/read/write)만 존재합니다.
#
# Usage:
#   ./scripts/reset-and-deploy.sh          # 전체 초기화 (Kind 삭제 + 재생성)
#   ./scripts/reset-and-deploy.sh --keep   # Kind 유지, DB만 초기화 + 재빌드
#   ./scripts/reset-and-deploy.sh --db     # DB만 초기화 (빌드 스킵)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIND_NAME="kube-assistant"
NS="kube-assistant"
KUBECONFIG_PATH="/tmp/kube-assistant-kubeconfig"
TAG="local"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}═══ $1 ═══${NC}"; }
ok()   { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

MODE="${1:-full}"

# ~/.kube/config이 디렉토리인 경우 Kind가 실패하므로 별도 kubeconfig 경로를 미리 지정
export KUBECONFIG="$KUBECONFIG_PATH"

# ═══════════════════════════════════════════════════
# 1. Kind 클러스터 관리
# ═══════════════════════════════════════════════════
if [[ "$MODE" == "--db" ]]; then
  step "DB-only reset (skip build)"
elif [[ "$MODE" == "--keep" ]]; then
  step "Keep Kind, rebuild + redeploy"
else
  step "Full reset — destroying Kind cluster"

  # 기존 Kind 데이터 삭제
  if kind get clusters 2>/dev/null | grep -qx "$KIND_NAME"; then
    kind delete cluster --name "$KIND_NAME"
    ok "Deleted Kind cluster"
  else
    warn "No existing cluster found"
  fi

  # Postgres 영구 데이터 삭제 (root 소유 파일일 수 있으므로 sudo 사용)
  if [[ -d "$ROOT/.kind-data/postgres" ]]; then
    rm -rf "$ROOT/.kind-data/postgres" 2>/dev/null || sudo rm -rf "$ROOT/.kind-data/postgres" 2>/dev/null || true
    ok "Cleaned postgres data"
  fi
  mkdir -p "$ROOT/.kind-data/postgres"

  # Kind 클러스터 재생성
  step "Creating Kind cluster"
  kind create cluster --name "$KIND_NAME" --config "$ROOT/kind-config.yaml"
  ok "Kind cluster created"

  # kubeconfig 저장
  kind get kubeconfig --name "$KIND_NAME" > "$KUBECONFIG_PATH"
  ok "Kubeconfig saved to $KUBECONFIG_PATH"
fi

# 클러스터 접근 확인
kubectl cluster-info --request-timeout=10s > /dev/null 2>&1 || fail "Cannot reach cluster"
ok "Cluster reachable"

# ═══════════════════════════════════════════════════
# 2. DB 초기화 (--keep / --db 모드)
# ═══════════════════════════════════════════════════
if [[ "$MODE" == "--keep" || "$MODE" == "--db" ]]; then
  step "Resetting database"

  # Postgres Pod 확인
  PG_POD=$(kubectl get pod -n "$NS" -l app=postgres -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [[ -z "$PG_POD" ]]; then
    fail "Postgres pod not found in namespace $NS"
  fi

  # 모든 테이블 데이터 삭제 (순서 중요: FK 의존성)
  kubectl exec -n "$NS" "$PG_POD" -- psql -U kubest -d kubest -c "
    -- AI service tables
    DELETE FROM session_contexts;
    DELETE FROM messages;
    DELETE FROM sessions;
    DELETE FROM model_configs;

    -- Auth service tables
    DELETE FROM auth_audit_logs;
    DELETE FROM auth_users;
    DELETE FROM cluster_setup;
  " 2>&1 || warn "Some tables may not exist (first run?)"
  ok "Database cleared"

  # K8s에 남아있는 클러스터 관련 리소스 정리
  step "Cleaning up K8s cluster resources"

  # 클러스터 등록 시 생성된 kubeconfig 시크릿 삭제 (k8s-kubeconfig, k8s-kubeconfig-<uuid>)
  KUBE_SECRETS=$(kubectl get secrets -n "$NS" -o name 2>/dev/null | grep "k8s-kubeconfig" || true)
  if [[ -n "$KUBE_SECRETS" ]]; then
    echo "$KUBE_SECRETS" | xargs kubectl delete -n "$NS" 2>/dev/null || true
    ok "Deleted kubeconfig secrets: $(echo $KUBE_SECRETS | tr '\n' ' ')"
  else
    warn "No kubeconfig secrets found"
  fi

  # 클러스터 목록 ConfigMap 삭제
  kubectl delete configmap kube-assistant-clusters -n "$NS" --ignore-not-found 2>/dev/null
  ok "Deleted cluster registry ConfigMap"

  # auth-service 재시작하면 기본 계정 자동 생성됨
  kubectl rollout restart deployment/auth-service -n "$NS" 2>/dev/null || true
  ok "Auth-service will recreate bootstrap accounts on startup"

  if [[ "$MODE" == "--db" ]]; then
    # DB 초기화만 하는 경우: 모든 서비스 재시작
    step "Restarting all services"
    kubectl rollout restart deployment/auth-service deployment/ai-service \
      deployment/frontend deployment/k8s-service \
      deployment/session-service -n "$NS" 2>/dev/null || true
    # tool-server도 재시작 (kubeconfig 시크릿 삭제됨)
    kubectl rollout restart deployment/tool-server -n "$NS" 2>/dev/null || true
    kubectl rollout status deployment/auth-service deployment/ai-service \
      deployment/frontend -n "$NS" --timeout=90s 2>/dev/null || warn "Some deployments slow"
    ok "All services restarted"

    # auth-service의 DB 초기화 완료 대기
    step "Waiting for auth-service DB initialization"
    echo -n "  Waiting for auth-service to initialize database..."
    for i in $(seq 1 30); do
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:30080/api/v1/auth/setup" 2>/dev/null || echo "000")
      if [[ "$HTTP_CODE" == "200" ]]; then
        ok "Auth-service DB initialized (HTTP $HTTP_CODE)"
        break
      fi
      if [[ $i -eq 30 ]]; then
        warn "Auth-service DB initialization timeout (got HTTP $HTTP_CODE)"
        echo "    This may be normal if postgres was not fully reset."
        echo "    Try accessing http://localhost:30080/setup manually."
        break
      fi
      echo -n "."
      sleep 2
    done

    step "Done! Access http://localhost:30080/setup"
    echo ""
    echo "  Accounts:"
    echo "    admin@local / admin  (admin)"
    echo "    read@local  / read   (read)"
    echo "    write@local / write  (write)"
    echo ""
    exit 0
  fi
fi

# ═══════════════════════════════════════════════════
# 3. Docker 이미지 빌드
# ═══════════════════════════════════════════════════
step "Building Docker images"

# format: name:context[:dockerfile]
IMAGES=(
  "auth-service:services:auth-service-go/Dockerfile"
  "ai-service:services/ai-service"
  "k8s-service:services:k8s-service-go/Dockerfile"
  "session-service:services:session-service-go/Dockerfile"
  "frontend:frontend"
  "tool-server:services/tool-server"
  "model-config-controller-go:services/model-config-controller-go"
)

BUILT_IMAGES=()
for entry in "${IMAGES[@]}"; do
  IFS=':' read -r name ctx dockerfile <<< "$entry"
  img="kube-assistant/${name}:${TAG}"
  echo -e "  Building ${YELLOW}${img}${NC} ..."
  if [[ -n "$dockerfile" ]]; then
    docker build -t "$img" -f "$ROOT/$ctx/$dockerfile" "$ROOT/$ctx" 2>&1 | tail -1
  else
    docker build -t "$img" "$ROOT/$ctx" 2>&1 | tail -1
  fi
  BUILT_IMAGES+=("$img")
  ok "$img"
done

# ═══════════════════════════════════════════════════
# 4. Kind에 이미지 로드
# ═══════════════════════════════════════════════════
step "Loading images into Kind"
kind load docker-image "${BUILT_IMAGES[@]}" --name "$KIND_NAME"
ok "All images loaded"

# ═══════════════════════════════════════════════════
# 5. Kubernetes 리소스 배포
# ═══════════════════════════════════════════════════
step "Applying Kubernetes manifests"
kubectl apply -k "$ROOT/k8s" 2>&1 | grep -E "^(namespace|configmap|secret|deployment|service|clusterrole)" || true
ok "Base manifests applied"

# local secret 덮어쓰기
if [[ -f "$ROOT/k8s/secret.local.yaml" ]]; then
  kubectl apply -f "$ROOT/k8s/secret.local.yaml" -n "$NS"
  ok "Local secrets applied"
fi

# ═══════════════════════════════════════════════════
# 6. 이미지 태그 패치 (yaml은 :local, 실제는 :dev)
# ═══════════════════════════════════════════════════
step "Patching image tags to :${TAG}"

for name in auth-service ai-service k8s-service session-service frontend; do
  kubectl set image "deployment/${name}" "${name}=kube-assistant/${name}:${TAG}" -n "$NS" 2>/dev/null || true
done
# tool-server: 단일 deployment
kubectl set image "deployment/tool-server" "tool-server=kube-assistant/tool-server:${TAG}" -n "$NS" 2>/dev/null || true
# model-config-controller-go (container name = controller)
kubectl set image "deployment/model-config-controller-go" \
  "controller=kube-assistant/model-config-controller-go:${TAG}" -n "$NS" 2>/dev/null || true

ok "Image tags patched"

# ═══════════════════════════════════════════════════
# 7. 순서 보장: auth/ai 먼저 내려두고 DB 준비 후 기동
# ═══════════════════════════════════════════════════
step "Scaling down auth/ai for ordered startup"
kubectl scale deployment/auth-service deployment/ai-service -n "$NS" --replicas=0 2>/dev/null || true
ok "Scaled down auth/ai"

step "Rolling out remaining deployments"
DEPLOYMENTS=$(kubectl get deploy -n "$NS" -o jsonpath='{.items[*].metadata.name}')
for d in $DEPLOYMENTS; do
  if [[ "$d" == "auth-service" || "$d" == "ai-service" ]]; then
    continue
  fi
  kubectl rollout restart "deployment/${d}" -n "$NS" 2>/dev/null || true
done

# Postgres 먼저 대기
step "Waiting for postgres"
echo -n "  Waiting for postgres..."
kubectl rollout status "deployment/postgres" -n "$NS" --timeout=120s 2>/dev/null && echo -e " ${GREEN}✓${NC}" || echo -e " ${YELLOW}slow${NC}"

# Postgres HBA 설정 (Pod CIDR 접근 허용) — auth-service가 DB에 붙지 못하는 문제 방지
step "Configuring postgres pg_hba.conf"
PG_POD=$(kubectl get pod -n "$NS" -l app=postgres -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [[ -n "$PG_POD" ]]; then
  kubectl exec -n "$NS" "$PG_POD" -- sh -c "
    grep -q '0.0.0.0/0' /var/lib/postgresql/data/pg_hba.conf || echo 'host all all 0.0.0.0/0 scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf
    grep -q '::/0' /var/lib/postgresql/data/pg_hba.conf || echo 'host all all ::/0 scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf
  " >/dev/null 2>&1 || true
  kubectl exec -n "$NS" "$PG_POD" -- psql -U kubest -d postgres -c "SELECT pg_reload_conf();" >/dev/null 2>&1 || true
  ok "pg_hba.conf updated"
else
  warn "Postgres pod not found for pg_hba.conf update"
fi

# Postgres 데이터가 남아있으면 kubest DB가 없을 수 있으므로 안전하게 생성
step "Ensuring kubest database exists"
PG_POD=""
for attempt in $(seq 1 10); do
  PG_POD=$(kubectl get pod -n "$NS" -l app=postgres -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [[ -n "$PG_POD" ]]; then
    # Pod Ready 상태인지 확인
    kubectl exec -n "$NS" "$PG_POD" -- pg_isready -U kubest 2>/dev/null && break
  fi
  echo "  Waiting for postgres to be ready... (attempt $attempt/10)"
  sleep 3
done

if [[ -n "$PG_POD" ]]; then
  DB_EXISTS=$(kubectl exec -n "$NS" "$PG_POD" -- psql -U kubest -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='kubest'" 2>/dev/null || echo "")
  if [[ "$DB_EXISTS" != "1" ]]; then
    kubectl exec -n "$NS" "$PG_POD" -- psql -U kubest -d postgres -c "CREATE DATABASE kubest;" 2>/dev/null
    ok "Created kubest database"
  else
    ok "kubest database already exists"
  fi
else
  fail "Postgres pod not found"
fi

# auth-service는 DB/HBA 준비 후에 기동 (순서 보장)
step "Starting auth-service after DB/HBA setup"
kubectl scale deployment/auth-service -n "$NS" --replicas=1 2>/dev/null || true
kubectl rollout status deployment/auth-service -n "$NS" --timeout=120s 2>/dev/null || warn "auth-service rollout slow"

# 나머지 핵심 서비스 대기 (프런트/게이트웨이/클러스터 서비스)
step "Waiting for core services"
for d in frontend gateway k8s-service; do
  echo -n "  Waiting for $d..."
  kubectl rollout status "deployment/${d}" -n "$NS" --timeout=120s 2>/dev/null && echo -e " ${GREEN}✓${NC}" || echo -e " ${YELLOW}slow${NC}"
done

# auth-service DB 초기화 완료 대기 (순서 보장)
step "Waiting for auth-service DB initialization"
echo -n "  Waiting for auth-service to initialize database..."
RESTARTED_AUTH=0
for i in $(seq 1 60); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:30080/api/v1/auth/setup" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    ok "Auth-service DB initialized (HTTP $HTTP_CODE)"
    break
  fi
  if [[ "$HTTP_CODE" == "500" && "$RESTARTED_AUTH" -eq 0 ]]; then
    echo ""
    warn "Auth-service returned 500. Restarting once to clear DB cache..."
    kubectl rollout restart deployment/auth-service -n "$NS" 2>/dev/null || true
    kubectl rollout status deployment/auth-service -n "$NS" --timeout=120s 2>/dev/null || true
    RESTARTED_AUTH=1
    echo -n "  Waiting for auth-service to initialize database..."
  fi
  if [[ $i -eq 60 ]]; then
    warn "Auth-service DB initialization timeout (got HTTP $HTTP_CODE)"
    echo "    Try accessing http://localhost:30080/setup manually."
    break
  fi
  echo -n "."
  sleep 2
done

# ai-service는 auth 완료 후 기동
step "Starting ai-service after auth-service"
kubectl scale deployment/ai-service -n "$NS" --replicas=1 2>/dev/null || true
kubectl rollout status deployment/ai-service -n "$NS" --timeout=120s 2>/dev/null || warn "ai-service rollout slow"

# ai-service DB 초기화 완료 대기 (auth 이후)
step "Waiting for ai-service DB initialization"
echo -n "  Waiting for ai-service to initialize database..."
RESTARTED_AI=0
for i in $(seq 1 60); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:30080/api/v1/ai/config" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    ok "AI-service DB initialized (HTTP $HTTP_CODE)"
    break
  fi
  if [[ "$HTTP_CODE" == "500" && "$RESTARTED_AI" -eq 0 ]]; then
    echo ""
    warn "AI-service returned 500. Restarting once to clear DB cache..."
    kubectl rollout restart deployment/ai-service -n "$NS" 2>/dev/null || true
    kubectl rollout status deployment/ai-service -n "$NS" --timeout=120s 2>/dev/null || true
    RESTARTED_AI=1
    echo -n "  Waiting for ai-service to initialize database..."
  fi
  if [[ $i -eq 60 ]]; then
    warn "AI-service DB initialization timeout (got HTTP $HTTP_CODE)"
    echo "    Try accessing http://localhost:30080/setup manually."
    break
  fi
  echo -n "."
  sleep 2
done

# ═══════════════════════════════════════════════════
# 8. 상태 확인
# ═══════════════════════════════════════════════════
step "Deployment status"
kubectl get pods -n "$NS" -o wide 2>/dev/null || true

echo ""
step "Health check"
for i in $(seq 1 10); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:30080/health" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    ok "Gateway is healthy (HTTP $HTTP_CODE)"
    break
  fi
  echo "  Waiting for gateway... (attempt $i/10, got $HTTP_CODE)"
  sleep 3
done

# ═══════════════════════════════════════════════════
# 9. 완료
# ═══════════════════════════════════════════════════
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Deploy complete!                      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo "  URL:  http://localhost:30080/setup"
echo ""
echo "  Accounts (created after first auth-service boot):"
echo "    admin@local / admin   (admin)"
echo "    read@local  / read    (read)"
echo "    write@local / write   (write)"
echo ""
echo "  Kubeconfig: $KUBECONFIG_PATH"
echo "  Usage:      export KUBECONFIG=$KUBECONFIG_PATH"
echo ""
