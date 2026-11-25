[English](../upgrade-0.7.9.md) | **한국어**

# 0.7.8에서 0.7.9로 업그레이드

**손 써야 하는 변경: 있음(설치에 따라 다름).** Kubernetes 1.30 아래에서는 `podShutdown.preStopSeconds`가 0보다 크거나(기본 5) `gateway.preStopSeconds`가 0보다 크거나 `streams.enabled`가 켜져 있으면 렌더가 멈추므로, `podShutdown.preStopSeconds: 0`으로 두고 `gateway.preStopSeconds`는 비우거나 0으로 두고 `streams.enabled`를 끄거나 Kubernetes 1.30 이상으로 올립니다([1.3](#13-kubernetes-버전)). Helm 4.0.0이나 Helm 3.14 이하에서 `--kube-version` 없이 돌린 `helm template`도 그 Helm의 기본 Kubernetes가 1.30보다 낮아 같은 까닭으로 멈추므로 클러스터 버전을 줍니다([1.3](#13-kubernetes-버전)). 차트의 알림 규칙(`metrics.prometheusRule.enabled`)과 AI를 켰다면 업그레이드가 알림을 두 개까지 더하므로 먼저 그 알림의 받을 곳을 정합니다([1.5](#15-알림-규칙)). k8s-service를 위해 주 Secret에 넣은 키는 k8s-service가 이름으로 읽는 키가 아니면 더는 읽히지 않습니다([1.4](#14-k8s-service가-주-secret에서-읽는-것)). 차트의 PostgreSQL에서 `postgresql.maxConnections`를 0.7.8의 연결 합계에 맞춰 두었다면, 0.7.9는 auth-service 파드마다 연결을 하나 더 세므로 렌더가 멈춥니다. 먼저 올립니다([1.6](#16-데이터베이스-연결)). 바깥 데이터베이스는 `max_connections`를 설치 안내가 출력한 새 합계보다 크게 둡니다([1.6](#16-데이터베이스-연결)). [4](#4-저절로-바뀌는-것)의 "API 답"에 있는 답을 읽는 스크립트는 고쳐야 할 수 있습니다. SSO 계정(SSO가 만든 계정, `auth_source` `oidc`)은 비밀번호로 더는 로그인하지 않습니다. 관리자 재설정으로 받은 비밀번호도 같고, 승인을 기다리던 중에 SSO가 닿은 자기 가입 계정은 업그레이드 때 SSO 계정이 됩니다([1.7](#17-sso-계정과-비밀번호)). `auth.passwordLogin: admin-only`이면 비밀번호 폼은 `admin.email` 적힌 그대로에만 열리므로, 대소문자만 다른 주소의 계정은 거기서 403을 받습니다. `admin.email`을 그 계정이 저장된 글자와 같게 적거나 `admin.email` 그대로 저장된 계정을 씁니다([4](#4-저절로-바뀌는-것)). 클러스터 API 서버 앞의 프록시가 `Audit-ID` 헤더를 떼면 그 오류 상태는 더는 API 서버의 답이 아니고, 그렇게 답한 상태 확인의 `/version`은 차단기를 엽니다. 프록시가 `Audit-ID`를 넘기게 합니다([3](#3-바꿔야-하는-값), [4](#4-저절로-바뀌는-것)). AI 도구를 하나씩 나열한 사용자 정의 역할은 `ai.tool.anomaly_rank`를 더해야 새 도구 `anomaly_rank`를 받습니다. 아래 다른 항목은 그 항목이 적은 설치에만 해당합니다.

이 문서는 0.7.8 설치를 0.7.9로 올릴 때 먼저 확인할 것, 저절로 바뀌는 것, 바꿔야 하는 값, 업그레이드가 한 번 하는 일, 되돌리는 방법을 다룹니다.
업그레이드 명령은 [설치와 첫 설정](getting-started.md#업그레이드)의 명령에 `--version 0.7.9`를 쓴 것입니다.
항목마다 그 변경을 만든 풀 리퀘스트 번호를 붙였습니다.

아래 명령은 네임스페이스 `kubeast`의 릴리스 `kubeast`를 기준으로 합니다. 자기 이름으로 바꿔 씁니다.

## 요약

- 먼저 [1.2](#12-드라이런으로-미리-해-보기)의 드라이런을 돌립니다. 업그레이드를 멈출 수 있는 검사는 모두 거기서 멈추고, 아무것도 바뀌지 않습니다.
- 0.7.7 이하에서 올린다면 먼저 0.7.8로 올립니다([1.1](#11-지금-버전)).
- Kubernetes 1.30 아래에서는 파드가 preStop sleep을 받게 되면, 1.33 아래에서는 k8s-service-stream이 0초 sleep을 받게 되면 렌더가 멈춥니다. 0.7.8은 다른 객체를 먼저 적용했고 그 뒤 API 서버가 Deployment를 거절했습니다(#1072).
- Kubeast 서버는 모두 1초마다 묻는 startup 프로브와 3초마다 묻는 readiness를 받습니다(`podStartup.quickReady`, 기본 켜짐). 그래서 업그레이드가 그 파드를 모두 하나씩 바꾸고, 하나뿐인 파드를 대신하는 파드는 듣기 시작한 뒤 1초쯤에 준비됩니다. `false`면 0.7.8의 프로브를 그대로 씁니다(#1072).
- 데이터베이스가 스키마 30에서 33이 되고, 서비스는 33을 기다립니다. 마이그레이션 00031(#882), SSO가 닿은 자기 가입 계정을 SSO 계정으로 바꾸는 00032(#1077), `tool_approvals` 인덱스 두 개를 만드는 00033(#1077)입니다.
- k8s-service와 k8s-service-stream은 주 Secret에서 쓰는 키만 읽습니다([1.4](#14-k8s-service가-주-secret에서-읽는-것), #1072).
- 20초 안에 답이 없는 클러스터 읽기는 503으로 답하고(#1060), 클러스터 차단기는 `Audit-ID`가 있는 오류 상태만 API 서버의 답으로 읽습니다(#1060).
- API 답이 바뀝니다. 비밀번호 바꾸기, 관리자의 비밀번호 재설정, `admin-only`의 비밀번호 로그인, 네트워크 흐름, 클러스터 읽기, 클러스터 기능, 로그와 트레이스의 지표, Resource Graph, AI 도구 넷, 알림 웹훅, 보존 기간 정리의 감사 행입니다([4](#4-저절로-바뀌는-것)).
- 보존 기간 정리의 잠금이 auth-service 풀 밖의 자기 연결을 쥐므로, 차트가 `postgresql.maxConnections`와 견주는 연결 합계가 배포 중의 auth-service 파드마다 하나씩 늘어납니다. AI를 켜고 서비스마다 1대면 156개(전에는 154), 서비스마다 3대면 290개(전에는 286)입니다. 0.7.8의 합계에 맞춘 값은 새 합계를 알리며 렌더를 멈춥니다([1.6](#16-데이터베이스-연결), #1072).
- PgBouncer 뒤에서는 여전히 세션 풀링이어야 합니다. 보존 기간 정리가 이제 도는 동안 세션 advisory lock을 쥡니다([1.6](#16-데이터베이스-연결), #1072).
- 파드 IP로 보내는 AWS Application Load Balancer 뒤에서는 게이트웨이 파드가 멈추기 전에 25초를 기다리고 Ingress가 등록 해제 지연 20초를 요청합니다. 0.7.8이 그런 로드 밸런서 뒤에 안내한 값으로 이미 0.7.8을 돌리고 있지 않으면, 처음 올릴 때 게이트웨이 파드를 바꾸는 한 번에 502 · 504가 날 수 있습니다([4](#4-저절로-바뀌는-것), #1072).
- SSO 계정은 비밀번호로 더는 로그인하지 않습니다. 0.7.9 전에 관리자 재설정으로 받은 비밀번호도 같고, 승인을 기다리던 중에 SSO가 닿은 자기 가입 계정은 SSO 계정이 됩니다([1.7](#17-sso-계정과-비밀번호), #1077).
- k8s-service 하나(`streams.enabled`면 k8s-service-stream)는 모든 계정을 합쳐 자기에게 열린 터미널과 실시간 로그가 443개를 넘으면, 넘는 것을 계정 상한처럼 거절합니다(`multicluster.maxStreamsPerServer`, `0`이면 상한 없음. [4](#4-저절로-바뀌는-것), #1060).
- AI의 새 읽기와 확인은 스위치입니다. `features.anomalyRank.enabled`는 기본 켬이라 AI 채팅, 플로팅 채팅, MCP 서버가 도구 `anomaly_rank`를 받습니다([4](#4-저절로-바뀌는-것), #1088). `ai.ruleCards.investigations`와 `features.alertInvestigation.rules` · `changesFirst` · `narrowFirst` · `ledger` · `evidenceCheck` · `verdict`도 기본 켬이지만 알림 조사만 바꾸고, 알림 조사는 꺼진 채입니다(`features.alertInvestigation.enabled`). 나머지는 꺼져 있습니다. 0.7.8처럼 두려면 그 스위치를 `false`로 둡니다. 스위치 없이 바뀌는 AI는 다음과 같습니다. AI가 쓴 글 속 이미지는 링크가 되고(#917), 알림은 링크 없이 규칙 식으로 모델에 가고(#1087), 채팅 질문은 출력 형식을 달라고 할 때만 그 형식의 도구로 좁혀지고(#1078), Gemini 모델에서는 도구 호출마다 thought signature가 함께 돌아가고(#1087), Claude 모델(공급자 `anthropic`)에서는 도구를 부르는 차례 뒤의 호출이 그 도구 목록을 그대로 보내되 부르지 않게 하고(#1082), Claude 구독의 알림 조사에서는 조사를 닫는 호출과 다시 묻기가 도구 결과를 표식 사이에 담고(#1087), 채팅 답 하나는 모델 호출을 20번까지 하고 마지막 호출은 도구를 부르지 않고 답하고(`ai.chat.maxSteps`, #1084), 길이에서 잘린 채팅 답의 나머지를 청하는 글이 바뀌고(#1084), Claude Code는 모든 프롬프트를 쓴 그대로 받고(#1086), AI 도구 `get_pod_metrics` · `issues`(#1088), `logsearch`(#1077), `alerts_inbox` · `investigations`(#1087), `k8s_get_pod_logs`(#1094)의 답이 바뀝니다([4](#4-저절로-바뀌는-것)).
- 기본 역할 Read는 시작할 때 `ai.tool.anomaly_rank`를 받고(이 도구는 기본 켬) Write는 `ai.tool.*`를 갖고 있습니다. AI 도구를 하나씩 나열한 사용자 정의 역할은 `ai.tool.anomaly_rank`를 더해야 새 도구를 받습니다([3](#3-바꿔야-하는-값), #902).
- 먼저 데이터베이스를 백업합니다. 〔되돌려도 남는 것: 리허설 뒤에 씁니다.〕

## 1. 업그레이드 전에

### 1.1 지금 버전

```bash
helm list -n kubeast                          # CHART kubeast-0.7.8
helm get values kubeast -n kubeast -o yaml    # 직접 넣은 값
```

0.7.7 이하에서 올린다면 먼저 [0.7.7에서 0.7.8로 업그레이드](upgrade-0.7.8.md)대로 0.7.8로 올리고 자리 잡게 둡니다. 〔0.7.8에서 시작한 리허설 뒤에 확인합니다.〕

### 1.2 드라이런으로 미리 해 보기

```bash
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.9 \
  -n kubeast --reset-then-reuse-values --dry-run=server > /dev/null
```

지금 값으로 0.7.9를 렌더하고 아무것도 바꾸지 않습니다. 검사가 멈추면 Helm이 무엇을 바꿔야 하는지 담은 오류를 출력하고, 그 목록은 [3](#3-바꿔야-하는-값)의 표에 있습니다. 0.7.9부터는 [1.3](#13-kubernetes-버전)의 Kubernetes 버전도 이 검사 가운데 하나입니다.

이 드라이런은 객체를 API 서버에 보내지 않습니다. API 서버에도 확인받으려면 [0.7.7에서 0.7.8로 업그레이드](upgrade-0.7.8.md#12-드라이런으로-미리-해-보기)의 `kubectl apply --server-side --dry-run=server`를 `--version 0.7.9`로 돌립니다.

### 1.3 Kubernetes 버전

```bash
kubectl version    # Server Version
```

preStop sleep은 Kubernetes 1.30(`PodLifecycleSleepAction`, 1.30부터 기본 켜짐)이, 0초 sleep은 1.33(`PodLifecycleSleepActionAllowZero`, 1.33부터 기본 켜짐)이 필요합니다. 0.7.9는 클러스터가 거절할 sleep을 파드가 받게 되면 Helm이 무엇이든 적용하기 전에 렌더를 멈춥니다(#1072).

- 1.30 아래에서 `podShutdown.preStopSeconds`가 0보다 크거나(기본 5), `gateway.preStopSeconds`가 0보다 크거나, `streams.enabled`가 켜져 있을 때입니다. k8s-service-stream은 `podShutdown.preStopSeconds`와 상관없이 `streams.preStopSeconds`만큼 sleep하므로, `podShutdown.preStopSeconds: 0`만으로는 그 sleep이 빠지지 않습니다. 비워 둔 `gateway.preStopSeconds`는 `podShutdown.preStopSeconds`를 따르고, 파드 IP로 보내는 AWS Application Load Balancer 뒤에서는 그 값이 0보다 클 때만 25로 올립니다.
- 1.33 아래에서 `streams.enabled`이고 `streams.preStopSeconds: 0`일 때입니다.

0.7.8은 다른 객체를 적용한 뒤 API 서버가 그 Deployment를 거절했으므로, 0.7.8 업그레이드가 끝까지 된 설치는 이미 통과하는 값을 갖고 있습니다. 메시지가 넣을 값을 알려 줍니다. `helm template`은 `--show-only`를 써도(`scripts/render-target-rbac.sh`가 그렇게 돌림) `--kube-version`으로 준 버전을, 없으면 Helm의 기본값을 읽습니다. Helm 4.0.0의 기본값은 v1.20.0, Helm 3.14 이하는 1.29 이하이므로 거기에 클러스터 버전을 줍니다.

### 1.4 k8s-service가 주 Secret에서 읽는 것

k8s-service와 k8s-service-stream은 주 Secret(`kubeast-secrets`, 또는 `secrets.existingSecret`의 Secret)을 통째로 환경으로 받았습니다. 0.7.9부터는 그 Secret에서 다음 키만 이름으로 읽습니다(#1072).

- `DATABASE_URL`과 `INTERNAL_API_TOKEN`입니다.
- Redis 사용자가 꺼져 있는 동안 `REDIS_PASSWORD`입니다. 사용자를 켰다면 0.7.8처럼 k8s-service는 자기 사용자의 비밀번호를 읽습니다.
- Secret에 있을 때 `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`입니다.

다른 서비스는 그대로 주 Secret을 통째로 받고, 모든 서비스가 그대로 `kubeast-config`를 통째로 받습니다.
k8s-service를 위해 `secrets.existingSecret`에 더한 키 가운데 위의 것이 아닌 키는 더는 읽히지 않습니다.
`kubeast-config`의 키와 같은 이름이라 그 값을 대신하던 키(`envFrom`에서 Secret이 `kubeast-config` 뒤에 있었음. 이제 k8s-service는 `kubeast-config`의 값을 읽음)와 소문자 `http_proxy`, `https_proxy`, `no_proxy`도 그렇습니다. 아래 명령은 Secret의 키 이름만 보여 주고 값은 보여 주지 않습니다.

```bash
kubectl -n kubeast get secret <secrets.existingSecret의 이름> -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}'
```

거기 있는 소문자 proxy 키는 대문자로 적으세요. k8s-service는 `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`를 그 이름으로만 받습니다.
`kubeast-config`의 키와 같은 이름의 키는, 그 키를 쓰는 차트 값이 있으면 그 값을 정하세요. 차트에는 k8s-service에 직접 정한 환경 변수를 주는 값이 없습니다.

Redis 사용자의 키를 그 Secret에 넣었다면(`redis.acl.existingSecretHasKeys: true`), 설치 안내는 이제 k8s-service를 뺀 모든 백엔드가 모든 Redis 사용자의 비밀번호를 갖는다고 알려 줍니다.

### 1.5 알림 규칙

`metrics.enabled`(기본 켜짐)와 `metrics.prometheusRule.enabled`이면 차트의 PrometheusRule에 알림이 두 개까지 더해지고, 둘 다 `severity: warning`입니다(#1060).

| 알림 | 렌더되는 조건 | 울리는 때 |
| --- | --- | --- |
| `KubeastAIModelUnreachable` | `ai.enabled` | 10분 동안 모델 요청이 3개 이상 실패하고 하나도 답을 받지 못한 상태가 10분 이어질 때 |
| `KubeastAIInvestigationsFailing` | `ai.enabled`와 `features.alertInvestigation.enabled` | 1시간 동안 알림 조사가 3개 이상 실패하고 끝난 조사의 절반을 넘은 상태가 15분 이어질 때 |

다른 값이 기본값(`ai.enabled` 켜짐, `features.alertInvestigation.enabled` 꺼짐)이면 첫째만 더해져, 알림은 다섯이 아니라 여섯입니다.
업그레이드 전에 Alertmanager에서 이 알림을 보낼 곳을 정합니다. 답하지 않는 모델 공급자는 채팅마다 200 스트림 안에서 끝나므로 `KubeastHighErrorRate`가 보지 못했습니다.

ai-service의 HTTP 지표는 kubelet이 `/api/v1/ai/health`를 묻는 프로브(파드마다 1분에 8~22개)를 더는 세지 않으므로, `KubeastHighErrorRate`와 `KubeastSlowRequests`는 그 프로브 없이 ai-service의 요청을 읽고, 업그레이드 뒤에는 ai-service에 대해 전에 울리지 않던 이 알림이 울릴 수 있습니다(#1060).

### 1.6 데이터베이스 연결

보존 기간 정리는 이제 정리가 도는 동안 auth-service 풀 밖의 자기 연결 하나에 advisory lock을 쥡니다. k8s-service의 상태 확인 잠금과 같은 꼴입니다(#1072).
차트가 `postgresql.maxConnections`와 견주는 합계([0.7.7에서 0.7.8로 업그레이드](upgrade-0.7.8.md#16-데이터베이스-연결))도 그 연결을 세어, 배포 중의 auth-service 파드마다 연결이 하나씩 더해집니다.
AI를 켜고 서비스마다 1대면 최대 156개(전에는 154), 서비스마다 3대면 290개(전에는 286), 거기에 `streams.enabled`를 켜면 310개(전에는 306)입니다.

차트의 PostgreSQL에서 `postgresql.maxConnections`를 0.7.8의 합계에 맞춰 두었거나, 그 위로 둔 여유가 배포 중의 auth-service 파드 수보다 적으면 렌더가 멈춥니다. [1.2](#12-드라이런으로-미리-해-보기)의 드라이런에서 `the pods can hold up to <합계> database connections`로 보입니다.
업그레이드 전에 `postgresql.maxConnections`를 그 합계 이상으로 올리거나, 풀이나 파드 수를 줄입니다.
`postgresql.maxConnections`를 바꾸면 번들 PostgreSQL의 `max_connections` 인자가 바뀌므로 업그레이드 동안 그 파드가 바뀌고, 새 파드가 뜨는 동안 데이터베이스가 멈춥니다. 다시 뜰 때까지 쓰기와 민감한 읽기는 [0.7.7에서 0.7.8로 업그레이드](upgrade-0.7.8.md#5-이번-업그레이드에서-한-번-일어나는-일)에서처럼 503 `audit unavailable`을 답합니다.

바깥 데이터베이스(`postgresql.enabled: false`)는 차트가 검사하지 않습니다. 설치 안내가 새 합계를 출력하므로 데이터베이스의 `max_connections`를 그보다 크게 둡니다.

PgBouncer 뒤에서는 0.7.8처럼 세션 풀링을 쓰거나 직접 연결합니다.
보존 기간 정리의 잠금은 세션 advisory lock입니다. 마이그레이션, 감사 싱크, k8s-service의 상태 확인 잠금과 같은 꼴이고, 트랜잭션 풀링에서는 그 잠금이 그것을 잡은 클라이언트에 남지 않습니다(#1072).

### 1.7 SSO 계정과 비밀번호

SSO 계정(`auth_source` `oidc`)의 관리자 비밀번호 재설정은 400과 `user.password.reset` 실패 행(`single_sign_on_account`)으로 거절되고, User Management는 비밀번호 초기화 대신 "SSO 계정"을 보여 줍니다(#1077).
승인을 기다리던 중에 SSO가 닿은 자기 가입 계정도 그런 계정입니다. 0.7.9부터는 그 로그인이 계정을 `oidc`로 바꾸고, 그 전에 닿은 계정은 업그레이드(마이그레이션 00032)가 바꿉니다. 그 뒤 관리자가 승인했거나 비밀번호를 준 계정도 같고, 가진 비밀번호는 지우지 않습니다(#1077).
업그레이드는 감사 기록의 `user.register` 행으로 자기 가입 계정을 알아보므로, 보존 기간 정리가 그 행을 이미 지운 계정은 비밀번호 계정으로 남습니다([5](#5-이번-업그레이드에서-한-번-일어나는-일)).
그런 계정 가운데 아직 승인을 기다리는(Pending) 계정으로 SSO가 이미 닿은 계정(비밀번호가 없거나 `user.account.link` 행이 있는 계정)은 아래 읽기 명령이 보여 줍니다. `user.create` 행이 있는 계정은 뺍니다.

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- psql -U kubeast -d kubeast -c \
  "SELECT u.id, u.email, u.created_at FROM auth_users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'Pending' AND u.auth_source = 'password' AND (u.password_hash = '' OR EXISTS (SELECT 1 FROM auth_audit_logs a WHERE a.action = 'user.account.link' AND a.result = 'success' AND a.target_user_id = u.id)) AND NOT EXISTS (SELECT 1 FROM auth_audit_logs c WHERE c.action IN ('user.register', 'user.create') AND c.result = 'success' AND c.target_user_id = u.id) ORDER BY u.created_at"
```

찾은 계정은 관리자가 확인한 뒤 정리합니다.

관리자가 만든 계정은 계정 등급이 무엇이든(Pending 포함) 비밀번호 계정으로 남고, SSO가 닿기 전에 관리자가 승인한 자기 가입 계정도 Pending보다 높은 등급인 동안은 같으므로, 두 길로 로그인하던 사람은 둘 다 그대로 씁니다.
차트의 admin 계정은 `admin.email` 그대로 저장된 계정이고, 무엇이 만들었든 재설정할 수 있습니다. 대소문자만 다른 주소의 계정은 다른 계정입니다. 공급자가 만들었으면 User Management에는 "SSO 계정"으로 보이고 Account 화면에는 비밀번호 변경이 없습니다. `reset-admin`으로 되살리는 길은 그대로이고, `POST /api/v1/auth/admin/users/{user_id}/reset-password`로 재설정하며, 비밀번호를 가진 뒤에는 `POST /api/v1/auth/change-password`로 바꿉니다.
`auth.passwordLogin: admin-only`는 비밀번호 폼을 차트의 admin 계정에만 열므로, `admin.email`과 대소문자만 다른 주소의 계정은 거기서 403 `Password login is disabled; use single sign-on`을 받습니다([4](#4-저절로-바뀌는-것)).

그런 계정은 0.7.9 전에 재설정으로 받은 비밀번호로도 더는 로그인하지 않습니다. 답은 틀린 비밀번호와 같은 401 `Invalid credentials`이고, `user.login.failed` 행에는 `single_sign_on_account`가 남으며, 잠금 실패 횟수는 세지 않습니다. 그런 계정의 `POST /api/v1/auth/change-password`도 400으로 답하므로, API로 그 계정의 비밀번호를 바꾸던 스크립트는 거기서 멈춥니다. 차트의 admin 계정은 무엇이 만들었든 그대로 비밀번호로 로그인합니다. 그렇게 로그인하던 사람은 그 뒤로 SSO로 로그인해야 합니다. 아래 명령은 가진 비밀번호로 더는 로그인하지 않게 될 계정 수만 보여 줍니다.

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- psql -U kubeast -d kubeast -c \
  "SELECT count(*) FROM auth_users u WHERE u.password_hash <> '' AND u.email <> '<admin.email>' AND (u.auth_source = 'oidc' OR (u.auth_source = 'password' AND EXISTS (SELECT 1 FROM auth_audit_logs r WHERE r.action = 'user.register' AND r.result = 'success' AND r.target_user_id = u.id) AND EXISTS (SELECT 1 FROM auth_audit_logs a WHERE a.action = 'user.account.link' AND a.result = 'success' AND a.target_user_id = u.id)))"
```

이미 열린 세션은 `auth.sessionAbsoluteHours`(기본 8)까지 이어지고, 관리자가 그 계정의 역할을 정하면(`PATCH /api/v1/auth/admin/users/{user_id}`의 `role_id`) 같은 역할로 정해도 그 전에 끝납니다. 업그레이드가 바꾸는 자기 가입 계정 가운데 비밀번호를 가진 계정은 업그레이드가 세션을 끝냅니다.
차트의 admin 계정이 아닌 그런 계정에 `reset-admin --email`을 돌리면 Admin 역할, 잠금 해제, 세션 끝내기만 하고 비밀번호는 쓰지 않으며, 명령의 마지막 줄은 그 계정이 공급자로 로그인한다고 알려 줍니다. 공급자가 멈췄을 때 비밀번호로 들어올 길은 `--email` 없이 돌린 `reset-admin`(차트의 admin 계정)입니다.

### 1.8 데이터베이스 백업

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- pg_dump -Fc -U kubeast kubeast > kubeast-before-0.7.9.dump
```

바깥 데이터베이스는 그 데이터베이스의 백업을 씁니다. 두 방법과 복원은 [데이터베이스: TLS, 백업과 복원](database-backup-restore.md#클러스터-안-데이터베이스-백업-backing-up-the-in-cluster-database)에 있습니다.

## 2. 업그레이드

```bash
helm upgrade kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.9 \
  -n kubeast --reset-then-reuse-values
```

- 마이그레이션은 auth-service가 시작할 때 적용하고, `migrations.mode: job`이면 마이그레이션 Job이 적용합니다. 00031(#882), 00032(#1077), 00033(#1077)입니다. 00032는 `auth_users.self_signed_up` 칸을 더하고(상수 기본값이라 표를 다시 쓰지 않음), `auth_audit_logs`를 action 인덱스로 한 번 읽어 자기 가입 계정을 표시한 뒤, SSO가 닿은 자기 가입 계정의 `auth_users` 행을 바꿉니다. 00033은 다른 마이그레이션처럼 인덱스 두 개를 마이그레이션의 트랜잭션 안에서 만들므로, 그것이 끝날 때까지 `tool_approvals`에 쓰는 일이 기다립니다(행 100만 개에 1.5초쯤). 〔걸린 시간: 리허설 뒤에 씁니다.〕 0.7.9 서비스는 스키마 33을 기다립니다.
- Kubeast 서버의 Deployment는 모두 이미지와, `podStartup.quickReady`면 프로브가 바뀌어 파드를 하나씩 바꿉니다. 0.7.8 파드는 `preStop` 기다림을 거쳐 멈춥니다. 멈추는 파드에 열려 있던 터미널과 따라가던 로그는 0.7.8처럼 끝납니다([0.7.7에서 0.7.8로 업그레이드](upgrade-0.7.8.md#4-저절로-바뀌는-것)).
- 0.7.9의 변경은 번들 PostgreSQL과 Redis를 건드리지 않습니다. 차트가 둘의 파드를 0.7.8과 같게 렌더합니다. [1.6](#16-데이터베이스-연결)을 위해 `postgresql.maxConnections`를 올리면 PostgreSQL 파드가 바뀝니다.
- 〔업그레이드 동안 요청이 겪은 것(실패, 다시 로그인, 초): 리허설 뒤에 씁니다.〕

## 3. 바꿔야 하는 값

자기 설치에 맞는 행만 봅니다. "멈춤"인 행은 그 값을 바꿀 때까지 메시지와 함께 업그레이드를 멈춥니다.

| 언제 | 0.7.8 | 0.7.9 | PR |
| --- | --- | --- | --- |
| Kubernetes 1.30 미만이고 `podShutdown.preStopSeconds`가 0보다 크거나 `gateway.preStopSeconds`가 0보다 크거나 `streams.enabled`일 때([1.3](#13-kubernetes-버전)) | 다른 객체를 적용한 뒤 API 서버가 Deployment를 거절함 | 멈춤. `podShutdown.preStopSeconds: 0`, `gateway.preStopSeconds` 비움 또는 0, `streams.enabled` 끔, 또는 Kubernetes 1.30 이상 | #1072 |
| Kubernetes 1.33 미만이고 `streams.enabled`, `streams.preStopSeconds: 0`일 때 | API 서버가 k8s-service-stream을 거절함 | 멈춤. `streams.preStopSeconds`를 1 이상으로, 또는 Kubernetes 1.33 이상 | #1072 |
| k8s-service가 읽던 `secrets.existingSecret`의 키 가운데 [1.4](#14-k8s-service가-주-secret에서-읽는-것)의 것이 아닌 키 | 읽힘 | 읽히지 않음 | #1072 |
| AI를 켜고 `metrics.prometheusRule.enabled`일 때([1.5](#15-알림-규칙)) | — | 새 알림 둘까지. 보낼 곳을 정합니다 | #1060 |
| 0.7.8의 프로브를 그대로 둘 때 | — | `podStartup.quickReady: false` | #1072 |
| 파드 IP로 보내는 AWS Application Load Balancer 뒤에서 0.7.8의 게이트웨이 기다림과 등록 해제 지연을 그대로 둘 때([4](#4-저절로-바뀌는-것)) | — | `gateway.preStopSeconds: 5`, 그리고 `alb.ingress.kubernetes.io/target-group-attributes`에 `deregistration_delay.timeout_seconds=300` | #1072 |
| 클러스터 API 서버 앞의 프록시가 `Audit-ID` 헤더를 뗄 때 | 그 4xx를 API 서버의 답으로 셈 | 그 오류 상태는 더는 API 서버의 답이 아니고, 그렇게 답한 상태 확인의 `/version`은 차단기를 엽니다. 프록시가 `Audit-ID`를 넘기게 합니다 | #1060 |
| 트랜잭션 풀링 PgBouncer 뒤 | 지원하지 않음 | 보존 기간 정리의 잠금까지 지원하지 않음. 세션 풀링이나 직접 연결 | #1072 |
| 차트의 PostgreSQL에서 `postgresql.maxConnections`가 새 연결 합계보다 작을 때([1.6](#16-데이터베이스-연결)) | 0.7.8의 합계에 맞음 | 멈춤. 배포 중의 auth-service 파드마다 연결 하나가 더해집니다. 메시지가 알린 합계로 올리거나, 풀이나 파드 수를 줄입니다 | #1072 |
| 바깥 데이터베이스 | — | `max_connections`를 설치 안내가 출력한 새 합계보다 크게 | #1072 |
| SSO 계정이나 SSO가 닿은 자기 가입 계정에 비밀번호로 로그인하는 사람([1.7](#17-sso-계정과-비밀번호)) | 로그인됨 | 거절됨. SSO로 로그인합니다 | #1077 |
| `auth.passwordLogin: admin-only`이고 `admin.email`과 대소문자만 다른 주소의 비밀번호 계정이 있을 때([4](#4-저절로-바뀌는-것)) | 이전 버전은 통과시킴 | 403 `Password login is disabled; use single sign-on`. `admin.email`을 그 계정이 저장된 글자와 같게 적거나 `admin.email` 그대로 저장된 계정을 씁니다 | #1077 |
| `--reuse-values`로 업그레이드 | 멈춤 | 0.7.8처럼 멈춤. `--reset-then-reuse-values`를 씁니다 | — |
| 채팅 답 하나의 모델 호출을 0.7.8처럼 10번으로 둘 때([4](#4-저절로-바뀌는-것)) | 10 | 정하지 않으면 20: `ai.chat.maxSteps: 10` | #1084 |
| AI 도구를 하나씩 나열한 사용자 정의 역할 | — | 기본 켬인 새 도구를 주려면 `ai.tool.anomaly_rank`를 더합니다 | #902, #1088 |
| AI를 0.7.8처럼 두기([4](#4-저절로-바뀌는-것)) | — | `features.anomalyRank.enabled: false`. 알림 조사를 켰다면 `ai.ruleCards.investigations`와 `features.alertInvestigation.rules` · `changesFirst` · `narrowFirst` · `ledger` · `evidenceCheck` · `verdict`도 `false` | #1088 |
| AI 도구 `alerts_inbox`나 `investigations`에서 `generator_url`이나 `alertmanager_url`을 읽는 스크립트나 MCP 클라이언트 | 주었음 | 주지 않음. `expr`에 규칙 식이 있습니다. 경로와 화면은 둘 다 그대로 둡니다 | #1087 |
| AI를 켠 채 `networkPolicy.aiEgress.allowListOnly: true`(기본 꺼짐) | — | `networkPolicy.enabled`가 꺼져 있거나, `networkPolicy.allowExternalEgressCIDRs`가 비었거나, `networkPolicy.aiEgress.clusterAPIs`와 `networkPolicy.apiserverCIDR`이 둘 다 비었거나, tool-server에 IRSA 롤이 있는데 `networkPolicy.aiEgress.stsEndpoints`가 비었으면 멈춤 | #917 |

값을 빼려면 [0.7.7에서 0.7.8로 업그레이드](upgrade-0.7.8.md#3-바꿔야-하는-값)에 있는 대로 하되 `--version 0.7.9`를 씁니다.

기본값 그대로 두면 되는 새 값은 `podStartup.quickReady`(true), `gateway.preStopSeconds`(비어 있음: 게이트웨이는 `podShutdown.preStopSeconds`만큼 기다리고, 파드 IP로 보내는 AWS Application Load Balancer 뒤에서는 그 값이 0보다 크면 25초 이상. `0`이면 기다리지 않고 음수나 정수가 아닌 값은 렌더를 멈추며, 0보다 크면 `preStop` sleep이라 Kubernetes 1.30 이상이 필요함. 그런 로드 밸런서 뒤에서는 대상 그룹의 등록 해제 지연보다 크게 둠), `gateway.servedByHeader`(false, alpha: 켜면 게이트웨이가 보내는 모든 응답의 `X-Kubeast-Gateway`에 게이트웨이 파드 이름이 실림. 교체 시험용이며, 켜 두면 클라이언트에게 파드 이름이 보이므로 다른 곳에서는 꺼 둠), `multicluster.maxStreamsPerServer`(443: k8s-service 하나가 모든 계정을 합쳐 열어 두는 터미널과 실시간 로그의 상한. `0`이면 상한 없음. 차트가 이 기본값으로 읽으므로 이 키가 없는 값(0.7.8의 값도)은 443으로 렌더되고, `--reuse-values`가 이 키가 없어서 멈추지는 않음, [4](#4-저절로-바뀌는-것)), `ai.chat.maxSteps`(20: 채팅 답 하나에 쓸 수 있는 모델 호출 수, 1~100. 차트가 이 기본값으로 읽으므로 이 키가 없는 값(0.7.8의 값도)은 20으로 렌더됨, [4](#4-저절로-바뀌는-것)), `ai.timelineChanges` · `ai.timelineChangesMore` · `ai.causeQuestions` · `ai.refuseRepeatedReads` · `ai.toolResultDetails` · `ai.toolResultsJSON` · `ai.redaction.numbered`(false), `ai.ruleCards.investigations`(true), `ai.ruleCards.chat` · `ai.ruleCards.symptoms`(false, `ai.ruleCards.cards`와 `ai.ruleCards.remove`는 비어 있음), `features.alertInvestigation.rules` · `changesFirst` · `narrowFirst` · `ledger` · `evidenceCheck` · `verdict`(true, `window.metricsMinutes` 15, `window.logsMinutes` 5, `window.changesHours` 4. 알림 조사가 켜져 있을 때만 읽음), `features.anomalyRank.enabled`(true, `maxQueries` 12, `checkTimeoutSeconds` 5, `timeoutSeconds` 20, `concurrency` 4, `cacheSeconds` 60, `logMaxBytes` 10737418240), `features.nodeNeighbors.enabled`(false), `features.logSearch.queryMaxBytes`(0), `features.callGraph.enabled`(false), `networkPolicy.aiEgress.allowListOnly`(false, `clusterAPIs`와 `stsEndpoints`는 비어 있음)입니다. 각 값의 설명은 [설정](configuration.md)에 있습니다.

## 4. 저절로 바뀌는 것

**파드**

- `podStartup.quickReady`(true)이면 Kubeast 서버마다(번들 PostgreSQL과 Redis는 빼고) 180초까지 1초마다 묻는 startup 프로브와, 처음 기다림 없이 3초마다 묻는 readiness가 붙습니다. 그래서 하나뿐인 파드를 대신하는 파드(지워졌거나 노드 드레인이 내보낸 파드)는 듣기 시작한 뒤 1초쯤에 준비됩니다. 0.7.8은 auth-service, k8s-service, session-service에 5초마다 묻는 startup 프로브를 주고 나머지에는 주지 않았으며, readiness는 기다린 뒤 10초마다 물었습니다. kind에서 파드 하나로 ai-service, 프론트엔드, 게이트웨이를 바꿀 때 6초쯤, auth-service, k8s-service, session-service를 바꿀 때 1초쯤 아무것도 답하지 않았습니다. 〔숫자: 0.7.9 측정으로 다시 맞춥니다.〕 kubelet이 Kubeast 서버 파드마다 묻는 횟수는 1분에 8번에서 22번으로 늘었습니다. `false`면 0.7.8의 프로브를 바이트까지 그대로 렌더합니다(#1072).
- k8s-service와 k8s-service-stream은 주 Secret에서 자기 키만 받습니다([1.4](#14-k8s-service가-주-secret에서-읽는-것), #1072).

**클러스터 요청**

- 클러스터 읽기(GET, HEAD, 접근 확인 같은 review)는 API 서버가 답을 시작하기를 20초 기다린 뒤 503으로 답합니다. 본문은 걸리는 만큼 읽습니다. 한 요청의 읽기 하나가 기다림을 다 쓰면 그 요청은 그 클러스터에 다른 읽기를 보내지 않습니다. watch, 따라가는 로그, exec, attach, port-forward, proxy 하위 리소스, 쓰기는 시간을 재지 않습니다. 0.7.8에서는 답이 없는 API 서버가 요청을 55초쯤 붙잡았고, 여러 번 묻는 요청은 까닭 없이 게이트웨이의 504로 끝날 수 있었습니다(#1060).
- 클러스터 차단기는 상태가 400 아래이거나 `Audit-ID`가 있는 응답을 API 서버의 답으로 읽습니다. kube-apiserver는 모든 답에 `Audit-ID`를 씁니다. API 서버 자신의 503이나 504(컨트롤 플레인을 다시 띄운 직후의 집계 API, 큰 목록)는 이제 시험을 닫고, 앞에 있는 프록시가 쓴 오류 상태는 시험을 닫지도 닫힌 차단기의 횟수를 지우지도 않으며, 그렇게 답한 상태 확인의 `/version`은 차단기를 엽니다(#1060).
- 자기 로그 저장소를 정한 클러스터(Admin → Clusters → 편집)는 차트의 `features.logSearch.clusters`에 없어도 `/api/v1/cluster/features`의 `features.logSearch.clusters`에 나옵니다(#1072).
- 네임스페이스로 한정한 권한의 타임라인과 이벤트 API는 첫 읽기 전에 그 네임스페이스들의 접근 확인을 8개씩 나란히 묻습니다. API 서버가 답하지 못한 확인은 그 네임스페이스만 그 사람으로 읽습니다. 서랍의 Events 섹션은 그 확인에 답을 받지 못하면 "events not listed"로 실패하던 대신 그 사람으로 이벤트를 읽습니다(#1060).

**게이트웨이**

- 파드 IP로 보내는 AWS Application Load Balancer 뒤(차트 Ingress에 `alb.ingress.kubernetes.io/target-type: ip`)에서는 게이트웨이 파드가 멈추기 전에 25초를 기다리고(`podShutdown.preStopSeconds`가 0이거나 25보다 크면 그 값, 종료 유예 55초), Ingress의 `alb.ingress.kubernetes.io/target-group-attributes`에 `deregistration_delay.timeout_seconds=20`이 붙습니다(적힌 속성 뒤에, 지연이 이미 적혀 있으면 그대로). AWS Load Balancer Controller가 이 값을 대상 그룹에 넣습니다. 0.7.8대로 두려면 `gateway.preStopSeconds: 5`와 그 주석에 `deregistration_delay.timeout_seconds=300`을 적습니다([여러 대로 띄우기](high-availability.md#시작하기-전에)). 차트가 둘을 넣은 동안은 설치 안내가 "Behind an AWS ALB that sends to pod IPs" 아래에 그렇게 알리고, 하나뿐이면 그 노드를 드레인하는 동안 대상이 갱신되지 않으므로 AWS Load Balancer Controller 파드를 둘 이상 두라고 알려 줍니다(#1072).
- 0.7.8에서 0.7.9로 처음 올릴 때는 게이트웨이 파드가 바뀌고(기다림 5초 → 25초), 그때 내려가는 파드는 5초를 기다리는 0.7.8 파드라서, 파드 IP로 보내는 AWS Application Load Balancer 뒤에서는 그 한 번에 [여러 대로 띄우기](high-availability.md#시작하기-전에)에 적은 502 · 504가 날 수 있습니다. 0.7.8이 거기서 안내한 값(`podShutdown.preStopSeconds: 25`와 `alb.ingress.kubernetes.io/target-group-attributes`의 `deregistration_delay.timeout_seconds=20`, [0.7.7에서 0.7.8로 업그레이드](upgrade-0.7.8.md#3-바꿔야-하는-값))으로 이미 돌고 있는 설치는 이 일이 없습니다. 내려가는 게이트웨이 파드가 이미 25초를 기다리기 때문이고, 실패가 없던 18번의 교체와 같은 꼴입니다. 0.7.8 안내대로 `podShutdown.preStopSeconds: 25`와 20초 지연을 손으로 넣은 설치는 그대로 두거나 `podShutdown.preStopSeconds`를 5로 되돌려도 됩니다. 어느 쪽이든 게이트웨이는 25초를 기다립니다.

**API 답**

- `POST /api/v1/auth/change-password`는 틀린 현재 비밀번호에 401 대신 403 `{"detail": "Invalid current password", "reason": "password_mismatch"}`로 답합니다. 콘솔은 로그인을 유지하고 칸 아래에 "현재 비밀번호가 틀립니다."라고 알립니다(#1077).
- `POST /api/v1/auth/admin/users/{user_id}/reset-password`는 SSO 계정에 400으로 답하고, 차트의 admin 계정은 무엇이 만들었든 재설정합니다([1.7](#17-sso-계정과-비밀번호), #1077).
- `POST /api/v1/auth/change-password`는 SSO 계정에 현재 비밀번호를 확인하기 전에 400으로 답하고 `user.password.change` 실패 행 `single_sign_on_account`를 남깁니다. 차트의 admin 계정은 무엇이 만들었든 비밀번호를 바꿉니다([1.7](#17-sso-계정과-비밀번호), #1077).
- `auth.passwordLogin: admin-only`이면 `POST /api/v1/auth/login`은 `admin.email` 적힌 그대로에만 열립니다. 이전 버전이 통과시키던 대소문자만 다른 주소는 403 `Password login is disabled; use single sign-on`과 `user.login.failed` 행 `password_login_disabled`를 받으므로, 그런 주소의 비밀번호 계정은 거기서 더는 로그인하지 않고 `admin.email` 그대로 저장된 계정은 그대로 로그인합니다. 나중에 `admin.email`을 다른 대소문자로 고쳐 적은 설치는 옛 글자로 저장된 옛 admin 계정이 거절되므로, `admin.email`을 그 계정이 저장된 글자와 같게 적습니다(`admin.email` 그대로 저장된 계정은 없으면 부팅 때 만들어지고 `reset-admin`이 되살립니다)(#1077).
- 네트워크 흐름 읽기는 Hubble Relay나 Calico Whisker가 스스로 쓴 401·403(Kubernetes Status가 아닌 본문, 또는 주소로 등록한 Relay의 어떤 본문)과 Relay의 gRPC 상태 7·16(PermissionDenied, Unauthenticated)에 403 대신 502로 답합니다. API 서버 프록시를 거친 Kubernetes Status는 그대로 클러스터의 거절입니다(#1077).
- 기다림 20초를 넘긴 클러스터 읽기는 503으로 답합니다(#1060).
- AI 도구 `alerts_inbox`(`alert_id`와 함께)와 `investigations`(`investigation_id`와 함께)는 `generator_url`과 `alertmanager_url` 대신 알림의 규칙 식을 `expr`로 줍니다. MCP로 부르는 쪽도 같습니다. 화면과 경로는 두 링크를 그대로 둡니다(#1087).
- 알림 웹훅은 절대 http·https 주소가 아닌 `generatorURL`이나 `externalURL`을 빈 값으로 저장하고, 메시지마다 한 번 그 scheme을 로그에 남깁니다. 전에 저장된 행은 그 값을 그대로 두고, 알림 창은 그런 주소를 글로 보여 줍니다(#1060).
- `admin.retention.purge` 행에 `failed_windows`가 더해지고, 실패한 창이 하나라도 있으면 실패 행입니다. 실패한 창이 뒤의 창을 더는 멈추지 않습니다(#1072).
- `GET /api/v1/cluster/features`에 `anomalyRank`와 `callGraph`(#902), `nodeNeighbors`(#1088)가 더해집니다.
- `/logsearch/logql`과 `/traces/metrics`의 지표 답에 `seriesTotal`이 더해집니다. 100개로 자르기 전 저장소가 답한 시리즈 수입니다(#886). `features.logSearch.queryMaxBytes`를 정하면 `/logsearch/logql`이 `estimatedBytes`를 주고, 한도를 넘는 질의에는 400으로 답합니다(#902).
- `GET /api/v1/namespaces/{namespace}/resource-graph`가 `include=calls`와 `range`, 또는 `start`와 `end`를 받고, 다른 `include`에는 400으로 답합니다(#902).
- 새 경로는 `GET /api/v1/timeline/changes`, `GET /api/v1/namespaces/{namespace}/timeline/changes`, `GET /api/v1/namespaces/{namespace}/anomalies`(#902), `GET /api/v1/nodes/{name}/neighbors`(#1088)입니다. 스위치가 꺼져 있으면 404로 답하고, anomalies 경로는 기본 설치에서 답합니다.
- `features.alertInvestigation.evidenceCheck`나 `ledger`를 켠 채 돈 알림 조사의 답에는 `result`가 있고(#882), `features.alertInvestigation.verdict`도 켜면 그 안에 `verdict`가 있습니다(#1088). 그때 `ai.investigation.run` 행에 `after.verdict`가 더해집니다.
- AI 도구 `get_pod_metrics`는 Pod가 없는 네임스페이스에서 kubectl의 문장으로 만든 행 하나 대신 `[]`로 답합니다. AI 도구 `issues`는 네임스페이스나 심각도로 좁힌 호출에서 읽지 못한 목록을 `not_read`와 `not_read_note`로 더하고, 그때는 문제가 없다는 `hint`가 없습니다. 모든 목록을 읽었다면 답은 전과 같습니다(#1088).
- AI 도구 `k8s_get_pod_logs`는 노드에 더는 없는 로그(대개 컨테이너가 지워진 `previous: true` 읽기)에 `{"status": "no_log"}`로 답하고, kubelet의 글을 `reason`에, 다른 볼 곳을 `hint`에 적습니다. 전에는 kubelet이 준 한 줄 `unable to retrieve container logs for …`을 로그로 주었습니다. 다른 답은 그대로입니다(#1094).

**감사 로그**

- 아무것도 돌기 전에 거절된 Approve와 Reject(승인이 없거나 부른 사람의 것이 아님, 더는 대기 중이 아님, 승인 토큰 서명이 맞지 않음, 모델 설정을 쓸 수 없음)는 `ai.tool.approve`나 `ai.tool.reject` 실패 행을 남깁니다. `ai.tool.interrupt` 행은 `ai.tool.execute`처럼 실행 인자의 가린 칸을 담습니다. 승인이 interrupted로 끝난 뒤에 실행이 돌아온 승인된 쓰기는 실패로 남고, 그 `ai.tool.execute` 행에 `after.late_after_interrupt: true`가 붙습니다(#1077).
- 승인된 실행의 끝과 그 `ai.tool.execute` 행은 한 트랜잭션에서 씁니다(#1077).
- 서버가 하트비트를 저장하지 못해 닫힌 노드 셸의 `k8s.session.end` 행(`heartbeat_lost`)은 데이터베이스와 감사 저장소가 다시 행을 받을 때까지 최대 256개까지 쥐었다가 쓰고, 그 `after`에 `ended_at`이 더해집니다(#1060).
- auth-service 레플리카가 둘 이상이면 보존 기간 정리는 한 번에 레플리카 하나에서만 돕니다. 다른 레플리카가 도는 동안 차례가 온 레플리카는 그 차례를 건너뛰고 행을 쓰지 않으며 `retention: another replica is purging; this turn is left to it`를 로그에 남깁니다. 도는 중에 노드와 함께 사라진 레플리카는 PostgreSQL이 그 연결을 끊을 때까지 잠금을 쥐고, 그때까지의 차례는 건너뜁니다(#1072).
- 보존 기간 정리(`retention.chatDays`)는 만료된 대화마다 도구 승인, 문맥, 메시지를 대화보다 먼저, 5,000개까지의 묶음마다 한 트랜잭션으로 지우므로 채팅 표에 `ON DELETE CASCADE`가 없는 곳(마이그레이션 전에 ai-service ORM이 만든 표)에서도 돕니다. 그런 곳에서 0.7.8은 매번 첫 만료 대화에서 실패했습니다(#1072).
- 감사 행은 어떤 글이 들어 있어도 저장됩니다. UTF-8이 아닌 바이트, 0x00, JSON에서 짝이 없는 서로게이트, 2,704바이트를 넘는 색인 값이 든 행은 PostgreSQL이 받지 않아 데이터베이스에 없었습니다. 이제 그런 글은 U+FFFD로 바꾸고, 0x00은 빼고(JSON에서는 U+FFFD), 색인이 있는 열(`service`, `action`, `actor_user_id`, `target_id`)은 앞 2,692바이트를 저장합니다. 그래도 글 때문에 PostgreSQL이 받지 않은 행은 그 동작 이름과 함께 로그에 남고(`audit: row refused for its text`), 감사 저장소를 고장으로 세지 않습니다(#1093).
- `user.login.failed`에 사유 `single_sign_on_account`가 더해집니다(#1077).
- `user.account.link`에 `before.auth_source`와 `after.auth_source`(`oidc`)가 더해지고, 비밀번호가 없던 계정이면 `password_removed`가 false입니다(#1077).
- `server reset-admin --email`은 차트의 admin 계정이 아닌 SSO 계정에 Admin 역할, 잠금 해제, 세션 끝내기만 하고 비밀번호는 주지 않습니다. `user.account.recover`에 `after.password_set`이 더해집니다(#1077).

**지표**

- 새 지표: k8s-service의 클러스터 차단기, 실시간 목록의 기다림, 노드 드레인, Redis 거절(#1060), `limiter="cache"`와 읽기 자리 기다림(#1072), 데이터베이스 풀(#1060), Claude Code의 실행과 기다림(#1060), 결과별 모델 요청과 알림 조사(#1060), k8s-service에서 큰 공유 답이 쓰기 자리를 기다린 시간(#1072)입니다. 목록은 [메트릭](metrics.md)에 있습니다.
- ai-service의 HTTP 지표는 kubelet이 `/api/v1/ai/health`를 묻는 프로브를 빼고 셉니다([1.5](#15-알림-규칙), #1060).

**화면**

- Cluster View의 파드 창은 Exec 탭을, 상자 메뉴는 Exec 항목을 Pods 서랍처럼 그 사람이 그 파드에 터미널을 열 수 있을 때만 보여 줍니다. Write 역할에는 더는 보이지 않습니다(#1077).
- AI가 쓴 글(채팅 답, 알림 조사 보고서, 최적화 답) 속 이미지는 글을 그릴 때 불러오지 않습니다. 다른 호스트의 http 또는 https 주소에 있는 이미지는 그 주소로 가는 링크가 되어 새 탭에서 열리고, 대체 텍스트(없으면 주소)가 링크 글자가 됩니다. 그 밖의 이미지는 콘솔 자기 호스트의 것과 `data:` 주소의 것도 포함해 대체 텍스트만 보입니다. 게이트웨이 뒤에서는 Content-Security-Policy가 콘솔 자기 호스트와 `data:`의 이미지만 불러오게 하므로, 다른 호스트의 이미지는 전에도 불러와지지 않았습니다(#917).
- 워크로드로 좁힌 로그 검색(그 서랍의 로그 검색 절과 AI 도구 `logsearch`)은 그 컨트롤러가 붙이는 파드 이름과 맞춥니다. 이름이 같은 글자로 시작하는 다른 워크로드는 빠지고, Kubeast에서 시작한 CronJob의 Job 파드와 이름이 긴 워크로드의 파드를 찾습니다(#1077).
- 워크로드 이름의 점은 서랍의 Prometheus 그래프에서 점하고만 맞습니다(#1079).

**그 밖**

- 알림 조사를 켰다면(`features.alertInvestigation.enabled`) 첫 메시지는 알림의 `generatorURL`에서 규칙 식만 `expr`로 모델에 줍니다. 알림을 보낸 서버의 주소(스킴, 호스트, 포트, 경로, 그 안의 사용자와 비밀번호)는 빠지고, Grafana가 관리하는 규칙의 페이지처럼 식이 없는 링크는 아무것도 더하지 않습니다. 알림함, 보고서 창, 저장된 행은 링크를 받은 그대로 둡니다(#1087).
- Gemini 모델(공급자 `google` 또는 `gemini`)이면 채팅과 알림 조사에서 함수 호출의 thought signature를 그 호출과 함께 돌려보냅니다. Gemini 3 이상은 한 턴의 두 번째 도구 단계부터 이것을 요구합니다. 서버가 첫 모델 호출 전에 하는 호출에는 Google의 자리표시 서명이 붙습니다(#1087).
- 공급자 `anthropic`에서는 도구를 부른 뒤 도구를 더 부르지 않는 호출(알림 조사의 마지막 호출, `evidenceCheck`나 `ledger`를 켠 조사의 다시 묻기, 길이에서 잘린 채팅 답의 나머지)이 앞 루프의 도구를 `tool_choice` `none`과 함께 보냅니다. 0.7.8은 그런 호출에 도구를 보내지 않았습니다. Claude Fable 5.2, Mythos 5.2, Mythos 5.1은 생각(thinking)을 그것을 만든 도구 없이 돌려보내면 400으로 답하고, Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5는 그럴 수 있습니다. 그런 때 마지막 단계까지 쓴 조사는 실패했고, 잘린 채팅 답은 잘린 자리에서 멈췄습니다(#1082).
- 채팅 답 하나는 모델 호출을 20번까지 합니다(`ai.chat.maxSteps`, 1~100). 전에는 10번이었습니다. 마지막 호출은 도구를 부르지 못하고, 읽은 것으로 질문의 언어로 답하라는 지시를 받습니다. 0.7.8에서는 열 번째 호출이 청한 도구가 돌고, 답은 읽은 것을 쓰지 않은 고정된 한국어 문장 하나였습니다. 그 마지막 호출이 글을 쓰지 않으면 답에 까닭이 나옵니다. 호출을 모두 썼거나, 답 최대 길이에 닿았거나, 공급자의 필터가 막은 것입니다. 호출이 많으면 토큰을 더 쓸 수 있고, 채팅 토큰 예산은 턴을 시작할 때 확인합니다. Claude 구독에서는 Claude Code가 전처럼 `ai.providers.claudeCode.maxTurns`(10)에서 멈추고, 도구 없는 실행 하나가 자기 칸을 잡고 답합니다. 그 칸도 첫 실행처럼 기다립니다. 시간 안에 칸이 나지 않거나 그 실행이 시작되지 않으면, 답은 읽은 것을 그대로 두고 다시 질문하라는 말로 끝납니다(#1084).
- Claude 구독에서 채팅 답을 한도에서 닫는 호출은 도구 결과를 클러스터 글이 닫지 못하는 표식 사이에서, 줄마다 `| ` 뒤에 읽습니다. 그 안의 지시나 요청은 사용자의 것이 아니고, 거기서 청하는 링크는 답에 넣지 말라는 말도 함께 받습니다. 알림 조사를 닫는 호출과 다시 묻기도 같은 표식을 씁니다(#1087).
- Claude 구독(공급자 `claude-code`)에서는 Claude Code가 모든 프롬프트를 쓴 그대로 받습니다(#1086).
- 채팅 질문은 출력 형식을 달라고 할 때만 `k8s_get_resources`(YAML이면 `k8s_get_resource_yaml`, 이벤트·로그·describe를 적었으면 그것도)로 좁혀집니다. kubectl의 `-o json` · `-o yaml` · `-o wide`, "as YAML", "show the YAML", "in JSON format", "wide output"과 그에 해당하는 한국어 말입니다. 0.7.8에서는 질문 어디든 yaml, yml, wide, json이라는 글자가 있으면 그렇게 좁혀졌습니다(#1078).
- `ai.debugDump`의 로그 줄은 `ai.redaction.enabled`와 `ai.redaction.disable`의 값과 상관없이 모든 자격 증명 규칙으로 가립니다(#1079).
- k8s-service 하나(`streams.enabled`면 k8s-service-stream)는 모든 계정을 합쳐 자기에게 열린 터미널과 실시간 로그를 `multicluster.maxStreamsPerServer`(443)개까지만 받고, 넘는 것은 계정 상한을 넘는 것처럼 거절합니다. 그 사람에게는 서버가 찼다고 알리고, 거절은 그 동작의 실패 감사 행을 남깁니다(#1060). `0`이면 이 상한이 없고, 올릴 때는 그 파드의 메모리 한도와 함께 올리세요(kind 노드에서 하나에 약 0.37 MiB).
- 0.7.9는 차트 객체, ClusterRole, Role을 새로 더하지 않습니다.

**AI 스위치**

- `features.anomalyRank.enabled`는 기본 켬(beta)입니다. AI 채팅, 플로팅 채팅, MCP 서버가 도구 `anomaly_rank`를 받아 읽기 도구가 52종에서 53종이 되고, `GET /api/v1/namespaces/{namespace}/anomalies`가 AI를 끈 설치에서도 호출한 사람으로 읽어 답합니다. 답 하나는 저장소 조회를 20초 안에 12번까지 합니다. 네임스페이스로 한정된 권한에는 지표 확인이 없고, 로그와 트레이스 확인은 로그·트레이스 도구의 규칙을 따릅니다. `false`면 0.7.8과 같습니다(#902, #1088).
- `ai.ruleCards.investigations`와 `features.alertInvestigation.rules` · `changesFirst` · `narrowFirst` · `ledger` · `evidenceCheck` · `verdict`는 기본 켬(alpha)이고 알림 조사만 바꿉니다. 알림 조사는 꺼진 채입니다(`features.alertInvestigation.enabled`). 켜면 조사는 첫 모델 호출 전에 바뀐 것과 이상 순위를 읽고, 보고서 끝에 원인·가설·결론 묶음이 붙고, 모델 호출마다 2,048 대신 4,096 토큰까지 답할 수 있고, 모델 호출이 하나 더 있을 수 있습니다(#1088).
- 나머지 AI 스위치는 꺼져 있습니다. `ai.timelineChanges`, `ai.timelineChangesMore`, `ai.causeQuestions`, `ai.refuseRepeatedReads`, `ai.toolResultDetails`, `ai.toolResultsJSON`, `ai.redaction.numbered`, `ai.ruleCards.chat`, `ai.ruleCards.symptoms`, `features.callGraph.enabled`, `features.nodeNeighbors.enabled`, `features.logSearch.queryMaxBytes`(0)입니다.
- 0.7.9가 더한 AI 스위치를 모두 `false`로 두면 모델이 받는 프롬프트와 도구 정의는 스위치 없이 바뀌는 것을 빼고 0.7.8과 같습니다.

## 5. 이번 업그레이드에서 한 번 일어나는 일

- **Kubeast 서버 파드가 모두 바뀜**(#1072). 이미지가 바뀌고, `podStartup.quickReady`면 프로브도 바뀝니다.
- **`tool_approvals` 인덱스**(#1077). 00033이 마이그레이션의 트랜잭션 안에서 한 번 만들고, 그것이 끝날 때까지 `tool_approvals`에 쓰는 일(새 승인 카드, Approve, Reject)이 기다립니다(행 100만 개에 1.5초쯤). 〔리허설 데이터에서 걸린 시간: 리허설 뒤에 씁니다.〕
- **SSO가 닿은 자기 가입 계정**(#1077). 00032가 `user.register` 행으로 가입 화면이 만든 계정을 표시하고(`self_signed_up`), 표시된 비밀번호 계정 가운데 비밀번호가 없거나 앞선 `user.account.link` 행이 가리키는 계정을 한 번 `oidc` 계정으로 바꿉니다. 가진 비밀번호는 두고 세션은 끝내며, 계정마다 `system` / `migration`의 `user.account.link` 행(`sessions_ended`)을 남깁니다. 관리자가 만든 계정은 등급이 무엇이든 바꾸지 않습니다. 보존 기간 정리가 `user.register` 행을 이미 지운 자기 가입 계정은 표시되지 않아 비밀번호 계정으로 남고, `user.account.link` 행이 지워졌고 그 뒤 관리자가 비밀번호를 준 계정도 같습니다.
- **http·https가 아닌 주소로 저장된 알림**(#1060). 0.7.9 전에 저장된 행은 그 주소를 그대로 두고 창은 글로 보여 줍니다. 새 알림은 빈 값으로 저장합니다.
- **SSO 계정의 비밀번호**(#1077). 업그레이드한 때부터 로그인하지 않습니다. 이미 열린 세션은 `auth.sessionAbsoluteHours`까지 이어집니다.
- **첫 보존 기간 정리**(#1072). 채팅 표에 `ON DELETE CASCADE`가 없는 곳에서 0.7.8은 매번 첫 만료 대화에서 실패했고, 채팅 창 뒤의 창(검토 서명, 알림 조사, 알림함)도 건너뛰었습니다. 그래서 0.7.9의 첫 정리는 만료된 대화와 함께, 그 창들의 기간을 넘겨 쌓인 것을 모두 지웁니다.
- **새로 고치지 않은 페이지**(#1060). 열어 둔 0.7.8 페이지는 다시 불러올 때까지, 서버 상한에서 거절된 터미널을 까닭을 알리는 줄 없이 닫고, 그곳에서 거절된 실시간 로그에는 계정 상한 글을 보여 줍니다.
- 〔리허설에서 한 번 보인 그 밖의 일: 리허설 뒤에 씁니다.〕

## 6. 업그레이드한 뒤

```bash
helm list -n kubeast                 # CHART kubeast-0.7.9
kubectl -n kubeast get pods          # 모든 파드가 Running이고 준비됨
helm get notes kubeast -n kubeast    # 설치 안내
```

**스키마**(#882, #1077):

```bash
kubectl -n kubeast exec deploy/postgres -c postgres -- \
  psql -U kubeast -d kubeast -c "SELECT max(version_id) FROM goose_db_version"    # 33
```

**k8s-service의 키**(#1072). k8s-service가 Secret에서 이름으로 받는 키입니다.

```bash
kubectl -n kubeast get deploy k8s-service -o yaml | grep -B3 'secretKeyRef'
```

**알림 규칙**(#1060):

```bash
kubectl -n kubeast get prometheusrule -o yaml | grep 'alert: KubeastAI'
```

**보존 기간 정리**(#1072). auth-service 레플리카가 둘 이상이면 차례를 건너뛴 레플리카가 그것을 로그에 남깁니다.

```bash
kubectl -n kubeast logs deploy/auth-service | grep 'another replica is purging'
```

**거절된 비밀번호 로그인**(#1077). Admin → Audit Logs에서 행위 `user.login.failed`가 거절마다 `single_sign_on_account`와 함께 보입니다. 00032가 바꾼 계정은 `system` / `migration`의 `user.account.link` 행입니다.

## 7. 0.7.8로 되돌리기

```bash
helm history kubeast -n kubeast                        # 0.7.8의 revision
helm rollback kubeast <revision> -n kubeast
```

- **데이터베이스**(#882, #1077): `helm rollback`은 Down 마이그레이션을 돌리지 않으므로 `alert_investigations.result`, `auth_users.self_signed_up`, `tool_approvals`의 인덱스 두 개는 남습니다. 0.7.8 서비스는 스키마 30 이상을 기다리며, 스키마 33은 그 조건에 맞습니다. 〔0.7.8이 그 데이터베이스에서 뜨는지: 리허설 뒤에 씁니다.〕
- **프로브**(#1072): `helm rollback`이 0.7.8의 프로브를 되돌립니다.
- **k8s-service의 Secret 키**(#1072): `helm rollback`은 k8s-service와 k8s-service-stream에 다시 주 Secret을 통째로 환경으로 줍니다.
- **Kubernetes 버전 검사**(#1072): `helm rollback`은 0.7.8 릴리스의 매니페스트를 그대로 적용하고 렌더하지 않으므로 검사가 돌지 않습니다.
- **알림 규칙**(#1060): `helm rollback`이 0.7.8의 PrometheusRule을 되돌려 놓고, AI 알림 두 개는 없어집니다.
- **보존 기간 정리**(#1072): 0.7.8의 auth-service는 파드마다 따로 정리를 돌리고, 채팅 표에 `ON DELETE CASCADE`가 없는 곳에서는 첫 만료 대화에서 실패합니다.
- **AWS Application Load Balancer 뒤 게이트웨이**(#1072): 0.7.8은 등록 해제 지연 없이 Ingress를 만듭니다. 대상 그룹이 20초로 남을 수 있으니 기본값으로 돌리려면 `ingress.annotations`의 `alb.ingress.kubernetes.io/target-group-attributes`에 `deregistration_delay.timeout_seconds=300`을 적습니다.
- **API 답과 감사 행**: 0.7.9가 쓴 감사 행은 쓴 그대로 남습니다. 〔그 밖은 리허설 뒤에 씁니다.〕
- **SSO 계정의 비밀번호 로그인**(#1077): 0.7.8은 거절하지 않으므로 그런 계정이 가진 비밀번호로 다시 로그인되고, 관리자 재설정도 비밀번호를 줍니다. 00032는 되돌지 않습니다. 바꾼 계정은 `oidc`로 남고, 0.7.8은 이 값을 표시에만 읽습니다. 0.7.8은 `self_signed_up`을 모르므로, 업그레이드 뒤 0.7.8에서 만든 자기 가입 계정은 0.7.9로 돌아와도 표시가 없어 비밀번호 계정으로 남고, 0.7.8에서 SSO가 닿은 자기 가입 계정은 0.7.9에서 다음 SSO 로그인 때까지 비밀번호 계정으로 남습니다. `helm rollback`은 Down 마이그레이션을 돌리지 않으므로 `self_signed_up` 칸은 남습니다. 00032의 Down은 돌리면 칸을 지우고, 바꾼 계정은 `oidc`로 둡니다. 〔리허설에서 확인합니다.〕
- **터미널과 실시간 로그의 서버 상한**(#1060): 0.7.8에는 `multicluster.maxStreamsPerServer`가 없으므로, `helm rollback` 뒤 k8s-service는 계정마다의 상한(`multicluster.maxTerminalsPerAccount`, `multicluster.maxFollowedLogsPerAccount`)이 허락하는 만큼 받고, 모든 계정을 합친 상한은 없습니다.
- **AI 스위치**: 0.7.8은 하나도 읽지 않습니다. auth-service가 시작할 때 기본 역할의 권한을 다시 쓰므로 Read에서 `ai.tool.anomaly_rank`가 빠집니다. 사용자 정의 역할에는 그 줄이 남고, 0.7.8에는 그 이름의 도구가 없습니다. `alert_investigations.result`에 남은 결과는 그대로 있고 0.7.8은 보여 주지 않습니다.
- **채팅의 호출 상한**(#1084): 0.7.8은 `ai.chat.maxSteps`를 읽지 않고, 채팅 답 하나는 다시 모델 호출을 10번까지 합니다.

## 8. Docker Compose

내려받은 폴더에서 올립니다. 스크립트는 `.env`를 다시 씁니다. 그 안의 비밀번호와 키, `OPENAI_MODEL`, `OPENAI_BASE_URL`은 남고 손으로 더한 줄은 없어집니다. 스크립트 뒤에 그 줄을 다시 더하고 `docker compose up -d`를 실행하거나, `.env`에서 포트만 바꾸는 `--skip-env`로 스크립트를 실행합니다. `--port`(빼면 8000)를 `.env`에 쓰므로, 지금 쓰는 Gateway 포트를 줍니다.

```bash
cd Kubeast
docker compose exec -T postgres pg_dump -Fc -U kubeast kubeast > kubeast-before-0.7.9.dump
git fetch --tags && git checkout v0.7.9
./install-docker.sh --port <지금 포트>
```

`KUBEAST_TAG`를 정해 두었다면 `v0.7.9`로 바꾸거나 지웁니다.

차트와 다른 점은 다음과 같습니다.

- **프로브, Kubernetes 버전 검사, 알림 규칙, 로드 밸런서 뒤 게이트웨이 기다림, 게이트웨이 파드 이름 헤더**: `podStartup.quickReady`, [1.3](#13-kubernetes-버전)의 검사, PrometheusRule, `gateway.preStopSeconds`, `gateway.servedByHeader`는 차트만 바꿉니다(Compose의 게이트웨이는 차트의 `nginx.conf`를 그대로 읽으므로 `X-Kubeast-Gateway`를 보내지 않습니다).
- **주 Secret**: Compose의 k8s-service는 다른 서비스처럼 그대로 `.env` 전체를 읽습니다(#1072은 차트만 바꿉니다).
- **보존 기간 정리**: Compose는 auth-service 하나로 돌므로 잠금은 늘 그 서비스의 것이고, 정리가 도는 동안 연결을 하나 더 씁니다(Compose는 연결 합계를 검사하지 않음). 정리의 다른 변경은 그대로 적용됩니다.
- **터미널과 실시간 로그의 서버 상한**(#1060): Compose는 값을 정하지 않으므로 k8s-service마다 코드 기본값인 모든 계정 합쳐 443개를 씁니다. 차트의 `multicluster.maxStreamsPerServer` 기본값과 같습니다. 바꾸려면 `.env`에 `MAX_STREAMS_PER_SERVER`를 정합니다(`0`이면 이 상한 없음).
- **Admin → Clusters에서 바꾼 클러스터 kubeconfig**: 데이터베이스가 그 변경을 받지 않으면 파일에 앞의 kubeconfig를 되돌려 놓습니다(#1079).
- **채팅의 호출 상한**(#1084): Compose는 값을 정하지 않으므로 ai-service가 코드 기본값 20을 씁니다. 차트의 `ai.chat.maxSteps` 기본값과 같습니다. 바꾸려면 `.env`에 `AI_CHAT_MAX_STEPS`를 정합니다.
- **0.7.9의 AI 스위치**: Compose는 하나도 정하지 않으므로, 차트의 기본값과 상관없이 모두 꺼져 있습니다. 차트 설치에는 있는 `anomaly_rank`가 Compose 설치에는 없습니다. 켜려면 ai-service · k8s-service · tool-server가 읽는 `.env`에 그 변수를 `true`로 적습니다. `AI_TIMELINE_CHANGES`, `AI_REFUSE_REPEATED_READS`, `AI_TOOL_RESULT_DETAILS`, `AI_RULE_CARDS_CHAT`, `AI_RULE_CARDS_INVESTIGATIONS`, `AI_TOOL_RESULTS_JSON`, `ANOMALY_RANK_ENABLED`, `CALL_GRAPH_ENABLED`, `ALERT_INVESTIGATION_RULES`, `ALERT_INVESTIGATION_CHANGES_FIRST`, `ALERT_INVESTIGATION_NARROW_FIRST`, `ALERT_INVESTIGATION_LEDGER`, `ALERT_INVESTIGATION_EVIDENCE_CHECK`, `ALERT_INVESTIGATION_VERDICT`, `AI_TIMELINE_CHANGES_MORE`, `AI_CAUSE_QUESTIONS`, `AI_RULE_CARDS_SYMPTOMS`, `NODE_NEIGHBORS_ENABLED`입니다.
- **차트와 같은 것**: 마이그레이션(스키마 33), 클러스터 읽기 기다림, 차단기, API 답, 감사 행은 차트와 같습니다.
- **되돌리기**: `git checkout v0.7.8 && ./install-docker.sh --port <지금 포트>`를 씁니다. 〔리허설 뒤에 씁니다〕
