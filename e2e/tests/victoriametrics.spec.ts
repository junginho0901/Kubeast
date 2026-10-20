import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// VictoriaMetrics as a cluster's metrics store (scripts/kind-victoriametrics.sh: a single node and a cluster in the
// second kind cluster, scraping with that cluster's Prometheus config). Cluster `default` is pointed at each in turn —
// the single node as its Service, the cluster's vmselect as its Service with the tenant path, then as an external URL
// with the cluster label — and reads the same values as from its own Prometheus; the status names the store
// VictoriaMetrics; the AI's targets come from the targets API where the store scrapes and from `up` where it does not;
// its rules are "not served" (no -vmalert.proxyURL here) rather than "none". Each setting is put back.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'default'
const PROMETHEUS = 'monitoring/prometheus:9090 (via K8s API proxy)'
const SINGLE = 'monitoring/vmsingle-kubeast:8428'
const SELECT = 'monitoring/vmselect-kubeast:8481/select/0/prometheus'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubectlFor(kindName: string) {
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-vm-')), 'kubeconfig')
  fs.writeFileSync(kcPath, execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' }), { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectlSecond = kubectlFor('kubeast-b')

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function tool(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    failOnStatusCode: false,
  })
  expect(res.status(), `${name}: ${await res.text()}`).toBe(200)
  const result = (await res.json()).result
  return { isError: !!result.isError, text: result.content?.[0]?.text as string }
}

test.describe('VictoriaMetrics as the metrics store', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)
  let admin = ''
  let mcp = false
  let nodeIP = ''
  let memory = '' // sum(node_memory_MemTotal_bytes) from the cluster's own Prometheus

  const status = async (request: APIRequestContext) =>
    (await request.get(`/api/v1/cluster/prometheus/status?cluster=${CLUSTER}`, { headers: bearer(admin) })).json()
  const query = async (request: APIRequestContext, q: string) =>
    (await request.get(`/api/v1/cluster/prometheus/query?cluster=${CLUSTER}&query=${encodeURIComponent(q)}`, { headers: bearer(admin) })).json()
  const patch = async (request: APIRequestContext, body: object) => {
    const res = await request.patch(`/api/v1/clusters/${CLUSTER}`, { headers: bearer(admin), data: body, failOnStatusCode: false })
    expect(res.status(), await res.text()).toBe(200)
  }
  const memoryNow = async (request: APIRequestContext) => {
    // the store answers once it has scraped node-exporter (a single node starts empty)
    let value = ''
    await expect.poll(async () => {
      value = (await query(request, 'sum(node_memory_MemTotal_bytes)')).results?.[0]?.value ?? ''
      return value
    }, { timeout: 90_000 }).not.toBe('')
    return value
  }

  test.beforeAll(async ({ request }) => {
    admin = await login(request)
    try {
      kubectlSecond('-n monitoring get service vmsingle-kubeast vmselect-kubeast')
    } catch {
      test.skip(true, 'no VictoriaMetrics in the second cluster — scripts/kind-victoriametrics.sh up')
    }
    const st = await status(request)
    test.skip(st.source !== 'proxy' || st.endpoint !== PROMETHEUS, `cluster ${CLUSTER} does not read ${PROMETHEUS} (${JSON.stringify(st)})`)
    expect(st.flavor).toBe('prometheus')
    memory = await memoryNow(request)
    mcp = !!(await (await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })).json()).enabled
    nodeIP = kubectlSecond(`get node -o 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'`)
  })

  test.afterAll(async ({ request }) => {
    if (!admin) return
    await request.patch(`/api/v1/clusters/${CLUSTER}`, {
      headers: bearer(admin), data: { prometheus_service: '', prometheus_url: '', prometheus_cluster_label: '', prometheus_auth: { type: 'none' } }, failOnStatusCode: false,
    })
  })

  test('a single node named as the Service reads the same values; its targets come from its own scraping', async ({ request }) => {
    await patch(request, { prometheus_service: SINGLE })
    const st = await status(request)
    expect(st).toMatchObject({ available: true, source: 'proxy', configured: true, flavor: 'victoriametrics', endpoint: `${SINGLE} (via K8s API proxy)` })
    expect(await memoryNow(request)).toBe(memory)
    test.skip(!mcp, 'the MCP server is off')
    const targets = JSON.parse((await tool(request, admin, 'prometheus_targets', { cluster: CLUSTER })).text)
    expect(targets.source).toBe('targets_api')
    expect(targets.targets.map((t: { job: string }) => t.job)).toContain('node-exporter')
    const rules = await tool(request, admin, 'prometheus_rules', { cluster: CLUSTER })
    expect(rules.text).toContain('vmalert') // not served here, said as such — not "no rules"
  })

  test("a cluster's vmselect named with its tenant path: same values, targets from `up`", async ({ request }) => {
    const bad = await request.patch(`/api/v1/clusters/${CLUSTER}`, { headers: bearer(admin), data: { prometheus_service: `${SELECT}/../x` }, failOnStatusCode: false })
    expect(bad.status()).toBe(400)
    await patch(request, { prometheus_service: SELECT })
    const st = await status(request)
    expect(st).toMatchObject({ available: true, flavor: 'victoriametrics', endpoint: `${SELECT} (via K8s API proxy)` })
    expect(await memoryNow(request)).toBe(memory)
    test.skip(!mcp, 'the MCP server is off')
    const targets = JSON.parse((await tool(request, admin, 'prometheus_targets', { cluster: CLUSTER })).text)
    expect(targets.source).toBe('up_metric') // vmselect has no targets API (400 unsupported path)
    expect(targets.targets.some((t: { job: string; health: string }) => t.job === 'node-exporter' && t.health === 'up')).toBe(true)
  })

  test('the vmselect as an external URL with the cluster label scopes every query', async ({ request }) => {
    await patch(request, { prometheus_service: '', prometheus_url: `http://${nodeIP}:30481/select/0/prometheus`, prometheus_cluster_label: 'kubeast-b', prometheus_auth: { type: 'none' } })
    const st = await status(request)
    expect(st).toMatchObject({ available: true, source: 'external', flavor: 'victoriametrics', cluster_label: 'kubeast-b' })
    expect(await memoryNow(request)).toBe(memory)
    const up = await query(request, 'up')
    expect(up.results.length).toBeGreaterThan(0)
    for (const r of up.results) expect(r.metric.cluster).toBe('kubeast-b')
    // MetricsQL-only syntax cannot be scoped: refused as a bad query, not a server error
    const metricsql = await request.get(`/api/v1/cluster/prometheus/query?cluster=${CLUSTER}&query=${encodeURIComponent('rate(up)')}`, { headers: bearer(admin), failOnStatusCode: false })
    expect(metricsql.status()).toBe(400)
    await patch(request, { prometheus_cluster_label: 'no-such-cluster' })
    expect((await query(request, 'up')).results).toEqual([])
  })
})
