# 설치와 첫 설정

## 빠른 시작

모든 컴포넌트 이미지와 Helm 차트는 **GitHub Container Registry(ghcr.io)에 공개 패키지**로 게시되어
있어 별도 빌드 없이 바로 설치됩니다. (공개 패키지는 익명 pull rate limit이 없습니다.)
설치는 릴리스된 차트(`oci://ghcr.io/junginho0901/charts/kubeast`)로 합니다 — 그 차트에 그 릴리스의 이미지 판이 들어 있습니다.
저장소에서 받은 소스의 `helm/kubeast`는 개발용이라 이미지 판이 릴리스와 맞지 않습니다.

### 옵션 1. 설치 스크립트 (이미 동작 중인 K8s 클러스터)

태그가 붙은 스크립트를 내려받아 내용을 확인한 뒤 실행합니다(검토하지 않은 스크립트를 `curl | bash`로 바로 실행하지 않습니다).

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/junginho0901/Kubeast/v0.7.0/install.sh
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
bash install.sh --version 0.7.0
```

> 사전 요구: `kubectl`, `helm`, 그리고 접근 가능한 Kubernetes 클러스터.

### 옵션 2. Helm 직접 사용

```bash
helm install kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.0 \
  --namespace kubeast --create-namespace \
  --set ai.openaiApiKey=$OPENAI_API_KEY     # 선택: 나중에 UI에서도 등록 가능

# 가장 가볍게: AI·캐시 없이 콘솔·관리·감사만 (파드 6개, docs/architecture.md "자원 사용량")
helm install kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.0 -n kubeast --create-namespace \
  -f https://raw.githubusercontent.com/junginho0901/Kubeast/v0.7.0/helm/kubeast/values-minimal.yaml
```

### 옵션 3. Docker Compose (클러스터 없이 단일 호스트)

```bash
git clone --branch v0.7.0 --depth 1 https://github.com/junginho0901/Kubeast.git
cd Kubeast

./install-docker.sh
#   --kubeconfig /path/to/kubeconfig.yaml   # 관리할 클러스터 kubeconfig
#   --port 9000                             # Gateway 포트 (기본 8000)
#   --uninstall                             # 컨테이너 + 볼륨 모두 제거
```

`docker-compose`는 published 이미지(기본 = 받은 태그의 판, `KUBEAST_TAG`로 바꿈)를 pull 합니다. 소스에서 빌드하려면:

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

**클러스터 준비물**: Kubeast는 등록한 클러스터에 아무것도 설치하지 않습니다. 권한(RBAC)은 클러스터마다 있어야 하고, 그래프·비용·정책 보고서 같은 기능은 그 클러스터의 metrics-server·Prometheus·OpenCost·Kyverno 등을 읽습니다. 기능별로 무엇이 있어야 하는지·찾는 방법·확인 명령·예시는 [docs/cluster-requirements.md](cluster-requirements.md), 예시 값은 `deploy/examples/target-cluster/`, 등록 클러스터용 권한 렌더는 `scripts/render-target-rbac.sh`.

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

**Azure OpenAI (provider `azure`, CRD `azureopenai`)** — Azure의 **v1 API**만 씁니다(2025-08부터, OpenAI 호환, 날짜 `api-version` 없음). **실계정 검증 전**: 연결·채팅은 같은 호출 코드이고 가짜 서버·OpenAI 호환 서버로만 확인했습니다.
- **주소**: `https://<리소스>.openai.azure.com/openai/v1/`(`…services.ai.azure.com/openai/v1/`나 API Management 같은 게이트웨이 주소도 됨). 비워 둘 수 없습니다(키가 다른 곳으로 가지 않게).
- **모델 칸**: 모델 이름이 아니라 **배포 이름**(Azure AI Foundry → 배포). 공급자 모델 목록은 없습니다(이름 직접 입력).
- **키**: `KUBEAST_AI_KEY_*` 변수에 두면 `Authorization: Bearer`와 `api-key` 헤더 둘 다로 보냅니다.
- **안 되는 것**: 옛 배포별 주소(`…/openai/deployments/<배포>`)와 날짜 `api-version` — 저장·연결 테스트에서 v1 주소를 알려 주며 거절합니다. Entra ID 토큰 인증도 아직 없습니다.
- Private Link로 사설 주소가 나오는 리소스는 그 호스트를 `ai.baseUrlAllowedHosts`에 넣습니다. CRD로 만들 때는 `spec.baseURL`(또는 `azureOpenAI.azureEndpoint`)에 v1 주소, `spec.model`에 배포 이름을 넣습니다(`apiVersion`·`azureDeployment`·`azureAdToken`은 kagent 호환으로 남아 있지만 쓰지 않음).

