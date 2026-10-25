import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'

// The Resource Graph's traffic lines on the Cilium kind cluster that scripts/kind-cilium.sh up registers
// (kubeast-cilium: the traffic of deploy/kind/cilium-demo.yaml — client reaches web on port 80, stranger is dropped
// by the NetworkPolicy web-only-client — and the Hubble drop and TCP metrics of deploy/kind/cilium-values.yaml in
// the Prometheus of deploy/kind/cilium-prometheus.yaml). The lines from the Relay and from the metrics as the
// cluster has them, read as a Read user, with the audit row of the Relay read; a namespace-limited user kept to
// their namespaces; the switch, the lines and a dropped line's "Why?" on screen. Skips without that cluster.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-traffic-pass1!'
const CLUSTER = process.env.E2E_CILIUM_CLUSTER || 'kubeast-cilium'
const NS = 'flows-demo'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function ciliumKubectl(): ((args: string) => string) | null {
  try {
    const kubeconfig = execSync(`kind get kubeconfig --name ${CLUSTER}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-traffic-')), 'kubeconfig')
    fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
    return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

type End = { namespace?: string; kind?: string; name?: string; outside?: string }
type Line = { from: End; to: End; allowed: number; dropped: number; ports?: { protocol?: string; port?: number }[]; reasons?: { reason: string; count: number }[] }
const endText = (e: End) => (e.namespace && e.name ? `${e.namespace}/${e.name}` : e.namespace || e.outside || 'unknown')
const key = (l: Line) => `${endText(l.from)} → ${endText(l.to)}`

test.describe('Resource Graph traffic lines (Hubble)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)
  const id = Date.now().toString(36)
  const userIds: string[] = []
  let admin = ''
  let relayReady = false
  let metricsReady = false
  let kubectl: ((args: string) => string) | null = null

  // what the cluster's Prometheus says, read directly through its API server (the kind admin)
  function promDirect(expr: string): { metric: Record<string, string>; value: [number, string] }[] {
    const q = encodeURIComponent(expr)
    return JSON.parse(kubectl!(`get --raw "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query?query=${q}"`)).data.result
  }

  async function user(request: APIRequestContext, name: string, grant: object): Promise<{ email: string; token: string }> {
    const roles = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(roles) ? roles : roles.roles || roles.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-traffic-${name}-${id}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E traffic ${name}`, email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    userIds.push((await created.json()).id)
    const put = await request.put(`/api/v1/auth/admin/users/${userIds[userIds.length - 1]}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: grant })
    expect(put.ok(), await put.text()).toBeTruthy()
    return { email, token: await login(request, email, PW) }
  }

  async function traffic(request: APIRequestContext, token: string, params: Record<string, string>, cluster = CLUSTER) {
    const res = await request.get('/api/v1/cluster/networktraffic', { headers: bearer(token), params: { cluster, namespaces: NS, ...params }, failOnStatusCode: false })
    return { status: res.status(), body: await res.json() }
  }

  async function auditRows(request: APIRequestContext, email: string) {
    const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: bearer(admin), params: { action: 'k8s.networkflows.query', actor_email: email, limit: 20 } })
    return ((await res.json()).items ?? []) as { TargetType: string; TargetID: string; Namespace: string; Result: string; After: Record<string, unknown> }[]
  }

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const features = await (await request.get(`/api/v1/cluster/features?cluster=${CLUSTER}`, { headers: bearer(admin) })).json()
    kubectl = ciliumKubectl()
    if (!kubectl) return
    relayReady = features?.networkFlows?.enabled === true && (features.networkFlows.clusters ?? []).includes(CLUSTER)
    try {
      metricsReady = promDirect(`sum(hubble_tcp_flags_total{flag="SYN",destination_namespace="${NS}"})`).length > 0
    } catch {
      metricsReady = false
    }
  })

  test.afterAll(async ({ request }) => {
    for (const u of userIds) await request.delete(`/api/v1/auth/admin/users/${u}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test('a Read user’s lines from the Relay are the demo’s connections, recorded once in the audit log', async ({ request }) => {
    test.skip(!relayReady, `no network flows for cluster ${CLUSTER} (scripts/kind-cilium.sh up)`)
    const reader = await user(request, 'read', { role: 'Read' })
    const { status, body } = await traffic(request, reader.token, { source: 'relay' })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({ available: true, source: 'relay', since: '15m0s', namespaces: [NS] })
    expect(body.flows).toBeGreaterThan(0)
    expect(body.flows).toBeLessThanOrEqual(2000)
    const lines = body.lines as Line[]
    const byKey = new Map(lines.map((l) => [key(l), l]))
    // client reaches web on port 80, as the policy allows
    const allowed = byKey.get(`${NS}/client → ${NS}/web`)
    expect(allowed, [...byKey.keys()].join('; ')).toMatchObject({ from: { kind: 'Deployment' }, to: { kind: 'Deployment' }, dropped: 0 })
    expect(allowed!.allowed).toBeGreaterThan(0)
    expect(allowed!.ports).toEqual([{ protocol: 'TCP', port: 80, allowed: allowed!.allowed, dropped: 0 }])
    // stranger's connections leave it (FORWARDED at its egress) and are dropped at web: a dropped line, not a mixed one
    const dropped = byKey.get(`${NS}/stranger → ${NS}/web`)
    expect(dropped).toMatchObject({ allowed: 0, reasons: [expect.objectContaining({ reason: 'POLICY_DENIED' })] })
    expect(dropped!.dropped).toBeGreaterThan(0)
    // the lookups of web's name reach the cluster DNS in kube-system, which the graph of flows-demo does not show
    const dnsName = kubectl!('-n kube-system get deploy -l k8s-app=kube-dns -o jsonpath={.items[0].metadata.name}')
    expect(byKey.get(`${NS}/client → kube-system/${dnsName}`)?.ports).toMatchObject([{ protocol: 'UDP', port: 53 }])
    // every workload a line names is one the cluster runs
    const workloads = new Set([NS, 'kube-system'].flatMap((ns) => kubectl!(`-n ${ns} get deploy,ds,sts -o name`).split('\n').map((n) => `${ns}/${n.split('/')[1]}`)))
    for (const l of lines) {
      for (const e of [l.from, l.to]) if (e.namespace && e.name) expect(workloads, endText(e)).toContain(endText(e))
    }
    // one read, one row: the namespaces and the counts, no flow contents
    const rows = await auditRows(request, reader.email)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ TargetType: 'namespaces', TargetID: NS, Namespace: NS, Result: 'success', After: { graph: true, namespaces: [NS], limit: 2000, flows: body.flows } })
    expect(JSON.stringify(rows[0].After)).not.toContain('stranger')
  })

  test('the metric lines are what the cluster’s Prometheus counts', async ({ request }) => {
    test.skip(!metricsReady, `no Hubble TCP metric on cluster ${CLUSTER} (scripts/kind-cilium.sh up)`)
    const reader = await user(request, 'metrics', { role: 'Read' })
    const { status, body } = await traffic(request, reader.token, { source: 'metrics', range: '1h' })
    expect(status, JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({ available: true, source: 'metrics', style: 'labels', range: '1h0m0s' })
    expect(body.notes ?? []).toEqual([])
    const byKey = new Map((body.lines as Line[]).map((l) => [key(l), l]))
    // connections counted where they arrived: the SYNs seen at web's ingress
    const syn = promDirect(`sum(increase(hubble_tcp_flags_total{flag="SYN",source_namespace="${NS}",source_workload="client",destination_workload="web",traffic_direction="ingress"}[3600s]))`)
    const opened = Math.round(Number(syn[0].value[1]))
    const allowed = byKey.get(`${NS}/client → ${NS}/web`)!
    expect(allowed.dropped).toBe(0)
    expect(Math.abs(allowed.allowed - opened), `Kubeast ${allowed.allowed}, Prometheus ${opened}`).toBeLessThanOrEqual(Math.max(20, opened / 10))
    const drops = promDirect(`sum(increase(hubble_drop_total{source_namespace="${NS}",source_workload="stranger",destination_workload="web",reason="POLICY_DENIED"}[3600s]))`)
    const dropped = byKey.get(`${NS}/stranger → ${NS}/web`)!
    expect(dropped.allowed).toBe(0)
    expect(Math.abs(dropped.dropped - Math.round(Number(drops[0].value[1]))), `drops ${dropped.dropped}`).toBeLessThanOrEqual(Math.max(60, dropped.dropped / 10))
    // UDP has no SYN: the DNS lookups are not a metric line
    expect([...byKey.keys()].filter((k) => k.includes('kube-system'))).toEqual([])
    // the second cluster's Prometheus has no Hubble metric (the reader has no grant there; the admin asks)
    expect((await traffic(request, admin, { source: 'metrics', namespaces: 'kube-system' }, 'default')).body).toMatchObject({ available: false, reason: 'no_metrics', lines: [] })
  })

  test('a namespace-limited user is kept to their namespaces, and the cluster decides the rest', async ({ request }) => {
    test.skip(!relayReady, `no network flows for cluster ${CLUSTER} (scripts/kind-cilium.sh up)`)
    const scoped = await user(request, 'scoped', { role: 'Read', namespaces: [NS] })
    // a namespace outside the grant: refused by Kubeast before any read, nothing recorded
    const outside = await traffic(request, scoped.token, { source: 'relay', namespaces: `${NS},kube-system` })
    expect(outside.status).toBe(403)
    expect(JSON.stringify(outside.body)).toContain('kube-system is outside your grant')
    expect(await auditRows(request, scoped.email)).toEqual([])
    // its own namespace: the cluster does not bind the Relay Role to namespace-limited grants — refused and recorded
    const own = await traffic(request, scoped.token, { source: 'relay' })
    expect(own.status, JSON.stringify(own.body)).toBe(403)
    expect(JSON.stringify(own.body)).toContain('services/proxy')
    const rows = await auditRows(request, scoped.email)
    expect(rows).toEqual([expect.objectContaining({ TargetType: 'namespaces', TargetID: NS, Result: 'failure' })])
  })

  test('the graph draws the lines, and a dropped one opens the NetworkPolicy check', async ({ page, request }) => {
    test.skip(!relayReady, `no network flows for cluster ${CLUSTER} (scripts/kind-cilium.sh up)`)
    await page.goto(`/cluster/resource-graph?cluster=${CLUSTER}&namespace=${NS}`)
    await expect(page.getByTestId('graph-view-structure')).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 })
    // off until switched on
    await expect(page.locator('[data-testid^="rf__edge-traffic-"]')).toHaveCount(0)
    await page.getByTestId('graph-view-traffic').click()
    // the Traffic view splits each line by port: it ends at that port's row of the receiving box
    const allowed = page.locator(`[aria-label="${NS}/client → ${NS}/web (TCP 80)"]`)
    await expect(allowed).toHaveCount(1, { timeout: 30_000 })
    const api = await traffic(request, admin, { source: 'relay' })
    const lines = api.body.lines as Line[]
    await expect(page.locator('[data-testid^="rf__edge-traffic-"]')).toHaveCount(lines.reduce((n, l) => n + Math.max(1, l.ports?.length ?? 0), 0))
    await expect(page.locator(`[data-testid="rf__node-Deployment/${NS}/web"] [data-testid="port-row"]`)).toHaveCount(1)
    await expect(page.locator(`[data-testid="rf__node-Deployment/${NS}/web"] [data-port-text="TCP 80"]`)).toContainText('✕')
    await expect(page.getByTestId('traffic-status-source')).toContainText('recent flows of the Hubble Relay')
    // the cluster DNS is not in this graph: a stand-in
    await expect(page.getByTestId('traffic-peer').filter({ hasText: 'kube-system' })).toHaveCount(1)
    // the dropped line: its details, then "Why?"
    await page.locator(`[aria-label="${NS}/stranger → ${NS}/web (TCP 80)"] .react-flow__edge-textwrapper`).click()
    const panel = page.getByTestId('traffic-panel')
    await expect(panel.getByTestId('traffic-panel-counts')).toContainText('0 flows allowed')
    await expect(panel.getByTestId('traffic-panel-reasons')).toContainText('POLICY_DENIED')
    await expect(panel.getByTestId('traffic-panel-ports')).toHaveText('TCP 80')
    await panel.getByTestId('traffic-panel-why').click()
    const modal = page.getByTestId('netpol-check-modal')
    await expect(modal.getByTestId('netpol-check-overall')).toHaveText('Denied', { timeout: 20_000 })
    await expect(modal.getByTestId('netpol-miss').first()).toContainText('web-only-client')
    await page.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)
    // both: the objects again, with the lines over them
    await page.getByTestId('graph-view-both').click()
    await expect(page.locator(`[data-testid="rf__node-Service/${NS}/web"]`)).toHaveCount(1, { timeout: 20_000 })
    await expect(page.locator(`[aria-label="${NS}/client → ${NS}/web"]`)).toHaveCount(1)
    await expect(page.getByTestId('traffic-legend')).toContainText('port · number of flows')
    // the port starts each line's number
    await expect(page.locator(`[aria-label="${NS}/client → ${NS}/web"] .react-flow__edge-text`)).toContainText('80 ·')
    // the metrics: no DNS line (UDP), the dropped line still there
    if (metricsReady) {
      await page.getByTestId('traffic-source-1h').click()
      await expect(page.getByTestId('traffic-status-source')).toContainText('Hubble metrics', { timeout: 20_000 })
      await expect(page.locator(`[aria-label="${NS}/stranger → ${NS}/web"]`)).toHaveCount(1)
      await expect(page.getByTestId('traffic-peer')).toHaveCount(0)
    }
  })

  test('a cluster whose Prometheus has no Hubble metrics says so', async ({ page, request }) => {
    const features = await (await request.get('/api/v1/cluster/features?cluster=default', { headers: bearer(admin) })).json()
    test.skip(features?.prometheus?.enabled !== true, 'the second cluster has no Prometheus in Kubeast')
    await page.goto('/cluster/resource-graph?cluster=default&namespace=kube-system')
    await page.getByTestId('graph-view-traffic').click({ timeout: 20_000 })
    // no Relay there: only the metrics are offered
    await expect(page.getByTestId('traffic-source-relay')).toHaveCount(0)
    await expect(page.getByTestId('traffic-empty')).toContainText('no Hubble TCP or drop metric', { timeout: 20_000 })
  })
})
