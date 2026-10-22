# 기능 한눈에


## 🤖 AI 어시스턴트

- **다중 LLM 지원** — OpenAI · Anthropic · Gemini · Ollama 등 (OpenAI 호환 어댑터로 통합, Anthropic은 Messages API)
- **스트리밍 채팅** — SSE 기반 실시간 응답, 세션/히스토리 보존. 모델에는 최근 `ai.chat.historyMessages`(기본 10)개의 user/assistant 메시지가 그대로 가고, 그 앞의 대화는 같은 모델이 밀려난 턴마다 적은 메모를 덧붙인 **요약 하나**(`ai.chat.summary.enabled`, 기본 켬; 마스킹·`maxChars` 상한, 넘으면 오래된 메모를 합침)로 접혀 세션 컨텍스트에 남는다 — 긴 대화도 앞부분 사실을 잃지 않으면서 프롬프트가 커지지 않음.
  - 요약은 창 밖으로 새 메시지가 밀릴 때만 증분 갱신되고 `ai.chat.summarize`로 감사됨.
  - 답마다 아래에 그 턴의 토큰("입력 · 출력 · 캐시 %", 툴팁에 모델 호출 수·모델)이 보이며, 메시지에 저장돼(`messages.usage`, 그 턴 `ai.chat.complete`와 같은 값) 새로고침 뒤에도 남음.
  - 그 줄(토큰·Copy)은 답이 나오는 동안 닫혀 있다가 끝나거나 멈추면 열리고 서서히 나타남(운영체제의 움직임 줄이기면 바로).
  - 멈춘 답은 그때까지의 글이 "멈춤 · 사용량을 표시할 수 없음" 표시와 함께 저장됨(session-service가 표식 `{"stopped": true}`만 받음).
  - 대화는 맨 아래에 있을 때만 새 글을 따라가고, 위로 올리면 멈춘 채 "맨 아래로" 버튼이 뜸. 답의 표는 가로·세로 선, 답 옆엔 Kubeast 아이콘
