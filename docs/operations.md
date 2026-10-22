# 운영 기능

## 정책 보고서 (Policy Reports)

Kyverno·Trivy Operator 같은 정책 엔진이 리소스마다 쓰는 `wgpolicyk8s.io/v1alpha2` `PolicyReport`(Namespace 리소스)·`ClusterPolicyReport`(클러스터 리소스)를 **읽기만** 해서 모아 보여 줍니다. Kubeast는 정책을 만들거나 데이터를 저장하지 않습니다.

- **화면** — Security → Policy Reports: fail·warn·error·pass·skip 합계, 정책별(분류·심각도·출처·Namespace 수)·Namespace별 탭, 결과 탭(결과·심각도·정책·Namespace·검색 필터, 행을 누르면 그 리소스 드로어). 워크로드·Pod 드로어의 "Policy violations" 절은 그 리소스의 fail/warn/error 행이며 워크로드는 자기 파드의 행을 함께 보여 줍니다(대부분의 정책이 Pod를 봄). CRD가 없는 클러스터는 "설치되어 있지 않습니다", 드로어 절은 숨김.
- **API** — `GET /api/v1/cluster/policyreports/status`(켜짐·CRD 유무) · `…/summary?namespace=`(정책별·Namespace별 집계 — 보고서의 `summary`가 아니라 결과 행을 셈) · `…/results?namespace=&policy=&result=fail,warn&severity=&kind=&search=&limit=`(기본 fail·warn·error, 최대 2,000행, `total`은 자르기 전 수) · `GET /api/v1/cluster/namespaces/{ns}/policyreports/resource?kind=&name=`. 데이터 라우트는 CRD가 없으면 빈 목록 + `X-Kubeast-Not-Installed`.
- **신원·범위** — 보고서는 **로그인 사용자로** 읽으므로 클러스터 RBAC이 상한입니다. Kyverno 차트 기본(`rbac.roles.aggregate.view: true`)이 `view`에 보고서 읽기를 붙이므로 Read(`kubeast:viewer`)도 읽힙니다. Namespace 범위 부여는 그 Namespace들의 보고서만 Namespace마다 따로 읽고(전체 목록 없음), ClusterPolicyReport는 클러스터 전체 보기에서만.
- **무게** — 열 때만 읽고 결과를 클러스터·Namespace·사용자별로 60초 둡니다(`force_refresh=true` = 화면의 새로고침은 그 캐시를 건너뛰고 다시 읽어 캐시를 갈아 끼움 — Kyverno는 새 객체의 보고서를 Pod·Deployment 약 20초, ReplicaSet 약 40초 뒤에 씀). 보고서 5,000개·결과 50,000행에서 읽기를 멈추고 `truncated: true`(화면 안내 — Namespace나 정책으로 좁히면 됨). 500개씩 페이지로 받습니다.
- 권한 `resource.policyreport.read`(Read 역할의 `resource.*.read`에 포함), 차트 `features.policyReports.enabled`(기본 켬, 끄면 404·메뉴·절 숨김), 감사 없음(일반 읽기). dev 2번 클러스터의 Kyverno·정책은 `deploy/kind/kyverno-*.yaml`.

## 클러스터 위생 점검 (Cluster hygiene)

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

## Argo CD 가드 (GitOps)

Argo CD가 배포한 객체에는 추적 어노테이션(`argocd.argoproj.io/tracking-id`, 값 `<앱>:<group>/<Kind>:<ns>/<이름>`)이 붙습니다. `gitops.argocd.enabled: true`면 콘솔이 그 표식을 읽어 드로어 머리에 "Argo CD · <앱>" 배지를 달고(`url`을 적으면 Argo CD 앱 페이지로 링크), 콘솔에서 그 객체를 바꾸려 할 때:

- `mode: warn`(기본) — 확인창에서 "다음 동기화 때 되돌아갑니다, Git에서 바꾸세요"를 알린 뒤 진행합니다.
- `mode: block` — k8s-service가 쓰기 요청을 409로 거부하고(`managed by Argo CD application <앱>; change it in Git`), AI 쓰기 도구(apply·delete·patch·scale·rollout)도 같은 이유로 거부합니다. 드로어의 삭제·YAML 적용 버튼은 비활성입니다.

