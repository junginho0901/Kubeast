import fs from 'node:fs'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// A list whose read failed says so — "Could not read the list: <the server's reason>" with Retry — instead of an
// empty list ("No items." read as "there are none": no audit rows, no alerts firing). And a list that keeps its
// rows when a later read fails says the read failed and that the rows are from before. Each read is answered in the
// browser with a 503 and a reason of its own; Retry after the stand-in is lifted reads the list again.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const REASON = 'e2e stand-in: the store did not answer'
const readFailed = EN.common.readFailed.replace('{{reason}}', REASON)

async function failReads(page: Page, pathname: string, when: (u: URL) => boolean = () => true): Promise<() => Promise<void>> {
  const match = (u: URL) => u.pathname === pathname && when(u)
  const handler = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ status: 503, json: { detail: REASON } })
  }
  await page.route(match, handler)
  return () => page.unroute(match, handler)
}

const LISTS: { screen: string; read: string; when?: (u: URL) => boolean }[] = [
  { screen: '/admin/clusters', read: '/api/v1/clusters', when: (u) => !u.searchParams.has('accessibleOnly') },
  { screen: '/admin/roles', read: '/api/v1/auth/roles' },
  { screen: '/admin/organizations', read: '/api/v1/auth/organizations' },
  { screen: '/admin/audit', read: '/api/v1/auth/admin/audit-logs' },
  { screen: '/admin/session-recordings', read: '/api/v1/cluster/recordings' },
  { screen: '/admin/ai-usage', read: '/api/v1/auth/admin/ai-usage' },
  { screen: '/admin/investigations', read: '/api/v1/ai/investigations' },
  { screen: '/alerts?cluster=self', read: '/api/v1/alerts/inbox' },
]

test.describe('a list whose read failed says so', () => {
  for (const l of LISTS) {
    test(`${l.screen}: the reason and Retry, not an empty list`, async ({ page }) => {
      const lift = await failReads(page, l.read, l.when)
      await page.goto(l.screen)
      test.skip(new URL(page.url()).pathname !== l.screen.split('?')[0], `${l.screen} is not on this install`)
      const row = page.getByTestId('table-load-error')
      await expect(row).toContainText(readFailed, { timeout: 20_000 })
      await expect(page.getByText(EN.common.listEmpty, { exact: true }), 'no "No items." beside it').toHaveCount(0)
      await lift()
      await row.getByTestId('table-load-error-retry').click()
      await expect(page.getByTestId('table-load-error'), 'Retry read the list again').toHaveCount(0, { timeout: 20_000 })
    })
  }

  test('/timeline: the reason and Retry, not "No events"', async ({ page }) => {
    const lift = await failReads(page, '/api/v1/cluster/timeline')
    await page.goto('/timeline?cluster=self')
    await expect(page.getByTestId('timeline-read-error')).toContainText(readFailed, { timeout: 20_000 })
    await lift()
    await page.getByTestId('timeline-read-error').getByRole('button', { name: EN.common.retry }).click()
    await expect(page.getByTestId('timeline-read-error')).toHaveCount(0, { timeout: 20_000 })
  })

  test("Dashboard → Top resources: pods the metrics API could not list say so with the server's reason", async ({ page }) => {
    // the answer k8s-service gives when the pod metrics read failed and the node one worked (pod_metrics_error)
    await page.route((u) => u.pathname === '/api/v1/cluster/metrics/top-resources', (route) => route.fulfill({
      json: { top_pods: [], top_nodes: [{ name: 'e2e-node', cpu: '100m', cpu_percent: '5%', memory: '200Mi', memory_percent: '10%' }], pod_metrics_error: REASON },
    }))
    await page.goto('/?cluster=self')
    const card = page.getByTestId('top-pods-metrics-error')
    await expect(card).toContainText(EN.dashboard.topPods.metricsError, { timeout: 30_000 })
    await expect(card).toContainText(REASON)
  })

  test('/admin/audit: a Refresh that fails keeps the rows and says they are from before', async ({ page }) => {
    await page.goto('/admin/audit')
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 20_000 })
    const before = await page.locator('tbody tr').count()
    const lift = await failReads(page, '/api/v1/auth/admin/audit-logs')
    await page.getByRole('button', { name: EN.adminAudit.refresh, exact: true }).click()
    const line = page.getByTestId('refresh-failed')
    await expect(line).toHaveText(new RegExp(`^Refresh failed at \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}: ${REASON}$`), { timeout: 20_000 })
    expect(await page.locator('tbody tr').count(), 'the rows stay').toBe(before)
    await lift()
    await page.getByRole('button', { name: EN.adminAudit.refresh, exact: true }).click()
    await expect(line, 'a read that works takes the line away').toHaveCount(0, { timeout: 20_000 })
  })
})
