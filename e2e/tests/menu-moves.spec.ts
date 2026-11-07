import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'

// Two screens left the Admin group. Node Shell's settings, which this browser keeps, are a card of the Account page;
// Cluster Hygiene is in the Cluster group and its report goes with the cluster: an Admin grant there reads it, the Read
// and Write roles do not, and the export and the sign-off stay with the all-cluster keys. Their old addresses lead to the
// new ones. Throwaway users and roles, removed after.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-moves-throwaway-1!'
const stamp = Date.now().toString(36)
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token as string
}

let admin = ''
let hygieneOn = false
const users: string[] = []
const roles: number[] = []

async function roleId(request: APIRequestContext, name: string): Promise<number> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  return (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === name.toLowerCase()).id
}
async function makeRole(request: APIRequestContext, tag: string, permissions: string[]): Promise<{ id: number; name: string }> {
  const name = `e2e-moves-${tag}-${stamp}`
  const res = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name, description: 'menu-moves.spec', permissions } })
  expect(res.status(), await res.text()).toBeLessThan(300)
  const id = (await res.json()).id as number
  roles.push(id)
  return { id, name }
}
// A user of the run: its global role, and its grants by cluster.
async function makeUser(request: APIRequestContext, tag: string, grants: Record<string, object>, globalRole?: number): Promise<{ email: string; token: string }> {
  const email = `e2e-moves-${tag}-${stamp}@kubeast.local`
  const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E moves ${tag}`, email, password: PW, role_id: globalRole ?? await roleId(request, 'Member') } })
  expect(created.status(), await created.text()).toBe(201)
  const id = (await created.json()).id as string
  users.push(id)
  for (const [cluster, grant] of Object.entries(grants)) {
    const put = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/${cluster}`, { headers: bearer(admin), data: grant })
    expect(put.ok(), await put.text()).toBeTruthy()
  }
  return { email, token: await login(request, email, PW) }
}
async function signedIn(browser: Browser, email: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, locale: 'en-US' })
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(PW)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), undefined, { timeout: 20_000 })
  return { ctx, page }
}

// The sidebar's entries once they stopped changing (Cluster Hygiene waits for its setting), each with its group.
async function sidebarOf(page: Page, cluster: string): Promise<Record<string, string>> {
  await page.goto(`/account?cluster=${cluster}`)
  await expect(page.getByTestId('sidebar-nav')).toBeVisible({ timeout: 20_000 })
  let entries: Record<string, string> = {}
  let prev = ''
  let same = 0
  for (let i = 0; i < 30 && same < 3; i++) {
    await page.waitForTimeout(500)
    entries = await page.getByTestId('sidebar-nav').locator(':scope > div').evaluateAll((groups) => Object.fromEntries(groups.flatMap((g) => {
      const label = g.querySelector('button')?.textContent?.trim() ?? ''
      return [...g.querySelectorAll('a[href^="/"]')].map((a) => [new URL((a as HTMLAnchorElement).href).pathname, label])
    })))
    const key = JSON.stringify(entries)
    same = key === prev ? same + 1 : 0
    prev = key
  }
  return entries
}
// A refused page draws a blank page at its address while /auth/me loads, then goes to "/": the address once it stayed
// put for 1.2 s with a page heading drawn (at most 10 s).
async function settledPath(page: Page, url: string): Promise<string> {
  await page.goto(url)
  let at = new URL(page.url()).pathname
  let since = Date.now()
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    await page.waitForTimeout(100)
    const now = new URL(page.url()).pathname
    if (now !== at) {
      at = now
      since = Date.now()
    } else if (Date.now() - since >= 1_200 && (await page.locator('main h1').count()) > 0) break
  }
  return at
}