어노테이션은 그 객체 자신을 가리킬 때만 인정합니다(파드 템플릿을 따라 복사된 어노테이션은 무시). 아직 라벨 방식(`app.kubernetes.io/instance` 또는 `argocd-cm`의 `application.instanceLabelKey`)을 쓰는 설치는 `instanceLabel`에 그 키를 적으면 됩니다. Helm 릴리스 작업·노드 cordon/drain·새 객체 생성은 대상이 아닙니다.

## 대시보드 빠른 작업 (이슈 · 최적화 · 스토리지)

세 카드는 모두 k8s-service가 계산한 읽기 전용 결과를 보여 줍니다(AI 도구와 같은 숫자).

- **이슈 확인** — `GET /api/v1/cluster/issues?window=<분>`: 파드(Phase·Ready·CrashLoopBackOff 등 대기/종료 사유·재시작), 워크로드(Deployment `ProgressDeadlineExceeded`·unavailable, StatefulSet·DaemonSet 미준비, Job 실패, CronJob 마지막 실행 실패, HPA 상한 도달), 노드(Ready≠True·압박 조건), PVC(미바인딩)에 최근 `window`분의 Warning 이벤트를 같은 객체 행에 붙여 "왜·언제·몇 번"을 보여 줍니다.
  - 기본 범위는 `features.issues.eventWindowMinutes`(60), 화면에서 1h/6h/24h로 바꿀 수 있습니다.
  - 행을 누르면 그 객체의 드로어가 열립니다.
- **최적화 제안** — `GET /api/v1/cluster/optimization?namespace=…&window=<시간>`: 실행 중인 파드의 컨테이너별 requests/limits와 사용량(Prometheus가 있으면 최근 `window`시간의 CPU 95퍼센타일·메모리 최대, 없으면 metrics-server 순간값, 둘 다 없으면 "없음"으로 표기), 추천값(CPU = p95, 메모리 = 최대+15%, 최소 10m/100Mi — Robusta KRR의 simple 전략), 플래그(`cpu_over`·`cpu_under`·`mem_over`·`mem_under`·`no_cpu_request`·`no_mem_request`·`no_mem_limit`)를 표로 냅니다.
  - 기본 범위는 `features.optimization.windowHours`(24).
  - "AI 설명" 버튼은 이 표를 그대로 모델에 보내 왜 그런 수치인지·무엇부터 바꿀지 설명을 받습니다 — 숫자는 모델이 바꾸지 않습니다.
- **재시작 없이 적용** — `POST /api/v1/cluster/namespaces/{ns}/optimization/resize` 본문 `{kind, name, container, cpu_request_m?, mem_request_bytes?}`(최적화 행 그대로): 그 워크로드의 실행 중인 파드마다 컨테이너 requests를 Pod `resize` 하위 리소스로 바꿉니다(Kubernetes 1.35+ GA, 차트 `features.inPlaceResize.enabled` 기본 켬, 서버가 낮으면 버튼 숨김·API 409).
  - QoS 클래스는 유지합니다 — Guaranteed면 limits도 같이, Burstable이면 새 request보다 낮은 limit만 올림, BestEffort는 건너뜀. `resizePolicy`가 재시작을 요구하는 자원·변화 없는 컨테이너도 건너뛰고 파드마다 `resized`/`pending`(kubelet의 `PodResizePending`: Infeasible·Deferred)/`skipped`/`error`로 답합니다.
  - 워크로드 템플릿은 바꾸지 않으므로 다음 롤아웃 때 원래 값으로 돌아갑니다.
  - 권한 `resource.pod.edit`, Argo CD 가드는 워크로드 기준, 감사 `k8s.pod.resize`(호출 하나에 행 하나, 파드별 결과 포함).
  - Pod 드로어의 컨테이너 카드에 있는 "리소스 조정"은 같은 호출을 `kind: Pod`로 보내 그 파드 하나의 컨테이너 requests(CPU m·메모리 MiB)를 바꿉니다 — 같은 권한·스위치·규칙.
