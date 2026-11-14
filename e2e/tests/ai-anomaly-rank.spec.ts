import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// The AI tool anomaly_rank through the MCP endpoint, so the checks are exact. A namespace of this run on self holds a
// crashing Deployment; the same namespace on the second cluster (default, which has a Prometheus) holds a pod that exits
// three times and then stays up and a pod holding most of its memory limit in a memory-backed emptyDir. Each answer is
// held to the route behind the tool (the same caller and window are answered from memory, so the two are one answer),
// its failing objects to the Dashboard's issues route, its terminations and restarts to kubectl and its memory share to
// the check's own query asked of the second cluster's Prometheus at the window's end. The checks it could not run are
// named with why: no Prometheus on self, no CPU limit in the namespace, and the three Prometheus checks for a grant
// limited to the namespace. The tool is offered exactly where features.anomalyRank is on.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-anomaly-pass1!'
const SELF = 'self'
const SECOND = 'default'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const IMAGE = 'busybox:1.37'
const READ_GROUP = 'kubeast:role:read'
const RESTARTS = 3
const FILL_MIB = 60
const LIMIT_MIB = 64
// self's window ends now; the second cluster's is a quarter hour so that it holds the pods' making whenever the wait ends
const WINDOW_S = 600
const SECOND_WINDOW_S = 900

// every check of internal/anomaly, each answered once: a finding, normal, or not run with why
const CHECKS = ['issues', 'crash_reasons', 'restarts', 'memory_near_limit', 'cpu_throttling', 'error_log_patterns', 'error_log_counts',
  'trace_errors', 'trace_latency', 'trace_requests', 'node_pressure']
const METRIC_CHECKS = ['restarts', 'memory_near_limit', 'cpu_throttling']
const NO_PROMETHEUS = 'no Prometheus reaches this cluster'
const LIMITED = "the cluster's Prometheus covers the whole cluster; your grant on this cluster is limited to namespaces"
const NO_SERIES = 'Prometheus holds no series for this check in the namespace (its metric is not scraped there, or no pod ran)'
const NO_LOG_STORE = 'no log store for this cluster (features.logSearch, or the cluster\'s own store)'
const NO_TRACE_STORE = 'no trace store for this cluster (features.traceStore)'
const OFF = 'anomaly ranking is off (features.anomalyRank.enabled)'
// What kubectl prints of a container that keeps exiting
const CRASHED = /^(CrashLoopBackOff|Error)$/

type Finding = { check: string; target: string; verdict: string; summary: string; before?: number; now?: number; ratio?: number; new?: boolean; examples?: string[] }
type Answer = {
  namespace: string; window: { start: string; end: string }; compared_with: { start: string; end: string }
  findings: Finding[]; findings_total: number; normal: string[]; not_run: { check: string; reason: string }[]; store_queries: number
  findings_note?: string; examples_note?: string; call_order?: unknown
}
type Terminated = { reason?: string; finishedAt?: string }
type ContainerStatus = { name: string; restartCount: number; ready: boolean; state?: { running?: object; waiting?: { reason?: string }; terminated?: Terminated }; lastState?: { terminated?: Terminated } }
type Pod = { metadata: { name: string }; status: { phase?: string; containerStatuses?: ContainerStatus[]; initContainerStatuses?: ContainerStatus[] } }
type Sample = { metric: Record<string, string>; value: [number, string] }

