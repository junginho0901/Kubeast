#!/usr/bin/env bash
#
# release.sh — 버전 릴리스 한 방 처리
#
#   1) helm/kubeast/values.yaml  global.imageTag  → vX.Y.Z
#   2) helm/kubeast/Chart.yaml   version/appVersion → X.Y.Z
#   3) 현재 변경분 + 위 bump 를 commit & push
#   4) vX.Y.Z 태그 생성 & push  → GitHub Actions 가 ghcr 에 이미지 7종 빌드/푸시
#
# Usage:
#   ./scripts/release.sh v0.1.1            # 또는 0.1.1
#   ./scripts/release.sh v0.1.1 -y         # 확인 프롬프트 건너뜀
#   ./scripts/release.sh v0.1.1 -m "i18n ko/en 패치"   # 커밋 메시지 지정
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info() { echo -e "${CYAN}▸${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

# ─── 인자 파싱 ───
VERSION=""; ASSUME_YES=false; MSG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)     ASSUME_YES=true; shift ;;
    -m|--message) MSG="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)  fail "Unknown option: $1" ;;
    *)   VERSION="$1"; shift ;;
  esac
done

[[ -n "$VERSION" ]] || fail "버전을 지정하세요. 예: ./scripts/release.sh v0.1.1"

# ─── 버전 정규화/검증 ───  (입력 vX.Y.Z 또는 X.Y.Z)
BARE="${VERSION#v}"                 # 0.1.1
TAG="v${BARE}"                      # v0.1.1
[[ "$BARE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "버전 형식이 잘못됨: '$VERSION' (vMAJOR.MINOR.PATCH)"

# ─── git 상태 점검 ───
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "git 저장소가 아닙니다."
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] || warn "현재 브랜치가 main 이 아닙니다: '$BRANCH' (install.sh 는 main 을 받습니다)"

# 태그 중복 = 잠수함 패치 방지
if git rev-parse "$TAG" >/dev/null 2>&1 || git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  fail "태그 $TAG 가 이미 존재합니다. 같은 태그 덮어쓰기는 금지(캐시된 이미지가 갱신 안 됨). 버전을 올리세요."
fi

CUR="$(grep -m1 'imageTag:' helm/kubeast/values.yaml | sed 's/.*imageTag: *//; s/"//g')"
info "현재 imageTag: ${BOLD}${CUR}${NC}  →  새 버전: ${BOLD}${TAG}${NC}"

# ─── 버전 파일 bump (macOS/Linux sed 호환) ───
sed_i() { sed -i '' "$@" 2>/dev/null || sed -i "$@"; }
sed_i "s|imageTag: .*|imageTag: \"${TAG}\"|"        helm/kubeast/values.yaml
sed_i "s|^version:.*|version: ${BARE}|"             helm/kubeast/Chart.yaml
sed_i "s|^appVersion:.*|appVersion: \"${BARE}\"|"   helm/kubeast/Chart.yaml
ok "bump 완료: values.yaml imageTag=${TAG}, Chart.yaml version=${BARE}"

# ─── 커밋 대상 미리보기 ───
COMMIT_MSG="release: ${TAG}${MSG:+ — ${MSG}}"
echo ""
echo -e "${BOLD}이번 릴리스로 처리할 내용:${NC}"
echo "  • 커밋 (현재 모든 변경분 포함):"
git status --short | sed 's/^/      /'
echo "  • 커밋 메시지: ${COMMIT_MSG}"
echo "  • push: origin ${BRANCH}"
echo "  • 태그: ${TAG} push → GitHub Actions 가 ghcr 이미지 7종 빌드/푸시"
echo ""

if [[ "$ASSUME_YES" != true ]]; then
  read -r -p "진행할까요? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { warn "취소됨. (버전 파일 bump 는 워킹트리에 남아있음 — git checkout 으로 되돌릴 수 있음)"; exit 1; }
fi

# ─── 실행 ───
git add -A
git commit -m "$COMMIT_MSG"
ok "commit"
git push origin "$BRANCH"
ok "push origin ${BRANCH}"
git tag -a "$TAG" -m "Kubeast ${TAG}"
git push origin "$TAG"
ok "tag ${TAG} push"

echo ""
echo -e "${GREEN}${BOLD}릴리스 트리거 완료!${NC}"
echo "  Actions(이미지 빌드): https://github.com/junginho0901/Kubeast/actions"
echo "  완료 후(~5~8분) install.sh 는 ${TAG} 를 배포합니다."
echo "  기존 클러스터 업그레이드: ${CYAN}helm upgrade kubeast ./helm/kubeast -n kubeast${NC}"
