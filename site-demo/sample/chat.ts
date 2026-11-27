// Prepared conversations for the released chat screen. No model is called: a question is matched to a prepared topic
// and its answer is played back as the chat's own stream events. Conversations live in page memory only.
import { listRows as clusterList } from './cluster'
import { unifiedDiff } from './diff'
import { auditRows, cost, deletePod, describe, findRelease, logs, nodes, optimization, overview, podMetrics, pods, readValues, revisionText } from './fixtures'
import { incident } from './logs'
import { hideSuggestions, lang, notice, showSuggestions } from './notice'

type Row = Record<string, any>
interface Call { function: string; args: Row; result: string; is_json: boolean; chart?: Row; call_id?: number; approval_id?: string; approval_status?: string; cluster?: string; expires_at?: string }
interface Turn { question: string; answer: string; calls: Call[]; approval?: boolean; unprepared?: boolean }

const now = () => new Date().toISOString()
const pick = (ko: boolean, a: string, b: string) => (ko ? a : b)
const call = (name: string, args: Row, result: unknown, chart?: Row): Call => ({
  function: name, args, result: typeof result === 'string' ? result : JSON.stringify(result, null, 2), is_json: typeof result !== 'string', ...(chart ? { chart } : {}),
})

// The clock of the prepared answers, in the viewer's zone as the graphs' axis: the alert and the timeouts 3 minutes after
// the checkout-api change, the graphs' rise 2 minutes later.
const clock = (minutes: number, seconds?: number) => new Date(incident + minutes * 60_000 + (seconds ?? 0) * 1000).toTimeString().slice(0, seconds === undefined ? 5 : 8)
const alertAt = 3, riseAt = 5
// An amount as the Cost screen writes it (utils/money.ts).
function money(amount: number): string {
  const digits = amount === 0 ? 0 : amount >= 1000 ? 0 : amount >= 1 ? 2 : amount >= 0.01 ? 4 : 6
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount)
}

// ---- The graph exploration: CPU 30 min -> 1 h -> 5xx rate and p95 -> what the graphs cannot tell

const end = incident / 1000 + 22 * 60
function series(label: string, minutes: number, kind: string, offset = 0) {
  return {
    label, points: Array.from({ length: minutes + 1 }, (_, i) => {
      const minute = 60 - minutes + i
      const bump = Math.max(0, 1 - Math.abs(minute - (60 - 22 + riseAt)) / 10)
      const value = kind === 'cpu' ? 0.08 + offset + 0.01 * Math.sin(minute * 0.55) + bump * 0.30
        : kind === 'errors' ? 0.2 + Math.max(0, Math.sin(minute * 0.4)) * 0.2 + bump * 6.2
          : 0.085 + offset + 0.015 * Math.sin(minute * 0.35) + bump * 1.55
      return [end - (minutes - i) * 60, Number(value.toFixed(3))]
    }),
  }
}
function chartCall(kind: string, minutes: number, ko: boolean): Call {
  const query = kind === 'cpu' ? 'sum(rate(container_cpu_usage_seconds_total{namespace="commerce",pod=~"checkout-api.*"}[5m]))'
    : kind === 'errors' ? '100 * sum(rate(http_requests_total{namespace="commerce",service="checkout-api",status=~"5.."}[5m])) / sum(rate(http_requests_total{namespace="commerce",service="checkout-api"}[5m]))'
      : 'histogram_quantile(0.95, sum by (le, service) (rate(http_request_duration_seconds_bucket{namespace="commerce",service="payment-gateway"}[5m])))'
  const title = kind === 'cpu' ? pick(ko, 'checkout-api · CPU 사용량', 'checkout-api · CPU usage') : kind === 'errors' ? pick(ko, 'checkout-api · 5xx 비율', 'checkout-api · 5xx rate') : pick(ko, 'payment-gateway · p95 응답 시간', 'payment-gateway · p95 latency')
  const unit = kind === 'cpu' ? 'cores' : kind === 'errors' ? 'percent' : 'seconds'
  const chart = { title, unit, promql: query, start: new Date((end - minutes * 60) * 1000).toISOString(), end: new Date(end * 1000).toISOString(), step_seconds: 60, common_labels: { namespace: 'commerce' }, series: kind === 'cpu' ? [series('checkout-api', minutes, kind)] : [series(kind === 'errors' ? '5xx / all requests' : 'payment-gateway', minutes, kind)] }
  const result = { status: 'success', data: { resultType: 'matrix', result: chart.series.map((s) => ({ metric: kind === 'latency' ? { service: 'payment-gateway' } : {}, values: s.points.map(([time, value]) => [time, String(value)]) })) } }
  return call('prometheus_query', { promql: query, range: true, since: minutes + 'm', chart: true, title, unit }, result, chart)
}
const peak = (c: Call) => Math.max(...(c.chart?.series || []).flatMap((s: Row) => s.points.map((p: number[]) => p[1])))
function graphTurns(ko: boolean): Turn[] {
  const cpu30 = chartCall('cpu', 30, ko), cpu60 = chartCall('cpu', 60, ko), errors = chartCall('errors', 60, ko), latency = chartCall('latency', 60, ko)
  return [
    { question: pick(ko, 'checkout-api CPU를 그래프로 보여 주세요.', 'Graph checkout-api CPU usage.'), calls: [cpu30], answer: pick(ko, `지난 30분의 CPU 사용량입니다. ${clock(riseAt)} 부근에 사용량이 높아졌다가 낮아집니다.\n\n최대 사용량은 **${Math.round(peak(cpu30) * 1000)}m**입니다. 마우스를 올리면 시점별 값을 볼 수 있고, **크게 보기**로 확대할 수 있습니다.\n\n시간 범위를 넓혀 비교할까요?`, `Here is CPU usage over 30 minutes. It rises around ${clock(riseAt)} and then falls.\n\nPeak usage is **${Math.round(peak(cpu30) * 1000)}m**. Hover for point values or choose **View larger**.\n\nWould you like a longer window?`) },
    { question: pick(ko, '지난 1시간으로 넓혀서 봐 주세요.', 'Expand that to the last hour.'), calls: [cpu60], answer: pick(ko, '같은 대상의 범위를 **1시간**으로 넓혔습니다. 상승 전 구간과 회복 뒤 구간이 함께 보입니다.\n\nCPU 증가만으로 장애 원인을 정하지 않고, 같은 시간의 오류율과 응답 시간을 비교합니다.', 'The same target is now shown over **1 hour**, including the baseline and recovery.\n\nCPU alone does not establish a cause. Compare errors and latency in the same time window.') },
    { question: pick(ko, '오류율과 결제 응답 시간도 같이 그려 주세요.', 'Graph the error rate and payment latency too.'), calls: [errors, latency], answer: pick(ko, `같은 1시간에 **5xx 비율**과 **p95 응답 시간**을 나란히 확인합니다.\n\n- 최대 5xx 비율: **${peak(errors).toFixed(2)}%**\n- 최대 p95: **${peak(latency).toFixed(2)}초**\n\n두 그래프 모두 ${clock(riseAt)} 부근에서 상승합니다. 단위가 달라 각각의 축으로 표시합니다.`, `Compare **5xx rate** and **p95 latency** over the same hour.\n\n- Peak 5xx rate: **${peak(errors).toFixed(2)}%**\n- Peak p95: **${peak(latency).toFixed(2)} s**\n\nBoth rise around ${clock(riseAt)}. Each graph keeps its own units.`) },
    { question: pick(ko, '그래프만으로 원인을 확정할 수 있나요?', 'Can these graphs establish the cause?'), calls: [], answer: pick(ko, '아직 확정할 수 없습니다. 같은 시점에 변했다는 사실을 확인한 것입니다.\n\n1. 해당 시각 Loki 로그에서 upstream timeout을 확인합니다.\n2. Tempo trace에서 payment-gateway span을 비교합니다.\n3. 최근 배포 시각과 감사 기록을 대조합니다.\n\n다음 질문으로 “**로그와 트레이스로 확인해 줘**”라고 이어갈 수 있습니다.', 'Not yet. The graphs show that the signals move together.\n\n1. Read the Loki logs for upstream timeouts.\n2. Compare payment-gateway spans in Tempo.\n3. Check rollout timing against the audit trail.\n\nContinue with **“Check the logs and traces.”**') },
  ]
}

