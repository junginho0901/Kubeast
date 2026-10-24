import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'

// Network flows from the Hubble Relay of the Cilium kind cluster that scripts/kind-cilium.sh up registers
// (kubeast-cilium, traffic of deploy/kind/cilium-demo.yaml): client reaches web on port 80, which the
// NetworkPolicy web-only-client allows, and stranger is dropped by it. Read through the API server proxy as
// the signed-in user; a user the cluster does not let use the Relay is refused; the drawer section and its
// "Why?" into the NetworkPolicy check; the AI tool over MCP. Skips without that cluster.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-flows-pass1!'
const CLUSTER = process.env.E2E_CILIUM_CLUSTER || 'kubeast-cilium'
const NS = 'flows-demo'
const MCP = '/api/v1/ai/mcp'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function ciliumKubectl(): ((args: string) => string) | null {
  try {
    const kubeconfig = execSync(`kind get kubeconfig --name ${CLUSTER}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-flows-')), 'kubeconfig')
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

type Group = { source: any; destination: any; verdict: string; drop_reason?: string; policies?: any; count: number; replies: number; observed: string[] }

test.describe('Network flows (Hubble Relay)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)
  const id = Date.now().toString(36)
  const userIds: string[] = []
  let admin = ''
  let ready = false
  let kubectl: ((args: string) => string) | null = null

  async function user(request: APIRequestContext, name: string, grant: object): Promise<{ email: string; token: string }> {
    const roles = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(roles) ? roles : roles.roles || roles.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-flows-${name}-${id}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E flows ${name}`, email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    userIds.push((await created.json()).id)
    const put = await request.put(`/api/v1/auth/admin/users/${userIds[userIds.length - 1]}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: grant })
    expect(put.ok(), await put.text()).toBeTruthy()
    return { email, token: await login(request, email, PW) }
  }

  async function flows(request: APIRequestContext, token: string, params: Record<string, string>) {
    const res = await request.get(`/api/v1/cluster/namespaces/${NS}/networkflows`, { headers: bearer(token), params: { cluster: CLUSTER, ...params }, failOnStatusCode: false })
    return { status: res.status(), body: await res.json() }
  }

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const features = await (await request.get(`/api/v1/cluster/features?cluster=${CLUSTER}`, { headers: bearer(admin) })).json()
    kubectl = ciliumKubectl()
    ready = !!kubectl && features?.networkFlows?.enabled === true && (features.networkFlows.clusters ?? []).includes(CLUSTER)
  })

  test.afterAll(async ({ request }) => {
    for (const u of userIds) await request.delete(`/api/v1/auth/admin/users/${u}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test('a Read user sees the allowed and the dropped connection, as the cluster has them', async ({ request }) => {
    test.skip(!ready, `no network flows for cluster ${CLUSTER} (scripts/kind-cilium.sh up)`)
    // what the cluster has: the policy and the three workloads
    expect(kubectl!(`-n ${NS} get networkpolicy web-only-client -o jsonpath={.spec.ingress[0].from[0].podSelector.matchLabels.app}`)).toBe('client')
    const reader = await user(request, 'read', { role: 'Read' })
    // the traffic runs every 3 s; wait until both connections are in the window
    let groups: Group[] = []
    await expect.poll(async () => {
      const { status, body } = await flows(request, reader.token, { kind: 'Deployment', name: 'web', since: '5m' })
      expect(status, JSON.stringify(body)).toBe(200)
      groups = body.groups
      return groups.some((g) => g.verdict === 'DROPPED') && groups.some((g) => g.verdict === 'FORWARDED')
    }, { timeout: 60_000, intervals: [3_000] }).toBe(true)
    const allowed = groups.find((g) => g.verdict === 'FORWARDED' && g.source.workload?.name === 'client')!
    expect(allowed.destination).toMatchObject({ namespace: NS, workload: { kind: 'Deployment', name: 'web' }, port: 80 })
    expect(allowed.policies?.ingress_allowed_by).toContainEqual({ kind: 'NetworkPolicy', namespace: NS, name: 'web-only-client' })
    expect(allowed.replies).toBeGreaterThan(0)
    const dropped = groups.find((g) => g.verdict === 'DROPPED')!
    expect(dropped).toMatchObject({ drop_reason: 'POLICY_DENIED', observed: ['ingress'], source: { workload: { name: 'stranger' } }, destination: { port: 80 } })
    // only drops, and the audit row says what was asked, not what came back
    const drops = await flows(request, reader.token, { verdict: 'dropped', limit: '20' })
    expect(drops.status).toBe(200)
    expect(new Set(drops.body.flows.map((f: { verdict: string }) => f.verdict))).toEqual(new Set(['DROPPED']))
    let row: any
    await expect.poll(async () => {
      const res = await request.get('/api/v1/auth/admin/audit-logs?action=k8s.networkflows.query&limit=20', { headers: bearer(admin) })
      row = ((await res.json()).items ?? []).find((r: any) => (r.ActorEmail ?? r.actor_email) === reader.email && (r.TargetType ?? r.target_type) === 'namespace')
      return !!row
    }, { timeout: 15_000 }).toBe(true)
    const after = row.After ?? row.after
    expect(after).toMatchObject({ mode: 'proxy', verdicts: ['DROPPED'], limit: 20, flows: drops.body.flows.length })
    expect(JSON.stringify(after)).not.toContain('stranger')
  })

  test('a user the cluster does not let use the Relay is refused before any read', async ({ request }) => {
    test.skip(!ready, `no network flows for cluster ${CLUSTER} (scripts/kind-cilium.sh up)`)
    // a namespace-limited grant acts as kubeast:role:read, which the Relay Role does not bind
    const scoped = await user(request, 'scoped', { role: 'Read', namespaces: [NS] })
    const { status, body } = await flows(request, scoped.token, { kind: 'Deployment', name: 'web' })
    expect(status, JSON.stringify(body)).toBe(403)
    expect(body.detail).toContain('services/proxy https:hubble-relay:443')
  })

  test('the drawer shows the connections and a drop opens the NetworkPolicy check for it', async ({ page }) => {
    test.skip(!ready, `no network flows for cluster ${CLUSTER} (scripts/kind-cilium.sh up)`)
    const pod = kubectl!(`-n ${NS} get pod -l app=web -o jsonpath={.items[0].metadata.name}`)
    await page.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=${NS}&detail=Pod/${NS}/${pod}`)
    const section = page.getByTestId('netflow-section')
    await expect(section).toBeVisible({ timeout: 20_000 })
    await section.getByTestId('netflow-load').click()
    const dropped = section.getByTestId('netflow-row').filter({ hasText: 'DROPPED' }).first()
    await expect(dropped).toBeVisible({ timeout: 20_000 })
    await expect(dropped.getByTestId('netflow-peer')).toHaveText('Deployment/stranger')
    await expect(dropped.getByTestId('netflow-reason')).toHaveText('POLICY_DENIED')
    await expect(section.getByTestId('netflow-row').filter({ hasText: 'FORWARDED' }).filter({ hasText: 'web-only-client' }).first()).toBeVisible()
    await dropped.getByTestId('netflow-why').click()
    const modal = page.getByTestId('netpol-check-modal')
    await expect(modal.getByTestId('netpol-check-overall')).toHaveText('Denied', { timeout: 20_000 })
    await expect(modal.getByTestId('netpol-miss')).toContainText(['web-only-client Rule 1: the other end is not one of its peers'])
    await expect(modal).toContainText(`deployment/${NS}/stranger → pod/${NS}/${pod}`)
  })

  test('the AI tool reads the same connections over MCP', async ({ request }) => {
    test.skip(!ready, `no network flows for cluster ${CLUSTER} (scripts/kind-cilium.sh up)`)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    test.skip(!(config.ok() && (await config.json()).enabled), 'the MCP server is off (mcp.enabled)')
    const res = await request.post(MCP, {
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'network_flows', arguments: { cluster: CLUSTER, namespace: NS, workload_kind: 'Deployment', workload_name: 'stranger', verdict: 'DROPPED', since: '5m' } } },
    })
    expect(res.status()).toBe(200)
    const result = (await res.json()).result
    expect(result.isError ?? false, result.content?.[0]?.text).toBe(false)
    const answer = JSON.parse(result.content[0].text)
    expect(answer.groups.length).toBeGreaterThan(0)
    for (const g of answer.groups as Group[]) expect(g).toMatchObject({ verdict: 'DROPPED', drop_reason: 'POLICY_DENIED', source: { workload: { name: 'stranger' } } })
    expect(answer.note).toContain('network_policy_check')
  })
})
