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
    // The page title is the screen's one h1.
    await expect(page.locator('h1.text-3xl').first()).toContainText(/Dashboard/i)

    // Mask the dynamic data regions: pod-name hashes change on every
    // restart, CPU/Memory percentages refresh every 5s (the Prometheus
    // utilization card too, when the cluster has Prometheus), and the
    // object counts and the pod status bars move with whatever the dev
    // clusters run. We compare layout, not values.
    await expect(page).toHaveScreenshot('dashboard-initial.png', {
      fullPage: true,
      animations: 'disabled',
      maxDiffPixels: 500,
      mask: [
        page.locator('[data-testid^="stat-value-"]'),
        page.locator('.card').filter({ hasText: /^Pod (status|상태)/i }),
        page.locator('.card').filter({ hasText: /top.*pod|top.*파드/i }),
        page.locator('.card').filter({ hasText: /top.*node|top.*노드/i }),
        page.locator('.card').filter({ hasText: /Cluster Resource Utilization|클러스터 리소스/i }),
      ],
    })
  })

  test('Refresh reads the page again for this cluster with the cards kept on screen and no list per namespace', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const pods = page.getByTestId('stat-value-pods')
    await expect(pods).toBeVisible()
    // note whether the card ever leaves the page (the skeleton replacing it) after the click
    await page.evaluate(() => {
      const w = window as unknown as { __statGone: boolean }
      w.__statGone = false
      new MutationObserver(() => { if (!document.querySelector('[data-testid="stat-value-pods"]')) w.__statGone = true })
        .observe(document.body, { childList: true, subtree: true })
    })
    const asked: string[] = []
    page.on('request', (r) => { if (r.url().includes('/api/v1/')) asked.push(new URL(r.url()).pathname) })

    const refresh = page.getByRole('button', { name: /refresh|새로고침/i })
    const overview = page.waitForResponse((r) => r.url().includes('/api/v1/cluster/overview'))
    await refresh.click()
    expect((await overview).status()).toBe(200)
    await expect(refresh).toBeEnabled()
    // soft, so a run on old code records each difference
    expect.soft(await page.evaluate(() => (window as unknown as { __statGone: boolean }).__statGone), 'the cards stay while the page reads again').toBe(false)
    expect.soft(asked.filter((p) => /\/namespaces\/[^/]+\/(services|deployments)$/.test(p)), 'no Services or Deployments list per namespace').toEqual([])
    expect.soft(asked.filter((p) => p.endsWith('/cluster/nodes')).length, 'the nodes read again').toBeGreaterThan(0)
  })
})
