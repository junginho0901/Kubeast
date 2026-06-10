import { test, expect, type Page } from '@playwright/test'

// Multi-cluster Prometheus isolation (regression for the per-cluster cache bug).
//
// Prometheus is discovered in the TARGET cluster and its location was cached on
// the Service — shared across clusters. After viewing a cluster WITH Prometheus
// (external 'default'), switching to one WITHOUT it (in-cluster 'self') reused
// the stale location and 500'd every dashboard query. The cache is now per
// clientBundle (per cluster), so each cluster discovers independently:
//   - 'default' (clarinet) HAS Prometheus  → available:true
//   - 'self' (this kind cluster) has none   → available:false, 200 (not 500)

async function accessToken(page: Page): Promise<string> {
  const t = await page.evaluate(() => localStorage.getItem('kubeast:access-token'))
  if (!t) throw new Error('no kubeast:access-token in localStorage — login state missing')
  return t
}

async function promQuery(page: Page, cluster: string) {
  const q = encodeURIComponent('count(kube_pod_info)')
  const res = await page.request.get(
    `/api/v1/cluster/prometheus/query?query=${q}&cluster=${cluster}`,
    { headers: { Authorization: `Bearer ${await accessToken(page)}` } },
  )
  return res
}

test.describe('multi-cluster Prometheus isolation', () => {
  test('a cluster without Prometheus returns 200 empty, not a stale-cache 500', async ({ page }) => {
    // Prime the shared path the way the UI did: query the cluster that HAS
    // Prometheus first, so any cross-cluster cache would be populated.
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const onDefault = await promQuery(page, 'default')
    expect(onDefault.status(), 'default cluster prometheus query').toBe(200)
    expect((await onDefault.json()).available, 'default cluster has Prometheus').toBe(true)

    // Switching to the cluster WITHOUT Prometheus must not reuse default's
    // discovered location — it should report unavailable, never 500.
    const onSelf = await promQuery(page, 'self')
    expect(onSelf.status(), 'self cluster prometheus query (no 500)').toBe(200)
    expect((await onSelf.json()).available, 'self cluster has no Prometheus').toBe(false)

    // And default still works afterwards — caches did not clobber each other.
    const backToDefault = await promQuery(page, 'default')
    expect(backToDefault.status()).toBe(200)
    expect((await backToDefault.json()).available).toBe(true)
  })
})
