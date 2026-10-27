[English](../getting-started.md) | **한국어**

# 설치와 첫 설정

## 빠른 시작

모든 컴포넌트 이미지와 Helm 차트는 **GitHub Container Registry(ghcr.io)에 공개 패키지**로 게시되어
있으므로 따로 빌드하지 않고 바로 설치할 수 있습니다. 공개 패키지라 익명 pull에도 rate limit이 없습니다.
설치에는 릴리스된 차트(`oci://ghcr.io/junginho0901/charts/kubeast`)를 쓰세요. 이 차트에 해당 릴리스의 이미지 버전이 들어 있습니다.
저장소에서 받은 소스의 `helm/kubeast`는 개발용이므로 이미지 버전이 릴리스와 맞지 않습니다.

### 옵션 1. 설치 스크립트 (이미 동작 중인 K8s 클러스터)

태그가 붙은 스크립트를 내려받아 내용을 확인한 뒤 실행하세요. 검토하지 않은 스크립트를 `curl | bash`로 바로 실행하지 마세요.

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/junginho0901/Kubeast/v0.7.3/install.sh
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
bash install.sh --version 0.7.3
```

> 필요한 것: `kubectl`, `helm`, 접근할 수 있는 Kubernetes 클러스터

### 옵션 2. Helm 직접 사용

```bash
helm install kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.3 \
  --namespace kubeast --create-namespace \
  --set ai.openaiApiKey=$OPENAI_API_KEY     # 선택: 나중에 UI에서도 등록 가능

# 가장 가볍게: AI·캐시 없이 콘솔·관리·감사만 (파드 6개, docs/ko/architecture.md "자원 사용량")
helm install kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.3 -n kubeast --create-namespace \
  -f https://raw.githubusercontent.com/junginho0901/Kubeast/v0.7.3/helm/kubeast/values-minimal.yaml
```

### 옵션 3. Docker Compose (클러스터 없이 단일 호스트)

```bash
git clone --branch v0.7.3 --depth 1 https://github.com/junginho0901/Kubeast.git
cd Kubeast

./install-docker.sh
#   --port 9000                             # Gateway 포트 (기본 8000)
#   --uninstall                             # 컨테이너 + 볼륨 모두 제거
```

로그인이 응답하면 스크립트가 주소와 관리자 비밀번호를 출력합니다.

- 로그인하면 Setup 화면이 관리할 클러스터의 kubeconfig를 묻습니다.
  - 그 server 주소는 컨테이너 안에서 닿아야 합니다. `127.0.0.1`이나 `localhost`(kind, minikube)는 컨테이너 자신을 가리킵니다.
  - kind 클러스터라면 `kind get kubeconfig --internal --name <클러스터>`를 붙여 넣고, 클러스터와 통신하는 컨테이너를 kind 네트워크에 연결하세요: `docker network connect kind <폴더>-auth-service-1`, `k8s-service`와 `tool-server`도 같은 방식입니다(`<폴더>`는 내려받은 폴더 이름, 곧 Compose 프로젝트 이름).
- 밖으로 여는 포트는 Gateway 하나뿐입니다. 다른 서비스에는 `docker compose exec`로 들어가세요.
- 스크립트를 다시 실행해도(예: `--port`를 바꿔서) `.env`의 비밀번호와 키는 그대로 둡니다. 데이터베이스 볼륨이 처음 만들 때의 비밀번호를 기억하기 때문입니다.

`docker-compose`는 게시된 이미지를 pull합니다. 기본은 내려받은 태그의 버전이며 `KUBEAST_TAG`로 바꿀 수 있습니다. 소스에서 빌드하려면 다음을 실행하세요.

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

### 업그레이드

```bash
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.3 \
  -n kubeast --reset-then-reuse-values
