[English](../ai-alerts.md) | **한국어**

# AI·알림

## AI 에이전트 연결 (MCP 서버)

Claude Code나 Cursor 같은 AI 에이전트에 클러스터를 보여 주려면 보통 kubeconfig를 에이전트에 넘겨 줍니다. 그러면 다음 문제가 생깁니다.

- 누가 무엇을 했는지 감사에 남지 않습니다.
- 에이전트가 사람보다 많은 권한을 갖게 됩니다.
- Secret 값이 그대로 모델로 넘어갑니다.

Kubeast의 MCP 서버(`/api/v1/ai/mcp`, [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports))가 그 역할을 대신합니다.

- 에이전트는 **API 키 하나**로 연결하고, 채팅과 같은 **읽기 도구**를 **그 사람의 권한으로만**(클러스터별 역할, impersonation) 씁니다.
- 결과는 모델로 가기 전에 마스킹합니다(Secret 값은 항상 제거).
- 호출마다 감사 로그 `ai.mcp.call`을 남기며, 감사 행을 쓰지 못하면 호출을 거부합니다.
- 쓰기 도구는 기본으로 없으며, 운영자가 `mcp.writeTools`로 켜면 역할 상한이 Write인 키에만 열립니다.

```bash
# Settings → API keys에서 키를 발급한 뒤(클러스터·역할 상한 지정), 에이전트에 등록
claude mcp add --transport http kubeast https://console.example.com/api/v1/ai/mcp \
  --header "Authorization: Bearer $KUBEAST_API_KEY"
```

- 켜기: `mcp.enabled: true`(컴포즈는 `MCP_ENABLED`). 기본은 꺼져 있고, 꺼져 있으면 경로 자체가 없습니다.
- 권한: 그 클러스터에 대한 `ai.mcp.use`(시스템 Read·Write 역할에 포함, Admin은 모든 권한)와 쓰려는 도구의 `ai.tool.<이름>`이 필요합니다.
  - Read는 읽기 도구 42종만, Write는 전부와 쓰기 미리보기 `k8s_diff`를 쓸 수 있습니다.
  - `hygiene`은 `admin.hygiene.read`를 가진 Admin에게만 보입니다.
  - `list_clusters`가 연결한 사람이 쓸 수 있는 클러스터와 도구를 알려 줍니다.
  - 나머지 도구는 `cluster` 인자가 필수이며 기본 클러스터로 대신하지 않습니다.
- 인증: `Authorization: Bearer` 헤더에 API 키(`kbk_…`)나 액세스 토큰을 넣습니다.
  - 서버는 키를 수명이 짧은 토큰으로 교환해 쓰고(교환도 감사에 남음), 키를 폐기하면 다음 호출부터 거부합니다.
  - 세션을 두지 않으므로(stateless) 요청마다 검사하고, 복제본을 여러 개 띄워도 됩니다.
- 감사: `ai.mcp.call`의 `after`에 도구, 클러스터, 마스킹 통계, 자격 증명(`credential.akid` = 키 id), 클라이언트(User-Agent), `write`(쓰기 도구 여부)가 남습니다. 권한 밖 호출도 `failure`로 남습니다.
- 쓰기 도구(`mcp.writeTools: true`, 컴포즈는 `MCP_WRITE_TOOLS`, 기본 꺼짐): 채팅의 쓰기 도구 11개(apply·create·delete·patch·annotate·label·scale·rollout·exec …)가 **역할 상한이 Write인 키**에 함께 열립니다.
  - 채팅의 승인 카드(`ai.writeApproval`)는 MCP에 없습니다.
  - 그 사람이 그 클러스터에서 할 수 있는 범위 안에서만 실행됩니다. 영구 역할이나 [접근 요청](configuration.md)(`accessRequests`)으로 받은 임시 역할이 그 범위입니다.
  - 호출마다 `write: true`로 감사에 남습니다.
  - 도구 어노테이션(`destructiveHint`)을 실제 동작대로 붙이므로 Claude Code 같은 클라이언트는 호출 전에 사용자에게 확인을 띄웁니다.
  - Argo CD가 관리하는 객체는 가드 모드를 따릅니다. `block`이면 거부하고(“Git에서 바꾸세요”), `warn`이면 실행한 뒤 결과 첫 줄에 경고를 붙입니다.
  - 권한이 모자라면 에이전트가 `request_access` 도구로 직접 접근 요청을 내고(관리자가 승인하면 1분 안에 반영), 다시 시도합니다.