- **다중 라운드 Tool Calling** — AI가 화이트리스트 툴로 K8s를 조회·변경(최대 10라운드).
  읽기/쓰기/관리 툴은 **사용자 권한(JWT)에 따라 게이팅**. 읽기 도구 13종에는 이름 조각·레이블로 여러 종류·네임스페이스를 한 번에 찾는 `k8s_find_resource`, API 스키마를 묻는 `k8s_explain`, 죽은 컨테이너의 직전 로그(`previous`)·기간·전체 컨테이너·텍스트 필터가 있는 Pod 로그, 객체·종류·`type=Warning`으로 좁히는 이벤트가 들어 있다.
  없는 이름·없는 종류·없는 기능(metrics-server 등)은 kubectl 오류 대신 **`not_found`(비슷한 이름 목록 포함)·`unknown_kind`·`unavailable` 결과**로 돌아와, AI가 네임스페이스를 바꿔 가며 되묻지 않고 한 번 찾아본 뒤 어디를 봤는지 말하고 질문한다. 비슷한 이름은 그 사람의 네임스페이스 범위 안에서만 찾는다.
  - Kubeast 기능을 쓰는 도구 — `issues`(이슈 점검: 파드·워크로드·노드·PVC·경고 이벤트 한 번에), `prometheus_query`(PromQL 즉시·범위, 절대 시각 범위도 — `chart=true`·제목·단위를 주면 그 결과가 **답 아래 그래프**로: AI 채팅·플로팅 같은 그래프, 시리즈 최대 10, "크게 보기", 저장된 답에도 남음) · `prometheus_metrics`·`prometheus_labels`(지표 이름·타입·설명, 레이블 이름·값 찾기 — 질의 전에) · `prometheus_rules`(알림·기록 규칙과 지금 울리는 알림 — 알림 조사 때 먼저) · `prometheus_targets`(수집 대상 up/down — 지표가 빌 때; 여러 클러스터가 쓰는 저장소나 targets API가 없으면 `up` 지표로) · `alerts_list`(알림 저장소의 이 클러스터 알림 — 울림·무음·억제, 그 알림을 덮은 무음), `logsearch`(로그 저장소 검색, 사라진 파드도) · `loki_query`(LogQL — 줄, 또는 `count_over_time`·`rate` 같은 메트릭 쿼리로 시간대별 에러 수 시리즈, 그래프로도) · `loki_labels`(로그 레이블 이름·값) · `loki_patterns`(로그 패턴 — 에러 유형별 줄 수) · `traces_search`·`traces_get`·`traces_tags`·`traces_metrics`·`traces_compare`(트레이스 저장소에 TraceQL — 느리거나 실패한 요청, 한 트레이스의 스팬, 속성 찾기, 요청 수·오류율·p95 추이 그래프, 빠른·느린 표본), `helm_read`(릴리스 목록·values·manifest·이력·리소스·이미지·리비전·두 리비전 diff, **읽기만**), `policy_reports`(PolicyReport 요약·결과), `cost`(OpenCost 배분)·`optimization`(requests 대비 사용량·권고), `can_i`(그 사용자가 할 수 있는지), `resource_graph`(네임스페이스 객체와 연결), `hygiene`(위생 보고, Admin) — 는 kubectl이 아니라 k8s-service API를 **그 사람 토큰으로** 부르므로 권한·감사·마스킹이 화면과 같다.
  - 그 클러스터에 기능이 없거나(Prometheus 미설정, 로그·트레이스·알림 저장소 없음, 비용·정책 보고 꺼짐) 그 사람에게 k8s-service가 묻는 권한(`admin.hygiene.read`·`resource.helm.read`·`resource.policyreport.read`·`resource.cost.read`)이 없으면 도구 목록에서 빠진다(`/api/v1/features`, 1분 캐시).
  - 결과는 시리즈 100·점 120·로그 200줄·행 200·그래프 노드 200/엣지 400·텍스트 64 KB에서 자른다.
  - 기간 결과(`prometheus_query`·`loki_query` 지표 질의)가 모델이 한 번에 읽는 길이(6,000자)를 넘으면 잘라 주지 않고 값이 큰 시리즈 10개의 최저·최고·평균·마지막 값과 12점 개요로 줄여 준다(그래프로 그린 결과도 같은 요약).
  - `gitops_status`는 Argo CD Application CR를 그 사람 권한으로 읽어 sync·health·마지막 operation·오류 조건·OutOfSync 리소스를 앱별로 정리한다(Argo CD가 없는 클러스터면 unavailable — 중앙 Argo CD면 관리 클러스터에서).
  - Admin 전용 `audit_search`는 auth-service의 감사 로그 API(`admin.audit.read`, 읽기 자체도 감사됨)를, `nodes_stats_summary`·`nodes_log`는 kubelet의 stats summary와 로그 질의를 API 서버 프록시로(`admin.nodes.read` + 클러스터 RBAC `nodes/proxy`; 로그 질의는 kubelet `enableSystemLogQuery`가 켜져 있어야 하고, 꺼져 있으면 unavailable로 답한다) 읽는다.
  - 큰 목록은 `k8s_jq_query`(`kubectl get -o json`을 jq로 걸러 필요한 필드만, 환경·파일 접근 없음·5초 상한)·`k8s_tabular_query`(고른 열만 표)·`k8s_count`(개수·그룹별 개수)로 줄여 받고, 쓰기 전엔 `k8s_diff`(서버 dry-run 결과를 라이브 객체와 비교한 diff — **적용 없음**, 쓰기 권한 사용자에게만 보임)로 바뀔 내용을 먼저 보인다.
