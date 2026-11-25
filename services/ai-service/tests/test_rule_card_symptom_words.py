"""The default cards' symptoms (ai.ruleCards.symptoms): which alert names and which English and Korean sentences pick which
card, which pick none, and what the cards with symptoms hold. The sentences are general ones, written without the
evaluation's cases."""

import hashlib
from types import SimpleNamespace

import pytest

from app.services import rule_cards
from app.services.ai.tools import get_tools_definition
from app.services.tool_whitelists import READONLY_TOOL_NAMES

OFF = rule_cards.cards_of("", "")
ON = rule_cards.cards_of("", "", True)
NEW_KINDS = ["error_rate", "latency", "resource_pressure"]
WITH_PHRASES = {"resource_limit", "dependency_down", "dependency_slow", *NEW_KINDS}
DEFINED = {tool["function"]["name"] for tool in get_tools_definition(SimpleNamespace(_filter_tools_by_role=lambda tools: tools))}


def picked(cards=ON, **kw):
    return [card.kind for card in rule_cards.pick(cards, **kw)]


# --- the alert's name ---------------------------------------------------------------------------------------------

# Names people give such alerts, as one word, with dashes or underscores, or in Korean.
NAMES = {
    "latency": [
        "HighLatency", "LatencyHigh", "HighRequestLatency", "RequestLatencyHigh", "APIHighLatency", "HighP99Latency",
        "P95LatencyHigh", "SlowRequests", "SlowResponses", "ServiceSlow", "SlowService", "HighResponseTime", "ResponseTimeHigh",
        "RequestTimeout", "SearchRequestTimeouts", "RequestsTimingOut", "http-latency-high", "응답시간증가",
    ],
    "error_rate": [
        "HighErrorRate", "ErrorRateHigh", "HTTPErrorRateHigh", "High5xxRate", "HTTP5xxHigh", "HighHttp5xxErrors", "TooManyErrors",
        "HighFailureRate", "RequestFailures", "RequestsFailing", "HighRequestErrors", "LowSuccessRate", "AvailabilityLow",
        "ServiceDown", "SearchServiceDown", "ServiceUnavailable", "EndpointDown", "WebsiteDown", "high_error_rate", "에러율높음",
    ],
    "dependency_down": ["InstanceDown", "DatabaseDown", "RedisDown", "KafkaDown", "DependencyUnavailable", "UpstreamUnavailable"],
    "dependency_slow": [
        "SlowDatabaseQueries", "SlowQueries", "DatabaseSlow", "ConsumerLagHigh", "KafkaConsumerLagHigh", "QueueBacklogGrowing",
        "TooManyConnections", "ConnectionPoolExhausted",
    ],
    "resource_pressure": [
        "HighCPUUsage", "CPUUsageHigh", "HighCpuUtilization", "HighMemoryUsage", "ContainerMemoryUsageHigh", "PodHighCpuUsage",
        "HostHighCpuLoad", "NodeHighLoad", "MemoryLeak", "CPUSaturation", "CPU사용률높음",
    ],
}


@pytest.mark.parametrize("kind, name", [(kind, name) for kind, names in NAMES.items() for name in names])
def test_a_generic_alert_name_picks_its_card(kind, name):
    assert picked(alertname=name, labels={"alertname": name, "severity": "warning", "namespace": "prod"}) == [kind]


@pytest.mark.parametrize("name", ["ErrorBudgetBurn", "SLOBurn", "SLOErrorBudgetBurn", "FastBurnSLO", "KubeAPIErrorBudgetBurn"])
def test_a_burning_error_budget_picks_the_error_rate_then_the_latency_card(name):
    assert picked(alertname=name) == ["error_rate", "latency"]


def test_a_burning_latency_objective_picks_the_latency_card_first():
    assert picked(alertname="LatencySLOBurn") == ["latency", "error_rate"]


