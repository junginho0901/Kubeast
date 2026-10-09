import { test, expect, type APIRequestContext, type Browser } from '@playwright/test'

// Re-QA PR-5: the console says what really happened instead of "no … found"
// or a blank page —
//  #64 a list that failed on the server: "could not load (503)" and a retry
//  #65 an address no screen has: a 404 screen with a way back
//  #37/#42 a Gateway API kind whose CRD the cluster lacks: "not installed" for
//          every role (a Read user got "no permission", an admin "none"), no create button
//  #45 rest a cluster-scoped create button only where the cluster allows it
//          (SelfSubjectAccessReview): not for Write, yes for an admin
//  #43 a Read user's ServiceAccount drawer: bindings it may not list are "cannot check", not "none"
//  #44 a Read user's Helm release page: "no permission", not "not found"
//  #72/#73 a user with no cluster: the chart's "where to ask" text and link, and the
//          footer says "no accessible cluster" on Settings too
// The dev install has no Gateway API CRDs on self and sets auth.accessHelp (deploy/kind/values.yaml).

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const CREATE_BUTTON = 'button.btn-primary:has(svg.lucide-plus)'

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

// A temporary user with an optional role on self, and a browser signed in as it.
async function tempUser(browser: Browser, request: APIRequestContext, admin: Record<string, string>, tag: string, clusterRole?: string) {
  const email = `e2e-notices-${tag}-${Date.now()}@kubeast.local`
  const password = 'e2e-notices-throwaway'
  const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: `E2E notices ${tag}`, email, password } })
  expect(created.status()).toBe(201)
  const id = (await created.json()).id as string
  if (clusterRole) {
    expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: admin, data: { role: clusterRole } })).status()).toBe(200)
  }
  const ctx = await browser.newContext({ baseURL: BASE })
  expect((await ctx.request.post('/api/v1/auth/login', { data: { email, password } })).ok(), `login ${email}`).toBeTruthy()
  return {
    page: await ctx.newPage(),
    done: async () => {
      await ctx.close()
      await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
    },
  }
}

test.describe('notices instead of "nothing here"', () => {
  test('a list that fails on the server says so and retries', async ({ page }) => {
    let fail = true
    await page.route('**/api/v1/cluster/deployments/all**', (route) =>
      fail ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"injected"}' }) : route.continue(),
    )
    await page.goto('/workloads/deployments?cluster=self')
    const row = page.getByTestId('table-load-error')
    await expect(row).toBeVisible({ timeout: 20000 })
    await expect(row).toContainText('503')
    fail = false
    await page.getByTestId('table-load-error-retry').click()
    await expect(row).toHaveCount(0, { timeout: 20000 })
    await expect(page.locator('tbody tr').first()).not.toContainText(/No .* found|찾을 수 없/)
  })

  test('an address no screen has shows a 404 screen with a way back', async ({ page }) => {
    await page.goto('/this-route-does-not-exist')
    await expect(page.getByTestId('not-found')).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('not-found')).toContainText('/this-route-does-not-exist')
    await expect(page.getByTestId('cluster-status')).toBeVisible() // the sidebar is there
    await page.getByTestId('not-found-home').click()
    await expect(page).toHaveURL(new URL('/', BASE).toString())
  })

  test('a Gateway API kind the cluster lacks is "not installed" for an admin and a Read user, with no create button', async ({ browser, page, request }) => {
    const admin = await adminHeaders(request)
    const probe = await request.get('/api/v1/cluster/httproutes/all?cluster=self', { headers: admin })
    test.skip(!probe.headers()['x-kubeast-not-installed'], 'self serves HTTPRoute: the Gateway API CRDs are installed')

    await page.goto('/gateway/httproutes?cluster=self')
    await expect(page.getByTestId('table-not-installed')).toContainText('HTTPRoute', { timeout: 20000 })
    await expect(page.locator(CREATE_BUTTON)).toHaveCount(0)

    const reader = await tempUser(browser, request, admin, 'read', 'Read')
    try {
      await reader.page.goto('/gateway/httproutes?cluster=self')
      await expect(reader.page.getByTestId('table-not-installed')).toBeVisible({ timeout: 20000 })
      await expect(reader.page.getByTestId('forbidden-banner')).toHaveCount(0)
    } finally {
      await reader.done()
    }
  })

  test('a cluster-scoped create button shows only where the cluster allows it', async ({ browser, page, request }) => {
    const admin = await adminHeaders(request)
    await page.goto('/cluster/priorityclasses?cluster=self')
    await expect(page.locator(CREATE_BUTTON)).toHaveCount(1, { timeout: 20000 })

    const writer = await tempUser(browser, request, admin, 'write', 'Write')
    try {
      // the app permission says yes (resource.*.create), the cluster says no
      const canI = await (await writer.page.request.get('/api/v1/cluster/can-i?cluster=self&verb=create&group=scheduling.k8s.io&resource=priorityclasses')).json()
      expect(canI.allowed).toBe(false)
      await writer.page.goto('/cluster/priorityclasses?cluster=self')
      await expect(writer.page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20000 })
      await expect(writer.page.locator('tbody tr').first()).toBeVisible({ timeout: 20000 })
      await expect(writer.page.locator(CREATE_BUTTON)).toHaveCount(0)
      // a namespaced kind Write may create keeps its button
      await writer.page.goto('/configuration/configmaps?cluster=self')
      await expect(writer.page.locator(CREATE_BUTTON)).toHaveCount(1, { timeout: 20000 })
    } finally {
      await writer.done()
    }
  })

  test('a Read user: unlistable bindings are "cannot check", a refused Helm release is "no permission"', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const reader = await tempUser(browser, request, admin, 'read2', 'Read')
    try {
      await reader.page.goto('/security/serviceaccounts?cluster=self')
      await reader.page.locator('tbody tr').filter({ hasText: 'default' }).first().click()
      const drawer = reader.page.locator(DRAWER).last()
      await expect(drawer.getByTestId('sa-bindings-unreadable')).toContainText('RoleBinding', { timeout: 20000 })
      await expect(drawer.getByText(/No RoleBinding or ClusterRoleBinding binds|묶는 RoleBinding·ClusterRoleBinding이 없습니다/)).toHaveCount(0)

      await reader.page.goto('/helm/releases/kubeast/kubeast?cluster=self')
      await expect(reader.page.getByTestId('helm-release-forbidden')).toBeVisible({ timeout: 20000 })
    } finally {
      await reader.done()
    }
  })

  test('a user with no cluster sees where to ask, and the footer agrees on Settings', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const cfg = await (await request.get('/api/v1/auth/access-requests/config', { headers: admin })).json()
    test.skip(!cfg.help_url, 'auth.accessHelp is not set on this install')
    const member = await tempUser(browser, request, admin, 'member')
    try {
      await member.page.goto('/')
      await expect(member.page.getByTestId('no-accessible-cluster')).toBeVisible({ timeout: 20000 })
      await expect(member.page.getByTestId('access-help')).toContainText(cfg.help_text)
      await expect(member.page.getByTestId('access-help-link')).toHaveAttribute('href', cfg.help_url)

      await member.page.goto('/account')
      await expect(member.page.getByTestId('cluster-status')).toContainText(/No accessible cluster|접근 가능한 클러스터 없음/, { timeout: 20000 })
      await expect(member.page.getByTestId('access-help').first()).toBeVisible()
    } finally {
      await member.done()
    }
  })
})