- **플로팅 AI 위젯(AI Chat)** — 모든 페이지에 떠 있는 위젯이 **현재 화면 컨텍스트(보고 있는 리소스)**
  - 를 이해하고 답변 (read-only 툴로 제한).
  - 첫 글자 전엔 대기 점, 끝난 답 옆엔 작은 복사 아이콘(토큰 줄은 없음), 넓은 표는 상자 안에서 스크롤되고 머리 줄 고정. 모달 위에도 떠서 열린 창을 보며 물을 수 있고, 오른쪽 상세 드로어가 열리면 드로어 왼쪽으로 비켜남(1348px 이상 화면).
  - 위젯 안에서 누른 Esc는 위젯만 닫음.
  - 목록 화면은 비어 있어도 "0개"를 넘김(불러오는 중엔 안 넘김).
  - 정보를 보여 주는 창(대시보드 목록·문제·최적화·스토리지, 클러스터 뷰 파드, Helm 리비전·테스트·업그레이드 미리보기, 알림 조사 보고서)은 그 내용을, 생성·확인 창은 "무슨 작업 + 대상"만 넘김. 관리자 메뉴(클러스터 정리·알림 조사는 예외)와 내 계정 화면은 아무것도 안 넘김. 대화는 브라우저 탭마다 하나(새로고침하면 이어짐) — 입력칸 왼쪽 "+"로 새 대화(이전 대화는 AI Chat 목록에 남음), 로그아웃하면 비워짐
- **리소스 최적화 제안** — 네임스페이스 관측값(requests/limits·사용량) 표 + AI 제안 스트리밍 + 행마다 **재시작 없이 적용**(Pod `resize` 하위 리소스, Kubernetes 1.35+, `features.inPlaceResize`); Pod 드로어의 컨테이너 카드에서도 값을 직접 넣어 같은 방식으로 조정
- **비용(OpenCost)** — 클러스터 안의 OpenCost를 Prometheus처럼 찾아(이름에 `opencost`가 든 9003 Service, API 서버 프록시) Namespace별·워크로드별 비용 표(Cost 메뉴)와 최적화 표의 **월 비용·월 절약** 열을 보여 줌(`features.cost`). 권한 `resource.cost.read`, Namespace 범위 부여는 그 Namespace만
- **정책 보고서(Policy Reports)** — Kyverno·Trivy Operator 등이 쓰는 `wgpolicyk8s.io` PolicyReport/ClusterPolicyReport를 읽어 Security → Policy Reports에 정책별·Namespace별 pass/fail/warn/error/skip과 결과 행을, 워크로드·Pod 드로어에 "Policy violations" 절을 보여 줌(`features.policyReports`, CRD 없으면 "설치되어 있지 않습니다"). 권한 `resource.policyreport.read`, Namespace 범위 부여는 그 Namespace만
- **AI 에이전트 연결(MCP 서버)** — Claude Code·Cursor가 kubeconfig 대신 API 키로 연결해 같은 읽기 도구를
  **그 사람 권한으로만**, 마스킹·감사를 거쳐 사용(기본 꺼짐). 운영자가 켜면(`mcp.writeTools`) 상한이 Write인 키에 쓰기 도구와
  접근 요청 도구도 — 승인 카드 없이 그 사람 권한(영구·임시) 그대로, Argo CD 가드·감사 동일
- **모델 설정** — `ModelConfig` CRD + DB로 관리, Admin UI에서 추가/테스트. 등급(`tier`, CRD `spec.tier`)이 `economy`인 설정을 켜 두면 채팅 이력 요약과 플로팅 어시스턴트가 그 (보통 더 싼) 모델을 쓰고 채팅은 기본 모델 그대로 — 스트림의 `model_info.tier`로 어느 쪽인지 보임. economy 설정이 없거나 키가 없어 못 쓰면 둘 다 기본 모델

## 🌐 멀티클러스터 & RBAC

- **클러스터 레지스트리** — in-cluster(self) + 외부 클러스터(kubeconfig) 등록/검증/헬스체크
- **클러스터별 RBAC** — 사용자×클러스터마다 역할 부여, **deny-by-default**
  (권한 없는 클러스터는 목록에도 안 보임)
- **부하/장애 격리** — 클러스터별 클라이언트 풀(LRU) · 서킷 브레이커 · 헬스체크 ·
  rate limit · Prometheus 쿼리 캐시
- **클러스터 스위처** — UI 상단에서 전환, 탭별 독립(URL 쿼리 기반)
- **커스텀 역할** — 리소스 단위 권한(`resource.*.read/create/edit/delete`),
  메뉴 가시성(`menu.*`), AI 툴(`ai.tool.*`)

### 역할과 권한 — 기본 역할이 무엇을 할 수 있고, 클러스터에는 누구로 가나

