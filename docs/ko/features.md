[English](../features.md) | **한국어**

# 기능 한눈에


## 🤖 AI 어시스턴트

- **다중 LLM 지원** — OpenAI · Anthropic · Gemini · Ollama 등 (OpenAI 호환 어댑터로 통합, Anthropic은 Messages API)
- **스트리밍 채팅** — SSE 기반 실시간 응답, 세션/히스토리 보존.
  모델에는 최근 user/assistant 메시지 `ai.chat.historyMessages`(기본 10)개가 그대로 가고, 그보다 앞의 대화는 **요약 하나**로 접혀 세션 컨텍스트에 남습니다.
  요약은 같은 모델이 밀려난 턴마다 메모를 덧붙여 만들고(`ai.chat.summary.enabled`, 기본 켬), 마스킹을 거치며 `maxChars`를 넘으면 오래된 메모끼리 합칩니다.
  그래서 대화가 길어도 앞부분의 사실을 잃지 않고 프롬프트도 커지지 않습니다.
  - 요약은 새 메시지가 창 밖으로 밀려날 때만 덧붙여 갱신하고, 그때마다 `ai.chat.summarize`로 감사 로그에 남깁니다.
  - 답마다 아래에 그 턴의 토큰("입력 · 출력 · 캐시 %")이 보이고, 툴팁에는 모델 호출 수와 모델이 나옵니다.
    이 값은 메시지에 저장되므로(`messages.usage`, 그 턴의 `ai.chat.complete`와 같은 값) 새로고침한 뒤에도 남습니다.
  - 그 줄(토큰·Copy)은 답이 나오는 동안 닫혀 있다가, 답이 끝나거나 멈추면 열리면서 서서히 나타납니다. 운영체제에서 움직임 줄이기를 켜 두었다면 바로 나타납니다.
  - 답을 멈추면 그때까지의 글이 "멈춤 · 사용량을 표시할 수 없음" 표시와 함께 저장됩니다. session-service는 표식 `{"stopped": true}`만 받습니다.
  - 대화는 맨 아래에 있을 때만 새 글을 따라가고, 위로 스크롤하면 그 자리에 멈추고 "맨 아래로" 버튼이 나타납니다.
  - 답 속의 표에는 가로·세로 선이 있고, 답 옆에는 Kubeast 아이콘이 붙습니다.
