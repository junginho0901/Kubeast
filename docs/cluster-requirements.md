# 클러스터 준비물 — Kubeast가 만들지 않는 것

Kubeast는 등록한 클러스터에 아무것도 설치하지 않습니다(노드 셸 파드 하나만 예외, §9). 기능마다 클러스터에 미리 있어야 하는 것이 있고, 없으면 그 기능은 "없음"·"설치 안 됨"·"권한 없음"으로 표시되거나 영역이 숨습니다. 이 문서는 기능별로 **무엇이 있어야 하는지 · Kubeast가 그걸 어떻게 찾는지 · 없으면 어떻게 보이는지 · 어떻게 확인하는지 · 예시**를 적습니다. 예시 파일은 [`deploy/examples/target-cluster/`](../deploy/examples/target-cluster/)에 있습니다.

"대상 클러스터"는 Kubeast가 관리하는 클러스터(설치된 클러스터 자신 포함)이고, Kubeast가 설치되는 클러스터의 조건은 §15에 따로 있습니다.

## 한눈에

| 기능 | 대상 클러스터에 있어야 하는 것 | Kubeast 쪽 스위치(기본) | 없으면 |
| --- | --- | --- | --- |
| 전부 | Kubeast 권한(RBAC) — §1 | `auth.impersonation.enabled`(켬) | 사용자 요청이 클러스터에서 403 |
| 알림 → AI 조사 | 조사 신원 RBAC — §1, Kubeast로 웹훅을 보내는 Alertmanager 또는 Grafana 알림 — §13 | `features.alertInvestigation.enabled`(끔) | 알림이 안 오거나, 조사의 읽기 도구가 클러스터에서 403 |
| 노드·파드 사용량, Monitoring, 최적화(대체) | metrics-server — §2 | — | 사용량 칸이 비고 최적화는 "없음" |
| 드로어·대시보드 그래프, 최적화, 스토리지 분석 | Prometheus + 지표 수집기 — §3 | `features.prometheus.enabled`(**끔**) | 그래프 영역이 숨고 최적화는 metrics-server 순간값 |
| 비용(Cost), 최적화 비용 열 | OpenCost — §4 | `features.cost.enabled`(켬) | "OpenCost 없음" 안내, 비용 열 없음 |
| 정책 보고서 | PolicyReport CRD와 그걸 만드는 도구 — §5 | `features.policyReports.enabled`(켬) | "설치 안 됨" 안내 |
| GPU·DRA | NVIDIA device plugin·GFD 라벨·DCGM exporter, DRA API — §6 | — | GPU 수·사용률이 비거나 DRA "unavailable" |
| VPA·Gateway API·Admission Policy·Ingress 지연 | 해당 CRD·컨트롤러 — §7 | — | 목록이 비고 "설치 안 됨" |
| 재시작 없이 적용(resize) | Kubernetes 1.35 이상 — §8 | `features.inPlaceResize.enabled`(켬) | 버튼이 숨고 API 409 |
| 노드 셸 | 특권 파드 허용과 이미지 — §9 | `nodeShell.enabled`(끔) | 파드 생성 실패 |
| 컨테이너 안 로그 파일 | 이미지에 `ls`·`tail`, exec 권한 — §10 | `features.logFiles.enabled`(끔) | 422 "볼 수 없음" |
| 로그 검색 | 로그를 Loki로 보내는 수집기, `pods/log` 읽기 권한 — §14 | `features.logSearch.enabled`(끔) | 검색이 안 보이고 API 404 |
| AI 알림 읽기 | 알림에 클러스터 레이블(기본 `cluster`)을 붙이는 Alertmanager 또는 Grafana 알림 — §14 끝 | `features.alertStore.enabled`(끔) | `alerts_list`가 빠지고 API 404 |
| AI 트레이스 읽기 | 스팬을 Tempo로 보내는 수집기(리소스 속성 `k8s.cluster.name`·`k8s.namespace.name`), `pods/log` 읽기 권한 — §14 끝 | `features.traceStore.enabled`(끔) | `traces_*` 도구가 빠지고 API 404 |
| 위생·업그레이드 점검의 폐기 API 항목 | API 서버 `/metrics` 읽기 권한 — §11 | `features.hygiene.enabled`(켬) | 그 항목만 "수집 실패" |
| Argo CD 가드 | Argo CD 추적 어노테이션 — §12 | `gitops.argocd.enabled`(끔) | 배지·경고 없음 |

## 1. 권한(RBAC) — 모든 대상 클러스터

Kubeast는 클러스터에 **로그인한 사람으로**(impersonation) 요청하고, 클러스터 RBAC이 최종 상한입니다. 그래서 대상 클러스터마다 아래가 있어야 합니다.

| 무엇 | 왜 | 어디서 |
| --- | --- | --- |
| ClusterRole `kubeast-impersonator` + 바인딩(그룹 `kubeast:impersonator`) | Kubeast 자격이 사용자와 정해진 그룹만 흉내 내게 | [`helm/kubeast/files/impersonation-rbac.yaml`](../helm/kubeast/files/impersonation-rbac.yaml) |
| 그룹 바인딩 `kubeast:viewer`(view + `kubeast:cluster-reader`) · `kubeast:operator`(edit) · `kubeast:admin`(cluster-admin) | Read·Write·Admin 역할이 클러스터에서 할 수 있는 일 | 같은 파일 |
| 커스텀 역할 그룹 `kubeast:role:<이름>`, Namespace 범위 부여 | 커스텀 역할·NS 한정 부여를 쓸 때 | `auth.impersonation.customRoles` → `templates/impersonation-custom-roles.yaml` |
| Read의 Prometheus·OpenCost 프록시 GET | Read가 비용·그래프를 볼 때 | `auth.impersonation.viewerProxyServices` → `templates/impersonation-viewer-proxy.yaml` |
| Admin의 `nodes/proxy` get — AI 도구 `nodes_stats_summary`·`nodes_log` | 노드의 kubelet stats summary·로그 질의를 API 서버 프록시로 읽을 때. `kubeast:admin`(cluster-admin)에는 이미 들어 있고, 커스텀 역할로 Admin 도구를 쓰면 `nodes` get + `nodes/proxy` get을 넣어야 함. `nodes_log`는 kubelet 설정 `enableSystemLogHandler: true` + `enableSystemLogQuery: true`(NodeLogQuery, 1.36 GA)도 필요 — 꺼져 있으면 도구가 unavailable로 답함(kind 기본값은 query 꺼짐) | 차트 `impersonation-rbac`(cluster-admin) · kubelet 설정 |
| 로그 파일 Namespace의 `pods/exec` | 로그 파일 보기를 켤 때(§10) | `features.logFiles` → `templates/logfiles-rbac.yaml` |
| 알림 조사 신원 `kubeast:investigator` — impersonate 허용 + 읽기 전용 ClusterRole(get·list·watch, Secret·exec·프록시·쓰기 없음) | 알림 → AI 조사를 켤 때. Kubeast가 사람 대신 이 신원으로 읽기 도구를 돌린다. 조사가 CRD(Kyverno PolicyReport·Argo Rollout 등)도 읽어야 하면 `features.alertInvestigation.extraRules`에 읽기 규칙을 더한다 — get·list·watch 외 동사, `apiGroups "*"`, Secret·exec·프록시·토큰은 렌더가 거부 | `features.alertInvestigation` → `templates/impersonation-investigator.yaml`(impersonation이 꺼져 있으면 렌더 실패) |

