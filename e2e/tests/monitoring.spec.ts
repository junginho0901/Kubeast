import { test, expect } from '@playwright/test'

import { pagerRange, readEveryPage } from './list-pages'

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
        // the node rows' live numbers and bars
        page.getByTestId('monitoring-node'),
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

  // A gateway or a cluster failing for a moment is an error, and the screen comes back by itself. Only the answer that
  // says metrics-server is missing stops the polling and puts up that notice. Cluster default runs metrics-server.
  test.describe('a failed metrics read', () => {
    const MISSING = /Metrics server not available for this cluster|이 클러스터에 메트릭 서버가 없습니다/
    const gateway503 = { status: 503, contentType: 'text/plain', body: 'gateway temporarily unavailable' }

    test('a 503 on the node metrics is an error, and the Nodes tab recovers by itself', async ({ page }) => {
      let failing = true
      await page.route('**/api/v1/cluster/metrics/nodes*', (route) => (failing ? route.fulfill(gateway503) : route.continue()))
      await page.goto('/monitoring?cluster=default')
      await expect(page.getByTestId('node-metrics-error')).toHaveText(/Failed to load node metrics|Node 메트릭을 불러오는/, { timeout: 30_000 })
      await expect(page.getByText(MISSING)).toHaveCount(0)

      failing = false
      await expect.poll(() => page.getByTestId('monitoring-node').count(), { timeout: 30_000 }).toBeGreaterThan(0)
      await expect(page.getByTestId('node-metrics-error')).toHaveCount(0)
    })

    test('a 503 on the pod metrics is an error, and the Pods tab recovers by itself', async ({ page }) => {
      let failing = true
      await page.route('**/api/v1/cluster/metrics/pods*', (route) => (failing ? route.fulfill(gateway503) : route.continue()))
      await page.goto('/monitoring?cluster=default')
      await page.getByRole('button', { name: /pod resources|pod 리소스/i }).first().click()
      await page.getByTestId('monitoring-namespace').click()
      await page.getByTestId('monitoring-namespace-opt-kube-system').click()
      await expect(page.getByTestId('pod-metrics-error')).toHaveText(/Failed to load pod metrics|Pod 메트릭을 불러오는/, { timeout: 30_000 })
      await expect(page.getByText(MISSING)).toHaveCount(0)

      failing = false
      await expect.poll(() => page.getByTestId('monitoring-pod-row').count(), { timeout: 30_000 }).toBeGreaterThan(0)
      await expect(page.getByTestId('pod-metrics-error')).toHaveCount(0)
    })

    const OLD_VALUES = /Refresh failed\. These values are from \d+s ago\.|새로고침에 실패했습니다\. \d+s 전 값입니다\./

    test('a refresh of the Nodes tab that fails keeps the numbers, says how old they are and goes when a read works', async ({ page }) => {
      let failing = false
      await page.route('**/api/v1/cluster/metrics/nodes*', (route) => (failing ? route.fulfill(gateway503) : route.continue()))
      await page.goto('/monitoring?cluster=default')
      await expect.poll(() => page.getByTestId('monitoring-node').count(), { timeout: 30_000 }).toBeGreaterThan(0)
      const nodes = await page.getByTestId('monitoring-node').count()

      failing = true
      const notice = page.getByTestId('node-metrics-refresh-failed')
      await expect(notice).toContainText(OLD_VALUES, { timeout: 30_000 })
      expect(await page.getByTestId('monitoring-node').count(), 'the cards stay').toBe(nodes)
      await expect(page.getByTestId('node-metrics-error')).toHaveCount(0)

      failing = false
      await expect(notice).toHaveCount(0, { timeout: 30_000 })
      expect(await page.getByTestId('monitoring-node').count()).toBe(nodes)
    })

    test('a refresh of the Pods tab that fails keeps the numbers, says how old they are and goes when a read works', async ({ page }) => {
      let failing = false
      await page.route('**/api/v1/cluster/metrics/pods*', (route) => (failing ? route.fulfill(gateway503) : route.continue()))
      await page.goto('/monitoring?cluster=default')
      await page.getByRole('button', { name: /pod resources|pod 리소스/i }).first().click()
      await page.getByTestId('monitoring-namespace').click()
      await page.getByTestId('monitoring-namespace-opt-kube-system').click()
      await expect.poll(() => page.getByTestId('monitoring-pod-row').count(), { timeout: 30_000 }).toBeGreaterThan(0)
      const names = () => page.getByTestId('monitoring-pod-row').locator('td:nth-child(1)').allInnerTexts()
      const before = await names()
      const total = (await pagerRange(page, 'monitoring-pod-pager')).total

      failing = true
      const notice = page.getByTestId('pod-metrics-refresh-failed')
      await expect(notice).toContainText(OLD_VALUES, { timeout: 30_000 })
      // the notice takes a row's height, so the Fit page may hold one row less; the rows are the same pods
      const after = await names()
      expect(after.length, 'the rows stay').toBeGreaterThan(0)
      expect(after, 'the rows stay').toEqual(before.slice(0, after.length))
      expect((await pagerRange(page, 'monitoring-pod-pager')).total, 'the count stays').toBe(total)
      await expect(page.getByTestId('pod-metrics-error')).toHaveCount(0)

      failing = false
      await expect(notice).toHaveCount(0, { timeout: 30_000 })
    })

    test('choosing another namespace on the Pods tab shows nothing of the last one while the new rows come', async ({ page }) => {
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => { release = resolve })
      await page.route('**/api/v1/cluster/metrics/pods*', async (route) => {
        if (new URL(route.request().url()).searchParams.get('namespace') === 'monitoring') await held
        return route.continue()
      })
      await page.goto('/monitoring?cluster=default')
      await page.getByRole('button', { name: /pod resources|pod 리소스/i }).first().click()
      await page.getByTestId('monitoring-namespace').click()
      await page.getByTestId('monitoring-namespace-opt-kube-system').click()
      const rows = page.getByTestId('monitoring-pod-row')
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(0)
      const numbers = page.locator('.bg-slate-700.rounded-lg p.text-2xl')
      await expect(numbers).toHaveCount(3)
      await expect(numbers.first()).not.toHaveText('-')

      await page.getByTestId('monitoring-namespace').click()
      await page.getByTestId('monitoring-namespace-opt-monitoring').click()
      await expect(rows).toHaveCount(0)
      await expect(page.getByText(/^(Loading data\.\.\.|데이터를 불러오는 중\.\.\.)$/)).toHaveCount(1)
      expect(await numbers.allInnerTexts(), 'the cards keep their place with no number').toEqual(['-', '-', '-'])

      release()
      await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(0)
      const namespaces = await readEveryPage(page, 'monitoring-pod-pager', () => rows.locator('td:nth-child(2)').allInnerTexts())
      expect([...new Set(namespaces)]).toEqual(['monitoring'])
      expect(await numbers.first().innerText()).toBe(String(namespaces.length))
    })

    test('a 503 on the top resources is an error on the dashboard, and it recovers by itself', async ({ page }) => {
      let failing = true
      await page.route('**/api/v1/cluster/metrics/top-resources*', (route) => (failing ? route.fulfill(gateway503) : route.continue()))
      await page.goto('/?cluster=default')
      const failed = page.getByText(/^(Failed to fetch data|데이터를 가져오지 못했습니다)$/)
      await expect(failed.first()).toHaveText(/Failed to fetch data|데이터를 가져오지 못했습니다/, { timeout: 30_000 })
      await expect(page.getByText(MISSING)).toHaveCount(0)

      failing = false
      await expect(failed).toHaveCount(0, { timeout: 30_000 })
      await expect(page.getByText(MISSING)).toHaveCount(0)
    })

    test('the answer that says metrics-server is missing puts up the notice and stops asking', async ({ page }) => {
      let asked = 0
      await page.route('**/api/v1/cluster/metrics/nodes*', (route) => {
        asked += 1
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'metrics_unavailable' }) })
      })
      await page.goto('/monitoring?cluster=default')
      await expect(page.getByText(MISSING)).toHaveText(MISSING, { timeout: 30_000 })
      await expect(page.getByTestId('node-metrics-error')).toHaveCount(0)
      const askedThen = asked
      await page.waitForTimeout(7_000)
      expect(asked).toBe(askedThen)
    })
  })
})