test.describe('the screens that left the Admin group', () => {
  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const config = await request.get('/api/v1/cluster/hygiene/config?cluster=self', { headers: bearer(admin) })
    hygieneOn = config.ok() && !!(await config.json()).enabled
  })

  test.afterAll(async ({ request }) => {
    for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test('the old Node Shell address lands on the Account card, whose settings this browser keeps', async ({ page }) => {
    await page.goto('/admin/node-shell?cluster=self')
    await expect(page).toHaveURL(/\/account\?cluster=self#node-shell$/, { timeout: 15_000 })
    const card = page.getByTestId('account-node-shell')
    await expect(card.getByRole('heading', { name: 'Node Shell' })).toHaveText('Node Shell')
    await expect(card).toBeInViewport()

    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('nodeShellSettings') ?? '{}') as { isEnabled?: boolean; linuxImage?: string })
    const toggle = page.getByTestId('node-shell-enabled')
    const was = (await toggle.getAttribute('aria-pressed')) === 'true'
    await toggle.click()
    expect((await stored()).isEnabled).toBe(!was)
    await page.getByLabel('Linux image').fill('registry.example/debug:1')
    expect((await stored()).linuxImage).toBe('registry.example/debug:1')
    await page.reload()
    await expect(page.getByTestId('node-shell-enabled')).toHaveAttribute('aria-pressed', String(!was))
    await expect(page.getByLabel('Linux image')).toHaveValue('registry.example/debug:1')
    expect(Object.keys(await sidebarOf(page, 'self'))).not.toContain('/admin/node-shell')
    await page.evaluate(() => localStorage.removeItem('nodeShellSettings'))
  })

  test('the old Cluster Hygiene address lands on the page in the Cluster group, with its query', async ({ page }) => {
    test.skip(!hygieneOn, 'cluster hygiene report is off (features.hygiene.enabled)')
    await page.goto('/admin/cluster-hygiene?cluster=self')
    await expect(page).toHaveURL(/\/cluster\/hygiene\?cluster=self$/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Cluster hygiene' })).toHaveText('Cluster Hygiene')
    await expect(page).toHaveTitle('Cluster Hygiene · Kubeast')
    const entries = await sidebarOf(page, 'self')
    expect(entries['/cluster/hygiene'], 'its group').toBe(entries['/cluster/namespaces'])
    expect(entries).not.toHaveProperty('/admin/cluster-hygiene')
  })

  test('an Admin grant reads its own cluster\'s report; it neither exports nor signs off, and another cluster stays closed', async ({ browser, request }) => {
    test.skip(!hygieneOn, 'cluster hygiene report is off (features.hygiene.enabled)')
    test.setTimeout(180_000)
    const { email, token } = await makeUser(request, 'clusteradmin', { self: { role: 'Admin' }, default: { role: 'Read' } })
    const status = async (path: string, method: 'GET' | 'POST' = 'GET') => (await request.fetch(path, { method, headers: bearer(token), data: method === 'POST' ? {} : undefined, failOnStatusCode: false })).status()
    const asAdmin = await (await request.get('/api/v1/cluster/hygiene/history?cluster=self', { headers: bearer(admin) })).json()
    const history = await request.get('/api/v1/cluster/hygiene/history?cluster=self', { headers: bearer(token) })
    expect(history.status()).toBe(200)
    expect(await history.json(), 'the history the global admin reads').toEqual(asAdmin)
    expect(await status('/api/v1/cluster/hygiene?cluster=self'), 'the report').toBe(200)
    expect(await status('/api/v1/cluster/hygiene?cluster=self&format=csv'), 'the export').toBe(403)
    expect(await status('/api/v1/cluster/hygiene/signoff?cluster=self', 'POST'), 'the sign-off').toBe(403)
    expect(await status('/api/v1/cluster/hygiene?cluster=default'), 'the report of a cluster it reads with Read').toBe(403)

    const { ctx, page } = await signedIn(browser, email)
    try {
      const entries = await sidebarOf(page, 'self')
      expect(entries['/cluster/hygiene'], 'its group').toBe(entries['/cluster/namespaces'])
      expect(Object.keys(entries).filter((p) => p.startsWith('/admin/')), 'admin entries').toEqual([])

      expect(await settledPath(page, '/cluster/hygiene?cluster=self')).toBe('/cluster/hygiene')
      await expect(page.getByTestId('hygiene-summary')).toHaveCount(1, { timeout: 60_000 })
      await expect(page.getByTestId('hygiene-export-csv')).toHaveCount(0)
      await expect(page.getByTestId('hygiene-export-json')).toHaveCount(0)
      await expect(page.getByTestId('hygiene-signoff-panel')).toHaveCount(0)
      await expect(page.getByTestId('hygiene-tab-history')).toHaveCount(1)
      // the picker offers the clusters whose report it may read
      await page.getByTestId('hygiene-cluster').click()
      await expect(page.getByTestId('hygiene-cluster-opt-self')).toHaveCount(1)
      await expect(page.getByTestId('hygiene-cluster-opt-default')).toHaveCount(0)

      expect(Object.keys(await sidebarOf(page, 'default')), 'on the cluster it reads with Read').not.toContain('/cluster/hygiene')
      expect(await settledPath(page, '/cluster/hygiene?cluster=default')).toBe('/')
    } finally {
      await ctx.close()
    }
  })

  test('the Read and Write roles and a grant limited to namespaces do not see Cluster Hygiene', async ({ browser, request }) => {
    test.skip(!hygieneOn, 'cluster hygiene report is off (features.hygiene.enabled)')
    test.setTimeout(240_000)
    for (const [tag, grant] of [
      ['read', { role: 'Read' }],
      ['write', { role: 'Write' }],
      ['limitedread', { role: 'Read', namespaces: ['default'] }],
      // it holds the key, and the report spans the cluster: the server refuses it, the screen does not offer it
      ['limitedadmin', { role: 'Admin', namespaces: ['default'] }],
    ] as const) {
      const { email, token } = await makeUser(request, tag, { self: grant })
      const refused = await request.get('/api/v1/cluster/hygiene?cluster=self', { headers: bearer(token), failOnStatusCode: false })
      expect(refused.status(), `${tag}: the report`).toBe(403)
      const history = await request.get('/api/v1/cluster/hygiene/history?cluster=self', { headers: bearer(token), failOnStatusCode: false })
      expect(history.status(), `${tag}: the history`).toBe(403)
      const { ctx, page } = await signedIn(browser, email)
      try {
        expect(Object.keys(await sidebarOf(page, 'self')), `${tag}: the sidebar`).not.toContain('/cluster/hygiene')
        expect(await settledPath(page, '/cluster/hygiene?cluster=self'), `${tag}: by address`).toBe('/')
      } finally {
        await ctx.close()
      }
    }
  })

  test('a bookmark opened in a fresh browser waits for the picker\'s cluster instead of being sent away', async ({ browser, request }) => {
    test.skip(!hygieneOn, 'cluster hygiene report is off (features.hygiene.enabled)')
    test.setTimeout(90_000)
    const { email } = await makeUser(request, 'onlyself', { self: { role: 'Admin' } })
    const { ctx, page } = await signedIn(browser, email)
    try {
      await page.waitForURL((u) => u.pathname === '/', { timeout: 20_000 })
      await page.evaluate(() => localStorage.clear())
      expect(await settledPath(page, '/cluster/hygiene')).toBe('/cluster/hygiene')
      await expect(page.getByRole('heading', { name: 'Cluster hygiene' })).toHaveText('Cluster Hygiene')
    } finally {
      await ctx.close()
    }
  })

  test('the all-cluster hygiene key keeps its reader without a menu key: the entry shows and the report opens', async ({ browser, request }) => {
    test.skip(!hygieneOn, 'cluster hygiene report is off (features.hygiene.enabled)')
    test.setTimeout(120_000)
    const global = await makeRole(request, 'auditor', ['admin.hygiene.read'])
    // a cluster role without menu.cluster: the group's other entries stay hidden
    const onCluster = await makeRole(request, 'nomenu', ['menu.dashboard', 'resource.*.read'])
    const { email, token } = await makeUser(request, 'auditor', { self: { role: onCluster.name } }, global.id)
    expect((await request.get('/api/v1/cluster/hygiene/history?cluster=default', { headers: bearer(token), failOnStatusCode: false })).status(), 'a cluster it has no grant on').toBe(200)
    const { ctx, page } = await signedIn(browser, email)
    try {
      const entries = await sidebarOf(page, 'self')
      expect(Object.keys(entries).filter((p) => p.startsWith('/cluster/') && entries[p] === entries['/cluster/hygiene']), 'the Cluster group').toEqual(['/cluster/hygiene'])
      expect(await settledPath(page, '/cluster/hygiene?cluster=self')).toBe('/cluster/hygiene')
    } finally {
      await ctx.close()
    }
  })

  test('the role screen offers the cluster key apart from the role\'s reads, and the seeded roles hold it as promised', async ({ request }) => {
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const list = (Array.isArray(raw) ? raw : raw.roles || raw.items || []) as { name: string; permissions: string[] | null }[]
    const holds = (name: string) => {
      const perms = list.find((r) => r.name === name)?.permissions ?? []
      return perms.includes('*') || perms.includes('resource.hygiene.scan') || perms.includes('resource.*.*')
    }
    expect(['Read', 'Write', 'Admin'].map(holds)).toEqual([false, false, true])
    const catalog = await (await request.get('/api/v1/auth/permissions', { headers: bearer(admin) })).json()
    const categories: { permissions: { key: string }[] }[] = Array.isArray(catalog) ? catalog : catalog.categories ?? catalog.items
    expect(categories.flatMap((c) => c.permissions).map((p) => p.key)).toContain('resource.hygiene.scan')
  })
})
