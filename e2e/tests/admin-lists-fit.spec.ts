import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { pageScrolls } from './list-pages'

// The admin lists and the Settings page's lists that grow with the data are paged. A list page is as high as the
// screen at 1440×900: its table, its footer (with the rows-per-page choice) and nothing below them, so the page
// does not scroll. A window pages its rows ten at a time as the drawers do and keeps every row reachable: the
// Pending window (its header box chooses every pending account, on every page), the Cluster access window (its
// search looks in every grant) and the bulk upload's rows not created; Settings → My requests pages through every
// request the server counts. Users, grants and requests are made for the run (e2e-fit- names) and removed.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PREFIX = 'e2e-fit-'
const PW = 'E2e-fit-lists-Qw7z'
const CLUSTER = 'default'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function roleIdOf(request: APIRequestContext, admin: string, name: string): Promise<number> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const roles: Obj[] = Array.isArray(raw) ? raw : raw.roles || raw.items || []
  const role = roles.find((r) => String(r.name).toLowerCase() === name.toLowerCase())
  expect(role, `role ${name} exists`).toBeTruthy()
  return role.id
}

// every user, newest first, read 200 at a time until a page comes back empty
async function allUsers(request: APIRequestContext, admin: string): Promise<Obj[]> {
  const out: Obj[] = []
  for (let offset = 0; offset < 100_000;) {
    const page = (await (await request.get(`/api/v1/auth/admin/users?limit=200&offset=${offset}`, { headers: bearer(admin) })).json()) as Obj[]
    if (page.length === 0) break
    out.push(...page)
    offset += page.length
  }
  return out
}

