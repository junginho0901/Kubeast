[English](../development.md) | **한국어**

# 개발

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
├── deploy/examples/target-cluster/   # 대상 클러스터 준비물 예시 값 (Prometheus·OpenCost 차트, 클러스터별 RBAC 값 — docs/ko/cluster-requirements.md)
├── docs/                            # 운영 문서 (클러스터 준비물·SSO·메트릭·감사·백업·공급망)
├── e2e/                             # Playwright E2E (라이브 클러스터 대상)
│   ├── actions/                     # 옵트인 동작 스위트 — UI 동작 92개 + kubectl 검증 (E2E_ACTIONS=1 --project=actions)
│   └── demo/                        # 소개 사이트 영상 대본 (E2E_DEMO=1 --project=demo, scripts/site-media.sh)
├── scripts/                         # 빌드/배포/개발 스크립트
├── site/                            # 소개 사이트 (GitHub Pages, .github/workflows/pages.yaml)
├── install.sh                       # K8s 원라인 설치
├── install-docker.sh                # Docker 원라인 설치
└── docker-compose.yml               # (+ docker-compose.build.yml 빌드 override)
```

---

## kind 개발 루프

로컬 개발 루프는 kind를 쓰며, dev 클러스터도 **같은 Helm 차트**로 설치합니다.
`deploy/kind/values.yaml`에는 NodePort 30080, localhost origin, 데모 계정, 토큰 60분 같은 dev 전용 차이만 둡니다.
빌드와 배포는 **항상 `scripts/rebuild-kind.sh`로** 하고, docker나 kubectl을 직접 실행하지 않습니다.

```bash
scripts/kind-deploy.sh                        # 처음: kind 생성 + 이미지 빌드·적재 + helm install
scripts/rebuild-kind.sh ai-service frontend   # 특정 서비스 재빌드+배포
scripts/rebuild-kind.sh --all                 # 전체
scripts/rebuild-kind.sh gateway               # nginx.conf만: 릴리스 값 그대로 helm upgrade(이미지 빌드 없음)
scripts/reset-and-deploy.sh [--keep|--db]     # 전체 재생성 / 릴리스·DB만 재설치 / DB만 비우기
```

kind 노드는 postgres·redis·nginx 이미지를 레지스트리에서 받습니다.
프록시 때문에 받지 못하면 `kind-deploy.sh`가 호스트 docker에 있는 같은 이미지를 노드에 넣으므로, 미리 `docker pull`로 받아 두면 됩니다.

AI 채팅과 AI e2e 스펙을 쓰려면 기본 모델이 하나 등록돼 있어야 합니다. 상황에 맞게 다음 중 하나를 쓰세요.

- **노트북에서 Ollama를 돌릴 때** — `kubectl apply -f deploy/kind/modelconfig-ollama.yaml`로 등록하고, 리셋한 뒤에도 다시 적용하세요.
  - 모델은 `granite4.1:3b`, 주소는 `host.docker.internal:11434`입니다.
  - dev 값이 이 주소를 `ai.baseUrlAllowedHosts`와 NetworkPolicy에서 허용합니다.
- **노트북에서 추론을 돌리지 않고 e2e를 전부 돌릴 때** — `scripts/kind-model-haiku.sh up <키 파일>`로 가장 싼 모델인 Anthropic Claude Haiku(`claude-haiku-5-5`)를 그 실행 동안 기본 모델로 둡니다.
  - 키는 파일에서 Secret `kubeast-ai-keys`로만 들어가고 출력되지 않습니다.
  - 끝나면 `down`으로 Ollama를 다시 기본 모델로 두고 키를 지웁니다.
- **Claude 구독 프로바이더로 AI spec을 돌릴 때** — ai-service를 `WITH_CLAUDE_CODE=true`로 빌드한 뒤 `scripts/kind-model-subscription.sh up <토큰 파일>`과 `down`을 같은 방식으로 씁니다.
  - 토큰은 `claude setup-token` 값입니다.

스크립트는 자기가 있는 체크아웃의 chart로 helm upgrade하므로, 브랜치 작업 중에는 그 워크트리에서 실행하세요.

모델 주소가 하나 더 필요한 스펙은 노트북의 Ollama를 쓰지 않습니다.
- `ai-model-list`·`ai-azure-openai`·`ai-model-tier`는 dev `model-stub`이 `/ok/` 아래에서 여는 OpenAI 호환 주소를 씁니다(`deploy/kind/devtools.yaml`).
- 이 주소는 `stub-large`·`stub-small`을 목록으로 내주고, 모든 채팅에 "ok"로 답하며, 요청하면 스트리밍으로 답합니다.
- 이 스텁이 설치돼 있지 않으면 이유를 남기고 건너뜁니다.

### E2E 테스트 (Playwright)

`e2e/`는 개발 서버가 아니라 **dev kind 클러스터의 게이트웨이**(`E2E_BASE_URL`, 기본 `http://localhost:30080`)를 대상으로 실행합니다.
공유 클러스터 상태를 바꾸므로 한 번에 하나씩(`workers: 1`)만 돌립니다. 화면 비교 스펙은 main에서 찍은 기준 이미지와 비교합니다.