- **비용(Cost 메뉴)** — `GET /api/v1/cluster/cost?window=1h|6h|12h|24h|48h|7d|14d|30d&aggregate=namespace|controller`: 대상 클러스터 안의 OpenCost(이름에 `opencost`가 든 9003 Service를 `opencost`·`kubecost`·`monitoring`·`cost` 네임스페이스에서 찾아 `/healthz`로 확인, API 서버 프록시로 질의 — Prometheus와 같은 방식)의 `/allocation/compute`(누적 1구간, idle 제외)를 행으로 냅니다: 이름·Namespace·종류(워크로드일 때)·CPU/메모리/GPU/PV/네트워크/LB/합계 비용·코어시간·바이트시간·효율. 워크로드 집계는 OpenCost에 `namespace,controller`로 물어 행마다 Namespace를 알고, **Namespace 범위가 부여된 사용자는 그 Namespace 행만**(합계도 그 행만) 받습니다(`scoped: true`).
  - 할당은 **로그인 사용자로 impersonate해 읽으므로 대상 클러스터 RBAC이 상한**입니다 — 기본 `kubeast:viewer`(Read)는 `view`+`kubeast:cluster-reader`뿐이라 `services/proxy`가 없어 클러스터가 403으로 거부하고(Prometheus 프록시도 같음), `kubeast:operator`(Write, `edit`)부터 읽힙니다; Read에게 열려면 차트 값 `auth.impersonation.viewerProxyServices`에 그 클러스터의 OpenCost·Prometheus Service를 적어 Role을 렌더·적용합니다(그 Namespace에서 `<service>:<port>` GET만).
  - 응답 캐시는 **사용자(식별자)별** 60초, OpenCost 발견(어느 Service인지)은 개요 캐시 식별자로 10분(없음은 5분).
  - `GET /api/v1/cluster/cost/status`는 발견 여부·주소. 권한 `resource.cost.read`(Read 역할의 `resource.*.read`에 포함), 차트 `features.cost.enabled`(기본 켬, 끄면 404·메뉴 숨김), 감사 없음(일반 읽기).
  - 단가는 OpenCost가 정합니다 — 클라우드면 가격 API, kind·온프렘이면 OpenCost 기본 단가(CPU 0.031611/core-h·RAM 0.004237/GB-h).
  - **최적화 표**는 OpenCost가 있으면 같은 Namespace 할당에서 단가(비용 ÷ 시간)를 역산해 행마다 `cost_month_usd`(requests × 730h × 파드 수)와 `saving_month_usd`(추천값과의 차이, 음수면 0)를, 응답에 `pricing`을 덧붙입니다.
  - OpenCost 자체는 설치하지 않습니다(dev 2번 클러스터 매니페스트는 `deploy/kind/second-cluster.yaml`).