async function makeUsers(request: APIRequestContext, admin: string, tag: string, n: number, role: string): Promise<{ id: string; email: string }[]> {
  const roleId = await roleIdOf(request, admin, role)
  const made: { id: string; email: string }[] = []
  for (let i = 0; i < n; i++) {
    const email = `${PREFIX}${tag}-${String(i).padStart(2, '0')}@kubeast.local`
    const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E fit ${tag} ${i}`, email, password: PW, role_id: roleId } })
    expect(res.status(), `create ${email}: ${await res.text()}`).toBe(201)
    made.push({ id: (await res.json()).id, email })
  }
  return made
}

// users of this spec, from this run or one that stopped (their grants and requests go with them)
async function cleanup(request: APIRequestContext, admin: string) {
  for (const u of (await allUsers(request, admin)).filter((u) => String(u.email ?? '').startsWith(PREFIX))) {
    await request.delete(`/api/v1/auth/admin/users/${u.id}`, { headers: bearer(admin), failOnStatusCode: false })
  }
}

async function loginUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20000 })
}

test.describe('admin lists page and fit the screen', () => {
  test('the admin list pages fit a 1440×900 screen with their footer and its rows-per-page choice', async ({ page, request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const reviewOn = !!(await (await request.get('/api/v1/auth/access-review/config', { headers: bearer(admin) })).json()).enabled
    const pages = [
      { path: '/admin/users', pager: 'admin-users-pager' },
      { path: '/admin/access-requests', pager: 'access-requests-pager' },
      ...(reviewOn ? [{ path: '/admin/access-review', pager: 'access-review-pager' }] : []),
      { path: '/admin/organizations', pager: 'teams-pager' },
      { path: '/admin/roles', pager: 'roles-pager' },
      { path: '/admin/clusters', pager: 'clusters-pager' },
    ]
    await page.setViewportSize({ width: 1440, height: 900 })
    for (const p of pages) {
      await page.goto(p.path)
      const pager = page.getByTestId(p.pager)
      await expect(pager, `${p.path}: the footer says what it shows`).toContainText(/Showing \d+-\d+ of \d+|Showing 0 of 0/, { timeout: 20_000 })
      await expect(pager.getByTestId('page-size'), `${p.path}: the rows-per-page choice`).toHaveCount(1)
      const box = await pager.boundingBox()
      expect(box ? box.y + box.height : Infinity, `${p.path}: the footer is on the screen`).toBeLessThanOrEqual(900)
      expect(await pageScrolls(page), `${p.path}: the page does not scroll`).toBeLessThanOrEqual(1)
    }
  })

  test('Teams, Roles and Clusters count every item in their footer', async ({ page, request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    // the range ends the footer's first part, after the rows-per-page choice
    const count = (n: number) => (n === 0 ? /Showing 0 of 0$/ : new RegExp(`Showing 1-\\d+ of ${n}$`))
    const teams = (await (await request.get('/api/v1/auth/organizations?type=team', { headers: bearer(admin) })).json()) as Obj[]
    const roles = (await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()) as Obj[]
    const clusters = ((await (await request.get('/api/v1/clusters', { headers: bearer(admin) })).json()).items ?? []) as Obj[]
    const range = (testId: string) => page.getByTestId(testId).locator('div').first()
    await page.goto('/admin/organizations')
    await expect(range('teams-pager'), 'Teams').toHaveText(count(teams.length), { timeout: 20_000 })
    await page.goto('/admin/roles')
    await expect(range('roles-pager'), 'Roles').toHaveText(count(roles.length), { timeout: 20_000 })
    await page.goto('/admin/clusters')
    await expect(range('clusters-pager'), 'Clusters').toHaveText(count(clusters.length), { timeout: 20_000 })
  })

  test('Users: the role menu of the last row on the page is not cut off by the table', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/admin/users')
    await expect(page.getByTestId('admin-users-pager')).toContainText(/Showing \d+-\d+ of \d+/, { timeout: 20_000 })
    const last = page.locator('main tbody tr button[aria-haspopup="menu"]').last()
    await last.click()
    const menu = page.locator('main tbody [role="menu"]')
    await expect(menu).toHaveCount(1)
    const box = await menu.boundingBox()
    const table = await page.locator('main tbody').first().evaluate((el) => {
      const b = (el.closest('.overflow-x-auto') as HTMLElement).getBoundingClientRect()
      return { top: b.top, bottom: b.bottom }
    })
    expect(box, 'the menu has a box').not.toBeNull()
    expect(box!.y, 'menu top inside the table').toBeGreaterThanOrEqual(table.top - 1)
    expect(box!.y + box!.height, 'menu bottom inside the table').toBeLessThanOrEqual(table.bottom + 1)
    // closed again, nothing chosen
    await last.click()
    await expect(menu).toHaveCount(0)
  })

  test('Users: the Pending window pages ten accounts and its header box chooses every pending one, on every page', async ({ page, request }) => {
    test.setTimeout(120_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    await cleanup(request, admin)
    try {
      await makeUsers(request, admin, `pend-${Date.now().toString(36)}`, 12, 'Pending')
      const pending = (await allUsers(request, admin)).filter((u) => String(u.role?.name ?? '').toLowerCase() === 'pending')
      expect(pending.length, 'pending accounts past one page of the window').toBeGreaterThan(10)

      await page.goto('/admin/users')
      await page.getByRole('button', { name: /Pending|대기/ }).first().click()
      const win = page.getByTestId('admin-users-pending-window')
      const rows = win.getByTestId('admin-users-pending-row')
      const pages = win.getByTestId('admin-users-pending-pages')
      await expect(rows, 'the first page of the window').toHaveCount(10, { timeout: 15_000 })
      await expect(pages).toContainText(`1-10 / ${pending.length}`)

      await win.getByTestId('admin-users-pending-select-all').check()
      await expect(win.getByTestId('admin-users-pending-chosen'), 'every pending account is chosen').toHaveText(`${pending.length} selected, on every page`)
      await pages.getByRole('button', { name: 'Next' }).click()
      await expect(pages).toContainText(`11-${Math.min(20, pending.length)} / ${pending.length}`)
      const checked = await rows.locator('input[type="checkbox"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked))
      expect(checked.length, 'rows on the second page').toBe(Math.min(10, pending.length - 10))
      expect(checked.every(Boolean), 'the rows of the second page are chosen too').toBe(true)

      await win.getByTestId('admin-users-pending-select-all').uncheck()
      await expect(win.getByTestId('admin-users-pending-chosen'), 'none chosen on any page').toHaveCount(0)
    } finally {
      await cleanup(request, admin)
    }
  })

  test('Cluster access: the window pages ten grants, reaches every one and its search finds one', async ({ page, request }) => {
    test.setTimeout(120_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    await cleanup(request, admin)
    try {
      const made = await makeUsers(request, admin, `ca-${Date.now().toString(36)}`, 12, 'Member')
      for (const u of made) {
        const res = await request.put(`/api/v1/auth/admin/users/${u.id}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read' } })
        expect(res.ok(), `grant ${u.email}: ${await res.text()}`).toBeTruthy()
      }
      const grants = (await (await request.get(`/api/v1/auth/admin/clusters/${CLUSTER}/user-roles`, { headers: bearer(admin) })).json()) as { user_id: string }[]
      expect(grants.length, 'grants past one page of the window').toBeGreaterThan(10)

      await page.goto('/admin/clusters')
      await page.getByTestId(`access-cluster-${CLUSTER}`).click()
      const list = page.getByTestId('cluster-access-list')
      const shown = () => list.locator('[data-testid^="cluster-access-revoke-"]').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice('cluster-access-revoke-'.length)))
      await expect.poll(shown, { timeout: 15_000, message: 'the first page of the window' }).toHaveLength(10)
      const pages = page.getByTestId('cluster-access-pages')
      await expect(pages).toContainText(`1-10 / ${grants.length}`)
      const seen: string[] = []
      for (let i = 0; i < 100; i++) {
        seen.push(...(await shown()))
        const next = pages.getByRole('button', { name: 'Next' })
        if ((await next.count()) === 0 || (await next.isDisabled())) break
        const before = await pages.innerText()
        await next.click()
        await expect.poll(() => pages.innerText()).not.toBe(before)
      }
      expect([...seen].sort(), 'every grant over the pages, each once').toEqual(grants.map((g) => g.user_id).sort())

      const one = made[made.length - 1]
      await page.getByTestId('cluster-access-search').fill(one.email)
      await expect.poll(shown, { message: 'the search finds the grant wherever its page was' }).toEqual([one.id])
    } finally {
      await cleanup(request, admin)
    }
  })

  test('Users: the bulk upload pages the rows it could not create', async ({ page, request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const run = Date.now().toString(36)
    const emails = Array.from({ length: 12 }, (_, i) => `${PREFIX}bulk-${run}-${String(i).padStart(2, '0')}@kubeast.local`)
    try {
      await page.goto('/admin/users')
      await page.getByRole('button', { name: /Bulk upload|일괄 업로드/ }).first().click()
      // no password: every row is refused before anything is sent
      const csv = ['name,email,password,role,team', ...emails.map((e, i) => `E2E fit bulk ${i},${e},,Member,`), ''].join('\n')
      await page.locator('input[type="file"][accept=".csv"]').setInputFiles({ name: 'users.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
      const failed = page.getByTestId('admin-users-bulk-create-failed')
      await expect(failed).toContainText('Not created: 12 of 12 accounts', { timeout: 15_000 })
      const rows = page.getByTestId('admin-users-bulk-create-failed-row')
      const pages = page.getByTestId('admin-users-bulk-create-failed-pages')
      await expect(rows).toHaveCount(10)
      await expect(pages).toContainText('1-10 / 12')
      const first = await rows.allInnerTexts()
      await pages.getByRole('button', { name: 'Next' }).click()
      await expect(rows).toHaveCount(2)
      const all = [...first, ...(await rows.allInnerTexts())]
      expect(all.map((r) => r.split(':')[0]), 'every refused row over the pages, in the file order').toEqual(emails)
      expect((await allUsers(request, admin)).filter((u) => emails.includes(u.email)).map((u) => u.email), 'nothing created').toEqual([])
    } finally {
      await cleanup(request, admin)
    }
  })

  test('Settings: My requests pages through every request the server counts', async ({ browser, request }) => {
    test.setTimeout(120_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const cfg = await (await request.get('/api/v1/auth/access-requests/config', { headers: bearer(admin) })).json()
    test.skip(!cfg.enabled, 'ACCESS_REQUESTS_ENABLED is off on this installation')
    await cleanup(request, admin)
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    try {
      const [u] = await makeUsers(request, admin, `mine-${Date.now().toString(36)}`, 1, 'Member')
      const grant = await request.put(`/api/v1/auth/admin/users/${u.id}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read' } })
      expect(grant.ok(), await grant.text()).toBeTruthy()
      const user = await login(request, u.email, PW)
      // one pending request at a time per cluster: ask, withdraw, again
      const ids: string[] = []
      for (let i = 0; i < 12; i++) {
        const made = await request.post('/api/v1/auth/access-requests', { headers: bearer(user), data: { cluster_id: CLUSTER, role: 'Write', duration_minutes: 30, reason: `e2e fit ${i}` } })
        expect(made.status(), await made.text()).toBe(201)
        const id = (await made.json()).id as string
        expect((await request.delete(`/api/v1/auth/access-requests/${id}`, { headers: bearer(user) })).status()).toBe(204)
        ids.push(id)
      }
      const newest = [...ids].reverse()

      // the server: a page of ten and the count of all twelve; without a page, the newest fifty as before
      const second = await request.get('/api/v1/auth/access-requests?limit=10&offset=10', { headers: bearer(user) })
      expect(second.headers()['x-kubeast-total']).toBe('12')
      expect(((await second.json()) as Obj[]).map((r) => r.id)).toEqual(newest.slice(10))
      const whole = await request.get('/api/v1/auth/access-requests', { headers: bearer(user) })
      expect(((await whole.json()) as Obj[]).map((r) => r.id)).toEqual(newest)
      expect((await request.get('/api/v1/auth/access-requests?limit=501', { headers: bearer(user), failOnStatusCode: false })).status()).toBe(400)

      const p = await ctx.newPage()
      await loginUI(p, u.email, PW)
      await p.goto('/account')
      const list = p.getByTestId('my-access-requests')
      const shown = () => list.locator('[data-testid^="my-access-request-"]').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice('my-access-request-'.length)))
      await expect.poll(shown, { timeout: 15_000, message: 'My requests: the first page, newest first' }).toEqual(newest.slice(0, 10))
      const pages = p.getByTestId('my-access-requests-pages')
      await expect(pages).toContainText('1-10 / 12')
      await pages.getByRole('button', { name: 'Next' }).click()
      await expect.poll(shown, { message: 'My requests: the second page reaches the oldest' }).toEqual(newest.slice(10))
      await expect(pages).toContainText('11-12 / 12')
    } finally {
      await ctx.close()
      await cleanup(request, admin)
    }
  })
})
