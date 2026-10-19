import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// The AI's LogQL tools — loki_query, loki_labels, loki_patterns — driven through the MCP endpoint so the checks are
// exact, against the kind setup of scripts/kind-logsearch.sh (one Loki for both clusters, its pattern ingester on).
// A Job prints 60 error lines and 35 info lines (Loki lists a pattern only from 30 lines in the window). A Read user counts the errors with a
// metric query, reads the info lines with a log query and gets both shapes as patterns, always inside this cluster
// and namespace; a grant limited to one namespace cannot reach another; through Grafana's data source proxy the
// tools answer the same as on the direct path.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-loki-pass1!'
const CLUSTER = 'self'
const NS = 'default'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubectlFor(kindName: string) {
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-loki-')), 'kubeconfig')
  fs.writeFileSync(kcPath, execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' }), { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
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

type Series = { metric: Record<string, string>; points: { t: number; v: number }[] }
type Pattern = { pattern: string; count: number; first: string; last: string }

test.describe('AI LogQL tools', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)
  const id = Date.now().toString(36)
  const job = `e2e-loki-${id}`
  const marker = `${job}-m`
  const podSelector = `{k8s_pod_name=~"${job}-.*"}`
  const userIds: string[] = []
  let admin = ''
  let reader = ''
  let scoped = ''
  let ready = false

  async function user(request: APIRequestContext, name: string, grant: object): Promise<string> {
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-loki-${name}-${id}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E loki ${name}`, email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    userIds.push(userId)
    const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: grant })
    expect(put.ok(), await put.text()).toBeTruthy()
    return login(request, email, PW)
  }

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    if (!(config.ok() && (await config.json()).enabled)) return
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    if (!features.logSearch?.clusters?.includes(CLUSTER)) return
    const yaml = [
      'apiVersion: batch/v1',
      'kind: Job',
      `metadata: {name: ${job}, namespace: ${NS}}`,
      'spec:',
      '  backoffLimit: 0',
      '  template:',
      '    spec:',
      '      restartPolicy: Never',
      '      containers:',
      '        - name: say',
      '          image: docker.io/library/busybox:1.38.0',
      '          command: [sh, -c]',
      '          args:',
      '            - |',
      `              for i in $(seq 1 60); do echo "${marker} level=error msg=\\"db timeout\\" try=$i"; done`,
      `              for i in $(seq 1 35); do echo "${marker} level=info msg=served req=$i"; done`,
    ].join('\n')
    const create = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, { headers: bearer(admin), data: { yaml, namespace: NS } })
    expect(create.ok(), await create.text()).toBeTruthy()
    reader = await user(request, 'read', { role: 'Read' })
    scoped = await user(request, 'scoped', { role: 'Read', namespaces: [NS] })
    await expect.poll(async () => {
      const out = await call(request, reader, 'loki_query', { cluster: CLUSTER, namespace: NS, logql: `${podSelector} |= "${marker}"`, since: '15m' })
      return out.isError ? -1 : JSON.parse(out.text).returned
    }, { timeout: 120_000, intervals: [3000] }).toBe(95)
    ready = true
  })

  test.afterAll(async ({ request }) => {
    if (!admin) return
    await request.delete(`/api/v1/namespaces/${NS}/jobs/${job}?cluster=${CLUSTER}`, { headers: bearer(admin), failOnStatusCode: false })
    for (const u of userIds) await request.delete(`/api/v1/auth/admin/users/${u}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test.beforeEach(() => {
    test.skip(!ready, 'no MCP server or no log search for cluster self — scripts/kind-logsearch.sh up')
  })

  test('a Read user counts the errors with a metric query and reads lines with a log query, in this cluster and namespace', async ({ request }) => {
    const q = `sum by (k8s_container_name) (count_over_time(${podSelector} |= "${marker}" | logfmt | level="error" [30m]))`
    const metric = await tool(request, reader, 'loki_query', { cluster: CLUSTER, namespace: NS, logql: q, since: '20m' })
    expect(metric).toMatchObject({ kind: 'metric', range: true, series: 1 })
    const series = metric.results as Series[]
    expect(series[0].metric).toEqual({ k8s_container_name: 'say' })
    // a 30-minute window over every step after the Job ran holds all sixty error lines
    expect(Math.max(...series[0].points.map((p) => p.v))).toBe(60)
    expect(metric.effective_query).toBe(q.replace(podSelector, `{k8s_cluster_name="kubeast", k8s_namespace_name="${NS}", k8s_pod_name=~"${job}-.*"}`))

    const lines = await tool(request, reader, 'loki_query', { cluster: CLUSTER, namespace: NS, logql: `${podSelector} |= "${marker}" | logfmt | level="info"`, since: '20m' })
    expect(lines).toMatchObject({ kind: 'log', returned: 35 })
    expect((lines.lines as { line: string; namespace: string }[]).every((l) => l.line.includes('level=info') && l.namespace === NS)).toBe(true)

    // both reads are audited as LogQL with their kind; the rows carry the queries, never the lines
    type Row = { ActorEmail?: string; actor_email?: string; After?: Record<string, unknown>; after?: Record<string, unknown> }
    const rows = ((await (await request.get('/api/v1/auth/admin/audit-logs?action=k8s.pod.logs.logql&limit=20', { headers: bearer(admin) })).json()).items ?? []) as Row[]
    const row = rows.find((r) => (r.After ?? r.after)?.logql === q)
    expect(row, 'an audit row for the metric query').toBeTruthy()
    expect(row?.After ?? row?.after).toMatchObject({ kind: 'metric', series: 1, effective: metric.effective_query })
    expect(row?.ActorEmail ?? row?.actor_email).toContain(`e2e-loki-read-${id}`)
    expect(JSON.stringify(rows)).not.toContain('msg=served req=')
  })

  test('label lists hold only what this cluster and namespace have', async ({ request }) => {
    const names = await tool(request, reader, 'loki_labels', { cluster: CLUSTER, namespace: NS })
    expect(names.values).toEqual(expect.arrayContaining(['k8s_container_name', 'k8s_namespace_name', 'k8s_pod_name']))
    expect((names.values as string[]).some((v) => v.startsWith('__'))).toBe(false)
    const ns = await tool(request, reader, 'loki_labels', { cluster: CLUSTER, namespace: NS, label: 'k8s_namespace_name' })
    expect(ns.values).toEqual([NS])
    // the same Loki holds the second cluster's streams too; this cluster's list never shows them
    const clusters = await tool(request, admin, 'loki_labels', { cluster: CLUSTER, label: 'k8s_cluster_name' })
    expect(clusters.values).toEqual(['kubeast'])
    const pods = await tool(request, reader, 'loki_labels', { cluster: CLUSTER, namespace: NS, label: 'k8s_pod_name', since: '20m' })
    expect((pods.values as string[]).filter((p) => p.startsWith(`${job}-`))).toHaveLength(1)
  })

  test('patterns group the lines by shape, most lines first', async ({ request }) => {
    let patterns: Pattern[] = []
    await expect.poll(async () => {
      const out = await tool(request, reader, 'loki_patterns', { cluster: CLUSTER, namespace: NS, selector: podSelector, since: '20m' })
      expect(out.status, JSON.stringify(out)).not.toBe('unavailable')
      patterns = out.patterns
      return patterns.reduce((n, p) => n + p.count, 0)
    }, { timeout: 120_000, intervals: [5000] }).toBe(95)
    expect(patterns.map((p) => p.count)).toEqual([60, 35])
    expect(patterns[0].pattern).toContain('db timeout')
    expect(patterns[1].pattern).toContain('msg=served')
    expect(patterns[0].pattern).not.toContain('try=1 ')
  })

  test('a grant limited to one namespace stays in it', async ({ request }) => {
    const everywhere = await call(request, scoped, 'loki_query', { cluster: CLUSTER, logql: `${podSelector} |= "${marker}"` })
    expect(everywhere.isError).toBe(true)
    expect(everywhere.text).toContain('limited to namespaces')
    const elsewhere = await call(request, scoped, 'loki_labels', { cluster: CLUSTER, namespace: 'kube-system', label: 'k8s_pod_name' })
    expect(elsewhere.isError).toBe(true)
    expect(elsewhere.text).toContain('outside your grant')
    // Its own namespace: the cluster asks the grant's group, which auth.impersonation.customRoles with namespaces binds
    // there; the dev cluster binds none, so the test binds it for the call.
    const self = kubectlFor('kubeast')
    const binding = `e2e-loki-read-${id}`
    const refused = await tool(request, scoped, 'loki_query', { cluster: CLUSTER, namespace: NS, logql: `${podSelector} |= "${marker}"` })
    expect(refused.status, JSON.stringify(refused)).toBe('forbidden')
    self(`-n ${NS} create rolebinding ${binding} --clusterrole=view --group=kubeast:role:read`)
    try {
      const own = await tool(request, scoped, 'loki_query', { cluster: CLUSTER, namespace: NS, logql: `${podSelector} |= "${marker}" | logfmt | level="error"`, since: '20m' })
      expect(own.returned, JSON.stringify(own)).toBe(60)
      expect(own.effective_query).toContain(`k8s_namespace_name="${NS}"`)
    } finally {
      self(`-n ${NS} delete rolebinding ${binding} --ignore-not-found`)
    }
  })

  test("through Grafana's data source proxy the tools give the same answers", async ({ request }) => {
    const second = kubectlFor('kubeast-b')
    let token = ''
    try {
      token = Buffer.from(second('-n grafana get secret kubeast-reader -o jsonpath={.data.token}'), 'base64').toString()
      second('-n grafana rollout status deploy/grafana --timeout=5s')
    } catch {
      test.skip(true, 'no Grafana in the second kind cluster — run scripts/kind-grafana.sh up')
    }
    const OTHER = 'default'
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    test.skip(!features.logSearch?.clusters?.includes(OTHER), `log search is off for cluster ${OTHER}`)
    // A window that ended a minute ago: nothing more arrives in it, so both paths must answer the same.
    const end = new Date(Date.now() - 60_000)
    const window = { since_time: new Date(end.getTime() - 10 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z'), until_time: end.toISOString().replace(/\.\d+Z$/, 'Z') }
    const ask = async () => ({
      labels: (await tool(request, admin, 'loki_labels', { cluster: OTHER, namespace: 'kube-system', label: 'k8s_pod_name' })).values,
      metric: (await tool(request, admin, 'loki_query', { cluster: OTHER, namespace: 'kube-system', logql: 'sum by (k8s_container_name) (count_over_time({k8s_namespace_name="kube-system"}[5m]))', ...window })).results,
    })
    const direct = await ask()
    expect(direct.labels.length).toBeGreaterThan(0)
    expect(direct.metric.length).toBeGreaterThan(0)

    const nodeIP = second(`get node -o 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'`)
    const url = `http://${nodeIP}:31300/api/datasources/proxy/uid/loki`
    const cleared = { log_search_url: '', log_search_tenant: '', log_search_cluster_label: '', log_search_auth: { type: 'none' } }
    try {
      const res = await request.patch(`/api/v1/clusters/${OTHER}`, {
        headers: bearer(admin), data: { log_search_url: url, log_search_tenant: '', log_search_cluster_label: 'kubeast-b', log_search_auth: { type: 'bearer', token } },
      })
      expect(res.status(), await res.text()).toBe(200)
      const st = await (await request.get(`/api/v1/cluster/logsearch/status?cluster=${OTHER}`, { headers: bearer(admin) })).json()
      expect(st, JSON.stringify(st)).toMatchObject({ available: true, source: 'cluster', endpoint: url })
      const viaGrafana = await ask()
      expect(viaGrafana.labels).toEqual(direct.labels)
      expect(viaGrafana.metric).toEqual(direct.metric)
    } finally {
      await request.patch(`/api/v1/clusters/${OTHER}`, { headers: bearer(admin), data: cleared, failOnStatusCode: false })
    }
  })
})
