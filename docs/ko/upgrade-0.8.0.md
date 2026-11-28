[English](../upgrade-0.8.0.md) | **한국어**

# 0.7.9에서 0.8.0으로 업그레이드

**손 써야 하는 변경: 값에는 없음.** Kubeast의 답을 읽는 스크립트, 알림 규칙, MCP 클라이언트는 바꿔야 할 수 있습니다([4](#4-저절로-바뀌는-것)). Kubeast가 부르지 않는 공급자의 AI 모델 설정이 있거나, Entra ID에서 그룹이 200개 넘는 사람이 있는 설치는 업그레이드 전에 할 일이 있습니다([1.4](#14-ai-모델-설정과-entra-id-그룹)).

이 문서는 0.7.9 설치를 0.8.0으로 올릴 때 먼저 확인할 것, 저절로 바뀌는 것, 바꿔야 하는 값, 업그레이드가 한 번 하는 일, 되돌리는 방법을 다룹니다.
업그레이드 명령은 [설치와 첫 설정](getting-started.md#업그레이드)의 명령에 `--version 0.8.0`을 쓴 것입니다.
항목마다 그 변경을 만든 풀 리퀘스트 번호를 붙였습니다.

아래 명령은 네임스페이스 `kubeast`의 릴리스 `kubeast`를 기준으로 합니다. 자기 이름으로 바꿔 씁니다.

## 요약

- 먼저 [1.2](#12-드라이런으로-미리-해-보기)의 드라이런을 돌립니다. 업그레이드를 멈출 수 있는 검사는 모두 거기서 멈추고, 아무것도 바뀌지 않습니다.
- 0.7.8 이하에서 올린다면 먼저 0.7.9로 올립니다([1.1](#11-지금-버전)).
- `bedrock`·`geminivertexai`·`anthropicvertexai` ModelConfig와, `base_url`이 없고 공급자에 자기 주소가 없는 모델 설정은 더 쓸 수 없습니다. 먼저 바꾸거나 지우세요([1.4](#14-ai-모델-설정과-entra-id-그룹), #1158, #1160).
- 토큰에 그룹이 빠진 Entra ID 로그인은 거부됩니다. 그룹이 200개 넘는 사람이 있으면 먼저 Entra ID 앱을 바꾸세요([1.4](#14-ai-모델-설정과-entra-id-그룹), #1163).
- 모든 화면의 모양이 바뀝니다. 콘솔 주소와 브라우저가 기억하는 설정은 그대로라 따로 할 일은 없고, 화면을 움직이는 도구는 바꿔야 할 수 있습니다([4](#4-저절로-바뀌는-것), #1113, #1114, #1116, #1117, #1118, #1119, #1122, #1123, #1124, #1125, #1126, #1127, #1129).
- 화면이나 AI가 쓴 전체 네임스페이스 LogQL 질의는 노드 로그, 컨트롤 플레인 로그처럼 네임스페이스 라벨이 없는 스트림을 더는 읽지 않습니다([4](#4-저절로-바뀌는-것), #1144).
- 클러스터를 둘 이상 등록했으면 한 클러스터의 여러 쪽 읽기와 파드 목록은 자리의 절반까지만 씁니다. 목록에 늦게 답하는 클러스터 하나가 다른 클러스터를 더는 기다리게 하지 않습니다([4](#4-저절로-바뀌는-것), #1142, #1143).
- 손님이 이미 떠난 뒤에 쓴 500은 요청이 5초 안쪽이면 Go 서비스의 요청 지표에서 `code="499"`로 셉니다([4](#4-저절로-바뀌는-것), #1142).
- 같은 때 같은 권한으로 같은 Pods 페이지나 노드 지도를 묻는 사람들은 한 번 지은 답 하나를 받습니다. 권한은 사람마다 따로 확인합니다(#1109).
- 옛 파드가 멈출 때 돌던 승인된 AI 쓰기는 0.7.9처럼 승인 10분 뒤에 닫히고, 새 파드부터는 종료가 끊은 실행을 바로 닫습니다([4](#4-저절로-바뀌는-것), #1131).
- `anomaly_rank`는 파드마다 검사가 읽는 것만 남기므로 답 하나가 k8s-service 메모리를 훨씬 적게 씁니다. 답은 같고 새 값은 없습니다([4](#4-저절로-바뀌는-것), #1154).
- 데이터베이스가 스키마 33에서 34가 됩니다. 마이그레이션 00034가 표 `model_uses` 하나를 더하고 다른 표는 바꾸지 않습니다(#1152).
- 바꿔야 하는 값은 없습니다. 새 AI 기능(스위치 여덟 — AI의 읽기와 답에 일곱, 알림 창의 지난 조사 목록에 하나 — 과 쓰임마다 답하는 모델 고르기)은 켜기 전에는 아무것도 바꾸지 않고, AI의 답은 스위치 없는 고침이 말하는 곳에서만 바뀝니다([3](#3-바꿔야-하는-값), [4](#4-저절로-바뀌는-것), #1149, #1150).
- 네임스페이스로 한정한 부여가 읽지 못한 것을 이름으로 알려 주므로, Service 확인, Service의 상세, 이슈 확인, 타임라인을 읽는 스크립트와 MCP 클라이언트는 새 칸을 봅니다([4](#4-저절로-바뀌는-것), #1147, #1148).
- 먼저 데이터베이스를 백업합니다([1.3](#13-데이터베이스-백업)). 0.7.9로 되돌려도 0.8.0 데이터베이스가 그대로 남고 0.7.9는 그 위에서 돕니다. 그 전 자료로 돌아가는 길은 백업입니다([7](#7-079로-되돌리기)).

## 1. 업그레이드 전에

### 1.1 지금 버전

```bash
helm list -n kubeast                          # CHART kubeast-0.7.9
helm get values kubeast -n kubeast -o yaml    # 직접 넣은 값
```

0.7.8 이하에서 올린다면 먼저 [0.7.8에서 0.7.9로 업그레이드](upgrade-0.7.9.md)대로 0.7.9로 올리고 자리 잡게 둡니다.

### 1.2 드라이런으로 미리 해 보기

```bash
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.8.0 \
  -n kubeast --reset-then-reuse-values --dry-run=server > /dev/null
```

지금 값으로 0.8.0을 렌더하고 아무것도 바꾸지 않습니다. 검사가 멈추면 Helm이 무엇을 바꿔야 하는지 담은 오류를 출력합니다. 0.8.0은 그런 검사를 더하지 않습니다.

### 1.3 데이터베이스 백업

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- pg_dump -Fc -U kubeast kubeast > kubeast-before-0.8.0.dump
```

외부 데이터베이스라면 그 데이터베이스의 백업을 씁니다. [데이터베이스: TLS, 백업과 복원](database-backup-restore.md#클러스터-안-데이터베이스-백업-backing-up-the-in-cluster-database)에 두 방법과 복원이 있습니다.

### 1.4 AI 모델 설정과 Entra ID 그룹

0.8.0이 더는 부르지 않는 AI 모델 설정:

```bash
kubectl get modelconfigs -A -o custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,PROVIDER:.spec.provider
```

- 공급자가 `bedrock`·`geminivertexai`·`anthropicvertexai`인 ModelConfig는 업그레이드 뒤에도 남지만, 컨트롤러가 더는 동기화하지 않고 API 서버는 새로 만드는 것을 거부합니다. Kubeast에는 이 공급자를 부르는 코드가 없었습니다. 그 모델은 OpenAI 호환 엔드포인트로 쓰세요. 공급자가 제공하면 그 엔드포인트를, 아니면 그 앞에 둔 LiteLLM 같은 게이트웨이를 쓰고, provider `openai`에 `spec.baseURL`로 주소를 넣거나 Admin → AI Models에서 provider `custom`을 고릅니다. 저장된 ModelConfig는 `spec.provider`를 바꾸거나 지우세요. 지우면 Admin → AI Models의 그 설정도 함께 없어집니다.
- Admin → AI Models에서 `base_url`이 없고 공급자에 자기 주소가 없는 설정(`custom`, 또는 API로 저장한 `groq` 같은 이름)은 업그레이드 뒤 채팅과 **Test**가 거절하고 아무것도 보내지 않습니다. 0.7.9는 그 채팅을 OpenAI 주소로 보냈습니다. 그 엔드포인트를 `base_url`로 넣거나(provider `custom`) 지우세요. 끄기만 할 수도 있습니다.

Microsoft Entra ID: 그룹이 200개 넘는 사람이면 Entra ID가 ID 토큰에서 그룹을 빼고, 0.8.0은 그 로그인을 `oidc_groups_overage`로 거부합니다. 그럴 수 있다면 업그레이드 전에 Entra ID가 애플리케이션에 할당된 그룹만 보내게 하거나, 앱 역할과 `auth.oidc.claims.groups: roles`를 쓰세요([SSO(OIDC) 설정 — Microsoft Entra ID](oidc.md#microsoft-entra-id)).

## 2. 업그레이드

```bash
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.8.0 \
  -n kubeast --reset-then-reuse-values
```

- 업그레이드 동안 멈추는 파드는 0.7.9의 것이므로, 그 파드가 끊은 승인된 AI 쓰기는 0.7.9처럼 승인 10분 뒤 처음 보는 ai-service가 닫습니다(#1131).
- 마이그레이션 00034는 auth-service가 시작할 때 적용하고, `migrations.mode: job`이면 마이그레이션 Job이 적용합니다. 모델 설정에 외래 키를 둔 작은 표 하나를 만듭니다. auth-service, session-service, k8s-service, ai-service는 스키마 34를 기다립니다. 아래 리허설에서는 거의 빈 데이터베이스에서 7~16 ms 걸렸습니다.
- `--wait` 없는 `helm upgrade`는 파드가 준비되기 전에 끝납니다. 끝난 뒤 파드를 봅니다([6](#6-업그레이드한-뒤)). 마이그레이션이 실패하면 다른 서비스의 새 파드가 그것을 기다리는 네 서비스의 옛 파드 곁에 남고, 실패는 그 파드들과 auth-service 로그에만 보입니다. `migrations.mode: job`이면 Job이 실패하고 서비스는 하나도 바뀌지 않습니다.
- Kubeast의 Deployment는 모두 새 이미지를 받아 파드를 하나씩 바꿉니다. 멈추는 파드에 열려 있던 터미널과 따라가던 로그는 0.7.9처럼 끝납니다.
- 0.8.0의 변경은 번들 PostgreSQL과 Redis 파드를 건드리지 않습니다.
- `--reuse-values`는 0.7.9처럼 안내와 함께 멈춥니다.
- 0.7.9에서 올리는 이 업그레이드를 kind(Kubernetes 1.37.0, Helm 4.2.4)에서 여섯 번 리허설했습니다(차트 기본값, 다른 키가 있거나 없는 `secrets.existingSecret`, 외부 데이터베이스, 복제본 셋, AI 끔). `helm upgrade`는 31~32초 걸렸고, 0.7.9 파드는 첫 파드를 지운 뒤 14~16초 안에 모두 없어졌습니다. 그동안 1초마다 물은 여섯 경로(게이트웨이, 로그인 키, 콘솔 페이지, 클러스터 목록 하나, 채팅 세션, 로그인한 계정)는 200 말고 다른 답을 받지 않았고 멈춘 것도 없었으며, 가장 느린 답은 0.06초였습니다. 번들 PostgreSQL 파드는 그대로였고, 계정의 비밀번호, API 키, 역할은 그 뒤에도 전처럼 됐습니다. Kubernetes 1.29.14에서는 `podShutdown.preStopSeconds: 0`인 0.7.9 설치가 올라가고 모든 Deployment가 준비됐습니다.

## 3. 바꿔야 하는 값

없습니다.

다음 값은 새로 생겼고 기본으로 꺼져 있으므로, 0.7.9의 값을 그대로 쓴 업그레이드는 전과 같게 렌더하고 이 설정을 꺼진 채로 더합니다. `ai.causeNaming`, `ai.faultOnset`, `ai.pastHints`, `ai.traceSpanTable`, `ai.yamlSpecFirst`, `features.callGraph.clientLatency`, `features.nodeNeighbors.busiestCPU`입니다(#1149, #1150).

`features.alertInvestigation.pastReports.window`도 새로 생겼고 기본으로 꺼져 있으며, 정했을 때만 ConfigMap에 줄을 더합니다(#1151).

`multicluster.flowSchemas`도 새로 생겼고 기본으로 꺼져 있으며, 꺼져 있는 동안 차트는 FlowSchema를 그리지 않습니다(#1171). 켜려면 차트를 적용하는 쪽에 `flowschemas.flowcontrol.apiserver.k8s.io`의 `create`가 있어야 하고, 클러스터는 Kubernetes 1.29 이상이어야 하며, 등록한 다른 클러스터마다 `scripts/render-target-rbac.sh`가 그린 FlowSchema 둘을 그 역할처럼 적용합니다([대상 클러스터 요구 사항](cluster-requirements.md#1-권한rbac--모든-대상-클러스터)).

ConfigMap에 일곱 값의 줄이 하나씩 더해져 체크섬이 바뀌므로, 그것을 읽는 Kubeast 파드는 새 이미지 때처럼 한 번 바뀝니다.

스위치는 이 업그레이드가 자리 잡은 뒤 `helm upgrade`를 한 번 더 해서 켭니다. 모두 alpha라 키나 동작이 바뀌거나 없어질 수 있습니다. 값마다 무엇을 돌려 보았는지는 [설정](configuration.md#새-값의-단계)의 "새 값의 단계"에 있습니다. 둘은 혼자서는 아무것도 바꾸지 않습니다. `features.callGraph.clientLatency`는 `features.callGraph.enabled`가, `features.nodeNeighbors.busiestCPU`는 `features.nodeNeighbors.enabled`가 있어야 합니다.

## 4. 저절로 바뀌는 것

**화면**

- 모든 화면이 세 색 모드에서 새 모양으로 바뀝니다. 주소, 화면마다 하는 일, 색 모드와 브라우저가 기억하는 다른 설정은 0.7.9와 같습니다(#1113, #1114, #1116, #1117, #1118, #1119, #1122, #1123, #1124, #1125, #1126, #1127, #1129). 창 너비가 1,280 px보다 좁으면 접히는 AI Chat 대화 목록은 브라우저에 아무것도 남기지 않습니다(#1127).
- 상세 서랍은 맨 위에 있는 동안 Tab을 안에 두는 모달 대화 상자(`role="dialog"`, `aria-modal="true"`, `data-testid="resource-drawer"`)입니다. `role="dialog"`를 모두 열린 창으로 보는 도구나 직접 만든 시험은 이제 서랍을 찾을 수 있습니다. 창만 찾으려면 `[role="dialog"]:not([data-testid="resource-drawer"])`를 씁니다(#1134, #1135, #1140).
- 목록 행과 정렬되는 열 머리가 Tab 차례를 받고, Enter나 Space로 열거나 정렬합니다(#1134, #1136, #1137).
- 터미널은 Tab, Shift+Tab, Escape를 셸에 둡니다. Ctrl+M(Mac은 Ctrl+Shift+M)을 누르면 Tab으로 터미널을 벗어날 수 있습니다(#1141).
- 열린 떠 있는 채팅 밖에서 ⌘/(그 밖에서는 Ctrl+/)를 누르면 채팅을 닫는 대신 초점을 채팅 안으로 옮깁니다(#1139).

**로그 검색**

- 전체 네임스페이스 LogQL 질의(화면의 LogQL, `loki_query`, `loki_patterns`, `loki_query` 앞의 크기 어림, 네임스페이스 없는 로그 검색 API)는 구조 검색과 같은 네임스페이스 라벨 matcher를 받습니다. 기본 라벨이면 `k8s_namespace_name=~".+"`이므로 네임스페이스 라벨이 있는 스트림만 읽습니다. 같은 Loki에 라벨 없이 든 노드 로그와 컨트롤 플레인 로그는 이제 답에 없으니 Loki에서 직접 읽습니다. 네임스페이스로 묶은 지표 질의에서는 네임스페이스 없는 묶음이 빠지고, `effectiveQuery`가 그 matcher를 보여 줍니다(#1144).
- 네임스페이스 하나의 질의, 구조 검색, 좁히기의 읽기는 보내던 그대로 보냅니다. 누가 전체 네임스페이스를 읽을 수 있는지도 그대로입니다.
- 클러스터 라벨 값 없이 등록한 로그 저장소는 여전히 그 클러스터만 담은 것으로 읽습니다. 여러 클러스터가 저장소 하나를 나눠 쓰면 등록마다 그 클러스터의 라벨 값을 적습니다.

**클러스터끼리 나눠 쓰는 자리**

- 클러스터를 둘 이상 등록했으면 한 클러스터의 여러 쪽 읽기는 `multicluster.bigReadConcurrency` 자리의 절반까지(올림, 기본 둘 가운데 하나)만 쓰므로, 그 클러스터의 큰 읽기는 하나씩 돕니다. `multicluster.bigReadConcurrency: 3`이면 둘이 함께 돌고, k8s-service 메모리가 읽기 하나만큼 늘어납니다(#1143).
- 사람으로 읽는 클러스터 파드 목록은 따로 된 자리를 씁니다. 파드 행 자리보다 하나 적고(CPU가 하나나 둘이면 같은 수), 한 클러스터는 그 절반까지(올림)만 씁니다. `POD_ROW_CONCURRENCY`가 이 수도 정합니다(#1142).
- 설치에 클러스터가 하나뿐이면 0.7.9처럼 그 클러스터가 자리를 모두 씁니다.

**AI의 파드 로그 읽기**

- `k8s_get_pod_logs`는 MCP 호출에서도 kubectl이 마지막에 한 말로 실패를 답하고, 시작하지 않았거나 앞선 실행이 없는 컨테이너를 넘어 모든 컨테이너를 읽어 마지막 줄에 그 이름을 적고, 컨테이너마다 무엇을 읽었는지 말합니다(#1146).

**감사 로그 목록**

- `GET /api/v1/auth/admin/audit-logs`와 내보내기는 0x00이나 UTF-8이 아닌 바이트가 든 글자 거르개에 거르개 이름과 함께 400으로 답합니다. 전에는 500이었습니다(#1143).

**지표**

- Go 서비스는 손님이 이미 떠난 뒤에 쓴 500을 요청이 5초 안쪽이면 `code="499"`로 셉니다. 그래서 `KubeastHighErrorRate`와 직접 만든 5xx 규칙은 손님이 떠난 읽기(닫거나 다시 불러온 페이지, 멈춘 채팅)를 더는 세지 않습니다. 그 5초 안에 사람이 다시 불러오는 동안 생긴 실패도 499로 셉니다. 더 늦게 쓴 500이나 손님이 있는 동안 쓴 500은 전처럼 셉니다(#1142).

**`anomaly_rank`**

- `anomaly_rank`와 그 경로는 파드마다 파드 검사가 읽는 것만 남깁니다. 0.7.9는 답을 만들 때까지 모든 파드의 행을 쥐었습니다. 이 고침을 0.7.9 위에 얹어 KWOK이 흉내 낸 파드 50 000개와 512 Mi의 k8s-service 하나로 재면, 답 하나는 메모리를 많아야 132 MiB까지 썼고(0.7.9는 480 MiB) 답 둘이 동시면 139 MiB까지 썼습니다. 답은 MCP 호출에서도 전과 같고, 새 값은 없습니다(#1154).
- 큰 네임스페이스에 답 둘이 동시면 0.7.9처럼 `multicluster.bigReadConcurrency`의 두 자리를 기다립니다. 5초를 넘겨 기다린 검사는 실행 안 됨("did not answer in time")으로 나옵니다.

**승인된 AI 쓰기**

- 종료가 끊은 실행은 그 실행을 돌린 ai-service가 끝냅니다. interrupted로 실패하고, `after.end_reason`이 `shutdown`인 `ai.tool.interrupt` 행이 남습니다. 원래 값 `interrupted`는 ai-service가 죽어서 승인 10분 뒤에 닫힌 실행에 남습니다(#1131).
- `end_reason: interrupted`만 보는 거르개, 알림 규칙, 보고서는 종료가 끊은 실행을 놓칩니다.
- 승인된 exec의 `k8s.pod.exec` 행은 그 승인을 끝내는 트랜잭션 안에 씁니다.

**Pods 페이지와 노드 지도**

- 같은 때 같은 페이지를 묻는 사람들은 한 번 지은 답 하나를 받습니다. 권한은 사람마다 따로 확인합니다. 답은 바뀌지 않습니다(#1109).

**네임스페이스로 한정한 부여의 AI 도구와 화면**

- 이슈 확인은 부여의 몇 네임스페이스가 거절한 목록에 `namespaces`와 까닭을 담은 `Collector` 행을 둡니다. 파드와 이벤트도 셉니다. 전에는 빠뜨렸습니다. AI 도구 `issues`는 그 목록을 `not_read`에 적습니다(#1147, #1148).
- 타임라인(화면 API와 AI 도구)은 다른 네임스페이스의 수 곁에 `summary.not_read_in`을 두고, 도구의 안내도 그렇게 말합니다. 전에는 아무것도 바뀌거나 일어나지 않았다고 했습니다. Timeline 화면은 이것을 그리지 않습니다.
- AI 도구 `k8s_find_resource`는 종류를 거절한 네임스페이스를 이름으로 알리고 나머지에서 찾습니다. 파드는 여전히 k8s-service가 가진 행에서 읽으므로 그런 네임스페이스가 빠집니다.
- 클러스터 전체를 덮는 부여, 네임스페이스 하나의 부여, 아무것도 거절당하지 않은 부여는 전과 같은 답을 받습니다.

**Service 확인과 Service 서랍**

- `k8s_check_service_connectivity`는 `status`를 까닭과 함께 `Forbidden`이나 `Unknown`으로 답하고, 수는 null로 두고 `endpoints_error`를 적습니다. 전에는 `NotFound`나 0과 `NotReady`로 답했습니다. 읽은 것과 없는 Service는 같은 바이트로 답합니다(#1147, #1148).
- `GET /api/v1/namespaces/{namespace}/services/{name}/describe`는 EndpointSlice를 나열하지 못하면 `endpoints_error`를 두고 `endpoints`와 `endpoint_slices`를 빼고 답합니다.
- `ai.toolResultDetails`를 켜면 읽지 못한 엔드포인트에는 `empty_reason`이 없습니다.

**AI 채팅**

- 답 안에서 돈 쓰기(`ai.writeApproval` 끔)나 카드에서 승인한 쓰기는 대화가 그 앞 읽기에서 가진 것을 버립니다. 그래서 그 뒤 같은 읽기는 승인 뒤에 시작한 답에서도 클러스터를 읽습니다(#1147, #1148).
- 로그, describe, YAML 읽기는 그 안의 한 줄이 `error`나 `status`를 가진 JSON 객체라는 까닭으로 실패나 거절로 읽지 않습니다.

**알림 조사**

- 조사의 `alerts_inbox` `with_report`는 스위치와 상관없이 거절합니다. 호출은 돌지 않고 `ai.tool.call` 행은 실패이며, 모델은 저장된 보고서 없이 알림을 읽습니다. AI Chat의 `alerts_inbox`는 전처럼 보고서를 읽습니다(#1153).
- 알림, 규칙, 이름만 읽는 호출(`alerts_inbox`, `alerts_list`, 지표 · 라벨 · 태그 이름, `k8s_find_resource`, `k8s_explain`, API 리소스, `can_i`, `clusters_list`)만 근거로 댄 원인은 verdict를 켜든 끄든 확인되지 않습니다. 모델에게 한 번 더 묻고, 그래도 안 되면 확인 안 된 것으로 적습니다. 전에는 보고서 창이 서버가 확인했다고 했습니다(#1153).

**모델**

- 마이그레이션 00034와 Admin → AI Models의 "Which model answers"는 누군가 모델을 고르기 전에는 아무것도 바꾸지 않습니다. 고른 것이 없으면 알림 조사와 Optimization 설명이 새 표를 한 번씩 읽습니다(#1152).
- `features.alertInvestigation.model`을 정한 설치에서는 키가 없어 실패한 조사의 글이 바뀝니다.

**AI 모델 설정, 로그인, 답**

- ModelConfig CRD의 `spec.provider`는 `openai`·`anthropic`·`azureopenai`·`gemini`·`ollama`·`claude-code`를 받습니다. 저장된 `bedrock`·`geminivertexai`·`anthropicvertexai`는 컨트롤러가 더는 동기화하지 않습니다([1.4](#14-ai-모델-설정과-entra-id-그룹), #1158).
- `POST`·`PATCH /api/v1/ai/model-configs`는 `base_url`이 없고 공급자에 자기 주소가 없는 설정에 400으로 답합니다. **Test**, 모델 드롭다운, 채팅은 주소 표 하나를 읽고, `base_url`이 있는 Gemini 설정의 **Test**는 그 주소를 부릅니다(#1160).
- ID 토큰이 그룹 클레임을 `_claim_names`에 적은 Entra ID 로그인은 `oidc_groups_overage`로 거부되고, `after.claim`이 붙은 `user.login.failed` 행이 남습니다(#1163).
- `GET /api/v1/prometheus/query`는 Prometheus가 NaN이나 무한대로 준 값을 `null`로 주고, `query_range`와 LogQL 지표 질의는 그 점을 뺍니다. 전에는 답 전체가 몸통 없는 200이었습니다(#1156).
- 앞 구간에 대부분의 값의 자료가 없는 `anomaly_rank` 답은 맨 앞에 `no_baseline`을 싣고, `features.anomalyRank`를 켜면 채팅 지시에 한 문장이 더해집니다(#1157).

**그 밖**

- 차트 기본값에서 0.8.0은 차트 객체, ClusterRole, Role을 더하지 않습니다. 차트 템플릿 가운데 바뀌는 것은 [3](#3-바꿔야-하는-값)의 줄만큼의 ConfigMap과, `spec.provider` 목록에서 값 셋이 빠진 ModelConfig CRD입니다(#1158). ConfigMap이 바뀌어 Deployment 여섯의 `checksum/config` 주석이 바뀌므로, 새 이미지 때처럼 그 파드가 바뀝니다. `multicluster.flowSchemas`를 켜면 차트가 FlowSchema `kubeast-cache`와 `kubeast`를 더합니다. 클러스터 전체의 객체이고, API 서버가 Kubeast의 요청을 다른 사용자의 요청 사이 어디에 두는지를 바꿉니다(#1171). 이름이 바뀌거나 없어진 값은 없습니다.

## 5. 이번 업그레이드에서 한 번 일어나는 일

- Kubeast 파드가 새 이미지로 하나씩 바뀝니다.
- 업그레이드 동안 열어 둔 0.7.9 콘솔 페이지는 다시 불러올 때까지 0.7.9 화면을 그립니다. 0.8.0 프런트엔드에 더는 없는 화면 코드를 열면 페이지가 스스로 다시 불러옵니다. 0.7.9가 어느 업그레이드 뒤에나 하는 것과 같습니다(`frontend/src/main.tsx`).
- 마이그레이션 00034가 `model_uses`를 만듭니다(#1152).
- 번들 PostgreSQL은 파드를 그대로 둡니다. 리허설에서 멈춘 시간은 0초였습니다.

## 6. 업그레이드한 뒤

```bash
helm list -n kubeast                 # CHART kubeast-0.8.0
kubectl -n kubeast get pods          # 모든 파드가 Running이고 준비됨
helm get notes kubeast -n kubeast    # 설치 안내
```

Admin → AI Models를 엽니다. "Which model answers"가 지금 쓰임마다 어느 모델이 도는지 알려 줍니다. "Does not run now"인 항목은 까닭을 적습니다. 준비되지 않는 파드가 있으면 `kubectl -n kubeast logs deploy/auth-service`가 마이그레이션이 실패했는지 알려 줍니다.

## 7. 0.7.9로 되돌리기

```bash
helm history kubeast -n kubeast                        # 0.7.9의 revision
helm rollback kubeast <revision> -n kubeast
```

- **화면**: 0.7.9 프런트엔드가 0.7.9 화면을 그리고, 브라우저가 기억하는 설정은 0.7.9가 쓴 대로 읽습니다. 0.8.0은 같은 키에 같은 값을 씁니다(#1113, #1114, #1116, #1117, #1118, #1119, #1122, #1123, #1124, #1125, #1126, #1127, #1129).
- **`anomaly_rank`**: 0.7.9는 다시 답을 만들 때까지 네임스페이스의 모든 파드 행을 쥡니다.
- **로그 검색**: 0.7.9는 다시 클러스터 matcher만으로 전체 네임스페이스를 읽습니다.
- **지표**: 0.7.9는 그 읽기를 다시 500으로 셉니다.
- **승인된 AI 쓰기**: 0.7.9는 ai-service가 멈춘 실행을 승인 10분 뒤에 닫습니다. `end_reason: shutdown`인 행은 쓴 그대로 남습니다.
- **데이터베이스**: `helm rollback`은 Down 마이그레이션을 돌리지 않으므로 `model_uses`가 남습니다. 0.7.9 서비스는 스키마 33 이상을 기다리며 스키마 34는 그 조건에 맞고, 그 표는 읽지 않습니다. 리허설에서 `helm rollback`은 13~34초 걸렸고, 0.7.9는 스키마 34 데이터베이스에서 마이그레이션 오류 없이 떴으며, 주요 화면을 보는 0.7.9 자신의 종단 간 시험이 거기서 통과했고, 0.8.0으로 다시 올릴 때는 다시 할 마이그레이션이 없었습니다. Admin → AI Models에서 고른 것은 읽히지 않고, 쓰임마다 전에 돌던 모델로 돕니다. 0.8.0을 다시 설치하면 고른 것이 그대로 있습니다. 고른 것이 쓰임의 자료가 어디로 가는지를 정한다면 되돌리기 전에 그 쓰임을 끄거나 다른 모델을 고릅니다. 0.8.0 전에 받은 백업은 `DROP TABLE IF EXISTS model_uses;` 뒤의 0.8.0 데이터베이스나 빈 데이터베이스에 복원합니다. 리허설에서 0.7.9에서 받은 백업을 `pg_restore --clean --if-exists --no-owner`로 새 0.7.9 설치에 복원하니 계정, 감사 행, 클러스터가 같았고, 관리자가 전의 비밀번호로 로그인했습니다.
- **AI 스위치**: 0.7.9는 새 스위치를 하나도 읽지 않습니다.
- **FlowSchema**: 0.7.9 차트는 FlowSchema를 그리지 않으므로 `helm rollback`이 설치한 클러스터의 둘을 지웁니다. 등록한 다른 클러스터에 손으로 적용한 것은 `kubectl --context <cluster> delete flowschema kubeast-cache kubeast`로 지울 때까지 남고, 남아 있는 동안은 같은 사용자 · 그룹 이름으로 가는 0.7.9의 요청도 그 자리에 둡니다.
- **AI 모델 설정**: 0.7.9의 ModelConfig CRD는 다시 `bedrock`·`geminivertexai`·`anthropicvertexai`를 받고, 0.7.9는 `base_url`이 없고 공급자에 자기 주소가 없는 설정을 다시 OpenAI 주소로 보냅니다.
- **Entra ID**: 0.7.9는 ID 토큰에 그룹이 빠진 사람을 다시 로그인시킵니다. 새 계정은 `defaultRole`, 이미 있는 계정은 전의 역할과 권한을 그대로 갖습니다.
- **알림 조사**: 네임스페이스 없는 알림의 0.7.9 조사는 다시 저장된 보고서를 읽을 수 있고, 알림 · 규칙 · 이름만 읽은 호출로 댄 원인은 다시 확인을 통과합니다.
- **API 답과 감사 행**: 0.8.0이 쓴 감사 행은 쓴 그대로 남습니다. 리허설에서 되돌린 0.7.9는 역할, 계정, 클러스터, 녹화 목록과 파드 로그 하나에 답했고, 파드 로그에 데이터베이스 오류가 없었으며, 사람들의 비밀번호, API 키, 역할이 전처럼 됐습니다.

## 8. Docker Compose

내려받은 폴더에서 올립니다. 스크립트는 `.env`의 비밀번호와 키를 남기고, 손으로 더한 줄은 없어집니다. 스크립트 뒤에 그 줄을 다시 더하거나 `--skip-env`로 스크립트를 실행합니다. 쓰는 게이트웨이 포트를 줍니다.

```bash
cd Kubeast
docker compose exec -T postgres pg_dump -Fc -U kubeast kubeast > kubeast-before-0.8.0.dump
git fetch --tags && git checkout v0.8.0
./install-docker.sh --port <지금 포트>
```

`KUBEAST_TAG`를 정해 두었다면 `v0.8.0`으로 바꾸거나 지웁니다.

- **새 스위치**: Compose는 하나도 정하지 않으므로 모두 꺼져 있습니다. 켜려면 `.env`에서 그 변수를 `true`로 정합니다. `AI_CAUSE_NAMING`, `AI_FAULT_ONSET`, `AI_PAST_HINTS`, `AI_TRACE_SPAN_TABLE`, `AI_YAML_SPEC_FIRST`, `CALL_GRAPH_CLIENT_LATENCY`, `NODE_NEIGHBORS_BUSIEST_CPU`이고, ai-service, k8s-service, tool-server가 읽습니다.
- 알림 창의 지난 조사 목록은 `ALERT_INVESTIGATION_PAST_WINDOW`입니다.
- **차트와 같은 것**: 마이그레이션, 모델 고르기, 그 감사 행은 차트와 같습니다.
- **되돌리기**: `git checkout v0.7.9 && ./install-docker.sh --port <지금 포트>`를 씁니다.
