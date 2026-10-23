[English](../cluster-requirements.md) | **한국어**

# 클러스터 준비물 — Kubeast가 만들지 않는 것

Kubeast는 등록한 클러스터에 아무것도 설치하지 않습니다. 예외는 노드 셸 파드 하나뿐입니다(§9).
기능마다 클러스터에 미리 갖춰 둬야 하는 것이 있고, 없으면 그 기능은 "없음"·"설치 안 됨"·"권한 없음"으로 표시되거나 영역 자체가 숨겨집니다.

이 문서는 기능마다 다음을 정리합니다.

- 무엇이 있어야 하는지
- Kubeast가 그것을 어떻게 찾는지
- 없으면 어떻게 보이는지
- 어떻게 확인하는지
- 예시

예시 파일은 [`deploy/examples/target-cluster/`](../../deploy/examples/target-cluster/)에 있습니다.

"대상 클러스터"는 Kubeast가 관리하는 클러스터를 말하며, Kubeast가 설치된 클러스터 자신도 포함합니다. Kubeast를 설치할 클러스터의 조건은 §15에 따로 정리했습니다.

## 한눈에

| 기능 | 대상 클러스터에 있어야 하는 것 | Kubeast 쪽 스위치(기본값) | 없으면 |
| --- | --- | --- | --- |
| 전체 | Kubeast 권한(RBAC) — §1 | `auth.impersonation.enabled`(켬) | 클러스터가 사용자 요청을 403으로 거부 |
| 알림 → AI 조사 | 조사 신원 RBAC — §1, Kubeast로 웹훅을 보내는 Alertmanager 또는 Grafana 알림 — §13 | `features.alertInvestigation.enabled`(끔) | 알림이 오지 않거나, 조사용 읽기 도구가 클러스터에서 403 |
| 노드·파드 사용량, Monitoring, 최적화(대체 수단) | metrics-server — §2 | — | 사용량 칸이 비고, 최적화는 "없음" |
| 드로어·대시보드 그래프, 최적화, 스토리지 분석 | Prometheus + 지표 수집기 — §3 | `features.prometheus.enabled`(**끔**) | 그래프 영역이 숨겨지고, 최적화는 metrics-server 순간값 사용 |
| 비용(Cost), 최적화 비용 열 | OpenCost — §4 | `features.cost.enabled`(켬) | "OpenCost 없음" 안내, 비용 열 없음 |
| 정책 보고서 | PolicyReport CRD와 보고서를 만드는 도구 — §5 | `features.policyReports.enabled`(켬) | "설치 안 됨" 안내 |
| GPU·DRA | NVIDIA device plugin·GFD 라벨·DCGM exporter, DRA API — §6 | — | GPU 수·사용률이 비거나 DRA가 "unavailable" |
| VPA·Gateway API·Admission Policy·Ingress 지연 | 해당 CRD·컨트롤러 — §7 | — | 목록이 비고 "설치 안 됨" 표시 |
| 재시작 없이 적용(resize) | Kubernetes 1.35 이상 — §8 | `features.inPlaceResize.enabled`(켬) | 버튼이 숨겨지고 API는 409 |
| 노드 셸 | 특권 파드 허용과 이미지 — §9 | `nodeShell.enabled`(끔) | 파드 생성 실패 |
| 컨테이너 안 로그 파일 | 이미지 안의 `ls`·`tail`, exec 권한 — §10 | `features.logFiles.enabled`(끔) | 422 "볼 수 없음" |
| 로그 검색 | 로그를 Loki로 보내는 수집기, `pods/log` 읽기 권한 — §14 | `features.logSearch.enabled`(끔) | 검색이 보이지 않고 API는 404 |
| AI 알림 읽기 | 알림에 클러스터 레이블(기본 `cluster`)을 붙이는 Alertmanager 또는 Grafana 알림 — §14 끝 | `features.alertStore.enabled`(끔) | `alerts_list` 도구가 빠지고 API는 404 |
| AI 트레이스 읽기 | 스팬을 Tempo로 보내는 수집기(리소스 속성 `k8s.cluster.name`·`k8s.namespace.name`), `pods/log` 읽기 권한 — §14 끝 | `features.traceStore.enabled`(끔) | `traces_*` 도구가 빠지고 API는 404 |
| 위생·업그레이드 점검의 폐기 API 항목 | API 서버 `/metrics` 읽기 권한 — §11 | `features.hygiene.enabled`(켬) | 그 항목만 "수집 실패"로 표시 |
| Argo CD 가드 | Argo CD 추적 어노테이션 — §12 | `gitops.argocd.enabled`(끔) | 배지·경고 없음 |

## 1. 권한(RBAC) — 모든 대상 클러스터

Kubeast는 **로그인한 사람의 신원으로**(impersonation) 클러스터에 요청을 보내며, 권한의 최종 상한은 클러스터 RBAC이 정합니다. 그래서 대상 클러스터마다 아래 항목이 있어야 합니다.

| 항목 | 필요한 이유 | 위치 |
| --- | --- | --- |
| ClusterRole `kubeast-impersonator` + 바인딩(그룹 `kubeast:impersonator`) | Kubeast 자격 증명이 사용자와 정해진 그룹으로만 가장하도록 제한 | [`helm/kubeast/files/impersonation-rbac.yaml`](../../helm/kubeast/files/impersonation-rbac.yaml) |
| 그룹 바인딩 `kubeast:viewer`(view + `kubeast:cluster-reader`) · `kubeast:operator`(edit) · `kubeast:admin`(cluster-admin) | Read·Write·Admin 역할이 클러스터에서 할 수 있는 범위 | 같은 파일 |
| 커스텀 역할 그룹 `kubeast:role:<이름>`, Namespace 범위 부여 | 커스텀 역할이나 Namespace 한정 부여를 쓸 때 | `auth.impersonation.customRoles` → `templates/impersonation-custom-roles.yaml` |
| Read의 Prometheus·OpenCost 프록시 GET | Read 역할이 비용과 그래프를 볼 때 | `auth.impersonation.viewerProxyServices` → `templates/impersonation-viewer-proxy.yaml` |
| Admin의 `nodes/proxy` get — AI 도구 `nodes_stats_summary`·`nodes_log` | API 서버 프록시를 거쳐 노드의 kubelet stats summary를 읽고 로그를 질의할 때 필요합니다. `kubeast:admin`(cluster-admin)에는 이미 들어 있고, 커스텀 역할로 Admin 도구를 쓰려면 `nodes` get + `nodes/proxy` get을 넣어야 합니다. `nodes_log`에는 kubelet 설정 `enableSystemLogHandler: true` + `enableSystemLogQuery: true`(NodeLogQuery, 1.36 GA)도 필요하며, 꺼져 있으면 도구가 unavailable로 답합니다. kind는 기본값에서 query가 꺼져 있습니다 | 차트 `impersonation-rbac`(cluster-admin) · kubelet 설정 |
| 로그 파일 Namespace의 `pods/exec` | 로그 파일 보기를 켤 때(§10) | `features.logFiles` → `templates/logfiles-rbac.yaml` |
| 알림 조사 신원 `kubeast:investigator` — impersonate 허용 + 읽기 전용 ClusterRole(get·list·watch, Secret·exec·프록시·쓰기 없음) | 알림 → AI 조사를 켤 때 필요합니다. Kubeast는 사람 대신 이 신원으로 읽기 도구를 실행합니다. 조사에서 CRD(Kyverno PolicyReport·Argo Rollout 등)도 읽어야 하면 `features.alertInvestigation.extraRules`에 읽기 규칙을 추가합니다. get·list·watch 외의 동사, `apiGroups "*"`, Secret·exec·프록시·토큰은 렌더 단계에서 거부합니다 | `features.alertInvestigation` → `templates/impersonation-investigator.yaml`(impersonation이 꺼져 있으면 렌더 실패) |

