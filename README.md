# <img src="frontend/public/icon.svg" alt="" width="40" height="40" align="top"> Kubeast

AI 어시스턴트를 내장한 멀티클러스터 Kubernetes 운영 플랫폼입니다. 웹 UI에서 여러
클러스터의 리소스(Workloads, Network, Storage, RBAC, GPU, Helm 등)를 조회·관리하고,
LLM 기반 채팅으로 리소스 조회·진단·변경을 수행할 수 있습니다.

주요 특징:

- 다중 LLM(OpenAI · Anthropic · Gemini · Azure OpenAI · Ollama) AI 어시스턴트, Tool calling 기반 클러스터 조작
- 알림(Alertmanager·Grafana)을 받으면 AI가 읽기 도구로 조사해 보고서를 남김
- 멀티클러스터 관리 및 사용자×클러스터 단위 RBAC, 임시 권한 요청·승인
- Helm 릴리스 관리 (rollback / upgrade / uninstall / test)
- GPU & DRA 모니터링, Prometheus 메트릭, 로그 검색(Loki), 토폴로지 시각화, Node Shell
- 모든 쓰기/민감 작업에 대한 감사 로그(해시 체인), 터미널 세션 기록
- 외부 AI 에이전트용 MCP 서버
- 공개 컨테이너 이미지(ghcr.io) 기반 한 줄 설치 (Kubernetes / Docker)
- 한국어 · 영어 지원

## 빠른 시작

```bash
git clone https://github.com/junginho0901/Kubeast.git
cd Kubeast
helm install kubeast ./helm/kubeast --namespace kubeast --create-namespace
```

설치 스크립트·Docker Compose·제거, 관리자 비밀번호 확인, 클러스터 연결, AI 켜기는 [설치와 첫 설정](docs/getting-started.md)에 있습니다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [설치와 첫 설정](docs/getting-started.md) | 설치 방법 3가지 · 제거 · 첫 접속 · 클러스터 연결 · AI 켜기 |
| [기능 한눈에](docs/features.md) | AI 어시스턴트 · 멀티클러스터와 역할·권한 · 리소스 관리 · Helm · GPU · 관측성 · 인증·감사 |
| [AI·알림](docs/ai-alerts.md) | MCP 서버 · 알림 → AI 조사 · Alerts 받은편지함 · 트레이스·알림 읽기 · AI 분석 평가 |
| [보안·감사](docs/security-audit.md) | API 키 · 접근 권한 검토 · 휴면 계정 잠금 · 감사 싱크 · 감사 로그 무결성 · 세션 기록 |
| [운영 기능](docs/operations.md) | 정책 보고서 · 클러스터 위생 점검 · Argo CD 가드 · 대시보드 빠른 작업 · 로그 파일 · 로그 검색 · 트레이스 링크 · 신뢰할 CA |
| [클러스터 준비물](docs/cluster-requirements.md) | 관리할 클러스터에 있어야 하는 것(RBAC·metrics-server·Prometheus·OpenCost 등)과 확인 방법 |
| [SSO(OIDC) 설정](docs/oidc.md) | Keycloak · Google · Entra ID · Okta 연결 |
| [아키텍처](docs/architecture.md) | 서비스 구성 · 컨테이너 이미지 · 자원 사용량 |
| [설정 (values.yaml)](docs/configuration.md) | 차트 값 설명 |
| [Database: TLS, backup and restore](docs/database-backup-restore.md) | DB 연결 TLS · 백업·복원 · 보존 기간 |
| [콘솔 메트릭](docs/metrics.md) | Kubeast 자신의 `/metrics` |
| [Supply chain](docs/supply-chain.md) | 이미지 스캔 · SBOM · 출처 증명 · 서명 |
| [감사 로그 계획](docs/audit-log-plan.md) | 감사 액션 카탈로그와 권한 매핑 |
| [개발](docs/development.md) | 디렉터리 구조 · kind 개발 루프 · E2E · 서비스별 개발 · 기술 스택 |

## 라이선스

MIT License