## 알림 → AI 조사 (Alertmanager·Grafana)

알림이 울리면 Kubeast가 **읽기 도구만으로 1차 조사를 해 두고** 보고서를 남깁니다. 쓰기는 하지 않으며, 고치는 일은 사람이 보고서를 보고 합니다.
기본은 꺼져 있습니다(`features.alertInvestigation.enabled`). 켜려면 `auth.impersonation.enabled`와 `ai.enabled`도 켜야 하며, 그렇지 않으면 차트 렌더가 실패합니다.

- **받는 곳**: Alertmanager 웹훅 수신자를 `POST <Kubeast 주소>/api/v1/alerts/webhook?cluster=<클러스터 ID>`로 지정합니다.
  - `http_config.authorization`에 Bearer `ALERT_WEBHOOK_TOKEN`(kubeast-secrets에 있으며 차트가 생성)을 넣습니다.
  - 형식은 Alertmanager v4를 그대로 씁니다.
  - Grafana 알림이면 웹훅 연락처에 같은 URL과 Authorization 헤더(Bearer, 토큰)를 넣습니다. Grafana 13의 웹훅 본문도 읽는 필드가 같아 그대로 받습니다.
  - 토큰이 틀리면 401, 모르는 클러스터이거나 기능이 꺼져 있으면 404를 돌려줍니다.
- **거르기**: `firing`이고 `severity` 라벨이 `severities`(기본 critical·warning)에 있는 알림만 받습니다.
  - 클러스터와 fingerprint가 같은 알림이 `dedupeHours`(24) 안에 다시 오면 `repeat_count`만 올립니다(Alertmanager는 4시간마다 다시 보냅니다).
  - 시간당 `maxPerHour`(6)나 하루 `dailyTokenBudget`(200,000 토큰, UTC 기준)을 넘으면 `skipped`로 남깁니다.
  - 모델 공급자가 **크레딧·키 문제로 거절**하면 그 건은 `failed`("provider refused (credit)…")가 됩니다.
    그 뒤 `providerPauseMinutes`(30분, 0 = 끔) 동안 들어오는 알림과 대기 중이던 알림은 `skipped`("paused: …until …")로 두어, 막힌 공급자를 알림마다 다시 부르지 않습니다.
    구독의 사용량 한도라면 한도가 풀리는 시각까지 멈춥니다.
  - 요청 한도 초과(429)나 장애는 일시적이므로 멈추지 않습니다.
  - 웹훅 응답 `{accepted, duplicate, filtered, skipped, resolved, dropped}`은 바로 돌아옵니다.
- **조사**: 작업자 하나가 대기열의 알림을 하나씩 처리하며, 복제본이 여럿이어도 한 번만 처리합니다.
  - auth-service가 그 클러스터용 **조사 전용 토큰**을 10분짜리로 발급합니다.
    - 권한은 읽기 도구 42개와 로그 저장소 검색이 확인하는 `resource.pod.read`입니다. Helm·정책 보고·비용·네트워크 흐름·네트워크 차단 도구는 이 권한이 없어 조사에는 보이지 않습니다.
    - 알림에 `namespace` 라벨이 있으면 그 Namespace로 한정합니다.
    - 클러스터에는 사용자·그룹 `kubeast:investigator`로 요청합니다. 이 신원은 Secret·exec·쓰기 권한이 없는 읽기 전용 ClusterRole입니다(`templates/impersonation-investigator.yaml`).
  - 조사에서 CRD(Kyverno PolicyReport, Argo Rollout, KEDA ScaledObject 등)도 읽게 하려면 `extraRules`에 읽기 규칙을 추가하세요. 동사는 get, list, watch만 쓸 수 있고, `apiGroups "*"`, Secret, exec, 프록시, 토큰, 와일드카드 자원은 렌더 단계에서 거부합니다.
  - 추가한 규칙은 알림을 보내는 모든 클러스터에 다시 적용하세요(`scripts/render-target-rbac.sh`).
  - 모델은 `model`(ModelConfig 이름) 또는 기본 모델을 쓰고, 모델 호출은 `maxSteps`(8)번까지, 전체 시간은 `timeoutSeconds`(300)까지입니다. 마지막 호출에는 도구를 주지 않으므로 답이 돌아옵니다.
  - 알림의 라벨·주석은 프롬프트에서 "신뢰하지 않는 데이터"로 분리합니다.
