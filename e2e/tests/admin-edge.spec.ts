import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Admin edges the v0.7.3 edge QA found: a role with some admin permissions opens those pages only; nobody changes
// their own cluster access; a role still held is not deleted, and says why; deleting a team clears it from its
// members; a browser whose session ends without signing out is told so; someone with no cluster sees no
// "in this cluster" notice; an Admin grant on one cluster opens none of the admin pages its APIs refuse.
// Throwaway accounts, roles and teams, removed at the end; the dev admin is never a target.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const stamp = Date.now().toString(36)
type H = Record<string, string>

test.use({ storageState: { cookies: [], origins: [] } })
test.describe.configure({ mode: 'serial' })

let admin: H = {}
const users: string[] = []
const roles: number[] = []
const teams: number[] = []

async function login(request: APIRequestContext, email: string, password: string) {
  return request.post('/api/v1/auth/login', { data: { email, password }, failOnStatusCode: false })
}
async function bearer(request: APIRequestContext, email: string, password: string): Promise<H> {
  const res = await login(request, email, password)
  expect(res.status(), `login ${email}`).toBe(200)
  return { Authorization: `Bearer ${(await res.json()).access_token}`, 'X-Requested-With': 'XMLHttpRequest' }
}
async function roleId(request: APIRequestContext, name: string): Promise<number> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
  return (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name === name).id
}
async function mkRole(request: APIRequestContext, tag: string, permissions: string[]) {
  const res = await request.post('/api/v1/auth/admin/roles', { headers: admin, data: { name: `e2e-edge-${tag}-${stamp}`, description: 'e2e', permissions } })
  expect(res.status(), await res.text()).toBeLessThan(300)
  const id = (await res.json()).id as number
  roles.push(id)
  return { id, name: `e2e-edge-${tag}-${stamp}` }
}
async function mkUser(request: APIRequestContext, tag: string, role: number, team?: string) {
  const email = `e2e-edge-${tag}-${stamp}@kubeast.local`
  const password = `e2e-edge-${tag}-pw`
  const res = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: `E2E edge ${tag}`, email, password, role_id: role, ...(team ? { team } : {}) } })
  expect(res.status(), await res.text()).toBe(201)
  const id = (await res.json()).id as string
  users.push(id)
  return { id, email, password }
}
async function uiLogin(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20000 })
}
// The sidebar's entries on self once they stopped changing (the admin entries wait for their settings).
async function sidebarPaths(page: Page): Promise<string[]> {
  await page.goto('/account?cluster=self')
  await expect(page.getByTestId('sidebar-nav')).toBeVisible({ timeout: 20000 })
  let prev = ''
  let same = 0
  let paths: string[] = []
  for (let i = 0; i < 30 && same < 3; i++) {
    await page.waitForTimeout(500)
    paths = [...new Set(await page.getByTestId('sidebar-nav').locator('a[href^="/"]').evaluateAll((as) => as.map((a) => new URL((a as HTMLAnchorElement).href).pathname)))].sort()
    same = paths.join(' ') === prev ? same + 1 : 0
    prev = paths.join(' ')
  }
  return paths
}
// A refused page draws a blank page at its address while /auth/me loads, then goes to "/": the address once it
// stayed put for 1.2 s with a page heading drawn (at most 10 s).
async function settledPath(page: Page, url: string): Promise<{ path: string; heading: string }> {
  await page.goto(url)
  let path = new URL(page.url()).pathname
  let since = Date.now()
  const end = Date.now() + 10000
  while (Date.now() < end) {
    await page.waitForTimeout(100)
    const at = new URL(page.url()).pathname
    if (at !== path) {
      path = at
      since = Date.now()
    } else if (Date.now() - since >= 1200 && (await page.locator('main h1').count()) > 0) break
  }
  return { path, heading: (await page.locator('main h1').first().innerText({ timeout: 1000 }).catch(() => '')).trim() }
}

test.beforeAll(async ({ request }) => {
  admin = await bearer(request, ADMIN_EMAIL, ADMIN_PASSWORD)
})

test.afterAll(async ({ request }) => {
  for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
  for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: admin, failOnStatusCode: false })
  for (const id of teams) await request.delete(`/api/v1/auth/admin/organizations/${id}`, { headers: admin, failOnStatusCode: false })
})

