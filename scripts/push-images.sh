#!/usr/bin/env bash
#
# push-images.sh — 이미지 빌드 + GitHub Container Registry (ghcr.io) push
#
# 사전 1회: write:packages 권한 PAT 로 ghcr 로그인
#   echo $GHCR_PAT | docker login ghcr.io -u junginho0901 --password-stdin
# 푸시 후: github.com 패키지 페이지에서 visibility 를 Public 으로 변경해야
#          익명 pull (install.sh) 이 동작한다.
#
# Usage:
#   ./scripts/push-images.sh                    # 전체 서비스, latest 태그
#   ./scripts/push-images.sh v0.2.0             # 전체 서비스, 버전 태그 + latest
#   ./scripts/push-images.sh v0.2.0 frontend    # 특정 서비스만
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${REGISTRY:-ghcr.io}"
OWNER="${OWNER:-junginho0901}"
TAG="${1:-latest}"
shift 2>/dev/null || true

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}═══ $1 ═══${NC}"; }
ok()   { echo -e "${GREEN}  ✓ $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

# Service definitions: name:context[:dockerfile]
ALL_SERVICES=(
  "auth-service:services:auth-service-go/Dockerfile"
  "ai-service:services/ai-service"
  "k8s-service:services:k8s-service-go/Dockerfile"
  "session-service:services:session-service-go/Dockerfile"
  "frontend:frontend"
  "tool-server:services/tool-server"
  "model-config-controller-go:services/model-config-controller-go"
)

# Filter by args if provided
if [[ $# -gt 0 ]]; then
  SELECTED=()
  for arg in "$@"; do
    found=false
    for entry in "${ALL_SERVICES[@]}"; do
      name="${entry%%:*}"
      if [[ "$name" == "$arg" ]]; then
        SELECTED+=("$entry")
        found=true
        break
      fi
    done
    if [[ "$found" == false ]]; then
      fail "Unknown service: $arg"
    fi
  done
  SERVICES=("${SELECTED[@]}")
else
  SERVICES=("${ALL_SERVICES[@]}")
fi

# Check ghcr login (a stored credential for the registry host must exist)
if ! grep -q "$REGISTRY" ~/.docker/config.json 2>/dev/null; then
  echo -e "${YELLOW}Not logged in to ${REGISTRY}.${NC}"
  echo -e "  Run:  ${CYAN}echo \$GHCR_PAT | docker login ${REGISTRY} -u ${OWNER} --password-stdin${NC}"
  echo -e "  (PAT needs the ${CYAN}write:packages${NC} scope.)"
  fail "Login to ${REGISTRY} first."
fi

step "Building and pushing (tag: $TAG)"

for entry in "${SERVICES[@]}"; do
  IFS=':' read -r name ctx dockerfile <<< "$entry"
  img="${REGISTRY}/${OWNER}/kubeast-${name}"

  echo -e "\n  ${YELLOW}[${name}]${NC}"

  # Build
  echo -n "    Building... "
  if [[ -n "$dockerfile" ]]; then
    docker build -t "${img}:${TAG}" -f "$ROOT/$ctx/$dockerfile" "$ROOT/$ctx" >/dev/null 2>&1
  else
    docker build -t "${img}:${TAG}" "$ROOT/$ctx" >/dev/null 2>&1
  fi
  echo "done"

  # Tag latest if version tag
  if [[ "$TAG" != "latest" ]]; then
    docker tag "${img}:${TAG}" "${img}:latest"
  fi

  # Push
  echo -n "    Pushing ${TAG}... "
  docker push "${img}:${TAG}" >/dev/null 2>&1
  echo "done"

  if [[ "$TAG" != "latest" ]]; then
    echo -n "    Pushing latest... "
    docker push "${img}:latest" >/dev/null 2>&1
    echo "done"
  fi

  ok "${img}:${TAG}"
done

# Update values.yaml imageTag
if [[ "$TAG" != "latest" ]]; then
  step "Updating helm/kubeast/values.yaml"
  sed -i '' "s/imageTag: .*/imageTag: \"${TAG}\"/" "$ROOT/helm/kubeast/values.yaml" 2>/dev/null || \
  sed -i "s/imageTag: .*/imageTag: \"${TAG}\"/" "$ROOT/helm/kubeast/values.yaml" 2>/dev/null || true
  ok "imageTag → ${TAG}"
fi

echo ""
echo -e "${GREEN}All done!${NC}"
echo ""
echo "  Images pushed:"
for entry in "${SERVICES[@]}"; do
  name="${entry%%:*}"
  echo "    ${REGISTRY}/${OWNER}/kubeast-${name}:${TAG}"
done
echo ""
echo -e "  ${YELLOW}⚠ 첫 푸시 후: GitHub > Packages 에서 각 패키지 visibility 를 Public 으로 변경하세요.${NC}"
echo -e "    (Public 이 아니면 install.sh 의 익명 pull 이 unauthorized 로 실패합니다.)"
echo ""
