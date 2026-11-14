import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'

// Real flows in a fresh browser, as a person uses the console rather than through a stored sign-in: a shared link
// opened before signing in, a cluster switch kept through a reload and in a second tab, the browser's back button,
// one person signing out and another signing in (also with no reload between, where the first person's live socket
// and chat answers end), and the screen settings across a sign-out. Each test starts a new browser context; the
// throwaway Read accounts are removed at the end.

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
// An account of the run, removed in afterAll: an Admin of the whole console, or a Member with Read on `default`. A
// sign-out ends that sign-in on the server and auth_time is in whole seconds, so the people who sign out here are not
// the admin whose token this spec holds.
async function throwaway(api: APIRequestContext, tag: string, roleName: 'Admin' | 'Member') {
  const roles = await (await api.get('/api/v1/auth/roles', { headers: admin })).json()
  const role = (Array.isArray(roles) ? roles : roles.roles || roles.items || []).find((r: { name: string }) => r.name === roleName).id
  const email = `e2e-rf-${tag}-${stamp}@kubeast.local`
  const password = `e2e-rf-${tag}-pw`
  const made = await api.post('/api/v1/auth/admin/users', { headers: admin, data: { name: `E2E real flows ${tag}`, email, password, role_id: role } })
  expect(made.status(), await made.text()).toBe(201)
  const id = (await made.json()).id as string
  users.push(id)
  if (roleName === 'Member') expect((await api.put(`/api/v1/auth/admin/users/${id}/cluster-roles/default`, { headers: admin, data: { role: 'Read', namespaces: [] } })).status()).toBeLessThan(300)
  return { email, password }
}
// A sign-in in the same second as one signed out shares its auth_time and would end with it.
async function pastTheSecondOf(at: number) {
  const wait = (Math.floor(at / 1000) + 1) * 1000 - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait + 50))
}
const storedCluster = (page: Page) => page.evaluate((k) => localStorage.getItem(k), CLUSTER_KEY)
const nodesCard = (page: Page) => page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Nodes', exact: true }) })
const nodeNames = (page: Page) => nodesCard(page).locator('button p[title]').evaluateAll((els) => els.map((e) => e.getAttribute('title')))
async function apiNodes(page: Page, cluster: string) {
  const res = await page.request.get(`/api/v1/cluster/nodes?cluster=${cluster}`)
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { name: string }[]).map((n) => n.name).sort()
}
// A throwaway Member account with Read on `default`, removed in afterAll.
async function readUser(request: APIRequestContext, tag: string) {
  const roles = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
  const member = (Array.isArray(roles) ? roles : roles.roles || roles.items || []).find((r: { name: string }) => r.name === 'Member').id
  const email = `e2e-rf-${tag}-${stamp}@kubeast.local`
  const password = `e2e-rf-${tag}-pw`
  const made = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: `E2E real flows ${tag}`, email, password, role_id: member } })
  expect(made.status(), await made.text()).toBe(201)
  const id = (await made.json()).id as string
  users.push(id)
  expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/default`, { headers: admin, data: { role: 'Read', namespaces: [] } })).status()).toBeLessThan(300)
  return { email, password }
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
  const { email, password } = await readUser(request, 'read')

  const { ctx, page } = await freshPage(browser)
  await page.goto('/login')
  await signIn(page)
  await page.goto('/admin/users')
  // the list pages as many rows as fit the screen: find the account by its email
  await page.getByTestId('admin-users-search').fill(email)
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

// The same change of person with no reload between the sign-out and the sign-in: the watch socket the first person's
// cookie opened closes at the sign-out, the second person's lists open a socket of their own after the sign-in, and the
// answers the first person was waiting for in AI Chat and in the floating chat stop. No model is asked: the chat
// requests are held in the browser and never answered.
test('signing out closes the live connection and stops the chat answers, and the next person signed in without a reload starts with their own', async ({ browser, request }) => {
  const { email, password } = await readUser(request, 'live')
  // the first person is an admin of the run's own: its sign-out ends no token a later step uses
  const first = await throwaway(request, 'live-first', 'Admin')
  const { ctx, page } = await freshPage(browser)
  const sockets: { openedAt: number; closedAt: number | null }[] = []
  page.on('websocket', (ws) => {
    if (!/\/api\/v1\/cluster\/wsMultiplexer/.test(ws.url())) return
    const socket = { openedAt: Date.now(), closedAt: null as number | null }
    ws.on('close', () => { socket.closedAt = Date.now() })
    sockets.push(socket)
  })
  const open = () => sockets.filter((s) => s.closedAt === null)
  const asked: string[] = []
  await page.route(/\/api\/v1\/ai\/sessions\/[^/]+\/(floating-)?chat$/, (route) => {
    asked.push(/sessions\/([^/]+)\//.exec(route.request().url())?.[1] ?? '')
  })
  const sidebarLink = (href: string) => page.getByTestId('sidebar-nav').locator(`a[href="${href}"]`)
  const aiChatStop = page.locator('main').getByRole('button', { name: /^(Stop|중단)$/ })
  const floatingPanel = page.getByTestId('floating-chat-panel')
  const openFloating = async () => {
    await page.getByRole('button', { name: /Open AI Chat|AI Chat 열기/i }).click()
    await expect(floatingPanel).toHaveCSS('pointer-events', 'auto')
  }

  try {
    await page.goto('/login')
    await signIn(page, first.email, first.password)
    await page.goto('/ai-chat?cluster=default')
    await page.waitForLoadState('networkidle')
    await page.getByTestId('chat-input').fill('which pods restarted today?')
    await page.getByRole('button', { name: /전송|send/i }).click()
    await expect.poll(() => asked.length).toBe(1)
    await expect(aiChatStop).toHaveCount(1)

    // to a list that follows the cluster without a reload (its sidebar group is closed on AI Chat), and the floating chat there
    await sidebarLink('/configuration/configmaps').dispatchEvent('click')
    await expect(page).toHaveURL(/\/configuration\/configmaps/)
    await expect.poll(() => open().length, { timeout: 15000 }).toBe(1)
    const first = open()[0]
    await openFloating()
    await page.getByTestId('floating-chat-input').fill('what is wrong on this page?')
    await page.getByTestId('floating-chat-input').press('Enter')
    await expect.poll(() => asked.length).toBe(2)
    await expect(floatingPanel.getByRole('button', { name: /^(Stop|중지)$/ })).toHaveCount(1)

    await page.getByRole('button', { name: /Log out|로그아웃/ }).click()
    await expect(page).toHaveURL(/\/login/)
    await expect.poll(() => first.closedAt !== null, { timeout: 10000 }).toBe(true)
    const signedInAt = Date.now()
    await signIn(page, email, password)
    await expect(page.getByText(email, { exact: true })).toHaveCount(1, { timeout: 15000 })

    // AI Chat: no answer of the first person is coming, so there is no Stop and the box takes a question
    await sidebarLink('/ai-chat').click()
    await expect(page).toHaveURL(/\/ai-chat/)
    await expect(page.getByTestId('chat-input')).toBeEnabled()
    await expect(aiChatStop).toHaveCount(0)

    // the list follows the cluster on a socket opened after this sign-in, not the first person's
    await sidebarLink('/configuration/configmaps').dispatchEvent('click')
    await expect(page).toHaveURL(/\/configuration\/configmaps/)
    await expect.poll(() => open().length, { timeout: 15000 }).toBe(1)
    const second = open()[0]
    expect(second).not.toBe(first)
    expect(first.closedAt!).toBeLessThanOrEqual(signedInAt)
    expect(second.openedAt).toBeGreaterThanOrEqual(signedInAt)

    // the floating chat sends this person's question at once, in a conversation of their own
    await openFloating()
    await expect(floatingPanel.getByRole('button', { name: /^(Stop|중지)$/ })).toHaveCount(0)
    await page.getByTestId('floating-chat-input').fill('and on this page?')
    await page.getByTestId('floating-chat-input').press('Enter')
    await expect.poll(() => asked.length).toBe(3)
    expect(asked[2]).not.toBe(asked[0])
    expect(asked[2]).not.toBe(asked[1])
  } finally {
    await ctx.close()
    // the conversations the questions made: the first two are the first person's, the third the second person's
    for (const [who, ids] of [[first, asked.slice(0, 2)], [{ email, password }, asked.slice(2, 3)]] as const) {
      if (!ids.some(Boolean)) continue
      const login = await request.post('/api/v1/auth/login', { data: who })
      const token = login.ok() ? (await login.json()).access_token : ''
      for (const id of ids) if (token && id) await request.delete(`/api/v1/sessions/${id}?cluster=default`, { headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' }, failOnStatusCode: false })
    }
  }
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