```bash
export KUBECONFIG=$PWD/.kubeconfig-kind      # kubectl을 부르는 스펙이 dev kind만 보게(기본 kubeconfig 금지)
export E2E_USER_EMAIL=admin E2E_USER_PASSWORD="$(kubectl -n kubeast get secret kubeast-secrets -o jsonpath='{.data.DEFAULT_ADMIN_PASSWORD}' | base64 -d)"
cd e2e && npx playwright test                 # 전체
npx playwright test cluster-hygiene.spec.ts   # 스펙 하나
```

전제 조건은 다음과 같습니다. 없으면 그 스펙은 실패하지 않고 사유를 남긴 채 건너뜁니다.

- **두 번째 클러스터 `default`** — `scripts/add-kind-cluster.sh default --addons`로 만드는 kind 클러스터입니다. `kubeast` 네임스페이스는 없습니다.
  - metrics-server, kube-state-metrics, node-exporter, 작은 Prometheus가 있습니다.
  - 그 Prometheus를 읽으면서 그 Prometheus에 수집되는 OpenCost(`deploy/kind/second-cluster.yaml`)도 있습니다.
  - Audit 정책 2개를 둔 Kyverno 1.19도 있습니다. 차트 3.9.2를 `helm template --no-hooks`로 렌더해 server-side로 적용합니다. `default`에 Helm 릴리스가 없어야 `helm.spec.ts`의 빈 목록 기준선이 맞기 때문입니다.
  - Kyverno 설정은 `deploy/kind/kyverno-values.yaml`·`kyverno-policies.yaml`이고, `policy-reports.spec.ts`가 읽는 PolicyReport가 여기서 나옵니다.
  - `?cluster=` 없이 연 화면은 이 클러스터를 보여 주므로, 객체가 필요한 드로어 스펙은 `?cluster=self`로 고정합니다.
- **픽스처** — `kind-deploy.sh`가 `deploy/kind/fixtures.yaml`을 적용하며, 다음이 준비됩니다.
  - CronJob, TLS Ingress, StatefulSet, HPA, RuntimeClass, Argo CD 어노테이션을 단 Deployment
  - 이슈 스펙용으로 깨진 객체 2개(스케줄되지 않는 Deployment, 실패한 Job)
  - `logfiles.spec.ts`가 쓰는, 로그를 파일로만 남기는 `e2e-logfile-writer`
  - dev 값에서는 `features.prometheus.enabled`와 `features.logFiles`(`/var/log/app/*.log`, `default`)가 켜져 있습니다.
- **AI 스펙** — 기본 모델 1개가 필요합니다(위의 Ollama `ModelConfig`).
- **감사 싱크·세션 기록 스펙** — `deploy/kind/devtools.yaml`(S3 스탠드인, Mailpit, 웹훅 수신기)과 dev 값의 싱크 설정, `sessionRecording.enabled`가 필요합니다.
- 리셋하면 위 데이터가 모두 사라지므로 다시 만드세요.

`e2e/actions/`는 UI 동작 92개를 두 번째 클러스터에 실행하고 `kubectl`로 결과를 확인하는 옵트인 동작 스위트(약 12분)라서 기본 실행에 들어가지 않습니다.
`E2E_ACTIONS=1 npx playwright test --project=actions`로 실행하고, 전제 조건은 [e2e/actions/README.md](../../e2e/actions/README.md)를 보세요.