- **보고서**: 요약 · 확인한 것 · 가능한 원인 · 다음에 볼 것으로 구성됩니다(`language`, 기본 en).
  - API는 `GET /api/v1/ai/investigations`(목록, `status`·`cluster`로 거르기)와 `/{id}`(상세: 보고서·도구 호출·토큰)이고, 권한은 `admin.investigations.read`입니다.
  - 상세에는 파드 로그가 인용될 수 있어 열람할 때마다 `ai.investigation.view`로 남깁니다.
  - 보존 기간은 `retention.investigationDays`(90일)입니다.
- **화면**: Admin → **Investigations**. 기능과 AI가 켜져 있을 때 메뉴에 보이며, 권한은 `admin.investigations.read`입니다.
  - 받은 시각, 클러스터, 알림, 심각도, Namespace, 상태, 반복, 토큰, 소요 시간을 표로 보여 주고, 상태와 클러스터로 거를 수 있습니다.
  - "보고서"를 누르면 창에 보고서, 알림 라벨/주석, 알림 보낸 곳(Alertmanager·Grafana) 링크, 도구 호출(인자·결과 길이)이 나옵니다.
  - 이때 주소가 감사 요약의 링크와 같은 `?id=<조사 ID>`로 바뀝니다.
  - 보고서는 외부 알림을 읽은 모델이 쓴 글이므로 원시 HTML 없이 Markdown으로만 그립니다.
- **모델**: 보고서의 품질은 모델에 달려 있습니다. 작은 로컬 모델은 근거가 약한 인과 관계를 "Likely cause"에 적기도 하므로, 운영 환경에서는 도구 호출을 잘하는 큰 모델을 `model`로 따로 지정하기를 권합니다.
- **감사·알림**: 조사 1건은 `ai.investigation.run`, 도구 호출 1번은 `ai.tool.call`로 남습니다.
  - 조사 기록의 actor는 `system` / `kubeast:investigator`이고, `after`에 알림, 모델, 토큰, 도구 호출 수, 소요 시간, 500자 요약, 링크가 들어갑니다.
  - 감사 싱크의 `filter.actions`에 `ai.investigation.run`을 넣으면 요약이 Slack이나 메일로 갑니다.
  - `consoleUrl`을 설정하면 요약에 보고서 링크가 붙습니다.
- **클러스터 쪽**: 조사 신원의 RBAC과 Alertmanager 설정 예시는 [docs/ko/cluster-requirements.md](cluster-requirements.md) §1·§13에 있습니다.
  - dev에서는 두 번째 클러스터의 Alertmanager에 `amtool alert add`로 가짜 알림을 넣어 확인합니다(`deploy/kind/alertmanager.yaml`).
  - Grafana는 `scripts/kind-grafana.sh`로 띄운 Grafana에서 웹훅 연락처 시험 기능으로 알림을 보냅니다(e2e `grafana.spec.ts`).

## Alerts 받은편지함

Alertmanager(또는 Grafana 알림)가 보낸 알림을 **울리는 중인 것과 해결된 것 모두, 심각도와 상관없이** 클러스터마다 한 목록으로 보여 줍니다(메뉴 Core → **Alerts**).
위 조사와 같은 웹훅으로 들어오므로 `features.alertInvestigation.enabled`(AI도 켜져 있어야 함)가 필요하고, 해결 소식을 받으려면 웹훅에 `send_resolved: true`(기본값)를 설정하세요.

