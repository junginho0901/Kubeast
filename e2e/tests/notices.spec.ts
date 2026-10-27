import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Browser } from '@playwright/test'

// Re-QA PR-5: the console says what really happened instead of "no … found"
// or a blank page —
//  #64 a list that failed on the server: "could not load (503)" and a retry
//  #65 an address no screen has: a 404 screen with a way back
//  #37/#42 a Gateway API kind whose CRD the cluster lacks: "not installed" for
//          every role (a Read user got "no permission", an admin "none"), no create button
//  #45 rest a cluster-scoped create button only where the cluster allows it
//          (SelfSubjectAccessReview): not for Write, yes for an admin
//  #43 a ServiceAccount drawer: bindings the user may not list are "cannot check", not "none" (a Read user
//          lists them through kubeast:cluster-reader; a namespace-limited reader bound to view does not)
//  #44 a Read user's Helm release page: "no permission", not "not found"
//  #72/#73 a user with no cluster: the chart's "where to ask" text and link, and the
//          footer says "no accessible cluster" on Settings too
//  a user with no role on self: the first page asked the feature flags before the picker chose a
//          cluster, the server answered for self (403) and every first page said "no permission"
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

function kubectl(args: string) {
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-notices-')), 'kubeconfig')
  fs.writeFileSync(kcPath, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
  return execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

// A temporary user with an optional role on self (limited to namespaces when given), and a browser signed in as it.
async function tempUser(browser: Browser, request: APIRequestContext, admin: Record<string, string>, tag: string, clusterRole?: string, namespaces?: string[]) {
  const email = `e2e-notices-${tag}-${Date.now()}@kubeast.local`
  const password = 'e2e-notices-throwaway'
  const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: `E2E notices ${tag}`, email, password } })
  expect(created.status()).toBe(201)
  const id = (await created.json()).id as string
  if (clusterRole) {
    expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: admin, data: { role: clusterRole, ...(namespaces ? { namespaces } : {}) } })).status()).toBe(200)
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

  test('a Read user: the bindings are listed, a refused Helm release is "no permission"', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const reader = await tempUser(browser, request, admin, 'read2', 'Read')
    try {
      expect(await (await reader.page.request.get('/api/v1/cluster/rolebindings/all?cluster=self')).status()).toBe(200)
      await reader.page.goto('/security/serviceaccounts?cluster=self')
      await reader.page.locator('tbody tr').filter({ hasText: 'default' }).first().click()
      const drawer = reader.page.locator(DRAWER).last()
      // the loaded title counts the bindings ("(n bindings)") only when every binding kind could be listed
      await expect(drawer.getByText(/Effective Permissions \(\d+ bindings?\)|실효 권한 \(바인딩 \d+개\)/)).toHaveCount(1, { timeout: 20000 })
      await expect(drawer.getByTestId('sa-bindings-unreadable')).toHaveCount(0)

      await reader.page.goto('/helm/releases/kubeast/kubeast?cluster=self')
      await expect(reader.page.getByTestId('helm-release-forbidden')).toContainText(/Secrets?.*Read cannot|Secret을 읽을 수 없어/, { timeout: 20000 })
    } finally {
      await reader.done()
    }
  })

  test('a namespace-limited reader bound to view: unlistable bindings are "cannot check"', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const binding = `e2e-notices-view-${Date.now()}`
    // view lists ServiceAccounts in default but not RoleBindings; the group is kubeast:role:read (the chart allows it)
    kubectl(`-n default create rolebinding ${binding} --clusterrole=view --group=kubeast:role:read`)
    const reader = await tempUser(browser, request, admin, 'nsread', 'Read', ['default'])
    try {
      expect(await (await reader.page.request.get('/api/v1/cluster/namespaces/default/rolebindings?cluster=self')).status()).toBe(403)
      await reader.page.goto('/security/serviceaccounts?cluster=self')
      await reader.page.locator('tbody tr').filter({ hasText: 'default' }).first().click()
      const drawer = reader.page.locator(DRAWER).last()
      await expect(drawer.getByTestId('sa-bindings-unreadable')).toContainText('RoleBinding', { timeout: 20000 })
      await expect(drawer.getByText(/No RoleBinding or ClusterRoleBinding binds|묶는 RoleBinding·ClusterRoleBinding이 없습니다/)).toHaveCount(0)
    } finally {
      await reader.done()
      kubectl(`-n default delete rolebinding ${binding} --ignore-not-found`)
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

  test('a user without access to self opens the console with no "no permission": the feature flags wait for their cluster', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const email = `e2e-notices-noself-${Date.now()}@kubeast.local`
    const password = 'e2e-notices-throwaway'
    const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E notices no self', email, password } })
    expect(created.status()).toBe(201)
    const id = (await created.json()).id as string
    const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } })
    try {
      expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/default`, { headers: admin, data: { role: 'Read' } })).status()).toBe(200)
      expect((await ctx.request.post('/api/v1/auth/login', { data: { email, password } })).ok(), `login ${email}`).toBeTruthy()
      const page = await ctx.newPage()
      const asked: string[] = []
      page.on('request', (r) => {
        if (r.url().includes('/api/v1/cluster/features')) asked.push(new URL(r.url()).searchParams.get('cluster') ?? '')
      })
      await page.goto('/account')
      await expect(page.getByTestId('cluster-picker')).toContainText('default', { timeout: 20000 })
      await expect.poll(() => asked.length, { timeout: 20000 }).toBeGreaterThan(0)
      await page.waitForLoadState('networkidle')
      expect(asked, 'every feature request names the picked cluster').toEqual(asked.map(() => 'default'))
      await expect(page.getByTestId('forbidden-banner')).toHaveCount(0)
    } finally {
      await ctx.close()
      await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })
})
