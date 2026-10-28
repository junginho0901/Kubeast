import { test, expect, type Page } from '@playwright/test'

// Dashboard lists: right after a sign-in (which clears the stored cluster) the Nodes card shows the nodes of the
// cluster the picker selects, not of the server's default cluster asked while the selection was empty; the card
// shows at most 8 nodes, those not Ready first, and links to the Nodes page; the window behind a stat card pages
// its list 50 at a time. The last two give the page a list longer than dev has, through page.route.

const nodesCard = (page: Page) => page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Nodes', exact: true }) })
const nodeNames = (page: Page) => nodesCard(page).locator('button p[title]').evaluateAll((els) => els.map((e) => e.getAttribute('title')))
const pagerText = (page: Page) => page.getByTestId('resource-modal-pager').locator('div').first().innerText()

test.describe('Dashboard lists', () => {
  test('after a fresh sign-in the Nodes card shows the selected cluster’s nodes and opens them', async ({ browser }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto('/login')
    await page.locator('input[autocomplete="email"]').first().fill(process.env.E2E_USER_EMAIL ?? '')
    await page.locator('input[type="password"]').first().fill(process.env.E2E_USER_PASSWORD ?? '')
    await page.locator('button[type="submit"]').first().click()
    await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'))
    // no reload: the sign-in lands on the dashboard while the selection is still empty, and the picker then
    // selects `default` — the card must list that cluster's nodes, not those of the server's default cluster
    await page.waitForURL((u) => u.pathname === '/')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('kubeast:current-cluster'))).toBe('default')
    const res = await page.request.get('/api/v1/cluster/nodes?cluster=default')
    expect(res.ok()).toBe(true)
    const expected = ((await res.json()) as { name: string }[]).map((n) => n.name).sort()
    await expect.poll(async () => (await nodeNames(page)).sort(), { timeout: 15_000 }).toEqual(expected)

    const describe = page.waitForResponse((r) => r.url().includes(`/cluster/nodes/${expected[0]}/describe`))
    await nodesCard(page).locator('button').filter({ hasText: expected[0] }).first().click()
    expect((await describe).status()).toBe(200)
    await expect(page.getByText('Failed to load node details')).toHaveCount(0)
    await ctx.close()
  })

  test('the Nodes card shows at most 8 nodes, those not Ready first, and links to the Nodes page', async ({ page }) => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({
      name: `e2e-node-${String(i + 1).padStart(2, '0')}`,
      status: i === 5 || i === 9 ? 'NotReady' : 'Ready',
      version: 'v1.37.0',
      roles: ['worker'],
      internal_ip: `10.0.0.${i + 1}`,
    }))
    await page.route(/\/api\/v1\/cluster\/nodes(\?|$)/, (route) => route.fulfill({ json: nodes }))
    await page.goto('/')
    await expect.poll(() => nodeNames(page)).toHaveLength(8)
    const names = await nodeNames(page)
    expect(names.slice(0, 2)).toEqual(['e2e-node-06', 'e2e-node-10'])
    expect(names.slice(2)).toEqual(['e2e-node-01', 'e2e-node-02', 'e2e-node-03', 'e2e-node-04', 'e2e-node-05', 'e2e-node-07'])
    const all = page.getByTestId('dashboard-nodes-all')
    await expect(all).toHaveAttribute('href', '/cluster/nodes')
    await expect(all).toContainText('12')
  })

  test('the window behind a stat card pages its list 50 at a time', async ({ page }) => {
    const pods = Array.from({ length: 120 }, (_, i) => ({
      name: `e2e-pod-${String(i + 1).padStart(3, '0')}`,
      namespace: 'e2e-lists',
      phase: 'Running',
      status: 'Running',
      node_name: 'e2e-node',
      containers: [],
    }))
    await page.route(/\/api\/v1\/cluster\/pods\/all(\?|$)/, (route) => route.fulfill({ json: pods }))
    await page.goto('/')
    await page.getByTestId('stat-pods').click()
    const pager = page.getByTestId('resource-modal-pager')
    await expect.poll(() => pagerText(page)).toMatch(/1-50 of 120|120개 중 1-50/)
    await expect(page.getByText('e2e-pod-050', { exact: true })).toBeVisible()
    await expect(page.getByText('e2e-pod-051', { exact: true })).toHaveCount(0)
    await pager.getByRole('button').last().click()
    await expect.poll(() => pagerText(page)).toMatch(/51-100 of 120|120개 중 51-100/)
    await expect(page.getByText('e2e-pod-051', { exact: true })).toBeVisible()
    await pager.getByRole('button').last().click()
    await expect.poll(() => pagerText(page)).toMatch(/101-120 of 120|120개 중 101-120/)
    await expect(page.getByText('e2e-pod-120', { exact: true })).toBeVisible()
    // a search starts again from the first page
    await page.getByPlaceholder(/Search|검색/).last().fill('e2e-pod-1')
    await expect.poll(() => pagerText(page)).toMatch(/1-21 of 21|21개 중 1-21/)
  })
})
