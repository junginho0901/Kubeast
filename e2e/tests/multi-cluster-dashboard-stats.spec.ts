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

// the Pods stat once it is the API's total of the cluster read right after it: both are read again each time, since an
// earlier test's namespace may still be going away (its delete does not wait) and the number moves on both
async function settledPodsTotal(page: Page, cluster: string): Promise<number> {
  let total = NaN
  await expect(async () => {
    const shown = await podsTotal(page)
    const api = await apiPods(page, cluster)
    expect(api, `the API's total of ${cluster}`).not.toBeNull()
    expect(shown, `the Pods stat, and the API's total of ${cluster} read after it`).toBe(api)
    total = shown
  }).toPass({ timeout: 30000 })
  return total
}

test.describe('multi-cluster dashboard stats', () => {
  test('top totals reflect the selected cluster (no stale bleed)', async ({ page }) => {
    await page.goto('/?cluster=default')
    await page.waitForLoadState('domcontentloaded')
    const [onDefault, onSelf] = await Promise.all([apiPods(page, 'default'), apiPods(page, 'self')])
    test.skip(onDefault === null || onSelf === null, 'clusters default and self are not both registered')

    const shownOnDefault = await settledPodsTotal(page, 'default')

    // Switch to self — the total must become this cluster's value, not keep default's.
    await page.getByTestId('cluster-picker').click()
    await page.getByTestId('cluster-option-self').click()
    const shownOnSelf = await settledPodsTotal(page, 'self')
    // decided on the two totals the screen settled on, not on those read at the start
    test.skip(shownOnDefault === shownOnSelf, `default and self run the same number of pods (${shownOnSelf}), so a stale total could not be told apart`)
  })
})