- **스토리지 분석** — PVC 목록(`?usage=true`)에 Prometheus의 `kubelet_volume_stats_*`로 사용률·용량과 6시간 추세로 계산한 "n일 뒤 가득 참"을 붙입니다(`features.prometheus.enabled`가 켜져 있고 Prometheus가 kubelet `/metrics`를 긁어야 함). CSI 드라이버가 볼륨 통계를 내지 않으면(hostPath·local-path 등) N/A로 표시합니다. 85%/97% 색 경계와 "4일 내 가득 참"은 kube-prometheus의 `KubePersistentVolumeFillingUp` 규칙과 같습니다.
- **Prometheus 소스(클러스터별)** — 기본은 대상 클러스터 안에서 Prometheus Service를 찾아 API 서버 프록시로 질의합니다: 모든 Namespace에서 레이블(`kubeast.io/prometheus=true` → prometheus 차트 서버 → Operator의 `prometheus-operated`)로, 없으면 이름에 `prometheus`가 든 9090 Service를 정해진 Namespace에서. 자동으로 못 찾으면 Admin → Clusters → 편집의 **클러스터 안 Service**(`namespace/service:port`, API가 경로 아래 있으면 `…/경로` — VictoriaMetrics 클러스터 `monitoring/vmselect-<이름>:8481/select/0/prometheus`, `PATCH`의 `prometheus_service`) 또는 차트 `features.prometheus.service`로 직접 적습니다(순서: 클러스터 주소 → 클러스터 Service → 차트 주소 → 차트 Service → 자동 발견).
  - 찾기(어느 Service인지, 클러스터마다 10분 기억)는 개요 캐시 식별자(`kubeast:cache`, 그룹 `kubeast:viewer`)로 하고 `/-/healthy`가 403이어도 "있음"으로 칩니다 — 그래서 누가 먼저 열었든 결과가 같습니다.
  - 질의 자체는 로그인한 사람으로 나가므로 Read(`kubeast:viewer`)는 `auth.impersonation.viewerProxyServices`에 그 Prometheus Service를 적어야 읽힙니다(적지 않으면 클러스터가 거부, 위 Read 역할 표).
  - Prometheus가 없으면 단일 VictoriaMetrics(VM operator `vmsingle`·`victoria-metrics-single` 차트 레이블, 이름 `*vmsingle*`·`*victoria-metrics*`의 8428)도 같은 방식으로 찾고, 상태 API가 저장소 종류(`flavor`)를 알려 줍니다 — VictoriaMetrics에서 다른 점(규칙은 `-vmalert.proxyURL`, 대상은 `up`, 메타데이터 v1.137+)은 [docs/cluster-requirements.md](cluster-requirements.md) §3 VictoriaMetrics. 중앙 저장소(Thanos·Mimir·VictoriaMetrics 등 Prometheus 호환 API)를 쓰면 Admin → Clusters → 편집에서 **주소·인증(bearer/basic, `cluster-prometheus-<id>` Secret에 보관)·클러스터 레이블 값**을 적습니다(`PATCH /api/v1/clusters/{id}`의 `prometheus_url`·`prometheus_auth`·`prometheus_cluster_label`).
  - 레이블 값이 있으면 모든 PromQL의 벡터 셀렉터에 `cluster="<값>"`(이름은 `features.prometheus.clusterLabel`)을 파서로 주입해 그 클러스터 시리즈만 봅니다.
  - 저장소를 Grafana 데이터소스로만 열어 둔 곳이면 주소에 Grafana 데이터소스 프록시(`https://<Grafana>/api/datasources/proxy/uid/<데이터소스 UID>`), 인증에 Grafana 서비스 계정 토큰(Viewer, bearer)을 적습니다 — 로그 저장소도 같은 방식([docs/cluster-requirements.md](cluster-requirements.md) §3·§14, dev `scripts/kind-grafana.sh`).
  - 노드 값(대시보드의 CPU·메모리·디스크, 노드 드로어 카드·24시간 추세)은 node-exporter 이름을 읽고, 없으면 OpenTelemetry Collector `hostmetrics` 이름(`system_*`, 노드는 `k8s_node_name` 레이블)을 읽습니다 — 고르는 설정은 없고, 맞출 것(`system.memory.limit` 켜기 등)은 [docs/cluster-requirements.md](cluster-requirements.md) §3. 차트 `features.prometheus.url`·`auth.existingSecret`(키 `authorization`)은 자기 주소가 없는 클러스터의 기본값, `discover: false`는 클러스터 안 자동 발견 끄기, `egressCIDRs`는 NetworkPolicy가 켜진 설치에서 443·6443 밖 포트의 저장소로 k8s-service 송신을 여는 목록(`{cidr, port}`).
  - `GET /api/v1/cluster/prometheus/status?cluster=<id>`가 `source`(external/proxy/none)·주소·인증 여부·레이블·`configured`(Service를 적었는지)·저장소 종류(`flavor`)와 연결 상태를 답하고, 못 찾았으면 이유(`reason`: `not_found`·`discover_off`)를 붙입니다 — 편집 창의 연결 확인은 이 값으로 화면 언어의 문구를 고르고, VictoriaMetrics면 결과 끝에 종류를 적습니다.

## 컨테이너 안 로그 파일 (Log files)

로그를 stdout이 아니라 **파일로 쓰는 앱**은 `kubectl logs`에도, Kubeast의 Logs 탭·AI 로그 툴에도 아무것도 안 보입니다(kubelet은 stdout/stderr만 모읍니다). 켜면(`features.logFiles.enabled`, 기본 off) Pod 상세의 Logs 탭과 Pod 드로어의 Logs 칸에 **컨테이너 출력 | 로그 파일** 전환이 생기고, 허용한 경로의 파일을 골라 마지막 N줄을 읽거나 실시간으로 따라갈 수 있습니다.