| Kubeast 역할 | 어디에 주나 | 앱 권한 | 클러스터 안 신원(impersonation 그룹) |
| --- | --- | --- | --- |
| **Pending** | 가입·SSO 직후 기본값 | 없음 — 로그인만 되고 API는 403 | — |
| **Member** | 계정 등급 | 전역 권한 없음, **클러스터별 부여로만** 접근 | `kubeast:authenticated`(권한 없음) |
| **Read** | 클러스터별 | 메뉴 10 · 모든 리소스 읽기(`resource.*.read`, 비용 `resource.cost.read` 포함) · Helm 읽기(권한 키는 있지만 Release 기록이 Secret이라 클러스터가 거부 — 오른쪽) · 컨테이너 안 로그 파일 읽기(`resource.pod.logfile`, 기능을 켰을 때) · AI 채팅의 읽기 도구 39종(`ai.tool.<읽기 도구>`)과 MCP 연결(`ai.mcp.use`) — 쓰기 도구는 없음 | `kubeast:viewer` = `view` + `kubeast:cluster-reader`. `view`는 Secret과 `services/proxy`를 제외하므로 Secret과 Helm 릴리스(Secret에 저장)는 클러스터가 거부하고 화면은 권한 안내를 띄운다. API 서버 프록시로 읽는 Prometheus·OpenCost(최적화 사용량·스토리지 분석·비용·드로어 메트릭)는 차트 값 `auth.impersonation.viewerProxyServices`에 적은 Service만 **GET으로** 열린다 — 그 Namespace의 Role, 이름은 정확히 `<service>:<port>`, 다른 Service·POST·NS 범위 부여는 계속 거부([설정](configuration.md)의 values 주석). 적지 않으면 거부(프록시는 `kubeast:operator`=`edit`부터) |
| **Write** | 클러스터별 | `menu.*` · 리소스 생성/수정/삭제 · CronJob suspend/trigger · Secret 값 보기 · 로그 파일 읽기 · Helm rollback/upgrade/test · AI 툴 전부(`ai.tool.*`, 쓰기 도구 포함) · MCP 연결 | `kubeast:operator` = `edit` + viewer |
| **Admin** | 계정 등급(`*`) 또는 클러스터별 | 전부 — 관리자 메뉴, 모든 클러스터(나중에 등록한 것 포함) | `kubeast:admin` = `cluster-admin` |
| 커스텀 | 클러스터별 | 고른 권한만(만드는 사람이 가진 권한 안에서) | `kubeast:role:<이름>` — 클러스터가 이 그룹을 바인딩하기 전엔 모든 호출이 403(`auth.impersonation.customRoles`). 화면의 권한 없음 배너와 역할 만들기 창이 이 그룹 이름을 보여 준다 |

