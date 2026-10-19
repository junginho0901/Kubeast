import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// The AI's alerts_list through the MCP endpoint, against the second cluster's Alertmanager
// (deploy/kind/alertmanager.yaml, NodePort 31093, features.alertStore in the dev values: self = cluster="kubeast",
// default = cluster="kubeast-b"). The spec posts alerts of both clusters and two silences — one on this cluster's
// alert, one on the other cluster's — labelled kubeast_e2e="store", which the dev route sends to no receiver (no
// investigation starts). Each cluster sees its own alerts and only the silences on them; a grant limited to
// namespaces is refused; Grafana's data source proxy serves the same Alertmanager API.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-alerts-pass1!'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

// the second cluster's Alertmanager, asked from its node (the laptop does not reach the kind network)
function am(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): string {
  const data = body === undefined ? '' : `-H 'Content-Type: application/json' --data-binary @-`
  return execSync(`docker exec -i kubeast-b-control-plane curl -sf -X ${method} ${data} 'http://127.0.0.1:31093${path}'`, {
    encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), stdio: ['pipe', 'pipe', 'pipe'],
  })
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function call(request: APIRequestContext, token: string, args: Record<string, unknown>) {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'alerts_list', arguments: args } },
    failOnStatusCode: false,
  })
  expect(res.status(), await res.text()).toBe(200)
  const result = (await res.json()).result
  return { isError: !!result.isError, text: result.content?.[0]?.text as string }
}
const alertsList = async (request: APIRequestContext, token: string, args: Record<string, unknown>) => {
  const out = await call(request, token, args)
  expect(out.isError, out.text).toBe(false)
  return JSON.parse(out.text)
}

type Alert = { alertname: string; severity: string; state: string; summary?: string; labels: Record<string, string>; silencedBy?: string[] }
type Silence = { id: string; comment: string; createdBy: string; matchers: string[] }

