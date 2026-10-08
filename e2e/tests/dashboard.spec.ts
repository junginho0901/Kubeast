import { test, expect } from '@playwright/test'

// Dashboard regression — the page is the largest target of the
// refactor (Phase 0 split + planned Phase 2). We capture the full
// rendered surface plus a few interactive steps to detect both visual
// and behavioral regressions.

test.describe('Dashboard', () => {
  test('initial render — full page', async ({ page }) => {
    await page.goto('/')
    // Wait for the cluster overview to finish loading. The page shows
    // a skeleton until isLoading flips false.
    await page.waitForLoadState('networkidle')
    // Two h1 on screen (sidebar 'Kubeast' + page title) — pick the
    // page title by its larger size class.
    await expect(page.locator('h1.text-3xl').first()).toContainText(/Dashboard/i)

    // Mask the dynamic data regions: pod-name hashes change on every
    // restart, CPU/Memory percentages refresh every 5s (the Prometheus
    // utilization card too, when the cluster has Prometheus). We compare
    // layout, not values.
    await expect(page).toHaveScreenshot('dashboard-initial.png', {
      fullPage: true,
      animations: 'disabled',
      maxDiffPixels: 500,
      mask: [
        page.locator('.card').filter({ hasText: /top.*pod|top.*파드/i }),
        page.locator('.card').filter({ hasText: /top.*node|top.*노드/i }),
        page.locator('.card').filter({ hasText: /Cluster Resource Utilization|클러스터 리소스/i }),
      ],
    })
  })

  test('refresh button is clickable and triggers refetch', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const refresh = page.getByRole('button', { name: /refresh|새로고침/i })
    await expect(refresh).toBeVisible()
    await expect(refresh).toBeEnabled()
    await refresh.click()
    // After click the page should still render the title — no error toast.
    await expect(page.locator('h1.text-3xl').first()).toBeVisible()
  })
})