**Claude 구독으로 쓰기 (provider `claude-code`, 개인용)** — API 키 대신 Claude Pro/Max 구독의 `claude setup-token` 값으로 채팅합니다. 구독 토큰은 Claude Code에서만 받아 주므로, ai-service가 모델 호출마다 Claude Code를 띄우고(Claude Agent SDK, `app/services/claude_code.py`) Claude Code가 부르는 도구는 채팅의 도구 코드가 이 프로세스 안에서 처리합니다. 그래서 도구 목록, 쓰기 도구의 승인 카드, 마스킹, `ai.tool.call`·`ai.chat.complete` 감사(provider `claude-code`)가 API 키 경로와 같습니다.
- **혼자 쓰는 설치에서만** 켭니다. Anthropic 약관은 구독을 본인 사용으로 한정합니다. 팀이나 여러 사용자가 쓰는 Kubeast에 넣으면 안 됩니다. 관리 화면은 이 프로바이더를 고르면 같은 경고를 보여 줍니다.
- **켜는 법**: ① 본인 PC에서 `claude setup-token`으로 토큰(1년)을 만들어 `ai.claudeCodeOAuthToken`(또는 `apiKeysSecret`의 `CLAUDE_CODE_OAUTH_TOKEN` 키)에 넣고 `ai.providers.claudeCode.enabled: true`로 올립니다.
  - 이 값을 켜면 ai-service가 Claude Code가 든 이미지(같은 버전의 `<버전>-claude-code` 태그, 약 250 MB 더 큼)로 바뀝니다 — 기본 이미지에는 없습니다.
  - 직접 빌드한 이미지면 `--build-arg WITH_CLAUDE_CODE=true`로 빌드하고 `ai.providers.claudeCode.imageTagSuffix: ""`로 둡니다.
  - ② **Admin > AI Models**에서 "Claude subscription"을 고르면 변수 이름이 `CLAUDE_CODE_OAUTH_TOKEN`으로 채워집니다.
  - 연결 테스트 후 저장합니다.
  - 이 설치에서 아직 쓸 수 없으면(값이 꺼져 있거나 이미지에 Claude Code가 없음) 목록에서 흐리게 "Not set up"으로 보이고, 고르면 이유가 먼저 나오며 테스트·저장 버튼이 막힙니다.
- **격리**: 실행마다 임시 HOME·설정 디렉터리, Claude Code 기본 도구(Bash·파일·웹) 없음, 설정 파일·CLAUDE.md 안 읽음. ai-service가 받은 환경변수는 경로·프록시·CA 변수를 빼고 모두 빈 값으로 덮어 모델 키·DB 주소가 넘어가지 않습니다. 토큰은 `CLAUDE_CODE_OAUTH_TOKEN`으로만 갑니다.
- **규칙**: `CLAUDE_CODE_OAUTH_TOKEN`은 claude-code만 쓸 수 있고, claude-code는 base_url과 다른 공급자 키 변수를 받지 않습니다. 꺼진 설치에서는 새 claude-code 설정 저장이 400으로 거절되고 연결 테스트가 이유를 보여 줍니다.
- **한도**: 동시에 도는 턴은 `maxConcurrent`(기본 1, 나머지는 대기), 한 턴은 `turnTimeoutSeconds`(기본 300초)와 `maxTurns`(기본 10회 모델 호출)까지입니다. 턴마다 Claude Code 프로세스(최대 약 300 MB)가 하나 뜨므로 `maxConcurrent`를 올리면 `resources.aiService.limits.memory`도 올립니다.
- **알림 → AI 조사**도 이 프로바이더로 돕니다. 조사는 채팅과 따로 한 칸을 써서(조사기는 한 번에 하나) 조사 중에도 채팅이 기다리지 않습니다 — 그래서 조사가 켜져 있으면 Claude Code 프로세스가 `maxConcurrent` + 1개까지 뜹니다. 단계 상한은 `maxSteps`(마지막 단계는 도구 없이 보고서)로 API 키일 때와 같습니다.
- **안 되는 것**: 공급자 모델 목록(내장 목록 또는 이름 직접 입력).