```

`--reset-then-reuse-values`는 직접 넣은 값을 그대로 두고 새 버전에 생긴 값을 더합니다. `--reuse-values`는 처음 설치한 버전의 기본값을 그대로 써서 뒤 버전에 생긴 값이 빠집니다. 차트는 그런 업그레이드를 이 안내와 함께 멈추고, 릴리스는 그대로 둡니다.

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

`admin.password`를 비워 두면 초기 admin 비밀번호는 **설치할 때 무작위로 생성**되고,
**설치 스크립트가 끝날 때 화면에 출력**됩니다.

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

비밀번호를 직접 정하려면 설치할 때 `--set admin.password=<원하는비번>`을 넘기세요.

### 3. 로그인 후 클러스터 연결 (Connect your cluster)

먼저 `admin` 계정으로 로그인하세요. 등록된 클러스터가 없으면 로그인하자마자 `/setup` 마법사로 이동합니다.
마법사와 그 API에는 관리자 권한이 필요합니다. **로그인한 뒤 바로 비밀번호를 바꾸세요.**

- **In-cluster** — Kubeast가 실행 중인 클러스터에 ServiceAccount 권한으로 자동 연결합니다.
- **External** — 다른 클러스터의 kubeconfig를 등록합니다(멀티클러스터). API 서버 주소를 비워 두면 연결을 확인할 때 실제로 접속한 주소가 채워지고, 주소 없이 등록된 클러스터는 **Admin > Clusters**에서 연결 테스트를 하면 채워집니다.

**클러스터 준비물**: Kubeast는 등록한 클러스터에 아무것도 설치하지 않습니다.
권한(RBAC)은 클러스터마다 갖춰야 하고, 그래프, 비용, 정책 보고서 같은 기능은 그 클러스터의 metrics-server, Prometheus, OpenCost, Kyverno 등을 읽습니다.

- [docs/ko/cluster-requirements.md](cluster-requirements.md): 기능마다 무엇이 필요한지, 그것을 찾는 방법, 확인 명령과 예시
- `deploy/examples/target-cluster/`: 예시 값
- `scripts/render-target-rbac.sh`: 등록 클러스터에 줄 권한을 렌더링하는 스크립트

**EKS 클러스터**는 IAM으로 인증합니다.

- Kubeast 파드의 IRSA 롤(`values.yaml`의 `aws.irsaRoleArn`)이 `-r`로 지정한 대상 롤을 AssumeRole합니다.
- 대상 클러스터의 access entry가 그 롤을 Kubernetes 그룹에 매핑합니다.
- 그룹 권한은 `helm/kubeast/files/impersonation-rbac.yaml`에 있습니다.

k8s-service와 tool-server 이미지에 `aws-iam-authenticator`가 들어 있으므로, kubeconfig에는 정적 자격증명 대신 exec 플러그인을 적으세요.

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

등록하는 kubeconfig의 exec 명령은 허용 목록(`multicluster.execCommands`, 기본값 `aws-iam-authenticator`)에 있어야 하며, `AWS_ACCESS_KEY_ID` 같은 정적 키를 env에 넣으면 거부됩니다.

### 4. AI 활성화

**Admin > AI Models**에서 OpenAI / Anthropic / Gemini 등의 API 키를 등록하면
AI 어시스턴트가 활성화됩니다.

모델 드롭다운에는 공급자가 그 키와 주소로 알려 주는 모델 목록이 나옵니다.

- ai-service가 Anthropic은 `GET /v1/models`를, 그 밖의 공급자(OpenAI, Gemini, Ollama, OpenAI 호환 게이트웨이)는 `GET {base_url}/models`를 호출합니다.
- 임베딩·음성·이미지 모델은 목록에서 뺍니다.
- 이 조회는 `POST /api/v1/ai/model-configs/models`(관리자 전용)이며, 키와 주소 규칙은 연결 테스트와 같습니다.
- 키가 없거나 목록을 받지 못하면 내장 목록과 그 이유가 표시되고, "모델 이름 직접 입력"도 할 수 있습니다.
- 브라우저는 Kubeast 밖으로 요청을 보내지 않으므로, 내부망에서도 그 설정의 주소(사내 게이트웨이, Ollama)에서 받은 목록이 나옵니다.

AI 없이 콘솔만 쓰려면 `ai.enabled: false`로 설치하세요. 그러면 다음과 같이 동작합니다.

- ai-service, tool-server, ModelConfig 컨트롤러가 배포되지 않습니다.
  - 새 설치에는 CRD도 없습니다.
  - 켰다가 끈 설치에는 CRD와 ModelConfig가 남습니다.
- 게이트웨이의 `/api/v1/ai`는 JSON으로 503을 돌려줍니다.
- 화면은 `/api/v1/cluster/features`의 `ai.enabled`를 보고 AI 채팅, 플로팅 어시스턴트, AI 관리 페이지, MCP 안내를 숨깁니다.

AI를 켠 설치에서도 ai-service는 모델 클라이언트를 처음 만들 때 provider SDK를 불러오고, MCP SDK는 `mcp.enabled`일 때만 불러와 유휴 메모리를 줄입니다.

Anthropic(provider `anthropic`)은 OpenAI 호환 주소가 아니라 Messages API(`/v1/messages`)로 호출합니다.
구현은 `app/services/anthropic_messages.py`에 있고, 응답은 다른 공급자와 같은 모양으로 바꿔 돌려줍니다.

- **샘플링 값**: Claude 4.7 이후 모델과 이름에서 버전을 읽지 못하는 모델에는 `temperature`·`top_p`·`top_k`를 보내지 않습니다. 이 모델들은 기본값이 아닌 값을 받으면 400을 돌려줍니다.
- **thinking**: 모델 기본값을 따르며, Claude 5 계열은 기본으로 켜져 있습니다.
  - API 요건에 따라 도구 호출 사이에는 그 턴의 thinking 블록을 그대로 돌려보냅니다.
  - thinking 토큰도 `max_tokens`에 들어가므로, Claude 5 계열과 이름에 버전이 없는 모델에는 호출부의 `max_tokens`에 4,096을 더해 보냅니다. 이 값은 상한일 뿐이고 실제로 쓴 만큼만 과금됩니다.
- **프롬프트 캐시**: 자동 캐시(`cache_control`)가 기본으로 켜져 있으며, 모델 설정 옵션 `prompt_cache: false`로 끌 수 있습니다. 사용량의 입력 토큰은 캐시에서 읽은 토큰까지 포함한 전체 입력입니다.
- 키는 지금처럼 `ANTHROPIC_API_KEY`(또는 `KUBEAST_AI_KEY_*`)에 두세요. base_url에 예전 호환 주소(`https://api.anthropic.com/v1/`)가 들어 있어도 그대로 동작합니다.

