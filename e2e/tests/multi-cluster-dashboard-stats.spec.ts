import { test, expect, type Page } from '@playwright/test'

// Multi-cluster dashboard stats isolation.
//
// The dashboard's top totals (Pods / Nodes / …) come from /cluster/overview,
// which was cached under a cluster-agnostic key on the backend AND fetched under
// a cluster-agnostic React Query key on the frontend. Both bugs made a switch
// show the PREVIOUS cluster's totals (the numbers stayed the same even though
// the drill-down lists changed). With per-cluster cache + query keys, the totals
// must reflect the selected cluster. self (this kind cluster) is small; the
// external 'default' (clarinet) is much larger — so the Pods total must change.

async function podsTotal(page: Page): Promise<number> {
  const txt = await page.getByTestId('stat-value-pods').innerText()
  return Number(txt.replace(/[^\d]/g, ''))
}

test.describe('multi-cluster dashboard stats', () => {
  test('top totals reflect the selected cluster (no stale bleed)', async ({ page }) => {
    // default (clarinet) — the larger cluster.
    await page.goto('/?cluster=default')
    await page.waitForLoadState('networkidle')
    await expect.poll(() => podsTotal(page), { timeout: 30000 }).toBeGreaterThan(40)
    const defaultPods = await podsTotal(page)

    // Switch to self (kind) — totals must drop to this cluster's values, not
    // keep showing default's.
    await page.getByTestId('cluster-picker').click()
    await page.getByTestId('cluster-option-self').click()
    await expect.poll(() => podsTotal(page), { timeout: 30000 }).toBeLessThan(40)
    const selfPods = await podsTotal(page)

    expect(selfPods).not.toBe(defaultPods)
  })
})
