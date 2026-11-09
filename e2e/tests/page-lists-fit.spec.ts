import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { pageScroll, pagerRange, readEveryPage } from './list-pages'

// The lists of Change History, a Helm release's History and Resources tabs and Monitoring's two tabs are a page at a
// time in a box sized to the screen (1440×900, the project's viewport): the page itself does not scroll, the footer
// is on screen, the rows drawn are the range it says, and reading every page gives every item once — compared with
// what the API answers.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function headers(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token}`, 'X-Requested-With': 'XMLHttpRequest' }
}

// the page does not scroll, the footer's bottom is inside the window, and the rows on screen are the footer's range
async function fits(page: Page, pagerId: string, rows: string) {
  await expect.poll(async () => {
    const range = await pagerRange(page, pagerId)
    const box = await page.getByTestId(pagerId).boundingBox()
    const height = await page.evaluate(() => window.innerHeight)
    return {
      scroll: (await pageScroll(page)) <= 1,
      footerOnScreen: !!box && box.y + box.height <= height,
      rows: (await page.locator(rows).count()) === (range.total === 0 ? 0 : range.end - range.start + 1),
    }
  }, { timeout: 20_000, message: `${pagerId}: the list and its footer fit the screen` }).toEqual({ scroll: true, footerOnScreen: true, rows: true })
}

test.describe('Lists sized to the screen', () => {
  test('Change History: the window a page at a time, the footer counting what the count says', async ({ page }) => {
    await page.goto('/timeline?cluster=self')
    await expect(page.getByTestId('timeline-count')).toHaveText(/\d+/, { timeout: 20_000 })
    await fits(page, 'timeline-pager', '[data-testid="timeline-row"]')
    const items = Number((await page.getByTestId('timeline-count').innerText()).match(/\d+/)?.[0])
    expect((await pagerRange(page, 'timeline-pager')).total).toBe(items)
  })

  test('Helm release History and Resources: every revision and object once over the pages, as the API lists them', async ({ page, request }) => {
    const h = await headers(request)
    const base = '/api/v1/helm/releases/kubeast/kubeast'
    const history = await request.get(`${base}/history?cluster=self`, { headers: h })
    test.skip(!history.ok(), `no Helm release kubeast/kubeast on cluster self (${history.status()})`)
    const revisions = ((await history.json()).items as { revision: number }[]).map((r) => r.revision).sort((a, b) => b - a)
    const resources = ((await (await request.get(`${base}/resources?cluster=self`, { headers: h })).json()).items as { kind: string; name: string }[])
      .map((r) => `${r.kind}/${r.name}`).sort()

    await page.goto('/helm/releases/kubeast/kubeast?cluster=self')
    await page.getByRole('button', { name: /^(History|이력)$/ }).first().click()
    await fits(page, 'helm-history-pager', 'main table tbody tr')
    const shownRevisions = await readEveryPage(page, 'helm-history-pager', () => page.locator('main table tbody tr td:first-child').allInnerTexts())
    expect(shownRevisions.map((s) => Number(s.replace(/\D/g, '')))).toEqual(revisions)

    await page.getByRole('button', { name: /^(Resources|리소스)$/ }).first().click()
    await fits(page, 'helm-resources-pager', 'main table tbody tr')
    const shownResources = await readEveryPage(page, 'helm-resources-pager', () =>
      page.locator('main table tbody tr').evaluateAll((rows) => rows.map((r) => `${(r as HTMLTableRowElement).cells[0].innerText.trim()}/${(r as HTMLTableRowElement).cells[2].innerText.trim()}`)))
    expect(shownResources.sort()).toEqual(resources)
  })

  test('Monitoring: the Nodes and Pods tabs fit their rows and footer to the screen', async ({ page, request }) => {
    const h = await headers(request)
    const nodes = await request.get('/api/v1/cluster/metrics/nodes?cluster=default', { headers: h })
    test.skip(!nodes.ok() || ((await nodes.json()) as unknown[]).length === 0, `no node metrics on cluster default (${nodes.status()})`)

    await page.goto('/monitoring?cluster=default')
    await fits(page, 'monitoring-node-pager', '[data-testid="monitoring-node"]')

    await page.getByRole('button', { name: /pod resources|pod 리소스/i }).first().click()
    await page.getByTestId('monitoring-namespace').click()
    await page.getByTestId('monitoring-namespace-opt-kube-system').click()
    await fits(page, 'monitoring-pod-pager', '[data-testid="monitoring-pod-row"]')
    // the picker and the search share one row and the cards one line each, so a fitted page holds at least seven
    // rows at this size (five when they were stacked)
    const range = await pagerRange(page, 'monitoring-pod-pager')
    expect(range.end - range.start + 1, 'rows a fitted page holds').toBeGreaterThanOrEqual(Math.min(7, range.total))
    const [picker, search] = await Promise.all([page.getByTestId('monitoring-namespace').boundingBox(), page.getByTestId('monitoring-pod-search').boundingBox()])
    expect({ top: picker?.y, height: picker?.height }, 'one row, one height').toEqual({ top: search?.y, height: search?.height })
  })
})