# The alerts of kubernetes-mixin, the node-exporter mixin and kube-prometheus the general cards list, with those they had.
PUBLIC = {
    "KubeAPIErrorBudgetBurn": ["error_rate", "latency"], "KubeAggregatedAPIErrors": ["error_rate"],
    "KubeAPITerminatedRequests": ["error_rate"], "KubeClientErrors": ["error_rate"], "TargetDown": ["dependency_down"],
    "CPUThrottlingHigh": ["resource_limit"], "NodeCPUHighUsage": ["resource_pressure"],
    "NodeSystemSaturation": ["resource_pressure"], "NodeMemoryMajorPagesFaults": ["resource_pressure"],
    "NodeDiskIOSaturation": ["resource_pressure"], "NodeMemoryHighUtilization": ["node", "resource_pressure"],
    "KubeCPUOvercommit": ["resource_pressure"], "KubeMemoryOvercommit": ["resource_pressure"],
    "KubeHpaMaxedOut": ["resource_pressure"], "CoreDNSLatencyHigh": ["dns", "latency"], "etcdGRPCRequestsSlow": ["latency"],
    "etcdHighNumberOfFailedGRPCRequests": ["error_rate"],
}


@pytest.mark.parametrize("name, kinds", PUBLIC.items())
def test_a_public_alert_name_picks_its_cards(name, kinds):
    assert picked(alertname=name, labels={"alertname": name, "severity": "warning"}) == kinds


# What other public alerts say: none of it is a symptom of the general cards.
DESCRIPTIONS = {
    "KubePodNotReady": "Pod shop/web has been in a non-ready state for longer than 15 minutes on cluster c.",
    "KubeDeploymentGenerationMismatch": "Deployment generation for shop/web does not match, this indicates that the Deployment has failed but has not been rolled back.",
    "KubeDeploymentReplicasMismatch": "Deployment shop/web has not matched the expected number of replicas for longer than 15 minutes.",
    "KubeDeploymentRolloutStuck": "Rollout of deployment shop/web is not progressing for longer than 15 minutes.",
    "KubeStatefulSetReplicasMismatch": "StatefulSet shop/db has not matched the expected number of replicas for longer than 15 minutes.",
    "KubeDaemonSetRolloutStuck": "DaemonSet kube-system/agent has not finished or progressed for at least 15m.",
    "KubeDaemonSetNotScheduled": "2 Pods of DaemonSet kube-system/agent are not scheduled.",
    "KubeContainerWaiting": "pod/web in namespace shop on container app has been in waiting state for longer than 1 hour.",
    "KubeJobNotCompleted": "Job shop/report is taking more than 12h to complete.",
    "KubeJobFailed": "Job shop/report failed to complete. Removing failed job after investigation should clear this alert.",
    "KubeHpaReplicasMismatch": "HPA shop/web has not matched the desired number of replicas for longer than 15 minutes.",
    "KubePdbNotEnoughHealthyPods": "PDB shop/web expects 2 more healthy pods. The desired number of healthy pods has not been met for at least 15m.",
    "KubeCPUQuotaOvercommit": "Cluster has overcommitted CPU resource requests for Namespaces and cannot tolerate node failure.",
    "KubeQuotaAlmostFull": "Namespace shop is using 95% of its pods quota.",
    "KubePersistentVolumeFillingUp": "The PersistentVolume claimed by data in Namespace shop is only 2.1% free.",
    "KubePersistentVolumeErrors": "The persistent volume pv-1 has status Failed.",
    "KubeVersionMismatch": "There are 2 different semantic versions of Kubernetes components running.",
    "KubeClientCertificateExpiration": "A client certificate used to authenticate to kubernetes apiserver is expiring in less than 7.0 days.",
    "KubeSchedulerDown": "KubeScheduler has disappeared from Prometheus target discovery.",
    "KubeNodeNotReady": "node-1 has been unready for more than 15 minutes.",
    "KubeNodeUnreachable": "node-1 is unreachable and some workloads may be rescheduled.",
    "KubeletTooManyPods": "Kubelet 'node-1' is running at 95% of its Pod capacity.",
    "KubeNodeReadinessFlapping": "The readiness status of node node-1 has changed 5 times in the last 15 minutes.",
    "KubeNodeEviction": "Node node-1 is evicting Pods due to memory.available. Eviction occurs when eviction thresholds are crossed, typically caused by Pods exceeding RAM/ephemeral-storage limits.",
    "KubeletPlegDurationHigh": "The Kubelet Pod Lifecycle Event Generator has a 99th percentile duration of 12 seconds on node node-1.",
    "KubeletPodStartUpLatencyHigh": "Kubelet Pod startup 99th percentile latency is 62 seconds on node node-1.",
    "KubeletClientCertificateRenewalErrors": "Kubelet on node node-1 has failed to renew its client certificate (5 errors in the last 5 minutes).",
    "NodeFilesystemSpaceFillingUp": "Filesystem on /dev/sda1, mounted on /, at node-1 has only 12% available space left and is filling up.",
    "NodeFilesystemAlmostOutOfFiles": "Filesystem on /dev/sda1 at node-1 has only 3% available inodes left.",
    "NodeNetworkReceiveErrs": "node-1 interface eth0 has encountered 1200 receive errors in the last two minutes.",
    "NodeHighNumberConntrackEntriesUsed": "80% of conntrack entries are used.",
    "NodeClockSkewDetected": "Clock at node-1 is out of sync by more than 0.05s. Ensure NTP is configured correctly on this host.",
    "NodeRAIDDegraded": "RAID array 'md0' at node-1 is in degraded state due to one or more disks failures.",
    "NodeSystemdServiceFailed": "Systemd service chronyd.service has entered failed state at node-1",
    "NodeNetworkInterfaceFlapping": "Network interface eth0 changing its up status often on node-exporter monitoring/node-1",
    "Watchdog": "This is an alert meant to ensure that the entire alerting pipeline is functional. This alert is always firing, therefore it should always be firing in Alertmanager and always fire against a receiver.",
    "InfoInhibitor": "This is an alert that is used to inhibit info alerts. By themselves, the info-level alerts are sometimes very noisy, but they are relevant when combined with other alerts.",
    "PrometheusBadConfig": "Prometheus monitoring/k8s-0 has failed to reload its configuration.",
    "PrometheusRuleFailures": "Prometheus monitoring/k8s-0 has failed to evaluate 12 rules in the last 5m.",
    "AlertmanagerFailedToSendAlerts": "Alertmanager monitoring/main-0 failed to send 12% of notifications to slack.",
    "ConfigReloaderSidecarErrors": "Errors encountered while the monitoring/k8s-0 config-reloader sidecar attempts to sync config in shop namespace.",
    "etcdInsufficientMembers": "etcd cluster \"etcd\": insufficient members (1).",
    "etcdHighFsyncDurations": "etcd cluster \"etcd\": 99th percentile fsync durations are 0.8s on etcd instance 10.0.0.1.",
}