test('a role with the user permissions sees and opens User Management only, not other admin pages', async ({ page, request }) => {
  const role = await mkRole(request, 'usermgr', ['menu.dashboard', 'admin.users.read', 'admin.users.update', 'resource.*.read'])
  const u = await mkUser(request, 'usermgr', role.id)
  expect((await request.put(`/api/v1/auth/admin/users/${u.id}/cluster-roles/default`, { headers: admin, data: { role: 'Read', namespaces: [] } })).status()).toBeLessThan(300)
  await uiLogin(page, u.email, u.password)
  await page.goto('/admin/users')
  await expect(page.getByTestId(`user-detail-${u.email}`)).toHaveCount(1, { timeout: 15000 })
  await expect(page).toHaveURL(/\/admin\/users/)
  const nav = page.getByTestId('sidebar-nav')
  await expect(nav.getByRole('link', { name: 'User Management' })).toHaveCount(1)
  await expect(nav.getByRole('link', { name: 'Role Management' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Audit Logs' })).toHaveCount(0)
  // the page the role does not cover still goes back to the start
  await page.goto('/admin/audit')
  await expect(page).not.toHaveURL(/\/admin\/audit/, { timeout: 15000 })
  // its own row: cluster access read-only, with the reason
  await page.goto('/admin/users')
  await page.getByTestId(`user-detail-${u.email}`).click({ timeout: 15000 })
  await expect(page.getByTestId('cluster-role-matrix-self')).toHaveCount(1, { timeout: 15000 })
})

test('nobody changes their own cluster access: refused with an audit row, the session stays', async ({ request }) => {
  const role = await mkRole(request, 'grantor', ['menu.dashboard', 'admin.users.read', 'admin.users.update', 'resource.*.read'])
  const u = await mkUser(request, 'grantor', role.id)
  expect((await request.put(`/api/v1/auth/admin/users/${u.id}/cluster-roles/default`, { headers: admin, data: { role: 'Read', namespaces: [] } })).status()).toBeLessThan(300)
  const mine = await bearer(request, u.email, u.password)
  const set = await request.put(`/api/v1/auth/admin/users/${u.id}/cluster-roles/default`, { headers: mine, data: { role: 'Read', namespaces: [] }, failOnStatusCode: false })
  expect(set.status(), await set.text()).toBe(403)
  const unset = await request.delete(`/api/v1/auth/admin/users/${u.id}/cluster-roles/default`, { headers: mine, failOnStatusCode: false })
  expect(unset.status(), await unset.text()).toBe(403)
  expect((await request.get('/api/v1/auth/me', { headers: mine })).status()).toBe(200)
  const rows = await (await request.get(`/api/v1/auth/admin/audit-logs?action=user.cluster_role.unset&limit=20`, { headers: admin })).json()
  const items = (rows.items ?? []) as Array<{ ActorEmail?: string; Result?: string; Error?: string }>
  expect(items.some((r) => r.ActorEmail === u.email && r.Result === 'failure' && /own cluster access/.test(r.Error ?? ''))).toBe(true)
})

test('a password reset of an account holding more is refused, and User Management says why', async ({ page, request }) => {
  const role = await mkRole(request, 'narrow', ['menu.dashboard', 'admin.users.read', 'admin.users.update'])
  const u = await mkUser(request, 'narrow', role.id)
  expect((await request.put(`/api/v1/auth/admin/users/${u.id}/cluster-roles/default`, { headers: admin, data: { role: 'Read', namespaces: [] } })).status()).toBeLessThan(300)
  const wide = await mkUser(request, 'wide', await roleId(request, 'Admin'))
  await uiLogin(page, u.email, u.password)
  await page.goto('/admin/users')
  await page.getByTestId('admin-users-search').fill(wide.email)
  const row = page.locator('tr').filter({ has: page.getByTestId(`user-detail-${wide.email}`) })
  await row.getByTestId('user-reset-password').click({ timeout: 15000 })
  await page.getByTestId('confirm-dialog-ok').click()
  await expect(page.getByTestId('admin-users-action-error')).toContainText(`permission ceiling: ${wide.email} holds what you do not: *`, { timeout: 15000 })
  await expect(page.getByTestId('reset-password-result')).toHaveCount(0)
  expect((await login(request, wide.email, wide.password)).status(), 'the password is what it was').toBe(200)
})

test('a role still held is not deleted, and Role Management says why', async ({ page, request }) => {
  const role = await mkRole(request, 'held', ['menu.dashboard', 'resource.*.read'])
  await mkUser(request, 'holder', role.id)
  const del = await request.delete(`/api/v1/auth/admin/roles/${role.id}`, { headers: admin, failOnStatusCode: false })
  expect(del.status()).toBe(409)
  expect(await del.json()).toMatchObject({ code: 'role_in_use', accounts: 1, cluster_grants: 0, access_requests: 0 })
  await uiLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD)
  await page.goto('/admin/roles')
  const row = page.locator('tr').filter({ hasText: role.name })
  await row.getByRole('button', { name: /delete|삭제/i }).click({ timeout: 15000 })
  await page.getByTestId('confirm-dialog-ok').click()
  await expect(page.getByTestId('admin-roles-delete-error')).toContainText(role.name, { timeout: 15000 })
  await expect(row).toHaveCount(1)
})

test('deleting a team clears it from the accounts that named it', async ({ request }) => {
  const name = `e2e-edge-team-${stamp}`
  const t = await request.post('/api/v1/auth/admin/organizations', { headers: admin, data: { type: 'team', name } })
  expect(t.status(), await t.text()).toBeLessThan(300)
  const teamId = (await t.json()).id as number
  teams.push(teamId)
  const u = await mkUser(request, 'member', await roleId(request, 'Member'), name)
  const team = async () => {
    const list = await (await request.get('/api/v1/auth/admin/users?limit=500', { headers: admin })).json()
    return (Array.isArray(list) ? list : list.users || list.items || []).find((x: { id: string }) => x.id === u.id)?.team ?? null
  }
  expect(await team()).toBe(name)
  expect((await request.delete(`/api/v1/auth/admin/organizations/${teamId}`, { headers: admin })).status()).toBe(204)
  expect(await team()).toBeNull()
})

test('a session that ends without signing out is told on the sign-in page; signing out is not', async ({ page, request }) => {
  const u = await mkUser(request, 'session', await roleId(request, 'Member'))
  expect((await request.put(`/api/v1/auth/admin/users/${u.id}/cluster-roles/default`, { headers: admin, data: { role: 'Read', namespaces: [] } })).status()).toBeLessThan(300)
  await uiLogin(page, u.email, u.password)
  await page.goto('/workloads/pods?cluster=default')
  // an admin changes the account's access: its tokens end
  expect((await request.delete(`/api/v1/auth/admin/users/${u.id}/cluster-roles/default`, { headers: admin })).status()).toBe(204)
  // the page's own next request may get the 401 first and go to the sign-in page itself: either way is the case
  await page.reload().catch(() => undefined)
  await expect(page).toHaveURL(/\/login/, { timeout: 15000 })
  await expect(page.getByTestId('login-session-ended')).toHaveCount(1)
  // shown once
  await page.reload()
  await expect(page.getByTestId('login-session-ended')).toHaveCount(0)
  // signing out on purpose: no notice
  await uiLogin(page, u.email, u.password)
  await page.getByRole('button', { name: /log out|로그아웃/i }).first().click()
  await expect(page).toHaveURL(/\/login/, { timeout: 15000 })
  await expect(page.getByTestId('login-session-ended')).toHaveCount(0)
})

test('a role with the cluster permissions opens Clusters; its cluster picker lists only the clusters it reaches', async ({ page, request }) => {
  const role = await mkRole(request, 'clustermgr', ['menu.dashboard', 'admin.clusters.list', 'admin.clusters.update', 'resource.*.read'])
  const u = await mkUser(request, 'clustermgr', role.id)
  expect((await request.put(`/api/v1/auth/admin/users/${u.id}/cluster-roles/default`, { headers: admin, data: { role: 'Read', namespaces: [] } })).status()).toBeLessThan(300)
  const mine = await bearer(request, u.email, u.password)
  const all = ((await (await request.get('/api/v1/clusters', { headers: mine })).json()).items as Array<{ id: string }>).map((c) => c.id)
  const reached = ((await (await request.get('/api/v1/clusters?accessibleOnly=true', { headers: mine })).json()).items as Array<{ id: string }>).map((c) => c.id)
  expect(all).toEqual(expect.arrayContaining(['self', 'default']))
  expect(reached).toEqual(['default'])
  await uiLogin(page, u.email, u.password)
  await page.goto('/admin/clusters')
  await expect(page).toHaveURL(/\/admin\/clusters/, { timeout: 15000 })
  await expect(page.getByTestId('sidebar-nav').getByRole('link', { name: 'Clusters' })).toHaveCount(1)
})

test('someone with no cluster sees the no-cluster page without a "no permission in this cluster" notice', async ({ page, request }) => {
  const u = await mkUser(request, 'nocluster', await roleId(request, 'Member'))
  await uiLogin(page, u.email, u.password)
  await page.goto('/')
  await expect(page.getByTestId('no-accessible-cluster')).toHaveCount(1, { timeout: 15000 })
  await page.waitForTimeout(2000)
  await expect(page.getByTestId('forbidden-banner')).toHaveCount(0)
})

test('an Admin grant on one cluster opens no admin page, as its APIs refuse; its screens and Node Shell stay, the global admin keeps every admin page', async ({ page, request, browser }) => {
  test.setTimeout(240000)
  const u = await mkUser(request, 'clusteradmin', await roleId(request, 'Member'))
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  try {
    expect((await request.put(`/api/v1/auth/admin/users/${u.id}/cluster-roles/self`, { headers: admin, data: { role: 'Admin', namespaces: [] } })).status()).toBeLessThan(300)
    // what the server gives it: the admin APIs (global admin.* keys) refuse, the cluster answers
    const mine = await bearer(request, u.email, u.password)
    const answers: number[] = []
    for (const path of ['/api/v1/auth/admin/users', '/api/v1/auth/admin/audit-logs?limit=1', '/api/v1/cluster/namespaces?cluster=self']) {
      answers.push((await request.get(path, { headers: mine, failOnStatusCode: false })).status())
    }
    expect(answers, 'users, audit log, self namespaces').toEqual([403, 403, 200])

    // the global admin: every admin entry this install turns on, each opening
    await uiLogin(page, ADMIN_EMAIL, ADMIN_PASSWORD)
    const globalNav = await sidebarPaths(page)
    const adminPages = globalNav.filter((p) => p.startsWith('/admin/') && p !== '/admin/node-shell')
    expect.soft(adminPages, 'the admin entries every install has').toEqual(expect.arrayContaining(['/admin/clusters', '/admin/users', '/admin/roles', '/admin/organizations', '/admin/audit', '/admin/session-recordings']))
    for (const p of [...adminPages, '/admin/node-shell']) expect.soft((await settledPath(page, `${p}?cluster=self`)).path, `the global admin opens ${p}`).toBe(p)

    // the Admin grant on self, every sidebar entry it was ever drawn recorded (no admin entry drawn, then taken away)
    await ctx.addInitScript(() => {
      const seen = new Set<string>()
      Object.assign(window, { __navSeen: seen })
      new MutationObserver(() => {
        document.querySelectorAll('[data-testid="sidebar-nav"] a[href]').forEach((a) => seen.add(new URL((a as HTMLAnchorElement).href).pathname))
      }).observe(document, { childList: true, subtree: true })
    })
    const mp = await ctx.newPage()
    await uiLogin(mp, u.email, u.password)
    const nav = await sidebarPaths(mp)
    const seen = await mp.evaluate(() => [...(window as unknown as { __navSeen: Set<string> }).__navSeen])
    expect.soft(nav.filter((p) => p.startsWith('/admin/')), 'its admin entries').toEqual(['/admin/node-shell'])
    expect.soft(seen.filter((p) => p.startsWith('/admin/')).sort(), 'the admin entries ever drawn').toEqual(['/admin/node-shell'])
    expect.soft(nav.filter((p) => !p.startsWith('/admin/')), 'its other entries: the global admin\'s on self').toEqual(globalNav.filter((p) => !p.startsWith('/admin/')))
    // and by address, the setup wizard (admin.clusters.create) too
    const byAddress = [...adminPages, '/setup']
    const sentTo: string[] = []
    for (const p of byAddress) sentTo.push((await settledPath(mp, `${p}?cluster=self`)).path)
    expect.soft(sentTo, `${byAddress.join(', ')} by address`).toEqual(byAddress.map(() => '/'))
    // the cluster's own pages stay
    expect.soft(await settledPath(mp, '/admin/node-shell?cluster=self'), 'Node Shell').toEqual({ path: '/admin/node-shell', heading: 'Node Shell' })
    expect.soft(await settledPath(mp, '/workloads/pods?cluster=self'), 'Pods').toEqual({ path: '/workloads/pods', heading: 'Pods' })
  } finally {
    await ctx.close()
    await request.delete(`/api/v1/auth/admin/users/${u.id}`, { headers: admin, failOnStatusCode: false })
  }
})
