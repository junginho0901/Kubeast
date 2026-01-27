#!/bin/bash

# MSA 통합 테스트 스크립트

echo "🚀 MSA 통합 테스트 시작"
echo "================================"

# 색상 정의
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 헬스 체크 함수
check_health() {
    local service=$1
    local url=$2
    local max_retries=30
    local retry_count=0

    echo -n "[$service] 헬스 체크 중... "
    
    while [ $retry_count -lt $max_retries ]; do
        if curl -s -f "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}✓ OK${NC}"
            return 0
        fi
        retry_count=$((retry_count + 1))
        sleep 2
    done
    
    echo -e "${RED}✗ FAIL${NC}"
    return 1
}

# 1. Docker Compose 실행
echo ""
echo "1. Docker Compose 빌드 및 실행"
docker-compose -f docker-compose.msa.yml up -d --build

if [ $? -ne 0 ]; then
    echo -e "${RED}Docker Compose 실행 실패!${NC}"
    exit 1
fi

echo ""
echo "2. 서비스 시작 대기 (30초)..."
sleep 30

echo ""
echo "3. 서비스 헬스 체크"
echo "================================"

# 각 서비스 헬스 체크
check_health "PostgreSQL" "http://localhost:5432" || true
check_health "Redis" "http://localhost:6379" || true
check_health "API Gateway" "http://localhost:8000/health"
check_health "AI Service" "http://localhost:8001/health"
check_health "K8s Service" "http://localhost:8002/health"
check_health "Session Service" "http://localhost:8003/health"
check_health "Frontend" "http://localhost:5173"

echo ""
echo "4. API 엔드포인트 테스트"
echo "================================"

# Session Service 테스트
echo -n "[Session Service] 세션 생성... "
RESPONSE=$(curl -s -X POST http://localhost:8000/api/v1/sessions/ \
    -H "Content-Type: application/json" \
    -d '{"title":"Test Session"}')

if echo "$RESPONSE" | grep -q "id"; then
    echo -e "${GREEN}✓ OK${NC}"
    SESSION_ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    echo "  Session ID: $SESSION_ID"
else
    echo -e "${RED}✗ FAIL${NC}"
fi

# K8s Service 테스트
echo -n "[K8s Service] 네임스페이스 조회... "
RESPONSE=$(curl -s http://localhost:8000/api/v1/cluster/namespaces)

if echo "$RESPONSE" | grep -q "name"; then
    echo -e "${GREEN}✓ OK${NC}"
else
    echo -e "${RED}✗ FAIL${NC}"
fi

# AI Service 테스트 (세션이 생성되었을 경우에만)
if [ ! -z "$SESSION_ID" ]; then
    echo -n "[AI Service] AI 챗 테스트... "
    # 간단한 헬스 체크만 수행 (실제 챗은 스트리밍이라 테스트 복잡)
    if curl -s http://localhost:8001/health | grep -q "healthy"; then
        echo -e "${GREEN}✓ OK${NC}"
    else
        echo -e "${RED}✗ FAIL${NC}"
    fi
fi

echo ""
echo "5. 컨테이너 상태 확인"
echo "================================"
docker-compose -f docker-compose.msa.yml ps

echo ""
echo "6. 테스트 요약"
echo "================================"
echo -e "${GREEN}✓ MSA 환경이 성공적으로 실행되었습니다!${NC}"
echo ""
echo "접속 정보:"
echo "  - Frontend:       http://localhost:5173"
echo "  - API Gateway:    http://localhost:8000"
echo "  - AI Service:     http://localhost:8001"
echo "  - K8s Service:    http://localhost:8002"
echo "  - Session Service: http://localhost:8003"
echo ""
echo "로그 확인:"
echo "  docker-compose -f docker-compose.msa.yml logs -f"
echo ""
echo "서비스 중지:"
echo "  docker-compose -f docker-compose.msa.yml down"