// ---- The other topics: two turns from the draft's scenarios and two more from its continuations

// The last two revisions of the storefront release, as its Helm page shows them.
function storefrontRevisions(ko: boolean) {
  const r = findRelease('commerce', 'storefront'), to = r?.revision ?? 8, from = to - 1
  const at = (revision: number) => {
    const text = r ? revisionText(r, revision, 'values') : '', values = readValues(text)
    return { revision, text, tag: String(values.image?.tag ?? '-'), replicas: String(values.replicaCount ?? '-'), status: String(r?.history.find((h) => h.revision === revision)?.status ?? '-') }
  }
  const before = at(from), after = at(to)
  const same = before.tag === after.tag, kept = before.replicas === after.replicas
  return {
    before, after, history: (r?.history ?? []).slice(0, 2), diff: unifiedDiff(`commerce/storefront@${from}.values`, `commerce/storefront@${to}.values`, before.text, after.text),
    tags: same ? pick(ko, `이미지 태그는 \`${after.tag}\`로 같습니다.`, `The image tag stays at \`${after.tag}\`;`) : pick(ko, `이미지 태그가 \`${before.tag}\`에서 \`${after.tag}\`로 바뀌었습니다.`, `The image changes from \`${before.tag}\` to \`${after.tag}\`;`),
    replicas: kept ? pick(ko, `복제본 수는 **${after.replicas}**로 같습니다.`, `replicas stay at **${after.replicas}**.`) : pick(ko, `복제본 수가 **${before.replicas}**에서 **${after.replicas}**로 바뀌었습니다.`, `replicas change from **${before.replicas}** to **${after.replicas}**.`),
  }
}
function topicTurns(key: string, ko: boolean): Turn[] {
  const pod = pods.find((p) => p.name.startsWith('checkout-api')) || pods[0]
  const p = (a: string, b: string) => pick(ko, a, b)
  const ov = overview(), restarts = pod.restart_count
  // the Cost screen's own totals and the Optimization window's row
  const day = cost(new URLSearchParams({ window: '24h' })), week = cost(new URLSearchParams({ window: '7d' })), requests = optimization('commerce')
  const front = requests.rows.find((r: Row) => r.name === 'storefront')
  const used = front?.cpu_usage_m === undefined ? '-' : front.cpu_usage_m + 'm'
  const helm = storefrontRevisions(ko)
  const upgrade = auditRows.find((r) => r.Action === 'helm.release.upgrade')!
  const turns: Record<string, Turn[]> = {
    pods: [
      { question: p('checkout-api가 왜 재시작하나요?', 'Why is checkout-api restarting?'), calls: [call('k8s_describe_resource', { resource_type: 'Pod', resource_name: pod.name, namespace: pod.namespace }, describe(pod)), call('k8s_get_pod_logs', { pod_name: pod.name, namespace: pod.namespace, previous: true }, logs(pod))], answer: p('## checkout-api 재시작 원인\n\n`commerce`의 checkout-api는 **0/1 Ready**, 재시작 **' + pod.restart_count + '회**입니다. 직전 컨테이너는 종료 코드 `1`로 끝났습니다.\n\n| 확인한 근거 | 결과 |\n|---|---|\n| 상태 | CrashLoopBackOff |\n| 이벤트 | BackOff |\n| 직전 로그 | `PAYMENT_GATEWAY_URL is not set` |\n\n다음은 Deployment의 `envFrom`과 `checkout-config` 참조를 확인할 차례입니다. 설정 참조가 누락되었는지 최근 배포와 비교합니다.', '## Why checkout-api is restarting\n\nThe Pod in `commerce` is **0/1 Ready** with **' + pod.restart_count + ' restarts**. Its previous container exited with code `1`.\n\n| Evidence | Result |\n|---|---|\n| State | CrashLoopBackOff |\n| Event | BackOff |\n| Previous logs | `PAYMENT_GATEWAY_URL is not set` |\n\nInspect the Deployment’s `envFrom` and its `checkout-config` reference. Compare them with the last rollout.') },
      { question: p('어디를 먼저 확인하면 되나요?', 'What should I check first?'), calls: [], answer: p('1. Deployment의 `envFrom.configMapRef.name`을 확인합니다.\n2. `checkout-config`에 필요한 키가 있는지 확인합니다.\n3. 감사 기록에서 최근 실행 주체·시각·대상을 확인합니다.\n\n원인이 확인되면 변경 내용을 먼저 보여 드리고 승인을 기다립니다.', '1. Inspect `envFrom.configMapRef.name` on the Deployment.\n2. Check the required key in `checkout-config`.\n3. Review the actor, time and target in the latest audit record.\n\nReview the proposed change before approving it.') },
      { question: p('Deployment 설정을 읽어 주세요.', 'Read the Deployment configuration.'), calls: [call('k8s_get_resource_yaml', { resource_type: 'deployments', resource_name: 'checkout-api', namespace: 'commerce' }, 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: checkout-api\n  namespace: commerce\nspec:\n  template:\n    spec:\n      containers:\n        - name: app\n          envFrom: []\n')], answer: p('현재 Deployment의 `envFrom`은 빈 목록입니다. 기대하는 `checkout-config` 참조가 있는지 배포 설정과 비교해야 합니다.\n\n감사 기록에는 YAML 본문이 없으므로 기록만으로 누락된 값을 단정하지 않습니다.', 'The current Deployment has an empty `envFrom`. Compare it with the expected `checkout-config` reference in deployment configuration.\n\nThe audit entry has no YAML body, so it cannot establish the missing value by itself.') },
      { question: p('변경 후에는 무엇을 확인해야 하나요?', 'What should I check after a change?'), calls: [], answer: p('Pod 준비 상태가 **1/1**로 바뀌는지, 재시작 횟수가 더 늘지 않는지, 새 로그에 설정 누락 오류가 없는지 확인합니다.\n\n그 뒤 Service의 Endpoint와 실제 요청 결과를 확인합니다. API의 변경 성공과 서비스 복구는 별개로 확인합니다.', 'Check **1/1 readiness**, a stable restart count and new logs without the configuration error.\n\nThen inspect Service endpoints and request results. A successful API change and service recovery are separate checks.') },
    ],
    alerts: [
      { question: p('지금 발생한 알림을 조사해 주세요.', 'Investigate the firing alert.'), calls: [call('alerts_inbox', { status: 'firing' }, { items: [{ id: 'alert-204', name: 'KubePodCrashLooping', namespace: 'commerce', pod: pod.name, severity: 'warning', status: 'firing', starts_at: new Date(incident + alertAt * 60_000).toISOString() }] }), call('alert_investigate', { alert_id: 'alert-204' }, { status: 'completed', steps: [{ tool: 'k8s_describe_resource', finding: `CrashLoopBackOff, ${restarts} restarts` }, { tool: 'k8s_get_pod_logs', finding: 'PAYMENT_GATEWAY_URL is not set' }], next: 'Review Deployment envFrom and checkout-config' })], answer: p('## KubePodCrashLooping\n\n**대상:** `commerce / checkout-api` · **심각도:** warning\n\n' + clock(alertAt) + '부터 발생한 알림입니다. Pod 상태와 이벤트, 직전 로그를 함께 읽었습니다.\n\n- Pod 준비 상태는 **0/1**, 재시작은 **' + restarts + '회**입니다.\n- 이벤트는 `BackOff`이며 직전 종료 코드는 `1`입니다.\n- 로그에서 `PAYMENT_GATEWAY_URL` 누락을 확인했습니다.\n\n설정 참조와 최근 배포를 다음으로 확인합니다. 도구 결과를 펼치면 조사 근거를 볼 수 있습니다.', '## KubePodCrashLooping\n\n**Target:** `commerce / checkout-api` · **Severity:** warning\n\nFiring since ' + clock(alertAt) + '. The investigation reads Pod state, events and previous logs.\n\n- **0/1 Ready**, **' + restarts + ' restarts**.\n- `BackOff` event; previous exit code `1`.\n- Logs report a missing `PAYMENT_GATEWAY_URL`.\n\nInspect the configuration reference and latest rollout next. Expand the tool results to read the evidence.') },
      { question: p('조사 결과를 한 번 더 정리해 주세요.', 'Summarize the investigation findings.'), calls: [], answer: p('알림과 재시작은 같은 Pod를 가리킵니다. 로그에 나온 누락 설정이 우선 확인 대상입니다. 설정을 고치기 전에 최근 변경과 기대값을 대조합니다.', 'The alert and restarts point to the same Pod. The missing configuration is the first lead to check against the latest change and expected values.') },
      { question: p('알림의 근거를 하나씩 보여 주세요.', 'Show the alert evidence step by step.'), calls: [call('alerts_inbox', { alert_id: 'alert-204', with_report: true }, { alertname: 'KubePodCrashLooping', report: { pod: pod.name, ready: '0/1', restarts, event: 'BackOff', previous_log: 'PAYMENT_GATEWAY_URL is not set' } })], answer: p('1. **Pod**: 0/1 Ready, 재시작 ' + restarts + '회입니다.\n2. **이벤트**: BackOff가 있습니다.\n3. **직전 로그**: 환경변수 누락을 말합니다.\n\n세 근거는 컨테이너 시작 실패와 맞습니다. 원인을 확인하려면 Deployment의 설정 참조를 읽습니다.', '1. **Pod**: 0/1 Ready, ' + restarts + ' restarts.\n2. **Event**: BackOff.\n3. **Previous log**: missing environment variable.\n\nThese agree with a container startup failure. Read its Deployment configuration reference next.') },
      { question: p('조사가 끝나면 알림도 해결로 바뀌나요?', 'Does completing the investigation resolve the alert?'), calls: [], answer: p('조사 완료와 알림 해소는 다릅니다. 보고서를 만들었다고 Alertmanager의 firing 상태가 바뀌지는 않습니다.\n\n실제 상태가 회복되고 알림 규칙의 조건이 풀렸는지 확인합니다.', 'Investigation completion and alert resolution are different. Creating a report does not change a firing Alertmanager alert.\n\nCheck resource recovery and whether the alert rule has cleared.') },
    ],
    logs: [
      { question: p('checkout 요청 지연을 로그와 트레이스로 찾아 주세요.', 'Trace the checkout latency through logs and traces.'), calls: [call('loki_query', { logql: '{namespace="commerce",app="checkout-api"} |= "timeout"' }, { lines: [clock(alertAt, 12) + ' upstream timeout trace_id=7d91c64fe2b8', clock(alertAt, 15) + ' payment request exceeded deadline'] }), call('traces_search', { traceql: '{ resource.service.name = "checkout-api" }' }, { traces: [{ trace_id: '7d91c64fe2b8', duration_ms: 1820 }] }), call('traces_get', { trace_id: '7d91c64fe2b8' }, { spans: [{ service: 'checkout-api', duration_ms: 1820 }, { service: 'payment-gateway', duration_ms: 1640 }, { service: 'ledger', duration_ms: 94 }] })], answer: p('## 결제 연결 구간에 지연이 모였습니다\n\n| 구간 | 시간 |\n|---|---:|\n| checkout-api | 1,820 ms |\n| payment-gateway | 1,640 ms |\n| ledger | 94 ms |\n\n`payment-gateway` span이 전체 시간의 약 **90**%를 차지합니다. 같은 시각 Loki 로그에도 upstream timeout이 있습니다.\n\n결제 연결의 지연 분포와 오류율을 다음으로 확인합니다.', '## Latency is concentrated in the payment call\n\n| Span | Duration |\n|---|---:|\n| checkout-api | 1,820 ms |\n| payment-gateway | 1,640 ms |\n| ledger | 94 ms |\n\nThe payment span accounts for roughly **90%** of the request. Loki shows an upstream timeout in the same time window.\n\nCheck the payment latency distribution and error rate next.') },
      { question: p('어느 구간이 가장 느린가요?', 'Which span takes the longest?'), calls: [], answer: p('`payment-gateway`가 1,640ms로 가장 깁니다. 전체 요청 시간과 자식 span을 중복해서 합산하지 않고, 해당 span의 로그와 지표를 함께 봅니다.', '`payment-gateway` is the longest at 1,640ms. Do not add child spans to the total request duration; compare this span with its logs and metrics.') },
      { question: p('같은 시간의 오류율을 그래프로 확인해 주세요.', 'Graph the error rate in the same window.'), calls: [chartCall('errors', 60, ko)], answer: p('오류율이 ' + clock(riseAt) + ' 부근에서 높아집니다. trace의 긴 결제 구간과 로그의 timeout이 같은 시간대에 모입니다.\n\n그래프에 마우스를 올려 시점별 값을 확인하세요.', 'Errors rise around ' + clock(riseAt) + ', alongside the slow payment span and timeout logs.\n\nHover over the graph to inspect point values.') },
      { question: p('다음 확인 순서를 정리해 주세요.', 'Summarize the next checks.'), calls: [], answer: p('결제 연결의 응답 시간 → upstream 오류 로그 → 최근 배포 순서로 확인합니다.\n\n근거가 없는 상태에서 시간 제한이나 재시도 횟수부터 올리지 않습니다.', 'Review payment latency, upstream error logs and then the latest rollout.\n\nDo not increase timeouts or retries before understanding the evidence.') },
    ],
    cost: [
      { question: p('클러스터 비용과 자원 사용량을 정리해 주세요.', 'Summarize cluster cost and resource efficiency.'), calls: [call('cost', { window: '24h', aggregate: 'namespace' }, day), call('optimization', { namespace: 'commerce' }, requests)], answer: p('## 지난 24시간 비용\n\n' + day.rows.length + '개 Namespace의 합계는 **' + money(day.totals.total_cost) + '**입니다. CPU·메모리·스토리지·네트워크·로드 밸런서 비용을 함께 합산한 값입니다.\n\n' + (front ? '`storefront` Pod 하나의 CPU 요청량은 **' + front.cpu_request_m + 'm**, 관측 사용량은 최대 **' + used + '**입니다. ' : '') + '평균 한 지점만으로 요청량을 낮추지 않고, 피크와 처리량을 확인합니다.\n\nCost 화면에서 기간을 바꾸거나 Namespace별 항목을 비교할 수 있습니다.', '## Cost over the last 24 hours\n\nThe ' + day.rows.length + ' namespaces total **' + money(day.totals.total_cost) + '**, including CPU, memory, storage, network and load balancer allocations.\n\n' + (front ? 'Each `storefront` Pod requests **' + front.cpu_request_m + 'm** CPU; the highest observed usage is **' + used + '**. ' : '') + 'Check peak demand and throughput before lowering requests.\n\nUse Cost to compare namespaces and time windows.') },
      { question: p('절감 대상을 어떻게 고르나요?', 'How should I choose an optimization target?'), calls: [], answer: p('비용이 큰 항목에서 요청량 대비 사용량이 낮은 대상을 찾습니다. 피크·장애 여유·오토스케일링 조건까지 확인한 뒤 변경안을 정합니다.', 'Start with high-cost workloads that use little of their requested capacity. Check peaks, headroom and autoscaling conditions before proposing a change.') },
      { question: p('Namespace별 금액도 보여 주세요.', 'Show the cost by namespace.'), calls: [call('cost', { window: '24h', aggregate: 'namespace' }, day)], answer: p('지난 24시간의 같은 집계입니다.\n\n', 'The same 24-hour allocation is shown below.\n\n') + '| Namespace | USD |\n|---|---:|\n' + day.rows.map((r: Row) => '| ' + r.name + ' | $' + r.total_cost.toFixed(4) + ' |').join('\n') + p('\n\n합계는 **' + money(day.totals.total_cost) + '**입니다.', '\n\nThe total is **' + money(day.totals.total_cost) + '**.') },
      { question: p('일주일 비용과 비교해 주세요.', 'Compare it with one week.'), calls: [call('cost', { window: '7d', aggregate: 'namespace' }, week)], answer: p('7일 합계는 **' + money(week.totals.total_cost) + '**입니다. 이 예시에서는 일별 사용량을 일정하게 둬 24시간 합계 **$' + day.totals.total_cost.toFixed(4) + '**의 7배입니다.\n\n실제 운영에서는 같은 기간의 트래픽과 사용량 변화도 함께 비교합니다.', 'The 7-day total is **' + money(week.totals.total_cost) + '**. This example keeps daily usage constant, so it is seven times the 24-hour total of **$' + day.totals.total_cost.toFixed(4) + '**.\n\nIn production, compare traffic and utilization changes over matching windows.') },
    ],
    helm: [
      { question: p('storefront의 최근 릴리스를 비교해 주세요.', 'Compare the latest storefront releases.'), calls: [call('helm_read', { what: 'history', namespace: 'commerce', release: 'storefront' }, { items: helm.history }), call('helm_read', { what: 'diff', namespace: 'commerce', release: 'storefront', from: helm.before.revision, to: helm.after.revision, section: 'values' }, { from: helm.before.revision, to: helm.after.revision, section: 'values', diff: helm.diff })], answer: p('## storefront · 리비전 ', '## storefront · revision ') + helm.before.revision + ' → ' + helm.after.revision + '\n\n' + helm.tags + ' ' + helm.replicas + (helm.diff ? '\n\n```diff\n' + helm.diff + '```' : '') + p(`\n\n리비전 ${helm.after.revision}: \`${helm.after.status}\` · 리비전 ${helm.before.revision}: \`${helm.before.status}\``, `\n\nRevision ${helm.after.revision} is \`${helm.after.status}\`; revision ${helm.before.revision} is \`${helm.before.status}\`.`) },
      { question: p('다음 배포 전에 무엇을 볼까요?', 'What should I check before the next rollout?'), calls: [], answer: p('변경된 values, 대상 Namespace, 준비 상태와 배포 이력을 확인합니다. 변경 실행은 권한과 사용자 확인을 거칩니다.', 'Review values, target namespace, readiness and history. Execution follows the user’s permissions and confirmation.') },
      { question: p('현재 values도 읽어 주세요.', 'Read the current values too.'), calls: [call('helm_read', { what: 'values', release: 'storefront', namespace: 'commerce' }, helm.after.text)], answer: p('현재 values의 복제본 수는 **' + helm.after.replicas + '**, 이미지 태그는 **' + helm.after.tag + '**입니다. 리비전 ' + helm.after.revision + '의 값과 같습니다.', 'Current values specify **' + helm.after.replicas + ' replicas** and image tag **' + helm.after.tag + '**, matching revision ' + helm.after.revision + '.') },
      { question: p('롤백 전에 확인할 것은요?', 'What should I check before a rollback?'), calls: [], answer: p('되돌릴 리비전의 values·manifest와 현재 리소스 상태를 비교합니다. DB 변경처럼 차트 밖의 영향도 확인합니다.\n\n조회만으로 롤백을 실행하지는 않습니다.', 'Compare the target revision’s values and manifest with the current resource state. Check effects outside the chart, such as database changes.\n\nReading the history does not execute a rollback.') },
    ],
    audit: [
      { question: p('checkout-api를 누가 바꿨는지 찾아 주세요.', 'Who changed checkout-api?'), calls: [call('audit_search', { namespace: 'commerce', target_id: 'checkout-api' }, { items: auditRows.filter((r) => r.TargetID === 'checkout-api').slice(0, 3) })], answer: p('## 최근 변경 기록\n\n실행 주체는 **release-bot@northstar.example**, 작업은 `k8s.yaml.apply`입니다. 결과는 `success`로 기록되었습니다.\n\n| 기록 | 값 |\n|---|---|\n| 대상 종류 | deployments |\n| YAML 길이 | 846 |\n\n이 기록에는 YAML 본문이 없습니다. Audit 화면에서 실행 주체와 대상을 확인하고, 실제 설정은 리소스와 배포 이력에서 이어서 읽습니다.', '## Latest change record\n\n**release-bot@northstar.example** ran `k8s.yaml.apply`, recorded as `success`.\n\n| Recorded field | Value |\n|---|---|\n| Resource type | deployments |\n| YAML length | 846 |\n\nThis record does not contain the YAML body. Review the actor and target in Audit, then inspect the resource and deployment history for configuration details.') },
      { question: p('기록에는 어떤 정보가 남나요?', 'What details are kept in this record?'), calls: [], answer: p('```json\n{"resource_type":"deployments","yaml_len":846}\n```\n\n기록의 성공은 API 요청이 성공했다는 뜻입니다. 워크로드의 정상 동작은 Pod 상태와 로그로 따로 확인합니다.', '```json\n{"resource_type":"deployments","yaml_len":846}\n```\n\nA successful request does not prove workload health. Check Pod state and logs separately.') },
      { question: p('Helm 기록에는 무엇이 더 있나요?', 'What else is recorded for Helm?'), calls: [call('audit_search', { action: 'helm.release.upgrade', namespace: 'commerce' }, { items: [upgrade] })], answer: p('Helm 변경 기록은 이전 리비전 **' + upgrade.Before.fromRevision + '**, 새 리비전 **' + upgrade.After.newRevision + '**과 values의 키·길이를 남깁니다.\n\n값 본문을 감사 기록에 그대로 저장하지는 않습니다. 자세한 차이는 Helm 리비전 조회로 이어 갑니다.', 'The Helm record identifies revision **' + upgrade.Before.fromRevision + ' → ' + upgrade.After.newRevision + '**, plus the values’ keys and length.\n\nIt does not store the full values body. Inspect the Helm revisions for detailed differences.') },
      { question: p('이 기록을 파일로 받을 수 있나요?', 'Can I download these records?'), calls: [], answer: p('Audit 탭에서 사용자·작업·Namespace·기간을 고르고 조회한 뒤 **CSV 내보내기**를 누릅니다. 적용한 필터의 기록을 받습니다.\n\n현재 체험에서는 예시 기록을 내려받습니다.', 'Open Audit, apply actor, action, namespace or time filters, then choose **Export CSV**. The download follows the applied filter.\n\nThe tour exports its example records.') },
    ],
    policy: [
      { question: p('실패한 정책 보고서를 정리해 주세요.', 'Summarize failing policy reports.'), calls: [call('policy_reports', { view: 'results', results: 'fail', namespace: 'commerce' }, { items: [{ policy: 'require-liveness-probe', resource: 'Deployment/checkout-api', result: 'fail', message: 'livenessProbe is missing' }, { policy: 'require-app-label', resource: 'Service/catalog', result: 'fail', message: 'app.kubernetes.io/name is missing' }] })], answer: p('## commerce · 실패 2건\n\n| 정책 | 리소스 | 확인할 내용 |\n|---|---|---|\n| require-liveness-probe | Deployment/checkout-api | livenessProbe 누락 |\n| require-app-label | Service/catalog | 앱 이름 라벨 누락 |\n\n정책 보고서의 결과를 읽은 것입니다. 정책 설정과 실제 리소스를 함께 확인해 수정 범위를 정합니다.', '## commerce · 2 failing checks\n\n| Policy | Resource | Finding |\n|---|---|---|\n| require-liveness-probe | Deployment/checkout-api | Missing livenessProbe |\n| require-app-label | Service/catalog | Missing app name label |\n\nReview the policy and resource together before choosing a change.') },
      { question: p('어떤 리소스부터 확인할까요?', 'Which resource should I review first?'), calls: [], answer: p('현재 장애를 조사 중인 checkout-api부터 확인합니다. 재시작 원인과 정책 실패를 같은 원인으로 단정하지 않고 각각의 근거를 대조합니다.', 'Start with checkout-api while investigating the incident. Check each finding separately rather than assuming the policy failure caused the restart.') },
      { question: p('정책 실패가 곧 서비스 장애인가요?', 'Does a failed policy check mean an outage?'), calls: [], answer: p('그렇지는 않습니다. 정책 결과는 정해 둔 기준과 리소스 설정의 차이를 말합니다.\n\nReady 상태·이벤트·로그를 함께 확인해 운영 영향과 수정 우선순위를 나눕니다.', 'Not necessarily. A policy result compares resource configuration with a defined rule.\n\nUse readiness, events and logs to assess operational impact and priority.') },
      { question: p('수정 후에는 무엇을 비교하나요?', 'What should I compare after a fix?'), calls: [], answer: p('같은 정책·리소스의 새 보고서 결과를 확인하고 필요한 값이 실제 리소스에도 반영됐는지 봅니다.\n\n보고서의 시각과 대상이 같은지 확인한 뒤 통과로 판단합니다.', 'Read the new result for the same policy and resource, and check the actual configuration.\n\nConfirm the report timestamp and target before calling the check passed.') },
    ],
    overview: [
      { question: p('지금 클러스터 상태를 요약해 주세요.', 'Summarize the current cluster state.'), calls: [call('get_cluster_overview', {}, ov)], answer: p(`## Commerce Production\n\n**Node ${ov.node_count}개 · Namespace ${ov.total_namespaces}개 · Pod ${ov.total_pods}개**\n\n| Pod 단계 | 수 |\n|---|---:|\n${Object.entries(ov.pod_status).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n\nRunning 단계인 Pod라도 준비 상태가 아닐 수 있습니다. checkout-api는 Running 단계지만 컨테이너가 CrashLoopBackOff이며 준비 상태는 0/1입니다.`, `## Commerce Production\n\n**${ov.node_count} nodes · ${ov.total_namespaces} namespaces · ${ov.total_pods} Pods**\n\n| Pod phase | Count |\n|---|---:|\n${Object.entries(ov.pod_status).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n\nA Running Pod is not necessarily ready: checkout-api has a container in CrashLoopBackOff and is 0/1 Ready.`) },
      { question: p('문제가 있는 항목만 알려 주세요.', 'Show only the items that need attention.'), calls: [], answer: p('checkout-api는 재시작 ' + restarts + '회, recommendations는 Pending입니다. Failed 단계의 scheduler도 로그와 이벤트 확인 대상입니다. 완료된 batch-worker는 Succeeded로 따로 구분합니다.', 'checkout-api has restarted ' + restarts + ' times; recommendations is Pending. Inspect the failed scheduler’s logs and events as well. The completed batch-worker is counted separately as Succeeded.') },
      { question: p('Running인데 준비가 안 된 Pod도 있나요?', 'Can a Running Pod still be unready?'), calls: [], answer: p('있습니다. checkout-api의 Pod phase는 **Running**이지만 컨테이너 상태는 **CrashLoopBackOff**, 준비 상태는 **0/1**입니다.\n\n상태 차트의 단계와 목록의 컨테이너 상태는 서로 다른 정보를 보여 줍니다.', 'Yes. checkout-api has Pod phase **Running**, container state **CrashLoopBackOff** and readiness **0/1**.\n\nThe phase chart and container status describe different aspects of the same Pod.') },
      { question: p('어디부터 조사하면 좋을까요?', 'Where should I start investigating?'), calls: [], answer: p('checkout-api의 직전 로그와 이벤트부터 확인합니다. Pending인 recommendations는 스케줄링 이벤트를 따로 봅니다.\n\n원인이 다른 항목을 하나의 장애로 묶지 않고 각각의 근거로 확인합니다.', 'Start with checkout-api’s previous logs and events. Inspect scheduling events separately for the Pending recommendations Pod.\n\nDo not assume that different symptoms share one cause.') },
    ],
    // A write: the chat parks it on an approval card, as v0.8.0 does with AI_WRITE_APPROVAL on (its default).
    restart: [
      { question: p('checkout-api를 재시작해 주세요.', 'Restart checkout-api.'), approval: true, calls: [call('k8s_rollout', { action: 'restart', resource_type: 'deployment', resource_name: 'checkout-api', namespace: 'commerce' }, { status: 'pending_approval', message: 'This action changes the cluster and is waiting for the user\'s approval in the chat.' })], answer: p('재시작은 클러스터를 바꾸는 작업이라 바로 실행하지 않습니다. 아래 승인 카드에서 대상과 인자를 확인한 뒤 **승인** 또는 **거절**을 누르세요.\n\n재시작만으로는 설정 누락이 풀리지 않을 수 있습니다. 재시작 뒤 Pod 상태와 새 로그를 다시 확인합니다.', 'A restart changes the cluster, so it does not run straight away. Check the target and arguments on the approval card below, then choose **Approve** or **Reject**.\n\nA restart alone may not fix the missing configuration. Check the Pod state and new logs afterwards.') },
    ],
  }
  return turns[key] || turns.pods
}

const turnsFor = (key: string, ko: boolean) => (key === 'graphs' ? graphTurns(ko) : topicTurns(key, ko))

// ---- Matching (decision of 2026-11-23): a topic word picks the topic; a follow-up in the conversation's topic takes
// its next turn; anything else gets the prepared-questions answer, never an unrelated prepared answer.

function topicOf(q: string): string | null {
  if (/재시작해|다시 시작|restart (it|checkout|the)|rollout restart|롤아웃 재시작/i.test(q)) return 'restart'
  if (/그래프|차트|시계열|추이|graph|chart|오류율|error rate|p95|\bcpu\b|cpu/i.test(q)) return 'graphs'
  if (/감사|누가|audit|who changed/i.test(q)) return 'audit'
  if (/알림|alert/i.test(q)) return 'alerts'
  if (/정책|policy|kyverno/i.test(q)) return 'policy'
  if (/비용|절감|cost|opencost|효율/i.test(q)) return 'cost'
  if (/helm|릴리스|release|storefront|values|롤백|rollback/i.test(q)) return 'helm'
  if (/loki|tempo|trace|트레이스|느린|지연|latency|로그/i.test(q)) return 'logs'
  if (/클러스터.*(요약|상태)|overview|cluster state/i.test(q)) return 'overview'
  if (/checkout|crashloop|재시작|restarting|파드|\bpod\b/i.test(q)) return 'pods'
  return null
}
const FOLLOW_UP = /자세히|더 (알려|보여|설명)|^\s*(그럼|그러면|그래서|왜)|왜\s*\??\s*$|이유|다음은|다음 단계|계속|이어서|한.?시간|1시간|일주일|7일|\bmore\b|\bdetails?\b|^\s*(why|then|and)\b|\bwhy\??\s*$|what about|\bnext\b|go on|continue|last hour|one hour|\b1h\b|\bweek\b|\b7d\b|\b7.?days?\b/i

// Questions the product's own welcome screen offers (aiChat.quickQuestions) answer from the sample cluster.
function starter(q: string, ko: boolean): Turn | null {
  if (/메모리|memory/i.test(q)) {
    const rows = [...podMetrics()].sort((a, b) => parseInt(b.memory) - parseInt(a.memory)).slice(0, 5)
    return { question: q, calls: [call('get_pod_metrics', {}, rows)], answer: pick(ko, '## 메모리를 많이 쓰는 Pod\n\n', '## Pods by memory usage\n\n') + '| Pod | Namespace | Memory |\n|---|---|---:|\n' + rows.map((p) => '| ' + p.name + ' | ' + p.namespace + ' | ' + p.memory + ' |').join('\n') }
  }
  if (/\bnode|노드/i.test(q)) {
    const ready = nodes.filter((n) => n.status.startsWith('Ready')).length
    const others = nodes.filter((n) => !n.status.startsWith('Ready'))
    const named = (gap: string) => others.map((n) => '`' + n.name + '`' + gap + '(' + n.status + ')')
    const list = named(' ')
    const all = list.length > 1 ? list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1] : list.join('')
    // "Node는" keeps the particle right whatever the last status is
    const head = pick(ko, `## Node 상태\n\nNode ${nodes.length}개 중 ${ready}개가 Ready입니다.` + (list.length ? ` ${named('').join('와 ')} Node는 Pod를 새로 받지 않습니다. 그 Node의 Pod는 이벤트와 상태를 따로 확인하세요.` : ''), `## Node status\n\n${ready} of ${nodes.length} nodes are Ready.` + (list.length ? ` ${all} ${list.length > 1 ? 'take' : 'takes'} no new Pods; check the events and status of the Pods there.` : ''))
    return { question: q, calls: [call('k8s_get_resources', { resource_type: 'Node' }, nodes)], answer: head + '\n\n| Node | Status | CPU | Memory |\n|---|---|---:|---:|\n' + nodes.map((n) => '| ' + n.name + ' | ' + n.status + ' | ' + n.capacity.cpu + ' | ' + n.capacity.memory + ' |').join('\n') }
  }
  if (/kube-system/i.test(q)) {
    const rows = pods.filter((p) => p.namespace === 'kube-system')
    return { question: q, calls: [call('k8s_get_resources', { resource_type: 'Pod', namespace: 'kube-system' }, rows)], answer: '## kube-system\n\n| Pod | Status | Ready |\n|---|---|---|\n' + rows.map((p) => '| ' + p.name + ' | ' + p.status + ' | ' + p.ready + ' |').join('\n') }
  }
  if (/service|서비스/i.test(q) && /default/i.test(q)) return { question: q, calls: [call('k8s_get_resources', { resource_type: 'Service', namespace: 'default' }, { items: clusterList('Service', 'default') })], answer: pick(ko, '`default` Namespace에는 API 서버를 가리키는 `kubernetes` Service만 있습니다. 앱의 Service는 `commerce`와 `payments` 등 각 Namespace에 있습니다.', 'The `default` namespace holds only the `kubernetes` Service, which points at the API server. Application Services are in their own namespaces, such as `commerce` and `payments`.') }
  return null
}

export function suggestedQuestions(ko: boolean): string[] {
  return [
    pick(ko, 'checkout-api가 왜 재시작하나요?', 'Why is checkout-api restarting?'),
    pick(ko, 'checkout-api CPU를 그래프로 보여 주세요.', 'Graph checkout-api CPU usage.'),
    pick(ko, '클러스터 비용과 자원 사용량을 정리해 주세요.', 'Summarize cluster cost and resource efficiency.'),
    pick(ko, 'checkout-api를 재시작해 주세요.', 'Restart checkout-api.'),
  ]
}

function notPrepared(q: string, ko: boolean, topicEnded: boolean): Turn {
  const list = suggestedQuestions(ko).map((s) => '- ' + s).join('\n')
  const head = topicEnded
    ? pick(ko, '이 주제에서 준비한 답은 여기까지입니다.', 'That is the end of the prepared answers for this topic.')
    : pick(ko, '체험판은 준비된 질문에만 답합니다.', 'The demo answers prepared questions only.')
  return { question: q, calls: [], unprepared: true, answer: head + pick(ko, '\n\n아래 질문 중 하나를 골라 보세요.\n\n', '\n\nTry one of these.\n\n') + list }
}

interface Session { id: string; title: string; title_en?: string; created_at: string; updated_at: string; messages: Row[]; messages_en?: Row[]; topic?: string; progress: Record<string, number> }
const sessions = new Map<string, Session>()
let sessionSeq = 0, messageSeq = 0

const toolMarkdown = (c: Call) => '<details>\n<summary>🔧 <strong>' + c.function + '</strong></summary>\n\n<details>\n<summary><strong>📋 Arguments</strong></summary>\n\n~~~json\n' + JSON.stringify(c.args, null, 2) + '\n~~~\n\n</details>\n\n<details>\n<summary><strong>📊 Results</strong></summary>\n\n~~~' + (c.is_json ? 'json' : '') + '\n' + c.result + '\n~~~\n\n</details>\n\n</details>\n\n'
const msg = (role: string, content: string, extra: Row = {}) => ({ id: ++messageSeq, role, content, created_at: now(), ...extra })
function create(title: string): Session {
  const s: Session = { id: 'sample-' + (++sessionSeq), title: title || 'New conversation', created_at: now(), updated_at: now(), messages: [], progress: {} }
  sessions.set(s.id, s)
  return s
}
const numbered = (calls: Call[]) => calls.map((c, i) => ({ ...c, call_id: i + 1 }))

// The nine prepared conversations, oldest first, so the graph exploration is the newest.
for (const key of ['overview', 'policy', 'helm', 'cost', 'logs', 'audit', 'alerts', 'pods', 'graphs']) {
  const firstKo = turnsFor(key, true)[0], firstEn = turnsFor(key, false)[0]
  const titles: Record<string, [string, string]> = {
    graphs: ['CPU·오류율 · 그래프 탐색', 'CPU & errors · graph exploration'], pods: ['checkout-api · 재시작 조사', 'checkout-api · restart investigation'],
    alerts: ['KubePodCrashLooping · 알림 조사', 'KubePodCrashLooping · alert investigation'], logs: ['checkout · Loki와 Tempo', 'checkout · Loki and Tempo'],
    cost: ['클러스터 비용 · 자원 효율', 'Cluster cost · resource efficiency'], helm: ['storefront · 릴리스 검토', 'storefront · release review'],
    audit: ['checkout-api · 변경 이력', 'checkout-api · audit trail'], policy: ['정책 보고서 · 실패 항목', 'Policy reports · failed checks'],
    overview: ['Commerce Production · 운영 요약', 'Commerce Production · operations overview'],
  }
  const s = create(titles[key][0] || firstKo.question)
  s.title_en = titles[key][1] || firstEn.question
  s.topic = key
  s.progress[key] = turnsFor(key, true).length
  const messages = (ko: boolean) => turnsFor(key, ko).flatMap((t) => {
    const calls = numbered(t.calls)
    return [msg('user', t.question), msg('assistant', calls.map(toolMarkdown).join('') + t.answer, { tool_calls: calls })]
  })
  s.messages = messages(true)
  s.messages_en = messages(false)
}

const shown = (s: Session) => (lang() === 'en' && s.messages_en ? s.messages_en : s.messages)
const summary = (s: Session) => ({ id: s.id, title: lang() === 'en' && s.title_en ? s.title_en : s.title, created_at: s.created_at, updated_at: s.updated_at, message_count: s.messages.length })

// A prepared question, typed or picked, is its own turn whatever came before it.
const TOPICS = ['graphs', 'pods', 'alerts', 'logs', 'cost', 'helm', 'audit', 'policy', 'overview', 'restart']
const plain = (text: string) => text.toLowerCase().replace(/[\s.,?!·’'"“”]/g, '')
function preparedTurn(q: string): { key: string; step: number } | null {
  const wanted = plain(q)
  for (const key of TOPICS) for (const ko of [true, false]) {
    const step = turnsFor(key, ko).findIndex((t) => plain(t.question) === wanted)
    if (step >= 0) return { key, step }
  }
  return null
}

function answerFor(s: Session, q: string, ko: boolean): Turn {
  const first = starter(q, ko)
  if (first) return first
  const exact = preparedTurn(q)
  if (exact) {
    s.progress[exact.key] = exact.step + 1
    s.topic = exact.key
    return turnsFor(exact.key, ko)[exact.step]
  }
  let key = topicOf(q)
  const followUp = !key && !!s.topic && FOLLOW_UP.test(q)
  if (!key && followUp) key = s.topic!
  if (!key) return notPrepared(q, ko, false)
  const turns = turnsFor(key, ko)
  let step = s.progress[key] ?? 0
  if (key === 'graphs') {
    if (/오류율|error rate|p95|latency|응답 시간/i.test(q)) step = 2
    else if (/한.?시간|1시간|one hour|last hour|60.?m|\b1h\b/i.test(q)) step = 1
    else if (/원인|확정|cause|conclu/i.test(q)) step = 3
    else if (!followUp && /cpu|처음|다시|start|again/i.test(q)) step = 0
  }
  if (key === 'cost' && /일주일|7일|week|\b7d\b|\b7.?days?\b/i.test(q)) step = 3
  if (key === 'cost' && /namespace|네임스페이스/i.test(q)) step = 2
  if (key === 'audit' && /csv|파일|download|내보내/i.test(q)) step = 3
  if (key === 'pods' && /deployment|설정.*읽/i.test(q)) step = 2
  if (key === 'helm' && /values/i.test(q)) step = 2
  if (key === 'helm' && /롤백|rollback/i.test(q)) step = 3
  if (followUp && step >= turns.length) return notPrepared(q, ko, true)
  if (step >= turns.length) step = 0
  step = Math.min(step, turns.length - 1)
  s.progress[key] = step + 1
  s.topic = key
  return turns[step]
}

// ---- Approvals of the chat's write tools (in memory; a decision changes only the sample data)

interface Approval { id: string; session_id: string; cluster: string; tool: string; args: Row; status: string; result: string | null; created_at: string; expires_at: string; decided_at: string | null }
const approvals = new Map<string, Approval>()
let approvalSeq = 0

function setStoredStatus(a: Approval) {
  const s = sessions.get(a.session_id)
  for (const list of [s?.messages, s?.messages_en]) for (const m of list || []) for (const c of m.tool_calls || []) if (c.approval_id === a.id) c.approval_status = a.status
}

export function decideApproval(id: string, kind: 'approve' | 'reject'): { status: number; data: any } {
  const a = approvals.get(id)
  if (!a) return { status: 404, data: { detail: 'Approval not found.' } }
  if (a.status !== 'pending') return { status: 409, data: { detail: 'This approval was already decided.' } }
  a.decided_at = now()
  if (kind === 'approve') {
    const pod = pods.find((p) => p.namespace === a.args.namespace && p.name.startsWith(String(a.args.resource_name) + '-'))
    if (pod) deletePod(pod.namespace, pod.name)
    a.status = 'executed'
    a.result = 'deployment.apps/' + a.args.resource_name + ' restarted\n\n' + (lang() === 'ko' ? '체험판 — 실제로 바뀌지 않음' : 'Demo — nothing really changes')
  } else {
    a.status = 'rejected'
  }
  setStoredStatus(a)
  notice('demo')
  return { status: 200, data: { ...a } }
}

export function approvalRead(id: string | null, sessionId: string | null): { status: number; data: any } {
  if (id) {
    const a = approvals.get(id)
    return a ? { status: 200, data: { ...a } } : { status: 404, data: { detail: 'Approval not found.' } }
  }
  return { status: 200, data: [...approvals.values()].filter((a) => !sessionId || a.session_id === sessionId) }
}

// ---- The chat's routes

export interface Answer { status: number; data?: any; stream?: (signal?: AbortSignal | null) => ReadableStream<Uint8Array> }

export function chatRoute(method: string, path: string, params: URLSearchParams, body: Row): Answer | null {
  if (path === '/sessions') {
    if (method === 'GET') return { status: 200, data: [...sessions.values()].reverse().map(summary) }
    if (method === 'POST') return { status: 200, data: summary(create(String(body.title || 'New conversation').slice(0, 100))) }
  }
  const one = path.match(/^\/sessions\/([^/]+)(\/messages)?$/)
  if (one) {
    const s = sessions.get(decodeURIComponent(one[1]))
    if (!s) return { status: 404, data: { detail: 'Conversation not found.' } }
    if (method === 'GET') return { status: 200, data: one[2] ? { messages: [] } : { ...summary(s), messages: shown(s), messages_before: 0 } }
    if (method === 'DELETE') { sessions.delete(s.id); return { status: 204 } }
    if (method === 'PATCH') { s.title = String(body.title || s.title).slice(0, 100); s.title_en = s.title; return { status: 200, data: summary(s) } }
    if (method === 'POST' && one[2]) {
      if (Array.isArray(body.messages)) for (const m of body.messages) { const row = msg(m.role, m.content); s.messages.push(row); s.messages_en?.push(row) }
      return { status: 200, data: { ok: true } }
    }
  }
  if (path === '/ai/tool-approvals' && method === 'GET') return approvalRead(null, params.get('session_id'))
  const approval = path.match(/^\/ai\/tool-approvals\/([^/]+)(?:\/(approve|reject))?$/)
  if (approval) {
    if (method === 'GET' && !approval[2]) return approvalRead(decodeURIComponent(approval[1]), null)
    if (method === 'POST' && approval[2]) return decideApproval(decodeURIComponent(approval[1]), approval[2] as 'approve' | 'reject')
  }
  const chat = path.match(/^\/ai\/sessions\/([^/]+)\/(chat|floating-chat)$/)
  if (chat && method === 'POST') {
    const s = sessions.get(decodeURIComponent(chat[1]))
    if (!s) return { status: 404, data: { detail: 'Conversation not found.' } }
    const question = String(body.message ?? params.get('message') ?? '')
    const ko = /[가-힣ㄱ-ㅎ]/.test(question) || (!/[a-z]/i.test(question) && lang() === 'ko')
    return { status: 200, stream: (signal) => streamTurn(s, question, ko, signal) }
  }
  return null
}

const access = { cluster: 'default', kind: 'person', user: 'operator@northstar.example', groups: ['kubeast:role:operations'], role: 'Operations', namespaces: [], impersonation: true, mode: 'read' }

function streamTurn(s: Session, question: string, ko: boolean, signal?: AbortSignal | null): ReadableStream<Uint8Array> {
  hideSuggestions()
  const turn = answerFor(s, question, ko)
  const calls = numbered(turn.calls)
  const user = msg('user', question)
  s.messages.push(user)
  s.messages_en?.push(user)
  const events: Row[] = []
  for (const c of calls) {
    events.push({ function: c.function, args: c.args, call_id: c.call_id })
    if (turn.approval) {
      const a: Approval = { id: 'approval-' + (++approvalSeq), session_id: s.id, cluster: 'default', tool: c.function, args: c.args, status: 'pending', result: null, created_at: now(), expires_at: new Date(Date.now() + 15 * 60000).toISOString(), decided_at: null }
      approvals.set(a.id, a)
      c.approval_id = a.id
      c.approval_status = 'pending'
      c.cluster = a.cluster
      c.expires_at = a.expires_at
      events.push({ approval_required: a.id, function: c.function, args: c.args, cluster: a.cluster, expires_at: a.expires_at })
      events.push({ function_result: c.function, result: c.result, is_json: c.is_json, call_id: c.call_id })
    } else {
      const k8s = c.function.startsWith('k8s_') || c.function === 'get_cluster_overview'
      const requests = k8s ? { total: 1, requests: [{ source: 'cluster', verb: 'get', resource: 'pods', namespace: c.args.namespace || '', status: 200 }] } : undefined
      events.push({ function_result: c.function, result: c.result, is_json: c.is_json, call_id: c.call_id, access, ...(requests ? { requests } : {}), ...(c.chart ? { chart: c.chart } : {}) })
    }
  }
  for (let i = 0; i < turn.answer.length; i += 32) events.push({ content: turn.answer.slice(i, i + 32) })
  const encoder = new TextEncoder()
  let timer = 0
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0
      const stop = () => { clearInterval(timer); try { controller.error(new DOMException('The demo answer was stopped.', 'AbortError')) } catch { /* closed */ } }
      if (signal?.aborted) { stop(); return }
      signal?.addEventListener('abort', stop, { once: true })
      timer = window.setInterval(() => {
        if (index < events.length) { controller.enqueue(encoder.encode('data: ' + JSON.stringify(events[index++]) + '\n\n')); return }
        clearInterval(timer)
        const assistant = msg('assistant', calls.map(toolMarkdown).join('') + turn.answer, { tool_calls: calls })
        s.messages.push(assistant)
        s.messages_en?.push(assistant)
        s.updated_at = now()
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
        signal?.removeEventListener('abort', stop)
        if (turn.unprepared) showSuggestions(suggestedQuestions(ko))
      }, 75)
    },
    cancel() { clearInterval(timer) },
  })
}