- **고정 명령, 셸 없음**: k8s-service가 사용자 신원의 `pods/exec`로 `ls`·`tail`만 실행합니다 — 목록 `ls -1p -- <디렉터리>`, 읽기 `tail -n N -- <파일>`, 실시간 `ls -lindL -- <파일>`(크기·inode) + `tail -c +<오프셋> -- <파일>`(인자는 배열로 넘겨 셸을 거치지 않음). 읽을 수 있는 건 `paths` 패턴(절대 경로, `*`·`?`는 파일 이름에만 — 예 `/var/log/app/*.log`)에 맞는 파일뿐이고, `..`·`.`·겹친 `/`가 든 경로는 거부합니다. 패턴이 틀리면 k8s-service가 뜨지 않습니다.
- **어디서**: `namespaces`를 적으면 그 네임스페이스의 파드에서만 됩니다(그 밖은 403).
  - impersonation이 켜져 있으면 차트가 ClusterRole `kubeast:logfile-reader`(`pods/exec` create·get)를 만들고 **그 네임스페이스에만** Read·Write 그룹(`kubeast:viewer`·`kubeast:operator`)을 RoleBinding으로 묶습니다 — Admin 그룹은 이미 cluster-admin, Write 그룹은 기본 `edit`로 원래 exec가 됩니다.
  - 다른 등록 클러스터에는 같은 렌더링을 적용합니다: `helm template kubeast helm/kubeast -s templates/logfiles-rbac.yaml -f <values> | kubectl --context <클러스터> apply -f -`.
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

## 로그 검색 (Loki)

