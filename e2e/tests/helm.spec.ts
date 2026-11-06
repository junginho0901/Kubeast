import { test, expect } from '@playwright/test'

// Helm Releases page — streams release updates over a long-lived SSE
// connection (helm/releases/stream). Since step 04b made that stream
// cluster-aware and actually long-lived, the page never reaches
// 'networkidle' — wait on DOM mount + the heading instead (same pattern as
// sse-migration.spec.ts). Captures the list view + (if any release exists)
// the detail page.

test.describe('Helm Releases', () => {
  test('list — initial render', async ({ page }) => {
    await page.goto('/helm/releases')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('h1.text-3xl').first()).toContainText(/helm/i)

    await expect(page).toHaveScreenshot('helm-releases-list.png', {
      fullPage: true,
      animations: 'disabled',
    })
  })

  test('detail — first release if present', async ({ page }) => {
    await page.goto('/helm/releases')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('h1.text-3xl').first()).toContainText(/helm/i)

    // Find the first release row link (if any).
    const firstRow = page.locator('tbody tr').first()
    const hasReleases = (await firstRow.count()) > 0

    test.skip(!hasReleases, 'no releases in this cluster — skipping detail snapshot')

    await firstRow.click()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('h1.text-3xl').first()).toBeVisible()

    await expect(page).toHaveScreenshot('helm-release-detail.png', {
      fullPage: true,
      animations: 'disabled',
    })
  })

  // The release is this install itself (kubeast in namespace kubeast on cluster self) and the failure is the browser's
  // own answer: no test pod runs.
  test('a failed test run shows the reason, not that the chart has no hooks', async ({ page }) => {
    const detail = await page.request.get('/api/v1/helm/releases/kubeast/kubeast?cluster=self', { failOnStatusCode: false })
    test.skip(!detail.ok(), `no Helm release kubeast/kubeast on cluster self (${detail.status()})`)
    await page.route('**/api/v1/helm/releases/kubeast/kubeast/test*', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'pod kubeast-test failed' }),
    }))
    await page.goto('/helm/releases/kubeast/kubeast?cluster=self')
    await page.getByRole('button', { name: /^(run tests|테스트 실행)$/i }).click()
    await expect(page.getByText('pod kubeast-test failed')).toHaveText('pod kubeast-test failed')
    await expect(page.getByText(/This chart defines no test hooks|test hook 이 정의되어 있지 않습니다/)).toHaveCount(0)
  })
})
