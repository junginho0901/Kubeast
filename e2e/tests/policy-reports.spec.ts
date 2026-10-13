import { test, expect, type APIRequestContext } from '@playwright/test'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Policy reports (wgpolicyk8s.io): /api/v1/cluster/policyreports/* and Security → Policy Reports read what
// Kyverno wrote on the second kind cluster (`default`: Kyverno 1.19 with two Audit policies, see
// deploy/kind/kyverno-*.yaml); `self` has no PolicyReport CRD and says so. A throwaway namespace with a
// Deployment that breaks both policies gets its rows within the admission report cycle; removed at the end.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-polrep-throwaway-1!'
const stamp = Date.now().toString(36)
const NS = `e2e-polrep-${stamp}`
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

type Counts = { pass: number; fail: number; warn: number; error: number; skip: number }
type Summary = { reports: number; truncated: boolean; scoped: boolean; totals: Counts; policies: ({ policy: string; namespaces: string[] } & Counts)[]; namespaces: ({ namespace: string; policies: number } & Counts)[] }
type Row = { namespace: string; kind: string; name: string; policy: string; rule?: string; result: string; severity?: string; message?: string; report: string }
type Results = { total: number; truncated: boolean; rows: Row[] }

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-polrep-'))
  const kcPath = path.join(dir, 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  const run = (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  return { run }
}
const { run: kubectl } = kubectlFor('kubeast-b')

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E policy reports', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  return (await res.json()).id
}

// What the cluster holds: every result row of every PolicyReport in a namespace (or all), counted by result.
function clusterCounts(namespace?: string): Counts {
  const scope = namespace ? `-n ${namespace}` : '-A'
  const json = JSON.parse(kubectl(`get policyreports ${scope} -o json`))
  const counts: Counts = { pass: 0, fail: 0, warn: 0, error: 0, skip: 0 }
  for (const item of json.items) for (const r of item.results || []) if (r.result in counts) counts[r.result as keyof Counts]++
  return counts
}

test.describe('policy reports', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(() => {
    kubectl(`create namespace ${NS}`)
    // Breaks both Audit policies: no app.kubernetes.io/name label, a :latest image (never pulled; the report is about the spec).
    const manifest = path.join(os.tmpdir(), `${NS}-deploy.json`)
    fs.writeFileSync(manifest, JSON.stringify({
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'latest-web', namespace: NS },
      spec: { replicas: 1, selector: { matchLabels: { app: 'latest-web' } }, template: { metadata: { labels: { app: 'latest-web' } }, spec: { containers: [{ name: 'web', image: 'nginx:latest' }] } } },
    }))
    kubectl(`apply -f ${manifest}`)
  })
  test.afterAll(() => {
    try { kubectl(`delete namespace ${NS} --wait=false`) } catch { /* already gone */ }
  })

  test('status and features: the second cluster serves PolicyReports, self does not, and a bad query is refused', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const features = await (await request.get('/api/v1/cluster/features?cluster=default', { headers: bearer(admin) })).json()
    expect(features.policyReports).toEqual({ enabled: true })
    const status = await (await request.get('/api/v1/cluster/policyreports/status?cluster=default', { headers: bearer(admin) })).json()
    expect(status).toMatchObject({ enabled: true, installed: true, group: 'wgpolicyk8s.io/v1alpha2' })
    const none = await (await request.get('/api/v1/cluster/policyreports/status?cluster=self', { headers: bearer(admin) })).json()
    expect(none).toMatchObject({ enabled: true, installed: false })
    // The data routes answer an empty list with the not-installed header on self.
    const missing = await request.get('/api/v1/cluster/policyreports/summary?cluster=self', { headers: bearer(admin) })
    expect(missing.status()).toBe(200)
    expect(missing.headers()['x-kubeast-not-installed']).toBe('policyreports')
    expect(await missing.json()).toEqual([])
    const bad = await request.get(`/api/v1/cluster/namespaces/${NS}/policyreports/resource?cluster=default`, { headers: bearer(admin), failOnStatusCode: false })
    expect(bad.status()).toBe(400)
  })

  test('the summary counts what the cluster holds, per policy and per namespace, and the fixture shows up with both failures', async ({ request }) => {
    test.setTimeout(240_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    // Kyverno writes a new object's reports ~20 s (Pod, Deployment) to ~40 s (ReplicaSet) after it is created
    // (raw step4-report-latency.log). force_refresh reads past the server's minute cache, as the refresh button does.
    await expect.poll(async () => {
      const res: Results = await (await request.get(`/api/v1/cluster/policyreports/results?cluster=default&namespace=${NS}&force_refresh=true`, { headers: bearer(admin) })).json()
      if (Array.isArray(res)) return -1
      return ['Pod', 'Deployment', 'ReplicaSet'].map((k) => res.rows.filter((r) => r.kind === k && r.result === 'fail').length).join(',')
    }, { timeout: 150_000, intervals: [5000] }).toBe('2,2,2')
    const fixture: Results = await (await request.get(`/api/v1/cluster/policyreports/results?cluster=default&namespace=${NS}&result=pass,fail,warn,error,skip&force_refresh=true`, { headers: bearer(admin) })).json()
    expect(fixture.rows.every((r) => r.namespace === NS)).toBeTruthy()
    expect(fixture.rows.some((r) => r.kind === 'Pod' && r.policy === 'disallow-latest-tag' && r.result === 'fail' && /latest/.test(r.message || ''))).toBeTruthy()

    const summary: Summary = await (await request.get('/api/v1/cluster/policyreports/summary?cluster=default&force_refresh=true', { headers: bearer(admin) })).json()
    const held = clusterCounts()
    expect(summary.totals.fail).toBeGreaterThan(0)
    // Two reads seconds apart: the report set can grow by a scan, so compare within a few rows.
    for (const k of ['fail', 'warn', 'error', 'pass', 'skip'] as const) expect(Math.abs(summary.totals[k] - held[k])).toBeLessThanOrEqual(5)
    expect(summary.scoped).toBe(false)
    expect(summary.reports).toBeGreaterThanOrEqual(Number(kubectl('get policyreports -A --no-headers | wc -l')) - 5)
    const requireLabels = summary.policies.find((p) => p.policy === 'require-labels')
    expect(requireLabels, 'require-labels row').toBeTruthy()
    expect(requireLabels!.fail).toBeGreaterThan(0)
    expect(requireLabels!.namespaces).toContain('kube-system')
    expect(requireLabels!.namespaces).toContain(NS)
    // Highest failures first.
    for (let i = 1; i < summary.policies.length; i++) expect(summary.policies[i - 1].fail).toBeGreaterThanOrEqual(summary.policies[i].fail)
    // Kyverno's autogen reports on the Deployment and ReplicaSet too, so the namespace holds 2 fails per object.
    const nsHeld = clusterCounts(NS)
    expect(nsHeld.fail).toBeGreaterThanOrEqual(2)
    const nsRow = summary.namespaces.find((n) => n.namespace === NS)
    expect(nsRow).toMatchObject({ fail: nsHeld.fail, policies: 2 })
    const one: Summary = await (await request.get(`/api/v1/cluster/policyreports/summary?cluster=default&namespace=${NS}&force_refresh=true`, { headers: bearer(admin) })).json()
    expect(one.totals).toEqual(clusterCounts(NS))
    expect(one.namespaces.map((n) => n.namespace)).toEqual([NS])

    // A workload's rows: its own (autogen) and its pod's, never the ReplicaSet's or another object's.
    const forDeploy = await (await request.get(`/api/v1/cluster/namespaces/${NS}/policyreports/resource?cluster=default&kind=Deployment&name=latest-web`, { headers: bearer(admin) })).json()
    const podName = kubectl(`get pods -n ${NS} -l app=latest-web -o jsonpath={.items[0].metadata.name}`)
    expect(forDeploy.rows.filter((r: Row) => r.kind === 'Pod' && r.name === podName && r.result === 'fail').length).toBe(2)
    expect(forDeploy.rows.filter((r: Row) => r.kind === 'Deployment' && r.name === 'latest-web' && r.result === 'fail').length).toBe(2)
    expect(forDeploy.rows.every((r: Row) => (r.kind === 'Deployment' && r.name === 'latest-web') || (r.kind === 'Pod' && r.name === podName))).toBeTruthy()
    expect(forDeploy.totals.fail).toBe(forDeploy.rows.filter((r: Row) => r.result === 'fail').length)
  })

  test('a Read grant reads (aggregate-to-view), a cluster without a grant refuses, and a namespace scope narrows the summary once the cluster binds its group', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const email = `e2e-polrep-${stamp}@kubeast.local`
    let userId = ''
    try {
      userId = await createUser(request, admin, email)
      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/default`, { headers: bearer(admin), data: { role: 'Read' } })).ok()).toBeTruthy()
      const reader = await login(request, email, PW)
      const ok = await request.get('/api/v1/cluster/policyreports/summary?cluster=default', { headers: bearer(reader) })
      expect(ok.status()).toBe(200)
      const asReader: Summary = await ok.json()
      expect(asReader.scoped).toBe(false)
      expect(asReader.totals.fail).toBeGreaterThan(0)
      const refused = await request.get('/api/v1/cluster/policyreports/summary?cluster=self', { headers: bearer(reader), failOnStatusCode: false })
      expect(refused.status()).toBe(403)

      // A namespace-scoped Read acts as group kubeast:role:read, which the dev second cluster binds nowhere:
      // the cluster refuses until the namespace binds the group to `view` (Kyverno aggregates report read into it).
      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/default`, { headers: bearer(admin), data: { role: 'Read', namespaces: [NS] } })).ok()).toBeTruthy()
      const scopedToken = await login(request, email, PW)
      const unbound = await request.get('/api/v1/cluster/policyreports/summary?cluster=default', { headers: bearer(scopedToken), failOnStatusCode: false })
      expect(unbound.status()).toBe(403)
      kubectl(`-n ${NS} create rolebinding e2e-polrep-view --clusterrole=view --group=kubeast:role:read`)
      const scoped: Summary = await (await request.get('/api/v1/cluster/policyreports/summary?cluster=default', { headers: bearer(scopedToken) })).json()
      expect(scoped.scoped).toBe(true)
      expect(scoped.namespaces.map((n) => n.namespace)).toEqual([NS])
      expect(scoped.totals).toEqual(clusterCounts(NS))
      const outside = await request.get('/api/v1/cluster/policyreports/summary?cluster=default&namespace=kube-system', { headers: bearer(scopedToken), failOnStatusCode: false })
      expect(outside.status()).toBe(403)
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('the page shows the tabs, the stats, the results of the fixture and the drawer section; self says not installed', async ({ page }) => {
    await page.goto('/security/policyreports?cluster=default')
    await expect(page.locator('h1')).toHaveText('Policy Reports')
    await expect(page.getByRole('link', { name: 'Policy Reports', exact: true })).toBeVisible()
    await expect(page.getByTestId('policy-reports-table')).toBeVisible({ timeout: 20_000 })
    const summary: Summary = await (await page.request.get('/api/v1/cluster/policyreports/summary?cluster=default')).json()
    await expect(page.getByTestId('policy-reports-stat-fail')).toHaveText(String(summary.totals.fail))
    await expect(page.getByTestId('policy-report-row')).toHaveCount(Math.min(summary.policies.length, 100))
    await expect(page.getByTestId('policy-report-row').first()).toContainText(summary.policies[0].policy)

    await page.getByTestId('policy-reports-tab-namespaces').click()
    await expect(page.getByTestId('policy-reports-table')).toHaveAttribute('data-tab', 'namespaces')
    await expect(page.getByTestId('policy-report-row').filter({ hasText: NS })).toHaveCount(1)

    // Results of the fixture namespace: its failures; the first row opens that object's drawer, whose
    // "Policy violations" section lists the same fail/warn/error rows the resource endpoint returns.
    await page.getByTestId('policy-reports-tab-results').click()
    await page.getByTestId('policy-reports-namespace').click()
    await page.getByTestId(`policy-reports-namespace-opt-${NS}`).click()
    const results: Results = await (await page.request.get(`/api/v1/cluster/policyreports/results?cluster=default&namespace=${NS}`)).json()
    await expect(page.getByTestId('policy-report-row')).toHaveCount(results.rows.length)
    await expect(page.getByTestId('policy-report-result').first()).toHaveText('fail')
    const first = results.rows[0]
    const forFirst = await (await page.request.get(`/api/v1/cluster/namespaces/${NS}/policyreports/resource?cluster=default&kind=${first.kind}&name=${first.name}`)).json()
    await page.getByTestId('policy-report-row').first().click()
    await expect(page.getByTestId('policy-violations')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('policy-violation-row')).toHaveCount(forFirst.rows.filter((r: Row) => ['fail', 'warn', 'error'].includes(r.result)).length)

    await page.goto('/security/policyreports?cluster=self')
    await expect(page.getByTestId('policy-reports-not-installed')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('policy-reports-table')).toHaveCount(0)
  })
})
