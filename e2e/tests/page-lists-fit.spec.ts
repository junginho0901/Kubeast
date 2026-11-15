import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { pageScroll, pagerRange, readEveryPage } from './list-pages'

// The lists of Change History, a Helm release's History and Resources tabs and Monitoring's two tabs are a page at a
// time in a box sized to the screen (1440×900, the project's viewport): the page itself does not scroll, the footer
// is on screen, the rows drawn are the range it says, and reading every page gives every item once — compared with
// what the API answers. The Alerts inbox's first page, whose rows wrap to different heights, holds the rows that end
// inside its table and no fewer, at one row count from the first frame with rows.

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
    // Fit measures each row (useAdaptiveRowsPerPage rowsThatFit: a long pod name wraps to two lines), so with a next page
    // the room left in the box under the last row would not hold one more at the height of the tallest drawn
    const range = await pagerRange(page, 'monitoring-pod-pager')
    if (range.end < range.total) {
      const { left, tallest } = await page.locator('[data-testid="monitoring-pod-row"]').evaluateAll((rows) => {
        const box = (rows[0] as HTMLElement).closest('table')!.parentElement!
        const bottom = box.getBoundingClientRect().top + box.clientHeight
        return { left: bottom - rows[rows.length - 1].getBoundingClientRect().bottom, tallest: Math.max(...rows.map((r) => r.getBoundingClientRect().height)) }
      })
      expect(left, 'room left under the last row of a fitted page').toBeLessThan(tallest + 1)
    }
    const [picker, search] = await Promise.all([page.getByTestId('monitoring-namespace').boundingBox(), page.getByTestId('monitoring-pod-search').boundingBox()])
    expect({ top: picker?.y, height: picker?.height }, 'one row, one height').toEqual({ top: search?.y, height: search?.height })
  })

  test('Alerts: with Fit the first page holds the rows that end inside the table, each as tall as its text', async ({ page }) => {
    // the inbox stood in: a short first row, then names that wrap to a second line with a summary under them
    const at = new Date(Date.now() - 10 * 60_000).toISOString()
    const item = (i: number) => ({
      id: `e2e-fit-${i}`, cluster: 'self', fingerprint: `e2e-fit-fp-${i}`, severity: 'info', namespace: 'default',
      alertname: i === 0 ? 'E2EFitShort' : `E2EFitInboxAlertNamedLongEnoughToWrapOntoASecondLineOfTheAlertColumn${i}`,
      labels: { alertname: `E2EFit${i}`, severity: 'info' }, summary: i === 0 ? '' : `fit inbox ${i}`, status: 'firing',
      starts_at: at, resolved_at: null, first_received_at: at, last_received_at: at, received_count: 1, acknowledged: false,
      acked_by: '', acked_at: null, assignee: '', done: false, done_by: '', done_at: null, investigation: null,
    })
    const all = Array.from({ length: 60 }, (_, i) => item(i))
    await page.route((u) => u.pathname === '/api/v1/alerts/inbox', async (route) => {
      const u = new URL(route.request().url())
      const offset = Number(u.searchParams.get('offset') ?? 0)
      const limit = Number(u.searchParams.get('limit') ?? 50)
      await route.fulfill({ json: { items: all.slice(offset, offset + limit), total: all.length, counts: { firing: all.length, stale: 0, resolved: 0 }, stale_hours: 24, severities: ['info'] } })
    })
    // the rows drawn in each painted frame
    await page.addInitScript(() => {
      const w = window as unknown as { __rows: number[] }
      w.__rows = []
      const tick = () => {
        const rows = document.querySelectorAll('tr[data-testid^="alert-row-"]').length
        if (rows) w.__rows.push(rows)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.goto('/alerts?cluster=self')
    await expect(page.getByTestId('alert-inbox-table').or(page.getByTestId('alert-inbox-disabled')).first()).toBeVisible({ timeout: 20_000 })
    test.skip(await page.getByTestId('alert-inbox-disabled').isVisible(), 'alert investigation is off on this install: no inbox')
    await expect(page.locator('tr[data-testid^="alert-row-"]').first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1500)

    const geometry = await page.getByTestId('alert-inbox-table').evaluate((table) => {
      const box = table.parentElement as HTMLElement
      const top = box.getBoundingClientRect().top + box.clientTop
      const rows = [...table.querySelectorAll('tr[data-testid^="alert-row-"]')].map((r) => r.getBoundingClientRect())
      return {
        room: box.clientHeight,
        bottoms: rows.map((r) => r.bottom - top),
        heights: rows.map((r) => r.height),
        scrolls: box.scrollHeight - box.clientHeight,
      }
    })
    const range = await pagerRange(page, 'list-pager')
    expect(new Set(geometry.heights.map(Math.round)).size, 'rows of different heights').toBeGreaterThan(1)
    expect(geometry.bottoms.filter((b) => b > geometry.room + 0.5), `rows ending below the table's box of ${geometry.room}px`).toEqual([])
    expect(geometry.scrolls, 'the table\'s box does not scroll').toBeLessThanOrEqual(1)
    expect(geometry.room - geometry.bottoms[geometry.bottoms.length - 1], 'room left under the last row, less than a row').toBeLessThan(Math.max(...geometry.heights))
    expect({ start: range.start, end: range.end }, 'the footer\'s range is the rows drawn').toEqual({ start: 1, end: geometry.bottoms.length })
    const frames = await page.evaluate(() => (window as unknown as { __rows: number[] }).__rows)
    expect([...new Set(frames)], 'row counts painted from the first frame with rows').toEqual([geometry.bottoms.length])
  })
})