**Write = Kubernetes 기본 `edit`**: Secret 읽기·쓰기, `pods/exec`·`pods/portforward`, 모든 Service 프록시(`services/proxy`)까지 들어 있습니다(kubectl로 `edit`을 받은 사람과 같은 범위). Kubeast 화면의 셸은 Admin만 열지만 클러스터 권한으로는 할 수 있으니, 더 좁혀야 하는 사람에게는 Write 대신 커스텀 역할(`auth.impersonation.customRoles`, Namespace 범위 가능)을 부여합니다.

**Kubeast가 설치된 클러스터**는 차트가 이걸 전부 만듭니다. 값을 바꾸고 `helm upgrade`하면 됩니다(이 클러스터에는 아래 스크립트를 쓰지 않습니다 — 차트가 소유한 객체에 kubectl 주석이 붙습니다).

**등록한 다른 클러스터**에는 Kubeast가 RBAC을 만들지 않으므로 같은 렌더를 직접 적용합니다. 설치 값에 그 클러스터만의 값(Prometheus·OpenCost Service 이름 등, [`cluster-values.yaml`](../deploy/examples/target-cluster/cluster-values.yaml))을 겹쳐 한 번에 렌더합니다. 해당 기능을 안 쓰면 그 템플릿은 비어 있어 건너뜁니다(helm은 빈 `--show-only`에서 멈추므로 스크립트가 템플릿마다 따로 렌더합니다).

```bash
scripts/render-target-rbac.sh -f values.yaml -f cluster-b-values.yaml | kubectl --context cluster-b apply -f -
# OCI 차트로 설치했다면: KUBEAST_CHART=oci://<레지스트리>/kubeast scripts/render-target-rbac.sh --version <버전> -f ...
```

**EKS**: Kubeast 파드의 IRSA 롤이 대상 롤을 AssumeRole하고(README "클러스터 연결"), 대상 클러스터의 **access entry가 그 롤을 Kubernetes 그룹 `kubeast:impersonator`에 매핑**해야 합니다(`kubernetesGroups`).

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

노드 목록·Monitoring 화면·노드 드로어의 사용량, 그리고 Prometheus가 없을 때 최적화 표의 사용량(순간값)이 `metrics.k8s.io`를 읽습니다.