function kubectlFor(kindName: string): ((args: string, input?: string) => string) | null {
  try {
    const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-anomaly-')), 'kubeconfig')
    fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
    return (args: string, input?: string) =>
      execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
  } catch {
    return null
  }
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function call(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    failOnStatusCode: false,
  })
  expect(res.status(), `${name}: ${await res.text()}`).toBe(200)
  const result = (await res.json()).result
  return { isError: !!result.isError, text: result.content?.[0]?.text as string }
}
async function rank(request: APIRequestContext, token: string, args: Record<string, unknown>): Promise<Answer> {
  const out = await call(request, token, 'anomaly_rank', args)
  expect(out.isError, out.text).toBe(false)
  return JSON.parse(out.text)
}
// the route behind the tool, as the same caller and window
async function routeAnswer(request: APIRequestContext, token: string, cluster: string, ns: string, start: string, end: string) {
  const res = await request.get(`/api/v1/namespaces/${ns}/anomalies`, { headers: bearer(token), params: { cluster, start, end }, failOnStatusCode: false })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()) as Answer
}
// the Dashboard's issues of the namespace that the check lists: critical and warning, no node, no list that failed
async function issueTargets(request: APIRequestContext, token: string, cluster: string, ns: string, minutes: number) {
  const res = await request.get('/api/v1/cluster/issues', { headers: bearer(token), params: { cluster, window: String(minutes) } })
  expect(res.ok(), await res.text()).toBeTruthy()
  const issues = (await res.json()).issues as { kind: string; namespace?: string; name: string; severity: string }[]
  return issues.filter((i) => i.namespace === ns && ['critical', 'warning'].includes(i.severity) && i.kind !== 'Node' && i.kind !== 'Collector')
    .map((i) => `${i.kind}/${i.name}`).sort()
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
const minuteNow = () => Math.floor(Date.now() / 60_000) * 60_000
const found = (a: Answer, check: string) => a.findings.filter((f) => f.check === check)
const reasonOf = (a: Answer, check: string) => a.not_run.find((n) => n.check === check)?.reason
const round3 = (v: number) => Math.round(v * 1000) / 1000

// what FromCrashReasons counts, read from kubectl: each container's current and last termination (not Completed) that
// finished in [start, end), by reason
function terminations(pods: Pod[], start: number, end: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of pods) {
    for (const c of [...(p.status.containerStatuses ?? []), ...(p.status.initContainerStatuses ?? [])]) {
      for (const t of [c.state?.terminated, c.lastState?.terminated]) {
        if (!t?.reason || t.reason === 'Completed' || !t.finishedAt) continue
        const at = Date.parse(t.finishedAt)
        if (at >= start && at < end) out[t.reason] = (out[t.reason] ?? 0) + 1
      }
    }
  }
  return out
}
// the termination times and restart counts, to see that the cluster held still around a read
const podState = (pods: Pod[]) => JSON.stringify(pods.map((p) => [p.metadata.name, (p.status.containerStatuses ?? []).map((c) =>
  [c.restartCount, c.state?.terminated?.finishedAt, c.lastState?.terminated?.finishedAt])]))

// each check is in one place: a finding, normal, or not run with a reason
function eachCheckOnce(a: Answer) {
  expect(a.findings_total, 'every finding is listed').toBe(a.findings.length)
  const withFindings = [...new Set(a.findings.map((f) => f.check))]
  const notRun = a.not_run.map((n) => n.check)
  expect([...withFindings, ...a.normal, ...notRun].sort()).toEqual([...CHECKS].sort())
  for (const n of a.not_run) expect(n.reason.length, `${n.check} says why it did not run`).toBeGreaterThan(0)
  for (const f of a.findings) expect(f.verdict, `${f.check} ${f.target}`).toBe('anomalous')
}

