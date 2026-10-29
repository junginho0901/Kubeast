import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'

// Real flows in a fresh browser, as a person uses the console rather than through a stored sign-in: a shared link
// opened before signing in, a cluster switch kept through a reload and in a second tab, the browser's back button,
// one person signing out and another signing in, and the screen settings across a sign-out. Each test starts a
// new browser context; a throwaway Read account is removed at the end.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER_KEY = 'kubeast:current-cluster'
const stamp = Date.now().toString(36)
type H = Record<string, string>

test.use({ storageState: { cookies: [], origins: [] } })
test.describe.configure({ mode: 'serial' })

let admin: H = {}
const users: string[] = []

async function bearer(request: APIRequestContext, email: string, password: string): Promise<H> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.status(), `login ${email}`).toBe(200)
  return { Authorization: `Bearer ${(await res.json()).access_token}`, 'X-Requested-With': 'XMLHttpRequest' }
}
async function signIn(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20000 })
}
async function freshPage(browser: Browser) {
  const ctx = await browser.newContext()
  return { ctx, page: await ctx.newPage() }
}
const storedCluster = (page: Page) => page.evaluate((k) => localStorage.getItem(k), CLUSTER_KEY)
const nodesCard = (page: Page) => page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Nodes', exact: true }) })
const nodeNames = (page: Page) => nodesCard(page).locator('button p[title]').evaluateAll((els) => els.map((e) => e.getAttribute('title')))
async function apiNodes(page: Page, cluster: string) {
  const res = await page.request.get(`/api/v1/cluster/nodes?cluster=${cluster}`)
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { name: string }[]).map((n) => n.name).sort()
}

test.beforeAll(async ({ request }) => {
  admin = await bearer(request, ADMIN_EMAIL, ADMIN_PASSWORD)
})

test.afterAll(async ({ request }) => {
  for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
})

test('a link opened before signing in comes back whole after the sign-in: its cluster and its drawer', async ({ browser }) => {
  const { ctx, page } = await freshPage(browser)
  await page.goto('/workloads/deployments?cluster=self&detail=Deployment/default/e2e-unschedulable')
  await expect(page).toHaveURL(/\/login/)
  await signIn(page)
  await expect(page).toHaveURL(/\/workloads\/deployments\?/)
  await expect(page).toHaveURL(/cluster=self/)
  await expect(page).toHaveURL(/detail=Deployment(%2F|\/)default(%2F|\/)e2e-unschedulable/)
  await expect.poll(() => storedCluster(page)).toBe('self')
  // the drawer is open on that Deployment: its header action is there (the list behind has no such button)
  await expect(page.getByRole('button', { name: /Delete Deployment|Deployment 삭제/ })).toHaveCount(1, { timeout: 15000 })
  await ctx.close()
})

test('a cluster picked on the dashboard stays picked through a reload, with that cluster’s nodes', async ({ browser }) => {
  const { ctx, page } = await freshPage(browser)
  await page.goto('/login')
  await signIn(page)
  await page.waitForURL((u) => u.pathname === '/')
  await expect.poll(() => storedCluster(page)).toBe('default')
  await page.getByTestId('cluster-picker').click()
  await page.getByTestId('cluster-option-self').click()
  await expect.poll(() => storedCluster(page)).toBe('self')
  const selfNodes = await apiNodes(page, 'self')
  await expect.poll(async () => (await nodeNames(page)).sort(), { timeout: 15000 }).toEqual(selfNodes)
  await page.reload()
  await expect.poll(() => storedCluster(page)).toBe('self')
  await expect.poll(async () => (await nodeNames(page)).sort(), { timeout: 15000 }).toEqual(selfNodes)
  await ctx.close()
})

