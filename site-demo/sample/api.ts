// Answers the demo's API requests from the sample data, in the page. A write changes only that data and says so; what the
// demo has not prepared answers "not in the demo" instead of an error from a server.
import { chatRoute, type Answer } from './chat'
import { advance, clusterRead, clusterWrite, optimization } from './cluster'
import { unifiedDiff } from './diff'
import { auditCsv, auditList, cost, created, features, findRelease, helmRead, manifestOf, me, newRevision, readValues, releases, revisionText, type Release } from './fixtures'
import { lang, notice } from './notice'

export interface Reply extends Answer { text?: string; headers?: Record<string, string> }

const ok = (data: unknown): Reply => ({ status: 200, data })
const unsupportedText = () => (lang() === 'ko' ? '체험판에서는 지원하지 않습니다' : 'Not supported in the demo')
// What the demo has not prepared: the screen shows this line where it would show a server's reason.
export function unsupported(write: boolean): Reply {
  if (write) notice('unsupported')
  return { status: 501, data: { detail: unsupportedText() } }
}
const changed = (data: unknown): Reply => {
  notice('demo')
  return ok(data)
}

function parseBody(text: string): Record<string, any> {
  if (!text) return {}
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

// Two revisions of a release compared as the server does, labelled <namespace>/<name>@<revision>.<section>.
const revisionDiff = (r: Release, from: number, to: number, section: string) =>
  unifiedDiff(`${r.namespace}/${r.name}@${from}.${section}`, `${r.namespace}/${r.name}@${to}.${section}`, revisionText(r, from, section), revisionText(r, to, section))

function helmWrite(method: string, route: string, params: URLSearchParams, body: Record<string, any>): Reply | null {
  const m = route.match(/^\/helm\/releases\/([^/]+)\/([^/]+)(?:\/(rollback|values|test|diff))?$/)
  if (!m) return null
  const r = findRelease(decodeURIComponent(m[1]), decodeURIComponent(m[2]))
  if (!r) return { status: 404, data: { detail: 'Example release not found.' } }
  const action = m[3]
  if (method === 'POST' && action === 'diff') {
    const from = Number(body.from) || r.revision - 1, to = Number(body.to) || r.revision, section = body.section === 'manifest' ? 'manifest' : 'values'
    return ok({ from, to, section, diff: revisionDiff(r, from, to, section) })
  }
  if (method === 'POST' && action === 'rollback') {
    const to = Number(body.revision) || r.revision - 1
    if (!r.kept.has(to)) return { status: 404, data: { detail: 'release: not found' } }
    const from = r.revision
    if (body.dryRun) return ok({ dryRun: true, fromRevision: from, toRevision: to, diff: revisionDiff(r, from, to, 'manifest') })
    newRevision(r, 'Rollback to ' + to, revisionText(r, to, 'values'))
    return changed({ dryRun: false, fromRevision: from, toRevision: to, newRevision: r.revision, status: 'deployed' })
  }
  if (method === 'PUT' && action === 'values') {
    const text = String(body.values ?? ''), from = r.revision
    let values: Record<string, any>
    try { values = readValues(text) } catch (e) { return { status: 400, data: { detail: (e as Error).message } } }
    if (body.dryRun) {
      // the manifest these values render against the one deployed, as the preview shows
      const diff = unifiedDiff(`${r.namespace}/${r.name}@${from}.manifest`, `${r.namespace}/${r.name}@next.manifest`, revisionText(r, from, 'manifest'), manifestOf(r, values))
      return ok({ dryRun: true, fromRevision: from, chartVersion: r.chartVersion, diff, values_changed: JSON.stringify(values) !== JSON.stringify(readValues(revisionText(r, from, 'values'))) })
    }
    newRevision(r, 'Upgrade complete', text)
    return changed({ dryRun: false, fromRevision: from, newRevision: r.revision, status: 'deployed', chartVersion: r.chartVersion })
  }
  if (method === 'POST' && action === 'test') {
    return changed({ success: true, hooks: [{ name: r.name + '-test-connection', phase: 'Succeeded', failed: false, logs: 'Connected to ' + r.name + ':80 (sample data)\n' }] })
  }
  if (method === 'DELETE' && !action) {
    const keepHistory = params.get('keepHistory') === 'true'
    const resources = [{ kind: r.kind, apiVersion: 'apps/v1', name: r.name, namespace: r.namespace }, { kind: 'Service', apiVersion: 'v1', name: r.name, namespace: r.namespace }]
    if (params.get('dryRun') === 'true') return ok({ dryRun: true, release: r.name, namespace: r.namespace, keepHistory, resources })
    releases.splice(releases.indexOf(r), 1)
    return changed({ dryRun: false, release: r.name, namespace: r.namespace, keepHistory, info: 'uninstalled' })
  }
  return null
}

function writeRoute(method: string, route: string, params: URLSearchParams, body: Record<string, any>): Reply {
  if (method === 'POST' && ['/auth/refresh', '/audit/cluster-switch'].includes(route)) return { status: 204 }
  const helm = helmWrite(method, route, params, body)
  if (helm) return helm
  const cluster = clusterWrite(method, route, body)
  if (cluster) {
    if (cluster.changed) notice('demo')
    return { status: cluster.status, data: cluster.data }
  }
  if (method === 'POST' && route === '/cluster/can-i') return ok({ allowed: true })
  return unsupported(true)
}

function readRoute(route: string, params: URLSearchParams): Reply {
  if (route === '/auth/me') return ok(me)
  if (route === '/auth/access-requests/config') return ok({ enabled: false, max_hours: 0, roles: [], help_text: '', help_url: '' })
  if (route === '/ai/config') return ok({ model: lang() === 'ko' ? '예시 답변(모델 없음)' : 'Sample answers (no model)', app_name: 'Kubeast', version: 'v0.8.0' })
  if (route === '/auth/oidc/config') return ok({ enabled: false })
  if (route === '/clusters') return ok({ items: [{ id: 'default', display_name: 'Commerce Production', mode: 'external', is_self_cluster: false, health_status: 'healthy', created_by: 'platform-operator', created_at: created, updated_at: created }] })
  if (route === '/system/deployment-mode') return ok({ mode: 'k8s' })
  if (route === '/health') return ok({ status: 'ok', kubernetes: 'connected' })
  if (route === '/cluster/features' || route === '/features') return ok(features)
  if (route === '/auth/admin/audit-logs') return ok(auditList(params))
  if (route === '/auth/admin/audit/integrity') return ok({ enabled: false, oldest_seq: 449, sealed_through_seq: 0, unsealed_rows: 32, last_anchor: null })
  if (route === '/cluster/cost/status') return ok({ available: true, source: 'proxy' })
  if (route === '/cluster/cost') return ok(cost(params))
  const helm = helmRead(route, params)
  if (helm) return helm
  if (route === '/cluster/can-i') return ok({ allowed: true })
  // Features the sample cluster has off answer as such a cluster does.
  if (route === '/cluster/logsearch/status') return ok({ enabled: false, available: false, clusters: [] })
  if (route === '/cluster/policyreports/status') return ok({ enabled: false, installed: false, group: '' })
  if (route === '/cluster/prometheus/status') return ok({ available: false, source: 'none' })
  const cluster = clusterRead(route, params)
  if (cluster) return { status: cluster.status, data: cluster.data }
  return unsupported(false)
}

// The Overview's optimization answer: what the namespace's containers request against what they use, from the sample
// cluster's metrics, then prepared suggestions in the screen's language (no model is called), as the answer stream sends them.
function optimizationStream(params: URLSearchParams): Reply {
  const ns = params.get('namespace') || 'default'
  const ko = (params.get('lang') || lang()).startsWith('ko')
  const table = optimization(ns)
  const measured = table.rows.filter((r: Record<string, any>) => r.cpu_usage_m !== undefined)
  const mib = (b: number) => Math.round(b / 1048576) + 'Mi'
  const observed = (ko ? '| Workload | 컨테이너 | CPU 요청 | CPU 사용 | 메모리 요청 | 메모리 사용 |' : '| Workload | Container | CPU request | CPU used | Memory request | Memory used |') + '\n|---|---|---:|---:|---:|---:|\n'
    + table.rows.map((r: Record<string, any>) => `| ${r.kind}/${r.name} | ${r.container} | ${r.cpu_request_m}m | ${r.cpu_usage_m ?? '-'}${r.cpu_usage_m === undefined ? '' : 'm'} | ${mib(r.mem_request_bytes)} | ${r.mem_usage_bytes === undefined ? '-' : mib(r.mem_usage_bytes)} |`).join('\n') + '\n'
  const gap = [...measured].sort((a: Record<string, any>, b: Record<string, any>) => (b.cpu_request_m - b.cpu_usage_m) - (a.cpu_request_m - a.cpu_usage_m))[0] as Record<string, any> | undefined
  const answer = !table.rows.length
    ? (ko ? `\`${ns}\`에는 요청량을 비교할 워크로드가 없습니다.` : `\`${ns}\` has no workloads to compare.`)
    : gap
      ? (ko
        ? `## ${ns}: 요청량과 사용량\n\n측정된 컨테이너 ${measured.length}개 중 차이가 가장 큰 곳은 **${gap.kind}/${gap.name}**입니다. CPU를 ${gap.cpu_request_m}m 요청하고 최대 ${gap.cpu_usage_m}m를 썼습니다. 20% 여유를 둔 ${gap.cpu_recommend_m}m로 낮출 수 있습니다.\n\n- 한 번에 크게 줄이지 말고 단계적으로 낮추며 스로틀링을 확인하세요.\n- 사용량이 없는 컨테이너 ${table.totals.unmeasured_rows}개(실행 중이 아님)는 요청량을 그대로 둡니다.\n\n_체험판 예시 데이터로 만든 답입니다. 모델을 부르지 않습니다._\n`
        : `## ${ns}: requests against use\n\nOf ${measured.length} measured containers, the largest gap is **${gap.kind}/${gap.name}**: it requests ${gap.cpu_request_m}m CPU and used ${gap.cpu_usage_m}m at most. ${gap.cpu_recommend_m}m keeps a 20% margin.\n\n- Lower requests in steps and watch for CPU throttling.\n- ${table.totals.unmeasured_rows} containers had no usage (not running) and keep their requests.\n\n_Prepared from the demo's sample data; no model is called._\n`)
      : (ko ? `\`${ns}\`의 컨테이너는 지금 실행 중이 아니어서 사용량이 없습니다. 요청량은 그대로 둡니다.` : `No container in \`${ns}\` is running now, so there is no usage to compare; requests stay as they are.`)
  const events = [{ kind: 'observed', content: observed }, ...answer.match(/[\s\S]{1,48}/g)!.map((content) => ({ kind: 'answer', content })), { kind: 'meta', finish_reason: 'stop', max_tokens: null }]
  const encoder = new TextEncoder()
  return {
    status: 200,
    stream: (signal) => new ReadableStream<Uint8Array>({
      start(controller) {
        let index = 0
        const timer = window.setInterval(() => {
          if (signal?.aborted) { clearInterval(timer); try { controller.error(new DOMException('Aborted', 'AbortError')) } catch { /* closed */ } return }
          if (index < events.length) { controller.enqueue(encoder.encode('data: ' + JSON.stringify(events[index++]) + '\n\n')); return }
          clearInterval(timer)
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }, 40)
      },
    }),
  }
}

// One request of the demo. `path` is the URL path as the console sends it (/api/v1/…, /health).
export function handle(method: string, url: URL, bodyText: string): Reply {
  const route = url.pathname.replace(/^\/api\/v1/, '')
  const params = url.searchParams
  const body = parseBody(bodyText)
  advance()
  const chat = chatRoute(method, route, params, body)
  if (chat) return chat
  if (method === 'GET' && route === '/ai/suggest-optimization/stream') return optimizationStream(params)
  if (method === 'GET' && route === '/auth/admin/audit-logs/export') {
    return { status: 200, text: auditCsv(params), headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="kubeast-sample-audit.csv"' } }
  }
  if (method === 'GET' || method === 'HEAD') return readRoute(route, params)
  return writeRoute(method, route, params, body)
}
