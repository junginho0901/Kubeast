import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// A-4 (records/ns-scope-20261012.md §6-9): the screens for namespace-scoped grants. An admin limits a grant to
// namespaces from the user's cluster-role matrix; the scoped user sees the limit in the permission notice, and the
// access-request form is prefilled with (and kept within) the scope. Throwaway user removed at the end.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-nsui-throwaway-1!'
const CLUSTER = 'self'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E ns ui', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  return madeUser((await res.json()).id, bearer(admin))
}

async function loginUI(page: Page, email: string, password: string): Promise<void> {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
}

test.describe('namespace-scoped grants in the UI', () => {
  test('the cluster-role matrix limits a grant to namespaces, and the grant list shows it', async ({ page, request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const email = `e2e-nsui-${Date.now().toString(36)}@kubeast.local`
    let userId = ''
    try {
      userId = await createUser(request, admin, email)
      await page.goto('/admin/users')
      // the list pages as many rows as fit the screen: find the account by its email
      await page.getByTestId('admin-users-search').fill(email)
      await page.getByTestId(`user-detail-${email}`).click()
      await expect(page.getByTestId('cluster-role-matrix')).toBeVisible({ timeout: 10_000 })

      // Role first; the namespace box appears next to a granted role.
      await page.getByTestId(`cluster-role-${CLUSTER}`).click()
      await page.getByTestId(`cluster-role-${CLUSTER}-opt-Read`).click()
      const box = page.getByTestId(`cluster-role-${CLUSTER}-namespaces`)
      await expect(box).toBeVisible({ timeout: 10_000 })
      await box.fill('Web, api, web')
      await box.press('Enter')

      await expect.poll(async () => {
        const grants = await (await request.get(`/api/v1/auth/admin/users/${userId}/cluster-grants`, { headers: bearer(admin) })).json()
        return (grants as { cluster_id: string; role: string; namespaces?: string[] }[]).find((g) => g.cluster_id === CLUSTER)
      }, { timeout: 10_000 }).toEqual({ cluster_id: CLUSTER, role: 'Read', namespaces: ['api', 'web'] })
      // The box shows the normalized list after the grant is read back.
      await expect(box).toHaveValue('api, web')

      // Clearing the box widens the grant back to the whole cluster.
      await box.fill('')
      await box.press('Enter')
      await expect.poll(async () => {
        const grants = await (await request.get(`/api/v1/auth/admin/users/${userId}/cluster-grants`, { headers: bearer(admin) })).json()
        return (grants as { cluster_id: string; namespaces?: string[] }[]).find((g) => g.cluster_id === CLUSTER)?.namespaces
      }, { timeout: 10_000 }).toBeUndefined()

      // The per-cluster access list carries the scope too.
      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: ['web'] } })).ok()).toBeTruthy()
      const list = await (await request.get(`/api/v1/auth/admin/clusters/${CLUSTER}/user-roles`, { headers: bearer(admin) })).json()
      expect((list as { email: string; namespaces?: string[] }[]).find((r) => r.email === email)?.namespaces).toEqual(['web'])

      // And the access review's cluster-roles section names the scope on the grant's row.
      await page.goto('/admin/access-review')
      await page.getByTestId('access-review-tab-cluster_roles').click()
      // the tab pages its rows: find the grant by the account's email
      await page.getByPlaceholder(/Search|검색/).fill(email)
      await expect(page.getByTestId('access-review-row').filter({ hasText: email })).toContainText('web')
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  // The cluster refuses the node list to a grant limited to namespaces. The Dashboard asked it, tried it again a second
  // later and asked it every minute, as every read on a timer did; it now asks each refused read once while the page is
  // open, two minutes here (the node list's timer twice over).
  test('a scoped user\'s Dashboard asks each read the cluster refuses once while it stays open', async ({ page, request }) => {
    test.setTimeout(240_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const email = `e2e-nsui-${Date.now().toString(36)}@kubeast.local`
    let userId = ''
    try {
      userId = await createUser(request, admin, email)
      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: ['api', 'web'] } })).ok()).toBeTruthy()
      await loginUI(page, email, PW)
      // a page that reads no node list, so nothing of the page signed in on is still on its way
      await page.goto('/account')

      const isNodeList = (url: string) => {
        const u = new URL(url)
        return u.pathname === '/api/v1/cluster/nodes' && u.searchParams.get('cluster') === CLUSTER
      }
      const asked: string[] = []
      const answered: number[] = []
      // each refused request of the page, by path and query, and how many times it went
      const refused = new Map<string, number>()
      page.on('request', (r) => { if (isNodeList(r.url())) asked.push(r.url()) })
      page.on('response', (r) => {
        const u = new URL(r.url())
        if (isNodeList(r.url())) answered.push(r.status())
        if (r.status() === 403 && u.pathname.startsWith('/api/v1/')) refused.set(`${u.pathname}${u.search}`, (refused.get(`${u.pathname}${u.search}`) ?? 0) + 1)
      })
      await page.goto('/')
      await expect(page.getByTestId('forbidden-banner')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('stat-value-nodes')).toHaveText('—')
      // past the second a refused read was tried again after
      await page.waitForTimeout(3_000)
      expect({ asked: asked.length, answered }).toEqual({ asked: 1, answered: [403] })

      // two minutes on the page: the node list's minute twice, the overview's 15 s and the Prometheus 30 s many times
      await page.waitForTimeout(120_000)
      const again = [...refused].filter(([, times]) => times > 1)
      expect({ nodeListAsked: asked.length, refusedMoreThanOnce: again }).toEqual({ nodeListAsked: 1, refusedMoreThanOnce: [] })
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  // The cluster's RBAC edited with kubectl leaves the account's access in Kubeast, and /auth/me, as they were. The
  // refused node list asks once more when the person comes back to the tab a minute or more after the refusal, so the
  // Dashboard reads it on the same screen; back within the minute, or not back at all, it asks nothing.
  test('a scoped user\'s Dashboard reads the node list again on the same screen once the cluster allows it', async ({ page, request }) => {
    test.setTimeout(240_000)
    const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-nsui-')), 'kubeconfig')
    fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
    const kubectl = (args: string) => execSync(`kubectl --kubeconfig ${kc} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const stamp = Date.now().toString(36)
    const email = `e2e-nsui-${stamp}@kubeast.local`
    // a grant limited to namespaces reaches the cluster in the group of its role, kubeast:role:read here
    const nodesRole = `e2e-nsui-nodes-${stamp}`
    let userId = ''
    // the tab hidden and shown again, as when the person comes back to it from another tab or window
    const backOnTab = () => page.evaluate(() => {
      for (const state of ['hidden', 'visible']) {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
      }
    })
    try {
      userId = await createUser(request, admin, email)
      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: ['api', 'web'] } })).ok()).toBeTruthy()
      await loginUI(page, email, PW)
      await page.goto('/account')

      const answered: number[] = []
      page.on('response', (r) => {
        const u = new URL(r.url())
        if (u.pathname === '/api/v1/cluster/nodes' && u.searchParams.get('cluster') === CLUSTER) answered.push(r.status())
      })
      await page.goto('/')
      await expect.poll(() => answered, { timeout: 20_000 }).toEqual([403])
      await backOnTab()
      await page.waitForTimeout(3_000)
      expect(answered, 'back on the tab within the minute').toEqual([403])

      kubectl(`create clusterrole ${nodesRole} --verb=get,list,watch --resource=nodes`)
      kubectl(`create clusterrolebinding ${nodesRole} --clusterrole=${nodesRole} --group=kubeast:role:read`)
      // past the minute, and past the 60 s k8s-service keeps an access answer, with no return to the tab
      await page.waitForTimeout(65_000)
      expect(answered, 'allowed, the person not back on the tab').toEqual([403])

      await backOnTab()
      await expect.poll(() => answered, { timeout: 20_000, message: 'back on the tab: the node list read on the same screen' }).toEqual([403, 200])
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
      for (const kind of ['clusterrolebinding', 'clusterrole']) {
        try { kubectl(`delete ${kind} ${nodesRole} --ignore-not-found`) } catch { /* a failed delete does not hide the test's own failure */ }
      }
    }
  })

  test('a scoped user sees the limit in the notice and requests access within it', async ({ page, request }) => {
    test.setTimeout(90_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const cfg = await request.get('/api/v1/auth/access-requests/config', { headers: bearer(admin) })
    test.skip(!cfg.ok() || !(await cfg.json()).enabled, 'access requests are off (auth.accessRequests.enabled)')
    const email = `e2e-nsui-${Date.now().toString(36)}@kubeast.local`
    let userId = ''
    try {
      userId = await createUser(request, admin, email)
      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: ['api', 'web'] } })).ok()).toBeTruthy()

      // The dashboard: cluster-wide reads are refused for the scoped group, and the notice names the scope.
      await loginUI(page, email, PW)
      await page.goto('/')
      await expect(page.getByTestId('forbidden-banner')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('forbidden-namespace-hint')).toContainText('api, web')
      // nodes are not counted for a namespace-scoped grant: no number rather than a 0 that reads as "no nodes"
      await expect(page.getByTestId('stat-value-nodes')).toHaveText('—')

      // The request form is prefilled with the scope and cannot leave it empty.
      await page.goto('/account')
      await page.getByTestId(`access-request-open-${CLUSTER}`).click()
      await expect(page.getByTestId('access-request-modal')).toBeVisible()
      const ns = page.getByTestId('access-request-namespaces')
      await expect(ns).toHaveValue('api, web')
      await expect(page.getByTestId('access-request-namespaces-hint')).toContainText('api, web')
      await page.getByTestId('access-request-reason').fill('e2e: namespace-scoped request')
      await ns.fill('')
      await expect(page.getByTestId('access-request-submit')).toBeDisabled()
      await ns.fill('web')
      await expect(page.getByTestId('access-request-submit')).toBeEnabled()
      await page.getByTestId('access-request-submit').click()
      await expect(page.getByTestId('access-request-modal')).toBeHidden({ timeout: 10_000 })

      const user = await login(request, email, PW)
      const mine = await (await request.get('/api/v1/auth/access-requests', { headers: bearer(user) })).json()
      const req = (mine as { id: string; status: string; namespaces?: string[] }[]).find((r) => r.status === 'pending')
      expect(req?.namespaces).toEqual(['web'])
      expect((await request.delete(`/api/v1/auth/access-requests/${req!.id}`, { headers: bearer(user) })).status()).toBe(204)
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})

// Accounts made by the tests above are deleted after each test as well: a test that times out has its request context
// ended before its own finally runs, so the delete there never reaches the server. A second delete answers 404.
const madeUsers: { id: string; headers: Record<string, string> }[] = []
function madeUser<T>(id: T, headers: Record<string, string>): T {
  madeUsers.push({ id: String(id), headers })
  return id
}
test.afterEach(async ({ request }) => {
  for (const { id, headers } of madeUsers.splice(0)) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers, failOnStatusCode: false })
})
