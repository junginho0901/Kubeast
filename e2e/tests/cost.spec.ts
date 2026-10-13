import { test, expect, type APIRequestContext } from '@playwright/test'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Cost (OpenCost): /api/v1/cluster/cost and the Cost page read OpenCost's allocation through the
// API server proxy. The second kind cluster (`default`) runs OpenCost (deploy/kind/second-cluster.yaml);
// `self` has none and says so. A Read grant covers cost, a namespace-scoped grant sees only its
// namespaces, and the optimization table of a cluster with OpenCost carries cost and saving columns.
// Throwaway user removed at the end.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-cost-throwaway-1!'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

type CostRow = { name: string; namespace: string; kind?: string; total_cost: number; cpu_cost: number }
type CostResponse = {
  window: string
  aggregate: string
  currency: string
  scoped: boolean
  source: { namespace: string; service: string; port: number }
  rows: CostRow[]
  totals: { total_cost: number; cpu_cost: number }
}
type OptimizationResponse = {
  rows: { cost_month_usd?: number; saving_month_usd?: number }[]
  totals: { cost_month_usd?: number; saving_month_usd?: number }
  pricing?: { cpu_core_hour_usd: number; ram_byte_hour_usd: number; source: string; window: string }
}

// The same digits rule as frontend/src/utils/money.ts, so the screen can be compared with the API.
function money(amount: number): string {
  const abs = Math.abs(amount)
  const digits = abs === 0 ? 0 : abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount)
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E cost', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  return (await res.json()).id
}

