import { test, expect, type APIRequestContext } from '@playwright/test'

// User Management → reset password. Another user's new password shows in a window. An admin resetting their own
// sees the same window — the server keeps that session, as a password change does — and closing it signs out to the
// login page, where the new password signs in. A throwaway global admin does it, so the dev admin keeps its password.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function login(request: APIRequestContext, email: string, password: string) {
  return request.post('/api/v1/auth/login', { data: { email, password }, failOnStatusCode: false })
}

test.use({ storageState: { cookies: [], origins: [] } })

test('an admin resetting their own password sees it, and signs in again with it', async ({ page, request }) => {
  const admin = { Authorization: `Bearer ${(await (await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)).json()).access_token}` }
  const raw = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
  const adminRole = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name === 'Admin')
  const email = `e2e-selfreset-${Date.now()}@kubeast.local`
  const first = 'e2e-selfreset-first-pw'
  const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E self reset', email, password: first, role_id: adminRole.id } })
  expect(created.status(), await created.text()).toBe(201)
  const id = (await created.json()).id as string
  try {
    await page.goto('/login')
    await page.locator('input[autocomplete="email"]').first().fill(email)
    await page.locator('input[type="password"]').first().fill(first)
    await page.locator('button[type="submit"]').first().click()
    await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20000 })

    await page.goto('/admin/users')
    const row = page.locator('tr').filter({ has: page.getByTestId(`user-detail-${email}`) })
    await row.getByTestId('user-reset-password').click({ timeout: 15000 })
    await page.getByTestId('confirm-dialog-ok').click()

    // the window stays: no sign-in page while it shows the password
    const result = page.getByTestId('reset-password-result')
    await expect(result.getByTestId('reset-password-self')).toHaveCount(1, { timeout: 15000 })
    const temp = (await result.getByTestId('reset-password-value').innerText()).trim()
    expect(temp).toMatch(/^[A-Za-z0-9]{16}$/)
    await page.waitForTimeout(1500)
    await expect(page).toHaveURL(/\/admin\/users/)

    await result.getByTestId('reset-password-done').click()
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 })
    expect((await login(request, email, first)).status(), 'the old password').toBe(401)
    expect((await login(request, email, temp)).status(), 'the new password').toBe(200)
  } finally {
    await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
  }
})