- **다중 라운드 Tool Calling** — AI가 허용 목록에 든 툴로 K8s를 조회하고 변경합니다(최대 10라운드).
  읽기/쓰기/관리 툴은 **사용자 권한(JWT)에 따라 허용됩니다**.
  없는 이름, 없는 종류, 없는 기능(metrics-server 등)은 kubectl 오류 대신 **`not_found`(비슷한 이름 목록 포함)·`unknown_kind`·`unavailable` 결과**로 돌아옵니다.
  그래서 AI는 네임스페이스를 바꿔 가며 되묻지 않고, 한 번 찾아본 뒤 어디를 봤는지 말하고 질문합니다. 비슷한 이름은 그 사람의 네임스페이스 범위 안에서만 찾습니다.
  - 읽기 도구 13종에는 다음이 들어 있습니다.
    - 이름 조각이나 레이블로 여러 종류와 네임스페이스를 한 번에 찾는 `k8s_find_resource`
    - API 스키마를 묻는 `k8s_explain`
    - 죽은 컨테이너의 직전 로그(`previous`), 기간, 전체 컨테이너, 텍스트 필터를 지원하는 Pod 로그
    - 객체·종류·`type=Warning`으로 좁히는 이벤트
  - 도구 블록 맨 위에는 **🔐 줄이 있어 클러스터가 그 호출을 누구로 봤는지** 보여 줍니다.
    - 사용자와 그룹은 클러스터에 실제로 보낸 impersonation 값이고, 보낸 서비스가 알려 준 그대로입니다(tool-server, 또는 k8s-service의 `X-Kubeast-Access` 헤더).
    - Kubeast 역할, 네임스페이스 범위, 읽기인지 쓰기인지도 함께 보입니다.
    - 같은 값이 그 호출의 감사 행(`after.access`)에 남으므로, 클러스터 감사 로그의 `impersonatedUser`와 맞춰 볼 수 있습니다.
    - impersonation이 꺼져 있으면(`auth.impersonation.enabled=false`) Kubeast 자체 자격 증명으로 실행됐다고 알립니다.
    - 알림 조사 보고서에는 어떤 신원으로 클러스터를 읽었는지 나옵니다.
  - 🔐 줄 아래 **🧾 Cluster requests**에는 그 호출이 보낸 쿠버네티스 요청이 나옵니다. 요청마다 Kubeast가 붙인 `Audit-ID`와 API 서버가 그 값을 돌려줬는지가 있어, 클러스터 감사 로그에서 그 호출을 찾을 수 있습니다([보안·감사](security-audit.md#클러스터-감사-로그에서-ai-도구-호출-찾기)).
    - Kubeast 자체 캐시로 답했으면 그렇게 표시하고, 클러스터에 보낸 요청은 없습니다.
    - kubectl 도구는 tool-server 안의 중계를 거쳐 클러스터에 닿고, 중계가 신원과 `Audit-ID`를 붙입니다. kubectl 자체의 탐색 요청은 목록에 넣지 않습니다.
  - Kubeast 기능을 쓰는 도구는 kubectl이 아니라 k8s-service API를 **그 사람 토큰으로** 부르므로, 권한·감사·마스킹이 화면과 같습니다. 이런 도구는 다음과 같습니다.
    - `issues` — 이슈 점검: 파드·워크로드·노드·PVC·경고 이벤트를 한 번에
    - `prometheus_query` — PromQL 즉시·범위 질의, 절대 시각 범위도 가능합니다.
      `chart=true`·제목·단위를 주면 결과를 **답 아래 그래프**로 그립니다(AI 채팅과 플로팅에 같은 그래프, 시리즈 최대 10개, "크게 보기", 저장된 답에도 보존).
    - `prometheus_metrics`·`prometheus_labels` — 질의 전에 지표 이름·타입·설명, 레이블 이름·값 찾기
    - `prometheus_rules` — 알림·기록 규칙과 지금 울리는 알림. 알림을 조사할 때 먼저 씁니다.
    - `prometheus_targets` — 수집 대상 up/down. 지표가 빌 때 씁니다. 여러 클러스터가 함께 쓰는 저장소이거나 targets API가 없으면 `up` 지표로 판단합니다.
    - `alerts_list` — 알림 저장소에 있는 이 클러스터의 알림(울림·무음·억제 상태)과 그 알림을 덮은 무음
    - `logsearch` — 로그 저장소 검색, 사라진 파드 포함
    - `loki_query` — LogQL. 로그 줄, 또는 `count_over_time`·`rate` 같은 메트릭 쿼리로 시간대별 에러 수 시리즈를 받고, 그래프로도 그립니다.
    - `loki_labels` — 로그 레이블 이름·값
    - `loki_patterns` — 로그 패턴, 에러 유형별 줄 수
    - `traces_search`·`traces_get`·`traces_tags`·`traces_metrics`·`traces_compare` — 트레이스 저장소에 TraceQL 질의
      - 느리거나 실패한 요청, 한 트레이스의 스팬, 속성 찾기, 요청 수·오류율·p95 추이 그래프, 빠른·느린 표본
    - `helm_read` — 릴리스 목록·values·manifest·이력·리소스·이미지·리비전·두 리비전 diff, **읽기 전용**
    - `policy_reports` — PolicyReport 요약·결과
    - `cost` — OpenCost 배분
    - `optimization` — requests 대비 사용량·권고
    - `can_i` — 그 사용자가 할 수 있는지 확인
    - `network_policy_check` — NetworkPolicy가 연결을 허용하는지와 그렇게 정한 정책·규칙([NetworkPolicy 보기와 연결 확인](#networkpolicy-보기와-연결-확인))
    - `network_flows` — 클러스터의 Hubble Relay가 본 네임스페이스·파드·워크로드의 최근 연결. 연결별로 합치고, 막힌 이유와 판정한 정책을 붙입니다([최근 흐름](#최근-흐름-hubble)).
    - `resource_graph` — 네임스페이스 객체와 그 연결
    - `hygiene` — 위생 보고, Admin
  - 다음 경우에는 그 도구가 도구 목록에서 빠집니다(`/api/v1/features`, 1분 캐시).
    - 그 클러스터에 기능이 없을 때: Prometheus 미설정, 로그·트레이스·알림 저장소 없음, 네트워크 흐름 꺼짐, 비용·정책 보고 꺼짐
    - 그 사람에게 k8s-service가 확인하는 권한(`admin.hygiene.read`·`resource.helm.read`·`resource.policyreport.read`·`resource.cost.read`·`resource.networkflow.read`)이 없을 때
  - 결과가 길면 시리즈 100개, 점 120개, 로그 200줄, 행 200개, 그래프 노드 200개/엣지 400개, 텍스트 64 KB에서 자릅니다.
  - 범위 질의 결과(`prometheus_query`·`loki_query` 지표 질의)가 모델이 한 번에 읽는 길이(6,000자)를 넘으면, 자르는 대신 값이 큰 시리즈 10개의 최저·최고·평균·마지막 값과 12점 개요로 줄여서 줍니다.
    그래프로 그린 결과도 같은 요약을 씁니다.
  - `gitops_status`는 Argo CD Application CR을 그 사람 권한으로 읽어 sync, health, 마지막 operation, 오류 조건, OutOfSync 리소스를 앱별로 정리합니다.
    Argo CD가 없는 클러스터에서는 unavailable을 돌려주고, 중앙 Argo CD를 쓴다면 관리 클러스터에서 물어야 합니다.
  - Admin 전용 도구는 다음과 같습니다.
    - `audit_search` — auth-service의 감사 로그 API를 읽습니다(`admin.audit.read`, 읽기 자체도 감사 대상).
    - `nodes_stats_summary`·`nodes_log` — kubelet의 stats summary와 로그 질의를 API 서버 프록시로 읽습니다(`admin.nodes.read` + 클러스터 RBAC `nodes/proxy`).
      로그 질의는 kubelet의 `enableSystemLogQuery`가 켜져 있어야 하며, 꺼져 있으면 unavailable로 답합니다.
  - 큰 목록은 다음 도구로 줄여 받습니다.
    - `k8s_jq_query` — `kubectl get -o json`을 jq로 걸러 필요한 필드만, 환경·파일 접근 없음, 5초 상한
    - `k8s_tabular_query` — 고른 열만 표로
    - `k8s_count` — 개수, 그룹별 개수
  - 쓰기 전에는 `k8s_diff`로 바뀔 내용을 먼저 보여 줍니다. 서버 dry-run 결과를 라이브 객체와 비교한 diff이며 **실제로 적용하지 않고**, 쓰기 권한이 있는 사용자에게만 보입니다.
- **플로팅 AI 위젯(AI Chat)** — 모든 페이지에 떠 있는 위젯이 **현재 화면 컨텍스트**(보고 있는 리소스)를 이해하고 답합니다.
  - 답할 때는 read-only 툴만 씁니다.
  - 첫 글자가 나오기 전에는 대기 점이, 끝난 답 옆에는 작은 복사 아이콘이 보이고 토큰 줄은 없습니다. 넓은 표는 상자 안에서 스크롤되고 머리 줄은 고정됩니다.
  - 위젯은 모달 위에도 떠 있어서 열린 창을 보면서 물을 수 있고, 1348px 이상 화면에서는 오른쪽 상세 드로어가 열리면 드로어 왼쪽으로 비켜납니다.
  - 위젯 안에서 Esc를 누르면 위젯만 닫힙니다.
  - 목록 화면은 비어 있어도 "0개"를 넘기고, 불러오는 중에는 넘기지 않습니다.
  - 정보를 보여 주는 창은 그 내용을 넘깁니다.
    - 대시보드 목록·문제·최적화·스토리지
    - Cluster View 파드
    - Helm 리비전·테스트·업그레이드 미리보기
    - 알림 조사 보고서
  - 생성·확인 창은 "무슨 작업 + 대상"만 넘깁니다. 관리자 메뉴(클러스터 정리·알림 조사는 예외)와 내 계정 화면은 아무것도 넘기지 않습니다.
  - 대화는 브라우저 탭마다 하나이고 새로고침해도 이어집니다. 입력칸 왼쪽의 "+"를 누르면 새 대화가 시작되고 이전 대화는 AI Chat 목록에 남습니다. 로그아웃하면 대화가 비워집니다.
- **리소스 최적화 제안** — 네임스페이스 관측값(requests/limits·사용량) 표 + AI 제안 스트리밍 + 행마다 **재시작 없이 적용**(Pod `resize` 하위 리소스, Kubernetes 1.35+, `features.inPlaceResize`).
  Pod 드로어의 컨테이너 카드에서도 값을 직접 넣어 같은 방식으로 조정할 수 있습니다.
- **비용(OpenCost)** — 클러스터 안의 OpenCost를 Prometheus와 같은 방식으로 찾습니다(이름에 `opencost`가 든 9003 Service, API 서버 프록시).
  Namespace별·워크로드별 비용 표(Cost 메뉴)와 최적화 표의 **월 비용·월 절약** 열을 보여 줍니다(`features.cost`).
  권한은 `resource.cost.read`이고, Namespace 범위로 부여받았다면 그 Namespace만 봅니다.
- **정책 보고서(Policy Reports)** — Kyverno·Trivy Operator 등이 쓰는 `wgpolicyk8s.io` PolicyReport/ClusterPolicyReport를 읽어 보여 줍니다(`features.policyReports`).
  - Security → Policy Reports: 정책별·Namespace별 pass/fail/warn/error/skip과 결과 행
  - 워크로드·Pod 드로어: "Policy violations" 절
  - CRD가 없으면 "설치되어 있지 않습니다"가 나옵니다.
  - 권한은 `resource.policyreport.read`이고, Namespace 범위로 부여받았다면 그 Namespace만 봅니다.
- **AI 에이전트 연결(MCP 서버)** — Claude Code·Cursor가 kubeconfig 대신 API 키로 연결해 같은 읽기 도구를
  **그 사람 권한으로만**, 마스킹·감사를 거쳐 씁니다(기본 꺼짐). 운영자가 켜면(`mcp.writeTools`) 상한이 Write인 키는 쓰기 도구와
  접근 요청 도구도 씁니다. 승인 카드 없이 그 사람 권한(영구·임시)을 그대로 쓰며, Argo CD 가드와 감사는 똑같이 적용됩니다.
- **모델 설정** — `ModelConfig` CRD와 DB로 관리하고, Admin UI에서 추가하고 테스트합니다.
  등급(`tier`, CRD `spec.tier`)이 `economy`인 설정을 켜 두면 채팅 이력 요약과 플로팅 어시스턴트는 보통 더 싼 그 모델을 쓰고, 채팅은 기본 모델을 그대로 씁니다.
  어느 쪽인지는 스트림의 `model_info.tier`로 알 수 있습니다. economy 설정이 없거나 키가 없어 쓸 수 없으면 둘 다 기본 모델을 씁니다.

## 🌐 멀티클러스터 & RBAC

- **클러스터 레지스트리** — in-cluster(self) + 외부 클러스터(kubeconfig) 등록/검증/헬스체크
- **클러스터별 RBAC** — 사용자×클러스터마다 역할 부여, **deny-by-default**
  (권한이 없는 클러스터는 목록에도 보이지 않습니다)
- **부하/장애 격리** — 클러스터별 클라이언트 풀(LRU) · 서킷 브레이커 · 헬스체크 ·
  rate limit · Prometheus 쿼리 캐시
- **클러스터 스위처** — UI 상단에서 전환, 탭별 독립(URL 쿼리 기반)
- **커스텀 역할** — 리소스 단위 권한(`resource.*.read/create/edit/delete`),
  메뉴 가시성(`menu.*`), AI 툴(`ai.tool.*`)

### 역할과 권한 — 기본 역할이 무엇을 할 수 있고, 클러스터에는 누구로 가나

| Kubeast 역할 | 어디에 주나 | 앱 권한 | 클러스터 안 신원(impersonation 그룹) |
| --- | --- | --- | --- |
| **Pending** | 가입·SSO 직후 기본값 | 없음 — 로그인은 되지만 API는 403 | — |
| **Member** | 계정 등급 | 전역 권한 없음, **클러스터별 부여로만** 접근 | `kubeast:authenticated`(권한 없음) |
| **Read** | 클러스터별 | 메뉴 10개 · 모든 리소스 읽기(`resource.*.read`, 비용 `resource.cost.read` 포함) · Helm 읽기(권한 키는 있지만 Release 기록이 Secret이라 클러스터가 거부 — 오른쪽 칸 참고) · 컨테이너 안 로그 파일 읽기(`resource.pod.logfile`, 기능을 켰을 때) · AI 채팅의 읽기 도구 41종(`ai.tool.<읽기 도구>`)과 MCP 연결(`ai.mcp.use`) — 쓰기 도구는 없음 | `kubeast:viewer` = `view` + `kubeast:cluster-reader`. `view`는 Secret과 `services/proxy`를 제외하므로, Secret과 Helm 릴리스(Secret에 저장)는 클러스터가 거부하고 화면에는 권한 안내가 뜹니다. API 서버 프록시로 읽는 Prometheus·OpenCost(최적화 사용량·스토리지 분석·비용·드로어 메트릭)는 차트 값 `auth.impersonation.viewerProxyServices`에 적은 Service만 **GET으로** 열립니다. 허용은 그 Namespace의 Role로 주고, 이름은 정확히 `<service>:<port>`로 적으며, 다른 Service·POST·NS 범위 부여는 계속 거부됩니다([설정](configuration.md)의 values 주석). 적지 않으면 거부됩니다(프록시는 `kubeast:operator`=`edit`부터 허용) |
| **Write** | 클러스터별 | `menu.*` · 리소스 생성/수정/삭제 · CronJob suspend/trigger · Secret 값 보기 · 로그 파일 읽기 · Helm rollback/upgrade/test · AI 툴 전부(`ai.tool.*`, 쓰기 도구 포함) · MCP 연결 | `kubeast:operator` = `edit` + viewer |
| **Admin** | 계정 등급(`*`) 또는 클러스터별 | 전부 — 관리자 메뉴, 모든 클러스터(나중에 등록한 것 포함) | `kubeast:admin` = `cluster-admin` |
| 커스텀 | 클러스터별 | 고른 권한만(만드는 사람이 가진 권한 안에서) | `kubeast:role:<이름>` — 클러스터가 이 그룹을 바인딩하기 전에는 모든 호출이 403입니다(`auth.impersonation.customRoles`). 화면의 권한 없음 배너와 역할 만들기 창에 이 그룹 이름이 나옵니다 |

- **Admin만 되는 것**: Pod exec · Node shell · cordon/drain · 워크로드 rollback · Helm uninstall.
  `resource.pod.exec`·`resource.node.cordon/drain/shell`·`resource.workload.rollback`·`resource.helm.uninstall`은 Write에 없으므로, 필요하면 커스텀 역할에 넣으세요.
  - 클러스터 쪽에서 보면 기본 `edit` ClusterRole에 `pods/exec`가 들어 있으므로, Write 그룹(`kubeast:operator`)은 원래 모든 네임스페이스에서 exec할 수 있습니다.
    Pod exec가 Admin 전용인 이유는 Kubeast의 앱 권한 때문입니다. 그래서 Kubeast의 impersonation 자격 증명(`kubeast-impersonator`)은 그 그룹들의 전체 권한만큼 중요하게 지켜야 합니다.
  - 로그 파일 보기(`features.logFiles`, 기본 off)는 Kubeast가 명령을 `ls`·`tail`로 고정하므로 Read와 Write도 쓸 수 있습니다.
    이를 위해 차트는 적어 둔 네임스페이스에서만 Read 그룹(`kubeast:viewer`)에 `pods/exec`를 바인딩합니다([컨테이너 안 로그 파일](operations.md#컨테이너-안-로그-파일-log-files)).
- **쓰기 API는 전부** 핸들러에서 권한을 검사하며, 감사 행을 남기지 못하면 거부됩니다(fail-closed).
  - **읽기 API**는 "그 클러스터에 역할이 있는가"(클러스터 미들웨어, deny-by-default)와 클러스터의 RBAC(viewer 그룹), 두 단계로 막습니다.
  - `menu.*`는 화면 메뉴만 가리며, 사이드바 그룹마다 하나씩 있습니다. 기본 역할에는 `menu.*`가 있으므로 커스텀 역할에서만 그룹이 빠집니다.
    - Core(대시보드·Cluster View·Monitoring·Alerts·Cost·AI Chat·Resource Graph·Change History·Advanced Search)는 `menu.dashboard`입니다. Alerts·Cost·AI Chat은 그 기능을 켰을 때만 나타납니다.
    - Cluster와 Custom Resources는 `menu.cluster`입니다.
    - Workloads·Storage·Network·Gateway·GPU·Security·Configuration·Helm은 같은 이름의 키를 따릅니다.
    - Admin은 관리자인지로 정해집니다.
- **대시보드 개수**(네임스페이스·파드·노드 …)는 클러스터별 informer 캐시(`kubeast:cache` 신원)에서 셉니다.
  그래서 사용자 신원이 네임스페이스를 list할 수 있는지(SelfSubjectAccessReview, 60초 캐시) 먼저 묻고, 안 되면 403을 돌려줍니다.
  그룹이 아직 바인딩되지 않은 커스텀 역할이나 네임스페이스 하나에만 묶인 사용자가 클러스터 전체 개수를 보지 못하게 하기 위해서입니다.
- **YAML 생성·편집**은 문서마다 그 Kind의 `resource.<이름>.create`(편집은 대상의 `resource.<이름>.edit`)를 확인합니다.
  - 이름은 Kind의 소문자 형태이고, 자기 이름이 없는 Kind(CR 등)는 `customresource`를 씁니다.
    단, HorizontalPodAutoscaler·VerticalPodAutoscaler·PodDisruptionBudget·PersistentVolume·PersistentVolumeClaim·CustomResourceDefinition은 `hpa`·`vpa`·`pdb`·`pv`·`pvc`·`crd`를 씁니다.
  - Write 그룹의 `edit`는 클러스터 범위 객체(Namespace·ClusterRole·StorageClass 등)를 만들 수 없어 클러스터가 거부합니다.
    그래서 그 화면들(클러스터 범위 15종 + Role·RoleBinding)의 생성 버튼은 앱 권한에 더해 클러스터에도 직접 묻습니다(`GET /api/v1/cluster/can-i?verb=create&group=&resource=`, 사용자 신원의 SelfSubjectAccessReview = `kubectl auth can-i`).
  - 클러스터가 안 된다고 답하면 버튼을 보여 주지 않습니다.
- **네임스페이스 범위 부여**: 클러스터별 역할을 네임스페이스 목록(최대 50개)으로 한정할 수 있습니다.
  목록은 사용자 상세의 역할 옆 칸이나 클러스터 접근 창에 적고, 비우면 클러스터 전체입니다. 부여 API는 이 목록을 `namespaces`로 받아 `/auth/me`(`cluster_namespaces`)와 토큰(`ns` 클레임)에 싣습니다.
  - 접근 요청에도 목록을 넣을 수 있고, 범위가 정해진 부여를 받은 사람은 그 안에서만 요청할 수 있습니다(폼에 미리 채워지며 필수).
  - 이런 부여에서는 Kubeast가 클러스터에 묻기 전에 **그 네임스페이스 밖의 경로를 403으로 거릅니다**(쓰기는 감사 행을 남김).
    - 네임스페이스 목록은 부여 목록 그대로 보여 줍니다.
    - "전체 네임스페이스" 조회는 목록의 네임스페이스를 하나씩 조회해 합칩니다.
    - 대시보드 개수도 그 안에서만 셉니다(`scoped: true`, 노드·PV는 0).
  - AI 도구와 MCP는 `namespace`를 반드시 받으며, 클러스터 전체 도구(overview·노드 메트릭·apply·create·API 목록·클러스터 설정)는 거부합니다.
  - 클러스터 쪽 신원은 `kubeast:role:<slug>` 그룹이므로 **그 네임스페이스마다 RoleBinding을 묶기 전에는 클러스터가 거부합니다**.
    차트 `auth.impersonation.customRoles`에 `{name: Read, namespaces: [a, b], clusterRoles: [view]}`처럼 적으면 그 RoleBinding이 렌더됩니다(등록한 클러스터마다 적용하세요).
  - 화면에서는 네임스페이스 선택기에 부여된 네임스페이스만 보이고, 권한 없음 안내에 "이 클러스터에서는 네임스페이스 a, b만"이 붙으며, 실시간 갱신도 네임스페이스별로 구독합니다.
  - Access Review 보고서와 CSV에 `namespaces` 열이 있습니다.
- **SSO 그룹 → 역할**: OIDC 공급자가 주는 그룹을 다음과 같이 역할로 바꿉니다. `syncRoles`를 켜면 로그인할 때마다 다시 맞춥니다.
  - 계정 등급: `auth.oidc.roleMapping`(`<그룹>=<Admin|Member|커스텀>`)
  - 클러스터별 부여: 그룹 이름 `<clusterGroupPrefix><클러스터>:<역할>`
  - 이름을 정할 수 없는 그룹(Google 그룹 이메일·Entra 그룹 ID)의 클러스터별 부여: `auth.oidc.clusterGroupMapping`(`<그룹>=<클러스터>:<역할>`)
  - **Google 로그인은 ID 토큰에 그룹이 없으므로**, `auth.oidc.googleGroups`를 켜면 로그인할 때 Admin SDK Directory API로 그 사람의 Workspace 그룹을 읽어 매핑에 걸리는 그룹만 더합니다.
    회사 그룹 전체를 감사 행에 남기지는 않습니다.
  - 서비스 계정에는 Workspace 관리자 역할 **Groups Reader**를 줍니다. 도메인 전체 위임은 쓰지 않고, 대신 요청에 `domain`이 붙습니다.
    자격 증명은 Secret의 `credentials.json` 하나로, 키 없는 Workload Identity Federation 설정 파일(`external_account`, 이 클러스터 토큰이면 `tokenAudience`) 또는 서비스 계정 키입니다.
    조회가 실패하면 지금 역할을 그대로 두고 로그인 감사 행에 `groups_lookup: failed`를 남깁니다.
  - 관리자는 `GET /api/v1/auth/admin/oidc/groups?email=`로 그 사람의 매핑 결과를 미리 볼 수 있습니다(매핑된 그룹 이름 + 나머지 개수, 감사 `admin.oidc.groups.read`).
  - 공급자별 설정 순서(Keycloak·Google·Entra ID·Okta), 첫 관리자, 로그인 실패 코드는 [docs/ko/oidc.md](oidc.md)를 보세요.
- `auth.impersonation.enabled=false`는 데모용입니다. k8s-service는 `cluster-admin`, tool-server는 `*` 권한으로 돌고, 읽기 API는 클러스터 부여만으로 열립니다.
- **목록이 비었을 때 화면에 나오는 문구**는 다음과 같습니다.
  - 권한이 없으면(403): "볼 권한이 없습니다"(위쪽 배너 + 표)
  - 서버 오류나 응답 없음: "불러오지 못했습니다(서버 오류 503)"와 다시 시도
  - 클러스터에 그 CRD가 없으면(Gateway API·VPA): "설치되어 있지 않습니다"
    - k8s-service가 discovery로 확인해 빈 목록에 `X-Kubeast-Not-Installed` 헤더를 붙입니다. 역할과 상관없이 같은 답이고, 생성 버튼은 없습니다.
  - 그 밖의 경우: "없습니다"
  - 없는 주소는 404 화면을 보여 줍니다.
- 회귀 확인용 스펙
  - `e2e/tests/rbac-matrix.spec.ts`(역할 × 동작 403/200 표)
  - `permission-ceiling.spec.ts`(남에게 자기 이상 못 줌)
  - `reader-ui-notices.spec.ts`(Read의 화면 안내)
  - `notices.spec.ts`(서버 오류·설치 안 됨·404·생성 버튼 can-i·권한 요청 안내)

## ☸️ Kubernetes 리소스 관리

| 도메인 | 리소스 |
| --- | --- |
| **Workloads** | Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob, HPA, VPA, PDB |
| **Network** | Service, Endpoint(1.33부터 폐기된 API — 객체 화면은 남기고, Service 상세·리소스 그래프·AI 서비스 점검은 EndpointSlice를 읽음), EndpointSlice, Ingress, IngressClass, NetworkPolicy |
| **Gateway API** | Gateway, GatewayClass, HTTPRoute, GRPCRoute, ReferenceGrant, BackendTLSPolicy, Policies(모든 구현체의 정책 한 화면 — `gateway.networking.k8s.io/policy` 라벨 CRD 자동 탐색 + Envoy Gateway·Istio 내장 + `gatewayApi.policyKinds`) |
| **Storage** | PV, PVC, StorageClass, VolumeAttachment |
| **Configuration** | ConfigMap, Secret, ResourceQuota, LimitRange, PriorityClass, RuntimeClass, Lease |
| **Security (RBAC)** | Role, ClusterRole, RoleBinding, ClusterRoleBinding, ServiceAccount · Policy Reports(`wgpolicyk8s.io` 보고서 모음, CRD 있을 때) |
| **Cluster** | Node, Namespace, Webhook Configuration(Mutating/Validating), Admission Policy(Validating/Mutating — `admissionregistration.k8s.io/v1`, 읽기 전용, API가 없으면 "설치 안 됨"; `features.admissionPolicies.readOnly: true`면 공용 YAML 적용과 AI 쓰기 도구도 정책·바인딩 4종을 거부하므로 Git으로만 바꿀 수 있습니다) |
| **Custom Resources** | CRD 동적 탐색 및 인스턴스 편집 |

- **YAML 편집** (Monaco), **Pod Exec / 로그** (xterm.js, WebSocket)
- **실시간 갱신** — WebSocket 멀티플렉서로 리소스 변경 스트리밍

### NetworkPolicy 보기와 연결 확인

Pod·워크로드 드로어에 "NetworkPolicy" 칸이 있습니다.

- 파드를 고르는 NetworkPolicy를 들어오는 연결·나가는 연결별로, 규칙이 허용하는 것과 함께 보여 줍니다.
- "연결 확인"은 다른 파드·워크로드·Service·IP 주소와의 연결 하나를 NetworkPolicy가 허용하는지 묻습니다.
- 답은 허용·거부·알 수 없음이고, 그렇게 정한 정책·규칙이나 규칙마다 맞지 않은 이유가 함께 나옵니다.
- Service는 뒤에 있는 파드의 포트로 확인합니다. 이름으로 된 대상 포트는 파드마다 찾습니다.
- 알 수 없음은 다음 둘 중 하나입니다.
  - 네트워크 플러그인이 정하는 경우: 파드 IP를 포함하는 `ipBlock`(Calico·kindnet은 적용하고 Cilium은 적용하지 않음), hostNetwork 파드
  - 규칙이 네임스페이스를 레이블로 고르는데, 권한이 없어 Kubeast가 그 레이블을 읽지 못한 경우
- 출발 쪽 나가기 정책이 클러스터 DNS를 허용하지 않으면, Service 이름이 풀리지 않는다고 알려 줍니다(IP로는 됩니다).
- Kubernetes NetworkPolicy만 평가합니다. 그 네임스페이스의 Cilium·Calico·network-policy-api 정책은 답에 들어가지 않는다고 따로 보여 줍니다.
- 모든 읽기는 로그인한 사람의 권한으로 하며, 네임스페이스가 정해진 사용자는 자기 네임스페이스 안의 연결만 확인할 수 있습니다.
- AI 도구 `network_policy_check`도 같은 답을 줍니다.
- 평가기(`services/pkg/netpol`)는 외부 의존이 없습니다. 시험에서 자동으로 만든 정책으로 np-guard/netpol-analyzer와 대조하고(`services/netpol-oracle`), e2e에서는 kind의 kindnet에서 실제 접속과 대조합니다.
- 대상 클러스터에 필요한 것은 [클러스터 요구사항 §7](cluster-requirements.md#7-있으면-보여-주는-api)에 있습니다.

### 최근 흐름 (Hubble)

클러스터에 `features.networkFlows`를 켜면 Pod·워크로드 드로어에 "최근 흐름" 칸도 생깁니다.

- 클러스터의 Hubble Relay가 본 그 파드·워크로드의 들어오고 나간 연결을 보여 줍니다.
  - 칸: 판정, 방향, 상대, 포트, 횟수, 마지막으로 본 시각, 막힌 이유 또는 판정한 정책
- 흐름 읽기는 감사 로그(`k8s.networkflows.query`)에 남으므로 "흐름 보기"를 눌러야 읽습니다.
  - 범위는 최근 5분·15분·1시간 중에서 고르고, 막힌 것만 볼 수도 있습니다.
- 한 줄은 연결 하나입니다. 응답 패킷은 그 연결에 합치고, 양쪽 노드에서 본 연결도 한 번만 나옵니다.
- 막힌 연결의 "왜?"를 누르면 위의 NetworkPolicy 연결 확인이 그 상대·포트·방향으로 열려, 막은 규칙을 알려 줍니다.
- Relay는 로그인한 사람의 권한으로 읽습니다. 읽는 길은 클러스터 API 서버의 서비스 프록시(`proxy`, 기본값)나 TLS 주소(`https://`)입니다.
  - 클러스터가 그 사람에게 Relay Service의 `services/proxy` create를 허용해야 합니다. `templates/impersonation-viewer-hubble.yaml`이 Read 그룹에 이 권한을 줍니다.
- 네임스페이스가 정해진 사용자에게는 자기 네임스페이스 밖의 상대가 네임스페이스와 주소로만 보이고, URL의 쿼리 문자열은 지웁니다.
- AI 도구 `network_flows`도 같은 연결을 읽고, 막힌 연결이면 `network_policy_check`로 이어 보라고 알려 줍니다.
- 대상 클러스터에 필요한 것은 [클러스터 요구사항 §16](cluster-requirements.md#16-hubble-relay-네트워크-흐름)에 있습니다.

## ⎈ Helm 릴리스 관리

- 릴리스 목록 / 상세 / 히스토리 / values / 매니페스트 / 리소스 보기
- **Rollback · Upgrade · Uninstall · Test** (모두 dry-run 미리보기 + 확인 후 실행)

## 🎮 GPU & DRA (Dynamic Resource Allocation)

- GPU 노드 / Pod / 사용률 대시보드, NVIDIA GPU 메트릭
- DeviceClass, ResourceClaim, ResourceClaimTemplate, ResourceSlice 관리

## 📊 관측성 (Observability)

- **Topology View** — 클러스터 리소스 관계 시각화 (React Flow / dagre / elkjs)
- **Dependency Graph** — 워크로드 간 의존성 그래프
- **Monitoring** — Prometheus 시계열 차트, 이상 감지, 상관 분석, GPU 심층 메트릭 (대상 클러스터에 있어야 하는 Prometheus·지표는 [docs/ko/cluster-requirements.md §3](cluster-requirements.md#3-prometheus))
- **Node Shell** — 웹 기반 노드 터미널
- **로그 파일** — 로그를 파일로 쓰는 앱의 컨테이너 안 로그를 허용된 경로에서만 읽고 따라가기(고정 `tail`, 기본 off, [자세히](operations.md#컨테이너-안-로그-파일-log-files))
- **로그 검색** — 재시작·삭제된 파드의 로그까지 Loki에서 텍스트·기간으로 찾기, 클러스터 RBAC(`pods/log`) 기준(기본 off, [자세히](operations.md#로그-검색-loki))
- **Advanced Search** — 표현식 기반 전역 리소스 탐색

## 🔐 인증 · 감사

- JWT 기반 자체 인증(JWKS) — 조직(Organization) / 팀(Team) / 사용자 계층
- **API 키** — 스크립트·CI용 자격 증명(Settings → API keys). 키는 짧은 액세스 토큰으로 교환해 쓰고, 클러스터 범위·역할 상한·만료가 있으며, 발급자의 권한을 넘지 못합니다([API 키](security-audit.md#api-키-자동화))
- **감사 로그** — 모든 쓰기 작업 + 민감 조회(Secret 열람, Node Shell, 컨테이너 로그 파일 열람, 로그 검색, Helm 변경 등)를
  기록하고, 성공과 실패를 모두 추적합니다
- **클러스터 위생 점검** — Pod Security Standards, 이미지 태그, 리소스, Namespace 정책, RBAC, TLS 만료를 보는 사람의 권한으로 읽어 한 장에 모읍니다.
  CSV/JSON으로 내보내고 클러스터별로 월간 서명을 남길 수 있습니다(Admin → Cluster hygiene, [자세히](operations.md#클러스터-위생-점검-cluster-hygiene)).
- **AI 사용량** — 채팅 턴과 Optimization의 AI 설명마다 남는 `ai.chat.complete` 감사 행(제공자가 보낸 토큰 수를 턴 단위로 합산)을 사용자·모델·클러스터별로 집계합니다(Admin → AI Usage).
  - 한도는 없고, 누가 얼마나 썼는지 보여 줍니다. 제공자가 usage를 보내지 않은 호출은 합계에서 빼고 건수로 따로 표시합니다.
  - 입력 토큰 옆의 **캐시 적중**은 제공자가 캐시에서 내준 입력 토큰(Anthropic `cache_read_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`)과 그 비율입니다.
  - 입력 토큰 칸의 툴팁은 ai-service가 실제로 보낸 프롬프트의 평균 크기(시스템·도구 정의·이력·메시지의 JSON 문자 수, `prompt_chars`)입니다.
    제공자 집계와 상관없이 이력 창·요약·도구 설명을 바꾼 효과를 보는 지표입니다.
  - 같은 행의 합계로 **채팅 토큰 예산**을 걸 수 있습니다(기본 0 = 끔).
    - `ai.chat.budget.sessionTokens` — 세션 누적
    - `ai.chat.budget.userDailyTokens` — 사용자별 UTC 하루 누적
    - 예산을 넘으면 그 턴은 모델을 호출하지 않고 거부되며, 채팅에 안내가 뜨고 `ai.chat.budget_exceeded`로 감사 로그에 남습니다. 사용량 기준은 이 화면과 같습니다.
    - Optimization AI 설명도 사용자 하루 예산을 넘으면 관측 표만 보여 주고 모델은 부르지 않습니다.
  - 모델 공급자가 요청을 거절하면 채팅·플로팅·Optimization이 그 이유를 **종류별로** 화면 언어로 알려 주고, 공급자 이름과 원문(마스킹)도 함께 보여 줍니다(`app/services/ai/model_errors.py`).
    - 크레딧·한도 소진(OpenAI `insufficient_quota`, Claude API `billing_error`·지출 한도, Gemini 402)
    - 너무 잦은 요청(429)
    - 키·토큰 거부(401·403)
    - 공급자 과부하·장애(5xx·529·시간 초과)
    - 구독 사용량 한도(풀리는 시각과 함께)
- **i18n** — 한국어 · 영어. Kubernetes 리소스 종류(`StatefulSet`, `ConfigMap`, `Namespace` …)와 화면 이름(사이드바 항목·페이지 제목)은 두 언어 모두 영어로, 동사·설명·안내문만 번역합니다(예: "StatefulSet 생성", "전체 Namespace")