**Write = Kubernetes 기본 `edit`**: kubectl로 `edit`을 받은 사람과 범위가 같으며, 다음 권한까지 포함합니다.

- Secret 읽기·쓰기
- `pods/exec`·`pods/portforward`
- 모든 Service 프록시(`services/proxy`)

Kubeast 화면에서 셸은 Admin만 열 수 있지만, 클러스터 권한으로는 가능합니다.
권한을 더 좁혀야 하는 사람에게는 Write 대신 커스텀 역할(`auth.impersonation.customRoles`, Namespace 범위 가능)을 부여하세요.

**Kubeast가 설치된 클러스터**에는 차트가 이 항목을 모두 만듭니다. 값을 바꾼 뒤 `helm upgrade`를 실행하면 됩니다.
차트가 소유한 객체에 kubectl 어노테이션이 붙으므로, 이 클러스터에는 아래 스크립트를 쓰지 마세요.

**등록한 다른 클러스터**에는 Kubeast가 RBAC을 만들지 않으므로, 같은 렌더 결과를 직접 적용하세요.

- 설치 값 위에 그 클러스터 고유의 값(Prometheus·OpenCost Service 이름 등, [`cluster-values.yaml`](../../deploy/examples/target-cluster/cluster-values.yaml))을 겹쳐 한 번에 렌더합니다.
- 쓰지 않는 기능의 템플릿은 비어 있으므로 건너뜁니다.
- helm은 빈 `--show-only`에서 멈추기 때문에 스크립트가 템플릿마다 따로 렌더합니다.

```bash
scripts/render-target-rbac.sh -f values.yaml -f cluster-b-values.yaml | kubectl --context cluster-b apply -f -
# OCI 차트로 설치했다면: KUBEAST_CHART=oci://<레지스트리>/kubeast scripts/render-target-rbac.sh --version <버전> -f ...
```

**EKS**: 다음 두 가지가 필요합니다.