@pytest.mark.parametrize("name, description", DESCRIPTIONS.items(), ids=DESCRIPTIONS)
def test_another_alert_picks_what_it_did_before(name, description):
    labels = {"alertname": name, "severity": "warning", "namespace": "shop", "job": "kube-state-metrics"}
    assert picked(alertname=name, labels=labels, texts=[description]) == picked(OFF, alertname=name, labels=labels)
    assert picked(texts=[description]) == []


# --- what an alert says and what a person asks --------------------------------------------------------------------

SENTENCES = {
    ("latency",): [
        "The search service is slow", "Why is search slow?", "why is the search page so slow since this morning?",
        "Requests to the search service are slow", "Our API has become sluggish", "users say the site takes too long to load",
        "p99 latency of the search service is above 1s", "p95 latency > 500ms for search", "High request latency on search",
        "Latency increased after yesterday's deployment", "Response times went up around 10:00",
        "99th percentile latency for service search in namespace prod is above 500ms", "requests are timing out",
        "Search has been timing out a lot", "timeouts increased on search", "Performance has degraded since yesterday",
        "The service seems to be hanging", "intermittent timeouts between frontend and billing", "why did latency go up at 3pm?",
        "billing responses are taking way longer than usual",
        "search 서비스가 느려요", "search가 왜 이렇게 느려?", "search가 너무 느려요", "응답이 느립니다", "응답이 늦어요",
        "응답 시간이 길어졌어", "응답시간이 평소보다 많이 늘었어요", "latency가 높아졌는데 왜 그래?", "p99가 1초를 넘었어요",
        "배포 후 느려졌어", "새로 배포한 서비스가 느려요", "어제부터 검색이 느려졌어요", "페이지 로딩이 오래 걸려요",
        "요청이 지연되고 있어요", "요청에서 타임아웃이 발생해요", "타임아웃이 많이 나요", "서비스가 버벅여요", "성능이 떨어졌어요",
        "응답 시간이 최근 10분간 평균 2초를 넘었습니다", "search 서비스의 p99 지연 시간이 500ms를 초과했습니다",
        "API 응답 시간이 2배가 됐어요", "응답 속도가 떨어졌어요",
    ],
    ("error_rate",): [
        "requests to search are failing", "Why are requests failing in namespace prod?", "High number of failed requests",
        "Error rate of the search service is high", "error rate > 5% on search", "The 5xx rate exceeded 5% for search",
        "search is returning 500 errors", "users get 502 bad gateway", "Lots of 503s from search", "search errors spiked",
        "There was a spike in errors at 10:00", "Why is the error count so high", "Success rate dropped below 99%",
        "success rate < 99%", "The search service is unavailable", "the website is down", "Our API is not responding",
        "The site won't load", "the gateway returns 504", "The site has been down for 5 minutes", "I see a lot of 502s at the gateway",
        "요청이 자꾸 실패해", "API 호출 실패가 늘었어요", "에러율이 올랐어", "search 서비스 오류율이 높아요", "5xx가 급증했어요",
        "5xx 에러가 나요", "500 에러가 계속 나요", "서비스에서 에러가 많이 나요", "오류가 늘어나고 있어요", "서비스가 안 돼요",
        "사이트 접속이 안됩니다", "홈페이지가 안 열려요", "서비스가 죽었어요", "서비스에 장애가 발생했어요", "API가 응답이 없어요",
        "응답이 안 와요", "성공률이 99% 아래로 떨어졌어요", "가용성이 떨어졌어요", "search 서비스의 5xx 비율이 5%를 초과했습니다",
        "게이트웨이에서 502가 많이 나와요", "에러가 갑자기 많이 나요", "사용자가 접속을 못 해요", "앱이 자꾸 멈춰요",
        "서비스가 간헐적으로 실패해요",
    ],
    ("error_rate", "latency"): [
        "The error budget is burning too fast", "SLO breach for search", "The search service burns its error budget 14 times too fast",
        "SLO를 위반했어", "에러 버짓이 빠르게 소진되고 있어", "에러 버짓을 다 썼어요",
    ],
    ("dependency_down",): [
        "the database is down", "search cannot connect to the database", "Redis is unreachable from the search pods",
        "Connections to the database are refused", "billing can't reach the database", "Redis connections keep dropping",
        "DB 연결이 안 돼요", "DB에 연결할 수 없어요", "레디스가 죽었어요", "데이터베이스 응답이 없어요",
        "외부 API 연결이 자꾸 끊겨요",
    ],
    ("dependency_slow",): [
        "consumer lag keeps growing", "kafka consumers are lagging behind", "connection pool exhausted",
        "컨슈머 랙이 쌓이고 있어", "카프카 랙이 늘어나요", "커넥션 풀이 고갈됐어요", "DB 커넥션이 부족합니다",
    ],
    ("dependency_slow", "latency"): ["database queries are slow", "DB가 느려요", "쿼리가 느려졌어요"],
    ("resource_pressure",): [
        "CPU usage is high on node-1", "memory usage of search keeps rising", "the node is overloaded", "CPU is pegged at 100%",
        "memory is running out on the nodes", "There is a memory leak in search", "why is there high CPU on this node",
        "The pods use too much memory", "memory keeps climbing until the pod dies", "disk is almost full on node-3",
        "노드 CPU 사용률이 높아요", "CPU가 높아요", "메모리가 부족해요", "메모리 사용량이 계속 늘어나요", "디스크가 꽉 찼어요",
        "메모리 누수가 있는 것 같아", "노드가 과부하 상태예요", "리소스가 부족해요", "CPU를 너무 많이 써요",
    ],
    ("resource_limit",): ["the container hits its limit", "CPU 스로틀링이 심해요", "컨테이너가 메모리 한도에 걸렸어"],
}
SENTENCE_CASES = [(list(kinds), sentence) for kinds, listed in SENTENCES.items() for sentence in listed]