test('a second tab opens on the cluster the first one picked, and each page shows its own cluster’s nodes', async ({ browser }) => {
  const { ctx, page } = await freshPage(browser)
  await page.goto('/login')
  await signIn(page)
  await page.goto('/?cluster=self')
  await expect.poll(() => storedCluster(page)).toBe('self')
  const second = await ctx.newPage()
  await second.goto('/')
  await expect.poll(() => storedCluster(second)).toBe('self')
  await expect.poll(async () => (await nodeNames(second)).sort(), { timeout: 15000 }).toEqual(await apiNodes(second, 'self'))
  // the first tab moves to default; the second keeps showing self's nodes until it is reloaded, then default's
  await page.goto('/?cluster=default')
  await expect.poll(async () => (await nodeNames(page)).sort(), { timeout: 15000 }).toEqual(await apiNodes(page, 'default'))
  await expect.poll(async () => (await nodeNames(second)).sort()).toEqual(await apiNodes(second, 'self'))
  await second.reload()
  await expect.poll(async () => (await nodeNames(second)).sort(), { timeout: 15000 }).toEqual(await apiNodes(second, 'default'))
  await ctx.close()
})

test('the back button after a cluster switch returns to the page of the cluster before', async ({ browser }) => {
  const { ctx, page } = await freshPage(browser)
  await page.goto('/login')
  await signIn(page)
  await page.goto('/workloads/pods?cluster=self')
  await expect.poll(() => storedCluster(page)).toBe('self')
  await page.goto('/workloads/pods?cluster=default')
  await expect.poll(() => storedCluster(page)).toBe('default')
  await page.goBack()
  await expect(page).toHaveURL(/\/workloads\/pods\?cluster=self/)
  await expect.poll(() => storedCluster(page)).toBe('self')
  await expect(page.getByTestId('cluster-picker')).toContainText('self')
  await ctx.close()
})

test('after one person signs out, the next one signs in to their own access and none of the first one’s', async ({ browser, request }) => {
  const roles = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
  const member = (Array.isArray(roles) ? roles : roles.roles || roles.items || []).find((r: { name: string }) => r.name === 'Member').id
  const email = `e2e-rf-read-${stamp}@kubeast.local`
  const password = `e2e-rf-read-pw`
  const made = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E real flows read', email, password, role_id: member } })
  expect(made.status(), await made.text()).toBe(201)
  const id = (await made.json()).id as string
  users.push(id)
  expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/default`, { headers: admin, data: { role: 'Read', namespaces: [] } })).status()).toBeLessThan(300)

  const { ctx, page } = await freshPage(browser)
  await page.goto('/login')
  await signIn(page)
  await page.goto('/admin/users')
  await expect(page.getByTestId(`user-detail-${email}`)).toHaveCount(1, { timeout: 15000 })
  await page.getByRole('button', { name: /Log out|로그아웃/ }).click()
  await expect(page).toHaveURL(/\/login/)
  await signIn(page, email, password)
  // the sidebar's account card names the second person, and the admin menu is gone
  await expect(page.getByText(email, { exact: true })).toHaveCount(1, { timeout: 15000 })
  await expect(page.getByTestId('sidebar-nav').getByRole('link', { name: 'User Management' })).toHaveCount(0)
  // the admin page the first person had open is not there for the second, from cache or otherwise
  await page.goto('/admin/users')
  await expect(page).not.toHaveURL(/\/admin\/users/, { timeout: 15000 })
  await expect(page.getByTestId(`user-detail-${email}`)).toHaveCount(0)
  const me = await (await page.request.get('/api/v1/auth/me')).json()
  expect(me.email).toBe(email)
  await ctx.close()
})

test('the language and the colour mode chosen on Settings stay through a sign-out and the next sign-in', async ({ browser }) => {
  const { ctx, page } = await freshPage(browser)
  await page.goto('/login')
  await signIn(page)
  await page.evaluate(() => {
    localStorage.setItem('i18nextLng', 'ko')
    localStorage.setItem('kubeast.colorMode', 'light')
  })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'light')
  await page.getByRole('button', { name: /Log out|로그아웃/ }).click()
  await expect(page).toHaveURL(/\/login/)
  await signIn(page)
  await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'light')
  await expect(page.getByRole('button', { name: '로그아웃' })).toHaveCount(1, { timeout: 15000 })
  await page.evaluate(() => {
    localStorage.removeItem('kubeast.colorMode')
    localStorage.setItem('i18nextLng', 'en')
  })
  await ctx.close()
})