- Kubeast 파드의 IRSA 롤이 대상 롤을 AssumeRole합니다([설치와 첫 설정 — 클러스터 연결](getting-started.md#3-로그인-후-클러스터-연결-connect-your-cluster)).
- 대상 클러스터의 **access entry가 그 롤을 Kubernetes 그룹 `kubeast:impersonator`에 매핑**해야 합니다(`kubernetesGroups`).

**확인**

```bash
kubectl --context <cluster> get clusterrole kubeast-impersonator kubeast:cluster-reader
kubectl --context <cluster> auth can-i list pods -A --as=check --as-group=kubeast:viewer --as-group=system:authenticated   # yes
kubectl --context <cluster> auth can-i get secrets -A --as=check --as-group=kubeast:viewer --as-group=system:authenticated # no
# 알림 조사를 켰다면
kubectl --context <cluster> auth can-i get pods --subresource=log -A --as=kubeast:investigator --as-group=kubeast:investigator # yes
kubectl --context <cluster> auth can-i get secrets -A --as=kubeast:investigator --as-group=kubeast:investigator                  # no
```

## 2. metrics-server

노드 목록, Monitoring 화면, 노드 드로어의 사용량과, Prometheus가 없을 때 최적화 표에 나오는 사용량(순간값)은 `metrics.k8s.io`에서 읽습니다.

- 설치: [metrics-server 차트](https://artifacthub.io/packages/helm/metrics-server/metrics-server) `3.14.0`(앱 0.9.0)
  - `helm install metrics-server metrics-server/metrics-server --version 3.14.0 -n kube-system`
  - EKS에서는 metrics-server 애드온으로 설치해도 됩니다.
  - kind처럼 kubelet 인증서가 자체 서명이면 `--kubelet-insecure-tls`가 필요합니다(로컬 전용).
- 확인: `kubectl --context <cluster> top nodes`

## 3. Prometheus

다음 항목은 Prometheus에서 읽습니다.

- 드로어(Pod·워크로드·Service·Namespace·노드·HPA·Ingress)의 그래프
- 대시보드 지표
- 최적화 표의 CPU p95와 메모리 최댓값
- 스토리지 분석

**Kubeast 쪽에서 `features.prometheus.enabled: true`를 켜야** 합니다(차트 기본값은 끔).

### Kubeast가 찾는 방법

- **순서**: 클러스터 설정에 적은 주소 → 클러스터 설정에 적은 Service → 차트 `features.prometheus.url` → 차트 `features.prometheus.service` → 자동 발견.
- **Service 지정**: Admin → Clusters → 편집의 "클러스터 안 Service" 또는 차트 `features.prometheus.service`에 적습니다.
  - Lens·Headlamp와 같은 `namespace/service:port` 형식으로 적습니다.
  - API가 하위 경로에 있으면 `namespace/service:port/경로`처럼 경로까지 적습니다(예: VictoriaMetrics 클러스터 `monitoring/vmselect-main:8481/select/0/prometheus`).
  - Kubeast는 API 서버 프록시로 읽고, 상태 API로 `/-/healthy` 연결 여부와 저장소 종류(`flavor`: prometheus·victoriametrics)를 알려 줍니다.
  - 저장소 종류는 `/-/healthy` 응답 문구로 판단합니다.
- **클러스터 안 자동 발견**: 아래 순서로 찾습니다. `/-/healthy`가 응답하면 그 Service를 쓰고, 찾은 결과는 클러스터마다 10분 동안 기억합니다.
  - ① 모든 Namespace에서 레이블로 찾고, Service의 포트를 모두 시도합니다. 레이블 순서는 다음과 같습니다.
    - `kubeast.io/prometheus=true`
    - prometheus 차트 서버(`app.kubernetes.io/name=prometheus,app.kubernetes.io/component=server`, 포트 80)
    - Prometheus Operator의 `prometheus-operated`(`operated-prometheus=true`)
  - ② 없으면 이름에 `prometheus`가 들어간 Service 중 **포트 9090**을 다음 Namespace 순서로 찾습니다: `monitoring` → `prometheus` → `jupyterhub` → `kube-system` → `gpu-operator` → `observability` → `default`.
  - 자동 발견은 개요 캐시 신원(`kubeast:cache`, `view`)으로 실행하므로, 이 신원이 모든 Namespace의 Service 목록을 읽을 수 있어야 합니다(§1 설정 그대로면 됩니다).
- **중앙 저장소**(Thanos·Mimir·VictoriaMetrics 등 Prometheus 호환 API): Admin → Clusters → 편집에 주소·인증·클러스터 레이블 값을 적습니다.
  - 참고: [운영 기능 — 대시보드 빠른 작업의 "Prometheus 소스"](operations.md#대시보드-빠른-작업-이슈--최적화--스토리지)
  - 이때 아래 지표에는 그 클러스터 레이블이 붙어 있어야 합니다.
- **Grafana를 거쳐**: 저장소 조회 API를 외부에 열지 않고 Grafana 데이터소스로만 쓰는 환경이면 다음과 같이 적습니다.
  - 주소: Grafana 데이터소스 프록시 `https://<Grafana>/api/datasources/proxy/uid/<데이터소스 UID>`
  - 인증: Grafana 서비스 계정 토큰(Viewer, bearer)
  - Kubeast 질의는 모두 GET이므로 Grafana Prometheus 프록시의 제한(POST는 일부만 허용)에 걸리지 않습니다.
  - 질의 시간은 Grafana `dataproxy.timeout`(기본 30초)의 제한도 받습니다.
  - Grafana OSS에는 데이터소스별 권한이 없어 그 토큰으로 모든 데이터소스를 읽을 수 있으므로, 토큰을 시크릿으로 관리하세요.
  - 로그 저장소(§14)도 같은 방식으로 연결합니다.
- 이름이나 레이블이 달라 자동 발견으로 찾지 못하는 설치라면, Service에 `kubeast.io/prometheus=true`를 붙이거나 Service를 직접 지정하세요.

### VictoriaMetrics

VictoriaMetrics는 Prometheus 질의 API를 그대로 제공하므로 화면과 AI 도구 모두 같은 질의로 읽습니다(검증: v1.154.1 단일판·클러스터판, 2번 클러스터 Prometheus와 같은 값). 아래는 Prometheus와 다른 점입니다.

- **찾기**: Prometheus가 없으면 단일판을 자동으로 찾습니다. Prometheus가 있으면 Prometheus를 먼저 씁니다.
  - 먼저 VM operator의 `app.kubernetes.io/name=vmsingle` 레이블과 Helm 차트의 `app.kubernetes.io/name=victoria-metrics-single` 레이블을 봅니다.
  - 그다음 이름에 `vmsingle`·`victoria-metrics`가 들어간 8428 포트 Service를 봅니다.
  - 클러스터판은 테넌트 경로가 필요해 자동으로 찾지 않습니다. 다음 중 하나로 지정하세요.
    - Service를 경로까지 적기: `monitoring/vmselect-<이름>:8481/select/<테넌트>/prometheus`
    - 중앙 저장소 주소로 적기: `http://vmselect-<이름>.<ns>.svc:8481/select/0/prometheus`, 클러스터 레이블 값과 함께
- **알림 규칙**(AI `prometheus_rules`): 규칙은 vmalert에 있습니다.
  - 단일판이나 vmselect에 `-vmalert.proxyURL=<vmalert 주소>`가 설정되어 있어야 `/api/v1/rules`가 그 규칙을 돌려줍니다.
  - 설정이 없으면 VM은 빈 목록을 돌려주므로, Kubeast는 저장소 종류를 보고 "이 저장소는 규칙을 주지 않는다"고 바꿔 답합니다. "규칙 없음"이라고 잘못 답하지 않기 위해서입니다.
- **수집 대상**(AI `prometheus_targets`): 저장소 구성에 따라 결과가 다릅니다.
  - 단일판이 직접 수집하면(`-promscrape.config`) 그 목록을 돌려줍니다.
  - vmagent나 원격 쓰기로 받으면 빈 목록이 옵니다.
  - vmselect는 그 API가 없어 400 `unsupported path requested`를 돌려줍니다.
  - 빈 목록과 400인 경우 모두 `up` 지표로 대신합니다.
- **메타데이터**(AI `prometheus_metrics`의 타입·설명): v1.137부터 기본으로 저장합니다(`-enableMetadata`). 메모리에만 저장하므로 재시작하면 다시 쌓일 때까지 이름만 보입니다.
- **클러스터 레이블 주입**: 여러 클러스터가 함께 쓰는 저장소라면 Kubeast가 Prometheus 파서로 `cluster="<값>"`을 넣습니다.
  - 그래서 MetricsQL 전용 문법(`WITH`, `[d]` 없는 `rate(x)` 등)은 400으로 거부됩니다.
  - 클러스터 하나만 담은 저장소(레이블 값 없음)에는 질의를 그대로 보내므로 MetricsQL도 쓸 수 있습니다.
- **OTLP로 받을 때**: VM은 점으로 구분된 이름을 그대로 저장하므로, hostmetrics를 OTLP로 보내려면 `-opentelemetry.usePrometheusNaming`이 필요합니다. 원격 쓰기로 보내면 수집기가 이미 이름을 바꿔 보냅니다.
- **Read 사용자**: 클러스터 안 Service로 읽는다면 Prometheus와 마찬가지로 `auth.impersonation.viewerProxyServices`에 `<ns>/<service>:<port>`를 경로 없이 적습니다.

### 있어야 하는 지표

| 지표 | 내는 곳 | 쓰는 화면 |
| --- | --- | --- |
| `container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`(라벨 `namespace`·`pod`·`container`) | kubelet의 cAdvisor(`/metrics/cadvisor`) | 최적화 표, Pod·워크로드·Service·Namespace 드로어 |
| `node_cpu_seconds_total`, `node_memory_MemAvailable_bytes`·`MemTotal_bytes`, `node_filesystem_avail_bytes`·`size_bytes`(`mountpoint="/"`), `node_load1`, `node_network_*_bytes_total`, `node_disk_*_bytes_total` — 또는 아래 hostmetrics 이름 | node-exporter 또는 OpenTelemetry Collector `hostmetrics` | 대시보드, 노드 드로어 |
| `kube_pod_info`, `kube_pod_container_status_restarts_total`, `kube_horizontalpodautoscaler_status_current_replicas` | kube-state-metrics | 대시보드, Namespace·워크로드·HPA 드로어 |
| `kubelet_volume_stats_used_bytes`·`capacity_bytes`·`available_bytes` | kubelet `/metrics` — CSI 드라이버가 볼륨 통계를 내야 합니다(hostPath·local-path는 내지 않아 N/A) | 스토리지 분석 |
| `DCGM_FI_DEV_GPU_UTIL`, `DCGM_FI_DEV_FB_USED`·`FB_FREE`, `DCGM_FI_DEV_MEMORY_TEMP` | NVIDIA DCGM exporter | GPU 화면 |
| `nginx_ingress_controller_request_duration_seconds_bucket` | ingress-nginx 컨트롤러 | Ingress 드로어 지연(P50/P95/P99) |
| OpenCost가 내는 지표 | OpenCost(§4) | 비용 |

**노드 드로어의 노드별 값**: node-exporter 시리즈의 `instance`가 **노드 이름이나 노드 주소(InternalIP·ExternalIP)**일 때만 그 노드의 값을 고릅니다. 포트는 붙어 있어도 되고 없어도 됩니다.

- 아래 두 차트의 기본값 `instance=<노드 IP>:9100`은 그대로 조건에 맞습니다.
- 그 밖의 형식(예: node-exporter 파드 IP)이면 노드 드로어의 카드와 24시간 추세가 비어 보이며, 다른 노드의 값으로 대신 채우지 않습니다. 이때는 scrape 설정의 `relabelings`로 `instance`를 노드 이름(`__meta_kubernetes_pod_node_name`)으로 바꾸세요.
- 디스크·네트워크 I/O는 그 노드의 장치를 합친 값입니다(`device!="lo"`, node-exporter node-mixin과 같은 방식).
- 대시보드처럼 클러스터 전체를 합산하는 값에는 영향이 없습니다.

**node-exporter 대신 OpenTelemetry `hostmetrics`**: 노드 질의는 모두 "node-exporter 식 `or` hostmetrics 식" 형태라서 저장소에 있는 쪽의 값이 나옵니다(둘 다 있으면 node-exporter).
어느 쪽을 쓸지 고르는 설정은 없습니다. hostmetrics를 쓸 때는 다음을 맞추세요.

- **이름**: Prometheus식 이름 변환 결과를 그대로 씁니다.
  - `system_cpu_time_seconds_total{state}`와 `system_cpu_logical_count` — CPU 사용률 = 1 − 유휴 초 ÷ 논리 CPU 수(node-exporter와 같은 계산)
  - `system_memory_usage_bytes{state="used"}`와 `system_memory_limit_bytes`
  - `system_filesystem_usage_bytes{mountpoint="/",state}`
  - `system_cpu_load_average_1m`
  - `system_network_io_bytes_total{direction,device}`
  - `system_disk_io_bytes_total{direction,device}`
  - OTel `prometheus_remote_write` exporter(0.162 이전 이름은 `prometheusremotewrite`)와 Prometheus의 OTLP 수신은 기본으로 이 이름을 씁니다.
  - VictoriaMetrics에 OTLP로 보낼 때는 `-opentelemetry.usePrometheusNaming`을 지정해야 합니다(기본값은 점으로 구분된 이름 그대로).
- **`system.memory.limit` 켜기**(기본 꺼짐): 메모리 사용률은 `used ÷ limit`입니다.
  - 수신기의 MemAvailable 게이트(0.137부터 기본 켬) 덕분에 `used` = 전체 − MemAvailable이 되므로, node-exporter의 `1 − MemAvailable/MemTotal`과 같은 값입니다.
  - state 값을 모두 더해도 전체가 되지 않으므로 합계로 나누지 않습니다.
- **노드 레이블 `k8s_node_name`** = 노드 이름: 리소스 속성 `k8s.node.name`(downward API `spec.nodeName`)을 레이블로 바꿉니다.
  - `prometheus_remote_write`: `resource_constant_labels.included: [k8s.node.name]`
  - Prometheus OTLP: `promote_resource_attributes`
- **수집기 버전을 올린 직후**: 버전을 올린 뒤 몇 분(조회 창, 기본 5분) 동안 같은 시리즈가 두 벌 존재합니다.
  - 수집기 버전이 레이블 `otel_scope_version`에 들어가고, 멈춘 수집기는 종료 표시를 보내지 않기 때문입니다.
  - Kubeast의 노드 질의는 `max without (otel_scope_name, otel_scope_version)`로 한 벌만 셉니다.
  - `sum`을 직접 쓰는 대시보드와 알림 규칙도 같은 방식으로 바꾸세요. dev에서 0.162.0 → 0.163.1로 올릴 때 7분 동안 합계가 2배로 나왔습니다.
- **호스트 읽기**: 호스트 `/`를 `root_path: /hostfs`에 읽기 전용으로 마운트합니다(opentelemetry-collector 차트의 hostMetrics 프리셋과 같음).
  - 네트워크 값은 `hostNetwork: true`일 때만 노드 인터페이스의 값입니다. 그렇지 않으면 수집기 파드 자신의 트래픽이 되므로 `network` 스크레이퍼를 끄세요. Kubeast는 그 칸을 숨깁니다.
  - 디스크는 node-exporter의 기본 제외 대상(파티션·loop·ram)과 같은 장치를 뺍니다.
- **예시**: [`deploy/kind/hostmetrics-collector.yaml`](../../deploy/kind/hostmetrics-collector.yaml)(contrib 0.163.1, `scripts/kind-hostmetrics.sh`).

**AI 도구가 추가로 읽는 경로**: Prometheus 찾기 도구는 질의와 같은 저장소, 같은 클러스터 범위에서 다음 경로를 읽습니다. 모두 GET이므로 Grafana 데이터소스 프록시로도 읽을 수 있습니다.

- `/api/v1/label/__name__/values`·`/api/v1/labels`·`/api/v1/label/<이름>/values` — `start`·`end`는 늘 최근 1시간처럼 지정하고, 여러 클러스터가 쓰는 저장소면 `match[]`에 클러스터 레이블을 넣습니다.
- `/api/v1/metadata` — 없으면 이름만 씁니다.
- `/api/v1/rules` — VictoriaMetrics는 조회 쪽에 `-vmalert.proxyURL`이 있을 때만 읽습니다. 없으면 "이 저장소는 규칙을 주지 않는다"고 답합니다(위 VictoriaMetrics 절 참고).
- `/api/v1/targets` — 클러스터 전용 저장소일 때만 읽습니다. 여러 클러스터가 쓰는 저장소, 목록이 빈 저장소, 그 API가 없는 저장소는 `up` 지표로 대신합니다.

### 예시

- **prometheus-community/prometheus 차트** — [`prometheus-values.yaml`](../../deploy/examples/target-cluster/prometheus-values.yaml).
  - 서버 Service는 레이블로 찾으므로 Namespace나 포트(기본 80)와 관계없이 찾습니다.
  - 예시는 Read 프록시 값(`cluster-values.yaml`의 `viewerProxyServices`)과 맞추려고 포트를 9090으로 둡니다.
  - 기본 수집 작업(cAdvisor·kubelet·kube-state-metrics·node-exporter)에 OpenCost를 추가합니다.

  ```bash
  helm install prometheus prometheus-community/prometheus --version 29.37.0 \
    -n monitoring --create-namespace -f deploy/examples/target-cluster/prometheus-values.yaml
  ```

- **kube-prometheus-stack** `92.3.0`: operator가 만드는 `prometheus-operated`(레이블 `operated-prometheus=true`, 포트 9090)를 레이블로 찾으므로, 어느 Namespace에 설치해도 찾을 수 있습니다.
  - 레이블과 포트는 Prometheus Operator v0.94.1 소스에서 확인했습니다.
  - 지표도 기본 ServiceMonitor로 모두 수집됩니다(렌더로만 확인).

### 확인

```bash
kubectl --context <cluster> get svc -A | grep -i prometheus      # 이름에 prometheus, 9090
kubectl --context <cluster> get --raw "/api/v1/namespaces/monitoring/services/prometheus-server:9090/proxy/-/healthy"
kubectl --context <cluster> get --raw "/api/v1/namespaces/monitoring/services/prometheus-server:9090/proxy/api/v1/query?query=count(container_cpu_usage_seconds_total)"
```

Kubeast에서 Admin → Clusters → 편집 → Prometheus의 "연결 확인"을 누르면 `클러스터 안에서 찾음: <ns>/<service>:<port>`가 표시됩니다.
Read 사용자에게도 열어 주려면 이 주소를 §1의 `viewerProxyServices`에 적으세요.

## 4. OpenCost (비용)

- **Kubeast가 찾는 방법**: 이름에 `opencost`가 들어간 Service 중 **포트 9003**인 것을 `opencost`·`kubecost`·`monitoring`·`cost` Namespace에서 찾고, `/healthz`로 확인합니다.
  - 찾은 결과는 10분, 찾지 못한 결과는 5분 동안 기억합니다.
- **조건**: OpenCost는 Prometheus를 읽고, Prometheus는 OpenCost의 `/metrics`를 다시 수집해야 합니다. OpenCost가 내보내는 가격·클러스터 지표를 할당 계산에 쓰기 때문입니다.
- **예시**: [`opencost-values.yaml`](../../deploy/examples/target-cluster/opencost-values.yaml) — §3 예시의 Prometheus를 읽도록 맞춘 값입니다.

  ```bash
  helm install opencost opencost/opencost --version 2.5.33 \
    -n opencost --create-namespace -f deploy/examples/target-cluster/opencost-values.yaml
  ```

- **확인**: Prometheus에서 `up{job="opencost"}`가 1이고, Kubeast 비용 페이지 상단에 `OpenCost <ns>/<service>:<port>`가 보이면 됩니다.
  - 단가는 OpenCost가 정하며, 클라우드에서는 가격 API를, 그 밖의 환경에서는 기본 단가를 씁니다.

## 5. 정책 보고서 (PolicyReport)

`wgpolicyk8s.io/v1alpha2`의 PolicyReport·ClusterPolicyReport CRD와 그 보고서를 만드는 도구가 있어야 합니다. Kubeast는 보고서를 읽기만 합니다.

- **Kyverno**: [Kyverno 차트](https://kyverno.io/docs/installation/methods/) `3.9.2`(Kyverno 1.19.2)가 CRD와 보고서를 만듭니다.
  - 보고서 읽기 권한을 기본 `view` 롤에 집계하므로 Read 역할도 보고서를 읽을 수 있습니다.
  - 보고서는 정책이 있어야 생기므로 Audit 정책 몇 개로 시작하세요.
  - 개발용 값과 정책 예시는 [`deploy/kind/kyverno-values.yaml`](../../deploy/kind/kyverno-values.yaml)·[`kyverno-policies.yaml`](../../deploy/kind/kyverno-policies.yaml)에 있습니다.
- 같은 CRD를 쓰는 다른 도구의 보고서도 읽을 수 있지만, 검증은 Kyverno로만 했습니다.
- **확인**: `kubectl --context <cluster> get policyreports -A`

## 6. GPU·DRA

| 구성 요소 | Kubeast가 보는 것 | 쓰는 화면 |
| --- | --- | --- |
| NVIDIA device plugin | 노드의 `nvidia.com/gpu`·`nvidia.com/mig-*` 자원, DaemonSet `nvidia-device-plugin-daemonset`(`kube-system`·`gpu-operator`·`nvidia-gpu-operator`) 또는 `kube-system/nvidia-device-plugin` | GPU 수·할당, 플러그인 상태 |
| GPU Feature Discovery | 노드 라벨 `nvidia.com/gpu.product`·`gpu.memory`·`mig.strategy`·`cuda.driver.*` | GPU 모델·메모리 |
| time-slicing 설정 | ConfigMap `time-slicing-config`·`nvidia-plugin-configs`·`time-slicing`(위 Namespace) | 시분할 설정 |
| DCGM exporter | §3 표의 `DCGM_FI_DEV_*` 지표 | 사용률·메모리·온도 |
| DRA | `resource.k8s.io`(1.34+ v1, 1.32–1.33 v1beta2/v1beta1, 1.31 v1alpha3) — API 탐색으로 버전 선택 | DeviceClass·ResourceClaim·ResourceSlice |

NVIDIA GPU Operator를 쓰면 위 구성 요소가 한 번에 설치됩니다. 이 절은 코드를 기준으로 썼으며, 실제 GPU 클러스터에서는 검증하지 않았습니다.

## 7. 있으면 보여 주는 API

CRD가 없으면 Kubeast는 빈 목록과 "설치 안 됨"(`X-Kubeast-Not-Installed`)으로 답합니다.

| 화면 | 있어야 하는 것 |
| --- | --- |
| VerticalPodAutoscalers | `autoscaling.k8s.io/v1` CRD. 추천값은 VPA recommender가 채웁니다 |
| Gateway API | `gateway.networking.k8s.io/v1` CRD(GatewayClass·Gateway·HTTPRoute 등)와 구현체 |
| Gateway 정책 | 라벨 `gateway.networking.k8s.io/policy`가 붙은 CRD(GEP-713), 또는 기본 목록 — BackendTLSPolicy, Envoy Gateway(`gateway.envoyproxy.io`의 BackendTraffic·ClientTraffic·Security·EnvoyPatch·EnvoyExtension Policy), Istio(AuthorizationPolicy·RequestAuthentication·PeerAuthentication·Telemetry·WasmPlugin·EnvoyFilter·DestinationRule) |
| Admission Policies | ValidatingAdmissionPolicy(`admissionregistration.k8s.io/v1`), MutatingAdmissionPolicy(`admissionregistration.k8s.io/v1`) — 이 API를 제공하지 않는 클러스터는 "설치 안 됨". Read 그룹은 `kubeast:cluster-reader`로 정책과 바인딩을 읽습니다. 이 권한은 2026-10-22에 추가되었고 `view`에는 없으므로, 그 전에 RBAC를 적용한 클러스터는 다시 적용하세요 |
| Ingress 드로어 지연 | ingress-nginx 컨트롤러와 §3의 `nginx_ingress_controller_*` 지표 수집 |
| AI 도구 `gitops_status` | `applications.argoproj.io` CRD(Argo CD). 이 CRD는 Argo CD가 설치된 클러스터에만 있으므로, 중앙 Argo CD를 쓴다면 관리 클러스터에서 호출하세요. 없으면 도구가 unavailable로 답합니다. 권한 상한은 읽는 사람의 RBAC(`applications.argoproj.io` get/list)입니다 |

## 8. Kubernetes 버전 조건

| 기능 | 조건 |
| --- | --- |
| 재시작 없이 적용(Pod `resize` 하위 리소스) | API 서버 1.35 이상 |
| DRA 화면 | 1.31 이상(§6) |
| 업그레이드 준비 점검 | 대상 = 서버 마이너 + 1 (조건 없음) |

## 9. 노드 셸

노드 셸을 켜면(`nodeShell.enabled`, Admin 전용) Kubeast가 대상 클러스터에 Namespace `kubeast-node-shell`(Pod Security `privileged` 라벨)을 만들고, 선택한 노드에 특권 파드(hostPID·hostIPC·hostNetwork, 호스트 `/` 마운트)를 띄웁니다.

- 그 Namespace에서 특권 파드를 막는 정책(Kyverno·Gatekeeper 등)이 있다면 그 정책에 예외를 두어야 합니다.
- 노드가 이미지(`nodeShell.images`, 기본 `docker.io/library/busybox:1.38.0`)를 내려받을 수 있어야 합니다. 폐쇄망이라면 사내 미러 주소를 적으세요.
- 사용자는 그 클러스터의 Admin(cluster-admin)이어야 합니다.

## 10. 컨테이너 안 로그 파일

Kubeast는 사용자 신원으로 `pods/exec`를 호출해 `ls`·`tail`만 실행합니다.

- 컨테이너 이미지에 `ls`·`tail`이 있어야 합니다(distroless 이미지는 422).
- Read 그룹이 이 기능을 쓰려면 `features.logFiles.namespaces`의 Namespace마다 `pods/exec` 바인딩이 있어야 합니다. 이 바인딩은 §1의 렌더(`templates/logfiles-rbac.yaml`)에 포함되어 있습니다.

## 11. 위생·업그레이드 점검의 폐기 API 항목

"폐기 예정 API를 아직 부른다" 항목은 API 서버의 `/metrics`(`apiserver_requested_deprecated_apis`)를 읽습니다.
여기에는 비리소스 URL 권한(`nonResourceURLs: ["/metrics"]`, `get`)이 필요하므로 cluster-admin(Kubeast Admin)으로 점검할 때만 값이 채워집니다. 권한이 없으면 그 항목만 수집 실패로 표시됩니다.

kube-proxy 설정 점검은 `kube-system`의 ConfigMap `kube-proxy`·`kube-proxy-config`를 읽습니다.

## 12. Argo CD 가드

Argo CD가 배포한 객체에 추적 어노테이션(`argocd.argoproj.io/tracking-id`, Argo CD 3.x 기본 추적 방식)이 있어야 배지와 경고가 붙습니다.
라벨 방식(`app.kubernetes.io/instance` 등)으로 추적하는 설치라면 `gitops.argocd.instanceLabel`에 그 키를 적으세요. Argo CD 자체는 대상 클러스터에 없어도 됩니다.

- **검증**: Argo CD 3.5.6 core 설치가 실제로 동기화한 Deployment(`scripts/kind-argocd.sh`, podinfo 차트 6.15.0)로 다음을 확인했습니다(e2e `argocd-real.spec.ts`).
  - 이 Deployment에 `<앱>:apps/Deployment:<NS>/<이름>` 어노테이션이 붙습니다.
  - Kubeast는 그 객체의 삭제·롤백을 409로 막고 `k8s.gitops.refuse` 행을 남깁니다.
  - 드로어에 배지가 뜹니다.
  - `gitops_status`는 그 Application을 kubectl과 같은 내용으로 읽습니다.

## 13. Alertmanager 또는 Grafana 알림 (Alerts 받은편지함 · 알림 → AI 조사)

받은편지함과 조사는 Alertmanager나 Grafana 알림이 보내는 웹훅으로 시작합니다. Kubeast는 알림 엔진을 설치하지 않고, 알림 규칙도 만들지 않습니다.

- **보내는 곳**: `POST <Kubeast 주소>/api/v1/alerts/webhook?cluster=<Kubeast 클러스터 ID>`
  - 클러스터 ID는 Admin → Clusters에 표시되는 ID입니다.
  - 클러스터마다 수신자(또는 `cluster` 값)를 따로 두세요.
- **인증**: `Authorization: Bearer <kubeast-secrets의 ALERT_WEBHOOK_TOKEN>`. 토큰은 차트가 만들고 업그레이드할 때도 유지합니다.
  - `secrets.existingSecret`을 쓴다면 그 Secret에 직접 넣어야 합니다.
- **받은편지함**: 받은 알림은 심각도나 상태(울리는 중·해결됨)와 관계없이 Alerts 메뉴에 1건당 1행으로 남습니다. 클러스터·fingerprint·`startsAt`이 같으면 같은 알림으로 봅니다.
  - 해결 소식도 받아야 하므로 `send_resolved: true`(웹훅 기본값)로 두세요.
  - Alertmanager는 울리는 알림의 `endsAt`을 웹훅으로 보내지 않습니다. 그래서 마지막으로 받은 뒤 `features.alertInvestigation.inbox.staleAfterHours`(기본 8 — `repeat_interval`의 2배) 동안 새 소식이 없으면 "상태 확인 안 됨"으로 표시합니다.
  - 그 클러스터에 §14의 알림 저장소(`features.alertStore`)가 설정되어 있으면, 화면에 Alertmanager의 현재 상태(울리는 중·무음·억제·없음)도 함께 표시합니다.
- **조사 대상 알림**: `status=firing`이고 `severity` 라벨이 `features.alertInvestigation.severities`(기본 critical·warning)에 있는 알림입니다.
  - Alertmanager는 `repeat_interval`(기본 4h)마다 알림을 다시 보내지만, 클러스터·fingerprint가 같은 알림은 `dedupeHours`(기본 24) 안에 다시 조사하지 않습니다.
  - resolved 알림은 조사하지 않고 받은편지함의 해결 표시에만 씁니다.
- **`namespace` 라벨**: 있으면 조사가 그 Namespace로 한정됩니다(토큰의 `ns`). 없으면 클러스터 전체를 읽습니다.
- **Kubeast 쪽**: 다음이 필요합니다.
  - `features.alertInvestigation.enabled: true`. `auth.impersonation.enabled`·`ai.enabled`도 켜져 있어야 하며, 꺼져 있으면 차트 렌더가 실패합니다.
  - 모델 하나(기본 모델 또는 `model`)
  - 대상 클러스터의 §1 조사 신원 RBAC

```yaml
# Alertmanager v0.34.1 — 수신자 예시 (토큰은 파일로)
receivers:
  - name: kubeast
    webhook_configs:
      - url: https://kubeast.example.com/api/v1/alerts/webhook?cluster=prod-1
        send_resolved: true
        max_alerts: 20
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/kubeast/token
```

- **Grafana 알림**: 웹훅 연락처(Contact point → Webhook)를 씁니다.
  - URL은 위와 같이 적습니다.
  - Authorization 헤더의 scheme은 `Bearer`, credentials에는 토큰을 넣습니다.
  - 알림 정책으로 클러스터마다 해당 연락처로 보내고, 규칙 레이블에 `severity`(필요하면 `namespace`도)를 넣으세요.
  - Grafana 13의 웹훅 본문(`version` "1")에도 Kubeast가 읽는 필드가 같은 이름으로 있어 그대로 받을 수 있습니다: `alerts[]`의 `status`·`labels`·`annotations`·`startsAt`·`fingerprint`, `externalURL`.
- **확인**: Kubeast Alerts 메뉴에 그 알림이 생기는지, Admin → Investigations에 조사 행이 생기는지 봅니다.
  - 심각도 필터에서 걸러진 알림은 조사 행이 생기지 않습니다.
  - 웹훅 응답 `{accepted, duplicate, filtered, skipped, resolved, dropped, stored}`는 Alertmanager 로그에 남습니다.
  - 개발용 전체 예시: [`deploy/kind/alertmanager.yaml`](../../deploy/kind/alertmanager.yaml)
  - Grafana 예시: `scripts/kind-grafana.sh`와 e2e `grafana.spec.ts`(연락처 시험으로 보낸 알림의 조사 확인)

## 14. 로그 저장소 (로그 검색)

Kubeast는 Loki의 `query_range`(AI의 `loki_query`는 메트릭 쿼리도 사용)·`labels`·`label/<이름>/values`·`patterns`를 읽기만 합니다.
모두 GET이므로 Grafana 데이터소스 프록시로도 읽을 수 있습니다. Loki와 수집기는 설치하지 않습니다.

패턴(`loki_patterns`)을 쓰려면 Loki에 `pattern_ingester: enabled: true`가 있어야 하며, 없으면 그 도구만 "없음"으로 답합니다.
Loki는 최근 3시간치 중 창 안에서 30줄 이상 나온 패턴만 돌려줍니다.

- **수집기**: 대상 클러스터의 컨테이너 로그를 Loki로 보내는 수집기가 있어야 합니다.
  - 라벨 이름이 `features.logSearch.labels`와 맞아야 합니다. 기본값은 Loki가 OTLP로 받은 로그에 붙이는 `k8s_cluster_name`·`k8s_namespace_name`·`k8s_pod_name`·`k8s_container_name`입니다.
    - 수집기 구성: OpenTelemetry Collector `file_log` + `container` 파서 또는 `k8sattributes`, `otlp_http` → Loki `/otlp`
    - 0.162 이전 이름인 `filelog`·`otlphttp`도 경고와 함께 아직 동작합니다.
  - Promtail이나 Alloy의 Kubernetes 탐색 방식을 쓴다면 `namespace`·`pod`·`container`로 바꾸세요.
- **클러스터 라벨**: Loki 하나에 여러 클러스터의 로그를 넣는다면 클러스터마다 다른 `k8s.cluster.name`(수집기의 resource 프로세서)을 붙이고, 그 값을 `features.logSearch.clusters`에 Kubeast 클러스터 ID와 짝지어 적으세요.
  - 여기에 적지 않은 클러스터에서는 검색을 쓸 수 없습니다.
- **클러스터별 저장소**: 로그가 다른 Loki에 있는 클러스터는 Admin → Clusters → 편집에서 그 저장소의 주소·인증·테넌트·레이블 값을 적습니다. 이 값은 `features.logSearch.url`보다 우선합니다.
  - 라벨 이름은 배포 전체 설정과 같아야 하므로, 그 저장소의 수집기도 같은 라벨 이름으로 보내야 합니다.
  - 그 저장소의 호스트와 포트도 아래 네트워크 정책에 추가하세요.
- **권한**: 사용자 신원으로 `get pods/log` 권한을 확인합니다. 범위는 그 Namespace이고, 전체 검색이면 클러스터 전체입니다.
  - 이 권한은 `view`·`edit`에 들어 있으므로 §1의 Read·Write 그룹이면 충분합니다.
  - Namespace 범위로 부여했다면 그 Namespace에 바인딩이 있어야 합니다.
- **네트워크**: k8s-service에서 Loki로 연결할 수 있어야 합니다. `networkPolicy`가 켜져 있고 포트가 443이 아니면 `features.logSearch.egressCIDRs`에 추가하세요.
- **Grafana를 거쳐**: §3과 같은 방식입니다.
  - 주소: `https://<Grafana>/api/datasources/proxy/uid/<Loki 데이터소스 UID>`
  - 인증: 서비스 계정 토큰
  - **테넌트는 비워 둡니다**. 데이터소스에 설정한 `X-Scope-OrgID`를 Grafana가 붙이고, Kubeast는 테넌트 칸이 비어 있으면 그 헤더를 보내지 않습니다.
- **AI 트레이스 읽기**(`features.traceStore`를 쓸 때): Kubeast는 Tempo의 다음 경로를 읽기만 합니다. 모두 GET이므로 Grafana 데이터소스 프록시로도 읽을 수 있습니다.
  - `/api/search`·`/api/v2/traces/<id>`·`/api/v2/search/tags`·`/api/v2/search/tag/<t>/values`·`/api/metrics/query_range`
  - 스팬의 **리소스 속성**에 클러스터 값(`k8s.cluster.name` — 수집기의 resource 프로세서)과 네임스페이스(`k8s.namespace.name` — `k8sattributes`)가 있어야 클러스터와 Namespace별로 거를 수 있습니다(값 = `features.traceStore.clusters`).
  - TraceQL 지표(`traces_metrics`)는 Tempo 3.x에서 기본으로 제공됩니다. 2.x에서는 metrics-generator `local-blocks`가 필요합니다.
  - 지표에서는 Tempo `query_frontend.query_end_cutoff`(기본 30초)와 step만큼 최근 구간이 빠집니다. 이 값은 `/status/config`에서 확인할 수 있습니다.
  - 읽기 권한은 로그 검색과 같이 사용자 신원의 `get pods/log`입니다.
- **AI 알림 읽기**(`features.alertStore`를 쓸 때): Kubeast는 알림 저장소의 `/api/v2/alerts`(매처 `filter`)와 `/api/v2/silences`를 GET으로 읽습니다.
  - 무음 쓰기를 켜면 아래 항목의 요청이 더해집니다.
  - 읽을 수 있는 저장소는 다음과 같습니다.
    - Alertmanager API v2
    - Grafana 데이터소스 프록시를 거치는 Alertmanager
    - Grafana 알림의 Alertmanager 호환 API(`/api/alertmanager/grafana/api/v2/…`). Grafana 13.2.4에서 Viewer로 200 응답을 확인했고, `…/status`는 Viewer에게 403이라 쓰지 않습니다.
  - 여러 클러스터가 함께 쓰는 저장소라면, 알림마다 **클러스터 레이블**(기본 `cluster` — Prometheus `external_labels` 또는 Grafana 알림 규칙 레이블)이 있어야 그 클러스터의 알림만 골라낼 수 있습니다(값 = `features.alertStore.clusters`).
  - 확인: `curl -G <url>/api/v2/alerts --data-urlencode 'filter=cluster="<값>"'`.
- **무음 쓰기**(`features.alertStore.silences: true`를 쓸 때): `resource.alert.silence` 권한이 있는 사람이 Alerts 화면에서 무음을 만들거나 끝내면 Kubeast가 다음 요청을 보냅니다.
  - 만들 때: `POST /api/v2/silences`
  - 끝낼 때: `DELETE /api/v2/silence/<id>`
  - 대상: Alertmanager API v2 · Grafana 데이터소스 프록시 · Grafana 알림의 호환 API
  - 따라서 저장소 인증 정보에 무음 쓰기 권한이 있어야 합니다. Grafana라면 Editor 이상의 서비스 계정이 필요하며, Viewer로는 403을 받고 화면에 "저장소가 쓰기를 거부"가 표시됩니다.
  - 모든 무음에 `<clusterLabel>="<값>"` 조건이 붙으므로 그 클러스터의 알림만 멈추며, 기간은 최대 `silenceMaxHours`(168)입니다.
- **트레이스 링크**(`features.tracing`을 쓸 때): 로그 줄의 trace ID는 Loki 라벨에서 먼저 찾습니다.
  - 앱이 OTLP로 로그를 보내면 Loki가 trace ID를 구조화 메타데이터 `trace_id`로 줄과 함께 돌려주므로(Loki 3.x, 10-14 kind 실측) 따로 할 일이 없습니다.
  - 위 예시처럼 컨테이너 로그를 파일에서 읽는 수집기는 trace ID를 알 수 없으므로, 줄 내용(`trace_id=…` 등)에서 찾습니다.
    - 앱이 로그 문장에 trace ID를 쓰거나, 수집기에서 JSON 줄을 파싱해 값을 trace 필드로 옮기면 됩니다.
  - 트레이스 저장소(Jaeger·Tempo)는 브라우저가 링크로 여는 곳이므로 Kubeast와 직접 통신하지 않습니다.

```yaml
# OpenTelemetry Collector contrib 0.163.1 — 노드의 컨테이너 로그를 Loki로 (DaemonSet, /var/log/pods 읽기 전용 마운트)
receivers:
  file_log:
    include: [/var/log/pods/*/*/*.log]
    include_file_path: true
    operators:
      - type: container          # 경로에서 k8s.namespace.name·k8s.pod.name·k8s.container.name
processors:
  resource:
    attributes:
      - {key: k8s.cluster.name, value: prod-1, action: upsert}
exporters:
  otlp_http:
    endpoint: https://loki.example.com/otlp
service:
  pipelines:
    logs: {receivers: [file_log], processors: [resource], exporters: [otlp_http]}
```

- **확인**: Loki의 `/loki/api/v1/label/k8s_cluster_name/values`에 그 값이 보이는지, Kubeast에서 그 클러스터의 Pod 로그를 검색했을 때 줄이 나오는지 봅니다.
  - 개발용 전체 예시: `scripts/kind-logsearch.sh`(`deploy/kind/logsearch-*.yaml`)

## 15. Kubeast가 설치되는 클러스터

| 항목 | 조건 |
| --- | --- |
| 사용자 네임스페이스 | `podSecurity.hostUsers: false`(기본)를 쓰려면 Kubernetes 1.33 이상과 이를 지원하는 노드 커널(6.3 이상)이 필요합니다. 조건이 맞지 않으면 `true` |
| 저장소 | 내장 PostgreSQL을 쓰면 PVC — 기본 StorageClass 또는 `postgresql.storageClassName` |
| 노출 | NodePort(기본)·LoadBalancer, 또는 Ingress 컨트롤러(`ingress.enabled`) |
| NetworkPolicy | `networkPolicy.enabled`(기본 켬)는 NetworkPolicy를 지원하는 CNI(Calico·Cilium·EKS VPC CNI 네트워크 정책)에서만 효과가 있습니다 |
| 콘솔 메트릭 수집 | `metrics.serviceMonitor`·`metrics.prometheusRule`을 켜려면 prometheus-operator CRD가 필요합니다([metrics.md](metrics.md)) |
| EKS 외부 클러스터·S3 | IRSA 롤(`aws.irsaRoleArn` 등) |
| 사설 CA·TLS를 가로채는 프록시 | `customCAs`에 적은 Secret·ConfigMap이 릴리스 네임스페이스에 먼저 있어야 합니다. 없으면 새 파드가 볼륨을 기다리느라 뜨지 않으며, 이전 파드는 계속 응답합니다 |

## 검증한 버전 (2026-10-13)

| 구성 | 버전 | 검증 방법 |
| --- | --- | --- |
| prometheus-community/prometheus | 차트 29.37.0(Prometheus v3.15.0) | 예시 값 그대로 kind에 설치(29.36.1) → Kubeast가 `monitoring/prometheus-server:9090` 발견, cAdvisor·node-exporter·kube-state-metrics 지표 조회, 최적화 source `prometheus`. 29.37.0은 예시 값 렌더 결과에서 차트 레이블만 다릅니다 |
| opencost/opencost | 차트 2.5.33(OpenCost 1.121.3) | 예시 값 그대로 설치(2.5.32) → `opencost/opencost:9003` 발견, 비용 Namespace별 행. 2.5.33은 예시 값 렌더 결과에서 차트 레이블만 다릅니다 |
| `scripts/render-target-rbac.sh` + `cluster-values.yaml` | — | 적용 전 Read 비용·Prometheus 조회 403 → 적용 뒤 200 |
| kube-prometheus-stack | 92.3.0 | 렌더로 Service 이름·포트만 확인 |
| metrics-server | 0.9.0 | 개발용 2번 클러스터(`deploy/kind/second-cluster.yaml`) |
| Kyverno | 1.19.2(차트 3.9.2) | 개발용 2번 클러스터 |
| Alertmanager | v0.34.1 | 개발용 2번 클러스터 — `amtool alert add`로 넣은 알림이 웹훅으로 들어와 조사됩니다(e2e `alert-investigation.spec.ts`) |
| Loki · OpenTelemetry Collector contrib | 3.7.9 · 0.163.1 | 10-14에 3.7.8 · 0.162.0으로 검증하고 10-21에 올렸습니다. 개발용 2번 클러스터의 Loki 하나에 두 클러스터의 수집기가 로그를 보냅니다 — Job 로그를 텍스트와 워크로드로 찾을 수 있고, 다른 클러스터에서는 0줄이며, Job을 삭제한 뒤에도 찾습니다(e2e `log-search.spec.ts`) |
| OpenTelemetry Collector contrib `host_metrics` | 0.163.1 | 10-17에 0.162.0으로 검증하고 10-21에 올렸습니다. 개발용 1번 클러스터(node-exporter 없음, `scripts/kind-hostmetrics.sh`)에서 2번 클러스터 Prometheus로 remote write합니다 — 같은 커널을 보는 2번 클러스터 node-exporter와 비교해 메모리 70.6% / 70.7%, 전체 메모리는 같은 바이트, Load 6.72 / 6.66, CPU 13.3% / 13.5%였고, 노드 드로어와 대시보드가 채워졌습니다(e2e `node-hostmetrics.spec.ts`). 0.162에서는 `hostmetrics`·`prometheusremotewrite`가 폐기 예정 별칭이라 `host_metrics`·`prometheus_remote_write` 이름을 씁니다 |
| VictoriaMetrics | v1.154.1(단일판·클러스터판, vmagent) | 10-20에 v1.154.0으로 검증하고 10-21에 올렸습니다. 개발용 2번 클러스터(`scripts/kind-victoriametrics.sh` — 2번 클러스터 Prometheus와 같은 수집 설정)에서 노드 메모리 합계가 Prometheus·단일판·클러스터판 모두 같은 바이트였습니다. 단일판과 경로를 붙인 vmselect의 `/-/healthy`는 200, 규칙·알림은 빈 자리표시, vmselect 대상 API는 400이라 `up`으로 대신하고, 메타데이터 타입·설명도 읽힙니다(e2e `victoriametrics.spec.ts`) |
| Grafana | 13.2.4 | 10-17, 개발용 2번 클러스터(`scripts/kind-grafana.sh`). 데이터소스 프록시로 읽은 지표·로그가 직접 읽은 값과 같고 대시보드·노드 드로어가 채워집니다. 틀린 토큰은 상태에 401로 나오고, 웹훅 연락처 시험으로 보낸 알림이 조사됩니다(e2e `grafana.spec.ts`) |
| Argo CD | 3.5.6(core 설치) | 10-21, 개발용 2번 클러스터(`scripts/kind-argocd.sh`). Application이 podinfo 차트를 동기화하고, 추적 어노테이션·409·감사 행·드로어 배지·`gitops_status`를 확인했습니다(e2e `argocd-real.spec.ts`) |
| GPU·DRA·VPA·Gateway API·ingress-nginx | — | 코드 기준이며 실제 클러스터에서는 검증하지 않았습니다 |

kind 노드에서는 루트 파일시스템이 `mountpoint="/"`로 잡히지 않아 디스크 사용률이 비어 있고, local-path 볼륨에는 볼륨 통계가 없습니다. 실제 노드와 CSI 드라이버에서는 이 값이 나옵니다.
