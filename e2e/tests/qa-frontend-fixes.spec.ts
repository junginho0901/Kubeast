import { execSync } from 'node:child_process'

import { test, expect } from '@playwright/test'

// Frontend fixes from the 2026-10 QA sweep that are checkable on the dev
// cluster: the login page does not offer "Create account" while registration
// is off; deleting from the drawer leaves no 404 in the console (the drawer
// closes before the deleted object's describe is invalidated); the sidebar nav
// scrolls instead of growing under the account box.

test.describe('QA sweep frontend fixes', () => {
  test('login page hides "Create account" when registration is off', async ({ page, request }) => {
    const cfg = await (await request.get('/api/v1/auth/oidc/config')).json()
    test.skip(cfg.registration !== false, 'registration is open on this server')
    await page.context().clearCookies()
    await page.goto('/login')
    await expect(page.locator('input[type="password"]')).toBeVisible()
    await expect(page.getByRole('button', { name: /create account|계정 만들기|회원가입/i })).toHaveCount(0)
  })

  test('deleting from the drawer leaves no 404 in the console', async ({ page }) => {
    const name = `e2e-drawer-delete-${Date.now().toString(36)}`
    execSync(`kubectl create configmap ${name} -n default --from-literal=k=v`, { stdio: ['ignore', 'ignore', 'inherit'] })
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    try {
      await page.goto('/configuration/configmaps?cluster=self')
      await page.getByPlaceholder(/search/i).first().fill(name)
      await page.getByRole('cell', { name, exact: true }).first().click()
      await page.getByRole('button', { name: /^delete\b/i }).first().click()
      const dialog = page.locator('[role="dialog"], [role="alertdialog"], div.fixed.inset-0:has(button)').last()
      await dialog.getByRole('button', { name: /^delete$/i }).last().click()
      await expect.poll(() => {
        try { execSync(`kubectl get configmap ${name} -n default`, { stdio: 'ignore' }); return 'present' } catch { return 'gone' }
      }, { timeout: 20000 }).toBe('gone')
      await page.waitForTimeout(1500)
      expect(errors.filter((e) => /404/.test(e)), errors.join('\n')).toEqual([])
    } finally {
      execSync(`kubectl delete configmap ${name} -n default --ignore-not-found`, { stdio: 'ignore' })
    }
  })

  test('the sidebar nav scrolls under the account box instead of overlapping it (900px)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/admin/users')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    const nav = page.getByTestId('sidebar-nav')
    const logout = page.getByRole('button', { name: /log ?out|로그아웃/i })
    await expect(logout).toBeVisible()
    const navBox = await nav.boundingBox()
    const logoutBox = await logout.boundingBox()
    expect(navBox && logoutBox).toBeTruthy()
    expect(navBox!.y + navBox!.height, 'nav must end above the account box').toBeLessThanOrEqual(logoutBox!.y + 1)
    // the active ADMIN entry is reachable by scrolling the nav itself
    const active = nav.locator('a[href="/admin/users"]')
    await active.scrollIntoViewIfNeeded()
    await expect(active).toBeInViewport()
  })
})
