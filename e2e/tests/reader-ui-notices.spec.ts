import { test, expect, type APIRequestContext, type Browser } from '@playwright/test'

// Two notices for non-admin users found by walking the UI as a Read user:
//  - a viewer may list most kinds but not Secrets (cluster RBAC 403): the page
//    says so instead of "No secrets found"
//  - a user with no cluster grant sees the "no accessible cluster" notice, the
//    footer says so, and no resource page mounts (no cluster API 403 storm)
//  - a custom role the cluster has not bound is told which group it acts as
//    (banner) and the role form shows that group while the name is typed

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

async function createUser(request: APIRequestContext, admin: Record<string, string>, tag: string) {
  const email = `e2e-${tag}-${Date.now()}@kubeast.local`
  const password = 'e2e-reader-throwaway'
  const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: `E2E ${tag}`, email, password } })
  expect(created.status()).toBe(201)
  return { id: (await created.json()).id as string, email, password }
}

// A fresh browser context whose session cookie belongs to the user.
async function userPage(browser: Browser, email: string, password: string) {
  const ctx = await browser.newContext({ baseURL: BASE })
  const login = await ctx.request.post('/api/v1/auth/login', { data: { email, password } })
  expect(login.ok(), `login ${email}`).toBeTruthy()
  return { ctx, page: await ctx.newPage() }
}

