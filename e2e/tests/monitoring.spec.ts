import { test, expect } from '@playwright/test'

// Monitoring page — split in Phase 0 (Monitoring.tsx 739 → 93 + 4
// sub-files). Both tabs (Nodes / Pods) are mounted on demand so we
// exercise both.

test.describe('Monitoring', () => {
  test('Nodes tab — initial render', async ({ page }) => {
    await page.goto('/monitoring')
    await page.waitForLoadState('networkidle')
    // Page title is the stable selector (i18n: "리소스 모니터링" / "Resource Monitoring").
    await expect(page.locator('h1.text-3xl').first()).toBeVisible()

    // Each node card shows live CPU/Memory percentages + progress bars
    // that move every 5s. Mask the per-node card bodies plus the
    // "Metrics sampled at <time>" / "Auto refresh every Ns" header
    // strip — both update on every render. The surrounding page chrome
    // (header, layout, tab buttons) is what we want to catch
    // regressions on.
    await expect(page).toHaveScreenshot('monitoring-nodes.png', {
      fullPage: true,
      animations: 'disabled',
      // Header strip text ("Metrics sampled at <time>", etc.) has
      // variable glyph width, so the mask boxes don't perfectly align
      // between baseline and actual. Bump the per-pixel tolerance just
      // for this spec — 500/1.3M pixels (~0.04 %) is well below any
      // meaningful UI change.
      maxDiffPixels: 500,
      mask: [
        page.locator('.bg-slate-700.rounded-lg'),
        page.locator('text=/Metrics sampled at|메트릭 기준 수집 시각/'),
        page.locator('text=/Auto refresh every/'),
        page.locator('text=/Data labels/'),
        page.locator('text=/Total \\d+ node/'),
      ],
    })
  })

  test('Pods tab — switch and render', async ({ page }) => {
    await page.goto('/monitoring')
    await page.waitForLoadState('networkidle')

    // The two tab buttons are the only buttons containing "Pod" /
    // "파드" in the page header — match by accessible name.
    await page.getByRole('button', { name: /pod resources|pod 리소스/i }).first().click()
    await page.waitForLoadState('networkidle')

    await expect(page).toHaveScreenshot('monitoring-pods-empty.png', {
      fullPage: true,
      animations: 'disabled',
    })
  })
})
