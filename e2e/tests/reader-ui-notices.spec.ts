import { test, expect, type APIRequestContext, type Browser } from '@playwright/test'

// Two notices for non-admin users found by walking the UI as a Read user:
//  - a viewer may list most kinds but not Secrets (cluster RBAC 403): the page
//    says so instead of "No secrets found"
//  - a user with no cluster grant sees the "no accessible cluster" notice, the
//    footer says so, and no resource page mounts (no cluster API 403 storm)

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