- **누가**: 선택한 클러스터를 Namespace 제한 없이 읽을 수 있는 사람(그 클러스터의 `resource.pod.read`)이 봅니다. AI 알림 도구, 알림 저장소 읽기와 같은 기준입니다.
  - 그 알림의 AI 조사 보고서도 여기서 열 수 있고, 열 때마다 `ai.investigation.view`가 남습니다.
- **한 줄 = 알림 1건**: 클러스터, fingerprint, `startsAt`이 같으면 같은 알림입니다.
  - Alertmanager가 `repeat_interval`마다 다시 보내면 "받은 횟수"가 오릅니다.
  - resolved가 오면 해결됨이 되고, 해결 뒤 다시 울리면 새 줄이 생깁니다.
  - 상태는 울리는 중 · **상태 확인 안 됨** · 해결됨입니다.
  - 상태 확인 안 됨은 울리는 중인데 `inbox.staleAfterHours`(8) 동안 소식이 없는 알림입니다(Alertmanager는 울리는 알림의 `endsAt`을 웹훅으로 보내지 않습니다).
  - 그 클러스터에 알림 저장소(`features.alertStore`)가 있으면 Alertmanager의 현재 상태(무음 중, 억제됨, Alertmanager에 없음)도 함께 표시합니다.
- **무음**: 그 클러스터에 알림 저장소가 있고 `features.alertStore.silences: true`이면 무음을 만들 수 있습니다.
  - 이 값은 기본으로 꺼져 있으며, 저장소 인증에 쓰기 권한이 필요합니다(Grafana면 Editor).
  - 권한 `resource.alert.silence`(Write·Admin에 기본 포함, Read에는 없음)를 가진 사람이 알림 창의 **무음**에서 조건, 기간, 이유를 정하고 **지금 무음이 걸릴 알림**을 미리 본 뒤 만듭니다.
  - 조건은 그 알림의 이름, Namespace, 대상 레이블에서 시작해 더하거나 지울 수 있습니다(`=`·`!=`·`=~`·`!~`).
  - 기간은 최대 `silenceMaxHours`(168시간)이고, 이유는 필수입니다.
  - 서버가 모든 무음에 그 클러스터 조건(`<clusterLabel>="<값>"`)을 붙이므로 다른 클러스터의 알림은 멈출 수 없습니다. 빈 레이블에도 맞는 조건(예: `alertname=~".*"`)만으로는 무음을 만들 수 없으며, 이는 Alertmanager와 같은 규칙입니다.
  - **무음** 탭에서 그 클러스터에 걸려 있거나 예정된 무음을 보고 "지금 끝내기"로 끝낼 수 있습니다.
  - 감사 `alert.silence.create`·`alert.silence.expire`.
- **처리 표시**: 확인함 · 내가 담당/해제 · 메모 · 조치 완료를 표시할 수 있습니다.
  - Kubeast 안에만 남는 기록이며 Alertmanager나 알림 규칙은 바꾸지 않습니다. "해결됨"은 알림 규칙이 정합니다.
  - 바꿀 때마다 `alert.inbox.update`(전·후 값)를 남기고, 감사 DB에 쓸 수 없으면 503을 돌려주며 표시도 되돌립니다.
- **화면**: 상태 탭(울리는 중, 상태 확인 안 됨, 해결됨, 전체)이 있고 심각도, 내 담당, 조치 안 된 것으로 거를 수 있습니다.
  - 대상(라벨 `pod`·`deployment`·`node` 등)을 누르면 리소스 상세 창이 열립니다.
  - 한 건을 열면 라벨, 주석, 알림 보낸 곳 링크, 처리 칸, AI 조사가 나옵니다.
  - API는 `GET /api/v1/alerts/inbox?cluster=`·`/{id}`·`PATCH /{id}`·`/{id}/investigation`입니다.
  - 보존 기간은 조사와 같은 `retention.investigationDays`이며, 마지막으로 받은 시각부터 셉니다.