**Azure OpenAI (provider `azure`, CRD `azureopenai`)** — Azure의 **v1 API**만 씁니다. v1 API는 2025-08부터 제공되며, OpenAI 호환이고 날짜 형식의 `api-version`이 없습니다.
**실계정 검증 전**: 연결과 채팅은 같은 호출 코드를 쓰며, 가짜 서버와 OpenAI 호환 서버로만 확인했습니다.

- **주소**: `https://<리소스>.openai.azure.com/openai/v1/`입니다. `…services.ai.azure.com/openai/v1/`나 API Management 같은 게이트웨이 주소도 쓸 수 있습니다. 키가 다른 곳으로 가지 않도록 비워 둘 수 없습니다.
- **모델 칸**: 모델 이름이 아니라 **배포 이름**을 넣습니다(Azure AI Foundry → 배포). 공급자 모델 목록이 없으므로 이름을 직접 입력하세요.
- **키**: `KUBEAST_AI_KEY_*` 변수에 두면 `Authorization: Bearer` 헤더와 `api-key` 헤더에 모두 실어 보냅니다.
- **안 되는 것**: 예전 배포별 주소(`…/openai/deployments/<배포>`)와 날짜 형식의 `api-version`은 저장이나 연결 테스트 때 v1 주소를 안내하며 거절합니다. Entra ID 토큰 인증도 아직 지원하지 않습니다.
- Private Link로 사설 주소가 나오는 리소스는 그 호스트를 `ai.baseUrlAllowedHosts`에 넣으세요.
- CRD로 만들 때는 `spec.baseURL`(또는 `azureOpenAI.azureEndpoint`)에 v1 주소를, `spec.model`에 배포 이름을 넣습니다.
  - `apiVersion`·`azureDeployment`·`azureAdToken`은 kagent 호환을 위해 남아 있지만 쓰지 않습니다.

