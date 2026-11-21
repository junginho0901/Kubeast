import { test, expect, type Page, type Route } from '@playwright/test'
import { pagerRange } from './list-pages'

// The Pods list's footer counts the answer on screen. While the first read, or the read of the cluster just picked,
// is on its way it says it has not counted ("Showing - of -") under the Loading row: never "Showing 0 of 0", and never
// the total of the cluster before. Once the answer comes it says that answer's total, held to the API.

const XRW = { 'X-Requested-With': 'XMLHttpRequest' }
const NOT_COUNTED = 'Showing - of -'
const isPageRead = (u: URL, cluster: string) => u.pathname === '/api/v1/cluster/pods/page' && u.searchParams.get('cluster') === cluster

// the API's total of every pod of the cluster, as the list opens (all namespaces, no search)
async function totalOf(page: Page, cluster: string): Promise<number> {
  const res = await page.request.get(`/api/v1/cluster/pods/page?offset=0&limit=50&cluster=${cluster}`, { headers: XRW })
  expect(res.ok(), `pods of ${cluster}: ${res.status()}`).toBeTruthy()
  return (await res.json()).total as number
}

// the footer's total once it is the API's total read right after it: both are read again each time, since an earlier
// test's namespace may still be going away (its delete does not wait) and the number moves on both
async function footerTotal(page: Page, cluster: string): Promise<number> {
  let total = NaN
  await expect(async () => {
    const shown = (await pagerRange(page, 'list-pager', { uncounted: 'nan' })).total
    total = await totalOf(page, cluster)
    expect(shown, `the footer's total, and the API's total of ${cluster} read after it`).toBe(total)
  }).toPass({ timeout: 20_000 })
  return total
}

// holds the Pods list's reads of `cluster` until released
async function hold(page: Page, cluster: string) {
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held = 0
  const handler = async (route: Route) => {
    if (isPageRead(new URL(route.request().url()), cluster)) {
      held++
      await gate
    }
    await route.continue().catch(() => {})
  }
  await page.route(/\/api\/v1\/cluster\/pods\/page(\?|$)/, handler)
  return {
    held: () => held,
    release: async () => {
      release()
      await page.unroute(/\/api\/v1\/cluster\/pods\/page(\?|$)/, handler)
    },
  }
}

// the footer's range text in each painted frame, each change once (runs in the page)
function recordFooter() {
  const w = window as unknown as { __footer: string[] }
  w.__footer = []
  const tick = () => {
    const pager = document.querySelector('main [data-testid="list-pager"]')
    const text = (pager?.firstElementChild as HTMLElement | null)?.innerText?.replace(/\s+/g, ' ').trim()
    if (text && w.__footer[w.__footer.length - 1] !== text) w.__footer.push(text)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
const footerSeen = (page: Page) => page.evaluate(() => (window as unknown as { __footer: string[] }).__footer)
const rangeTexts = (seen: string[]) => seen.map((s) => s.match(/Showing (\d+-\d+ of \d+|0 of 0|- of -)/)?.[0] ?? s)

test.describe('the Pods list footer', () => {
  test('says it has not counted while the first read comes, then the answer\'s total', async ({ page }) => {
    await page.addInitScript(recordFooter)
    const held = await hold(page, 'self')
    try {
      await page.goto('/workloads/pods?cluster=self')
      await expect.poll(held.held, { message: 'the first read is held' }).toBeGreaterThan(0)
      await expect(page.locator('main tbody').first()).toContainText('Loading...')
      await expect(page.getByTestId('list-pager')).toContainText(NOT_COUNTED)
    } finally {
      await held.release()
    }
    expect(await footerTotal(page, 'self'), 'the total the footer settles on').toBeGreaterThan(0)
    expect(rangeTexts(await footerSeen(page)).filter((s) => s === 'Showing 0 of 0'), 'a 0 nobody counted').toEqual([])
  })

  test('says it has not counted while the cluster just picked is read, not the total of the cluster before', async ({ page }) => {
    await page.goto('/workloads/pods?cluster=self')
    const self = await footerTotal(page, 'self')
    await page.evaluate(recordFooter)
    const held = await hold(page, 'default')
    try {
      await page.getByTestId('cluster-picker').click()
      await page.getByTestId('cluster-option-default').click()
      await expect(page).toHaveURL(/[?&]cluster=default(&|$)/)
      await expect.poll(held.held, { message: 'the read of default is held' }).toBeGreaterThan(0)
      await page.waitForTimeout(1000)
      await expect(page.getByTestId('list-pager')).toContainText(NOT_COUNTED)
    } finally {
      await held.release()
    }
    const other = await footerTotal(page, 'default')
    const seen = rangeTexts(await footerSeen(page))
    expect(seen.filter((s) => s === 'Showing 0 of 0'), 'a 0 nobody counted').toEqual([])
    test.skip(self === other, `self and default both hold ${self} pods: the footer could not tell them apart`)
    // from the first frame without self's total, self's total does not come back before default's
    const left = seen.findIndex((s) => !s.endsWith(`of ${self}`))
    expect(left, 'the footer left self\'s total').toBeGreaterThanOrEqual(0)
    expect(seen.slice(left).filter((s) => s.endsWith(`of ${self}`)), 'self\'s total after the switch').toEqual([])
  })
})
