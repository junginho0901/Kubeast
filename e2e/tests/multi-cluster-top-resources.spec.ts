import { test, expect, type Page } from '@playwright/test'

// Multi-cluster "Top N by resource usage" isolation.
//
// The dashboard's top-pods/top-nodes query uses keepPreviousData
// (placeholderData) to avoid flicker on its 5s refresh. In v5 that callback
// receives the prior data even across a KEY change, so switching to a cluster
// that has no metrics-server briefly (and repeatedly) rendered the PREVIOUS
// cluster's top-N. The placeholderData now bails when the previous query's
// cluster differs, so nothing bleeds across a switch.
//
// The test needs one registered cluster that serves metrics (its top node name
// is the marker) and one that does not; which is which comes from the API.
//
// The switch is the render that gives the picker the new cluster: the router
// moves ?cluster= in a transition, so the click returns before it, and until
// then the page rightly shows the prior cluster. Every DOM change from that
// render on is checked, so a bleed of one render is caught too.

async function topNodeName(page: Page, cluster: string): Promise<string | null | undefined> {
  const res = await page.request.get(`/api/v1/cluster/metrics/top-resources?cluster=${cluster}`)
  if (!res.ok()) return undefined
  const nodes = (await res.json()).top_nodes as Array<{ name: string }> | null
  return nodes?.[0]?.name ?? null
}

async function pageHas(page: Page, text: string): Promise<boolean> {
  return (await page.content()).includes(text)
}

type Watch = { switched: boolean; bled: string[] }
const watched = (page: Page) => page.evaluate(() => (window as unknown as { __topN: Watch }).__topN)

test.describe('multi-cluster top-resources', () => {
  test('switching to a metrics-less cluster never shows the prior cluster top-N', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    const clusters = ['default', 'self']
    const tops = await Promise.all(clusters.map((c) => topNodeName(page, c)))
    test.skip(tops.some((t) => t === undefined), 'clusters default and self are not both registered')
    const withMetrics = clusters.find((_, i) => tops[i])
    const without = clusters.find((_, i) => tops[i] === null)
    test.skip(!withMetrics || !without, `metrics-server is on ${tops.filter(Boolean).length} of the two clusters; the test needs exactly one`)
    const marker = tops[clusters.indexOf(withMetrics!)] as string

    await page.goto(`/?cluster=${withMetrics}`)
    await page.waitForLoadState('networkidle')

    // sanity: the metrics cluster surfaces its own top node
    await expect.poll(() => pageHas(page, marker), { timeout: 15000 }).toBe(true)

    // from the render where the picker stops naming the prior cluster, note every state of the page that holds the
    // prior cluster's top node — read once the picker names it as the cluster list does (before, it shows the id)
    const picker = page.getByTestId('cluster-picker')
    const listed = await page.request.get('/api/v1/clusters?accessibleOnly=true')
    const items = (listed.ok() ? (await listed.json()).items ?? [] : []) as Array<{ id: string; display_name?: string }>
    await expect(picker).toContainText(items.find((c) => c.id === withMetrics)?.display_name || withMetrics!)
    const prior = (await picker.innerText()).trim()
    await page.evaluate(({ marker, prior }) => {
      const w = window as unknown as { __topN: Watch }
      w.__topN = { switched: false, bled: [] }
      const check = () => {
        const now = (document.querySelector('[data-testid="cluster-picker"]') as HTMLElement | null)?.innerText.trim() ?? ''
        if (now !== prior) w.__topN.switched = true
        if (w.__topN.switched && w.__topN.bled.length < 10 && document.documentElement.outerHTML.includes(marker)) w.__topN.bled.push(now)
      }
      new MutationObserver(check).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
    }, { marker, prior })

    // switch to the cluster without metrics-server
    await picker.click()
    await page.getByTestId(`cluster-option-${without}`).click()
    await expect.poll(async () => (await watched(page)).switched, { timeout: 10_000, message: 'the picker names the new cluster' }).toBe(true)

    // over the next several seconds the prior cluster's top-N must never appear
    // (covers the flicker: it would otherwise blink in and out on each refetch).
    for (let i = 0; i < 18; i++) {
      expect(await pageHas(page, marker), 'prior cluster top-N bled onto the new cluster').toBe(false)
      await page.waitForTimeout(300)
    }
    expect((await watched(page)).bled, 'prior cluster top-N in a render after the switch (the picker text then)').toEqual([])
  })
})
