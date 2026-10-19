import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// The AI's trace tools — traces_search, traces_get, traces_tags, traces_metrics, traces_compare — driven through
// the MCP endpoint so the checks are exact, against the Tempo of scripts/kind-tracing.sh (one Tempo in the second
// cluster for both). A Job sends traces of one service: 6 to /cart (200ms) and 4 failing ones to /checkout (1.5s)
// in this cluster's namespace default, 2 in this cluster's kube-system and 3 as the other cluster. A Read user finds
// and opens them, counts them per route, compares fast and slow — always inside this cluster (and namespace);
// queries that read the root span or the parent are refused; Grafana's data source proxy serves the same Tempo
// paths the tools read.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-traces-pass1!'
const CLUSTER = 'self'
const NS = 'default'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const GEN = 'ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen:v0.162.0'

function kubectlFor(kindName: string) {
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-traces-')), 'kubeconfig')
  fs.writeFileSync(kcPath, execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' }), { mode: 0o600 })
  return (args: string, input?: string) =>
    execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
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
const tool = async (request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) => {
  const out = await call(request, token, name, args)
  expect(out.isError, out.text).toBe(false)
  return JSON.parse(out.text)
}

type Found = { traceId: string; spans: { spanId: string; durationMs: number }[] }

test.describe('AI trace tools', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)
  const id = Date.now().toString(36)
  const svc = `e2e-trace-${id}`
  const job = `e2e-traces-${id}`
  const userIds: string[] = []
  const self = kubectlFor('kubeast')
  let admin = ''
  let reader = ''
  let scoped = ''
  let ready = false

  async function user(request: APIRequestContext, name: string, grant: object): Promise<string> {
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-traces-${name}-${id}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E traces ${name}`, email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    userIds.push(userId)
    const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: grant })
    expect(put.ok(), await put.text()).toBeTruthy()
    return login(request, email, PW)
  }

  test.beforeAll(async ({ request }) => {
    test.setTimeout(300_000)
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    if (!(config.ok() && (await config.json()).enabled)) return
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    if (!features.traceStore?.clusters?.includes(CLUSTER)) return
    const gen = (name: string, args: string[]) => [
      `        - name: ${name}`, `          image: ${GEN}`, '          imagePullPolicy: IfNotPresent',
      `          args: [traces, --otlp-endpoint, "kubeast-b-control-plane:31318", --otlp-http, --otlp-insecure, --service, "${svc}", ${args.map((a) => JSON.stringify(a)).join(', ')}]`,
    ]
    const yaml = [
      'apiVersion: batch/v1', 'kind: Job', `metadata: {name: ${job}, namespace: ${NS}}`, 'spec:', '  backoffLimit: 0', '  template:', '    spec:',
      '      restartPolicy: Never', '      initContainers:',
      ...gen('cart', ['--traces', '6', '--span-duration', '200ms', '--otlp-attributes', 'k8s.cluster.name="kubeast"', '--otlp-attributes', `k8s.namespace.name="${NS}"`, '--telemetry-attributes', 'http.route="/cart"']),
      ...gen('checkout', ['--traces', '4', '--span-duration', '1500ms', '--status-code', 'Error', '--otlp-attributes', 'k8s.cluster.name="kubeast"', '--otlp-attributes', `k8s.namespace.name="${NS}"`, '--telemetry-attributes', 'http.route="/checkout"']),
      ...gen('other-ns', ['--traces', '2', '--otlp-attributes', 'k8s.cluster.name="kubeast"', '--otlp-attributes', 'k8s.namespace.name="kube-system"']),
      '      containers:',
      ...gen('other-cluster', ['--traces', '3', '--otlp-attributes', 'k8s.cluster.name="kubeast-b"', '--otlp-attributes', `k8s.namespace.name="${NS}"`]),
    ].join('\n')
    self(`-n ${NS} apply -f -`, yaml)
    self(`-n ${NS} wait --for=condition=complete job/${job} --timeout=120s`)
    reader = await user(request, 'read', { role: 'Read' })
    scoped = await user(request, 'scoped', { role: 'Read', namespaces: [NS] })
    // Tempo serves new spans to search some 25 s after they come and counts them in metrics a few seconds later:
    // wait for this cluster's twelve traces in both
    await expect.poll(async () => {
      const out = await call(request, admin, 'traces_search', { cluster: CLUSTER, traceql: `{ resource.service.name = "${svc}" }`, since: '15m' })
      return out.isError ? -1 : JSON.parse(out.text).returned
    }, { timeout: 150_000, intervals: [5000] }).toBe(12)
    await expect.poll(async () => {
      const out = await call(request, admin, 'traces_metrics', { cluster: CLUSTER, traceql: `{ resource.service.name = "${svc}" } | count_over_time()`, since: '15m' })
      return out.isError ? -1 : (JSON.parse(out.text).results as { points: { v: number }[] }[]).flatMap((s) => s.points).reduce((n, p) => n + p.v, 0)
    }, { timeout: 60_000, intervals: [3000] }).toBe(24)
    ready = true
  })

  test.afterAll(async ({ request }) => {
    try {
      self(`-n ${NS} delete job ${job} --ignore-not-found`)
    } catch { /* gone already */ }
    if (!admin) return
    for (const u of userIds) await request.delete(`/api/v1/auth/admin/users/${u}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test.beforeEach(() => {
    test.skip(!ready, 'no MCP server or no trace store for cluster self — scripts/kind-tracing.sh up')
  })

  test('a Read user finds the failing requests and opens one, in this cluster and namespace only', async ({ request }) => {
    const q = `{ resource.service.name = "${svc}" && status = error }`
    const found = await tool(request, reader, 'traces_search', { cluster: CLUSTER, namespace: NS, traceql: q, since: '15m' })
    expect(found.returned).toBe(4)
    const scope = `resource.k8s.cluster.name = "kubeast" && resource.k8s.namespace.name = "${NS}"`
    expect(found.effective_query).toBe(`{ ( resource.service.name = "${svc}" && status = error ) && ${scope} }`)
    expect(JSON.stringify(found)).not.toContain('rootServiceName')
    // Tempo's search leaves the leading zeros out of trace IDs: they come back whole
    for (const t of found.traces as Found[]) expect(t.traceId).toMatch(/^[0-9a-f]{32}$/)

    const opened = await tool(request, reader, 'traces_get', { cluster: CLUSTER, namespace: NS, trace_id: (found.traces as Found[])[0].traceId })
    expect(opened.shown).toBe(2) // telemetrygen: a server span and its child
    expect(opened.errors).toBe(2)
    for (const s of opened.spans as { service: string; namespace: string; durationMs: number; status: string }[]) {
      expect(s).toMatchObject({ service: svc, namespace: NS, status: 'ERROR' })
      expect(s.durationMs).toBeCloseTo(1500, 0)
    }

    type Row = { ActorEmail?: string; actor_email?: string; After?: Record<string, unknown>; after?: Record<string, unknown> }
    const rows = ((await (await request.get('/api/v1/auth/admin/audit-logs?action=k8s.traces.query&limit=20', { headers: bearer(admin) })).json()).items ?? []) as Row[]
    const kinds = rows.filter((r) => (r.ActorEmail ?? r.actor_email ?? '').includes(`e2e-traces-read-${id}`)).map((r) => (r.After ?? r.after)?.kind)
    expect(kinds).toEqual(expect.arrayContaining(['search', 'trace']))
    const searchRow = rows.find((r) => (r.After ?? r.after)?.traceql === q)
    expect(searchRow?.After ?? searchRow?.after).toMatchObject({ kind: 'search', traces: 4, effective: found.effective_query })
    expect(JSON.stringify(rows)).not.toContain('okey-dokey')
  })

  test("the other cluster's and namespace's traces stay out", async ({ request }) => {
    // every namespace (unscoped admin): this cluster's 12, never the other cluster's 3
    const all = await tool(request, admin, 'traces_search', { cluster: CLUSTER, traceql: `{ resource.service.name = "${svc}" }`, since: '15m' })
    expect(all.returned).toBe(12)
    const other = await tool(request, admin, 'traces_search', { cluster: CLUSTER, traceql: `{ resource.k8s.cluster.name = "kubeast-b" && resource.service.name = "${svc}" }`, since: '15m' })
    expect(other.returned).toBe(0)
    const values = await tool(request, admin, 'traces_tags', { cluster: CLUSTER, tag: 'resource.k8s.cluster.name', since: '15m' })
    expect(values.values).toEqual(['kubeast'])
    // the namespace default: not kube-system's two
    const inNS = await tool(request, reader, 'traces_search', { cluster: CLUSTER, namespace: NS, traceql: `{ resource.service.name = "${svc}" }`, since: '15m' })
    expect(inNS.returned).toBe(10)
    // a kube-system trace read by ID from the namespace default is not there
    const ks = await tool(request, admin, 'traces_search', { cluster: CLUSTER, namespace: 'kube-system', traceql: `{ resource.service.name = "${svc}" }`, since: '15m' })
    expect(ks.returned).toBe(2)
    const out = await call(request, reader, 'traces_get', { cluster: CLUSTER, namespace: NS, trace_id: (ks.traces as Found[])[0].traceId })
    expect(JSON.parse(out.text).status).toBe('not_found')
    // intrinsics that read outside the scope are not offered
    const names = await tool(request, reader, 'traces_tags', { cluster: CLUSTER, namespace: NS, scope: 'intrinsic', since: '15m' })
    expect(names.scopes.intrinsic).toEqual(expect.arrayContaining(['duration', 'status']))
    expect(names.scopes.intrinsic).not.toContain('rootServiceName')
    expect(names.scopes.intrinsic).not.toContain('trace:duration')
  })

  test('counts per route over time and compares fast and slow', async ({ request }) => {
    const m = await tool(request, reader, 'traces_metrics', { cluster: CLUSTER, namespace: NS, traceql: `{ resource.service.name = "${svc}" } | count_over_time() by (span.http.route)`, since: '15m' })
    const sum = (route: string) => (m.results as { metric: Record<string, string>; points: { v: number }[] }[])
      .filter((s) => s.metric['span.http.route'] === route).flatMap((s) => s.points).reduce((n, p) => n + p.v, 0)
    expect(m).toMatchObject({ kind: 'metric', range: true })
    expect(sum('/cart')).toBe(12) // 6 traces × 2 spans
    expect(sum('/checkout')).toBe(8)

    const c = await tool(request, reader, 'traces_compare', { cluster: CLUSTER, namespace: NS, traceql: `{ resource.service.name = "${svc}" }`, since: '15m' })
    expect(c.traces).toBe(10)
    expect(c.minMs).toBeCloseTo(200, 0)
    expect(c.maxMs).toBeCloseTo(1500, 0)
    expect(c.slowest[0].durationMs).toBeCloseTo(1500, 0)
  })

  test('queries that read outside the scope are refused, and a namespace grant stays in it', async ({ request }) => {
    for (const traceql of [`{ rootServiceName = "x" }`, `{ trace:duration > 1s }`, `{ parent.span.http.route = "/" }`]) {
      const out = await call(request, reader, 'traces_search', { cluster: CLUSTER, namespace: NS, traceql })
      expect(out.isError, traceql).toBe(true)
      expect(out.text).toContain('Filter on the spans themselves')
    }
    const everywhere = await call(request, scoped, 'traces_search', { cluster: CLUSTER, traceql: '{}' })
    expect(everywhere.isError).toBe(true)
    expect(everywhere.text).toContain('limited to namespaces')
    const elsewhere = await call(request, scoped, 'traces_search', { cluster: CLUSTER, namespace: 'kube-system', traceql: '{}' })
    expect(elsewhere.isError).toBe(true)
    expect(elsewhere.text).toContain('outside your grant')
    // its own namespace: the cluster asks the grant's group, which the dev cluster does not bind — bound for the call
    const binding = `e2e-traces-read-${id}`
    self(`-n ${NS} create rolebinding ${binding} --clusterrole=view --group=kubeast:role:read`)
    try {
      const own = await tool(request, scoped, 'traces_search', { cluster: CLUSTER, namespace: NS, traceql: `{ resource.service.name = "${svc}" && status = error }`, since: '15m' })
      expect(own.returned).toBe(4)
    } finally {
      self(`-n ${NS} delete rolebinding ${binding} --ignore-not-found`)
    }
  })

  test("Grafana's data source proxy serves the Tempo paths the tools read", async ({ request }) => {
    const second = kubectlFor('kubeast-b')
    let token = ''
    try {
      token = Buffer.from(second('-n grafana get secret kubeast-reader -o jsonpath={.data.token}'), 'base64').toString()
    } catch {
      test.skip(true, 'no Grafana in the second kind cluster — run scripts/kind-grafana.sh up')
    }
    // the laptop does not reach the kind network: ask from the second cluster's node, the token in the environment
    const viaGrafana = (p: string, params: Record<string, string>) => JSON.parse(execSync(
      `docker exec -e GRAFANA_TOKEN kubeast-b-control-plane sh -c 'curl -sf -G -H "Authorization: Bearer $GRAFANA_TOKEN" "$0" "$@"' http://127.0.0.1:31300/api/datasources/proxy/uid/tempo${p} ${Object.entries(params).map(([k, v]) => `--data-urlencode ${JSON.stringify(`${k}=${v}`)}`).join(' ')}`,
      { encoding: 'utf8', env: { ...process.env, GRAFANA_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] },
    ))
    try {
      viaGrafana('/api/status/buildinfo', {})
    } catch {
      test.skip(true, 'Grafana has no Tempo data source — re-apply deploy/kind/grafana.yaml and run scripts/kind-grafana.sh up')
    }
    const now = Math.floor(Date.now() / 1000)
    const window = { start: String(now - 900), end: String(now + 60) }
    const found = await tool(request, admin, 'traces_search', { cluster: CLUSTER, namespace: NS, traceql: `{ resource.service.name = "${svc}" && status = error }`, since: '15m' })
    const ids = (viaGrafana('/api/search', { q: found.effective_query, ...window }).traces as { traceID: string }[]).map((t) => t.traceID).sort()
    expect(ids).toEqual((found.traces as Found[]).map((t) => t.traceId).sort())

    const values = viaGrafana('/api/v2/search/tag/resource.service.name/values', { q: '{ resource.k8s.cluster.name = "kubeast" }', ...window })
    expect((values.tagValues as { value: string }[]).map((v) => v.value)).toContain(svc)

    const m = await tool(request, admin, 'traces_metrics', { cluster: CLUSTER, namespace: NS, traceql: `{ resource.service.name = "${svc}" && status = error } | count_over_time()`, since: '15m' })
    const series = viaGrafana('/api/metrics/query_range', { q: m.effective_query, ...window, step: `${m.step_seconds}s` }).series as { samples: { value?: number }[] }[]
    expect(series.flatMap((s) => s.samples).reduce((n, p) => n + (p.value ?? 0), 0)).toBe(8)
  })
})