test.describe('AI alerts_list', () => {
  test.describe.configure({ mode: 'serial' })
  const id = Date.now().toString(36)
  const firing = `E2EAlertsFiring${id}`
  const quiet = `E2EAlertsSilenced${id}`
  const silenceIds: string[] = []
  const userIds: string[] = []
  let admin = ''
  let reader = ''
  let scoped = ''
  let ready = false

  async function user(request: APIRequestContext, name: string, grant: object): Promise<string> {
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-alerts-${name}-${id}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E alerts ${name}`, email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    userIds.push(userId)
    const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/self`, { headers: bearer(admin), data: grant })
    expect(put.ok(), await put.text()).toBeTruthy()
    return login(request, email, PW)
  }

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    if (!(config.ok() && (await config.json()).enabled)) return
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    if (!features.alertStore?.clusters?.includes('self') || !features.alertStore?.clusters?.includes('default')) return
    try {
      am('GET', '/-/ready')
    } catch {
      return
    }
    const startsAt = new Date().toISOString()
    const endsAt = new Date(Date.now() + 15 * 60_000).toISOString()
    const labels = (alertname: string, cluster: string, severity: string) =>
      ({ alertname, cluster, severity, namespace: 'default', kubeast_e2e: 'store', e2e_run: id })
    am('POST', '/api/v2/alerts', [
      { labels: labels(firing, 'kubeast', 'critical'), annotations: { summary: `disk almost full ${id}` }, startsAt, endsAt },
      { labels: labels(quiet, 'kubeast', 'warning'), annotations: { summary: `restarts ${id}` }, startsAt, endsAt },
      { labels: labels(firing, 'kubeast-b', 'critical'), annotations: { summary: `other cluster ${id}` }, startsAt, endsAt },
    ])
    const silence = (cluster: string, alertname: string, comment: string) => JSON.parse(am('POST', '/api/v2/silences', {
      matchers: [{ name: 'alertname', value: alertname, isRegex: false, isEqual: true }, { name: 'cluster', value: cluster, isRegex: false, isEqual: true }],
      startsAt: new Date().toISOString(), endsAt, createdBy: 'e2e', comment,
    })).silenceID as string
    silenceIds.push(silence('kubeast', quiet, `deploy window ${id}`), silence('kubeast-b', firing, `other cluster freeze ${id}`))
    reader = await user(request, 'read', { role: 'Read' })
    scoped = await user(request, 'scoped', { role: 'Read', namespaces: ['default'] })
    // Alertmanager marks a new alert suppressed once it has run it through the silences
    await expect.poll(() => (JSON.parse(am('GET', `/api/v2/alerts?filter=e2e_run%3D%22${id}%22&active=false`)) as unknown[]).length, { timeout: 30_000 }).toBe(2)
    ready = true
  })

  test.afterAll(async ({ request }) => {
    for (const s of silenceIds) {
      try {
        am('DELETE', `/api/v2/silence/${s}`)
      } catch { /* expired already */ }
    }
    if (!admin) return
    for (const u of userIds) await request.delete(`/api/v1/auth/admin/users/${u}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test.beforeEach(() => {
    test.skip(!ready, 'no MCP server, no alert store for clusters self and default, or no Alertmanager on NodePort 31093')
  })

  test("each cluster sees its own alerts and only the silences on them", async ({ request }) => {
    const all = await alertsList(request, reader, { cluster: 'self', state: 'all', alert_labels: { e2e_run: id } })
    expect(all.total).toBe(2)
    expect(all.states).toEqual({ firing: 1, silenced: 1 })
    const [first, second] = all.alerts as Alert[]
    expect(first).toMatchObject({ alertname: firing, severity: 'critical', state: 'firing', summary: `disk almost full ${id}` })
    expect(first.labels).toMatchObject({ cluster: 'kubeast', namespace: 'default' })
    expect(second).toMatchObject({ alertname: quiet, state: 'silenced', silencedBy: [silenceIds[0]] })
    expect((all.silences as Silence[]).map((s) => [s.id, s.comment, s.createdBy])).toEqual([[silenceIds[0], `deploy window ${id}`, 'e2e']])
    expect(JSON.stringify(all)).not.toContain('other cluster')

    const other = await alertsList(request, admin, { cluster: 'default', state: 'all', alert_labels: { e2e_run: id } })
    expect((other.alerts as Alert[]).map((a) => [a.alertname, a.state, a.labels.cluster])).toEqual([[firing, 'silenced', 'kubeast-b']])
    expect((other.silences as Silence[]).map((s) => s.comment)).toEqual([`other cluster freeze ${id}`])
    expect(JSON.stringify(other)).not.toContain(`deploy window ${id}`)
  })

  test('states and filters narrow the list; the cluster label cannot be widened', async ({ request }) => {
    const fire = await alertsList(request, reader, { cluster: 'self', alert_labels: { e2e_run: id } })
    expect(fire.state).toBe('firing')
    expect((fire.alerts as Alert[]).map((a) => a.alertname)).toEqual([firing])
    const quietOnes = await alertsList(request, reader, { cluster: 'self', state: 'silenced', alert_labels: { e2e_run: id } })
    expect((quietOnes.alerts as Alert[]).map((a) => a.alertname)).toEqual([quiet])
    const byName = await alertsList(request, reader, { cluster: 'self', state: 'all', alertname: quiet })
    expect((byName.alerts as Alert[]).map((a) => a.alertname)).toEqual([quiet])
    // naming the other cluster's value does not reach its alerts
    const widened = await alertsList(request, reader, { cluster: 'self', state: 'all', alert_labels: { e2e_run: id, cluster: 'kubeast-b' } })
    expect((widened.alerts as Alert[]).map((a) => a.labels.cluster)).toEqual(['kubeast', 'kubeast'])
    const none = await alertsList(request, reader, { cluster: 'self', alert_labels: { e2e_run: `${id}-none` } })
    expect(none.total).toBe(0)
    expect(none.hint).toContain('state=all')
  })

  test('a grant limited to namespaces is refused', async ({ request }) => {
    const out = await call(request, scoped, { cluster: 'self', state: 'all' })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('alerts_list spans the cluster')
    const direct = await request.get('/api/v1/cluster/alertstore/alerts?cluster=self', { headers: bearer(scoped), failOnStatusCode: false })
    expect(direct.status()).toBe(403)
    expect(await direct.text()).toContain('alerts cover the whole cluster')
  })

  test("Grafana's data source proxy serves the same Alertmanager API", async ({ request }) => {
    let token = ''
    try {
      const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-alerts-')), 'kubeconfig')
      fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast-b', { encoding: 'utf8' }), { mode: 0o600 })
      token = Buffer.from(execSync(`kubectl --kubeconfig ${kc} -n grafana get secret kubeast-reader -o jsonpath={.data.token}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), 'base64').toString()
    } catch {
      test.skip(true, 'no Grafana in the second kind cluster — run scripts/kind-grafana.sh up')
    }
    const viaGrafana = (p: string) => execSync(
      `docker exec -e GRAFANA_TOKEN kubeast-b-control-plane sh -c 'curl -sf -H "Authorization: Bearer $GRAFANA_TOKEN" "$0"' 'http://127.0.0.1:31300/api/datasources/proxy/uid/alertmanager${p}'`,
      { encoding: 'utf8', env: { ...process.env, GRAFANA_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let proxied: { labels: Record<string, string>; status: { state: string } }[] = []
    try {
      proxied = JSON.parse(viaGrafana(`/api/v2/alerts?filter=${encodeURIComponent(`e2e_run="${id}"`)}&filter=${encodeURIComponent('cluster="kubeast"')}`))
    } catch {
      test.skip(true, 'Grafana has no Alertmanager data source — re-apply deploy/kind/grafana.yaml and run scripts/kind-grafana.sh up')
    }
    const kubeast = await alertsList(request, admin, { cluster: 'self', state: 'all', alert_labels: { e2e_run: id } })
    expect(proxied.map((a) => a.labels.alertname).sort()).toEqual((kubeast.alerts as Alert[]).map((a) => a.alertname).sort())
  })
})
