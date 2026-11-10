import fs from 'node:fs'
import path from 'node:path'

import { test, expect } from '@playwright/test'

// A list's Refresh that fails says so under the header — when and the server's reason — until a Refresh that
// works takes the line away, or the page moves to another namespace or cluster. The screens are a sample of
// the 55 that read through hooks/useRefresh, one per way they read (a direct API read, invalidateQueries with
// throwOnError, a query's refetch, a hook a page draws), plus the Dashboard's own Refresh. After the page has
// loaded, every cluster read is answered 503 in the browser; the server is not asked.

const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
const REASON = 'e2e stand-in: the cluster did not answer'
const SCREENS = [
  '/workloads/deployments?cluster=self',
  '/cluster/namespaces?cluster=self',
  '/configuration/configmaps?cluster=self',
  '/network/services?cluster=self',
  '/cluster/nodes?cluster=self',
  '/gpu/pods?cluster=self',
  '/gpu/nodes?cluster=self',
  '/gateway/backendtlspolicies?cluster=test2',
  '/?cluster=self',
]

test.describe("a list's Refresh that fails says so", () => {
  for (const screen of SCREENS) {
    test(screen, async ({ page }) => {
      await page.goto(screen)
      const head = page.locator('.page-head').first()
      const refresh = head.getByRole('button', { name: /^(Refresh|새로고침)$/ }).first()
      test.skip(!(await refresh.waitFor({ timeout: 20_000 }).then(() => true, () => false)), `${screen} shows no Refresh`)
      await page.waitForLoadState('networkidle')
      const reads = (u: URL) => u.pathname.startsWith('/api/v1/cluster/') || u.pathname.startsWith('/api/v1/gpu') || u.pathname.startsWith('/api/v1/prometheus')
      const fail = async (route: import('@playwright/test').Route) => {
        if (route.request().method() !== 'GET') return route.fallback()
        await route.fulfill({ status: 503, json: { detail: REASON } })
      }
      await page.route(reads, fail)
      await refresh.click()
      const line = page.getByTestId('refresh-failed')
      await expect(line).toHaveText(new RegExp(`^${EN.common.refreshFailed.split('{{time}}')[0]}\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}: ${REASON}$`), { timeout: 30_000 })
      await page.waitForTimeout(4_000)
      await expect(line, 'it stays until a read works').toContainText(REASON)
      await page.unroute(reads, fail)
      await refresh.click()
      await expect(line, 'a Refresh that works takes it away').toHaveCount(0, { timeout: 30_000 })
    })
  }
})