**Claude 구독으로 쓰기 (provider `claude-code`, 개인용)** — API 키 대신 Claude Pro/Max 구독의 `claude setup-token` 값으로 채팅합니다.
구독 토큰은 Claude Code에서만 쓸 수 있으므로, ai-service는 모델을 호출할 때마다 Claude Agent SDK(`app/services/claude_code.py`)로 Claude Code를 띄웁니다.
Claude Code가 부르는 도구는 채팅의 도구 코드가 이 프로세스 안에서 처리합니다.
그래서 도구 목록, 쓰기 도구의 승인 카드, 마스킹, `ai.tool.call`·`ai.chat.complete` 감사(provider `claude-code`)가 API 키를 쓸 때와 같습니다.

- **혼자 쓰는 설치에서만** 켜세요. Anthropic 약관은 구독을 본인 사용으로 한정하므로, 팀이나 여러 사용자가 쓰는 Kubeast에 넣으면 안 됩니다. 관리 화면에서도 이 프로바이더를 고르면 같은 경고가 나옵니다.
- **켜는 법**: ① 본인 PC에서 `claude setup-token`으로 유효 기간 1년짜리 토큰을 만들어 `ai.claudeCodeOAuthToken`(또는 `apiKeysSecret`의 `CLAUDE_CODE_OAUTH_TOKEN` 키)에 넣고, `ai.providers.claudeCode.enabled: true`로 설정해 배포하세요.
  - 이 값을 켜면 ai-service가 Claude Code가 들어 있는 이미지로 바뀝니다. 같은 버전의 `<버전>-claude-code` 태그이며 약 250 MB 더 큽니다. 기본 이미지에는 Claude Code가 없습니다.
  - 이미지를 직접 빌드한다면 `--build-arg WITH_CLAUDE_CODE=true`로 빌드하고 `ai.providers.claudeCode.imageTagSuffix: ""`로 두세요.
  - ② **Admin > AI Models**에서 "Claude subscription"을 고르면 변수 이름이 `CLAUDE_CODE_OAUTH_TOKEN`으로 채워집니다.
  - 연결을 테스트한 뒤 저장하세요.
  - 값이 꺼져 있거나 이미지에 Claude Code가 없어 이 설치에서 아직 쓸 수 없으면, 목록에 "Not set up"으로 흐리게 보입니다. 고르면 그 이유가 먼저 나오고 테스트·저장 버튼이 막힙니다.
- **격리**: 실행 환경을 다음과 같이 분리합니다.
  - 실행할 때마다 임시 HOME과 설정 디렉터리를 씁니다.
  - Claude Code 기본 도구(Bash, 파일, 웹)는 없고, 설정 파일과 CLAUDE.md를 읽지 않습니다.
  - ai-service가 받은 환경변수는 경로, 프록시, CA 변수를 빼고 모두 빈 값으로 덮어쓰므로 모델 키나 DB 주소가 넘어가지 않습니다.
  - 토큰은 `CLAUDE_CODE_OAUTH_TOKEN`으로만 전달합니다.
- **규칙**: `CLAUDE_CODE_OAUTH_TOKEN`은 claude-code만 쓸 수 있고, claude-code는 base_url과 다른 공급자의 키 변수를 받지 않습니다. 꺼진 설치에서 새 claude-code 설정을 저장하면 400으로 거절되고, 연결 테스트가 그 이유를 보여 줍니다.
- **한도**: 동시에 실행되는 턴은 `maxConcurrent`까지입니다(기본 1, 나머지는 대기).
  - 한 턴은 `turnTimeoutSeconds`(기본 300초)와 `maxTurns`(기본 모델 호출 10회)를 넘지 않습니다.
  - 턴마다 Claude Code 프로세스(최대 약 300 MB)가 하나씩 뜨므로, `maxConcurrent`를 올리면 `resources.aiService.limits.memory`도 함께 올리세요.
- **알림 → AI 조사**도 이 프로바이더로 실행됩니다.
  - 조사기는 한 번에 하나씩 돌며 채팅과 별도의 칸을 쓰므로, 조사 중에도 채팅이 기다리지 않습니다.
  - 그래서 조사가 켜져 있으면 Claude Code 프로세스가 `maxConcurrent` + 1개까지 뜹니다.
  - 단계 상한은 API 키를 쓸 때와 같은 `maxSteps`이며, 마지막 단계에서는 도구 없이 보고서를 씁니다.
- **안 되는 것**: 공급자 모델 목록은 없습니다. 내장 목록에서 고르거나 이름을 직접 입력하세요.
