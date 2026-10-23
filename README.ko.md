# <img src="frontend/public/icon.svg" alt="" width="40" height="40" align="top"> Kubeast

[English](README.md) | **한국어**

여러 Kubernetes 클러스터를 웹 콘솔 하나로 다루고, 궁금한 건 AI에게 물어보세요. Workloads, Network, Storage, RBAC, GPU, Helm까지 리소스를 살펴보고 고칠 수 있고, AI는 내 권한 그대로 클러스터를 읽고 원인을 찾아 답합니다.

소개 사이트(기능 영상): https://junginho0901.github.io/Kubeast/

주요 기능:

- 원하는 모델로 쓰는 AI 어시스턴트(OpenAI · Anthropic · Gemini · Azure OpenAI · Ollama) — 도구로 클러스터를 직접 읽고, 승인한 작업만 실행
- Alertmanager·Grafana 알림이 오면 AI가 읽기 전용으로 먼저 조사하고 보고서를 남김
- 여러 클러스터를 한 화면에서, 권한은 사람마다·클러스터마다 따로 — 필요할 때만 쓰는 임시 권한 요청·승인
- Helm 릴리스 관리(롤백·업그레이드·삭제·테스트, 실행 전 dry-run 미리보기)
- GPU·DRA 모니터링, Prometheus 메트릭, Loki 로그 검색, 리소스 연결 그래프, Node Shell
- 모든 변경과 민감한 조회를 감사 로그(해시 체인)로, 터미널 세션은 녹화로
- Claude Code·Cursor 같은 외부 AI 에이전트가 쓰는 MCP 서버
- 공개 이미지(ghcr.io)로 한 줄 설치 — Kubernetes·Docker 모두
- 한국어·영어 화면

## 빠른 시작

```bash
helm install kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.0 \
  --namespace kubeast --create-namespace
```

설치 스크립트·Docker Compose·제거, 관리자 비밀번호 확인, 클러스터 연결, AI 켜기는 [설치와 첫 설정](docs/ko/getting-started.md)에 있습니다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [설치와 첫 설정](docs/ko/getting-started.md) | 설치 방법 3가지 · 제거 · 첫 접속 · 클러스터 연결 · AI 켜기 |
| [기능 한눈에](docs/ko/features.md) | AI 어시스턴트 · 멀티클러스터와 역할·권한 · 리소스 관리 · Helm · GPU · 관측성 · 인증·감사 |
| [AI·알림](docs/ko/ai-alerts.md) | MCP 서버 · 알림 → AI 조사 · Alerts 받은편지함 · 트레이스·알림 읽기 · AI 분석 평가 |
| [보안·감사](docs/ko/security-audit.md) | API 키 · 접근 권한 검토 · 휴면 계정 잠금 · 감사 싱크 · 감사 로그 무결성 · 세션 기록 |
| [운영 기능](docs/ko/operations.md) | 정책 보고서 · 클러스터 위생 점검 · Argo CD 가드 · 대시보드 빠른 작업 · 로그 파일 · 로그 검색 · 트레이스 링크 · 신뢰할 CA |
| [클러스터 준비물](docs/ko/cluster-requirements.md) | 관리할 클러스터에 있어야 하는 것(RBAC·metrics-server·Prometheus·OpenCost 등)과 확인 방법 |
| [SSO(OIDC) 설정](docs/ko/oidc.md) | Keycloak · Google · Entra ID · Okta 연결 |
| [아키텍처](docs/ko/architecture.md) | 서비스 구성 · 컨테이너 이미지 · 자원 사용량 |
| [설정 (values.yaml)](docs/ko/configuration.md) | 차트 값 설명 |
| [데이터베이스: TLS·백업·복원](docs/ko/database-backup-restore.md) | DB 연결 TLS · 백업·복원 · 보존 기간 |
| [콘솔 메트릭](docs/ko/metrics.md) | Kubeast 자신의 `/metrics` |
| [공급망 보안](docs/ko/supply-chain.md) | 이미지 스캔 · SBOM · 출처 증명 · 서명 |
| [감사 로그 계획](docs/ko/audit-log-plan.md) | 감사 액션 카탈로그와 권한 매핑 |
| [개발](docs/ko/development.md) | 디렉터리 구조 · kind 개발 루프 · E2E · 서비스별 개발 · 기술 스택 |

## 라이선스

MIT License