- **Admin만 되는 것**: Pod exec · Node shell · cordon/drain · 워크로드 rollback · Helm uninstall. `resource.pod.exec`·`resource.node.cordon/drain/shell`·`resource.workload.rollback`·`resource.helm.uninstall`은 Write에 없고, 필요하면 커스텀 역할에 넣는다.
  - 클러스터 쪽에서 보면 Write 그룹(`kubeast:operator`)은 기본 `edit` ClusterRole에 `pods/exec`가 들어 있어 원래 모든 네임스페이스에서 exec가 된다 — Pod exec를 Admin 전용으로 만드는 것은 Kubeast의 앱 권한이다. 그래서 Kubeast의 impersonation 자격(`kubeast-impersonator`)은 그 그룹들 전체 권한과 같은 무게로 지켜야 한다.
  - 로그 파일 보기(`features.logFiles`, 기본 off)는 Kubeast가 명령을 `ls`·`tail`로 고정하므로 Read·Write도 쓴다. 이를 위해 차트는 적어 둔 네임스페이스에만 Read 그룹(`kubeast:viewer`)에 `pods/exec`를 묶는다([컨테이너 안 로그 파일](operations.md#컨테이너-안-로그-파일-log-files)).
- **쓰기 API는 전부** 핸들러에서 권한을 검사하고 감사 행 없이는 거부된다(fail-closed).
  - **읽기 API**는 "그 클러스터에 역할이 있나"(클러스터 미들웨어, deny-by-default) + 클러스터의 RBAC(viewer 그룹)으로 막힌다.
  - `menu.*`는 화면 메뉴만 가린다 — 사이드바 그룹마다 하나씩: Core(대시보드·Cluster View·Monitoring·Alerts·Cost·AI Chat·Resource Graph·Change History·Advanced Search — Alerts·Cost·AI Chat은 그 기능을 켰을 때)는 `menu.dashboard`, Cluster와 Custom Resources는 `menu.cluster`, Workloads·Storage·Network·Gateway·GPU·Security·Configuration·Helm은 같은 이름의 키, Admin은 관리자 여부. 기본 역할은 `menu.*`를 가지므로 커스텀 역할에서만 그룹이 빠진다.
- **대시보드 개수**(네임스페이스·파드·노드 …)는 클러스터별 informer 캐시(`kubeast:cache` 신원)에서 세므로, 사용자 신원이 네임스페이스를 list 할 수 있는지(SelfSubjectAccessReview, 60초 캐시)를 먼저 묻고 안 되면 403을 돌려준다 — 그룹이 아직 바인딩되지 않은 커스텀 역할이나 네임스페이스 하나에만 묶인 사용자가 클러스터 전체 개수를 보지 않도록.
- **YAML 생성·편집**은 문서마다 그 Kind의 `resource.<이름>.create`(편집은 대상의 `resource.<이름>.edit`)를 본다.
  - 이름은 Kind 소문자, 단 HorizontalPodAutoscaler·VerticalPodAutoscaler·PodDisruptionBudget·PersistentVolume·PersistentVolumeClaim·CustomResourceDefinition은 `hpa`·`vpa`·`pdb`·`pv`·`pvc`·`crd`, 자기 이름이 없는 Kind(CR 등)는 `customresource`.
  - Write 그룹의 `edit`는 클러스터 범위 객체(Namespace·ClusterRole·StorageClass 등)를 만들 수 없어 그건 클러스터가 거부한다 — 그래서 그 화면들(클러스터 범위 15종 + Role·RoleBinding)의 생성 버튼은 앱 권한에 더해 클러스터에 직접 묻는다(`GET /api/v1/cluster/can-i?verb=create&group=&resource=`, 사용자 신원의 SelfSubjectAccessReview = `kubectl auth can-i`).
  - 클러스터가 안 된다고 하면 버튼이 없다.
- **네임스페이스 범위 부여**: 클러스터별 역할을 네임스페이스 목록(최대 50)으로 한정할 수 있다 — 사용자 상세의 역할 옆 칸이나 클러스터 접근 창에서 적고(비우면 클러스터 전체), 부여 API는 `namespaces`로 받아 `/auth/me`(`cluster_namespaces`)와 토큰(`ns` 클레임)에 싣는다.
  - 접근 요청도 목록을 가질 수 있고, 범위 부여를 가진 사람은 그 안에서만 요청한다(폼에 프리필·필수).
  - 그런 부여는 Kubeast가 **그 네임스페이스 밖의 경로를 403으로 거르고**(클러스터에 묻기 전에, 쓰기는 감사 행), 네임스페이스 목록은 부여 목록 그대로, "전체 네임스페이스" 조회는 목록을 하나씩 모아 합치며, 대시보드 개수도 그 안에서만 센다(`scoped: true`, 노드·PV는 0).
  - AI 도구와 MCP는 `namespace`를 꼭 받고 클러스터 전체 도구(overview·노드 메트릭·apply·create·API 목록·클러스터 설정)는 거부한다.
  - 클러스터 쪽 신원은 `kubeast:role:<slug>` 그룹이라 **그 네임스페이스마다 RoleBinding을 묶기 전엔 클러스터가 거부한다** — 차트 `auth.impersonation.customRoles`에 `{name: Read, namespaces: [a, b], clusterRoles: [view]}`처럼 적으면 그 RoleBinding이 렌더된다(등록 클러스터마다 적용).
  - 화면에선 네임스페이스 선택기가 부여된 것만 보여 주고, 권한 없음 안내에 "이 클러스터에서는 네임스페이스 a, b만"이 붙으며, 실시간 갱신도 네임스페이스별로 구독한다.
  - Access Review 보고서·CSV에 `namespaces` 열이 있다.
- **SSO 그룹 → 역할**: OIDC 공급자가 주는 그룹을 `auth.oidc.roleMapping`(`<그룹>=<Admin|Member|커스텀>`, 계정 등급)과 클러스터별 부여 — 그룹 이름 `<clusterGroupPrefix><클러스터>:<역할>` 또는 이름을 못 정하는 그룹(Google 그룹 이메일·Entra 그룹 ID)은 `auth.oidc.clusterGroupMapping`(`<그룹>=<클러스터>:<역할>`) — 으로 바꾸고, `syncRoles`면 로그인마다 다시 맞춘다.
  - **Google 로그인은 ID 토큰에 그룹이 없으므로** `auth.oidc.googleGroups`를 켜면 로그인 때 Admin SDK Directory API로 그 사람의 Workspace 그룹을 읽어 매핑에 걸리는 것만 더한다(회사 그룹 전체를 감사 행에 남기지 않음).
  - 서비스 계정엔 Workspace 관리자 역할 **Groups Reader**(도메인 전체 위임 없음 — 대신 요청에 `domain`이 붙는다), 자격은 Secret의 `credentials.json` 하나: 키 없는 Workload Identity Federation 설정 파일(`external_account`, 이 클러스터 토큰이면 `tokenAudience`) 또는 서비스 계정 키. 조회가 실패하면 지금 역할을 그대로 두고 로그인 감사 행에 `groups_lookup: failed`를 남긴다.
  - 관리자는 `GET /api/v1/auth/admin/oidc/groups?email=`로 그 사람의 매핑 결과를 미리 본다(매핑된 그룹 이름 + 나머지 개수, 감사 `admin.oidc.groups.read`).
  - 공급자별 설정 순서(Keycloak·Google·Entra ID·Okta)·첫 관리자·로그인 실패 코드는 [docs/oidc.md](oidc.md).
- `auth.impersonation.enabled=false`는 데모용이다: k8s-service가 `cluster-admin`, tool-server가 `*`로 돌고 읽기 API는 클러스터 부여만으로 열린다.
- **목록이 비었을 때 화면이 하는 말**: 권한이 없으면(403) "볼 권한이 없습니다"(위쪽 배너 + 표), 서버 오류·응답 없음이면 "불러오지 못했습니다(서버 오류 503)" + 다시 시도, 클러스터에 그 CRD가 없으면(Gateway API·VPA) "설치되어 있지 않습니다"(k8s-service가 discovery로 보고 빈 목록에 `X-Kubeast-Not-Installed` 헤더 — 역할과 무관하게 같은 답, 생성 버튼 없음). 그 밖엔 "없습니다". 없는 주소는 404 화면.
- 회귀 확인: `e2e/tests/rbac-matrix.spec.ts`(역할 × 동작 403/200 표) · `permission-ceiling.spec.ts`(남에게 자기 이상 못 줌) · `reader-ui-notices.spec.ts`(Read의 화면 안내) · `notices.spec.ts`(서버 오류·설치 안 됨·404·생성 버튼 can-i·권한 요청 안내).

## ☸️ Kubernetes 리소스 관리

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

## ⎈ Helm 릴리스 관리

- 릴리스 목록 / 상세 / 히스토리 / values / 매니페스트 / 리소스 보기
- **Rollback · Upgrade · Uninstall · Test** (모두 dry-run 미리보기 + 확인 후 실행)

## 🎮 GPU & DRA (Dynamic Resource Allocation)

- GPU 노드 / Pod / 사용률 대시보드, NVIDIA GPU 메트릭
- DeviceClass, ResourceClaim, ResourceClaimTemplate, ResourceSlice 관리

## 📊 관측성 (Observability)

- **Topology View** — 클러스터 리소스 관계 시각화 (React Flow / dagre / elkjs)
- **Dependency Graph** — 워크로드 간 의존성 그래프
- **Monitoring** — Prometheus 시계열 차트, 이상 감지, 상관 분석, GPU 심층 메트릭 (대상 클러스터에 있어야 하는 Prometheus·지표는 [docs/cluster-requirements.md §3](cluster-requirements.md#3-prometheus))
- **Node Shell** — 웹 기반 노드 터미널
- **로그 파일** — 파일로 로그를 쓰는 앱의 컨테이너 안 로그를 허용 경로에서만 읽고 따라가기(고정 `tail`, 기본 off, [자세히](operations.md#컨테이너-안-로그-파일-log-files))
- **로그 검색** — Loki에서 재시작·삭제된 파드까지 텍스트·기간으로 찾기, 클러스터 RBAC(`pods/log`)대로(기본 off, [자세히](operations.md#로그-검색-loki))
- **Advanced Search** — 표현식 기반 전역 리소스 탐색

## 🔐 인증 · 감사

- JWT 기반 자체 인증(JWKS) — 조직(Organization) / 팀(Team) / 사용자 계층
- **API 키** — 스크립트·CI용 자격(Settings → API keys). 키는 짧은 액세스 토큰으로 교환해 쓰며 클러스터 범위·역할 상한·만료를 갖고, 발급자의 권한을 넘지 못함([API 키](security-audit.md#api-키-자동화))
- **감사 로그** — 모든 쓰기 작업 + 민감 조회(Secret 열람, Node Shell, 컨테이너 로그 파일 열람, 로그 검색, Helm 변경 등)를
  기록, 성공/실패 모두 추적
- **클러스터 위생 점검** — Pod Security Standards·이미지 태그·리소스·Namespace 정책·RBAC·TLS 만료를 보는 사람 권한으로 읽어 한 장으로, CSV/JSON과 클러스터별 월간 서명(Admin → Cluster hygiene, [자세히](operations.md#클러스터-위생-점검-cluster-hygiene))
- **AI 사용량** — 채팅 턴과 Optimization의 AI 설명마다 남는 `ai.chat.complete` 감사 행(제공자가 보낸 토큰 수를 턴 단위로 합산)을 사용자·모델·클러스터별로 집계(Admin → AI Usage).
  - 한도는 없고 누가 얼마나 썼는지 본다; 제공자가 usage를 안 보낸 호출은 합계에서 빼고 건수로 표시. 입력 토큰 옆의 **캐시 적중**은 제공자가 캐시에서 서빙한 입력 토큰(Anthropic `cache_read_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens`)과 그 비율, 입력 토큰 칸의 툴팁은 ai-service가 실제로 보낸 프롬프트 평균 크기(시스템·도구 정의·이력·메시지 JSON 문자 수, `prompt_chars`) — 제공자 집계와 무관하게 이력 창·요약·도구 설명 변경의 효과를 보는 지표. 같은 행 합계로 **채팅 토큰 예산**을 걸 수 있음(`ai.chat.budget.sessionTokens` 세션 누적·`ai.chat.budget.userDailyTokens` 사용자 UTC 하루 누적, 기본 0 = 끔): 넘으면 그 턴은 모델 호출 없이 거부되고 채팅에 안내가 뜨며 `ai.chat.budget_exceeded`로 감사됨(사용량 기준이 이 화면과 같음; Optimization AI 설명도 사용자 하루 예산을 넘으면 관측 표만 보이고 모델은 안 부름).
  - 모델 공급자가 거절하면 채팅·플로팅·Optimization이 **종류별로** 화면 언어로 알림 — 크레딧·한도 소진(OpenAI `insufficient_quota`, Claude API `billing_error`·지출 한도, Gemini 402), 너무 잦음(429), 키·토큰 거부(401·403), 공급자 과부하·장애(5xx·529·시간 초과), 구독 사용량 한도(풀리는 시각과 함께) — 공급자 이름과 원문(마스킹)을 같이(`app/services/ai/model_errors.py`)
- **i18n** — 한국어 · 영어. Kubernetes 리소스 종류(`StatefulSet`, `ConfigMap`, `Namespace` …)와 화면 이름(사이드바 항목·페이지 제목)은 두 언어 모두 영어로, 동사·설명·안내문만 번역합니다(예: "StatefulSet 생성", "전체 Namespace")
