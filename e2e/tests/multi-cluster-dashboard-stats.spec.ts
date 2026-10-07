import { test, expect, type Page } from '@playwright/test'

// Multi-cluster dashboard stats isolation.
//
// The dashboard's top totals (Pods / Nodes / …) come from /cluster/overview,
// which was cached under a cluster-agnostic key on the backend AND fetched under
// a cluster-agnostic React Query key on the frontend. Both bugs made a switch
// show the PREVIOUS cluster's totals (the numbers stayed the same even though
// the drill-down lists changed). With per-cluster cache + query keys, the totals
// must reflect the selected cluster: the Pods stat has to equal what the API
// reports for the cluster that is selected, before and after a switch.

async function podsTotal(page: Page): Promise<number> {
  const txt = await page.getByTestId('stat-value-pods').innerText()
  return Number(txt.replace(/[^\d]/g, ''))
}

async function apiPods(page: Page, cluster: string): Promise<number | null> {
  const res = await page.request.get(`/api/v1/cluster/overview?cluster=${cluster}`)
  if (!res.ok()) return null
  return (await res.json()).total_pods as number
}

test.describe('multi-cluster dashboard stats', () => {
  test('top totals reflect the selected cluster (no stale bleed)', async ({ page }) => {
    await page.goto('/?cluster=default')
    await page.waitForLoadState('domcontentloaded')
    const [onDefault, onSelf] = await Promise.all([apiPods(page, 'default'), apiPods(page, 'self')])
    test.skip(onDefault === null || onSelf === null, 'clusters default and self are not both registered')
    test.skip(onDefault === onSelf, `default and self run the same number of pods (${onDefault}), so a stale total could not be told apart`)

    await expect.poll(() => podsTotal(page), { timeout: 30000 }).toBe(onDefault)

    // Switch to self — the total must become this cluster's value, not keep default's.
    await page.getByTestId('cluster-picker').click()
    await page.getByTestId('cluster-option-self').click()
    await expect.poll(() => podsTotal(page), { timeout: 30000 }).toBe(onSelf)
  })
})