test.describe('AI tool anomaly_rank', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)
  const id = Date.now().toString(36)
  const NS = `e2e-anomaly-${id}`
  const userIds: string[] = []
  const self = kubectlFor('kubeast')
  const second = kubectlFor('kubeast-b')
  let admin = ''
  let mcpOn = false
  let switchOn = false
  let ready = false
  let secondReady = false
  let features: Record<string, { enabled?: boolean; clusters?: string[] }> = {}

  const selfPods = () => (JSON.parse(self!(`get pods -n ${NS} -o json`)).items as Pod[])
  const secondPods = () => (JSON.parse(second!(`get pods -n ${NS} -o json`)).items as Pod[])
  const secondPod = (name: string) => JSON.parse(second!(`get pod ${name} -n ${NS} -o json`)) as Pod
  // the second cluster's Prometheus, read directly through its API server (the kind admin) at a time
  const promAt = (expr: string, atSeconds: number): Sample[] => JSON.parse(second!(
    `get --raw "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query?query=${encodeURIComponent(expr)}&time=${atSeconds}"`,
  )).data.result
  // the queries of the restarts and memory_near_limit checks (internal/anomaly Queries) for the namespace
  const restartsQuery = (seconds: number) => `sum by (pod) (increase(kube_pod_container_status_restarts_total{namespace="${NS}"}[${seconds}s]))`
  const memoryQuery = (seconds: number) =>
    `max by (pod, container) (max_over_time(container_memory_working_set_bytes{namespace="${NS}",container!=""}[${seconds}s])) / ` +
    `max by (pod, container) (kube_pod_container_resource_limits{namespace="${NS}",resource="memory"} > 0)`

  async function user(request: APIRequestContext, name: string, cluster: string, grant: object): Promise<string> {
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-anomaly-${name}-${id}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E anomaly ${name}`, email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    userIds.push(userId)
    const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${cluster}`, { headers: bearer(admin), data: grant })
    expect(put.ok(), await put.text()).toBeTruthy()
    return login(request, email, PW)
  }

  test.beforeAll(async ({ request }) => {
    test.setTimeout(420_000)
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    mcpOn = config.ok() && !!(await config.json()).enabled
    if (!mcpOn) return
    features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    switchOn = features.anomalyRank?.enabled === true
    if (!switchOn || !self) return

    // self: a Deployment whose container exits at once
    self('apply -f -', [
      `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${NS}}`,
      JSON.stringify({
        apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'crash', namespace: NS },
        spec: {
          replicas: 1, selector: { matchLabels: { app: 'crash' } },
          template: { metadata: { labels: { app: 'crash' } }, spec: { terminationGracePeriodSeconds: 0, containers: [{ name: 'app', image: IMAGE, imagePullPolicy: 'IfNotPresent', command: ['false'] }] } },
        },
      }),
    ].join('\n---\n'))

    // the second cluster: a pod that exits three times and then stays up (its first run waits a minute, so the
    // restart counter is scraped at 0 first), and a pod holding FILL_MIB of its LIMIT_MIB in a memory-backed emptyDir
    const status = second ? await (await request.get(`/api/v1/cluster/prometheus/status?cluster=${SECOND}`, { headers: bearer(admin) })).json() : {}
    if (second && status.available) {
      second('apply -f -', [
        `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${NS}}`,
        JSON.stringify({
          apiVersion: 'v1', kind: 'Pod', metadata: { name: 'settle', namespace: NS },
          spec: {
            terminationGracePeriodSeconds: 0,
            containers: [{
              name: 'app', image: IMAGE, imagePullPolicy: 'IfNotPresent', command: ['sh', '-c',
                `n=$(( $(cat /state/n 2>/dev/null || echo 0) + 1 )); echo $n > /state/n; if [ $n -gt ${RESTARTS} ]; then exec sleep 86400; fi; if [ $n -eq 1 ]; then sleep 60; fi; exit 1`],
              volumeMounts: [{ name: 'state', mountPath: '/state' }],
            }],
            volumes: [{ name: 'state', emptyDir: {} }],
          },
        }),
        JSON.stringify({
          apiVersion: 'v1', kind: 'Pod', metadata: { name: 'near', namespace: NS },
          spec: {
            terminationGracePeriodSeconds: 0,
            containers: [{
              name: 'fill', image: IMAGE, imagePullPolicy: 'IfNotPresent',
              command: ['sh', '-c', `dd if=/dev/zero of=/fill/blob bs=1M count=${FILL_MIB} && exec sleep 86400`],
              resources: { requests: { memory: `${LIMIT_MIB}Mi` }, limits: { memory: `${LIMIT_MIB}Mi` } },
              volumeMounts: [{ name: 'fill', mountPath: '/fill' }],
            }],
            volumes: [{ name: 'fill', emptyDir: { medium: 'Memory', sizeLimit: `${FILL_MIB + 2}Mi` } }],
          },
        }),
      ].join('\n---\n'))
    }

    await expect.poll(() => {
      const crash = selfPods().find((p) => p.metadata.name.startsWith('crash-'))
      const c = crash?.status.containerStatuses?.[0]
      return c?.state?.waiting?.reason ?? c?.state?.terminated?.reason ?? ''
    }, { timeout: 120_000, intervals: [2_000], message: 'the crashing pod on self' }).toMatch(CRASHED)
    ready = true

    if (second && status.available) {
      await expect.poll(() => {
        const c = secondPod('settle').status.containerStatuses?.[0]
        return c ? `${c.restartCount} ${c.state?.running ? 'running' : 'not running'} ${c.ready}` : ''
      }, { timeout: 300_000, intervals: [5_000], message: `the pod that exits ${RESTARTS} times, then stays up` }).toBe(`${RESTARTS} running true`)
      await expect.poll(() => {
        const c = secondPod('near').status.containerStatuses?.[0]
        return c ? `${c.restartCount} ${c.ready}` : ''
      }, { timeout: 120_000, intervals: [3_000], message: 'the pod near its memory limit, never restarted' }).toBe('0 true')
      secondReady = true
    }
  })

  test.afterAll(async ({ request }) => {
    for (const u of userIds) await request.delete(`/api/v1/auth/admin/users/${u}`, { headers: bearer(admin), failOnStatusCode: false })
    for (const k of [self, second]) {
      try {
        k?.(`delete namespace/${NS} --wait=false --ignore-not-found`)
      } catch { /* gone already */ }
    }
  })

  test('on a cluster without Prometheus the crash findings are kubectl\'s and the Prometheus checks say why they did not run', async ({ request }) => {
    test.skip(!mcpOn, 'the MCP server is off (mcp.enabled)')
    test.skip(!switchOn, 'features.anomalyRank is off (on in deploy/kind/values.yaml)')
    test.skip(!ready, 'kind cluster kubeast is not reachable with kind get kubeconfig')
    const prom = await (await request.get(`/api/v1/cluster/prometheus/status?cluster=${SELF}`, { headers: bearer(admin) })).json()
    test.skip(!!prom.available, `cluster ${SELF} reads a Prometheus (${JSON.stringify(prom)})`)
    const crashPod = selfPods().find((p) => p.metadata.name.startsWith('crash-'))!.metadata.name

    // the container keeps exiting: compare when the pods held still around the reads, with a window that ends now
    // (each try a new window, so no answer is reused from the last try)
    await expect(async () => {
      const end = Math.floor(Date.now() / 1000) * 1000
      const start = end - WINDOW_S * 1000
      const before = selfPods()
      const tool = await rank(request, admin, { cluster: SELF, namespace: NS, since_time: stamp(start), until_time: stamp(end) })
      const route = await routeAnswer(request, admin, SELF, NS, stamp(start), stamp(end))
      const issues = await issueTargets(request, admin, SELF, NS, WINDOW_S / 60)
      const after = selfPods()
      expect(podState(after), 'the pods held still').toBe(podState(before))
      const want = terminations(before, start, end)
      expect(Object.keys(want).length, 'a termination in the window').toBeGreaterThan(0)

      expect(tool.examples_note ?? tool.findings_note, 'the answer was not cut').toBeUndefined()
      expect(tool).toEqual(route)
      expect(tool.window).toEqual({ start: stamp(start), end: stamp(end) })
      expect(tool.compared_with).toEqual({ start: stamp(start - WINDOW_S * 1000), end: stamp(start) })
      eachCheckOnce(tool)

      // terminations by reason, as kubectl's containers hold them; nothing before the namespace was made
      const crash = found(tool, 'crash_reasons')
      expect(crash.map((f) => [f.target, f.now])).toEqual(Object.entries(want).sort())
      for (const f of crash) {
        expect(f).toMatchObject({ verdict: 'anomalous', new: true, before: 0 })
        expect(f.summary).toContain(`${want[f.target]} container terminations with reason ${f.target} in the window, 0 in the window before`)
      }
      // failing now: the issues the Dashboard reads for this namespace, the crashing pod among them
      expect(found(tool, 'issues').map((f) => f.target).sort()).toEqual(issues)
      expect(issues).toContain(`Pod/${crashPod}`)
    }).toPass({ timeout: 150_000, intervals: [5_000] })

    const end = Math.floor(Date.now() / 1000) * 1000
    const tool = await rank(request, admin, { cluster: SELF, namespace: NS, since_time: stamp(end - WINDOW_S * 1000), until_time: stamp(end) })
    // no Prometheus: its three checks are named, never normal
    for (const check of METRIC_CHECKS) {
      expect(reasonOf(tool, check), check).toBe(NO_PROMETHEUS)
      expect(tool.normal).not.toContain(check)
    }
    // the log and trace checks say which store is missing; a window that does not end on a whole minute leaves the
    // trace checks out even with a store
    for (const check of ['error_log_patterns', 'error_log_counts']) {
      if (!features.logSearch?.clusters?.includes(SELF)) expect(reasonOf(tool, check), check).toBe(NO_LOG_STORE)
    }
    for (const check of ['trace_errors', 'trace_latency', 'trace_requests']) {
      if (!features.traceStore?.clusters?.includes(SELF)) expect(reasonOf(tool, check), check).toBe(NO_TRACE_STORE)
      else expect(reasonOf(tool, check), check).toMatch(/not on whole minutes|too many trace reads/)
    }
    if (!features.logSearch?.clusters?.includes(SELF) && !features.traceStore?.clusters?.includes(SELF)) {
      expect(tool.store_queries, 'no store was asked').toBe(0)
    }
  })

  test('with Prometheus the restarts and the memory near the limit are kubectl\'s and the query\'s, and a check with no series says so', async ({ request }) => {
    test.setTimeout(600_000)
    test.skip(!mcpOn, 'the MCP server is off (mcp.enabled)')
    test.skip(!switchOn, 'features.anomalyRank is off (on in deploy/kind/values.yaml)')
    test.skip(!secondReady, `cluster ${SECOND} (kind kubeast-b) does not read its Prometheus — scripts/add-kind-cluster.sh default --addons`)

    // wait for the window: a whole minute at which the second cluster's Prometheus counts the restarts kubectl
    // shows (the counter scraped after the last one) and the memory peak is past nine tenths of the limit
    let end = 0
    await expect.poll(() => {
      const at = minuteNow() / 1000
      const counted = secondPod('settle').status.containerStatuses?.[0]?.restartCount
      const restarts = promAt(restartsQuery(SECOND_WINDOW_S), at).find((s) => s.metric.pod === 'settle')
      const memory = promAt(memoryQuery(SECOND_WINDOW_S), at).find((s) => s.metric.pod === 'near' && s.metric.container === 'fill')
      const held = !!restarts && Math.round(Number(restarts.value[1])) === counted && !!memory && Number(memory.value[1]) >= 0.9
      if (held) end = at * 1000
      return held
    }, { timeout: 480_000, intervals: [15_000], message: 'the restarts counted as kubectl counts them and the memory peak in Prometheus at a whole minute' }).toBe(true)
    const start = end - SECOND_WINDOW_S * 1000

    const before = secondPods()
    const tool = await rank(request, admin, { cluster: SECOND, namespace: NS, since_time: stamp(start), until_time: stamp(end) })
    const route = await routeAnswer(request, admin, SECOND, NS, stamp(start), stamp(end))
    const issues = await issueTargets(request, admin, SECOND, NS, SECOND_WINDOW_S / 60)
    const memory = promAt(memoryQuery(SECOND_WINDOW_S), end / 1000).find((s) => s.metric.pod === 'near' && s.metric.container === 'fill')!
    expect(podState(secondPods()), 'the pods held still').toBe(podState(before))

    expect(tool.examples_note ?? tool.findings_note, 'the answer was not cut').toBeUndefined()
    expect(tool).toEqual(route)
    expect(tool.window).toEqual({ start: stamp(start), end: stamp(end) })
    eachCheckOnce(tool)

    // restarts: the pod that settled, as many as kubectl counts, none before the namespace was made
    const settled = before.find((p) => p.metadata.name === 'settle')!.status.containerStatuses![0].restartCount
    expect(settled).toBe(RESTARTS)
    expect(found(tool, 'restarts')).toEqual([expect.objectContaining({ target: 'Pod/settle', verdict: 'anomalous', new: true, now: settled })])
    expect(found(tool, 'restarts')[0].before, 'no series in the window before').toBeUndefined()
    expect(found(tool, 'restarts')[0].summary).toBe(`${settled} restarts in the window, no series in the window before`)

    // memory: the working set's peak over the limit, the value Prometheus gives the same query at the window's end
    expect(found(tool, 'memory_near_limit')).toEqual([expect.objectContaining({ target: 'Pod/near container fill', verdict: 'anomalous', new: true, now: round3(Number(memory.value[1])) })])
    expect(found(tool, 'memory_near_limit')[0].now).toBeGreaterThanOrEqual(0.9)
    expect(found(tool, 'memory_near_limit')[0].summary).toContain('of the memory limit, no series before')

    // terminations: the settled pod's last exit, as kubectl holds it
    const want = terminations(before, start, end)
    expect(want).toEqual({ Error: 1 })
    expect(found(tool, 'crash_reasons').map((f) => [f.target, f.now])).toEqual([['Error', 1]])
    expect(found(tool, 'crash_reasons')[0].examples).toEqual([expect.stringMatching(/^settle\/app exit 1 at /)])

    // failing now: the Dashboard's issues of the namespace (the pod restarted within the hour)
    expect(found(tool, 'issues').map((f) => f.target).sort()).toEqual(issues)
    expect(issues).toEqual(['Pod/settle'])

    // no container of the namespace has a CPU limit, so the throttling series are not there: not run, not normal
    expect(reasonOf(tool, 'cpu_throttling')).toBe(NO_SERIES)
  })

  test('a grant limited to the namespace is refused the Prometheus checks and keeps the namespace\'s own reads', async ({ request }) => {
    test.skip(!mcpOn, 'the MCP server is off (mcp.enabled)')
    test.skip(!switchOn, 'features.anomalyRank is off (on in deploy/kind/values.yaml)')
    test.skip(!secondReady, `cluster ${SECOND} (kind kubeast-b) does not read its Prometheus — scripts/add-kind-cluster.sh default --addons`)
    const scoped = await user(request, 'scoped', SECOND, { role: 'Read', namespaces: [NS] })
    // the grant's group reads the namespace's objects on the second cluster, as a team's binding would
    const binding = `e2e-anomaly-read-${id}`
    second!(`-n ${NS} create rolebinding ${binding} --clusterrole=view --group=${READ_GROUP}`)
    try {
      // half an hour and more reaches back past the namespace's making, so the settled pod's last exit is in it; each
      // try a window of its own while the new binding takes effect (the same window is answered from memory)
      let tries = 0
      await expect(async () => {
        const end = minuteNow()
        const start = end - (30 + tries++) * 60_000
        const before = secondPods()
        const tool = await rank(request, scoped, { cluster: SECOND, namespace: NS, since_time: stamp(start), until_time: stamp(end) })
        expect(podState(secondPods()), 'the pods held still').toBe(podState(before))
        expect(tool.namespace).toBe(NS)
        eachCheckOnce(tool)
        for (const check of METRIC_CHECKS) {
          expect(reasonOf(tool, check), check).toBe(LIMITED)
          expect(found(tool, check), check).toEqual([])
          expect(tool.normal).not.toContain(check)
        }
        // the namespace's pods are its own: the terminations are read as for the admin
        expect(found(tool, 'crash_reasons').map((f) => [f.target, f.now])).toEqual(Object.entries(terminations(before, start, end)).sort())
        expect(found(tool, 'crash_reasons').length).toBe(1)
      }).toPass({ timeout: 60_000, intervals: [5_000] })

      const elsewhere = await call(request, scoped, 'anomaly_rank', { cluster: SECOND, namespace: 'kube-system' })
      expect(elsewhere.isError, 'a namespace outside the grant').toBe(true)
      expect(elsewhere.text).toContain('outside your grant')
    } finally {
      second!(`-n ${NS} delete rolebinding ${binding} --ignore-not-found`)
    }
  })

  test('the tool is offered where the switch is on; off, the route answers 404 and reads nothing', async ({ request }) => {
    test.skip(!mcpOn, 'the MCP server is off (mcp.enabled)')
    const clusters = JSON.parse((await call(request, admin, 'list_clusters', {})).text).clusters as { id: string; tools: string[] }[]
    for (const cluster of [SELF, SECOND]) {
      const listed = clusters.find((c) => c.id === cluster)
      if (!listed) continue
      expect(listed.tools.includes('anomaly_rank'), `anomaly_rank offered on ${cluster}`).toBe(switchOn)
    }
    const res = await request.get('/api/v1/namespaces/default/anomalies', { headers: bearer(admin), params: { cluster: SELF }, failOnStatusCode: false })
    if (!switchOn) {
      expect(res.status()).toBe(404)
      expect((await res.json()).detail).toBe(OFF)
      const out = await call(request, admin, 'anomaly_rank', { cluster: SELF, namespace: 'default' })
      expect(out.isError, out.text).toBe(false)
      expect(JSON.parse(out.text)).toEqual({ status: 'unavailable', feature: 'anomaly_rank', reason: OFF, alternative: 'issues' })
      return
    }
    expect(res.status(), await res.text()).toBe(200)
    expect(((await res.json()) as Answer).namespace).toBe('default')
    // a window shorter than five minutes compares noise: refused
    const end = minuteNow()
    const short = await call(request, admin, 'anomaly_rank', { cluster: SELF, namespace: 'default', since_time: stamp(end - 240_000), until_time: stamp(end) })
    expect(short.isError, short.text).toBe(true)
    expect(short.text).toContain('the window is at least 5m0s')
  })
})