## 트레이스 읽기 (AI, Tempo)

`features.traceStore.enabled`(기본 꺼짐)를 켜면 AI가 Tempo HTTP API를 읽습니다.
Grafana 데이터소스 프록시 `…/api/datasources/proxy/uid/<Tempo UID>`를 거쳐도 되며, 이때는 Viewer 서비스 계정 토큰을 쓰고 테넌트는 비워 둡니다.

- **도구**:
  - `traces_search`: TraceQL 검색
  - `traces_get`: 트레이스 ID → 스팬
  - `traces_tags`: 속성 이름·값
  - `traces_metrics`: TraceQL 지표 → 시리즈, 그래프로도 표시
  - `traces_compare`: 빠른·보통·느린 표본 + p50·p90
- **누가**: 로그 검색과 같이 다음을 모두 통과해야 하며, 네임스페이스 한정 부여는 자기 네임스페이스만 읽습니다.
  - Pod 읽기 권한
  - 그 네임스페이스에서 사용자 신원으로 `get pods/log` 권한(클러스터에 확인)
  - 분당 한도
- **범위 강제**: AI가 쓴 TraceQL의 **모든 스팬셋 필터 `{ }`에** k8s-service가 `resource.<attributes.cluster> = "<clusters의 값>"`을 AND로 넣고, NS 경로라면 `resource.<attributes.namespace> = "<ns>"`도 넣습니다.
  - 필터는 Tempo 렉서와 같은 규칙(문자열, raw 문자열, 주석, 속성 이름 읽기)으로 찾고, 괄호가 깨졌거나 중괄호가 겹치면 거부합니다. Tempo 3.1.0의 실제 파서에 변형을 100만 건 넘게 넣어 범위 없는 필터가 0건임을 확인했습니다.
  - 다른 스팬을 읽는 `parent.`, 루트 스팬(`rootName`·`rootServiceName`·`trace:rootService`), 트레이스 전체 시간(`traceDuration`·`trace:duration`), 트리 위치(`nestedSet*`)는 400으로 거부합니다.
  - 검색 결과에서는 루트 서비스와 전체 시간을 빼고, ID 조회는 그 클러스터(와 NS)의 스팬만 돌려주며 나머지는 `hidden` 개수로만 알려 줍니다.
- **최근 데이터**: Tempo는 새 스팬을 몇십 초 뒤부터 검색에 내줍니다(개발 Tempo에서 약 25초).
  - TraceQL 지표에서는 끝 시각을 지금보다 `query_end_cutoff`(기본 30초)만큼 앞당긴 뒤 단계 단위로 내려 자르므로, 하루 창(단계 12분)이면 마지막 몇 분이 지표에 없습니다.
  - 점이 창 끝보다 2분 넘게 일찍 끝나면 `traces_metrics`는 그 시각과 함께 "최근 몇 분은 `traces_search`로" 보라는 안내를 붙입니다.
- **감사**: `k8s.traces.query`에 `kind`(search·metrics·compare·trace), AI가 쓴 질의, 실제 보낸 질의, 건수를 남기고 스팬 내용은 남기지 않습니다. 속성 목록 조회는 감사에 남기지 않습니다.
- **API**:
  - `GET /api/v1/[cluster/namespaces/{ns}/]traces/{search,metrics,compare}?q=&since=`
  - `…/traces/trace/{traceID}`
  - `…/traces/tags?scope=&tag=`

```yaml
features:
  traceStore:
    enabled: true
    url: https://grafana.example.com/api/datasources/proxy/uid/tempo
    auth: {existingSecret: grafana-reader}   # key "authorization": "Bearer <token>"
    attributes: {cluster: k8s.cluster.name, namespace: k8s.namespace.name}
    clusters: {alpha: eks-alpha, prod: eks-prod}
```

## AI 분석 평가

AI가 원인을 실제로 찾는지는 e2e가 아니라 평가 스크립트로 측정합니다. `scripts/ai-eval.py`는 다음 순서로 동작하며, 모델마다 한 번씩 돌립니다.

