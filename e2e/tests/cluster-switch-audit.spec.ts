import { test, expect, type APIRequestContext } from '@playwright/test'

// Switching clusters in the picker leaves a `user.cluster.switch` audit row
// (POST /api/v1/audit/cluster-switch, fired by ClusterProvider.setCurrentCluster).
// The picker's initial auto-select is not a switch and must not record one.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), 'admin login should succeed — set E2E_USER_EMAIL / E2E_USER_PASSWORD').toBeTruthy()
  return (await res.json()).access_token
}

async function switchRows(request: APIRequestContext, token: string, since: string) {
  const res = await request.get('/api/v1/auth/admin/audit-logs', {
    headers: { Authorization: `Bearer ${token}` },
    params: { action: 'user.cluster.switch', since, limit: 20 },
  })
  expect(res.ok()).toBeTruthy()
  const { items } = (await res.json()) as { items: Array<Record<string, any>> | null }
  return items ?? [] // the API answers `items: null` for an empty page
}

test.describe('cluster switch audit', () => {
  test('picking another cluster records user.cluster.switch with previous and new', async ({ page, request }) => {
    const since = new Date(Date.now() - 5000).toISOString()

    await page.goto('/?cluster=self')
    await page.waitForLoadState('networkidle')
    const picker = page.getByTestId('cluster-picker')
    await expect(picker).toContainText('self', { timeout: 15000 })

    const audited = page.waitForResponse((r) => r.url().includes('/api/v1/audit/cluster-switch'))
    await picker.click()
    await page.getByTestId('cluster-option-default').click()
    expect((await audited).status()).toBe(204)
    await expect(picker).toContainText('default', { timeout: 15000 })

    const token = await adminToken(request)
    const rows = await switchRows(request, token, since)
    const mine = rows.filter((r) => {
      const after = r.After ?? r.after ?? {}
      return after.previous === 'self' && after.new === 'default'
    })
    expect(mine.length, 'one user.cluster.switch row for self → default').toBeGreaterThanOrEqual(1)
    expect(mine[0].Cluster ?? mine[0].cluster, 'cluster column = the new cluster').toBe('default')
  })

  test('loading a page with the cluster already chosen records nothing', async ({ page, request }) => {
    // Compare the newest row before and after instead of a time window: the
    // previous test's row can be less than a second old when this one starts.
    const token = await adminToken(request)
    const since = new Date(Date.now() - 3_600_000).toISOString()
    const newestId = (rows: Array<Record<string, any>>) => rows[0]?.ID ?? rows[0]?.id ?? null
    const before = newestId(await switchRows(request, token, since))
    let posted = 0
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/audit/cluster-switch')) posted++
    })

    await page.goto('/?cluster=self')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('cluster-picker')).toContainText('self', { timeout: 15000 })
    expect(posted, 'no audit call for the initial selection').toBe(0)

    const after = newestId(await switchRows(request, token, since))
    expect(after, 'no new user.cluster.switch row').toBe(before)
  })
})
