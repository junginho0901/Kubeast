import { execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// The AI tool resource_graph with include ["calls"] through the MCP endpoint, so the checks are exact, against the
// service graph metrics Tempo's metrics-generator writes into the second cluster's Prometheus (scripts/kind-tracing.sh
// up; deploy/kind/tracing-tempo.yaml). In a namespace of this run on the second cluster (Kubeast id default) two
// Deployments, cg-front and cg-back, stand for two services; OTLP spans sent into Tempo from that cluster's node make
// the calls cg-gate → cg-front → cg-back (cg-gate is a service no workload is named after), some of them failing at
// both callees. Over a fixed window the edges are the route's answer and the same increase asked of that Prometheus at
// the window's end, the failing callee that calls nothing failing comes first among the suspects and starts the path to
// its caller, and a grant limited to the namespace gets no trace part.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-callgraph-pass1!'
const SECOND = 'default'
const NODE = 'kubeast-b-control-plane'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const IMAGE = 'busybox:1.37'
const READ_GROUP = 'kubeast:role:read'
const GATE = 'cg-gate'
const FRONT = 'cg-front'
const BACK = 'cg-back'
// the first batch makes the series (a counter's first sample is where increase starts), the second is counted
const WARM = { ok: 1, failing: 1 }
const MAIN = { ok: 4, failing: 6 }
const WINDOW_S = 900

type End = { id?: string; namespace?: string; kind?: string; name?: string; service?: string; matched_by?: string }
type Edge = { from: End; to: End; sources: string[]; requests?: number; errors?: number; error_ratio?: number; p90_ms?: number }
type Source = { source: string; read: boolean; reason?: string; detail?: string; series?: number }
type Suspect = { id: string; signals: string[]; failing_callees?: string[]; failing_callers?: string[]; failing_outside?: string[] }
type Calls = {
  available: boolean; reason?: string; range?: string; window?: { start: string; end: string }; sources: Source[]
  paths: string[][]; no_start?: string; suspects: Suspect[]; suspects_total?: number; edges_total: number; edges: Edge[]
}
type Sample = { metric: Record<string, string>; value: [number, string] }

function kubectlFor(kindName: string): ((args: string, input?: string) => string) | null {
  try {
    const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-callgraph-')), 'kubeconfig')
    fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
    return (args: string, input?: string) =>
      execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function call(request: APIRequestContext, token: string, args: Record<string, unknown>) {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'resource_graph', arguments: { cluster: SECOND, ...args } } },
    failOnStatusCode: false,
  })
  expect(res.status(), await res.text()).toBe(200)
  const result = (await res.json()).result
  return { isError: !!result.isError, text: result.content?.[0]?.text as string }
}
async function graph(request: APIRequestContext, token: string, args: Record<string, unknown>): Promise<{ calls: Calls; calls_note?: string }> {
  const out = await call(request, token, args)
  expect(out.isError, out.text).toBe(false)
  return JSON.parse(out.text)
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')
const nanos = (ms: number) => `${Math.round(ms)}000000`
const hex = (bytes: number) => crypto.randomBytes(bytes).toString('hex')
const attr = (key: string, value: string) => ({ key, value: { stringValue: value } })

test.describe('AI tool resource_graph: who calls whom', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)
  const id = Date.now().toString(36)
  const NS = `e2e-callgraph-${id}`
  const box = (name: string) => `Deployment/${NS}/${name}`
  const placed = (name: string): End => ({ id: box(name), namespace: NS, kind: 'Deployment', name, matched_by: 'workload_name' })
  const second = kubectlFor('kubeast-b')
  const userIds: string[] = []
  let admin = ''
  let why = ''
  let start = 0
  let end = 0

  // the second cluster's Prometheus, read directly through its API server (the kind admin), at a time or now
  const promAt = (expr: string, atSeconds?: number): Sample[] => JSON.parse(second!(
    `get --raw "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query?query=${encodeURIComponent(expr)}${atSeconds ? `&time=${atSeconds}` : ''}"`,
  )).data.result
  const pair = (client: string, server: string) =>
    `client="${client}",server="${server}",client_k8s_namespace_name="${NS}",server_k8s_namespace_name="${NS}"`
  const counter = (metric: string, client: string, server: string) => {
    const r = promAt(`sum(${metric}{${pair(client, server)}})`)
    return r.length ? Number(r[0].value[1]) : -1
  }
  // what the tool's queries give one edge at the window's end: the increase of requests and failures, the servers' p90
  const increaseAtEnd = (metric: string, client: string, server: string) => {
    const r = promAt(`sum(increase(${metric}{${pair(client, server)}}[${WINDOW_S}s]))`, end / 1000)
    expect(r.length, `${metric} ${client} → ${server} at the window's end`).toBe(1)
    return Number(r[0].value[1])
  }
  const p90AtEnd = (client: string, server: string) => {
    const r = promAt(`histogram_quantile(0.9, sum by (le) (rate(traces_service_graph_request_server_seconds_bucket{${pair(client, server)}}[${WINDOW_S}s])))`, end / 1000)
    return r.length ? Number(r[0].value[1]) : NaN
  }

  // OTLP/JSON spans of `ok + failing` traces cg-gate → cg-front → cg-back, each service a resource of its own with
  // the namespace and the cluster; a failing trace has both callees' server spans in error. Ends within the last
  // second: the metrics-generator drops spans that ended more than 30 s before they came.
  function traces(ok: number, failing: number) {
    const now = Date.now()
    const spans: Record<string, object[]> = { [GATE]: [], [FRONT]: [], [BACK]: [] }
    for (let i = 0; i < ok + failing; i++) {
      const status = i >= ok ? { status: { code: 2, message: 'e2e failure' } } : {}
      const traceId = hex(16)
      const [gateClient, frontServer, frontClient, backServer] = [hex(8), hex(8), hex(8), hex(8)]
      const span = (spanId: string, parentSpanId: string, name: string, kind: number, from: number, to: number, extra: object = {}) => ({
        traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}), name, kind, startTimeUnixNano: nanos(now - from), endTimeUnixNano: nanos(now - to), ...extra,
      })
      spans[GATE].push(span(gateClient, '', 'GET /front', 3, 2000, 500))
      spans[FRONT].push(span(frontServer, gateClient, 'GET /front', 2, 1900, 600, status))
      spans[FRONT].push(span(frontClient, frontServer, 'GET /back', 3, 1800, 700))
      spans[BACK].push(span(backServer, frontClient, 'GET /back', 2, 1700, 800, status))
    }
    return {
      resourceSpans: Object.entries(spans).map(([service, list]) => ({
        resource: { attributes: [attr('service.name', service), attr('k8s.namespace.name', NS), attr('k8s.cluster.name', 'kubeast-b')] },
        scopeSpans: [{ scope: { name: 'e2e-call-graph' }, spans: list }],
      })),
    }
  }
  // the laptop does not reach the kind network: posted from the second cluster's node to Tempo's OTLP/HTTP NodePort
  const send = (body: object) => execSync(
    `docker exec -i ${NODE} curl -sf -X POST -H 'Content-Type: application/json' --data-binary @- http://${NODE}:31318/v1/traces`,
    { input: JSON.stringify(body), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const counts = () => [
    counter('traces_service_graph_request_total', GATE, FRONT), counter('traces_service_graph_request_failed_total', GATE, FRONT),
    counter('traces_service_graph_request_total', FRONT, BACK), counter('traces_service_graph_request_failed_total', FRONT, BACK),
  ]

  async function user(request: APIRequestContext, name: string, grant: object): Promise<string> {
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-callgraph-${name}-${id}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E call graph ${name}`, email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    userIds.push(userId)
    const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${SECOND}`, { headers: bearer(admin), data: grant })
    expect(put.ok(), await put.text()).toBeTruthy()
    return login(request, email, PW)
  }

  test.beforeAll(async ({ request }) => {
    test.setTimeout(360_000)
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    if (!(config.ok() && (await config.json()).enabled)) {
      why = 'the MCP server is off (mcp.enabled)'
      return
    }
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    if (features.callGraph?.enabled !== true) {
      why = 'features.callGraph is off — scripts/kind-tracing.sh up turns it on (deploy/kind/tracing-values.yaml)'
      return
    }
    if (!second) {
      why = 'no kind cluster kubeast-b — scripts/add-kind-cluster.sh default --addons'
      return
    }
    const status = await (await request.get(`/api/v1/cluster/prometheus/status?cluster=${SECOND}`, { headers: bearer(admin) })).json()
    if (!status.available) {
      why = `cluster ${SECOND} reads no Prometheus (${JSON.stringify(status)})`
      return
    }
    let tempo = ''
    try {
      tempo = JSON.parse(second('-n tempo get configmap tempo -o json')).data['tempo.yaml'] ?? ''
    } catch { /* no Tempo */ }
    if (!tempo.includes('service-graphs') || !tempo.includes('enable_client_server_prefix: true')) {
      why = 'Tempo in kubeast-b writes no service graph metrics with the namespace — scripts/kind-tracing.sh up (deploy/kind/tracing-tempo.yaml)'
      return
    }

    second('apply -f -', [
      `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${NS}}`,
      ...[FRONT, BACK].map((name) => JSON.stringify({
        apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: NS },
        spec: {
          replicas: 1, selector: { matchLabels: { app: name } },
          template: { metadata: { labels: { app: name } }, spec: { terminationGracePeriodSeconds: 0, containers: [{ name: 'app', image: IMAGE, imagePullPolicy: 'IfNotPresent', command: ['sleep', '86400'] }] } },
        },
      })),
    ].join('\n---\n'))
    for (const name of [FRONT, BACK]) second(`-n ${NS} rollout status deployment/${name} --timeout=120s`)

    // the series first, then the counted batch; Tempo pairs each client span with its callee's server span, and its
    // registry writes every 15 s
    send(traces(WARM.ok, WARM.failing))
    const warm = WARM.ok + WARM.failing
    await expect.poll(counts, { timeout: 120_000, intervals: [5_000], message: 'the first batch in the second cluster\'s Prometheus' })
      .toEqual([warm, WARM.failing, warm, WARM.failing])
    send(traces(MAIN.ok, MAIN.failing))
    const all = warm + MAIN.ok + MAIN.failing
    const failed = WARM.failing + MAIN.failing
    await expect.poll(counts, { timeout: 120_000, intervals: [5_000], message: 'both batches in the second cluster\'s Prometheus' })
      .toEqual([all, failed, all, failed])
    end = Math.floor(Date.now() / 1000) * 1000
    start = end - WINDOW_S * 1000
  })

  test.afterAll(async ({ request }) => {
    for (const u of userIds) await request.delete(`/api/v1/auth/admin/users/${u}`, { headers: bearer(admin), failOnStatusCode: false })
    try {
      second?.(`delete namespace/${NS} --wait=false --ignore-not-found`)
    } catch { /* gone already */ }
  })

  test.beforeEach(() => {
    test.skip(!!why, why)
  })

  test('the calls between the workloads are what the cluster\'s Prometheus counts over the window, as the route answers', async ({ request }) => {
    const { calls, calls_note } = await graph(request, admin, { namespace: NS, include: ['calls'], since_time: stamp(start), until_time: stamp(end) })
    const res = await request.get(`/api/v1/namespaces/${NS}/resource-graph`, {
      headers: bearer(admin), params: { cluster: SECOND, group_pods: '1', include: 'calls', start: stamp(start), end: stamp(end) },
    })
    expect(res.ok(), await res.text()).toBeTruthy()
    expect(calls).toEqual((await res.json()).calls)
    expect(calls_note).toContain('who calls whom')

    expect(calls).toMatchObject({ available: true, range: `${WINDOW_S / 60}m0s`, window: { start: stamp(start), end: stamp(end) } })
    const traceSource = calls.sources.find((s) => s.source === 'traces')
    expect(traceSource).toMatchObject({ source: 'traces', read: true })
    expect(traceSource?.detail, 'the metric names the namespace on both sides').toBeUndefined()
    expect(calls.sources.find((s) => s.source === 'network')?.read, 'no Hubble metrics on this cluster').toBe(false)

    const key = (e: Edge) => `${e.from.id ?? `service ${e.from.service}`} → ${e.to.id ?? `service ${e.to.service}`}`
    const traced = calls.edges.filter((e) => e.sources.includes('traces'))
    expect(traced.map(key).sort()).toEqual([`${box(FRONT)} → ${box(BACK)}`, `service ${GATE} → ${box(FRONT)}`].sort())
    expect(traceSource?.series).toBe(traced.length)

    for (const [client, server, from, to] of [[GATE, FRONT, { namespace: NS, service: GATE }, placed(FRONT)], [FRONT, BACK, placed(FRONT), placed(BACK)]] as const) {
      const edge = traced.find((e) => e.to.id === box(server) && (e.from.id ?? e.from.service) === (client === GATE ? GATE : box(client)))!
      const requests = Math.round(increaseAtEnd('traces_service_graph_request_total', client, server))
      const errors = Math.round(increaseAtEnd('traces_service_graph_request_failed_total', client, server))
      const p90 = p90AtEnd(client, server)
      expect(edge, `${client} → ${server}`).toEqual({
        from, to, sources: ['traces'], requests, errors, error_ratio: Math.round((errors / requests) * 1000) / 1000,
        ...(Number.isFinite(p90) ? { p90_ms: Math.round(p90 * 1000 * 10) / 10 } : {}),
      })
      // the counted batch is in the window whole
      expect(requests, `${client} → ${server} requests`).toBeGreaterThanOrEqual(MAIN.ok + MAIN.failing)
      expect(errors, `${client} → ${server} errors`).toBeGreaterThanOrEqual(MAIN.failing)
    }
  })

  test('the failing callee comes first among the suspects and starts the path to its failing caller', async ({ request }) => {
    const { calls } = await graph(request, admin, { namespace: NS, include: ['calls'], since_time: stamp(start), until_time: stamp(end) })
    // cg-back calls nothing failing: where the failure may start; cg-front fails too and calls it, so it comes after
    // and the path runs from cg-back to cg-front; cg-gate fits no workload and is no suspect
    expect(calls.suspects.map((s) => s.id)).toEqual([box(BACK), box(FRONT)])
    expect(calls.suspects[0]).toMatchObject({ id: box(BACK), signals: ['calls_fail'], failing_callers: [box(FRONT)] })
    expect(calls.suspects[0].failing_callees).toBeUndefined()
    expect(calls.suspects[1]).toMatchObject({ id: box(FRONT), signals: ['calls_fail'], failing_callees: [box(BACK)] })
    expect(calls.suspects[1].failing_callers, 'its caller is no box of the graph').toBeUndefined()
    for (const s of calls.suspects) expect(s.failing_outside, s.id).toBeUndefined()
    expect(calls.suspects_total).toBe(2)
    expect(calls.paths).toEqual([[box(BACK), box(FRONT)]])
    expect(calls.no_start).toBeUndefined()
  })

  test('a grant limited to the namespace gets no trace part, and a namespace outside it is refused', async ({ request }) => {
    const scoped = await user(request, 'scoped', { role: 'Read', namespaces: [NS] })
    // the grant's group reads the namespace's objects on the second cluster, as a team's binding would
    const binding = `e2e-callgraph-read-${id}`
    second!(`-n ${NS} create rolebinding ${binding} --clusterrole=view --group=${READ_GROUP}`)
    try {
      await expect(async () => {
        const { calls } = await graph(request, scoped, { namespace: NS, include: ['calls'], since_time: stamp(start), until_time: stamp(end) })
        expect(calls.sources.find((s) => s.source === 'traces')).toEqual({ source: 'traces', read: false, reason: 'namespace_limited' })
        expect(calls.edges.filter((e) => e.sources.includes('traces'))).toEqual([])
        expect(calls.suspects).toEqual([])
        expect(calls.paths).toEqual([])
      }).toPass({ timeout: 60_000, intervals: [5_000] })
      const elsewhere = await call(request, scoped, { namespace: 'kube-system', include: ['calls'] })
      expect(elsewhere.isError, 'a namespace outside the grant').toBe(true)
      expect(elsewhere.text).toContain('outside your grant')
    } finally {
      second!(`-n ${NS} delete rolebinding ${binding} --ignore-not-found`)
    }
  })

  test('since reads back from now, and a window past a day is refused', async ({ request }) => {
    const { calls } = await graph(request, admin, { namespace: NS, include: ['calls'], since: '15m' })
    expect(calls.range).toBe('15m0s')
    expect(calls.window, 'no fixed window').toBeUndefined()
    const edge = calls.edges.find((e) => e.from.id === box(FRONT) && e.to.id === box(BACK))
    expect(edge?.sources).toEqual(['traces'])
    expect(edge?.errors ?? 0).toBeGreaterThanOrEqual(MAIN.failing)

    const long = await call(request, admin, { namespace: NS, include: ['calls'], since_time: stamp(end - 25 * 3600_000), until_time: stamp(end) })
    expect(long.isError, long.text).toBe(true)
    expect(long.text).toContain('between 1m and 24h')
  })
})
