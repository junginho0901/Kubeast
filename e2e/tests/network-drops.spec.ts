import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'

// Network drops from the Hubble drop metric of the Cilium kind cluster that scripts/kind-cilium.sh up registers
// (kubeast-cilium: deploy/kind/cilium-values.yaml, the Prometheus of deploy/kind/cilium-prometheus.yaml, the traffic
// of deploy/kind/cilium-demo.yaml — stranger is dropped by the NetworkPolicy web-only-client on its way to web).
// The counts as Prometheus has them, read as a Read user; a user the cluster does not let read that Prometheus is
// refused; the drawer section and its "Why?" into the NetworkPolicy check; the AI tool over MCP. Skips without
// that cluster's drop metric.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-drops-pass1!'
const CLUSTER = process.env.E2E_CILIUM_CLUSTER || 'kubeast-cilium'
const NS = 'flows-demo'
const MCP = '/api/v1/ai/mcp'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function ciliumKubectl(): ((args: string) => string) | null {
  try {
    const kubeconfig = execSync(`kind get kubeconfig --name ${CLUSTER}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-drops-')), 'kubeconfig')
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

type Peer = { namespace?: string; workload?: string; kind?: string; pod?: string; reason: string; count: number }

test.describe('Network drops (Hubble metrics)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)
  const id = Date.now().toString(36)
  const userIds: string[] = []
  let admin = ''
  let ready = false
  let kubectl: ((args: string) => string) | null = null

  // what the cluster's Prometheus says, read directly through its API server (the kind admin)
  function promDirect(expr: string): { metric: Record<string, string>; value: [number, string] }[] {
    const q = encodeURIComponent(expr)
    return JSON.parse(kubectl!(`get --raw "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query?query=${q}"`)).data.result
  }

  async function user(request: APIRequestContext, name: string, grant: object): Promise<{ email: string; token: string }> {
    const roles = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(roles) ? roles : roles.roles || roles.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-drops-${name}-${id}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E drops ${name}`, email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    userIds.push((await created.json()).id)
    const put = await request.put(`/api/v1/auth/admin/users/${userIds[userIds.length - 1]}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: grant })
    expect(put.ok(), await put.text()).toBeTruthy()
    return { email, token: await login(request, email, PW) }
  }

  async function drops(request: APIRequestContext, token: string, params: Record<string, string>, cluster = CLUSTER) {
    const res = await request.get(`/api/v1/cluster/namespaces/${NS}/networkdrops`, { headers: bearer(token), params: { cluster, ...params }, failOnStatusCode: false })
    return { status: res.status(), body: await res.json() }
  }

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    kubectl = ciliumKubectl()
    if (!kubectl) return
    try {
      ready = promDirect(`sum(hubble_drop_total{destination_namespace="${NS}",destination_workload="web"})`).length > 0
    } catch {
      ready = false
    }
  })

  test.afterAll(async ({ request }) => {
    for (const u of userIds) await request.delete(`/api/v1/auth/admin/users/${u}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test('a Read user sees the drops as the cluster’s Prometheus counts them', async ({ request }) => {
    test.skip(!ready, `no Hubble drop metric on cluster ${CLUSTER} (scripts/kind-cilium.sh up)`)
    const reader = await user(request, 'read', { role: 'Read' })
    const { status, body } = await drops(request, reader.token, { kind: 'Deployment', name: 'web', range: '1h' })
    expect(status, JSON.stringify(body)).toBe(200)
    const direct = promDirect(`sum by (reason, source_namespace, source_workload) (increase(hubble_drop_total{destination_namespace="${NS}",destination_workload="web"}[3600s]))`)
      .map((r) => ({ reason: r.metric.reason, peer: `${r.metric.source_namespace}/${r.metric.source_workload}`, count: Math.round(Number(r.value[1])) }))
      .filter((r) => r.count > 0)
    expect(body).toMatchObject({ available: true, style: 'labels', workload: { kind: 'Deployment', name: 'web' } })
    // the same peers and reasons as Prometheus, and the counts it had a moment later (the counter only grows)
    const got = (body.incoming.peers as Peer[]).map((p) => ({ reason: p.reason, peer: `${p.namespace}/${p.workload}`, count: p.count }))
    expect(got.map((g) => `${g.peer} ${g.reason}`).sort()).toEqual(direct.map((d) => `${d.peer} ${d.reason}`).sort())
    for (const g of got) {
      const d = direct.find((x) => x.peer === g.peer && x.reason === g.reason)!
      expect(g.count, `${g.peer} ${g.reason}`).toBeGreaterThan(0)
      expect(Math.abs(d.count - g.count), `${g.peer}: Kubeast ${g.count}, Prometheus ${d.count}`).toBeLessThanOrEqual(Math.max(60, d.count / 10))
    }
    expect(got).toContainEqual(expect.objectContaining({ peer: `${NS}/stranger`, reason: 'POLICY_DENIED' }))
    expect(body.incoming.total).toBe(got.reduce((n, g) => n + g.count, 0))
    // the other side of the same drops: stranger's outgoing ones go to web
    const out = await drops(request, reader.token, { kind: 'Deployment', name: 'stranger' })
    expect(out.body.outgoing.peers).toContainEqual(expect.objectContaining({ namespace: NS, workload: 'web', kind: 'Deployment', reason: 'POLICY_DENIED' }))
    expect(out.body.incoming.total).toBe(0)
    // a pod's drops are its workload's: the dev metric has no pod label
    const pod = kubectl!(`-n ${NS} get pod -l app=web -o jsonpath={.items[0].metadata.name}`)
    const byPod = await drops(request, reader.token, { kind: 'Pod', name: pod })
    expect(byPod.body).toMatchObject({ notes: ['workload_level'], workload: { kind: 'Deployment', name: 'web' } })
    // the second cluster's Prometheus has no Hubble metric (the reader has no grant there; the admin asks)
    expect((await drops(request, admin, {}, 'default')).body).toMatchObject({ available: false, reason: 'no_metrics' })
  })

  test('a user the cluster does not let read its Prometheus is refused', async ({ request }) => {
    test.skip(!ready, `no Hubble drop metric on cluster ${CLUSTER} (scripts/kind-cilium.sh up)`)
    // a namespace-limited grant acts as kubeast:role:read, which the viewer proxy Role does not bind
    const scoped = await user(request, 'scoped', { role: 'Read', namespaces: [NS] })
    const { status, body } = await drops(request, scoped.token, { kind: 'Deployment', name: 'web' })
    expect(status, JSON.stringify(body)).toBe(403)
  })

  test('the drawer shows the drops and a policy drop opens the NetworkPolicy check for it', async ({ page }) => {
    test.skip(!ready, `no Hubble drop metric on cluster ${CLUSTER} (scripts/kind-cilium.sh up)`)
    const pod = kubectl!(`-n ${NS} get pod -l app=web -o jsonpath={.items[0].metadata.name}`)
    await page.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=${NS}&detail=Pod/${NS}/${pod}`)
    const section = page.getByTestId('netdrop-section')
    await expect(section).toBeVisible({ timeout: 20_000 })
    const row = section.getByTestId('netdrop-row').filter({ hasText: 'POLICY_DENIED' }).first()
    await expect(row.getByTestId('netdrop-peer')).toHaveText('Deployment/stranger')
    await expect(section.getByTestId('netdrop-workload-level')).toContainText('Deployment/web')
    const shown = Number(await row.getByTestId('netdrop-count').textContent())
    expect(shown).toBeGreaterThan(0)
    await row.getByTestId('netdrop-why').click()
    const modal = page.getByTestId('netpol-check-modal')
    await expect(modal.getByTestId('netpol-check-overall')).toHaveText('Denied', { timeout: 20_000 })
    await expect(modal.getByTestId('netpol-miss').first()).toContainText('web-only-client Rule 1: the other end is not one of its peers')
    await expect(modal).toContainText(`deployment/${NS}/stranger → pod/${NS}/${pod}`)
  })

  test('the AI tool reads the same drops over MCP', async ({ request }) => {
    test.skip(!ready, `no Hubble drop metric on cluster ${CLUSTER} (scripts/kind-cilium.sh up)`)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    test.skip(!(config.ok() && (await config.json()).enabled), 'the MCP server is off (mcp.enabled)')
    const res = await request.post(MCP, {
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'network_drops', arguments: { cluster: CLUSTER, namespace: NS, workload_kind: 'Deployment', workload_name: 'stranger', since: '1h' } } },
    })
    expect(res.status()).toBe(200)
    const result = (await res.json()).result
    expect(result.isError ?? false, result.content?.[0]?.text).toBe(false)
    const answer = JSON.parse(result.content[0].text)
    expect(answer).toMatchObject({ available: true, incoming: { total: 0 } })
    expect(answer.outgoing.peers).toContainEqual(expect.objectContaining({ workload: 'web', reason: 'POLICY_DENIED' }))
    expect(answer.note).toContain('network_policy_check')
  })
})