- 설치: [metrics-server 차트](https://artifacthub.io/packages/helm/metrics-server/metrics-server) `3.14.0`(앱 0.9.0) — `helm install metrics-server metrics-server/metrics-server --version 3.14.0 -n kube-system`. EKS는 metrics-server 애드온으로도 됩니다. kind처럼 kubelet 인증서가 자체 서명이면 `--kubelet-insecure-tls`가 필요합니다(로컬 전용).
- 확인: `kubectl --context <cluster> top nodes`

## 3. Prometheus

드로어(Pod·워크로드·Service·Namespace·노드·HPA·Ingress)의 그래프, 대시보드 지표, 최적화 표의 CPU p95·메모리 최대, 스토리지 분석이 Prometheus를 읽습니다. **Kubeast 쪽에서 `features.prometheus.enabled: true`를 켜야** 합니다(차트 기본 끔).

### Kubeast가 찾는 방법

- **순서**: 클러스터에 적은 주소 → 클러스터에 적은 Service → 차트 `features.prometheus.url` → 차트 `features.prometheus.service` → 자동 발견.
- **Service 지정**(Admin → Clusters → 편집 "클러스터 안 Service", 또는 차트 `features.prometheus.service`): `namespace/service:port`(Lens·Headlamp와 같은 형식), API가 경로 아래 있으면 그 경로까지 — `namespace/service:port/경로`(예: VictoriaMetrics 클러스터 `monitoring/vmselect-main:8481/select/0/prometheus`). API 서버 프록시로 읽고, 상태 API가 `/-/healthy`로 닿는지와 저장소 종류(`flavor`: prometheus·victoriametrics — `/-/healthy` 답의 글자로)를 알려 줍니다.
- **클러스터 안 자동 발견**: ① 모든 Namespace에서 레이블로 — `kubeast.io/prometheus=true` → prometheus 차트 서버(`app.kubernetes.io/name=prometheus,app.kubernetes.io/component=server`, 포트 80) → Prometheus Operator의 `prometheus-operated`(`operated-prometheus=true`), Service의 포트를 모두 시험 ② 없으면 이름에 `prometheus`가 든 Service 중 **포트 9090**을 `monitoring` → `prometheus` → `jupyterhub` → `kube-system` → `gpu-operator` → `observability` → `default` 순서로. `/-/healthy`가 답하면 쓰고, 찾은 결과는 클러스터마다 10분 기억합니다. 찾기는 개요 캐시 식별자(`kubeast:cache`, `view`)로 하므로 모든 Namespace의 Service 목록을 읽을 수 있어야 합니다(§1 그대로).
- **중앙 저장소**(Thanos·Mimir·VictoriaMetrics 등 Prometheus 호환 API): Admin → Clusters → 편집에 주소·인증·클러스터 레이블 값을 적습니다(README "Prometheus 소스"). 이때 아래 지표가 그 클러스터 레이블을 달고 있어야 합니다.
- **Grafana를 거쳐**: 저장소 조회 API를 밖에 열지 않고 Grafana 데이터소스로만 둔 곳이면 주소에 Grafana 데이터소스 프록시 `https://<Grafana>/api/datasources/proxy/uid/<데이터소스 UID>`를, 인증에 Grafana 서비스 계정 토큰(Viewer, bearer)을 적습니다. Kubeast 질의는 모두 GET이라 Grafana의 Prometheus 프록시 제한(POST 일부만 허용)에 걸리지 않고, 질의 시간은 Grafana `dataproxy.timeout`(기본 30초)도 받습니다. Grafana OSS는 데이터소스별 권한이 없어 그 토큰으로 모든 데이터소스를 읽을 수 있으니 시크릿으로 다룹니다. 로그 저장소(§14)도 같은 방식입니다.
- 자동 발견이 못 찾는 설치(다른 이름·레이블)는 Service에 `kubeast.io/prometheus=true`를 붙이거나 Service를 직접 적습니다.

### VictoriaMetrics

Prometheus 질의 API를 그대로 쓰므로 화면·AI 도구 모두 같은 질의로 읽습니다(검증: v1.154.1 단일판·클러스터판, 2번 클러스터 Prometheus와 같은 값). 다른 점만:

- **찾기**: Prometheus가 없을 때 단일판을 자동으로 찾습니다 — VM operator의 `app.kubernetes.io/name=vmsingle`·Helm 차트의 `app.kubernetes.io/name=victoria-metrics-single` 레이블, 그다음 이름에 `vmsingle`·`victoria-metrics`가 든 8428 Service. Prometheus가 있으면 Prometheus가 먼저입니다. 클러스터판은 테넌트 경로가 필요해 자동으로 찾지 않습니다 — Service를 경로까지 적거나(`monitoring/vmselect-<이름>:8481/select/<테넌트>/prometheus`) 중앙 저장소 주소로(`http://vmselect-<이름>.<ns>.svc:8481/select/0/prometheus`, 클러스터 레이블 값과 함께).
- **알림 규칙**(AI `prometheus_rules`): 규칙은 vmalert에 있고, 단일판·vmselect에 `-vmalert.proxyURL=<vmalert 주소>`가 있어야 `/api/v1/rules`가 그 규칙을 돌려줍니다. 없으면 VM은 빈 목록을 주므로 Kubeast가 저장소 종류를 보고 "이 저장소는 규칙을 안 준다"로 바꿔 답합니다("규칙 없음"이라고 틀리게 말하지 않도록).
- **수집 대상**(AI `prometheus_targets`): 단일판이 스스로 긁으면(`-promscrape.config`) 그 목록, vmagent·원격 쓰기로 받으면 빈 목록이고 vmselect는 그 API가 없어 400 `unsupported path requested` — 둘 다 `up` 지표로 대신합니다.
- **메타데이터**(AI `prometheus_metrics`의 타입·설명): v1.137부터 기본으로 저장(`-enableMetadata`, 메모리에만 — 재시작하면 다시 쌓일 때까지 이름만).
- **클러스터 레이블 주입**: 여러 클러스터가 쓰는 저장소면 Kubeast가 Prometheus 파서로 `cluster="<값>"`을 넣으므로 MetricsQL 전용 문법(`WITH`, `[d]` 없는 `rate(x)` 등)은 400으로 거부됩니다. 클러스터 하나만 담은 저장소(레이블 값 없음)는 질의를 그대로 보내 MetricsQL도 됩니다.
- **OTLP로 받을 때**: VM은 점 이름을 그대로 저장하므로 hostmetrics를 OTLP로 보내면 `-opentelemetry.usePrometheusNaming`이 필요합니다(원격 쓰기는 수집기가 이미 바꿔 보냄).
- **Read 사용자**: 클러스터 안 Service로 읽으면 `auth.impersonation.viewerProxyServices`에 `<ns>/<service>:<port>`(경로 없이)를 적습니다 — Prometheus와 같음.

### 있어야 하는 지표

| 지표 | 내는 곳 | 쓰는 화면 |
| --- | --- | --- |
| `container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`(라벨 `namespace`·`pod`·`container`) | kubelet의 cAdvisor(`/metrics/cadvisor`) | 최적화 표, Pod·워크로드·Service·Namespace 드로어 |
| `node_cpu_seconds_total`, `node_memory_MemAvailable_bytes`·`MemTotal_bytes`, `node_filesystem_avail_bytes`·`size_bytes`(`mountpoint="/"`), `node_load1`, `node_network_*_bytes_total`, `node_disk_*_bytes_total` — 또는 아래 hostmetrics 이름 | node-exporter 또는 OpenTelemetry Collector `hostmetrics` | 대시보드, 노드 드로어 |
| `kube_pod_info`, `kube_pod_container_status_restarts_total`, `kube_horizontalpodautoscaler_status_current_replicas` | kube-state-metrics | 대시보드, Namespace·워크로드·HPA 드로어 |
| `kubelet_volume_stats_used_bytes`·`capacity_bytes`·`available_bytes` | kubelet `/metrics` — CSI 드라이버가 볼륨 통계를 내야 함(hostPath·local-path는 안 냄 → N/A) | 스토리지 분석 |
| `DCGM_FI_DEV_GPU_UTIL`, `DCGM_FI_DEV_FB_USED`·`FB_FREE`, `DCGM_FI_DEV_MEMORY_TEMP` | NVIDIA DCGM exporter | GPU 화면 |
| `nginx_ingress_controller_request_duration_seconds_bucket` | ingress-nginx 컨트롤러 | Ingress 드로어 지연(P50/P95/P99) |
| OpenCost가 내는 지표 | OpenCost(§4) | 비용 |

**노드 드로어의 노드별 값**: node-exporter 시리즈의 `instance`가 **노드 이름이나 노드 주소(InternalIP·ExternalIP)**여야(포트는 있어도 없어도 됨) 그 노드의 값을 고릅니다. 아래 두 차트의 기본값 `instance=<노드 IP>:9100`은 그대로 맞습니다. 그 밖의 형식(예: node-exporter 파드 IP)이면 노드 드로어의 카드와 24시간 추세가 비어 보입니다 — 다른 노드 값으로 대신 채우지 않습니다. 그때는 scrape 설정의 `relabelings`로 `instance`를 노드 이름(`__meta_kubernetes_pod_node_name`)으로 바꿉니다. 디스크·네트워크 I/O는 그 노드 장치를 합친 값(`device!="lo"`, node-exporter node-mixin과 같은 방식)입니다. 대시보드처럼 클러스터 전체를 합치는 값은 영향이 없습니다.

**node-exporter 대신 OpenTelemetry `hostmetrics`**: 노드 질의는 모두 "node-exporter 식 `or` hostmetrics 식"이라 저장소에 있는 쪽이 나옵니다(둘 다 있으면 node-exporter). 고르는 설정은 없습니다. hostmetrics로 갈 때 맞출 것:

- **이름**: Prometheus식 이름 변환 그대로 — `system_cpu_time_seconds_total{state}`와 `system_cpu_logical_count`(CPU 사용률 = 1 − 유휴 초 ÷ 논리 CPU 수, node-exporter와 같은 셈), `system_memory_usage_bytes{state="used"}`와 `system_memory_limit_bytes`, `system_filesystem_usage_bytes{mountpoint="/",state}`, `system_cpu_load_average_1m`, `system_network_io_bytes_total{direction,device}`, `system_disk_io_bytes_total{direction,device}`. OTel `prometheus_remote_write` exporter(0.162 전 이름 `prometheusremotewrite`)와 Prometheus의 OTLP 수신은 기본이 이 이름이고, VictoriaMetrics에 OTLP로 보내면 `-opentelemetry.usePrometheusNaming`을 줘야 합니다(기본은 점 이름 그대로).
- **`system.memory.limit` 켜기**(기본 꺼짐): 메모리 사용률 = `used ÷ limit`. 수신기의 MemAvailable 게이트(0.137부터 기본 켬)로 `used` = 전체 − MemAvailable이라 node-exporter의 `1 − MemAvailable/MemTotal`과 같은 값입니다. state들을 더해도 전체가 되지 않으므로 합으로 나누지 않습니다.
- **노드 레이블 `k8s_node_name`** = 노드 이름: 리소스 속성 `k8s.node.name`(downward API `spec.nodeName`)을 레이블로 — `prometheus_remote_write`의 `resource_constant_labels.included: [k8s.node.name]`, Prometheus OTLP면 `promote_resource_attributes`.
- **수집기를 올린 직후**: 수집기 판이 레이블 `otel_scope_version`에 들어가고 멈춘 수집기는 끝 표시를 보내지 않아, 판을 올린 뒤 몇 분(조회 창, 기본 5분) 동안 같은 시리즈가 두 벌 있습니다. Kubeast의 노드 질의는 `max without (otel_scope_name, otel_scope_version)`로 한 벌만 셉니다 — 직접 `sum`을 쓰는 대시보드·알림 규칙도 같게 하세요(dev 0.162.0 → 0.163.1에서 7분 동안 합계 2배를 봄).
- **호스트 읽기**: `root_path: /hostfs`에 호스트 `/`를 읽기 전용으로 마운트(opentelemetry-collector 차트의 hostMetrics 프리셋과 같음). 네트워크는 `hostNetwork: true`일 때만 노드 인터페이스 값입니다 — 아니면 수집기 파드 자기 트래픽이 되므로 그때는 `network` 스크레이퍼를 끄세요(Kubeast는 그 칸을 숨김). 디스크는 node-exporter 기본 제외(파티션·loop·ram)와 같은 장치를 뺍니다.
- **예시**: [`deploy/kind/hostmetrics-collector.yaml`](../deploy/kind/hostmetrics-collector.yaml)(contrib 0.163.1, `scripts/kind-hostmetrics.sh`).

**AI 도구가 더 읽는 경로**(Prometheus 찾기 도구, 질의와 같은 저장소·같은 클러스터 범위): `/api/v1/label/__name__/values`·`/api/v1/labels`·`/api/v1/label/<이름>/values`(늘 최근 1시간 등 `start`·`end`, 여러 클러스터가 쓰는 저장소면 `match[]`에 클러스터 레이블), `/api/v1/metadata`(없으면 이름만), `/api/v1/rules`(VictoriaMetrics는 조회 쪽에 `-vmalert.proxyURL`이 있을 때만 — 없으면 "이 저장소는 규칙을 안 줌"으로 답함, 위 VictoriaMetrics 절), `/api/v1/targets`(클러스터 자기 저장소일 때만 — 여러 클러스터가 쓰는 저장소, 목록이 빈 저장소, 그 API가 없는 저장소는 `up` 지표로 대신). 모두 GET이라 Grafana 데이터소스 프록시로도 읽힙니다.

### 예시

- **prometheus-community/prometheus 차트** — [`prometheus-values.yaml`](../deploy/examples/target-cluster/prometheus-values.yaml). 서버 Service는 레이블로 찾으므로 Namespace·포트(기본 80)와 상관없습니다 — 예시는 Read 프록시 값(`cluster-values.yaml`의 `viewerProxyServices`)과 맞추려고 9090으로 둡니다. 기본 수집 작업(cAdvisor·kubelet·kube-state-metrics·node-exporter)에 OpenCost를 더합니다.

  ```bash
  helm install prometheus prometheus-community/prometheus --version 29.36.1 \
    -n monitoring --create-namespace -f deploy/examples/target-cluster/prometheus-values.yaml
  ```

- **kube-prometheus-stack** `92.3.0`: operator가 만드는 `prometheus-operated`(레이블 `operated-prometheus=true`, 9090 — Prometheus Operator v0.94.1 소스 확인)를 레이블로 찾으므로 어느 Namespace에 설치해도 그대로 찾습니다. 지표도 기본 ServiceMonitor로 다 모입니다(렌더로만 확인).

### 확인

```bash
kubectl --context <cluster> get svc -A | grep -i prometheus      # 이름에 prometheus, 9090
kubectl --context <cluster> get --raw "/api/v1/namespaces/monitoring/services/prometheus-server:9090/proxy/-/healthy"
kubectl --context <cluster> get --raw "/api/v1/namespaces/monitoring/services/prometheus-server:9090/proxy/api/v1/query?query=count(container_cpu_usage_seconds_total)"
```

Kubeast에서는 Admin → Clusters → 편집 → Prometheus "연결 확인"이 `클러스터 안에서 찾음: <ns>/<service>:<port>`를 보여 줍니다. Read 사용자에게 열려면 이 주소를 §1의 `viewerProxyServices`에 적습니다.

## 4. OpenCost (비용)

- **Kubeast가 찾는 방법**: 이름에 `opencost`가 든 Service 중 **포트 9003**을 `opencost`·`kubecost`·`monitoring`·`cost` Namespace에서 찾고 `/healthz`로 확인합니다. 발견은 10분(없음은 5분) 기억합니다.
- **조건**: OpenCost는 Prometheus를 읽고, Prometheus는 OpenCost의 `/metrics`를 다시 수집해야 합니다(OpenCost가 내는 가격·클러스터 지표를 할당 계산에 씀).
- **예시**: [`opencost-values.yaml`](../deploy/examples/target-cluster/opencost-values.yaml) — §3 예시의 Prometheus를 읽도록 한 값.

  ```bash
  helm install opencost opencost/opencost --version 2.5.32 \
    -n opencost --create-namespace -f deploy/examples/target-cluster/opencost-values.yaml
  ```

- **확인**: Prometheus에서 `up{job="opencost"}`가 1, Kubeast 비용 페이지 머리에 `OpenCost <ns>/<service>:<port>`. 단가는 OpenCost가 정합니다(클라우드면 가격 API, 그 밖엔 기본 단가).

## 5. 정책 보고서 (PolicyReport)

`wgpolicyk8s.io/v1alpha2`의 PolicyReport·ClusterPolicyReport CRD와 그 보고서를 만드는 도구가 있어야 합니다. Kubeast는 보고서를 읽기만 합니다.

- **Kyverno**: [Kyverno 차트](https://kyverno.io/docs/installation/methods/) `3.9.2`(Kyverno 1.19.2)이 CRD와 보고서를 만들고, 보고서 읽기를 기본 `view` 롤에 집계해 Read도 읽습니다. 보고서는 정책이 있어야 생기므로 Audit 정책 몇 개부터 둡니다. 개발용 값·정책 예시는 [`deploy/kind/kyverno-values.yaml`](../deploy/kind/kyverno-values.yaml)·[`kyverno-policies.yaml`](../deploy/kind/kyverno-policies.yaml).
- 같은 CRD를 쓰는 다른 도구의 보고서도 읽히지만 Kyverno로만 검증했습니다.
- **확인**: `kubectl --context <cluster> get policyreports -A`

## 6. GPU·DRA

| 무엇 | Kubeast가 보는 것 | 쓰는 화면 |
| --- | --- | --- |
| NVIDIA device plugin | 노드의 `nvidia.com/gpu`·`nvidia.com/mig-*` 자원, DaemonSet `nvidia-device-plugin-daemonset`(`kube-system`·`gpu-operator`·`nvidia-gpu-operator`) 또는 `kube-system/nvidia-device-plugin` | GPU 수·할당, 플러그인 상태 |
| GPU Feature Discovery | 노드 라벨 `nvidia.com/gpu.product`·`gpu.memory`·`mig.strategy`·`cuda.driver.*` | GPU 모델·메모리 |
| time-slicing 설정 | ConfigMap `time-slicing-config`·`nvidia-plugin-configs`·`time-slicing`(위 Namespace) | 시분할 설정 |
| DCGM exporter | §3 표의 `DCGM_FI_DEV_*` 지표 | 사용률·메모리·온도 |
| DRA | `resource.k8s.io`(1.34+ v1, 1.32–1.33 v1beta2/v1beta1, 1.31 v1alpha3)를 API 탐색으로 고름 | DeviceClass·ResourceClaim·ResourceSlice |

NVIDIA GPU Operator를 쓰면 위가 한 번에 들어옵니다. 이 절은 코드 기준이며 실제 GPU 클러스터로 검증하지 않았습니다.

## 7. 있으면 보여 주는 API

CRD가 없으면 Kubeast는 빈 목록과 "설치 안 됨"(`X-Kubeast-Not-Installed`)으로 답합니다.

| 화면 | 있어야 하는 것 |
| --- | --- |
| VerticalPodAutoscalers | `autoscaling.k8s.io/v1` CRD. 추천값은 VPA recommender가 채움 |
| Gateway API | `gateway.networking.k8s.io/v1` CRD(GatewayClass·Gateway·HTTPRoute 등)와 구현체 |
| Gateway 정책 | 라벨 `gateway.networking.k8s.io/policy`가 붙은 CRD(GEP-713), 또는 기본 목록 — BackendTLSPolicy, Envoy Gateway(`gateway.envoyproxy.io`의 BackendTraffic·ClientTraffic·Security·EnvoyPatch·EnvoyExtension Policy), Istio(AuthorizationPolicy·RequestAuthentication·PeerAuthentication·Telemetry·WasmPlugin·EnvoyFilter·DestinationRule) |
| Admission Policies | ValidatingAdmissionPolicy(`admissionregistration.k8s.io/v1`), MutatingAdmissionPolicy(`admissionregistration.k8s.io/v1`) — 서빙하지 않는 클러스터는 "설치 안 됨" |
| Ingress 드로어 지연 | ingress-nginx 컨트롤러와 §3의 `nginx_ingress_controller_*` 수집 |
| AI 도구 `gitops_status` | `applications.argoproj.io` CRD(Argo CD). Argo CD가 설치된 클러스터에만 있으므로 중앙 Argo CD면 관리 클러스터에서 호출 — 없으면 도구가 unavailable로 답함. 읽는 사람의 RBAC(`applications.argoproj.io` get/list)이 상한 |

## 8. Kubernetes 버전 조건

| 기능 | 조건 |
| --- | --- |
| 재시작 없이 적용(Pod `resize` 하위 리소스) | API 서버 1.35 이상 |
| DRA 화면 | 1.31 이상(§6) |
| 업그레이드 준비 점검 | 대상 = 서버 마이너 + 1 (조건 없음) |

## 9. 노드 셸

켜면(`nodeShell.enabled`, Admin만) Kubeast가 대상 클러스터에 Namespace `kubeast-node-shell`(Pod Security `privileged` 라벨)을 만들고, 고른 노드에 특권 파드(hostPID·hostIPC·hostNetwork, 호스트 `/` 마운트)를 띄웁니다.

- 그 Namespace에서 특권 파드를 막는 정책(Kyverno·Gatekeeper 등)이 있으면 예외가 있어야 합니다.
- 노드가 이미지(`nodeShell.images`, 기본 `docker.io/library/busybox:1.38.0`)를 받을 수 있어야 합니다. 폐쇄망이면 사내 미러 주소를 적습니다.
- 사용자는 그 클러스터의 Admin(cluster-admin)이어야 합니다.

## 10. 컨테이너 안 로그 파일

Kubeast가 사용자 신원의 `pods/exec`로 `ls`·`tail`만 실행합니다.

- 컨테이너 이미지에 `ls`·`tail`이 있어야 합니다(distroless는 422).
- Read 그룹이 쓰려면 `features.logFiles.namespaces`의 Namespace마다 `pods/exec` 바인딩이 있어야 합니다 — §1의 렌더(`templates/logfiles-rbac.yaml`)에 포함됩니다.

## 11. 위생·업그레이드 점검의 폐기 API 항목

"폐기 예정 API를 아직 부른다" 항목은 API 서버의 `/metrics`(`apiserver_requested_deprecated_apis`)를 읽습니다. 이건 비리소스 URL 권한(`nonResourceURLs: ["/metrics"]`, `get`)이 필요해서 cluster-admin(Kubeast Admin)으로 돌 때만 채워지고, 권한이 없으면 그 항목만 수집 실패로 표시됩니다. kube-proxy 설정 점검은 `kube-system`의 ConfigMap `kube-proxy`·`kube-proxy-config`를 읽습니다.

## 12. Argo CD 가드

Argo CD가 배포한 객체에 추적 어노테이션(`argocd.argoproj.io/tracking-id`, Argo CD 3.x 기본 추적 방식)이 있어야 배지·경고가 붙습니다. 라벨 방식(`app.kubernetes.io/instance` 등)을 쓰는 설치는 `gitops.argocd.instanceLabel`에 그 키를 적습니다. Argo CD 자체가 대상 클러스터에 있을 필요는 없습니다.

- **검증**: Argo CD 3.5.6 core 설치가 실제로 동기화한 Deployment(`scripts/kind-argocd.sh`, podinfo 차트 6.15.0)에 `<앱>:apps/Deployment:<NS>/<이름>` 어노테이션이 붙고, Kubeast는 그 객체의 삭제·롤백을 409로 막고 `k8s.gitops.refuse` 행을 남기며, 드로어에 배지가 뜨고, `gitops_status`가 그 Application을 kubectl과 같게 읽습니다(e2e `argocd-real.spec.ts`).

## 13. Alertmanager 또는 Grafana 알림 (Alerts 받은편지함 · 알림 → AI 조사)

받은편지함과 조사는 Alertmanager나 Grafana 알림이 보내는 웹훅으로 시작합니다. Kubeast는 알림 엔진을 설치하지 않고, 알림 규칙도 만들지 않습니다.

- **보내는 곳**: `POST <Kubeast 주소>/api/v1/alerts/webhook?cluster=<Kubeast 클러스터 ID>` — 클러스터 ID는 Admin → Clusters의 ID. 클러스터마다 수신자(또는 `cluster` 값)를 따로 둡니다.
- **인증**: `Authorization: Bearer <kubeast-secrets의 ALERT_WEBHOOK_TOKEN>`. 차트가 만들고 업그레이드 때 유지합니다(`secrets.existingSecret`이면 그 Secret에 넣어야 함).
- **받은편지함**: 받은 알림은 심각도와 상관없이, 울리는 중·해결됨 모두 Alerts 메뉴에 1건 1행으로 남습니다(같은 클러스터·fingerprint·`startsAt`). 해결 소식이 필요하니 `send_resolved: true`(웹훅의 기본값)로 둡니다. Alertmanager는 울리는 알림의 `endsAt`을 웹훅으로 보내지 않으므로, 마지막으로 받은 뒤 `features.alertInvestigation.inbox.staleAfterHours`(기본 8 — `repeat_interval`의 2배로) 동안 소식이 없으면 "상태 확인 안 됨"으로 보입니다. §14의 알림 저장소(`features.alertStore`)가 그 클러스터에 있으면 화면이 Alertmanager의 지금 상태(울리는 중·무음·억제·없음)도 함께 봅니다.
- **조사되는 알림**: `status=firing`이고 `severity` 라벨이 `features.alertInvestigation.severities`(기본 critical·warning)에 있는 것. 같은 클러스터·fingerprint는 `dedupeHours`(기본 24) 안에선 다시 조사하지 않습니다 — Alertmanager는 `repeat_interval`(기본 4h)마다 다시 보냅니다. resolved는 조사하지 않습니다(받은편지함의 해결 표시에만 씀).
- **`namespace` 라벨**: 있으면 조사가 그 Namespace로 한정됩니다(토큰의 `ns`). 없으면 클러스터 전체를 읽습니다.
- **Kubeast 쪽**: `features.alertInvestigation.enabled: true`(`auth.impersonation.enabled`·`ai.enabled`도 켜져 있어야 함 — 아니면 차트 렌더 실패), 모델 하나(기본 모델 또는 `model`), 대상 클러스터에 §1의 조사 신원 RBAC.

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

- **Grafana 알림**: 웹훅 연락처(Contact point → Webhook)의 URL을 위와 같이, Authorization 헤더 scheme `Bearer`·credentials에 토큰. Grafana 13의 웹훅 본문(`version` "1")에도 Kubeast가 읽는 필드(`alerts[]`의 `status`·`labels`·`annotations`·`startsAt`·`fingerprint`, `externalURL`)가 같은 이름으로 있어 그대로 받습니다. 알림 정책으로 클러스터마다 그 연락처로 보내고, 규칙 레이블에 `severity`(필요하면 `namespace`)를 둡니다.
- **확인**: Kubeast Alerts 메뉴에 그 알림이 생기는지, Admin → Investigations에 조사 행이 생기는지(심각도 필터에 걸리면 조사 행은 없음). 웹훅 응답 `{accepted, duplicate, filtered, skipped, resolved, dropped, stored}`가 Alertmanager 로그에 남습니다. 개발용 전체 예시는 [`deploy/kind/alertmanager.yaml`](../deploy/kind/alertmanager.yaml), Grafana는 `scripts/kind-grafana.sh`와 e2e `grafana.spec.ts`(연락처 시험으로 보낸 알림이 조사됨).

## 14. 로그 저장소 (로그 검색)

Kubeast는 Loki의 `query_range`(AI의 `loki_query`는 메트릭 쿼리도)·`labels`·`label/<이름>/values`·`patterns`를 읽기만 합니다(모두 GET — Grafana 데이터소스 프록시로도 됨). Loki와 수집기는 설치하지 않습니다. 패턴(`loki_patterns`)은 Loki에 `pattern_ingester: enabled: true`가 있어야 하고, 없으면 그 도구만 "없음"으로 답합니다(Loki는 창 안에서 30줄 이상인 패턴만, 최근 3시간치를 돌려줌).

- **수집기**: 대상 클러스터의 컨테이너 로그를 Loki로 보내는 것. 라벨 이름이 `features.logSearch.labels`와 맞아야 합니다 — 기본값은 Loki가 OTLP로 받은 로그에 붙이는 `k8s_cluster_name`·`k8s_namespace_name`·`k8s_pod_name`·`k8s_container_name`(OpenTelemetry Collector `file_log` + `container` 파서 또는 `k8sattributes`, `otlp_http` → Loki `/otlp`; 0.162 전 이름 `filelog`·`otlphttp`는 경고와 함께 아직 동작). Promtail·Alloy의 쿠버네티스 탐색식이면 `namespace`·`pod`·`container`로 바꿉니다.
- **클러스터 라벨**: Loki 하나에 여러 클러스터를 넣으면 클러스터마다 다른 `k8s.cluster.name`(수집기의 resource 프로세서)을 붙이고, 그 값을 `features.logSearch.clusters`에 Kubeast 클러스터 ID와 짝지어 적습니다. 적지 않은 클러스터는 검색이 없습니다.
- **클러스터별 저장소**: 로그가 다른 Loki에 있는 클러스터는 Admin → Clusters → 편집에서 그 저장소의 주소·인증·테넌트·레이블 값을 적습니다(`features.logSearch.url`보다 먼저 쓰임). 라벨 이름은 배포 전체 값과 같아야 하므로 그 저장소의 수집기도 같은 라벨 이름으로 보내야 합니다. 그 저장소의 호스트·포트도 네트워크 정책(아래)에 넣습니다.
- **권한**: 사용자 신원으로 `get pods/log`(그 Namespace, 전체 검색은 전체)를 묻습니다. `view`·`edit`에 들어 있으므로 §1의 Read·Write 그룹이면 됩니다. Namespace 범위 부여는 그 Namespace에 바인딩이 있어야 합니다.
- **네트워크**: k8s-service에서 Loki로. `networkPolicy`가 켜져 있고 443이 아닌 포트면 `features.logSearch.egressCIDRs`.
- **Grafana를 거쳐**(§3과 같음): 주소 = `https://<Grafana>/api/datasources/proxy/uid/<Loki 데이터소스 UID>`, 인증 = 서비스 계정 토큰, **테넌트는 비움** — 데이터소스에 설정한 `X-Scope-OrgID`를 Grafana가 붙입니다(Kubeast는 테넌트 칸이 비면 그 헤더를 보내지 않음).
- **AI 트레이스 읽기**(`features.traceStore`, 쓸 때): Kubeast는 Tempo의 `/api/search`·`/api/v2/traces/<id>`·`/api/v2/search/tags`·`/api/v2/search/tag/<t>/values`·`/api/metrics/query_range`를 읽기만 합니다(모두 GET — Grafana 데이터소스 프록시로도). 스팬의 **리소스 속성**에 클러스터 값(`k8s.cluster.name` — 수집기의 resource 프로세서)과 네임스페이스(`k8s.namespace.name` — `k8sattributes`)가 있어야 그 클러스터·NS로 거를 수 있습니다(값 = `features.traceStore.clusters`). TraceQL 지표(`traces_metrics`)는 Tempo 3.x에서 기본 제공(2.x는 metrics-generator `local-blocks` 필요). 지표는 Tempo `query_frontend.query_end_cutoff`(기본 30초)와 단계만큼 최근 구간이 빠집니다 — 확인: `/status/config`에서 그 값. 읽는 권한은 로그 검색과 같이 사용자 신원 `get pods/log`.
- **AI 알림 읽기**(`features.alertStore`, 쓸 때): Kubeast는 알림 저장소의 `/api/v2/alerts`(매처 `filter`)와 `/api/v2/silences`를 GET으로 읽습니다(무음 쓰기를 켜면 아래 한 줄 더) — Alertmanager API v2, Grafana 데이터소스 프록시로 가는 Alertmanager, Grafana 알림의 Alertmanager 호환 API(`/api/alertmanager/grafana/api/v2/…`, Grafana 13.2.4에서 Viewer로 200 확인 — `…/status`는 Viewer 403이라 안 씀). 여러 클러스터가 쓰는 저장소면 알림마다 **클러스터 레이블**(기본 `cluster` — Prometheus `external_labels` 또는 Grafana 알림 규칙 레이블)이 있어야 그 클러스터 것만 거릅니다(값 = `features.alertStore.clusters`). 확인: `curl -G <url>/api/v2/alerts --data-urlencode 'filter=cluster="<값>"'`.
- **무음 쓰기**(`features.alertStore.silences: true`, 쓸 때): Alerts 화면에서 `resource.alert.silence`를 가진 사람이 만들면 `POST /api/v2/silences`, 끝내면 `DELETE /api/v2/silence/<id>`를 보냅니다(Alertmanager API v2 · Grafana 데이터소스 프록시 · Grafana 알림의 호환 API). 그래서 그 인증에 무음 쓰기 권한이 있어야 합니다 — Grafana면 Editor 이상의 서비스 계정(Viewer로는 403, 화면에 "저장소가 쓰기를 거부"). 무음마다 `<clusterLabel>="<값>"` 조건이 붙어 그 클러스터 알림만 멈추고, 기간은 `silenceMaxHours`(168)까지입니다.
- **트레이스 링크**(`features.tracing`, 쓸 때): 줄의 trace ID를 Loki 라벨에서 먼저 읽습니다. 앱이 OTLP로 로그를 보내면 Loki가 trace ID를 구조화 메타데이터 `trace_id`로 줄과 함께 돌려주므로(Loki 3.x, 10-14 kind 실측) 따로 할 일이 없습니다. 위처럼 컨테이너 로그를 파일로 읽는 수집기는 trace ID를 모르므로 줄 글자(`trace_id=…` 등)에서 찾습니다 — 앱이 로그 문장에 trace ID를 쓰거나, 수집기에서 JSON 줄을 파싱해 trace 필드로 옮기면 됩니다. 트레이스 저장소(Jaeger·Tempo)는 브라우저가 링크로 여는 곳이라 Kubeast 쪽 통신은 없습니다.

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

- **확인**: Loki에서 `/loki/api/v1/label/k8s_cluster_name/values`에 그 값이 보이는지, Kubeast에서 그 클러스터의 Pod 로그 검색이 줄을 돌려주는지. 개발용 전체 예시는 `scripts/kind-logsearch.sh`(`deploy/kind/logsearch-*.yaml`).

## 15. Kubeast가 설치되는 클러스터

| 무엇 | 조건 |
| --- | --- |
| 사용자 네임스페이스 | `podSecurity.hostUsers: false`(기본)는 Kubernetes 1.33 이상과 이를 지원하는 노드 커널(6.3 이상)이 필요. 아니면 `true` |
| 저장소 | 내장 PostgreSQL을 쓰면 PVC — 기본 StorageClass 또는 `postgresql.storageClassName` |
| 노출 | NodePort(기본)·LoadBalancer, 또는 Ingress 컨트롤러(`ingress.enabled`) |
| NetworkPolicy | `networkPolicy.enabled`(기본 켬)는 NetworkPolicy를 지원하는 CNI(Calico·Cilium·EKS VPC CNI 네트워크 정책)에서만 효과 |
| 콘솔 메트릭 수집 | `metrics.serviceMonitor`·`metrics.prometheusRule`을 켜면 prometheus-operator CRD 필요([metrics.md](metrics.md)) |
| EKS 외부 클러스터·S3 | IRSA 롤(`aws.irsaRoleArn` 등) |
| 사설 CA·TLS 가로채는 프록시 | `customCAs`에 적은 Secret·ConfigMap이 릴리스 네임스페이스에 먼저 있어야 함(없으면 새 파드가 볼륨을 기다리며 안 뜸 — 이전 파드는 계속 응답) |

## 검증한 버전 (2026-10-13)

| 구성 | 버전 | 어떻게 |
| --- | --- | --- |
| prometheus-community/prometheus | 차트 29.37.0(Prometheus v3.15.0) | 예시 값 그대로 kind에 설치(29.36.1) → Kubeast가 `monitoring/prometheus-server:9090` 발견, cAdvisor·node-exporter·kube-state-metrics 지표 조회, 최적화 source `prometheus`. 29.37.0은 예시 값 렌더가 차트 레이블만 다름 |
| opencost/opencost | 차트 2.5.33(OpenCost 1.121.3) | 예시 값 그대로 설치(2.5.32) → `opencost/opencost:9003` 발견, 비용 Namespace별 행. 2.5.33은 예시 값 렌더가 차트 레이블만 다름 |
| `scripts/render-target-rbac.sh` + `cluster-values.yaml` | — | 적용 전 Read 비용·Prometheus 조회 403 → 적용 뒤 200 |
| kube-prometheus-stack | 92.3.0 | 렌더로 Service 이름·포트만 확인 |
| metrics-server | 0.9.0 | 개발용 2번 클러스터(`deploy/kind/second-cluster.yaml`) |
| Kyverno | 1.19.2(차트 3.9.2) | 개발용 2번 클러스터 |
| Alertmanager | v0.34.1 | 개발용 2번 클러스터 — `amtool alert add`로 넣은 알림이 웹훅으로 와서 조사됨(e2e `alert-investigation.spec.ts`) |
| Loki · OpenTelemetry Collector contrib | 3.7.9 · 0.163.1 | 10-14(3.7.8 · 0.162.0), 10-21 올림, 개발용 2번 클러스터의 Loki 하나에 두 클러스터 수집기 — Job 로그를 텍스트·워크로드로 찾고 다른 클러스터에선 0줄, Job 삭제 뒤에도 찾음(e2e `log-search.spec.ts`) |
| OpenTelemetry Collector contrib `host_metrics` | 0.163.1 | 10-17(0.162.0), 10-21 올림, 개발용 1번 클러스터(node-exporter 없음, `scripts/kind-hostmetrics.sh`) → 2번 클러스터 Prometheus remote write — 같은 커널을 보는 2번 클러스터 node-exporter와 메모리 70.6% / 70.7%, 전체 메모리 같은 바이트, Load 6.72 / 6.66, CPU 13.3% / 13.5%, 노드 드로어·대시보드가 채워짐(e2e `node-hostmetrics.spec.ts`). 0.162에선 `hostmetrics`·`prometheusremotewrite` 이름이 폐기 예정 별칭이라 `host_metrics`·`prometheus_remote_write`로 씀 |
| VictoriaMetrics | v1.154.1(단일판·클러스터판, vmagent) | 10-20(v1.154.0), 10-21 올림, 개발용 2번 클러스터(`scripts/kind-victoriametrics.sh` — 2번 클러스터 Prometheus와 같은 수집 설정) — 노드 메모리 합계가 Prometheus·단일판·클러스터판 모두 같은 바이트, 단일판·경로 붙은 vmselect의 `/-/healthy` 200, 규칙·알림은 빈 자리표시, vmselect 대상 API 400 → `up`, 메타데이터 타입·설명 있음(e2e `victoriametrics.spec.ts`) |
| Grafana | 13.2.4 | 10-17, 개발용 2번 클러스터(`scripts/kind-grafana.sh`) — 데이터소스 프록시로 읽은 지표·로그가 직접 읽은 값과 같고 대시보드·노드 드로어가 채워짐, 틀린 토큰은 상태에 401, 웹훅 연락처 시험으로 보낸 알림이 조사됨(e2e `grafana.spec.ts`) |
| Argo CD | 3.5.6(core 설치) | 10-21, 개발용 2번 클러스터(`scripts/kind-argocd.sh`) — Application이 podinfo 차트를 동기화, 추적 어노테이션·409·감사 행·드로어 배지·`gitops_status`(e2e `argocd-real.spec.ts`) |
| GPU·DRA·VPA·Gateway API·ingress-nginx | — | 코드 기준, 실제 클러스터 검증 안 함 |

kind 노드는 루트 파일시스템이 `mountpoint="/"`로 잡히지 않아 디스크 사용률이 비고, local-path 볼륨은 볼륨 통계가 없습니다 — 실제 노드·CSI 드라이버에서는 나오는 값입니다.
