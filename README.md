# <img src="frontend/public/icon.svg" alt="" width="40" height="40" align="top"> Kubeast

AI 어시스턴트를 내장한 멀티클러스터 Kubernetes 운영 플랫폼입니다. 웹 UI에서 여러
클러스터의 리소스(Workloads, Network, Storage, RBAC, GPU, Helm 등)를 조회·관리하고,
LLM 기반 채팅으로 리소스 조회·진단·변경을 수행할 수 있습니다.

주요 특징:

- 다중 LLM(OpenAI · Anthropic · Gemini · Ollama) AI 어시스턴트, Tool calling 기반 클러스터 조작
- 멀티클러스터 관리 및 사용자×클러스터 단위 RBAC
- Helm 릴리스 관리 (rollback / upgrade / uninstall / test)
- GPU & DRA 모니터링, Prometheus 메트릭, 토폴로지 시각화, Node Shell
- 모든 쓰기/민감 작업에 대한 감사 로그
- 공개 컨테이너 이미지(ghcr.io) 기반 한 줄 설치 (Kubernetes / Docker)
- 한국어 · 영어 지원

---

## 목차

- [빠른 시작](#빠른-시작)
- [설치 후 첫 설정](#설치-후-첫-설정)
- [주요 기능](#주요-기능)
- [아키텍처](#아키텍처)
- [설정 (values.yaml)](#설정-valuesyaml)
- [디렉터리 구조](#디렉터리-구조)
- [개발](#개발)
- [기술 스택](#기술-스택)

---

## 빠른 시작

모든 컴포넌트 이미지는 **GitHub Container Registry(ghcr.io)에 공개 패키지**로 게시되어
있어 별도 빌드 없이 바로 설치됩니다. (공개 패키지는 익명 pull rate limit이 없습니다.)

### 옵션 1. 설치 스크립트 (이미 동작 중인 K8s 클러스터)

태그가 붙은 스크립트를 내려받아 내용을 확인한 뒤 실행합니다(검토하지 않은 스크립트를 `curl | bash`로 바로 실행하지 않습니다).

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/junginho0901/Kubeast/v0.3.0/install.sh
less install.sh
bash install.sh
```

옵션:

```bash
# NodePort 변경 (기본 30333)
bash install.sh --node-port 30333

# LoadBalancer (클라우드 환경)
bash install.sh --load-balancer

# 네임스페이스 지정
bash install.sh --namespace my-ns

# 차트 버전 지정
bash install.sh --version 0.3.0
```

> 사전 요구: `kubectl`, `helm`, 그리고 접근 가능한 Kubernetes 클러스터.

### 옵션 2. Helm 직접 사용

```bash
git clone https://github.com/junginho0901/Kubeast.git
cd Kubeast

helm install kubeast ./helm/kubeast \
  --namespace kubeast --create-namespace \
  --set ai.openaiApiKey=$OPENAI_API_KEY     # 선택: 나중에 UI에서도 등록 가능
```

### 옵션 3. Docker Compose (클러스터 없이 단일 호스트)

```bash
git clone https://github.com/junginho0901/Kubeast.git
cd Kubeast

./install-docker.sh
#   --kubeconfig /path/to/kubeconfig.yaml   # 관리할 클러스터 kubeconfig
#   --port 9000                             # Gateway 포트 (기본 8000)
#   --uninstall                             # 컨테이너 + 볼륨 모두 제거
```

`docker-compose`는 published 이미지를 pull 합니다. 소스에서 빌드하려면:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

### 제거

```bash
helm uninstall kubeast -n kubeast      # K8s
./install-docker.sh --uninstall        # Docker
```

---

## 설치 후 첫 설정

### 1. 접속

- **NodePort**: `http://<노드IP>:30333`
- **포트포워드**: `kubectl -n kubeast port-forward svc/gateway 8000:8000` → `http://localhost:8000`
- **Docker**: `http://localhost:8000`

### 2. 관리자 비밀번호 확인

초기 admin 비밀번호는 **설치 시 무작위 생성**되며(`admin.password`를 비워둔 경우),
**설치 스크립트가 끝날 때 화면에 출력**합니다.

```text
Default account:
  ID:       admin
  Password: KhHAm7GGGvXiT9ysnOiV     ← 설치 출력에서 바로 확인
```

출력을 놓쳤다면 언제든 다시 조회할 수 있습니다.

```bash
# K8s / Helm
kubectl -n kubeast get secret kubeast-secrets \
  -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' | base64 -d ; echo

# Docker — .env 파일의 DEFAULT_ADMIN_PASSWORD
grep DEFAULT_ADMIN_PASSWORD .env
```

비밀번호를 직접 지정하려면 설치 시 `--set admin.password=<원하는비번>`.

### 3. 로그인 후 클러스터 연결 (Connect your cluster)

`admin` 계정으로 먼저 로그인합니다. 등록된 클러스터가 없으면 로그인 직후 `/setup` 마법사로 이동합니다
(마법사와 그 API는 관리자 권한이 필요합니다). **로그인 후 즉시 비밀번호를 변경하세요.**

- **In-cluster** — Kubeast가 떠 있는 그 클러스터를 ServiceAccount 권한으로 자동 연결
- **External** — 다른 클러스터의 kubeconfig를 등록 (멀티클러스터). API 서버 주소를 비워 두면 연결 확인 때 실제로 붙은 주소가 들어가고, 주소 없이 등록된 클러스터는 **Admin > Clusters**의 연결 테스트가 채웁니다

**클러스터 준비물**: Kubeast는 등록한 클러스터에 아무것도 설치하지 않습니다. 권한(RBAC)은 클러스터마다 있어야 하고, 그래프·비용·정책 보고서 같은 기능은 그 클러스터의 metrics-server·Prometheus·OpenCost·Kyverno 등을 읽습니다. 기능별로 무엇이 있어야 하는지·찾는 방법·확인 명령·예시는 [docs/cluster-requirements.md](docs/cluster-requirements.md), 예시 값은 `deploy/examples/target-cluster/`, 등록 클러스터용 권한 렌더는 `scripts/render-target-rbac.sh`.

**EKS 클러스터**는 IAM으로 인증합니다. k8s-service·tool-server 이미지에 `aws-iam-authenticator`가 들어 있으므로 kubeconfig에는 정적 자격증명 대신 exec 플러그인을 적습니다. Kubeast 파드의 IRSA 롤(`values.yaml`의 `aws.irsaRoleArn`)이 `-r`의 대상 롤을 AssumeRole하고, 대상 클러스터의 access entry가 그 롤을 Kubernetes 그룹에 매핑합니다(그룹 권한은 `helm/kubeast/files/impersonation-rbac.yaml`).

```yaml
users:
- name: kubeast
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws-iam-authenticator
      args: ["token", "-i", "<cluster-name>", "-r", "arn:aws:iam::<account>:role/kubeast-target"]
      interactiveMode: Never
```

등록되는 kubeconfig의 exec 명령은 허용 목록(`multicluster.execCommands`, 기본 `aws-iam-authenticator`)에 있어야 하고, `AWS_ACCESS_KEY_ID` 같은 정적 키 env는 거부됩니다.

### 4. AI 활성화

**Admin > AI Models**에서 OpenAI / Anthropic / Gemini 등의 API 키를 등록하면
AI 어시스턴트가 활성화됩니다.

모델 드롭다운은 공급자가 그 키·주소로 알려 주는 모델 목록입니다 — ai-service가 Anthropic `GET /v1/models`, 그 외(OpenAI·Gemini·Ollama·OpenAI 호환 게이트웨이)는 `GET {base_url}/models`를 부르고(`POST /api/v1/ai/model-configs/models`, 관리자, 연결 테스트와 같은 키·주소 규칙) 임베딩·음성·이미지 모델은 뺍니다. 키가 없거나 목록을 못 받으면 내장 목록과 그 이유가 보이고, "모델 이름 직접 입력"도 됩니다. 브라우저는 Kubeast 밖으로 나가지 않으므로 내부망에서도 그 설정의 주소(사내 게이트웨이·Ollama)의 목록이 나옵니다.

AI 없이 콘솔만 쓰려면 `ai.enabled: false`로 설치합니다 — ai-service·tool-server·ModelConfig 컨트롤러가 배포되지 않고(새 설치는 CRD도 없음, 켰다 끈 설치는 CRD와 ModelConfig가 남음), 게이트웨이의 `/api/v1/ai`는 JSON 503, 화면은 AI 채팅·플로팅 어시스턴트·AI 관리 페이지·MCP 안내를 숨깁니다(`/api/v1/cluster/features`의 `ai.enabled`). 켜진 설치에서도 ai-service는 모델 클라이언트를 처음 만들 때 provider SDK를, `mcp.enabled`일 때만 MCP SDK를 읽어 유휴 메모리를 줄입니다.

Anthropic(provider `anthropic`)은 OpenAI 호환 주소가 아니라 Messages API(`/v1/messages`)로 부릅니다(`app/services/anthropic_messages.py`, 응답은 다른 공급자와 같은 모양으로 바꿔 돌려줌).
- **샘플링 값**: Claude 4.7 이후 모델(이름에서 버전을 읽지 못하는 모델 포함)에는 `temperature`·`top_p`·`top_k`를 보내지 않습니다 — 그 모델들은 기본값이 아니면 400을 돌려줍니다.
- **thinking**: 모델 기본값을 따릅니다(Claude 5 계열은 기본으로 켜짐). 도구 호출 사이에는 그 턴의 thinking 블록을 그대로 돌려보냅니다(API 요건). thinking 토큰도 `max_tokens`에 들어가므로 Claude 5 계열(이름에 버전이 없는 모델 포함)에는 호출부의 `max_tokens`에 4,096을 더해 보냅니다 — 상한일 뿐 쓴 만큼만 과금됩니다.
- **프롬프트 캐시**: 자동 캐시(`cache_control`)가 기본으로 켜집니다. 모델 설정 옵션 `prompt_cache: false`로 끕니다. 사용량의 입력 토큰은 캐시에서 읽은 토큰을 포함한 총 입력입니다.
- 키는 지금처럼 `ANTHROPIC_API_KEY`(또는 `KUBEAST_AI_KEY_*`)에 둡니다. 예전 호환 주소(`https://api.anthropic.com/v1/`)가 base_url에 들어 있어도 그대로 동작합니다.

**Claude 구독으로 쓰기 (provider `claude-code`, 개인용)** — API 키 대신 Claude Pro/Max 구독의 `claude setup-token` 값으로 채팅합니다. 구독 토큰은 Claude Code에서만 받아 주므로, ai-service가 모델 호출마다 Claude Code를 띄우고(Claude Agent SDK, `app/services/claude_code.py`) Claude Code가 부르는 도구는 채팅의 도구 코드가 이 프로세스 안에서 처리합니다. 그래서 도구 목록, 쓰기 도구의 승인 카드, 마스킹, `ai.tool.call`·`ai.chat.complete` 감사(provider `claude-code`)가 API 키 경로와 같습니다.
- **혼자 쓰는 설치에서만** 켭니다. Anthropic 약관은 구독을 본인 사용으로 한정합니다. 팀이나 여러 사용자가 쓰는 Kubeast에 넣으면 안 됩니다. 관리 화면은 이 프로바이더를 고르면 같은 경고를 보여 줍니다.
- **켜는 법**: ① 본인 PC에서 `claude setup-token`으로 토큰(1년)을 만들어 `ai.claudeCodeOAuthToken`(또는 `apiKeysSecret`의 `CLAUDE_CODE_OAUTH_TOKEN` 키)에 넣고 `ai.providers.claudeCode.enabled: true`로 올립니다. 이 값을 켜면 ai-service가 Claude Code가 든 이미지(같은 버전의 `<버전>-claude-code` 태그, 약 250 MB 더 큼)로 바뀝니다 — 기본 이미지에는 없습니다. 직접 빌드한 이미지면 `--build-arg WITH_CLAUDE_CODE=true`로 빌드하고 `ai.providers.claudeCode.imageTagSuffix: ""`로 둡니다. ② **Admin > AI Models**에서 "Claude subscription"을 고르면 변수 이름이 `CLAUDE_CODE_OAUTH_TOKEN`으로 채워집니다. 연결 테스트 후 저장합니다. 이 설치에서 아직 쓸 수 없으면(값이 꺼져 있거나 이미지에 Claude Code가 없음) 목록에서 흐리게 "Not set up"으로 보이고, 고르면 이유가 먼저 나오며 테스트·저장 버튼이 막힙니다.
- **격리**: 실행마다 임시 HOME·설정 디렉터리, Claude Code 기본 도구(Bash·파일·웹) 없음, 설정 파일·CLAUDE.md 안 읽음. ai-service가 받은 환경변수는 경로·프록시·CA 변수를 빼고 모두 빈 값으로 덮어 모델 키·DB 주소가 넘어가지 않습니다. 토큰은 `CLAUDE_CODE_OAUTH_TOKEN`으로만 갑니다.
- **규칙**: `CLAUDE_CODE_OAUTH_TOKEN`은 claude-code만 쓸 수 있고, claude-code는 base_url과 다른 공급자 키 변수를 받지 않습니다. 꺼진 설치에서는 새 claude-code 설정 저장이 400으로 거절되고 연결 테스트가 이유를 보여 줍니다.
- **한도**: 동시에 도는 턴은 `maxConcurrent`(기본 1, 나머지는 대기), 한 턴은 `turnTimeoutSeconds`(기본 300초)와 `maxTurns`(기본 10회 모델 호출)까지입니다. 턴마다 Claude Code 프로세스(최대 약 300 MB)가 하나 뜨므로 `maxConcurrent`를 올리면 `resources.aiService.limits.memory`도 올립니다.
- **알림 → AI 조사**도 이 프로바이더로 돕니다. 조사는 채팅과 따로 한 칸을 써서(조사기는 한 번에 하나) 조사 중에도 채팅이 기다리지 않습니다 — 그래서 조사가 켜져 있으면 Claude Code 프로세스가 `maxConcurrent` + 1개까지 뜹니다. 단계 상한은 `maxSteps`(마지막 단계는 도구 없이 보고서)로 API 키일 때와 같습니다.
- **안 되는 것**: 공급자 모델 목록(내장 목록 또는 이름 직접 입력).

---

## 주요 기능

### 🤖 AI 어시스턴트

- **다중 LLM 지원** — OpenAI · Anthropic · Gemini · Ollama 등 (OpenAI 호환 어댑터로 통합, Anthropic은 Messages API)
- **스트리밍 채팅** — SSE 기반 실시간 응답, 세션/히스토리 보존. 모델에는 최근 `ai.chat.historyMessages`(기본 10)개의 user/assistant 메시지가 그대로 가고, 그 앞의 대화는 같은 모델이 밀려난 턴마다 적은 메모를 덧붙인 **요약 하나**(`ai.chat.summary.enabled`, 기본 켬; 마스킹·`maxChars` 상한, 넘으면 오래된 메모를 합침)로 접혀 세션 컨텍스트에 남는다 — 긴 대화도 앞부분 사실을 잃지 않으면서 프롬프트가 커지지 않음. 요약은 창 밖으로 새 메시지가 밀릴 때만 증분 갱신되고 `ai.chat.summarize`로 감사됨. 답마다 아래에 그 턴의 토큰("입력 · 출력 · 캐시 %", 툴팁에 모델 호출 수·모델)이 보이며, 메시지에 저장돼(`messages.usage`, 그 턴 `ai.chat.complete`와 같은 값) 새로고침 뒤에도 남음. 그 줄(토큰·Copy)은 답이 나오는 동안 닫혀 있다가 끝나거나 멈추면 열리고 서서히 나타남(운영체제의 움직임 줄이기면 바로). 멈춘 답은 그때까지의 글이 "멈춤 · 사용량을 표시할 수 없음" 표시와 함께 저장됨(session-service가 표식 `{"stopped": true}`만 받음). 대화는 맨 아래에 있을 때만 새 글을 따라가고, 위로 올리면 멈춘 채 "맨 아래로" 버튼이 뜸. 답의 표는 가로·세로 선, 답 옆엔 Kubeast 아이콘
- **다중 라운드 Tool Calling** — AI가 화이트리스트 툴로 K8s를 조회·변경(최대 10라운드).
  읽기/쓰기/관리 툴은 **사용자 권한(JWT)에 따라 게이팅**. 읽기 도구 13종에는 이름 조각·레이블로 여러 종류·네임스페이스를 한 번에 찾는 `k8s_find_resource`, API 스키마를 묻는 `k8s_explain`, 죽은 컨테이너의 직전 로그(`previous`)·기간·전체 컨테이너·텍스트 필터가 있는 Pod 로그, 객체·종류·`type=Warning`으로 좁히는 이벤트가 들어 있다.
  없는 이름·없는 종류·없는 기능(metrics-server 등)은 kubectl 오류 대신 **`not_found`(비슷한 이름 목록 포함)·`unknown_kind`·`unavailable` 결과**로 돌아와, AI가 네임스페이스를 바꿔 가며 되묻지 않고 한 번 찾아본 뒤 어디를 봤는지 말하고 질문한다. 비슷한 이름은 그 사람의 네임스페이스 범위 안에서만 찾는다.
  Kubeast 기능을 쓰는 도구 — `issues`(이슈 점검: 파드·워크로드·노드·PVC·경고 이벤트 한 번에), `prometheus_query`(PromQL 즉시·범위), `logsearch`(로그 저장소 검색, 사라진 파드도), `helm_read`(릴리스 목록·values·manifest·이력·리소스·이미지·리비전·두 리비전 diff, **읽기만**), `policy_reports`(PolicyReport 요약·결과), `cost`(OpenCost 배분)·`optimization`(requests 대비 사용량·권고), `can_i`(그 사용자가 할 수 있는지), `resource_graph`(네임스페이스 객체와 연결), `hygiene`(위생 보고, Admin) — 는 kubectl이 아니라 k8s-service API를 **그 사람 토큰으로** 부르므로 권한·감사·마스킹이 화면과 같다. 그 클러스터에 기능이 없거나(Prometheus 미설정, 로그 저장소 없음, 비용·정책 보고 꺼짐) 그 사람에게 k8s-service가 묻는 권한(`admin.hygiene.read`·`resource.helm.read`·`resource.policyreport.read`·`resource.cost.read`)이 없으면 도구 목록에서 빠진다(`/api/v1/features`, 1분 캐시). 결과는 시리즈 100·점 120·로그 200줄·행 200·그래프 노드 200/엣지 400·텍스트 64 KB에서 자른다. `gitops_status`는 Argo CD Application CR를 그 사람 권한으로 읽어 sync·health·마지막 operation·오류 조건·OutOfSync 리소스를 앱별로 정리한다(Argo CD가 없는 클러스터면 unavailable — 중앙 Argo CD면 관리 클러스터에서). Admin 전용 `audit_search`는 auth-service의 감사 로그 API(`admin.audit.read`, 읽기 자체도 감사됨)를, `nodes_stats_summary`·`nodes_log`는 kubelet의 stats summary와 로그 질의를 API 서버 프록시로(`admin.nodes.read` + 클러스터 RBAC `nodes/proxy`; 로그 질의는 kubelet `enableSystemLogQuery`가 켜져 있어야 하고, 꺼져 있으면 unavailable로 답한다) 읽는다.
  큰 목록은 `k8s_jq_query`(`kubectl get -o json`을 jq로 걸러 필요한 필드만, 환경·파일 접근 없음·5초 상한)·`k8s_tabular_query`(고른 열만 표)·`k8s_count`(개수·그룹별 개수)로 줄여 받고, 쓰기 전엔 `k8s_diff`(서버 dry-run 결과를 라이브 객체와 비교한 diff — **적용 없음**, 쓰기 권한 사용자에게만 보임)로 바뀔 내용을 먼저 보인다.
- **플로팅 AI 위젯(AI Chat)** — 모든 페이지에 떠 있는 위젯이 **현재 화면 컨텍스트(보고 있는 리소스)**
  를 이해하고 답변 (read-only 툴로 제한). 첫 글자 전엔 대기 점, 끝난 답 옆엔 작은 복사 아이콘(토큰 줄은 없음), 넓은 표는 상자 안에서 스크롤되고 머리 줄 고정
- **리소스 최적화 제안** — 네임스페이스 관측값(requests/limits·사용량) 표 + AI 제안 스트리밍 + 행마다 **재시작 없이 적용**(Pod `resize` 하위 리소스, Kubernetes 1.35+, `features.inPlaceResize`); Pod 드로어의 컨테이너 카드에서도 값을 직접 넣어 같은 방식으로 조정
- **비용(OpenCost)** — 클러스터 안의 OpenCost를 Prometheus처럼 찾아(이름에 `opencost`가 든 9003 Service, API 서버 프록시) Namespace별·워크로드별 비용 표(Cost 메뉴)와 최적화 표의 **월 비용·월 절약** 열을 보여 줌(`features.cost`). 권한 `resource.cost.read`, Namespace 범위 부여는 그 Namespace만
- **정책 보고서(Policy Reports)** — Kyverno·Trivy Operator 등이 쓰는 `wgpolicyk8s.io` PolicyReport/ClusterPolicyReport를 읽어 Security → Policy Reports에 정책별·Namespace별 pass/fail/warn/error/skip과 결과 행을, 워크로드·Pod 드로어에 "Policy violations" 절을 보여 줌(`features.policyReports`, CRD 없으면 "설치되어 있지 않습니다"). 권한 `resource.policyreport.read`, Namespace 범위 부여는 그 Namespace만
- **AI 에이전트 연결(MCP 서버)** — Claude Code·Cursor가 kubeconfig 대신 API 키로 연결해 같은 읽기 도구를
  **그 사람 권한으로만**, 마스킹·감사를 거쳐 사용(기본 꺼짐). 운영자가 켜면(`mcp.writeTools`) 상한이 Write인 키에 쓰기 도구와
  접근 요청 도구도 — 승인 카드 없이 그 사람 권한(영구·임시) 그대로, Argo CD 가드·감사 동일
- **모델 설정** — `ModelConfig` CRD + DB로 관리, Admin UI에서 추가/테스트. 등급(`tier`, CRD `spec.tier`)이 `economy`인 설정을 켜 두면 채팅 이력 요약과 플로팅 어시스턴트가 그 (보통 더 싼) 모델을 쓰고 채팅은 기본 모델 그대로 — 스트림의 `model_info.tier`로 어느 쪽인지 보임. economy 설정이 없거나 키가 없어 못 쓰면 둘 다 기본 모델

### 🌐 멀티클러스터 & RBAC

- **클러스터 레지스트리** — in-cluster(self) + 외부 클러스터(kubeconfig) 등록/검증/헬스체크
- **클러스터별 RBAC** — 사용자×클러스터마다 역할 부여, **deny-by-default**
  (권한 없는 클러스터는 목록에도 안 보임)
- **부하/장애 격리** — 클러스터별 클라이언트 풀(LRU) · 서킷 브레이커 · 헬스체크 ·
  rate limit · Prometheus 쿼리 캐시
- **클러스터 스위처** — UI 상단에서 전환, 탭별 독립(URL 쿼리 기반)
- **커스텀 역할** — 리소스 단위 권한(`resource.*.read/create/edit/delete`),
  메뉴 가시성(`menu.*`), AI 툴(`ai.tool.*`)

#### 역할과 권한 — 기본 역할이 무엇을 할 수 있고, 클러스터에는 누구로 가나

| Kubeast 역할 | 어디에 주나 | 앱 권한 | 클러스터 안 신원(impersonation 그룹) |
| --- | --- | --- | --- |
| **Pending** | 가입·SSO 직후 기본값 | 없음 — 로그인만 되고 API는 403 | — |
| **Member** | 계정 등급 | 전역 권한 없음, **클러스터별 부여로만** 접근 | `kubeast:authenticated`(권한 없음) |
| **Read** | 클러스터별 | 메뉴 10 · 모든 리소스 읽기(`resource.*.read`, 비용 `resource.cost.read` 포함) · Helm 읽기 · 컨테이너 안 로그 파일 읽기(`resource.pod.logfile`, 기능을 켰을 때) · AI 채팅의 읽기 도구 26종(`ai.tool.<읽기 도구>`)과 MCP 연결(`ai.mcp.use`) — 쓰기 도구는 없음 | `kubeast:viewer` = `view` + `kubeast:cluster-reader`. `view`는 Secret과 `services/proxy`를 제외하므로 Secret과 Helm 릴리스(Secret에 저장)는 클러스터가 거부하고 화면은 권한 안내를 띄운다. API 서버 프록시로 읽는 Prometheus·OpenCost(최적화 사용량·스토리지 분석·비용·드로어 메트릭)는 차트 값 `auth.impersonation.viewerProxyServices`에 적은 Service만 **GET으로** 열린다 — 그 Namespace의 Role, 이름은 정확히 `<service>:<port>`, 다른 Service·POST·NS 범위 부여는 계속 거부(아래 values 주석). 적지 않으면 거부(프록시는 `kubeast:operator`=`edit`부터) |
| **Write** | 클러스터별 | `menu.*` · 리소스 생성/수정/삭제 · CronJob suspend/trigger · Secret 값 보기 · 로그 파일 읽기 · Helm rollback/upgrade/test · AI 툴 전부(`ai.tool.*`, 쓰기 도구 포함) · MCP 연결 | `kubeast:operator` = `edit` + viewer |
| **Admin** | 계정 등급(`*`) 또는 클러스터별 | 전부 — 관리자 메뉴, 모든 클러스터(나중에 등록한 것 포함) | `kubeast:admin` = `cluster-admin` |
| 커스텀 | 클러스터별 | 고른 권한만(만드는 사람이 가진 권한 안에서) | `kubeast:role:<이름>` — 클러스터가 이 그룹을 바인딩하기 전엔 모든 호출이 403(`auth.impersonation.customRoles`). 화면의 권한 없음 배너와 역할 만들기 창이 이 그룹 이름을 보여 준다 |

- **Admin만 되는 것**: Pod exec · Node shell · cordon/drain · 워크로드 rollback · Helm uninstall. `resource.pod.exec`·`resource.node.cordon/drain/shell`·`resource.workload.rollback`·`resource.helm.uninstall`은 Write에 없고, 필요하면 커스텀 역할에 넣는다.
  - 클러스터 쪽에서 보면 Write 그룹(`kubeast:operator`)은 기본 `edit` ClusterRole에 `pods/exec`가 들어 있어 원래 모든 네임스페이스에서 exec가 된다 — Pod exec를 Admin 전용으로 만드는 것은 Kubeast의 앱 권한이다. 그래서 Kubeast의 impersonation 자격(`kubeast-impersonator`)은 그 그룹들 전체 권한과 같은 무게로 지켜야 한다.
  - 로그 파일 보기(`features.logFiles`, 기본 off)는 Kubeast가 명령을 `ls`·`tail`로 고정하므로 Read·Write도 쓴다. 이를 위해 차트는 적어 둔 네임스페이스에만 Read 그룹(`kubeast:viewer`)에 `pods/exec`를 묶는다(아래 "컨테이너 안 로그 파일" 절).
- **쓰기 API는 전부** 핸들러에서 권한을 검사하고 감사 행 없이는 거부된다(fail-closed). **읽기 API**는 "그 클러스터에 역할이 있나"(클러스터 미들웨어, deny-by-default) + 클러스터의 RBAC(viewer 그룹)으로 막힌다. `menu.*`는 화면 메뉴만 가린다 — 사이드바 그룹마다 하나씩: Core(대시보드·Cluster View·Monitoring·AI Chat·Resource Graph·Change History·Advanced Search)는 `menu.dashboard`, Cluster와 Custom Resources는 `menu.cluster`, Workloads·Storage·Network·Gateway·GPU·Security·Configuration·Helm은 같은 이름의 키, Admin은 관리자 여부. 기본 역할은 `menu.*`를 가지므로 커스텀 역할에서만 그룹이 빠진다.
- **대시보드 개수**(네임스페이스·파드·노드 …)는 클러스터별 informer 캐시(`kubeast:cache` 신원)에서 세므로, 사용자 신원이 네임스페이스를 list 할 수 있는지(SelfSubjectAccessReview, 60초 캐시)를 먼저 묻고 안 되면 403을 돌려준다 — 그룹이 아직 바인딩되지 않은 커스텀 역할이나 네임스페이스 하나에만 묶인 사용자가 클러스터 전체 개수를 보지 않도록.
- **YAML 생성·편집**은 문서마다 그 Kind의 `resource.<이름>.create`(편집은 대상의 `resource.<이름>.edit`)를 본다. 이름은 Kind 소문자, 단 HorizontalPodAutoscaler·VerticalPodAutoscaler·PodDisruptionBudget·PersistentVolume·PersistentVolumeClaim·CustomResourceDefinition은 `hpa`·`vpa`·`pdb`·`pv`·`pvc`·`crd`, 자기 이름이 없는 Kind(CR 등)는 `customresource`. Write 그룹의 `edit`는 클러스터 범위 객체(Namespace·ClusterRole·StorageClass 등)를 만들 수 없어 그건 클러스터가 거부한다 — 그래서 그 화면들(클러스터 범위 15종 + Role·RoleBinding)의 생성 버튼은 앱 권한에 더해 클러스터에 직접 묻는다(`GET /api/v1/cluster/can-i?verb=create&group=&resource=`, 사용자 신원의 SelfSubjectAccessReview = `kubectl auth can-i`). 클러스터가 안 된다고 하면 버튼이 없다.
- **네임스페이스 범위 부여**: 클러스터별 역할을 네임스페이스 목록(최대 50)으로 한정할 수 있다 — 사용자 상세의 역할 옆 칸이나 클러스터 접근 창에서 적고(비우면 클러스터 전체), 부여 API는 `namespaces`로 받아 `/auth/me`(`cluster_namespaces`)와 토큰(`ns` 클레임)에 싣는다. 접근 요청도 목록을 가질 수 있고, 범위 부여를 가진 사람은 그 안에서만 요청한다(폼에 프리필·필수). 그런 부여는 Kubeast가 **그 네임스페이스 밖의 경로를 403으로 거르고**(클러스터에 묻기 전에, 쓰기는 감사 행), 네임스페이스 목록은 부여 목록 그대로, "전체 네임스페이스" 조회는 목록을 하나씩 모아 합치며, 대시보드 개수도 그 안에서만 센다(`scoped: true`, 노드·PV는 0). AI 도구와 MCP는 `namespace`를 꼭 받고 클러스터 전체 도구(overview·노드 메트릭·apply·create·API 목록·클러스터 설정)는 거부한다. 클러스터 쪽 신원은 `kubeast:role:<slug>` 그룹이라 **그 네임스페이스마다 RoleBinding을 묶기 전엔 클러스터가 거부한다** — 차트 `auth.impersonation.customRoles`에 `{name: Read, namespaces: [a, b], clusterRoles: [view]}`처럼 적으면 그 RoleBinding이 렌더된다(등록 클러스터마다 적용). 화면에선 네임스페이스 선택기가 부여된 것만 보여 주고, 권한 없음 안내에 "이 클러스터에서는 네임스페이스 a, b만"이 붙으며, 실시간 갱신도 네임스페이스별로 구독한다. Access Review 보고서·CSV에 `namespaces` 열이 있다.
- **SSO 그룹 → 역할**: OIDC 공급자가 주는 그룹을 `auth.oidc.roleMapping`(`<그룹>=<Admin|Member|커스텀>`, 계정 등급)과 클러스터별 부여 — 그룹 이름 `<clusterGroupPrefix><클러스터>:<역할>` 또는 이름을 못 정하는 그룹(Google 그룹 이메일·Entra 그룹 ID)은 `auth.oidc.clusterGroupMapping`(`<그룹>=<클러스터>:<역할>`) — 으로 바꾸고, `syncRoles`면 로그인마다 다시 맞춘다. **Google 로그인은 ID 토큰에 그룹이 없으므로** `auth.oidc.googleGroups`를 켜면 로그인 때 Admin SDK Directory API로 그 사람의 Workspace 그룹을 읽어 매핑에 걸리는 것만 더한다(회사 그룹 전체를 감사 행에 남기지 않음). 서비스 계정엔 Workspace 관리자 역할 **Groups Reader**(도메인 전체 위임 없음 — 대신 요청에 `domain`이 붙는다), 자격은 Secret의 `credentials.json` 하나: 키 없는 Workload Identity Federation 설정 파일(`external_account`, 이 클러스터 토큰이면 `tokenAudience`) 또는 서비스 계정 키. 조회가 실패하면 지금 역할을 그대로 두고 로그인 감사 행에 `groups_lookup: failed`를 남긴다. 관리자는 `GET /api/v1/auth/admin/oidc/groups?email=`로 그 사람의 매핑 결과를 미리 본다(매핑된 그룹 이름 + 나머지 개수, 감사 `admin.oidc.groups.read`). 공급자별 설정 순서(Keycloak·Google·Entra ID·Okta)·첫 관리자·로그인 실패 코드는 [docs/oidc.md](docs/oidc.md).
- `auth.impersonation.enabled=false`는 데모용이다: k8s-service가 `cluster-admin`, tool-server가 `*`로 돌고 읽기 API는 클러스터 부여만으로 열린다.
- **목록이 비었을 때 화면이 하는 말**: 권한이 없으면(403) "볼 권한이 없습니다"(위쪽 배너 + 표), 서버 오류·응답 없음이면 "불러오지 못했습니다(서버 오류 503)" + 다시 시도, 클러스터에 그 CRD가 없으면(Gateway API·VPA) "설치되어 있지 않습니다"(k8s-service가 discovery로 보고 빈 목록에 `X-Kubeast-Not-Installed` 헤더 — 역할과 무관하게 같은 답, 생성 버튼 없음). 그 밖엔 "없습니다". 없는 주소는 404 화면.
- 회귀 확인: `e2e/tests/rbac-matrix.spec.ts`(역할 × 동작 403/200 표) · `permission-ceiling.spec.ts`(남에게 자기 이상 못 줌) · `reader-ui-notices.spec.ts`(Read의 화면 안내) · `notices.spec.ts`(서버 오류·설치 안 됨·404·생성 버튼 can-i·권한 요청 안내).

### ☸️ Kubernetes 리소스 관리

| 도메인 | 리소스 |
| --- | --- |
| **Workloads** | Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, HPA, VPA, PDB |
| **Network** | Service, Endpoint(1.33부터 폐기된 API — 객체 화면은 남기고, Service 상세·리소스 그래프·AI 서비스 점검은 EndpointSlice를 읽음), EndpointSlice, Ingress, IngressClass, NetworkPolicy |
| **Gateway API** | Gateway, GatewayClass, HTTPRoute, GRPCRoute, ReferenceGrant, BackendTLSPolicy, Policies(모든 구현체의 정책 한 화면 — `gateway.networking.k8s.io/policy` 라벨 CRD 자동 탐색 + Envoy Gateway·Istio 내장 + `gatewayApi.policyKinds`) |
| **Storage** | PV, PVC, StorageClass, VolumeAttachment |
| **Configuration** | ConfigMap, Secret, ResourceQuota, LimitRange, PriorityClass, RuntimeClass, Lease |
| **Security (RBAC)** | Role, ClusterRole, RoleBinding, ClusterRoleBinding, ServiceAccount · Policy Reports(`wgpolicyk8s.io` 보고서 모음, CRD 있을 때) |
| **Cluster** | Node, Namespace, Webhook Configuration(Mutating/Validating), Admission Policy(Validating/Mutating — `admissionregistration.k8s.io/v1`, 읽기 전용, API가 없으면 "설치 안 됨"; `features.admissionPolicies.readOnly: true`면 공용 YAML 적용과 AI 쓰기 도구도 정책·바인딩 4종을 거부해 Git으로만 바꿈) |
| **Custom Resources** | CRD 동적 탐색 및 인스턴스 편집 |

- **YAML 편집** (Monaco), **Pod Exec / 로그** (xterm.js, WebSocket)
- **실시간 갱신** — WebSocket 멀티플렉서로 리소스 변경 스트리밍

### ⎈ Helm 릴리스 관리

- 릴리스 목록 / 상세 / 히스토리 / values / 매니페스트 / 리소스 보기
- **Rollback · Upgrade · Uninstall · Test** (모두 dry-run 미리보기 + 확인 후 실행)

### 🎮 GPU & DRA (Dynamic Resource Allocation)

- GPU 노드 / Pod / 사용률 대시보드, NVIDIA GPU 메트릭
- DeviceClass, ResourceClaim, ResourceClaimTemplate, ResourceSlice 관리

### 📊 관측성 (Observability)

- **Topology View** — 클러스터 리소스 관계 시각화 (React Flow / dagre / elkjs)
- **Dependency Graph** — 워크로드 간 의존성 그래프
- **Monitoring** — Prometheus 시계열 차트, 이상 감지, 상관 분석, GPU 심층 메트릭 (대상 클러스터에 있어야 하는 Prometheus·지표는 [docs/cluster-requirements.md §3](docs/cluster-requirements.md#3-prometheus))
- **Node Shell** — 웹 기반 노드 터미널
- **로그 파일** — 파일로 로그를 쓰는 앱의 컨테이너 안 로그를 허용 경로에서만 읽고 따라가기(고정 `tail`, 기본 off, 아래 절)
- **로그 검색** — Loki에서 재시작·삭제된 파드까지 텍스트·기간으로 찾기, 클러스터 RBAC(`pods/log`)대로(기본 off, 아래 절)
- **Advanced Search** — 표현식 기반 전역 리소스 탐색

### 🔐 인증 · 감사

- JWT 기반 자체 인증(JWKS) — 조직(Organization) / 팀(Team) / 사용자 계층
- **API 키** — 스크립트·CI용 자격(Settings → API keys). 키는 짧은 액세스 토큰으로 교환해 쓰며 클러스터 범위·역할 상한·만료를 갖고, 발급자의 권한을 넘지 못함(아래 "API 키" 절)
- **감사 로그** — 모든 쓰기 작업 + 민감 조회(Secret 열람, Node Shell, 컨테이너 로그 파일 열람, 로그 검색, Helm 변경 등)를
  기록, 성공/실패 모두 추적
- **클러스터 위생 점검** — Pod Security Standards·이미지 태그·리소스·Namespace 정책·RBAC·TLS 만료를 보는 사람 권한으로 읽어 한 장으로, CSV/JSON과 클러스터별 월간 서명(Admin → Cluster hygiene, 아래 절)
- **AI 사용량** — 채팅 턴과 Optimization의 AI 설명마다 남는 `ai.chat.complete` 감사 행(제공자가 보낸 토큰 수를 턴 단위로 합산)을 사용자·모델·클러스터별로 집계(Admin → AI Usage). 한도는 없고 누가 얼마나 썼는지 본다; 제공자가 usage를 안 보낸 호출은 합계에서 빼고 건수로 표시. 입력 토큰 옆의 **캐시 적중**은 제공자가 캐시에서 서빙한 입력 토큰(Anthropic `cache_read_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`)과 그 비율, 입력 토큰 칸의 툴팁은 ai-service가 실제로 보낸 프롬프트 평균 크기(시스템·도구 정의·이력·메시지 JSON 문자 수, `prompt_chars`) — 제공자 집계와 무관하게 이력 창·요약·도구 설명 변경의 효과를 보는 지표. 같은 행 합계로 **채팅 토큰 예산**을 걸 수 있음(`ai.chat.budget.sessionTokens` 세션 누적·`ai.chat.budget.userDailyTokens` 사용자 UTC 하루 누적, 기본 0 = 끔): 넘으면 그 턴은 모델 호출 없이 거부되고 채팅에 안내가 뜨며 `ai.chat.budget_exceeded`로 감사됨(사용량 기준이 이 화면과 같음)
- **i18n** — 한국어 · 영어. Kubernetes 리소스 종류(`StatefulSet`, `ConfigMap`, `Namespace` …)와 화면 이름(사이드바 항목·페이지 제목)은 두 언어 모두 영어로, 동사·설명·안내문만 번역합니다(예: "StatefulSet 생성", "전체 Namespace")

---

## 아키텍처

NGINX 게이트웨이가 모든 요청을 받아 각 마이크로서비스로 라우팅합니다.
영속 상태는 PostgreSQL, 캐시/세션 컨텍스트는 Redis가 담당합니다.

```
                         ┌──────────────────────────┐
                         │  Frontend (React + Vite) │
                         └────────────┬─────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │  Gateway (NGINX, :8000)  │  라우팅 · CORS · SSE/WS 프록시
                         └────────────┬─────────────┘
        ┌───────────┬─────────────────┼─────────────────┬───────────┐
        ▼           ▼                 ▼                 ▼           ▼
   ┌─────────┐ ┌─────────┐      ┌──────────┐      ┌─────────┐ ┌──────────┐
   │  Auth   │ │   AI    │      │   K8s    │      │ Session │ │   Tool   │
   │   Go    │ │ FastAPI │─────▶│   Go     │      │   Go    │ │  Server  │
   │  :8004  │ │  :8001  │      │  :8002   │      │  :8003  │ │   Go     │
   └────┬────┘ └────┬────┘      └────┬─────┘      └────┬────┘ └────┬─────┘
        │           │                │                 │           │
        │           └──────┐    ┌────┘                 │      kubectl → K8s API
        ▼                  ▼    ▼                       ▼
   ┌──────────┐        ┌──────────┐               ┌──────────┐
   │ Postgres │        │  Redis   │               │ K8s API  │ (멀티클러스터)
   └──────────┘        └──────────┘               └──────────┘

   model-config-controller (controller-runtime) — ModelConfig CRD 감시
```

**AI Tool-calling 흐름**: `ai-service`가 채팅을 오케스트레이션하며, 화이트리스트된
툴을 `tool-server`로 디스패치 → `tool-server`가 선택된 클러스터의 K8s API를 호출 →
결과가 채팅으로 스트리밍됩니다.

### 서비스 구성

| 서비스 | 언어 | 포트 | 역할 |
| --- | --- | --- | --- |
| `gateway` | NGINX | 8000 | API 라우팅, CORS, SSE/WebSocket 프록시 (이미지 빌드 없음, 설정만) |
| `auth-service` | Go | 8004 | 인증, JWT/JWKS, 조직/팀/RBAC, 클러스터 레지스트리 |
| `ai-service` | Python (FastAPI) | 8001 | LLM 통합, 스트리밍 챗봇, 최적화 제안, Tool calling |
| `k8s-service` | Go | 8002 | K8s 리소스 CRUD, WS 로그/exec, 토폴로지, Helm, GPU/DRA, 멀티클러스터 풀 |
| `session-service` | Go | 8003 | 채팅 세션 / 메시지 히스토리 |
| `tool-server` | Go | — | AI Tool 호출 백엔드 (kubectl 실행) |
| `model-config-controller` | Go (controller-runtime) | — | `ModelConfig` CRD 컨트롤러 |
| `frontend` | React + Vite + TS | 5173 | UI (prod 정적 빌드, nginx 서빙) |
| `postgres` | — | 5432 | 메인 DB (durable state) — PostgreSQL 18 |
| `redis` | — | 6379 | 캐시 / 세션 컨텍스트 — Valkey 9.1(Redis 프로토콜) |

### 컨테이너 이미지

모두 ghcr.io에 공개 패키지로 게시됩니다.

```
ghcr.io/junginho0901/kubeast-frontend
ghcr.io/junginho0901/kubeast-auth-service
ghcr.io/junginho0901/kubeast-ai-service
ghcr.io/junginho0901/kubeast-k8s-service
ghcr.io/junginho0901/kubeast-session-service
ghcr.io/junginho0901/kubeast-tool-server
ghcr.io/junginho0901/kubeast-model-config-controller-go
```

> 릴리스: `v*` 태그를 push하면 GitHub Actions(`.github/workflows/release.yaml`)가
> 7개 이미지를 ghcr에 자동 빌드·게시하고 Helm 차트를 패키징합니다.

---

## 설정 (values.yaml)

자주 쓰는 값:

```yaml
global:
  imageTag: "v0.1.0"

# 초기 관리자 계정 — password 를 비우면 설치 시 랜덤 생성
admin:
  email: admin
  password: ""          # 비우면 자동 생성 (secret 으로 확인)

# JWT 서명키 — 비우면 설치 시 생성해 Secret(kubeast-auth-keys)에 보관, upgrade 때 재사용.
# 직접 관리하는 Secret(키 이름 jwt_private.pem)이 있으면 지정.
# 토큰 60분(활동 중이면 UI가 자동 갱신), 셀프 가입·데모 계정은 기본 off
auth:
  signingKey:
    existingSecret: ""
  tokenTTLMinutes: 15
  allowRegistration: false
  bootstrapDemoUsers: false
  passwordMinLength: 12
  # 세션 쿠키 Secure(HTTPS에서만 전송). TLS 뒤(Ingress·Gateway API)면 true 유지,
  # localhost 아닌 주소를 plain http로 쓸 때만 false (아니면 로그인 쿠키가 버려짐)
  cookieSecure: true
  # 클러스터에는 로그인한 사용자 본인(이메일)으로 impersonation — 클러스터 RBAC이
  # 최종 판단, K8s audit에 사용자가 남음. 등록하는 모든 클러스터에 아래 RBAC 적용:
  #   helm template kubeast helm/kubeast -s templates/impersonation-rbac.yaml | kubectl --context <cluster> apply -f -
  # 아래 커스텀 역할·Read 프록시·로그 파일 권한까지 한 번에(쓰지 않는 템플릿은 건너뜀, docs/cluster-requirements.md §1):
  #   scripts/render-target-rbac.sh -f values.yaml -f <그 클러스터 값> | kubectl --context <cluster> apply -f -
  # (Kubeast 자격증명은 ClusterRole kubeast-impersonator 만 있으면 됨 — 설치된
  #  클러스터의 k8s-service·tool-server ServiceAccount도 이것과 kubeconfig Secret
  #  읽기 Role만 받음; false면 예전처럼 cluster-admin)
  # 커스텀 역할(Read/Write/Admin 외)을 클러스터에 부여하면 그룹 kubeast:role:<slug>로
  # 동작하는데, 위 RBAC은 고정 그룹 4개만 impersonate 허용 → customRoles에 적어야
  # 그 그룹이 허용되고 적은 ClusterRole에 묶임(등록 클러스터마다 같은 렌더 적용):
  #   helm template kubeast helm/kubeast -s templates/impersonation-custom-roles.yaml -f values.yaml | kubectl --context <cluster> apply -f -
  # 네임스페이스 범위 부여(Read/Write/Admin이든 커스텀이든 그룹 kubeast:role:<slug>)는
  # 항목에 namespaces를 적으면 그 네임스페이스마다 RoleBinding으로 묶인다.
  # Read(kubeast:viewer)는 기본 view라 프록시가 없음 → Prometheus·OpenCost 화면이 거부됨.
  # viewerProxyServices에 그 클러스터의 Service를 적으면 그 Namespace에 Role을 만들어
  # "<service>:<port>" GET만 허용(다른 Service·POST·NS 범위 부여는 그대로 거부, 클러스터마다 그 클러스터 값으로):
  #   helm template kubeast helm/kubeast -s templates/impersonation-viewer-proxy.yaml -f values.yaml | kubectl --context <cluster> apply -f -
  impersonation:
    enabled: true
    clusterRoles: true
    customRoles: []
    #  - name: Read
    #    namespaces: [team-a, team-b]
    #    clusterRoles: [view]
    #  - name: sre-readonly
    #    clusterRoles: [view, "kubeast:cluster-reader"]
    viewerProxyServices: []
    #  - {namespace: monitoring, service: prometheus, port: 9090}
    #  - {namespace: opencost, service: opencost, port: 9003}
  # 임시 권한 요청 — 기본 off. 켜면 사용자가 Settings → Cluster access에서 이미 권한이 있는
  # 클러스터에 더 높은 역할(기본 Write까지)을 최대 maxHours 동안 사유와 함께 요청하고,
  # 관리자(본인 제외)가 Admin → Access requests에서 승인·거절. 승인되면 요청자는 다시
  # 로그인해 그 역할로 들어오고, 시간이 지나면 자동으로 이전 역할로 돌아간다(감사 로그
  # access.request.* / access.grant.expire). 클러스터 RBAC가 그 역할의 그룹을 바인딩한
  # 클러스터에서만 효력이 있다(viewer만 바인딩한 운영 클러스터에선 승격돼도 403).
  accessRequests:
    enabled: false
    maxHours: 8
    roles: [Write]
  # 클러스터가 하나도 없는 사용자에게 "어디서 권한을 요청하나" — 대시보드·Settings의
  # "접근 가능한 클러스터 없음" 아래에 보인다. 한 줄 문구 + http(s) 링크(사내 요청 양식 등).
  # #이 들어가면 따옴표로 감싼다(YAML 주석). 비우면 일반 문구만
  accessHelp:
    text: ""
    url: ""

# EKS: k8s-service·tool-server 파드가 aws-iam-authenticator를 실행할 IRSA 롤 + STS 리전
aws:
  irsaRoleArn: ""
  region: ""
# 서비스마다 자기 롤(IRSA)이나 다른 클라우드 워크로드 아이덴티티 주석 — 감사 S3 싱크는
# authService, S3 세션 기록은 k8sService(aws.irsaRoleArn 위에 덮어씀)
serviceAccounts:
  authService:
    annotations: {}   # eks.amazonaws.com/role-arn: arn:aws:iam::<계정>:role/kubeast-audit-sink
  k8sService:
    annotations: {}

# 콘솔 자체 메트릭 — 백엔드 5개가 각자 포트의 /metrics로 Prometheus 메트릭을 냄
# (요청 수·지연·진행 중, 감사 저장소 상태, WebSocket 구독; docs/metrics.md).
# 게이트웨이는 /metrics를 프록시하지 않음. prometheus-operator가 있으면 ServiceMonitor,
# networkPolicy.enabled면 스크레이퍼를 from에 적어 열어 줌. 알람 5개는 prometheusRule.
metrics:
  enabled: true
  serviceMonitor:
    enabled: false
    interval: 30s
    labels: {}            # kube-prometheus-stack: {release: <그 릴리스 이름>}
  networkPolicy:
    from: []
  prometheusRule:
    enabled: false

# 서비스 간 토큰 — k8s-service의 /internal 라우트(tool-server의 kubeconfig 조회,
# auth-service의 validate·invalidate)는 사용자 JWT에 더해 Secret kubeast-secrets의
# INTERNAL_API_TOKEN을 X-Internal-Token으로 요구한다(차트가 생성·보존). 회전 = 값 교체 후
# auth-service·k8s-service·tool-server 롤아웃. secrets.existingSecret를 쓰면 그 Secret에 넣는다.

# 노드 셸(특권 디버그 파드) — 기본 off. 켜면 전용 네임스페이스 + 이미지 허용 목록(첫 항목이 기본).
# 이미지는 IfNotPresent로 받으므로 버전을 고정(또는 사내 미러 주소) — 이미 받은 노드는 레지스트리에 안 감
nodeShell:
  enabled: false
  images:
    - docker.io/library/busybox:1.38.0

# 파드 보안 (Pod Security Standards restricted 기본). 사용자 네임스페이스를
# 지원하지 않는 클러스터(커널 6.3 미만)에서는 hostUsers: true
podSecurity:
  enabled: true
  hostUsers: false
  readOnlyRootFilesystem: true

# 가용성 — replicas 를 2 이상으로 올릴 때 pdb.enabled: true
replicas:
  gateway: 1
pdb:
  enabled: false
topologySpread:
  enabled: true
resources:               # 컨테이너별 requests / memory limit (전체는 values.yaml)
  aiService:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { memory: 1Gi }

# AI 키 — ai-service 환경변수로만 주입되고 DB에는 저장되지 않음. 모델 설정(UI/CRD)은
# 변수 이름(api_key_env)만 가리킴. ESO 등으로 만든 Secret이 있으면 apiKeysSecret에 지정
ai:
  openaiApiKey: ""
  anthropicApiKey: ""
  geminiApiKey: ""
  claudeCodeOAuthToken: ""  # Claude 구독 setup-token(provider claude-code, 개인용 — "4. AI 활성화" 참고)
  apiKeysSecret: ""
  model: "gpt-4o-mini"
  baseUrlAllowedHosts: []  # 모델 설정 base_url이 사설 주소(클러스터 안 Ollama·사내 LLM 게이트웨이)면 여기 등록. api_key_env는 OPENAI/ANTHROPIC/GEMINI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN(claude-code 전용) 또는 KUBEAST_AI_KEY_*
  providers:
    claudeCode: { enabled: false, maxConcurrent: 1, turnTimeoutSeconds: 300, maxTurns: 10 }

# 내장 PostgreSQL / Redis (false 면 외부 사용)
postgresql:
  enabled: true
  user: kubeast
  password: ""          # 비우면 설치 때 생성·업그레이드에도 유지 (secret 으로 확인). 외부 DB(enabled: false)면 필수
  database: kubeast
redis:
  enabled: true
  password: ""          # requirepass — 비우면 생성 (REDIS_PASSWORD)
networkPolicy:
  enabled: true         # 기본 거부 + 서비스가 쓰는 흐름만. NetworkPolicy를 강제하지 않는 CNI(kindnet 등)에선 무해

# Gateway 노출 방식
gateway:
  service:
    type: NodePort        # NodePort | ClusterIP | LoadBalancer
    nodePort: 30333
  trustedProxies: []      # 앞단 프록시(Ingress 컨트롤러·LB) CIDR — 감사 로그의 클라이언트 주소를 그 뒤에서 읽음
  allowedOrigins: []      # 게이트웨이 자기 호스트·Ingress 호스트 외에 API·WebSocket을 열 브라우저 origin(없으면 같은 호스트만)

# Ingress (선택)
ingress:
  enabled: false
  className: ""
  host: kubeast.example.com
  tls: false

# 멀티클러스터 부하/장애 격리 튜닝
multicluster:
  maxClusters: 20
  healthcheckIntervalSec: 60
  rateLimitQPS: 0           # 0 = off
  breakerConsecutiveFails: 5
```

전체 옵션은 [helm/kubeast/values.yaml](helm/kubeast/values.yaml) 참고.

---

## 디렉터리 구조

```
.
├── services/
│   ├── ai-service/                  # Python · FastAPI · LLM 통합 / Tool calling
│   ├── auth-service-go/             # Go · 인증 / RBAC / 클러스터 레지스트리
│   ├── k8s-service-go/              # Go · K8s 리소스 API / Helm / 멀티클러스터
│   ├── session-service-go/          # Go · 채팅 세션
│   ├── tool-server/                 # Go · AI Tool 백엔드 (kubectl)
│   ├── model-config-controller-go/  # Go · ModelConfig CRD 컨트롤러
│   └── pkg/                         # Go 공통 (audit / auth / cluster / config …)
├── frontend/                        # React + TS + Tailwind
├── helm/kubeast/                    # Helm 차트 — 모든 설치 경로의 유일한 매니페스트 원본 (정본 nginx.conf = files/nginx.conf)
├── deploy/kind/                     # 로컬 kind 개발 설치 값 (values.yaml; 개인 값은 values.local.yaml, git 제외)
├── deploy/examples/target-cluster/   # 대상 클러스터 준비물 예시 값 (Prometheus·OpenCost 차트, 클러스터별 RBAC 값 — docs/cluster-requirements.md)
├── docs/                            # 운영 문서 (클러스터 준비물·SSO·메트릭·감사·백업·공급망)
├── e2e/                             # Playwright E2E (라이브 클러스터 대상)
│   └── actions/                     # 옵트인 동작 스위트 — UI 동작 92개 + kubectl 검증 (E2E_ACTIONS=1 --project=actions)
├── scripts/                         # 빌드/배포/개발 스크립트
├── install.sh                       # K8s 원라인 설치
├── install-docker.sh                # Docker 원라인 설치
└── docker-compose.yml               # (+ docker-compose.build.yml 빌드 override)
```

---

## 개발

로컬 개발 루프는 kind 기반이고, dev 클러스터도 **같은 Helm 차트**로 설치합니다(`deploy/kind/values.yaml`
— NodePort 30080·localhost origin·데모 계정·토큰 60분 같은 dev 차이만). 빌드/배포는 **항상
`scripts/rebuild-kind.sh`**를 통해 수행합니다(직접 docker/kubectl 금지).

```bash
scripts/kind-deploy.sh                        # 처음: kind 생성 + 이미지 빌드·적재 + helm install
scripts/rebuild-kind.sh ai-service frontend   # 특정 서비스 재빌드+배포
scripts/rebuild-kind.sh --all                 # 전체
scripts/rebuild-kind.sh gateway               # nginx.conf만: 릴리스 값 그대로 helm upgrade(이미지 빌드 없음)
scripts/reset-and-deploy.sh [--keep|--db]     # 전체 재생성 / 릴리스·DB만 재설치 / DB만 비우기
```

kind 노드는 postgres·redis·nginx 이미지를 레지스트리에서 당기는데, 프록시 뒤라 안 되면 `kind-deploy.sh`가
호스트 docker에 있는 같은 이미지를 노드에 넣습니다(미리 `docker pull` 해 두면 됨).

AI 채팅과 AI e2e 스펙은 기본 모델이 하나 등록돼 있어야 합니다. 노트북에서 Ollama를 돌린다면
`kubectl apply -f deploy/kind/modelconfig-ollama.yaml`(모델 `granite4.1:3b`, `host.docker.internal:11434`
— dev 값이 그 주소를 `ai.baseUrlAllowedHosts`와 NetworkPolicy에서 허용)로 등록하면 되고, 리셋 뒤에도 다시 적용합니다.
노트북에서 추론을 돌리지 않고 e2e를 전부 돌리려면 `scripts/kind-model-haiku.sh up <키 파일>`로 Anthropic Claude Haiku(`claude-haiku-5-5`, 가장 싼 모델)를 그 실행 동안의 기본 모델로 두고(키는 파일에서 Secret `kubeast-ai-keys`로만 들어가고 출력되지 않음), 끝나면 `down`으로 Ollama 기본·키 제거까지 되돌립니다. Claude 구독 프로바이더로 AI spec을 돌릴 때는 `scripts/kind-model-subscription.sh up <토큰 파일>`(ai-service를 `WITH_CLAUDE_CODE=true`로 빌드한 뒤, 토큰은 `claude setup-token` 값)·`down`을 같은 방식으로 씁니다. 그동안 알림 → AI 조사 spec은 건너뜁니다. 스크립트는 자기가 있는 체크아웃의 chart로 helm upgrade하므로 브랜치 작업 중에는 그 워크트리에서 실행합니다.

### E2E 테스트 (Playwright)

`e2e/`는 개발 서버가 아니라 **dev kind 클러스터의 게이트웨이**(`E2E_BASE_URL`, 기본 `http://localhost:30080`)를 상대로 돌고, 공유 클러스터 상태를 바꾸므로 한 번에 하나씩(`workers: 1`) 실행합니다. 화면 비교 스펙은 main에서 찍은 기준 이미지와 비교합니다.

```bash
export KUBECONFIG=$PWD/.kubeconfig-kind      # kubectl을 부르는 스펙이 dev kind만 보게(기본 kubeconfig 금지)
export E2E_USER_EMAIL=admin E2E_USER_PASSWORD="$(kubectl -n kubeast get secret kubeast-secrets -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' | base64 -d)"
cd e2e && npx playwright test                 # 전체
npx playwright test cluster-hygiene.spec.ts   # 스펙 하나
```

전제(없으면 해당 스펙은 실패하지 않고 사유를 남기며 건너뜀):

- **두 번째 클러스터 `default`** — `scripts/add-kind-cluster.sh default --addons`: `kubeast` 네임스페이스는 없고 metrics-server·kube-state-metrics·node-exporter·작은 Prometheus·그 Prometheus를 읽고 또 그 Prometheus가 긁는 OpenCost(`deploy/kind/second-cluster.yaml`), 그리고 Audit 정책 2개를 둔 Kyverno 1.19(차트 3.9.1을 `helm template --no-hooks`로 렌더해 server-side 적용 — `default`엔 Helm 릴리스가 없어야 `helm.spec.ts`의 빈 목록 기준선이 맞음; `deploy/kind/kyverno-values.yaml`·`kyverno-policies.yaml`, `policy-reports.spec.ts`가 읽는 PolicyReport의 출처)가 있는 kind. `?cluster=` 없이 연 화면은 이 클러스터를 보여 주므로, 객체가 필요한 드로어 스펙은 `?cluster=self`로 고정합니다.
- **픽스처** — `deploy/kind/fixtures.yaml`(`kind-deploy.sh`가 적용): CronJob·TLS Ingress·StatefulSet·HPA·RuntimeClass·Argo CD 어노테이션 Deployment, 이슈 스펙용 깨진 객체 2(스케줄 안 되는 Deployment, 실패한 Job), 로그를 파일로만 쓰는 `e2e-logfile-writer`(`logfiles.spec.ts`용). dev 값은 `features.prometheus.enabled`와 `features.logFiles`(`/var/log/app/*.log`, `default`)가 켜져 있습니다.
- **AI 스펙** — 기본 모델 1개(위 Ollama `ModelConfig`).
- **감사 싱크·세션 기록 스펙** — `deploy/kind/devtools.yaml`(S3 스탠드인·Mailpit·웹훅 수신기)과 dev 값의 싱크·`sessionRecording.enabled`.
- 리셋하면 위 데이터가 다 사라지므로 다시 만듭니다.

`e2e/actions/`는 옵트인 동작 스위트(UI 동작 92개를 두 번째 클러스터에 실행하고 `kubectl`로 확인, 약 12분)라 기본 실행에 들어가지 않습니다: `E2E_ACTIONS=1 npx playwright test --project=actions` — 전제는 [e2e/actions/README.md](e2e/actions/README.md).

### API 키 (자동화)

사람 로그인 대신 스크립트·CI가 쓰는 긴 자격입니다. Settings → API keys에서 이름·만료(기본 30일, 상한은 차트
`auth.apiKeys.maxDays`)·클러스터·역할 상한(기본 Read)을 정해 발급하면 값(`kbk_…`)이 한 번만 보입니다. 키는 그
자체로 API를 부르지 않고 짧은 액세스 토큰으로 교환해 씁니다 — 토큰은 발급자가 그 순간 가진 권한을 키의 범위로
잘라낸 것이라 발급자보다 많은 일을 할 수 없고, 키를 폐기하면 다음 교환부터 거부됩니다(관리자는 사용자 상세에서
남의 키를 폐기할 수 있고, 발급은 본인만).

```bash
TOKEN=$(curl -s -X POST https://console.example.com/api/v1/auth/token \
  -H "Authorization: Bearer $KUBEAST_API_KEY" | jq -r .access_token)     # expires_in 초 뒤 다시 교환
curl -s "https://console.example.com/api/v1/cluster/overview?cluster=prod" \
  -H "Authorization: Bearer $TOKEN" -H "X-Cluster-Name: prod"
```

`?cluster=`를 빼면 레지스트리 기본 클러스터(self 클러스터, 없으면 가장 먼저 등록한 것)로 가고 권한도 그 클러스터로 검사합니다. 어느 클러스터인지는 `GET /api/v1/cluster/current`(`{"id": "…"}`)로 확인합니다.

끄려면 `auth.apiKeys.enabled: false`(컴포즈는 `API_KEYS_ENABLED`). 발급·폐기·교환은 감사 로그에 남습니다.

### AI 에이전트 연결 (MCP 서버)

Claude Code·Cursor 같은 AI 에이전트가 클러스터를 보게 하려면 보통 kubeconfig를 에이전트에 쥐여 줍니다. 그러면
누가 무엇을 했는지 감사에 안 남고, 에이전트가 사람보다 많은 권한을 쥐고, Secret 값이 그대로 모델로 갑니다.
Kubeast의 MCP 서버(`/api/v1/ai/mcp`, [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports))는
그 자리를 대신합니다 — 에이전트는 **API 키 하나**로 연결하고, 채팅과 같은 **읽기 도구**를 **그 사람 권한으로만**(클러스터별 역할,
impersonation) 씁니다. 결과는 모델로 가기 전에 마스킹되고(Secret 값은 늘 제거), 호출마다 감사 로그 `ai.mcp.call`이
남으며, 감사 행을 못 쓰면 호출이 거부됩니다. 쓰기 도구는 기본으로 없고, 운영자가 켜면(`mcp.writeTools`) 상한이 Write인 키에만
열립니다.

```bash
# Settings → API keys에서 키를 발급한 뒤(클러스터·역할 상한 지정), 에이전트에 등록
claude mcp add --transport http kubeast https://console.example.com/api/v1/ai/mcp \
  --header "Authorization: Bearer $KUBEAST_API_KEY"
```

- 켜기: `mcp.enabled: true`(컴포즈는 `MCP_ENABLED`). 기본은 꺼짐이고, 꺼져 있으면 경로가 없습니다.
- 권한: 그 클러스터에 `ai.mcp.use`(시스템 Read·Write 역할에 포함, Admin은 전부)와 쓰려는 도구의 `ai.tool.<이름>`(Read는 읽기 도구 25종만, Write는 전부 + 쓰기 미리보기 `k8s_diff`; `hygiene`은 `admin.hygiene.read`를 가진 Admin에게만 보임). `list_clusters`가
  연결한 사람이 쓸 수 있는 클러스터와 도구를 알려 주고, 나머지 도구는 `cluster` 인자가 필수입니다(기본 클러스터로 떨어지지 않음).
- 인증: `Authorization: Bearer` 헤더에 API 키(`kbk_…`) 또는 액세스 토큰. 키는 서버가 짧은 토큰으로 교환해 쓰고(교환도 감사), 키를
  폐기하면 다음 호출부터 거부됩니다. 세션이 없어(stateless) 요청마다 검사하고, 복제본이 여럿이어도 됩니다.
- 감사: `ai.mcp.call`의 `after`에 도구·클러스터·마스킹 통계·자격(`credential.akid` = 키 id)·클라이언트(User-Agent)·`write`(쓰기 도구
  여부). 권한 밖 호출도 `failure`로 남습니다.
- 쓰기 도구(`mcp.writeTools: true`, 컴포즈는 `MCP_WRITE_TOOLS`, 기본 꺼짐): 채팅의 쓰기 도구 11개(apply·create·delete·patch·
  annotate·label·scale·rollout·exec …)가 **역할 상한이 Write인 키**에 같이 나옵니다. 채팅의 승인 카드(`ai.writeApproval`)는 MCP에
  없습니다 — 그 사람이 그 클러스터에서 할 수 있는 만큼(영구 역할, 또는 [접근 요청](#접근-요청)으로 받은 임시 역할)만 되고, 호출마다
  `write: true`로 감사에 남습니다. 도구 어노테이션(`destructiveHint`)이 정직하게 붙어 Claude Code 같은 클라이언트가 호출 전에 사용자에게 확인을
  띄웁니다. Argo CD가 관리하는 객체는 가드 모드대로 — `block`이면 거부(“Git에서 바꾸세요”), `warn`이면 실행하고 결과 첫 줄에
  경고를 붙입니다. 권한이 모자라면 에이전트가 `request_access` 도구로 접근 요청을 직접 내고(관리자 승인 → 1분 안에 반영) 다시
  시도합니다.

### 접근 권한 검토 (Access review)

"지금 누가 무엇을 할 수 있나"를 한 장으로 뽑아 주기적으로 검토하고 "검토했다"를 남기는 기능입니다(ISMS-P 2.5.6 접근권한 검토, NIST 800-53 AC-2(j)). 관리자 → Access review에 섹션 5개가 표로 뜹니다.

| 섹션 | 내용 | 플래그 |
|---|---|---|
| 사용자 | 이메일·팀·전역 역할·인증 출처·생성일·**마지막 로그인**(`auth_users.last_login_at`, 로그인 성공마다 기록·감사 로그로 백필)·클러스터 역할/API 키/임시 권한 개수 | `global_admin` · `never_logged_in` · `dormant`(마지막 로그인 또는 생성이 `dormantDays` 전) · `locked` |
| 클러스터 역할 | 사용자별 클러스터·역할, 영구/요청 경유, 만료·복귀 역할 | `temporary` · `admin_role` |
| API 키 | 소유자·이름·접두어·클러스터·역할 상한·생성·만료·마지막 사용 | `expired` · `expiring_30d` · `unused_30d` |
| 임시 권한 이력 | 마지막 검토 이후의 권한 요청: 신청자·클러스터·역할·기간·사유·승인자·결정·종료 | — |
| 역할 | 이름·시스템 여부·권한 목록·쓰는 사용자/바인딩 수 | `has_admin_permissions` · `unused` |

- 탭마다 **CSV**(UTF-8 BOM, 수식 주입 방지) · 상단 카드에 전역 Admin·휴면·만료 임박 키·활성 임시 권한 수와 **마지막 검토·다음 기한**(`intervalDays` 뒤, 지나면 표시).
- **검토 완료** 버튼이 메모와 함께 그 시점 보고서를 통째로 저장합니다(`access_reviews`, 보존 `retention.reviewDays` 기본 3년). 지난 검토는 목록에서 열어 보고 그때 CSV로 다시 내려받을 수 있습니다.
- 권한 `admin.review.read` · `admin.review.export` · `admin.review.signoff`(시스템 Admin 역할에 포함), 감사 액션도 같은 이름. 쓰기는 서명뿐이고 권한 변경은 기존 화면에서 합니다.
- 끄려면 `auth.accessReview.enabled: false`(메뉴·API가 사라짐). 비용: 페이지를 열 때 조회 7번, 서명 1건당 스냅샷 수십 KB.

### 정책 보고서 (Policy Reports)

Kyverno·Trivy Operator 같은 정책 엔진이 리소스마다 쓰는 `wgpolicyk8s.io/v1alpha2` `PolicyReport`(Namespace 리소스)·`ClusterPolicyReport`(클러스터 리소스)를 **읽기만** 해서 모아 보여 줍니다. Kubeast는 정책을 만들거나 데이터를 저장하지 않습니다.

- **화면** — Security → Policy Reports: fail·warn·error·pass·skip 합계, 정책별(분류·심각도·출처·Namespace 수)·Namespace별 탭, 결과 탭(결과·심각도·정책·Namespace·검색 필터, 행을 누르면 그 리소스 드로어). 워크로드·Pod 드로어의 "Policy violations" 절은 그 리소스의 fail/warn/error 행이며 워크로드는 자기 파드의 행을 함께 보여 줍니다(대부분의 정책이 Pod를 봄). CRD가 없는 클러스터는 "설치되어 있지 않습니다", 드로어 절은 숨김.
- **API** — `GET /api/v1/cluster/policyreports/status`(켜짐·CRD 유무) · `…/summary?namespace=`(정책별·Namespace별 집계 — 보고서의 `summary`가 아니라 결과 행을 셈) · `…/results?namespace=&policy=&result=fail,warn&severity=&kind=&search=&limit=`(기본 fail·warn·error, 최대 2,000행, `total`은 자르기 전 수) · `GET /api/v1/cluster/namespaces/{ns}/policyreports/resource?kind=&name=`. 데이터 라우트는 CRD가 없으면 빈 목록 + `X-Kubeast-Not-Installed`.
- **신원·범위** — 보고서는 **로그인 사용자로** 읽으므로 클러스터 RBAC이 상한입니다. Kyverno 차트 기본(`rbac.roles.aggregate.view: true`)이 `view`에 보고서 읽기를 붙이므로 Read(`kubeast:viewer`)도 읽힙니다. Namespace 범위 부여는 그 Namespace들의 보고서만 Namespace마다 따로 읽고(전체 목록 없음), ClusterPolicyReport는 클러스터 전체 보기에서만.
- **무게** — 열 때만 읽고 결과를 클러스터·Namespace·사용자별로 60초 둡니다(`force_refresh=true` = 화면의 새로고침은 그 캐시를 건너뛰고 다시 읽어 캐시를 갈아 끼움 — Kyverno는 새 객체의 보고서를 Pod·Deployment 약 20초, ReplicaSet 약 40초 뒤에 씀). 보고서 5,000개·결과 50,000행에서 읽기를 멈추고 `truncated: true`(화면 안내 — Namespace나 정책으로 좁히면 됨). 500개씩 페이지로 받습니다.
- 권한 `resource.policyreport.read`(Read 역할의 `resource.*.read`에 포함), 차트 `features.policyReports.enabled`(기본 켬, 끄면 404·메뉴·절 숨김), 감사 없음(일반 읽기). dev 2번 클러스터의 Kyverno·정책은 `deploy/kind/kyverno-*.yaml`.

### 클러스터 위생 점검 (Cluster hygiene)

클러스터에 지금 떠 있는 것의 **설정상 위험**을 한 장으로 모으고, 월간 점검을 했다는 서명을 남깁니다(ISMS-P 2.10.2 보안설정 모니터링·2.11.2 정기 점검). 이슈 확인이 "지금 터진 문제"라면 이건 정상 동작 중이어도 위험한 설정입니다. 외부 스캐너를 깔지 않고, Admin → Cluster hygiene에서 클러스터를 고르면 k8s-service가 **보는 사람의 신원**(impersonation)으로 파드·Namespace·NetworkPolicy·RBAC·`kubernetes.io/tls` Secret을 읽어 그 자리에서 판정합니다(백그라운드 작업 없음). 못 읽은 목록은 숨기지 않고 "건너뛴 점검"으로 보여 줍니다.

| 점검 | 근거 | 심각도 |
|---|---|---|
| privileged · 호스트 네임스페이스(hostNetwork/PID/IPC) | Pod Security Standards baseline · CIS 5.2.2~5.2.5 | 치명 |
| hostPath · hostPort · baseline 밖 capability · 기타 baseline(HostProcess·프로브 host·AppArmor·SELinux·/proc·seccomp Unconfined·sysctl) | PSS baseline(v1.37 표의 허용값 그대로) · CIS 5.2.8~5.2.12 | 경고 |
| restricted 미충족(권한 상승·non-root·seccomp·drop ALL·볼륨 종류) | PSS restricted · CIS 5.2.6/5.2.7 | 참고 |
| `:latest`·태그 없는 이미지(digest 고정은 통과) · 메모리 limit 없음 | Kubernetes Images · 보안 체크리스트 | 경고 |
| CPU·메모리 requests 없음 | 보안 체크리스트 | 참고 |
| PSS `enforce` 라벨 없는 Namespace · NetworkPolicy 없는 Namespace | 보안 체크리스트 · CIS 5.2.1/5.3.2 | 경고 |
| `default` Namespace 사용 · default ServiceAccount 토큰 마운트 | CIS 5.6.4 · 5.1.5/5.1.6 | 참고 |
| cluster-admin 바인딩(기본 `cluster-admin`·`kubeadm:cluster-admins`·`system:`·`eks:` 제외) · `*` 동사/리소스 Role·ClusterRole | CIS 5.1.1 · 5.1.3 | 경고 |
| TLS 인증서 만료(지남·`tlsCriticalDays` 이내 = 치명, `tlsWarnDays` 이내 = 경고) — 서버에서 `tls.crt`만 파싱, 응답엔 만료일·대상 이름만 | 보안 체크리스트 · cert-manager는 수명 2/3에서 갱신 | 치명/경고 |
| **업그레이드 준비**(대상 = 지금 마이너 + 1, 화면 머리에 표시) — Helm 릴리스 매니페스트에 남은 제거 API(다음 `helm upgrade`가 깨짐) · CRD의 served 아닌 storedVersions · 아직 폐기 API를 부르는 클라이언트(`apiserver_requested_deprecated_apis`, `/metrics` 권한이 있을 때) · fail-closed 웹훅(백엔드 없음/준비된 엔드포인트 0 = 치명, 전부 매치·caBundle 없음 = 경고) · 드레인을 막는 PDB(`disruptionsAllowed 0`) · kubelet 버전 차이(서버보다 높음 = 치명, 대상보다 3 마이너 넘게 낮음 = 경고) · kube-proxy ipvs(1.35 폐기) · gitRepo 볼륨(1.36 기본 비활성) · Service `externalIPs`(1.36 폐기) · `scheduling.k8s.io/v1alpha2` 객체(1.37 제거) · cgroup v1 계열 노드 OS(1.35 폐기, 노드에서 `stat -fc %T /sys/fs/cgroup/`로 확인) | [Deprecated API Migration Guide](https://kubernetes.io/docs/reference/using-api/deprecation-guide/) · 릴리스 변경 로그 1.35~1.37 · [Version Skew Policy](https://kubernetes.io/releases/version-skew-policy/) · EKS는 콘솔 Upgrade insights도 함께 | 치명/경고/참고 |

- 같은 워크로드의 파드는 한 줄로 묶습니다(Deployment·StatefulSet·DaemonSet·Job, 파드 수 표시). 시스템 Namespace(`excludeNamespaces`, 기본 kube-system·kube-public·kube-node-lease)는 워크로드·Namespace·Role·TLS 점검에서 뺍니다.
- **예외**: 객체(파드는 템플릿)나 그 Namespace에 `kubeast.io/hygiene-exempt: "image.latest,pss.hostpath"`(또는 `*`)와 `kubeast.io/hygiene-exempt-reason: <사유>`를 붙이면 그 항목은 "예외(사유)"로 남고 건수에서 따로 셉니다. 사유가 없으면 예외로 치지 않고 그렇다고 적습니다. 차트가 만드는 `kubeast:admin` 바인딩은 이 방식으로 이미 예외입니다.
- **내보내기·서명**: CSV(BOM·CRLF, 수식 문자 무력화)·JSON을 내려받고, 클러스터별로 메모와 함께 서명하면 그 순간 보고서가 스냅샷으로 저장됩니다(`hygiene_reviews`, `retention.reviewDays` 동안). 화면에 마지막 서명과 다음 기한(`intervalDays`, 기본 30일)이 보입니다. n8n 같은 자동화는 API 키로 `GET /api/v1/cluster/hygiene?cluster=<id>&format=json`을 가져가면 됩니다. 항목의 `message`는 영어 문장(CSV·스냅샷도 이것)이고, 화면은 같은 내용을 `message_key`·`message_args`로 받아 화면 언어로 보여 줍니다.
- 권한: `admin.hygiene.read`(보기·이력) · `admin.hygiene.export` · `admin.hygiene.signoff`(Admin에 포함). 감사: 조회 `k8s.hygiene.scan`(Secret을 읽으므로 민감 조회 — 기록이 안 되면 503), `admin.hygiene.export` · `admin.hygiene.signoff` · `admin.hygiene.read`(스냅샷). 보고서는 읽기만 하고 아무것도 고치지 않습니다 — 고치는 건 gitops로.

```yaml
features:
  hygiene:
    enabled: true            # false = 메뉴·API 404
    intervalDays: 30
    excludeNamespaces: [kube-system, kube-public, kube-node-lease]
    tlsWarnDays: 30
    tlsCriticalDays: 7
```

### 휴면 계정 자동 잠금 (Dormant accounts)

위 보고서가 휴면 계정을 **보여 주는** 것이라면, 이 기능은 사람이 안 봐도 **닫습니다**(ISMS-P 2.5.6 결함 사례 "6개월 이상 미접속 계정 활성", NIST 800-53 AC-2(3)). `auth.dormantAccounts.enabled: true`면 auth-service 안의 스위퍼가 `sweepHours`(24)마다 돌면서 `days`(90) 동안 **로그인도 API 키 교환도 없는 계정**(한 번도 안 쓴 계정은 생성일 기준)을 잠그고 그 계정의 세션을 회수합니다. 잠긴 계정은 비밀번호 로그인·SSO·API 키 교환이 모두 거부되고(응답은 일반 401, 사유는 감사 로그 `reason: dormant`), 관리자가 Admin → User Management에서 **잠금 해제**를 눌러야 다시 들어옵니다.

- `exemptAdmins: true`(기본)면 역할에 `*`나 `admin.*` 권한이 있는 계정은 잠그지 않습니다 — 마지막 관리자까지 잠기면 아무도 못 풀기 때문. 대신 접근 권한 검토 보고서에 `dormant`로 계속 보입니다.
- Admin → User Management: 잠긴 계정에 "휴면 잠김"/"잠김" 배지와 **잠금 해제** 버튼, 상단에 **휴면 계정 지금 점검**(스위퍼를 즉시 1회 실행, `admin.users.update`). 감사 액션: `user.account.dormant_lock`(actor `system`) · `admin.dormant.sweep` · `admin.users.unlock`.
- 끄면 스위퍼가 멈추고 새로 잠그지 않지만, 이미 잠긴 계정은 풀 때까지 그대로입니다. 접근 권한 검토의 `dormantDays`(표시 기준)와는 별개 값이라 "60일부터 표시, 90일에 잠금"처럼 벌릴 수 있습니다.

### Argo CD 가드 (GitOps)

Argo CD가 배포한 객체에는 추적 어노테이션(`argocd.argoproj.io/tracking-id`, 값 `<앱>:<group>/<Kind>:<ns>/<이름>`)이 붙습니다. `gitops.argocd.enabled: true`면 콘솔이 그 표식을 읽어 드로어 머리에 "Argo CD · <앱>" 배지를 달고(`url`을 적으면 Argo CD 앱 페이지로 링크), 콘솔에서 그 객체를 바꾸려 할 때:

- `mode: warn`(기본) — 확인창에서 "다음 동기화 때 되돌아갑니다, Git에서 바꾸세요"를 알린 뒤 진행합니다.
- `mode: block` — k8s-service가 쓰기 요청을 409로 거부하고(`managed by Argo CD application <앱>; change it in Git`), AI 쓰기 도구(apply·delete·patch·scale·rollout)도 같은 이유로 거부합니다. 드로어의 삭제·YAML 적용 버튼은 비활성입니다.

어노테이션은 그 객체 자신을 가리킬 때만 인정합니다(파드 템플릿을 따라 복사된 어노테이션은 무시). 아직 라벨 방식(`app.kubernetes.io/instance` 또는 `argocd-cm`의 `application.instanceLabelKey`)을 쓰는 설치는 `instanceLabel`에 그 키를 적으면 됩니다. Helm 릴리스 작업·노드 cordon/drain·새 객체 생성은 대상이 아닙니다.

### 대시보드 빠른 작업 (이슈 · 최적화 · 스토리지)

세 카드는 모두 k8s-service가 계산한 읽기 전용 결과를 보여 줍니다(AI 도구와 같은 숫자).

- **이슈 확인** — `GET /api/v1/cluster/issues?window=<분>`: 파드(Phase·Ready·CrashLoopBackOff 등 대기/종료 사유·재시작), 워크로드(Deployment `ProgressDeadlineExceeded`·unavailable, StatefulSet·DaemonSet 미준비, Job 실패, CronJob 마지막 실행 실패, HPA 상한 도달), 노드(Ready≠True·압박 조건), PVC(미바인딩)에 최근 `window`분의 Warning 이벤트를 같은 객체 행에 붙여 "왜·언제·몇 번"을 보여 줍니다. 기본 범위는 `features.issues.eventWindowMinutes`(60), 화면에서 1h/6h/24h로 바꿀 수 있습니다. 행을 누르면 그 객체의 드로어가 열립니다.
- **최적화 제안** — `GET /api/v1/cluster/optimization?namespace=…&window=<시간>`: 실행 중인 파드의 컨테이너별 requests/limits와 사용량(Prometheus가 있으면 최근 `window`시간의 CPU 95퍼센타일·메모리 최대, 없으면 metrics-server 순간값, 둘 다 없으면 "없음"으로 표기), 추천값(CPU = p95, 메모리 = 최대+15%, 최소 10m/100Mi — Robusta KRR의 simple 전략), 플래그(`cpu_over`·`cpu_under`·`mem_over`·`mem_under`·`no_cpu_request`·`no_mem_request`·`no_mem_limit`)를 표로 냅니다. 기본 범위는 `features.optimization.windowHours`(24). "AI 설명" 버튼은 이 표를 그대로 모델에 보내 왜 그런 수치인지·무엇부터 바꿀지 설명을 받습니다 — 숫자는 모델이 바꾸지 않습니다.
- **재시작 없이 적용** — `POST /api/v1/cluster/namespaces/{ns}/optimization/resize` 본문 `{kind, name, container, cpu_request_m?, mem_request_bytes?}`(최적화 행 그대로): 그 워크로드의 실행 중인 파드마다 컨테이너 requests를 Pod `resize` 하위 리소스로 바꿉니다(Kubernetes 1.35+ GA, 차트 `features.inPlaceResize.enabled` 기본 켬, 서버가 낮으면 버튼 숨김·API 409). QoS 클래스는 유지합니다 — Guaranteed면 limits도 같이, Burstable이면 새 request보다 낮은 limit만 올림, BestEffort는 건너뜀. `resizePolicy`가 재시작을 요구하는 자원·변화 없는 컨테이너도 건너뛰고 파드마다 `resized`/`pending`(kubelet의 `PodResizePending`: Infeasible·Deferred)/`skipped`/`error`로 답합니다. 워크로드 템플릿은 바꾸지 않으므로 다음 롤아웃 때 원래 값으로 돌아갑니다. 권한 `resource.pod.edit`, Argo CD 가드는 워크로드 기준, 감사 `k8s.pod.resize`(호출 하나에 행 하나, 파드별 결과 포함). Pod 드로어의 컨테이너 카드에 있는 "리소스 조정"은 같은 호출을 `kind: Pod`로 보내 그 파드 하나의 컨테이너 requests(CPU m·메모리 MiB)를 바꿉니다 — 같은 권한·스위치·규칙.
- **비용(Cost 메뉴)** — `GET /api/v1/cluster/cost?window=1h|6h|12h|24h|48h|7d|14d|30d&aggregate=namespace|controller`: 대상 클러스터 안의 OpenCost(이름에 `opencost`가 든 9003 Service를 `opencost`·`kubecost`·`monitoring`·`cost` 네임스페이스에서 찾아 `/healthz`로 확인, API 서버 프록시로 질의 — Prometheus와 같은 방식)의 `/allocation/compute`(누적 1구간, idle 제외)를 행으로 냅니다: 이름·Namespace·종류(워크로드일 때)·CPU/메모리/GPU/PV/네트워크/LB/합계 비용·코어시간·바이트시간·효율. 워크로드 집계는 OpenCost에 `namespace,controller`로 물어 행마다 Namespace를 알고, **Namespace 범위가 부여된 사용자는 그 Namespace 행만**(합계도 그 행만) 받습니다(`scoped: true`). 할당은 **로그인 사용자로 impersonate해 읽으므로 대상 클러스터 RBAC이 상한**입니다 — 기본 `kubeast:viewer`(Read)는 `view`+`kubeast:cluster-reader`뿐이라 `services/proxy`가 없어 클러스터가 403으로 거부하고(Prometheus 프록시도 같음), `kubeast:operator`(Write, `edit`)부터 읽힙니다; Read에게 열려면 차트 값 `auth.impersonation.viewerProxyServices`에 그 클러스터의 OpenCost·Prometheus Service를 적어 Role을 렌더·적용합니다(그 Namespace에서 `<service>:<port>` GET만). 응답 캐시는 **사용자(식별자)별** 60초, OpenCost 발견(어느 Service인지)은 개요 캐시 식별자로 10분(없음은 5분). `GET /api/v1/cluster/cost/status`는 발견 여부·주소. 권한 `resource.cost.read`(Read 역할의 `resource.*.read`에 포함), 차트 `features.cost.enabled`(기본 켬, 끄면 404·메뉴 숨김), 감사 없음(일반 읽기). 단가는 OpenCost가 정합니다 — 클라우드면 가격 API, kind·온프렘이면 OpenCost 기본 단가(CPU 0.031611/core-h·RAM 0.004237/GB-h). **최적화 표**는 OpenCost가 있으면 같은 Namespace 할당에서 단가(비용 ÷ 시간)를 역산해 행마다 `cost_month_usd`(requests × 730h × 파드 수)와 `saving_month_usd`(추천값과의 차이, 음수면 0)를, 응답에 `pricing`을 덧붙입니다. OpenCost 자체는 설치하지 않습니다(dev 2번 클러스터 매니페스트는 `deploy/kind/second-cluster.yaml`).
- **스토리지 분석** — PVC 목록(`?usage=true`)에 Prometheus의 `kubelet_volume_stats_*`로 사용률·용량과 6시간 추세로 계산한 "n일 뒤 가득 참"을 붙입니다(`features.prometheus.enabled`가 켜져 있고 Prometheus가 kubelet `/metrics`를 긁어야 함). CSI 드라이버가 볼륨 통계를 내지 않으면(hostPath·local-path 등) N/A로 표시합니다. 85%/97% 색 경계와 "4일 내 가득 참"은 kube-prometheus의 `KubePersistentVolumeFillingUp` 규칙과 같습니다.
- **Prometheus 소스(클러스터별)** — 기본은 대상 클러스터 안에서 Prometheus Service를 찾아 API 서버 프록시로 질의합니다: 모든 Namespace에서 레이블(`kubeast.io/prometheus=true` → prometheus 차트 서버 → Operator의 `prometheus-operated`)로, 없으면 이름에 `prometheus`가 든 9090 Service를 정해진 Namespace에서. 자동으로 못 찾으면 Admin → Clusters → 편집의 **클러스터 안 Service**(`namespace/service:port`, `PATCH`의 `prometheus_service`) 또는 차트 `features.prometheus.service`로 직접 적습니다(순서: 클러스터 주소 → 클러스터 Service → 차트 주소 → 차트 Service → 자동 발견). 찾기(어느 Service인지, 클러스터마다 10분 기억)는 개요 캐시 식별자(`kubeast:cache`, 그룹 `kubeast:viewer`)로 하고 `/-/healthy`가 403이어도 "있음"으로 칩니다 — 그래서 누가 먼저 열었든 결과가 같습니다. 질의 자체는 로그인한 사람으로 나가므로 Read(`kubeast:viewer`)는 `auth.impersonation.viewerProxyServices`에 그 Prometheus Service를 적어야 읽힙니다(적지 않으면 클러스터가 거부, 위 Read 역할 표). 중앙 저장소(Thanos·Mimir·VictoriaMetrics 등 Prometheus 호환 API)를 쓰면 Admin → Clusters → 편집에서 **주소·인증(bearer/basic, `cluster-prometheus-<id>` Secret에 보관)·클러스터 레이블 값**을 적습니다(`PATCH /api/v1/clusters/{id}`의 `prometheus_url`·`prometheus_auth`·`prometheus_cluster_label`). 레이블 값이 있으면 모든 PromQL의 벡터 셀렉터에 `cluster="<값>"`(이름은 `features.prometheus.clusterLabel`)을 파서로 주입해 그 클러스터 시리즈만 봅니다. 차트 `features.prometheus.url`·`auth.existingSecret`(키 `authorization`)은 자기 주소가 없는 클러스터의 기본값, `discover: false`는 클러스터 안 자동 발견 끄기, `egressCIDRs`는 NetworkPolicy가 켜진 설치에서 443·6443 밖 포트의 저장소로 k8s-service 송신을 여는 목록(`{cidr, port}`). `GET /api/v1/cluster/prometheus/status?cluster=<id>`가 `source`(external/proxy/none)·주소·인증 여부·레이블·`configured`(Service를 적었는지)와 연결 상태를 답합니다.

### 알림 → AI 조사 (Alertmanager)

알림이 울리면 Kubeast가 **읽기 도구만으로 1차 조사를 해 두고** 보고서를 남깁니다. 쓰기는 하지 않습니다 — 고치는 건 사람이 보고서를 보고 합니다. 기본 off(`features.alertInvestigation.enabled`). 켜려면 `auth.impersonation.enabled`와 `ai.enabled`도 켜져 있어야 합니다(아니면 차트 렌더가 실패).

- **받는 곳**: Alertmanager 웹훅 수신자를 `POST <Kubeast 주소>/api/v1/alerts/webhook?cluster=<클러스터 ID>`로, `http_config.authorization`에 Bearer `ALERT_WEBHOOK_TOKEN`(kubeast-secrets, 차트가 생성)을 둡니다. 형식은 Alertmanager v4 그대로. 토큰이 틀리면 401, 모르는 클러스터는 404, 꺼져 있으면 404.
- **거르기**: `firing`이고 `severity` 라벨이 `severities`(기본 critical·warning)에 있는 알림만. 같은 클러스터·fingerprint는 `dedupeHours`(24) 안에선 `repeat_count`만 올립니다(Alertmanager가 4시간마다 다시 보냄). 시간당 `maxPerHour`(6)·하루 `dailyTokenBudget`(200,000 토큰, UTC)을 넘으면 `skipped`로 남깁니다. 응답은 바로 `{accepted, duplicate, filtered, skipped, resolved, dropped}`.
- **조사**: 작업자 하나가 줄을 선 알림을 하나씩(복제본이 여럿이어도 한 번만) 처리합니다. auth-service가 그 클러스터용 **조사 전용 토큰**(읽기 도구 25개 권한 + 로그 저장소 검색이 묻는 `resource.pod.read`; Helm·정책 보고·비용 도구는 그 권한이 없어 조사에는 안 보임, 알림에 `namespace` 라벨이 있으면 그 Namespace로 한정, 10분)을 주고, 클러스터에는 사용자·그룹 `kubeast:investigator`로 갑니다(읽기 전용 ClusterRole — Secret·exec·쓰기 없음, `templates/impersonation-investigator.yaml`). 조사가 CRD(Kyverno PolicyReport, Argo Rollout, KEDA ScaledObject 등)도 읽게 하려면 `extraRules`에 읽기 규칙을 더합니다 — 동사는 get·list·watch만, `apiGroups "*"`·Secret·exec·프록시·토큰·와일드카드 자원은 렌더가 거부합니다. 더한 규칙은 알림이 오는 모든 클러스터에 다시 적용합니다(`scripts/render-target-rbac.sh`). 모델 = `model`(ModelConfig 이름) 또는 기본 모델, 호출 `maxSteps`(8)번까지 — 마지막 호출엔 도구를 주지 않아 답을 받습니다 — 전체 `timeoutSeconds`(300). 알림의 라벨·주석은 프롬프트에서 "신뢰하지 않는 데이터"로 분리합니다.
- **보고서**: 요약 · 확인한 것 · 가능한 원인 · 다음에 볼 것(`language`, 기본 en). `GET /api/v1/ai/investigations`(목록, `status`·`cluster` 거르기)·`/{id}`(상세: 보고서·도구 호출·토큰), 권한 `admin.investigations.read`. 상세 열람은 파드 로그가 인용될 수 있어 `ai.investigation.view`로 남깁니다. 보존 `retention.investigationDays`(90일).
- **화면**: Admin → **Investigations**(기능과 AI가 켜졌을 때 메뉴, 권한 `admin.investigations.read`) — 받은 시각·클러스터·알림·심각도·Namespace·상태·반복·토큰·소요 표, 상태·클러스터 거르기. "보고서"를 누르면 창에 보고서·알림 라벨/주석·Alertmanager 링크·도구 호출(인자·결과 길이)이 나오고, 주소가 `?id=<조사 ID>`가 되어 감사 요약의 링크와 같습니다. 보고서는 외부 알림을 읽은 모델이 쓴 글이라 원시 HTML 없이 Markdown으로만 그립니다.
- **모델**: 보고서의 질은 모델을 따릅니다. 작은 로컬 모델은 근거가 약한 인과를 "Likely cause"에 쓰기도 하므로, 운영에선 도구 호출을 잘하는 큰 모델을 `model`로 따로 지정하는 것을 권합니다.
- **감사·알림**: 조사 1건 = `ai.investigation.run`(actor `system` / `kubeast:investigator`, `after`에 알림·모델·토큰·도구 호출 수·소요·요약 500자·링크), 도구 호출 = `ai.tool.call`. 감사 싱크의 `filter.actions`에 `ai.investigation.run`을 넣으면 Slack·메일로 요약이 갑니다. `consoleUrl`을 적으면 요약에 보고서 링크가 붙습니다.
- **클러스터 쪽**: 조사 신원 RBAC과 Alertmanager 설정 예시는 [docs/cluster-requirements.md](docs/cluster-requirements.md) §1·§13. dev는 2번 클러스터의 Alertmanager에 `amtool alert add`로 가짜 알림을 넣어 확인합니다(`deploy/kind/alertmanager.yaml`).

### 감사 싱크 (S3 · 웹훅 · 메일 · 파일)

감사 로그의 1차 저장소는 DB이고, 싱크는 그 행을 **밖으로 복사**합니다. auth-service 한 replica가 싱크마다
"어디까지 보냈는지"(커서)를 DB에 두고 배치로 보내므로, 싱크가 죽어도 요청은 막히지 않고 복구되면 이어서
보냅니다(최소 1회 전달 — 레코드의 `id`로 중복 제거). 싱크가 없으면 지금과 똑같습니다.

| 종류 | 용도 | 비밀(Secret 키) |
|---|---|---|
| `s3` | 장기 보관(S3·MinIO·GCS·R2). 시간 파티션 NDJSON gzip | `accessKeyId`·`secretAccessKey` — 없으면 IRSA(`serviceAccounts.authService.annotations`에 롤) |
| `webhook` `json` | SIEM·n8n 등 범용(선택 HMAC 서명 `X-Kubeast-Signature`) | `url`, `hmacSecret` |
| `webhook` `slack` · `teams` · `discord` | 채팅 알림 | `url` |
| `webhook` `telegram` | 채팅 알림(`chatId`) | `botToken` |
| `webhook` `pagerduty` | 온콜(Events v2, 이벤트당 1건) | `routingKey` |
| `email` | 메일(SMTP, STARTTLS/TLS) | `username`·`password` |
| `file` | PVC에 NDJSON(`/var/lib/kubeast-audit`, `audit.fileSinkVolume`) | — |

`teams`·`discord`·`pagerduty`는 각 서비스의 공개 페이로드 형식을 따르지만 실제 서비스로는 아직 확인하지 않았습니다.

```yaml
audit:
  sinks:
    - name: archive                      # 장기 보관, 전체 이력
      type: s3
      s3: {bucket: kubeast-audit, prefix: audit/, region: ap-northeast-2}
    - name: slack-danger                 # 위험한 행동만 Slack으로
      type: webhook
      secret: kubeast-audit-slack        # kubectl create secret generic kubeast-audit-slack --from-literal=url=https://hooks.slack.com/...
      webhook: {format: slack}
      filter: {actions: ["k8s.*.delete", "k8s.pod.exec", "k8s.node.shell", "access.request.create", "admin.*"]}
retention:
  auditDays: 90                          # S3를 켰다면 DB는 화면·CSV에 필요한 기간만
```

- **필터**: 권한 패턴과 같은 와일드카드(`k8s.*.delete`, `admin.*`)와 `results: [failure]`. 필터 없음 = 전부.
- **시작점**: `s3`·`file`은 처음부터(기존 이력 전체), 나머지는 켠 시점부터(`startFrom`으로 바꿈).
- **S3 Object Lock(WORM, ISMS-P 증적)**: 버킷을 Object Lock + 버전 관리로 만들고 **기본 보존**(compliance 또는 governance, 기간)을 겁니다. Kubeast는 객체마다 보존을 지정하지 않으며 IAM 권한은 `s3:PutObject` 하나면 됩니다. compliance 모드는 기간 동안 root도 못 지웁니다.
- **보존**: `retention.auditDays`가 지나도 **아직 싱크로 안 보낸 행은 지우지 않습니다**. 멈춘 싱크는 알람 `KubeastAuditSinkStalled`(메트릭 `kubeast_audit_sink_pending`·`_failures_total`·`_last_success_timestamp_seconds`)로 드러납니다.
- **네트워크**: 443은 열려 있습니다. SMTP(587/465)나 클러스터 안 엔드포인트는 `audit.sinkEgress`에 NetworkPolicy 규칙을 추가합니다.

로컬 kind에는 `deploy/kind/devtools.yaml`(S3 대용 versitygw + Object Lock 버킷, Mailpit, 웹훅 수신기)이 `kind-deploy.sh`로
함께 올라가고 dev 값이 싱크 3개를 그쪽으로 향합니다. 메일 수신함은 `kubectl -n kubeast-devtools port-forward svc/mailpit 8025`.

### 감사 로그 무결성 (해시 체인 · S3 앵커)

감사 행을 나중에 고치거나 지웠는지 알 수 있게 합니다. auth-service가 `audit.integrity.sealSeconds`(기본 10초)마다 새 행을 앞 행의 해시를 포함한 sha256으로 묶고(`chain_seq`·`prev_hash`·`row_hash`), `audit.integrity.anchor.sink`에 S3 싱크 이름을 적으면 `anchor.hours`(기본 24)마다 체인 머리를 다이제스트 JSON으로 그 버킷의 `<prefix>digests/`에 씁니다. Admin → 감사 로그 상단 띠에서 봉인 위치와 마지막 앵커를 보고, **검증**(기본 = 마지막 앵커부터, 싱크 객체 대조 포함)과 **지금 앵커**를 누를 수 있습니다. 둘 다 감사 행(`admin.audit.verify`·`admin.audit.anchor`)으로 남고, 주기 앵커는 `audit.chain.anchor`(actor `system`)입니다.

```yaml
audit:
  sinks:
    - name: archive
      type: s3
      s3: {bucket: kubeast-audit, prefix: audit/, region: ap-northeast-2}
  integrity:
    enabled: true        # 기본값: 체인만(의존성 없음)
    sealSeconds: 10
    anchor:
      sink: archive      # 위 s3 싱크의 이름. 비우면 앵커 없음
      hours: 24
```

- **신뢰 근거는 버킷의 Object Lock**입니다. DB와 S3를 둘 다 고칠 수 있는 사람은 앵커도 다시 쓸 수 있으니, 다이제스트가 놓이는 버킷에 기본 보존을 거세요. 다이제스트에 서명은 없습니다.
- **독립 검증**: Kubeast 없이 psql로 같은 식을 재계산할 수 있습니다(`services/auth-service-go/internal/auditchain`의 `CanonSQL`, [docs/audit-log-plan.md](docs/audit-log-plan.md) §7).
- **한계**: 봉인 전 창(≤ `sealSeconds`)에 지워진 행은 못 잡습니다. 껐다 켠 구간은 검증 결과에 앵커 없음으로 드러납니다. 보존(`retention.auditDays`)은 체인 접두만 지웁니다.
- 메트릭 `kubeast_audit_chain_sealed_seq` · `kubeast_audit_chain_unsealed_rows` · `kubeast_audit_anchor_last_timestamp_seconds`.

로컬 kind는 dev 값이 `dev-s3` 스탠드인에 앵커합니다(`e2e/tests/audit-integrity.spec.ts`).

### 세션 기록 (exec · 노드 셸)

켜면(`sessionRecording.enabled`, 기본 off) Pod exec와 노드 셸 터미널에 **찍힌 출력**(사용자가 본 화면 — 친 명령은
에코로 보이고, 에코되지 않는 비밀번호 입력은 안 남음)을 asciicast v2로 녹화합니다. 세션을 열면 터미널에
"This session is recorded"(한국어 화면이면 "이 세션은 녹화됩니다") 한 줄이 먼저 찍히고 — 녹화에도 그 줄이 그대로 남습니다 — 감사 행(`k8s.pod.exec`·`k8s.node.shell`)에 `recording_id`가 붙습니다.

- **저장**: k8s-service가 로컬 볼륨에 쓰고 세션 중에도 `chunkSeconds`(기본 30초)마다 조각을 올립니다 — k8s-service 파드가 사라져도 잃는 건 마지막 조각 간격만큼. 저장소 = `s3`(운영 권장, 감사 S3 싱크와 같은 필드) · `database`(세션당 1 MiB, S3 없는 작은 설치) · `file`(PVC). S3 키는 파일로 마운트돼 k8s-service의 IRSA 신원을 건드리지 않습니다.
- **끊긴 세션**: k8s-service 쪽 사정으로 끊긴 세션은 `interrupted`로 남습니다 — 정상 종료(롤아웃·드레인)와 컨테이너 재시작은 남은 출력까지 다 올리고, 파드가 통째로 사라지면 그 전에 올린 조각만 남습니다. 목록의 크기는 남은(올라간) 크기이고, 올라간 조각이 없으면 재생 버튼이 꺼집니다.
- **터미널이 끊길 때**: 브라우저 탭을 닫거나 네트워크가 끊겨 터미널이 `exit` 없이 사라지면, k8s-service가 셸에 Ctrl-C·Ctrl-D를 보내 끝냅니다(컨테이너 런타임은 끊긴 exec의 프로세스를 정리하지 않음). 편집기처럼 이를 무시하는 프로그램이 앞에 떠 있으면 남을 수 있습니다.
- **실패**: 녹화를 시작하지 못하면(로컬 볼륨에 못 씀) 세션을 거부합니다(`required: true`). 저장소 업로드가 실패하거나 조각 하나가 30초 안에 끝나지 않아도 세션은 계속되고, 재시도하며 알람 `KubeastSessionRecordingUploadStalled`로 드러납니다. 세션당 `maxBytes`(기본 64 MiB)를 넘으면 녹화만 멈춥니다.
- **다시보기**: Admin → Session recordings(권한 `admin.sessions.read`)에서 재생·`.cast`·텍스트 사본 내려받기, Audit Logs의 exec 행에서도 재생. 녹화를 열 때마다 `admin.session.read`가 감사에 남습니다.
- **재생기와 CSP**: 재생기(asciinema-player)는 터미널을 WebAssembly로 돌립니다. 그래서 게이트웨이가 보내는 CSP의 `script-src`에 `'wasm-unsafe-eval'`이 들어 있습니다(`'unsafe-eval'`은 아님, `helm/kubeast/files/nginx.conf`). 앞단 Ingress·프록시가 CSP 헤더를 덮어쓰면 같은 값을 허용해야 재생됩니다 — 빠지면 ▶ 버튼과 `--:--`에서 멈춥니다.
- **보존**: 원격 객체는 버킷 수명주기·Object Lock에 맡기고, 목록 행은 `retention.auditDays`를 따릅니다.

```yaml
sessionRecording:
  enabled: true
  s3: {bucket: kubeast-sessions, prefix: sessions/, region: ap-northeast-2}   # k8s-service 롤에 s3:PutObject·GetObject
```

### 컨테이너 안 로그 파일 (Log files)

로그를 stdout이 아니라 **파일로 쓰는 앱**은 `kubectl logs`에도, Kubeast의 Logs 탭·AI 로그 툴에도 아무것도 안 보입니다(kubelet은 stdout/stderr만 모읍니다). 켜면(`features.logFiles.enabled`, 기본 off) Pod 상세의 Logs 탭과 Pod 드로어의 Logs 칸에 **컨테이너 출력 | 로그 파일** 전환이 생기고, 허용한 경로의 파일을 골라 마지막 N줄을 읽거나 실시간으로 따라갈 수 있습니다.

- **고정 명령, 셸 없음**: k8s-service가 사용자 신원의 `pods/exec`로 `ls`·`tail`만 실행합니다 — 목록 `ls -1p -- <디렉터리>`, 읽기 `tail -n N -- <파일>`, 실시간 `ls -lindL -- <파일>`(크기·inode) + `tail -c +<오프셋> -- <파일>`(인자는 배열로 넘겨 셸을 거치지 않음). 읽을 수 있는 건 `paths` 패턴(절대 경로, `*`·`?`는 파일 이름에만 — 예 `/var/log/app/*.log`)에 맞는 파일뿐이고, `..`·`.`·겹친 `/`가 든 경로는 거부합니다. 패턴이 틀리면 k8s-service가 뜨지 않습니다.
- **어디서**: `namespaces`를 적으면 그 네임스페이스의 파드에서만 됩니다(그 밖은 403). impersonation이 켜져 있으면 차트가 ClusterRole `kubeast:logfile-reader`(`pods/exec` create·get)를 만들고 **그 네임스페이스에만** Read·Write 그룹(`kubeast:viewer`·`kubeast:operator`)을 RoleBinding으로 묶습니다 — Admin 그룹은 이미 cluster-admin, Write 그룹은 기본 `edit`로 원래 exec가 됩니다. 다른 등록 클러스터에는 같은 렌더링을 적용합니다: `helm template kubeast helm/kubeast -s templates/logfiles-rbac.yaml -f <values> | kubectl --context <클러스터> apply -f -`.
- **권한·감사**: `resource.pod.logfile`(Read·Write에 포함, 클러스터별). 파일 내용 읽기와 실시간 연결마다 `k8s.pod.logfile.read`(민감 조회 — 기록이 안 되면 503, `after` = 컨테이너·경로·줄 수·follow), 파일 목록은 이름만이라 기록하지 않습니다. 권한이 있는데 경로·네임스페이스 밖이거나 실행이 실패한 시도도 failure 행으로 남습니다.
- **안 되는 경우**: `tail`·`ls`가 없는 이미지(distroless)는 422 "이 컨테이너에선 볼 수 없음", 컨테이너 사용자가 못 읽는 파일은 422, 없는 파일은 404. 파일 내용은 마스킹하지 않습니다(화면에 안내) — 로그에 비밀값이 찍히면 앱 쪽에서 막아야 합니다.
- **실시간 보기 = 2초 폴링**: 긴 `tail -F` 하나를 띄우지 않습니다 — 컨테이너 런타임은 exec 클라이언트가 끊겨도 그 프로세스를 멈추지 않아서, 탭을 닫을 때마다 앱 컨테이너에 `tail`이 남습니다(실측). 대신 2초마다 마지막으로 읽은 바이트 뒤만 `tail -c +<오프셋>`(탐색이라 파일 크기와 무관)으로 읽고, 가끔 `ls -lindL`로 크기·inode를 봐서 잘림·교체(로그 회전)를 따라갑니다. 명령은 매번 바로 끝납니다. 20초마다 SSE 주석을 보내 프록시의 유휴 끊김(nginx 60초)을 막고, 끊기면 브라우저가 스스로 다시 붙지 않습니다(다시 붙으면 마지막 줄을 또 읽고 감사 행도 하나 더 생기므로). 한 번에 읽는 줄은 `maxLines`(기본 2000)까지입니다.

```yaml
features:
  logFiles:
    enabled: true
    paths: [/var/log/app/*.log, /srv/app/log/production.log]
    namespaces: [apps]       # 비우면 모든 네임스페이스(그때는 RoleBinding을 만들지 않으므로 Read 그룹은 클러스터가 거부)
    maxLines: 2000
```

### 로그 검색 (Loki)

`pods/log`는 살아 있는 파드의 지금 로그만 줍니다. 켜면(`features.logSearch.enabled`, 기본 off) 로그 저장소(Loki)에서 **재시작·삭제된 파드까지** 텍스트·기간으로 찾습니다 — Loki와 수집기는 따로 둡니다([docs/cluster-requirements.md §14](docs/cluster-requirements.md#14-로그-저장소-로그-검색)).

- **화면**: Pod 드로어 Logs 칸과 클러스터 뷰 Logs 탭의 출처 전환에 "검색(기록)"(그 파드·컨테이너), Deployment·StatefulSet·DaemonSet·ReplicaSet·Job·CronJob 드로어에 "로그 검색" 섹션(그 워크로드의 파드들, 펼칠 때만 검색). 텍스트·기간(15분~최대)·정규식(`.*`)·대소문자 구분(`Aa`), 일치 부분 강조, "더 이전". 검색은 열 때 한 번과 검색 버튼에서만(검색마다 감사). 그 클러스터에 설정이 없거나 `resource.pod.read`가 없으면 보이지 않음.
- **API**: `GET /api/v1/namespaces/{ns}/logsearch`(한 Namespace) · `GET /api/v1/cluster/logsearch`(전체). 조건 `q`(256자까지) · `match=contains|regex` · `ignore_case` · `pod` 또는 `workload_kind`+`workload_name`(Deployment·StatefulSet·DaemonSet·ReplicaSet·Job·CronJob → 그 컨트롤러가 만드는 파드 이름) · `container` · `since` 또는 `start`·`end`(RFC 3339) · `limit` · `direction`. 응답 = 최신부터 줄(`ts`·`namespace`·`pod`·`container`·`line`), `truncated`이면 `oldest`를 `end`로 다시.
- **쿼리는 서버가 만듭니다**: 사용자는 LogQL을 쓰지 않고, 값은 전부 따옴표 안 문자열로만 들어갑니다. 클러스터 라벨 매처(`clusters`의 값)는 항상 붙어 Loki 하나를 여러 클러스터가 써도 섞이지 않습니다.
- **권한**: `resource.pod.read`(그 클러스터) + 사용자 신원으로 `get pods/log`를 물어 허용될 때만 — 클러스터 RBAC이 정합니다. 전체 검색은 그 클러스터에 Namespace 범위 부여가 있으면 403(Namespace를 고름).
- **한도**: 기본 1시간·최대 `maxRange`(24h) · 줄 `maxLines`(1,000) · 질의 `timeout`(15s, 넘으면 504) · 사용자별 분당 `perUserPerMinute`(20, k8s-service 레플리카마다).
- **감사**: 검색마다 `k8s.pod.logs.search`(민감 조회 — 기록이 안 되면 503). `after` = 조건·기간·줄 수·처리 바이트, 줄 본문은 남기지 않습니다. 클러스터가 거부(403)·한도 초과(429)·저장소 오류(502·504)도 실패 행.
- **클러스터마다 다른 Loki**: 어떤 클러스터의 로그가 다른 저장소에 있으면 Admin → Clusters → 편집의 "로그 검색"에 그 저장소의 주소·인증(Bearer/Basic, 값은 `cluster-logsearch-<id>` Secret)·테넌트(`X-Scope-OrgID`)·그 저장소에서 이 클러스터가 갖는 레이블 값(비우면 "그 저장소엔 이 클러스터뿐")을 적습니다 — 그 클러스터는 `url` 대신 그 저장소를 씁니다. 모든 클러스터가 자기 저장소를 적는 운영이면 `url`·`clusters`는 둘 다 비워도 됩니다. 레이블 **이름**과 한도는 배포 전체 값 그대로. "연결 확인"(`GET /api/v1/cluster/logsearch/status`)이 어느 저장소를 쓰는지와 인증·테넌트까지 답하는지를 보여 줍니다. `networkPolicy`가 켜져 있으면 그 저장소의 호스트·포트도 `egressCIDRs`에.
- **LogQL 직접 입력(관리자)**: `features.logSearch.logql: true`(기본 off)이면 `admin.logsearch.query`를 가진 사용자에게 검색 칸 옆 "LogQL" 토글이 생깁니다. 서버는 질의를 파싱하지 않고 Loki 렉서와 같은 규칙으로 문자열·주석을 건너뛴 뒤 **모든 스트림 선택자에 그 클러스터(+Namespace) 매처를 더해** 보냅니다 — 사용자가 `k8s_cluster_name="다른값"`을 써도 AND라 그 클러스터 밖은 빈 결과. 로그 쿼리만(메트릭 쿼리는 400), 4 KB까지, 선택자가 없거나 리터럴·주석·선택자가 안 닫히면 400. 응답과 화면에 실제로 보낸 질의(`effectiveQuery`)가 보이고, 감사는 `k8s.pod.logs.logql`(쓴 질의·보낸 질의·줄 수). API `GET /api/v1/namespaces/{ns}/logsearch/query?q=…` · `GET /api/v1/cluster/logsearch/query?q=…`(전체 NS, 범위 부여 없을 때만). 권한·한도·감사 준비는 구조화 검색과 같습니다.

```yaml
features:
  logSearch:
    enabled: true
    url: https://loki.example.com
    auth:
      existingSecret: loki-auth        # 키 authorization = "Bearer …" 또는 "Basic …"
    tenant: ""                         # X-Scope-OrgID (멀티 테넌트 Loki)
    clusters:                          # Kubeast 클러스터 ID: k8s_cluster_name 값
      prod-1: prod-1
      alpha: eks-alpha
```

개발용(kind): `scripts/kind-logsearch.sh up` — 2번 클러스터에 Loki 하나, 두 클러스터에 OpenTelemetry Collector, Kubeast 값까지(`down`으로 되돌림).

### 트레이스 링크

Kubeast는 트레이스를 저장하지 않고, 트레이스 저장소(Jaeger·Tempo·APM)로 가는 링크만 만듭니다(`features.tracing.enabled`, 기본 off).

- **로그 줄 → 트레이스**: 로그 검색 결과에서 trace ID가 있는 줄 끝에 "트레이스"(`traceUrl`). trace ID는 줄의 라벨에서 먼저 찾고(`traceIdLabels`, 기본 `trace_id` 등 — Loki는 OTLP 로그의 trace ID를 구조화 메타데이터 `trace_id`로 줄과 함께 돌려줌), 없으면 줄 글자에서(`traceIdPattern`, 기본 `trace_id=…`·`traceID=…`·`"traceId":"…"`). 16진수 16자·32자만 씁니다.
- **Pod → 그 서비스의 트레이스**: Pod 드로어 머리에 "트레이스"(`searchUrl`). `{{service}}` = OpenTelemetry 순서(주석 `resource.opentelemetry.io/service.name` → `app.kubernetes.io/instance` → `app.kubernetes.io/name` → 소유 워크로드 → Pod 이름).
- **템플릿**: `{{traceId}}` `{{cluster}}`(Kubeast 클러스터 ID) `{{namespace}}` `{{pod}}` `{{container}}` `{{service}}` — 채운 값은 URL 인코딩, 빈 자리가 있으면 링크를 만들지 않습니다. 둘 다 `http(s)://`로 시작해야 렌더됩니다. 새 탭(`noopener noreferrer`)으로 열고, 서버 동작이 아니라 감사 항목은 없습니다(로그 검색 자체는 `k8s.pod.logs.search`).

```yaml
features:
  tracing:
    enabled: true
    traceUrl: https://jaeger.example.com/trace/{{traceId}}
    searchUrl: https://jaeger.example.com/search?service={{service}}
```

개발용(kind): `scripts/kind-logsearch.sh up` 다음 `scripts/kind-tracing.sh up` — 2번 클러스터에 Jaeger 2.22, 링크는 `kubectl port-forward -n tracing svc/jaeger 16686`(kubeast-b) 뒤 `localhost:16686`.

### 신뢰할 CA 추가 (사설 CA·TLS 가로채는 프록시)

Kubeast 서비스는 밖으로 여는 TLS(Loki·외부 Prometheus·OIDC 발급자·Google API·감사 싱크·LLM 엔드포인트)에서 이미지에 든 공인 CA만 신뢰합니다. 사설 CA(AWS Private CA·사내 루트·자체 서명)로 연 엔드포인트나 TLS를 가로채는 사내 프록시 뒤라면 `customCAs`에 그 CA를 적습니다 — 공인 CA는 그대로 두고 더합니다.

```yaml
customCAs:
  - secret: corp-root-ca      # 키마다 PEM 인증서(여러 장 가능), 키 이름은 항목끼리 겹치지 않게
  - configMap: proxy-ca
```

- **어디에**: 밖으로 TLS를 여는 6개(auth·k8s·session·tool-server·model-config-controller·ai-service)에 `/etc/kubeast/ca`로 마운트. Go 서비스는 `SSL_CERT_DIR`(기본 번들 파일은 그대로 읽힘), ai-service는 `CUSTOM_CA_DIR` — httpx는 `SSL_CERT_*`를 주면 자기 번들을 바꿔 버려서 코드가 certifi 위에 더합니다. 모델별 CA(Admin → AI Models)는 그 모델에 한해 그 위에 더해지고, 모델 연결 시험·모델 목록도 같은 CA로 검증합니다.
- **언제 읽나**: 시작할 때. CA를 바꾸면 서비스를 재시작합니다. 적은 Secret·ConfigMap이 없으면 새 파드가 볼륨을 기다리며 뜨지 않고 이전 파드가 계속 응답합니다.
- **인증서 조건**: CA는 CA답게(`basicConstraints CA:TRUE`, `keyUsage keyCertSign`), 서버 인증서엔 키 식별자 확장 — Python 3.13+는 엄격 검증(`VERIFY_X509_STRICT`)이라 이게 없는 손수 만든 인증서는 ai-service에서만 거부됩니다.
- **docker-compose**: 이 값은 차트에만 있습니다. compose 설치에서 사설 CA가 필요한 곳은 대개 LLM 엔드포인트라, AI 모델 설정의 "CA 인증서 (PEM)" 칸(모델별)으로 맞춥니다.

개발용(kind): `scripts/kind-private-ca.sh up` — 버리는 CA로 서명한 HTTPS 앞단을 2번 클러스터에 두고(로그 검색 Loki 경로·고정 모델 목록) Kubeast가 그 CA를 신뢰하게 함(`scripts/kind-logsearch.sh up` 다음, `down`으로 되돌림).

### 프론트엔드

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc + vite build
npm run lint     # eslint (--max-warnings 0)
npm run test     # vitest
```

### Go 서비스

```bash
cd services/k8s-service-go
go run ./cmd/server
go test ./...
```

### Python AI 서비스

```bash
cd services/ai-service
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
pytest
```

### 헬스 체크

```bash
curl http://localhost:8000/health   # Gateway
```

---

## 기술 스택

**Backend**
- Go 1.26 (auth · k8s · session · tool-server · controller · pkg)
- Python 3.14 + FastAPI (ai-service)
- PostgreSQL 18, Valkey 9(Redis 호환 캐시, BSD)
- controller-runtime (CRD operator)

**Frontend**
- React 19 · TypeScript · Vite · Tailwind CSS
- TanStack Query · React Router
- Monaco Editor · xterm.js
- React Flow · dagre · elkjs (그래프) · three.js (3D 토폴로지)
- i18next (한/영)

**Infra**
- Kubernetes · Helm · NGINX
- GitHub Container Registry (ghcr.io) · GitHub Actions

---

## 라이선스

MIT License
