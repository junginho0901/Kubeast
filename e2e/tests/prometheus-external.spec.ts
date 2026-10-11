import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// A cluster can name an external Prometheus-compatible store (Admin → Clusters → Edit): URL,
// bearer/basic auth kept in a Secret, and the value of the cluster label its series carry.
// The second kind cluster's Prometheus (external_labels cluster=kubeast-b) is reachable from the
// first cluster on NodePort 30090 plain and 30091 behind nginx basic auth, so the self cluster
// (which has no Prometheus of its own) is pointed at it: every series comes back with the
// cluster label, counts match the proxy path on the second cluster, a wrong password shows up
// in the status, the stored credential never appears in the audit row, and clearing the fields
// takes the cluster back to "no Prometheus".

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const SELF = 'self'
const SECOND = 'default'

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-prom-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectlSelf = kubectlFor('kubeast')
const kubectlSecond = kubectlFor('kubeast-b')

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

const status = async (request: APIRequestContext, admin: string, cluster: string) =>
  (await request.get(`/api/v1/cluster/prometheus/status?cluster=${cluster}`, { headers: bearer(admin) })).json()
const query = async (request: APIRequestContext, admin: string, cluster: string, q: string) =>
  (await request.get(`/api/v1/cluster/prometheus/query?cluster=${cluster}&query=${encodeURIComponent(q)}`, { headers: bearer(admin) })).json()
const patch = (request: APIRequestContext, admin: string, body: object) =>
  request.patch(`/api/v1/clusters/${SELF}`, { headers: bearer(admin), data: body, failOnStatusCode: false })

test.describe('external Prometheus source', () => {
  test.describe.configure({ mode: 'serial' })
  let admin = ''
  let plainURL = ''
  let authURL = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request, EMAIL, PASSWORD)
    const before = await status(request, admin, SELF)
    test.skip(before.source === 'external', `the self cluster already names an external store (${before.endpoint})`)
    let nodeIP = ''
    try {
      nodeIP = kubectlSecond(`get node -o 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'`)
      kubectlSecond('-n monitoring get svc prometheus-nodeport prometheus-auth -o name')
    } catch {
      test.skip(true, 'the second kind cluster has no Prometheus NodePorts (deploy/kind/second-cluster.yaml)')
    }
    plainURL = `http://${nodeIP}:30090`
    authURL = `http://${nodeIP}:30091`
  })

  test.afterAll(async ({ request }) => {
    if (!admin) return
    await patch(request, admin, { prometheus_url: '', prometheus_cluster_label: '', prometheus_auth: { type: 'none' } })
  })

  test('a plain external store with a cluster label answers for that cluster only', async ({ request }) => {
    const res = await patch(request, admin, { prometheus_url: plainURL, prometheus_cluster_label: 'kubeast-b', prometheus_auth: { type: 'none' } })
    expect(res.status(), await res.text()).toBe(200)
    const meta = await res.json()
    expect(meta.prometheus_url).toBe(plainURL)
    expect(meta.prometheus_cluster_label).toBe('kubeast-b')
    expect(meta.prometheus_auth).toBe(false)

    const st = await status(request, admin, SELF)
    expect(st, JSON.stringify(st)).toMatchObject({ available: true, source: 'external', endpoint: plainURL, auth: false, cluster_label: 'kubeast-b', label_name: 'cluster' })

    const viaExternal = await query(request, admin, SELF, 'up')
    const viaProxy = await query(request, admin, SECOND, 'up')
    expect(viaExternal.available).toBe(true)
    expect(viaExternal.results.length).toBeGreaterThan(0)
    expect(viaExternal.results.length).toBe(viaProxy.results.length)
    for (const r of viaExternal.results) expect(r.metric.cluster, JSON.stringify(r.metric)).toBe('kubeast-b')
    // A matcher on the cluster label is replaced, not duplicated: another cluster's name finds nothing.
    const other = await query(request, admin, SELF, 'up{cluster="elsewhere"}')
    expect(other.results).toEqual(viaExternal.results)
  })

  test('a wrong password shows in the status; the right one works and never reaches the audit row', async ({ request }) => {
    const bad = await patch(request, admin, { prometheus_url: authURL, prometheus_auth: { type: 'basic', username: 'kubeast', password: 'wrong' } })
    expect(bad.status(), await bad.text()).toBe(200)
    const badStatus = await status(request, admin, SELF)
    expect(badStatus.available).toBe(false)
    expect(badStatus.auth).toBe(true)
    expect(String(badStatus.message)).toContain('401')

    const good = await patch(request, admin, { prometheus_auth: { type: 'basic', username: 'kubeast', password: 'kubeast-prom' } })
    expect(good.status()).toBe(200)
    expect((await good.json()).prometheus_auth).toBe(true)
    const goodStatus = await status(request, admin, SELF)
    expect(goodStatus, JSON.stringify(goodStatus)).toMatchObject({ available: true, source: 'external', endpoint: authURL, auth: true })
    const viaAuth = await query(request, admin, SELF, 'up')
    expect(viaAuth.results.length).toBeGreaterThan(0)

    expect(kubectlSelf(`-n kubeast get secret cluster-prometheus-self -o 'jsonpath={.data.authorization}'`)).not.toBe('')
    const rows = ((await (await request.get('/api/v1/auth/admin/audit-logs?action=admin.cluster.update&limit=10', { headers: bearer(admin) })).json()).items ?? []) as any[]
    const row = rows.find((r) => (r.TargetID ?? r.target_id) === SELF && (r.After ?? r.after)?.prometheus_auth_change === 'set')
    expect(row, 'admin.cluster.update row with prometheus_auth_change=set').toBeTruthy()
    expect(JSON.stringify(row)).not.toContain('kubeast-prom')
  })

  test('the clusters page shows the external badge and the edit dialog checks the connection', async ({ page }) => {
    await page.goto('/admin/clusters')
    // The row's text runs "selfself…" (name + the self tag), so find it by the badge and check the name.
    const row = page.locator('tr').filter({ has: page.getByTestId('cluster-prometheus-external') }).first()
    await expect(row).toBeVisible()
    await expect(row).toContainText(SELF)
    await expect(row.getByTestId('cluster-prometheus-external')).toHaveAttribute('title', authURL)
    await row.getByRole('button', { name: /Edit|편집/ }).click()
    await expect(page.getByTestId('edit-prometheus-url')).toHaveValue(authURL)
    await expect(page.getByTestId('edit-prometheus-auth')).toHaveValue('keep')
    await page.getByTestId('edit-prometheus-check').click()
    await expect(page.getByTestId('edit-prometheus-status')).toContainText(/OK|정상/, { timeout: 20000 })
    await expect(page.getByTestId('edit-submit')).toBeDisabled()
    await page.keyboard.press('Escape')
  })

  test('clearing the fields removes the Secret and the cluster is back to no Prometheus', async ({ request }) => {
    const res = await patch(request, admin, { prometheus_url: '', prometheus_cluster_label: '', prometheus_auth: { type: 'none' } })
    expect(res.status()).toBe(200)
    const meta = await res.json()
    expect(meta.prometheus_url ?? '').toBe('')
    expect(meta.prometheus_auth).toBe(false)
    expect(() => kubectlSelf('-n kubeast get secret cluster-prometheus-self -o name')).toThrow()
    const st = await status(request, admin, SELF)
    expect(st.source).toBe('none')
  })
})