@pytest.mark.parametrize("kinds, sentence", SENTENCE_CASES, ids=[s for _, s in SENTENCE_CASES])
def test_a_sentence_that_says_a_symptom_picks_its_card(kinds, sentence):
    assert picked(texts=[sentence]) == kinds
    # as an alert's description, whose name and labels say nothing
    assert picked(alertname="Custom", labels={"alertname": "Custom", "service": "search"}, texts=[sentence]) == kinds


UNRELATED_EN = [
    "How many pods run on each node?", "List the services in the shop namespace", "Show me the deployments that were rolled out today",
    "What is the request rate of the search service?", "What does the latency metric mean?", "What is an SLO?",
    "Explain error budgets to me", "Create a Grafana dashboard for latency and errors", "How do I set CPU requests and limits?",
    "Scale web to 5 replicas", "Scale the search service down to one replica", "scale down redis", "What is a high availability setup?",
    "How do I configure a high CPU limit for the service?", "The deployment failed, show the logs", "Why did the job fail?",
    "kubectl apply failed with an error", "Which pods request more memory than they use?",
    "Why do pods with high memory requests fail to schedule?", "Show the slow query log settings",
    "Set the slow_query_log option on the database", "How do I enable slow logs in Elasticsearch",
    "Is the image pull slow on the new nodes?", "Why is the rollout so slow?", "the image pull is slow", "the build is slow",
    "Is slow start enabled on the target group?", "the pod is slow to start", "kubectl is slow",
    "The new pods are slow to pull their image", "Is my database backup running slow?", "Show the logs of the search pod",
    "Show errors in the search service's log", "How many errors are in the log?", "What is the request timeout of the ingress?",
    "Show me latency over the last hour", "Which PersistentVolumeClaims are unbound?", "Who can delete pods in namespace prod?",
    "Update the ConfigMap key LOG_LEVEL to debug", "What changed yesterday in the kube-system namespace?",
    "Which certificates expire this month?", "Compare cost between namespaces", "The pull request failed the checks",
    "Certificate signing request failed", "Liveness probe failed: HTTP probe failed with statuscode: 404", "Explain slow start in Envoy",
    "Is the service account allowed to list secrets?", "Where is the API documentation?", "Show pods sorted by restart count",
    "What is the CPU usage of each node?", "increase the memory limit of web to 1Gi", "Which nodes are under maintenance?",
    "How is the availability zone chosen for a volume?", "Delete the failed pods", "What is the high watermark in Kafka?",
    "Explain the difference between latency and throughput", "How do I make my service highly available",
    "Take the service down for maintenance", "shut down the database", "Drill down into Redis metrics",
    "The API call succeeded but the job failed", "What is the cache hit ratio of redis?", "Give me the p99 of every service",
    "Who changed the request limits of search?", "How do I fail over the database?", "Add a timeout of 5s to requests",
    "Which pods use the most memory?", "Show all error events", "Is the website behind the ingress?",
    "Which deployments have no readiness probe?", "Are there any pods without resource limits?", "What is a good target for p99?",
    "Which Helm releases are outdated?", "Is the failed job safe to delete?", "Explain the burn rate formula",
    "What happens to requests during a rolling update?", "Where is the database connection string stored?",
    "Show the latency chart next to the error chart", "Give me a sample PromQL for request latency",
    "Explain the high watermark and low watermark of disk eviction", "I plan to increase replicas before the sale",
]
UNRELATED_KO = [
    "파드 몇 개야?", "노드별 파드 수 알려줘", "search 서비스 목록 보여줘", "지연님이 배포한 서비스 알려줘", "김지연이 만든 요청을 보여줘",
    "이 서비스의 요청량이 얼마나 돼?", "CPU 요청량과 한도를 알려줘", "메모리 요청이 높은 파드 알려줘", "web의 메모리 한도를 높여줘",
    "메모리를 늘려줘", "배포가 실패했어", "잡이 실패했어", "이미지 빌드가 느려요", "배포가 느려요", "왜 배포가 이렇게 느려?",
    "파드 시작이 느려", "노드 조인이 왜 이렇게 오래 걸려?", "에러 로그 보여줘", "에러가 있는 파드 보여줘",
    "search 서비스 에러 로그 보여줘", "SLO가 뭐야?", "에러 버짓 설명해줘", "응답은 표로 해줘", "응답이 느려도 괜찮아", "빠르게 답해 줘",
    "서비스 중단 없이 배포하는 방법 알려줘", "서비스 생성이 실패했어", "DB 버전을 다운그레이드하는 방법",
    "DB 타임아웃이 몇 초로 설정돼 있어?", "DB 백업이 실패했어", "DB 마이그레이션이 느려요", "API 로그가 안 나와요",
    "서비스 메트릭이 안 나와요", "ConfigMap 값을 바꿔줘", "인증서 만료일 알려줘", "어제 바뀐 것 알려줘", "레플리카를 5개로 늘려줘",
    "latency 지표 이름이 뭐야?", "응답 시간 그래프 만들어줘", "p99가 뭐야?", "서비스 어카운트 권한 알려줘", "CPU 사용량 상위 파드 보여줘",
    "헬름 설치 중 에러가 나요", "테라폼 적용이 실패해요", "요청은 정상인데 배포가 실패해", "지연 로딩이 뭐야?",
    "요청 실패 시 재시도 정책을 설정하는 법", "재시작 횟수 순으로 파드를 정렬해줘", "PVC가 왜 Pending이야?",
    "redis 캐시 적중률 알려줘", "외부 API를 쓰는 서비스 목록", "응답 코드별 요청 수를 보여줘", "요청 수가 가장 많은 서비스는?",
    "CPU 요청이 높은 파드", "디스크 용량을 늘려줘", "파드가 안 떠요", "오류 메시지를 한국어로 번역해줘", "에러 코드 137이 뭐야?",
    "최근 배포 목록 알려줘", "모니터링 대시보드 주소", "하지 연결은 그대로 두고 서비스 이름만 알려줘",
    "이 매니페스트 검토해줘", "크론잡이 왜 멈춰 있어?", "서비스 타입을 NodePort로 바꿔줘", "CPU 사용량이 80% 넘으면 알림 보내줘",
    "요청과 한도의 차이가 뭐야?", "롤링 업데이트 중에 요청은 어떻게 돼?", "느린 시작이 뭐야?", "에러 처리 코드를 작성해줘",
    "요청 지연 시간 PromQL 예시 줘", "에러 차트 옆에 지연 차트를 붙여줘", "이 요청을 승인한 사람이 누구야?",
]