1. dev 클러스터에 문제 12개를 만듭니다: CPU 급등, OOMKilled, 로그에 원인이 찍히는 CrashLoop, 한 파드의 5xx, 느린 경로 트레이스, 울리는 알림, Pending 두 가지, ImagePullBackOff, Read 사용자의 Secret 요청, 멈춘 롤아웃, PVC Pending.
2. 운영자처럼 질문합니다.
3. 답에 기대한 사실과 필요한 도구가 들어 있는지 채점합니다.

사례 형식과 최근 결과는 [evals/ai/README.md](../../evals/ai/README.md)에 있습니다. 2026-10-19 결과: Haiku 5.5·Sonnet 5.5(구독) 12/12.

## 알림 읽기 (AI, Alertmanager)

`features.alertStore.enabled`(기본 꺼짐)를 켜면 AI의 `alerts_list`가 알림 저장소에서 **이 클러스터의 현재 알림**과 **그 알림에 걸린 무음**을 읽습니다.

- **읽는 내용**:
  - 알림: 이름, 심각도, 상태(울림/무음/억제), 시작 시각, 요약, 레이블, 받는 곳
  - 무음: 누가, 왜, 언제까지
- **저장소 주소**: 다음 중 하나이며, Grafana라면 Viewer 서비스 계정 토큰을 씁니다.
  - Alertmanager API v2(`http://alertmanager.monitoring:9093`)
  - Grafana 데이터소스 프록시를 거치는 Alertmanager(`…/api/datasources/proxy/uid/<Alertmanager UID>`)
  - Grafana 알림 자체(`…/api/alertmanager/grafana`)
- **누가**: 그 클러스터 전체에 대한 부여가 있는 사람만 읽습니다(Prometheus 도구와 같음).
  - 노드·클러스터 알림처럼 네임스페이스가 없는 알림이 많아 네임스페이스 한정 부여는 거부합니다.
  - 분당 한도도 적용됩니다.
- **범위 강제**: k8s-service가 저장소에 `<clusterLabel>="<clusters의 값>"` 매처로 묻고, 돌아온 알림의 레이블을 **다시 확인**해 다른 값은 버립니다.
  - 모델이 준 조건(알림 이름, 레이블 값)은 따옴표 매처로 만들고, 클러스터 레이블은 항상 이 클러스터의 값으로 고정합니다.
  - 무음은 **이 클러스터 알림에 걸린 것만** 보여 주고, 다른 클러스터의 무음은 보이지 않습니다.
  - 클러스터 하나만 쓰는 Alertmanager라면 값을 비워 전부 읽을 수 있습니다(`clusters`에 클러스터가 하나일 때만).
- **감사**: 없음 — 알림은 운영 상태이므로 `prometheus_rules`처럼 일반 읽기로 다룹니다.
- **API**:
  - `GET /api/v1/alertstore/alerts?state=firing|silenced|inhibited|all&alertname=&label=<이름>=<값>`
  - `GET /api/v1/alertstore/silences`: 이 클러스터에 걸려 있거나 예정된 무음
  - `GET …/silences/preview?matchers=<JSON>`: 그 무음이 지금 멈출 알림
  - 쓰기는 `silences: true`일 때만 가능합니다. `POST /api/v1/alertstore/silences {matchers, durationMinutes, comment}`와 `DELETE …/silences/{id}`이며, 권한은 `resource.alert.silence`입니다(위 Alerts 받은편지함의 "무음").
  - 화면에서든 AI에서든 요청은 브라우저가 아니라 k8s-service가 저장소로 보냅니다(게이트웨이 `/api/v1/alertstore/`).

```yaml
features:
  alertStore:
    enabled: true
    url: https://grafana.example.com/api/alertmanager/grafana   # 또는 …/api/datasources/proxy/uid/<Alertmanager UID>
    auth: {existingSecret: grafana-reader}   # key "authorization": "Bearer <token>"
    clusterLabel: cluster
    clusters: {alpha: eks-alpha, prod: eks-prod}
```
