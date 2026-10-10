import { test, expect, type APIRequestContext } from '@playwright/test'

// Dashboard quick actions after the rework: "Check issues" shows the rows of
// /api/v1/cluster/issues (deploy/kind/fixtures.yaml leaves an unschedulable
// Deployment and a failed Job on `self`), "Optimization" shows the table from
// /api/v1/cluster/optimization before any model call (the second cluster has
// metrics-server + Prometheus, `self` has neither), and "Storage" shows each
// PVC's usage or an honest N/A (kind's local-path driver reports no stats).

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  const token = (await res.json()).access_token as string
  return { Authorization: `Bearer ${token}` }
}

test.describe('Dashboard quick actions', () => {
  test('issues API lists the broken fixtures with severity and reason', async ({ request }) => {
    const admin = await adminHeaders(request)
    const body = await (await request.get('/api/v1/cluster/issues?cluster=self', { headers: admin })).json()
    expect(body.window_minutes).toBe(60)
    const byId = Object.fromEntries(body.issues.map((i: any) => [i.id, i]))

    const dep = byId['Deployment/default/e2e-unschedulable']
    expect(dep, 'unschedulable Deployment missing — re-apply deploy/kind/fixtures.yaml').toBeTruthy()
    expect(dep.severity).toBe('critical')
    expect(['ProgressDeadlineExceeded', 'Unavailable']).toContain(dep.reason)
    expect(dep.message).toContain('available 0/1')

    const job = byId['Job/default/e2e-failing-job']
    expect(job, 'failing Job missing — re-apply deploy/kind/fixtures.yaml').toBeTruthy()
    expect(job.severity).toBe('warning')
    expect(job.reason).toBe('Failed')

    const pending = body.issues.find((i: any) => i.kind === 'Pod' && i.name.startsWith('e2e-unschedulable-'))
    expect(pending.severity).toBe('warning')
    expect(pending.reason).toContain('Phase Pending')

    for (const i of body.issues) {
      expect(['critical', 'warning', 'info']).toContain(i.severity)
      expect(i.id).toBe(i.namespace ? `${i.kind}/${i.namespace}/${i.name}` : `${i.kind}/${i.name}`)
    }

    const narrow = await (await request.get('/api/v1/cluster/issues?cluster=self&window=1', { headers: admin })).json()
    expect(narrow.window_minutes).toBe(1)
    const bad = await request.get('/api/v1/cluster/issues?cluster=self&window=0', { headers: admin })
    expect((await bad.json()).window_minutes).toBe(60)
  })

  test('Check issues modal groups the fixtures per kind, searches, and switches the window', async ({ page }) => {
    await page.goto('/?cluster=self')
    await page.locator('button').filter({ hasText: /Check issues|이슈 확인/ }).first().click()
    await expect(page.locator('h2').filter({ hasText: /^Issues$|^이슈$/ })).toBeVisible()

    await expect(page.getByTestId('issues-kind-Deployment').getByText('e2e-unschedulable')).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('issues-kind-Job').getByText('e2e-failing-job')).toBeVisible()
    await expect(page.getByTestId('issues-kind-Deployment')).toContainText(/available 0\/1/)

    const defaultWindow = page.getByTestId('issues-window-60')
    await expect(defaultWindow).toHaveAttribute('aria-pressed', 'true')
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/v1/cluster/issues') && r.url().includes('window=360')),
      page.getByTestId('issues-window-360').click(),
    ])
    expect(req.url()).toContain('window=360')
    await expect(page.getByTestId('issues-window-360')).toHaveAttribute('aria-pressed', 'true')

    await page.getByPlaceholder(/Search issues|이슈 검색/).fill('e2e-failing-job')
    await expect(page.getByTestId('issues-kind-Job').getByText('e2e-failing-job')).toBeVisible()
    await expect(page.getByTestId('issues-kind-Deployment')).toHaveCount(0)

    // A row opens the drawer of that object.
    await page.getByPlaceholder(/Search issues|이슈 검색/).fill('e2e-unschedulable')
    await page.getByTestId('issues-kind-Deployment').getByTestId('issue-row').first().click()
    await expect(page.locator('h2').filter({ hasText: /^Issues$|^이슈$/ })).toHaveCount(0)
    await expect(page.getByText('e2e-unschedulable').first()).toBeVisible({ timeout: 10000 })
  })

  test('optimization API sizes from usage where there is some and says "none" where there is not', async ({ request }) => {
    const admin = await adminHeaders(request)
    const self = await (await request.get('/api/v1/cluster/optimization?cluster=self&namespace=default', { headers: admin })).json()
    expect(self.namespace).toBe('default')
    expect(self.window_hours).toBe(24)
    expect(self.source).toBe('none')
    const sleep = self.rows.find((r: any) => r.kind === 'Deployment' && r.name === 'e2e-argo-managed')
    expect(sleep, 'e2e-argo-managed row missing').toBeTruthy()
    expect(sleep.cpu_usage_m).toBeUndefined()
    expect(sleep.flags).toEqual(['no_cpu_request', 'no_mem_request', 'no_mem_limit'])

    const withUsage = await (await request.get('/api/v1/cluster/optimization?cluster=default&namespace=kube-system', { headers: admin })).json()
    expect(['prometheus', 'metrics-server']).toContain(withUsage.source)
    const measured = withUsage.rows.filter((r: any) => r.cpu_usage_m != null && r.mem_usage_bytes != null)
    expect(measured.length).toBeGreaterThan(0)
    for (const r of measured) {
      expect(r.cpu_recommend_m).toBeGreaterThanOrEqual(10)
      expect(r.cpu_recommend_m % 5).toBe(0)
      expect(r.mem_recommend_bytes).toBeGreaterThanOrEqual(100 * 1024 * 1024)
    }
    expect(withUsage.totals.pods).toBeGreaterThan(0)

    const missing = await request.get('/api/v1/cluster/optimization?cluster=self', { headers: admin, failOnStatusCode: false })
    expect(missing.status()).toBe(400)
  })

  test('Optimization modal shows the table and the source before any model call', async ({ page }) => {
    await page.goto('/?cluster=default')
    await page.locator('button').filter({ hasText: /Optimization suggestions|최적화 제안/ }).first().click()
    await expect(page.locator('h2').filter({ hasText: /Optimization suggestions|최적화 제안/ })).toBeVisible()

    // kube-system has pods with usage on the second cluster.
    await page.locator('button[title="Select namespace"], button[title="Namespace 선택"]').first().click()
    await page.getByRole('button', { name: 'kube-system', exact: true }).click()

    await expect(page.getByTestId('optimization-table')).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('optimization-source')).toContainText(/Prometheus|metrics-server/)
    expect(await page.getByTestId('optimization-row').count()).toBeGreaterThan(0)
    await expect(page.getByTestId('optimization-totals')).toBeVisible()
    await expect(page.getByTestId('optimization-ai')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Explain with AI$|^AI 설명$/ })).toBeEnabled()
  })

  test('Storage modal shows PVC usage or N/A with the reason', async ({ page }) => {
    await page.goto('/?cluster=self')
    await page.locator('button').filter({ hasText: /Storage analysis|스토리지 분석/ }).first().click()
    await expect(page.locator('h2').filter({ hasText: /Storage analysis|스토리지 분석/ })).toBeVisible()
    const usage = page.getByTestId('pvc-usage').or(page.getByTestId('pvc-usage-na'))
    await expect(usage.first()).toBeVisible({ timeout: 20000 })
    // a usage bar carries its percent; N/A says why in its tooltip
    const measured = page.getByTestId('pvc-usage').first()
    if (await measured.count()) {
      const percent = Number(await measured.getByRole('progressbar').getAttribute('aria-valuenow'))
      expect(percent).toBeGreaterThanOrEqual(0)
      expect(percent).toBeLessThanOrEqual(100)
    } else {
      expect(await page.getByTestId('pvc-usage-na').first().getAttribute('title')).toMatch(/CSI|Prometheus/)
    }
  })
})
