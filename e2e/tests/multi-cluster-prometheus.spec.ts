import { test, expect, type Page } from '@playwright/test'

// Multi-cluster Prometheus isolation (regression for the per-cluster cache bug).
//
// Prometheus is discovered in the TARGET cluster and its location was cached on
// the Service — shared across clusters. After viewing a cluster WITH Prometheus,
// switching to one WITHOUT it reused the stale location and 500'd every
// dashboard query. The cache is now per clientBundle (per cluster), so each
// cluster discovers independently. The test needs one registered cluster with
// Prometheus and one without (the second kind cluster carries it when it was
// created with `scripts/add-kind-cluster.sh --addons`).

// page.request carries the session cookie from the login storage state.
async function promQuery(page: Page, cluster: string) {
  const q = encodeURIComponent('count(kube_pod_info)')
  return page.request.get(`/api/v1/cluster/prometheus/query?query=${q}&cluster=${cluster}`)
}

async function available(page: Page, cluster: string): Promise<boolean | null> {
  const res = await promQuery(page, cluster)
  if (!res.ok()) return null
  return (await res.json()).available === true
}

test.describe('multi-cluster Prometheus isolation', () => {
  test('a cluster without Prometheus returns 200 empty, not a stale-cache 500', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    const clusters = ['default', 'self']
    const has = await Promise.all(clusters.map((c) => available(page, c)))
    test.skip(has.some((h) => h === null), 'clusters default and self are not both registered')
    const withProm = clusters.find((_, i) => has[i] === true)
    const without = clusters.find((_, i) => has[i] === false)
    test.skip(!withProm || !without, `Prometheus is on ${has.filter(Boolean).length} of the two clusters; the test needs exactly one`)

    // Prime the shared path the way the UI did: query the cluster that HAS
    // Prometheus first, so any cross-cluster cache would be populated.
    const onWith = await promQuery(page, withProm!)
    expect(onWith.status(), `${withProm} prometheus query`).toBe(200)
    expect((await onWith.json()).available, `${withProm} has Prometheus`).toBe(true)

    // Switching to the cluster WITHOUT Prometheus must not reuse the other's
    // discovered location — it should report unavailable, never 500.
    const onWithout = await promQuery(page, without!)
    expect(onWithout.status(), `${without} prometheus query (no 500)`).toBe(200)
    expect((await onWithout.json()).available, `${without} has no Prometheus`).toBe(false)

    // And the first cluster still works afterwards — caches did not clobber each other.
    const again = await promQuery(page, withProm!)
    expect(again.status()).toBe(200)
    expect((await again.json()).available).toBe(true)
  })
})