// OpenCost's own answer on the second cluster, through its API server, to compare with Kubeast's.
function openCostRaw(query: string): Record<string, { totalCost: number }> {
  const kubeconfig = execSync('kind get kubeconfig --name kubeast-b', { encoding: 'utf8' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cost-'))
  const kcPath = path.join(dir, 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  const out = execSync(
    `kubectl --kubeconfig ${kcPath} get --raw "/api/v1/namespaces/opencost/services/opencost:9003/proxy/allocation/compute?${query}"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  )
  return JSON.parse(out).data[0]
}

test.describe('cost (OpenCost)', () => {
  test('features and status: the second cluster has OpenCost, self does not, and a window OpenCost would not take is refused', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const features = await (await request.get('/api/v1/cluster/features?cluster=default', { headers: bearer(admin) })).json()
    expect(features.cost).toEqual({ enabled: true })

    const status = await (await request.get('/api/v1/cluster/cost/status?cluster=default', { headers: bearer(admin) })).json()
    expect(status).toMatchObject({ available: true, source: 'proxy', endpoint: 'opencost/opencost:9003 (via K8s API proxy)' })

    const none = await (await request.get('/api/v1/cluster/cost/status?cluster=self', { headers: bearer(admin) })).json()
    expect(none).toMatchObject({ available: false, source: 'none' })
    expect(none.message).toContain('OpenCost not found')
    const missing = await request.get('/api/v1/cluster/cost?cluster=self&window=1h', { headers: bearer(admin), failOnStatusCode: false })
    expect(missing.status()).toBe(404)
    expect((await missing.json()).detail).toContain('OpenCost not found')

    const bad = await request.get('/api/v1/cluster/cost?cluster=default&window=2h', { headers: bearer(admin), failOnStatusCode: false })
    expect(bad.status()).toBe(400)
  })

  test('the allocation matches OpenCost: the same namespaces, totals that add up, workload rows that know their namespace and kind', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    // The 6h window holds hours of accumulation, so the server's 60 s answer cache and the seconds
    // between the two reads move the number by well under 5%; a 1h window that just began does not
    // (13.5% off at 03:00:40 on the first run).
    const raw = openCostRaw('window=6h&aggregate=namespace&accumulate=true&includeIdle=false')
    const body: CostResponse = await (await request.get('/api/v1/cluster/cost?cluster=default&window=6h&aggregate=namespace', { headers: bearer(admin) })).json()
    expect(body).toMatchObject({ window: '6h', aggregate: 'namespace', currency: 'USD', scoped: false, source: { namespace: 'opencost', service: 'opencost', port: 9003 } })
    expect(body.rows.map((r) => r.name).sort()).toEqual(Object.keys(raw).filter((k) => k !== '__idle__').sort())

    const ks = body.rows.find((r) => r.name === 'kube-system')
    expect(ks, 'kube-system row').toBeTruthy()
    expect(ks!.total_cost).toBeGreaterThan(0)
    expect(Math.abs(ks!.total_cost - raw['kube-system'].totalCost) / raw['kube-system'].totalCost).toBeLessThan(0.05)
    expect(body.totals.total_cost).toBeCloseTo(body.rows.reduce((n, r) => n + r.total_cost, 0), 9)
    expect(body.totals.cpu_cost).toBeCloseTo(body.rows.reduce((n, r) => n + r.cpu_cost, 0), 9)
    for (let i = 1; i < body.rows.length; i++) expect(body.rows[i - 1].total_cost).toBeGreaterThanOrEqual(body.rows[i].total_cost)

    const wl: CostResponse = await (await request.get('/api/v1/cluster/cost?cluster=default&window=1h&aggregate=controller', { headers: bearer(admin) })).json()
    expect(wl.aggregate).toBe('controller')
    expect(wl.rows.find((r) => r.name === 'kindnet')).toMatchObject({ namespace: 'kube-system', kind: 'DaemonSet' })
    expect(wl.rows.every((r) => r.namespace.length > 0)).toBeTruthy()
  })

  // The allocation is read as the signed-in user, so the cluster's RBAC is the ceiling: kubeast:viewer (Read)
  // is bound to `view` + kubeast:cluster-reader, neither of which has services/proxy, so the cluster refuses —
  // even right after an admin warmed the answer cache (answers are cached per identity). kubeast:operator
  // (Write) is bound to `edit`, which may proxy. A namespace-scoped grant acts as kubeast:role:read, which the
  // dev second cluster binds nowhere: refused as well, never served the whole cluster's rows.
  test('cluster RBAC is the ceiling: a Read grant is refused even with a warm cache, a scoped Read too, Write reads, no grant refuses', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const asAdmin: CostResponse = await (await request.get('/api/v1/cluster/cost?cluster=default&window=1h&aggregate=namespace', { headers: bearer(admin) })).json()
    expect(asAdmin.rows.length).toBeGreaterThan(0)
    const email = `e2e-cost-${Date.now().toString(36)}@kubeast.local`
    let userId = ''
    try {
      userId = await createUser(request, admin, email)
      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/default`, { headers: bearer(admin), data: { role: 'Read' } })).ok()).toBeTruthy()
      const reader = await login(request, email, PW)
      // Discovery is shared (the overview cache identity lists the Service); the read is the caller's own.
      const status = await request.get('/api/v1/cluster/cost/status?cluster=default', { headers: bearer(reader) })
      expect(status.status()).toBe(200)
      expect((await status.json()).available).toBe(true)
      const refused = await request.get('/api/v1/cluster/cost?cluster=default&window=1h&aggregate=namespace', { headers: bearer(reader), failOnStatusCode: false })
      expect(refused.status()).toBe(403)
      expect((await refused.json()).detail).toContain('403')
      const noGrant = await request.get('/api/v1/cluster/cost?cluster=self&window=1h', { headers: bearer(reader), failOnStatusCode: false })
      expect(noGrant.status()).toBe(403)
      expect((await noGrant.json()).detail).toContain('no access to cluster')

      // The scope is a token claim: sign in again after the grant changes.
      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/default`, { headers: bearer(admin), data: { role: 'Read', namespaces: ['kube-system'] } })).ok()).toBeTruthy()
      const scoped = await login(request, email, PW)
      const scopedRes = await request.get('/api/v1/cluster/cost?cluster=default&window=1h&aggregate=controller', { headers: bearer(scoped), failOnStatusCode: false })
      expect(scopedRes.status()).toBe(403)

      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/default`, { headers: bearer(admin), data: { role: 'Write' } })).ok()).toBeTruthy()
      const writer = await login(request, email, PW)
      const ok = await request.get('/api/v1/cluster/cost?cluster=default&window=1h&aggregate=namespace', { headers: bearer(writer) })
      expect(ok.status()).toBe(200)
      const asWriter: CostResponse = await ok.json()
      expect(asWriter.scoped).toBe(false)
      expect(asWriter.rows.map((r) => r.name).sort()).toEqual(asAdmin.rows.map((r) => r.name).sort())
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('the Cost page shows the table and totals, switches aggregate and window, and says when OpenCost is missing', async ({ page }) => {
    await page.goto('/cost?cluster=default')
    await expect(page.locator('h1')).toHaveText('Cost')
    await expect(page.getByRole('link', { name: 'Cost', exact: true })).toBeVisible()
    await expect(page.getByTestId('cost-table')).toBeVisible({ timeout: 20_000 })

    const body: CostResponse = await (await page.request.get('/api/v1/cluster/cost?cluster=default&window=24h&aggregate=namespace')).json()
    expect(body.rows.length).toBeGreaterThan(0)
    await expect(page.getByTestId('cost-row')).toHaveCount(body.rows.length)
    await expect(page.getByTestId('cost-total')).toHaveText(money(body.totals.total_cost))
    await expect(page.getByTestId('cost-row').first()).toContainText(body.rows[0].name)
    await expect(page.getByTestId('cost-source')).toContainText('opencost/opencost:9003')
    await expect(page.getByTestId('cost-scoped')).toHaveCount(0)

    // By workload: the request says aggregate=controller and the rows carry a kind.
    const [wlRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/v1/cluster/cost?') && r.url().includes('aggregate=controller')),
      page.getByTestId('cost-aggregate-controller').click(),
    ])
    expect(wlRes.status()).toBe(200)
    await expect(page.getByTestId('cost-row').filter({ hasText: 'DaemonSet' }).first()).toBeVisible()

    // Window: the dropdown's choice goes into the request.
    const [winRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/v1/cluster/cost?') && r.url().includes('window=1h')),
      (async () => {
        await page.getByTestId('cost-window').click()
        await page.getByTestId('cost-window-opt-1h').click()
      })(),
    ])
    expect(winRes.status()).toBe(200)

    // self has no OpenCost: the notice, no table.
    await page.goto('/cost?cluster=self')
    await expect(page.getByTestId('cost-not-installed')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('cost-not-installed')).toContainText(/OpenCost/)
    await expect(page.getByTestId('cost-table')).toHaveCount(0)
  })

  test('the optimization table of a cluster with OpenCost carries cost and saving columns, one without does not', async ({ page }) => {
    await page.goto('/?cluster=default')
    await page.locator('button').filter({ hasText: /Optimization suggestions|최적화 제안/ }).first().click()
    await expect(page.locator('h2').filter({ hasText: /Optimization suggestions|최적화 제안/ })).toBeVisible()
    await page.locator('button[title="Select namespace"], button[title="Namespace 선택"]').first().click()
    await page.getByRole('button', { name: 'kube-system', exact: true }).click()
    await expect(page.getByTestId('optimization-table')).toBeVisible({ timeout: 20_000 })

    const api: OptimizationResponse = await (await page.request.get('/api/v1/cluster/optimization?cluster=default&namespace=kube-system')).json()
    expect(api.pricing).toMatchObject({ source: 'opencost', window: '24h' })
    expect(api.pricing!.cpu_core_hour_usd).toBeGreaterThan(0)
    expect(api.rows.length).toBeGreaterThan(0)
    expect(api.rows.every((r) => typeof r.cost_month_usd === 'number')).toBeTruthy()

    await expect(page.getByTestId('optimization-pricing')).toContainText('OpenCost')
    await expect(page.getByTestId('optimization-cost')).toHaveCount(api.rows.length)
    const shown = (await page.getByTestId('optimization-cost').allTextContents()).sort()
    expect(shown).toEqual(api.rows.map((r) => money(r.cost_month_usd!)).sort())
    await expect(page.getByTestId('optimization-totals')).toContainText(money(api.totals.cost_month_usd!))

    await page.goto('/?cluster=self')
    await page.locator('button').filter({ hasText: /Optimization suggestions|최적화 제안/ }).first().click()
    await page.locator('button[title="Select namespace"], button[title="Namespace 선택"]').first().click()
    await page.getByRole('button', { name: 'kubeast', exact: true }).click()
    await expect(page.getByTestId('optimization-table')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('optimization-pricing')).toHaveCount(0)
    await expect(page.getByTestId('optimization-cost')).toHaveCount(0)
  })
})