### 소개 사이트 (`site/`)

[https://junginho0901.github.io/Kubeast/](https://junginho0901.github.io/Kubeast/)에는 정적 페이지 `site/`(`index.html`·`style.css`·`app.js`·`particles.js`, 영어·한국어 전환)가 올라갑니다.
main에 반영할 때마다 `.github/workflows/pages.yaml`이 GitHub Pages로 배포합니다.
기능 영상(`site/media/<이름>.mp4`와 첫 장면 `.jpg`)은 `e2e/demo/<이름>.demo.ts` 대본을 dev 클러스터에서 녹화해 만듭니다.

```bash
scripts/site-media.sh              # 전부
scripts/site-media.sh logs helm    # 이것만
```

- 스크립트는 두 번째 클러스터에 녹화용 가게(`e2e/demo/shop.yaml`)와 리비전 3개짜리 Helm 릴리스(`e2e/demo/chart`)를 올렸다가 끝나면 지웁니다.
  녹화는 `E2E_DEMO=1`일 때만 생기는 `demo` 프로젝트에서 돌기 때문에 기본 실행에 들어가지 않습니다.
- 대본에서 `show()`와 `hide()` 사이만 영상에 남고, 페이지 로딩이나 조사 대기 같은 기다림은 잘립니다.
  `step(id)`는 사이트에서 그 영상의 단계 목록이 다음으로 넘어가는 지점이며, 스크립트가 그 시각을 `site/media/steps.js`에 씁니다.
- `ffmpeg`(`brew install ffmpeg`)와, E2E에서 쓰는 것과 같은 `E2E_USER_EMAIL`·`E2E_USER_PASSWORD`가 필요합니다.
  AI 영상(`ai-chat`·`floating-chat`·`alert-investigation`·`masking`)에는 답을 잘하는 기본 모델이 있어야 합니다(`scripts/kind-model-subscription.sh up` → 녹화 → `down`).
- 화면이 바뀌면 그 영상만 다시 찍으세요.
- `floating-chat`을 녹화하면 두 README 맨 위 그림인 `docs/images/floating-chat.gif`도 함께 만들어집니다.
- 배포 단계에서 `index.html`이 불러오는 스타일·스크립트·영상 주소에 `?v=<커밋>`을 붙입니다.
  Pages는 파일을 `max-age=600`으로 내주고, 새로고침해도 페이지만 다시 받기 때문입니다. 저장소의 `index.html`에는 이 값이 붙어 있지 않습니다.
- 휴대폰 화면은 두 엔진으로 확인합니다.
  - 아이폰의 브라우저는 모두 WebKit이므로 Playwright WebKit을 씁니다.
  - 안드로이드 기기를 흉내 낸 Chromium(`devices['iPhone 15']`·`devices['iPhone SE']`·`devices['Pixel 7']`)도 씁니다.
  - 페이지를 불러온 뒤 몇 시점에서 페이지 폭이 화면 폭과 같은지, 확대 창이 화면 안에 들어오는지 봅니다.
  - WebKit은 영상의 원래 폭을 격자 칸의 최소 폭으로 세므로 격자에 `minmax(0, 1fr)`를 씁니다.
  - 안드로이드 크롬은 한 번 넓힌 페이지 폭을 그대로 두므로, 떠다니는 이름은 자리를 잡은 뒤에 폭을 재고 첫 화면은 가로로 잘라 냅니다.
- `site/particles.js`는 콘솔 로그인 화면의 입자 로고(`frontend/src/components/login/LoginHero.tsx`·`frontend/src/utils/particles.ts`)를 순수 자바스크립트로 옮긴 파일이므로, 둘을 함께 바꾸세요.
  로그인 화면의 그림판은 창에 고정돼 있지만, 사이트의 그림판은 페이지의 첫 화면을 덮고 페이지와 함께 스크롤됩니다.
  창에 고정한 그림판을 스크롤할 때마다 다시 그리면 페이지보다 한 박자 늦게 따라오기 때문입니다. 점은 전과 같이 화면 어디서든 날아와 모입니다.

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