test.describe('non-admin UI notices', () => {
  test('a viewer sees a permission notice on the Secrets page', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const user = await createUser(request, admin, 'viewer')
    try {
      const grant = await request.put(`/api/v1/auth/admin/users/${user.id}/cluster-roles/self`, { headers: admin, data: { role: 'Read' } })
      expect(grant.status()).toBe(200)
      const { ctx, page } = await userPage(browser, user.email, user.password)
      await page.goto('/configuration/secrets?cluster=self')
      await expect(page.getByTestId('secrets-forbidden')).toBeVisible({ timeout: 20000 })
      await expect(page.getByTestId('secrets-forbidden')).toContainText('permission')
      await ctx.close()
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${user.id}`, { headers: admin })
    }
  })

  // The banner above the page (fed by the API client's 403 event) names the kinds the viewer cannot list, instead of
  // the page passing a 403 off as an empty list. Secrets are what the Read role does not read (view leaves them out).
  test('a viewer sees the permission banner naming the kind it cannot list (Secrets)', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const user = await createUser(request, admin, 'viewer-roles')
    try {
      const grant = await request.put(`/api/v1/auth/admin/users/${user.id}/cluster-roles/self`, { headers: admin, data: { role: 'Read' } })
      expect(grant.status()).toBe(200)
      const { ctx, page } = await userPage(browser, user.email, user.password)
      await page.goto('/configuration/secrets?cluster=self')
      const banner = page.getByTestId('forbidden-banner')
      await expect(banner).toBeVisible({ timeout: 20000 })
      await expect(banner).toContainText(/permission|권한/)
      // the Kubernetes kind name (re-QA #42), not "secrets"
      await expect(banner).toContainText('Secret')
      await expect(banner).not.toContainText('secrets')
      // a built-in role acts as a group the chart binds: no custom-role hint
      await expect(page.getByTestId('forbidden-custom-role-hint')).toHaveCount(0)
      // another page resets the banner; a page the viewer may read shows none
      await page.goto('/workloads/pods?cluster=self')
      await expect(page.getByRole('heading', { level: 1, name: /^(Pods|파드)$/ })).toBeVisible()
      await expect(page.getByTestId('forbidden-banner')).toHaveCount(0)
      await ctx.close()
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${user.id}`, { headers: admin })
    }
  })

  // The Read role reads every kind but Secrets (docs/features.md): a viewer opens every screen of the sidebar it sees on
  // test2 — the dev cluster that also serves the Gateway API and VPA — and the cluster refuses no list request but the
  // Secret-backed ones (Secrets, Helm releases). Every refused request is listed, so a kind kubeast:cluster-reader
  // leaves out names itself, a new screen's included.
  test('a viewer is refused nothing but Secrets on every screen of its sidebar', async ({ browser, request }) => {
    test.setTimeout(600_000)
    const admin = await adminHeaders(request)
    const body = await (await request.get('/api/v1/clusters', { headers: admin })).json()
    const registered = (Array.isArray(body) ? body : body.items ?? []).some((c: { id: string }) => c.id === 'test2')
    test.skip(!registered, 'needs the dev cluster test2 registered (scripts/add-kind-cluster.sh test2)')
    const user = await createUser(request, admin, 'viewer-all')
    try {
      const grant = await request.put(`/api/v1/auth/admin/users/${user.id}/cluster-roles/test2`, { headers: admin, data: { role: 'Read' } })
      expect(grant.status()).toBe(200)
      const { ctx, page } = await userPage(browser, user.email, user.password)
      await page.setViewportSize({ width: 1600, height: 1000 })
      const refused: string[] = []
      page.on('response', (r) => {
        const url = new URL(r.url())
        if (r.status() === 403 && url.pathname.startsWith('/api/')) refused.push(`${new URL(page.url()).pathname} → ${url.pathname}`)
      })
      await page.goto('/?cluster=test2')
      const nav = page.getByTestId('sidebar-nav')
      await expect(nav).toBeVisible({ timeout: 20000 })
      const screens = [...new Set(await nav.locator('a[href^="/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href') as string)))]
      expect(screens.length, `screens on a viewer's sidebar: ${screens.join(' ')}`).toBeGreaterThan(40)
      for (const href of screens) {
        await page.goto(`${href}${href.includes('?') ? '&' : '?'}cluster=test2`)
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
      }
      const secretBacked = (r: string) => /\/secrets(\/|$)|\/helm\//.test(r)
      expect(refused.filter((r) => !secretBacked(r)), 'requests the cluster refused a viewer, Secrets aside').toEqual([])
      expect(refused.some((r) => r.startsWith('/configuration/secrets') && secretBacked(r)), 'the Secrets page is refused').toBe(true)
      // Gateway → Policies answers every policy kind it scanned in one 200, a refused kind with its error
      const policies = await (await ctx.request.get('/api/v1/cluster/gateway-policies/all?cluster=test2')).json()
      const kinds: { plural: string; error?: string }[] = policies.kinds ?? []
      expect(kinds.length, 'policy kinds test2 serves').toBeGreaterThan(0)
      expect(kinds.filter((k) => k.error).map((k) => `${k.plural}: ${k.error}`), 'policy kinds refused a viewer').toEqual([])
      await ctx.close()
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${user.id}`, { headers: admin })
    }
  })

  // Helm keeps releases in Secrets, so the same viewer gets 403 on the release
  // list once the Helm calls run as the user.
  test('a viewer sees a permission notice on the Helm releases page', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const user = await createUser(request, admin, 'viewer-helm')
    try {
      const grant = await request.put(`/api/v1/auth/admin/users/${user.id}/cluster-roles/self`, { headers: admin, data: { role: 'Read' } })
      expect(grant.status()).toBe(200)
      const { ctx, page } = await userPage(browser, user.email, user.password)
      const list = await ctx.request.get('/api/v1/helm/releases?cluster=self')
      expect(list.status(), 'viewer helm list').toBe(403)
      await page.goto('/helm/releases?cluster=self')
      await expect(page.getByTestId('helm-forbidden')).toBeVisible({ timeout: 20000 })
      // says why: Helm keeps its records in Secrets, which Read cannot read
      await expect(page.getByTestId('helm-forbidden')).toContainText(/Secrets?.*Read cannot|Secret을 읽을 수 없어/)
      await ctx.close()
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${user.id}`, { headers: admin })
    }
  })

  // A custom role acts on the cluster as kubeast:role:<slug>; the dev cluster
  // neither allows nor binds that group, so every list is refused — the banner
  // names the group and the chart setting instead of a bare "no permission".
  test('a custom role without a cluster binding sees which group the cluster refuses', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const user = await createUser(request, admin, 'customrole')
    const roleName = `E2E Hint ${Date.now()}`
    let roleId: number | undefined
    try {
      const role = await request.post('/api/v1/auth/admin/roles', {
        headers: admin,
        data: { name: roleName, description: 'e2e', permissions: ['menu.workloads', 'resource.*.read'] },
      })
      expect(role.status(), await role.text()).toBe(201)
      roleId = (await role.json()).id as number
      const grant = await request.put(`/api/v1/auth/admin/users/${user.id}/cluster-roles/self`, { headers: admin, data: { role: roleName } })
      expect(grant.status()).toBe(200)
      const { ctx, page } = await userPage(browser, user.email, user.password)
      const pods = await ctx.request.get('/api/v1/cluster/namespaces/default/pods?cluster=self')
      expect(pods.status(), 'the cluster refuses the unbound group').toBe(403)
      await page.goto('/workloads/pods?cluster=self')
      await expect(page.getByTestId('forbidden-banner')).toBeVisible({ timeout: 20000 })
      const hint = page.getByTestId('forbidden-custom-role-hint')
      await expect(hint).toContainText(`kubeast:role:${roleName.toLowerCase().replace(/ /g, '-')}`)
      await expect(hint).toContainText('auth.impersonation.customRoles')
      await ctx.close()
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${user.id}`, { headers: admin })
      if (roleId) await request.delete(`/api/v1/auth/admin/roles/${roleId}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('the role form shows the group a custom role will act as', async ({ page }) => {
    await page.goto('/admin/roles')
    await page.getByRole('button', { name: /^(Create Role|역할 생성)$/ }).click()
    const name = page.getByPlaceholder(/InfraManager/)
    await expect(page.getByTestId('role-group-hint')).toHaveCount(0)
    await name.fill('Infra Manager')
    await expect(page.getByTestId('role-group-hint')).toContainText('kubeast:role:infra-manager')
    await name.fill('Read')
    await expect(page.getByTestId('role-group-hint')).toHaveCount(0)
  })

  test('a user with no cluster grant gets the notice and no cluster requests', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const user = await createUser(request, admin, 'nogrant')
    try {
      const { ctx, page } = await userPage(browser, user.email, user.password)
      const clusterRequests: string[] = []
      page.on('request', (r) => {
        const path = r.url().replace(BASE, '')
        if (/^\/api\/v1\/cluster\/(overview|namespaces|nodes|metrics|pods|deployments)/.test(path)) clusterRequests.push(path)
      })
      await page.goto('/')
      await expect(page.getByTestId('no-accessible-cluster')).toBeVisible({ timeout: 20000 })
      await expect(page.getByTestId('cluster-status')).toContainText('No accessible cluster')
      await page.waitForTimeout(2000)
      expect(clusterRequests, 'no resource page mounted').toEqual([])
      await ctx.close()
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${user.id}`, { headers: admin })
    }
  })
})