`pods/log`는 살아 있는 파드의 지금 로그만 줍니다. 켜면(`features.logSearch.enabled`, 기본 off) 로그 저장소(Loki)에서 **재시작·삭제된 파드까지** 텍스트·기간으로 찾습니다 — Loki와 수집기는 따로 둡니다([docs/cluster-requirements.md §14](cluster-requirements.md#14-로그-저장소-로그-검색)).

- **화면**: Pod 드로어 Logs 칸과 클러스터 뷰 Logs 탭의 출처 전환에 "검색(기록)"(그 파드·컨테이너), Deployment·StatefulSet·DaemonSet·ReplicaSet·Job·CronJob 드로어에 "로그 검색" 섹션(그 워크로드의 파드들, 펼칠 때만 검색). 텍스트·기간(15분~최대)·정규식(`.*`)·대소문자 구분(`Aa`), 일치 부분 강조, "더 이전". 검색은 열 때 한 번과 검색 버튼에서만(검색마다 감사). 그 클러스터에 설정이 없거나 `resource.pod.read`가 없으면 보이지 않음.
- **API**: `GET /api/v1/namespaces/{ns}/logsearch`(한 Namespace) · `GET /api/v1/cluster/logsearch`(전체).
  - 조건 `q`(256자까지) · `match=contains|regex` · `ignore_case` · `pod` 또는 `workload_kind`+`workload_name`(Deployment·StatefulSet·DaemonSet·ReplicaSet·Job·CronJob → 그 컨트롤러가 만드는 파드 이름) · `container` · `since` 또는 `start`·`end`(RFC 3339) · `limit` · `direction`.
  - 응답 = 최신부터 줄(`ts`·`namespace`·`pod`·`container`·`line`), `truncated`이면 `oldest`를 `end`로 다시.
- **쿼리는 서버가 만듭니다**: 사용자는 LogQL을 쓰지 않고, 값은 전부 따옴표 안 문자열로만 들어갑니다. 클러스터 라벨 매처(`clusters`의 값)는 항상 붙어 Loki 하나를 여러 클러스터가 써도 섞이지 않습니다.
- **권한**: `resource.pod.read`(그 클러스터) + 사용자 신원으로 `get pods/log`를 물어 허용될 때만 — 클러스터 RBAC이 정합니다. 전체 검색은 그 클러스터에 Namespace 범위 부여가 있으면 403(Namespace를 고름).
- **한도**: 기본 1시간·최대 `maxRange`(24h) · 줄 `maxLines`(1,000) · 질의 `timeout`(15s, 넘으면 504) · 사용자별 분당 `perUserPerMinute`(20, k8s-service 레플리카마다).
- **감사**: 검색마다 `k8s.pod.logs.search`(민감 조회 — 기록이 안 되면 503). `after` = 조건·기간·줄 수·처리 바이트, 줄 본문은 남기지 않습니다. 클러스터가 거부(403)·한도 초과(429)·저장소 오류(502·504)도 실패 행.
- **클러스터마다 다른 Loki**: 어떤 클러스터의 로그가 다른 저장소에 있으면 Admin → Clusters → 편집의 "로그 검색"에 그 저장소의 주소·인증(Bearer/Basic, 값은 `cluster-logsearch-<id>` Secret)·테넌트(`X-Scope-OrgID`)·그 저장소에서 이 클러스터가 갖는 레이블 값(비우면 "그 저장소엔 이 클러스터뿐")을 적습니다 — 그 클러스터는 `url` 대신 그 저장소를 씁니다.
  - 모든 클러스터가 자기 저장소를 적는 운영이면 `url`·`clusters`는 둘 다 비워도 됩니다.
  - 레이블 **이름**과 한도는 배포 전체 값 그대로. "연결 확인"(`GET /api/v1/cluster/logsearch/status`)이 어느 저장소를 쓰는지와 인증·테넌트까지 답하는지를 보여 줍니다.
  - `networkPolicy`가 켜져 있으면 그 저장소의 호스트·포트도 `egressCIDRs`에.
- **LogQL 직접 입력**: `features.logSearch.logql: true`(기본 off)이면 로그 검색을 쓸 수 있는 사람 모두에게 검색 칸 옆 "LogQL" 토글이 생깁니다(따로 주는 권한 없음 — 아래처럼 읽는 범위가 구조화 검색과 같아서).
  - 서버는 질의를 파싱하지 않고 Loki 렉서와 같은 규칙으로 문자열·주석을 건너뛴 뒤 **모든 스트림 선택자에 그 클러스터(+Namespace) 매처를 더해** 보냅니다 — 사용자가 `k8s_cluster_name="다른값"`을 써도 AND라 그 클러스터 밖은 빈 결과. 로그 쿼리만(메트릭 쿼리는 400), 4 KB까지, 선택자가 없거나 리터럴·주석·선택자가 안 닫히면 400. 응답과 화면에 실제로 보낸 질의(`effectiveQuery`)가 보이고, 감사는 `k8s.pod.logs.logql`(쓴 질의·보낸 질의·줄 수).
  - API `GET /api/v1/namespaces/{ns}/logsearch/query?q=…` · `GET /api/v1/cluster/logsearch/query?q=…`(전체 NS, 범위 부여 없을 때만).
  - 문(Pod 읽기 + 사용자 신원 `get pods/log` + 분당 한도)·감사 준비는 구조화 검색과 같습니다.
  - 예전 권한 `admin.logsearch.query`는 없어졌습니다(DB 마이그레이션 00019가 역할에서 지움).
- **AI의 LogQL**(`loki_query`·`loki_labels`·`loki_patterns`): 로그 검색이 켜진 클러스터면 **구조화 검색을 쓸 수 있는 사람의 AI**가 씁니다(화면 `logql` 스위치와 무관) — 위와 같은 주입기로 모든 선택자에 클러스터(+Namespace) 매처가 붙어 구조화 검색보다 넓게 읽지 못하고, 늘어나는 건 세기·묶기·`| json` 같은 표현력뿐입니다.
  - 메트릭 쿼리(`count_over_time`·`rate`·`topk`)는 시리즈로 답해 답 아래 그래프로도 그립니다(`chart=true`).
  - API `GET /api/v1/[cluster/namespaces/{ns}/]logsearch/logql?q=&step=` · `…/logsearch/labels[?label=]` · `…/logsearch/patterns?q=<선택자>` — 같은 문(Pod 읽기 + `get pods/log` + 분당 한도), 감사 `k8s.pod.logs.logql`(`kind`), 레이블 목록은 감사 없음.
  - 패턴은 Loki `pattern_ingester.enabled: true`가 있어야 하고(없으면 AI가 "패턴 없음"을 받고 `loki_query`로 셉니다), Loki는 창 안에서 30줄 이상 나온 패턴만 돌려줍니다(3.7 고정값).

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

## 트레이스 링크

Kubeast는 트레이스를 저장하지 않고, 트레이스 저장소(Jaeger·Tempo·APM)로 가는 링크를 만듭니다(`features.tracing.enabled`, 기본 off). AI가 트레이스를 직접 읽는 것은 위 `features.traceStore`.

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

## 신뢰할 CA 추가 (사설 CA·TLS 가로채는 프록시)

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