@pytest.mark.parametrize("text", UNRELATED_EN + UNRELATED_KO)
def test_an_unrelated_text_picks_no_card(text):
    assert picked(texts=[text]) == []
    assert picked(alertname="Custom", labels={"alertname": "Custom"}, texts=[text]) == []


AMBIGUOUS = [
    "slow", "latency", "error", "errors", "5xx", "timeout", "timeouts", "down", "high", "cpu", "memory", "slo", "burn", "failing",
    "unavailable", "degraded", "느려", "지연", "에러", "오류", "장애", "타임아웃", "높아", "실패", "메모리", "부족",
]


@pytest.mark.parametrize("word", AMBIGUOUS)
def test_one_word_alone_picks_no_card(word):
    assert picked(texts=[word]) == []
    assert picked(texts=[f"search {word} prod"]) == []
    assert picked(alertname=word.capitalize(), labels={"reason": word}) == []


def test_a_sentence_about_one_thing_and_a_state_of_another_pick_no_card():
    assert picked(texts=["Show the latency panel. The replica count is high."]) == []
    assert picked(texts=["latency 패널을 보여줘\n레플리카 수가 높아"]) == []


# --- the cards ----------------------------------------------------------------------------------------------------


def test_the_switch_adds_the_general_cards_after_the_others_and_leaves_those_as_they_are():
    assert [card.kind for card in ON] == [card.kind for card in OFF] + NEW_KINDS
    for off, on in zip(OFF, ON):
        assert (on.kind, on.title, on.terms, on.checks) == (off.kind, off.title, off.terms, off.checks)
        assert on.alerts[:len(off.alerts)] == off.alerts
    assert {card.kind for card in ON if card.phrases} == WITH_PHRASES
    assert not any(card.phrases for card in OFF)


@pytest.mark.parametrize("kind", NEW_KINDS)
def test_each_check_of_a_general_card_names_tools_that_exist_and_only_read(kind):
    card = next(c for c in ON if c.kind == kind)
    assert not card.terms and 4 <= len(card.checks) <= rule_cards.MAX_CHECKS
    for check in card.checks:
        assert set(check.tools) <= DEFINED, (check.text, set(check.tools) - DEFINED)
        assert set(check.tools) <= READONLY_TOOL_NAMES, (check.text, set(check.tools) - READONLY_TOOL_NAMES)


def test_the_two_longest_cards_stay_short_beside_the_first_message():
    tools = sorted(DEFINED)
    longest = max(len(rule_cards.render([a, b], tools, source=rule_cards.INVESTIGATION_SYMPTOMS_SOURCE)[0])
                  for a in ON for b in ON if a is not b)
    assert 0 < longest <= 2000


def test_no_listed_alert_name_is_listed_by_two_cards():
    listed = [a.lower() for card in ON for a in card.alerts]
    assert len(listed) == len(set(listed))


def test_of_several_symptoms_the_two_cards_with_the_stronger_place_go():
    said = "Requests to search are failing, the database is down and CPU usage is high"
    assert len(picked(texts=[said])) == 2 and len(picked(texts=[said], limit=9)) == 3
    # a listed alert name, then what the alert's name says, then a reason in the description, then what it says
    names = picked(alertname="KubePodCrashLooping", labels={"reason": "high latency"}, texts=["OOMKilled, and CPU usage is high"], limit=9)
    assert names == ["crash", "latency", "oom", "resource_pressure"]


# --- the switch off -----------------------------------------------------------------------------------------------

# Both worked out with rule_cards.py and rule_cards.json of 31cec8f9c, which had no symptoms: the alert names above that
# picked a card (no other name and no text here did), and the sha256 of every card as the model reads it.
OFF_PICKS = {
    "TargetDown": "dependency_down", "CPUThrottlingHigh": "resource_limit", "NodeMemoryHighUtilization": "node",
    "CoreDNSLatencyHigh": "dns", "KubeDeploymentGenerationMismatch": "rollout", "KubeDeploymentReplicasMismatch": "rollout",
    "KubeDeploymentRolloutStuck": "rollout", "KubeStatefulSetReplicasMismatch": "rollout", "KubeDaemonSetRolloutStuck": "rollout",
    "KubeCPUQuotaOvercommit": "quota", "KubeQuotaAlmostFull": "quota", "KubePersistentVolumeFillingUp": "storage",
    "KubePersistentVolumeErrors": "storage", "KubeNodeNotReady": "node", "KubeNodeUnreachable": "node",
    "KubeNodeReadinessFlapping": "node",
}
OFF_CARDS = "3c11aad176e6fb0bd3f3675ad8c6f79ae7176900250babc1fec98cb7d8c258df"


def test_with_the_switch_off_every_name_and_text_here_picks_what_it_did_before_the_symptoms():
    for name in [n for listed in NAMES.values() for n in listed] + list(PUBLIC) + list(DESCRIPTIONS):
        expected = [OFF_PICKS[name]] if name in OFF_PICKS else []
        assert picked(OFF, alertname=name, labels={"alertname": name, "severity": "warning"}) == expected, name
    for text in [s for _, s in SENTENCE_CASES] + UNRELATED_EN + UNRELATED_KO + AMBIGUOUS + list(DESCRIPTIONS.values()):
        assert picked(OFF, texts=[text]) == [], text


def test_with_the_switch_off_the_cards_read_as_they_did_before_the_symptoms():
    tools = {tool for card in OFF for check in card.checks for tool in check.tools}
    text = "\n".join(rule_cards.render([card], tools, source=source)[0]
                     for card in OFF for source in (rule_cards.INVESTIGATION_SOURCE, rule_cards.CHAT_SOURCE))
    assert hashlib.sha256(text.encode()).hexdigest() == OFF_CARDS


