import { expect, test } from '@playwright/test'

import { XRW, beat, clip, demoUser } from './clip'

// A Read user asks for Write on the cluster for an hour, an admin approves, and the audit log shows the trail.
// One page plays both people: the switch between their sessions is cut.
test('access-audit', async ({ page, playwright, baseURL }) => {
  const c = clip(page, 'access-audit')
  await page.goto('/')
  const admin = await playwright.request.newContext({ baseURL, storageState: '.auth/user.json', extraHTTPHeaders: XRW })
  const alex = await demoUser(admin, 'Alex Lee', 'alex@example.com', 'Read')
  try {
    const adminCookies = await page.context().cookies()
    await alex.signIn(page)
    await page.goto('/account')
    await expect(page.getByTestId('account-cluster-access')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('account-cluster-access').scrollIntoViewIfNeeded()
    c.show()
    c.step('request')
    await beat(page, 2000)
    await page.getByTestId('access-request-open-default').click()
    await expect(page.getByTestId('access-request-modal')).toBeVisible()
    await beat(page, 1000)
    await page.getByTestId('access-request-reason').pressSequentially('Fix the checkout-api crash loop in shop', { delay: 40 })
    await beat(page, 800)
    await page.getByTestId('access-request-submit').click()
    await expect(page.getByTestId('access-request-notice')).toBeVisible({ timeout: 10_000 })
    await beat(page, 2500)
    c.hide()

    await page.context().clearCookies()
    await page.context().addCookies(adminCookies)
    const pending = (await (await admin.get('/api/v1/auth/admin/access-requests?status=pending')).json()) as Array<{ id: string; user_id: string }>
    const id = pending.find((r) => r.user_id === alex.id)!.id
    await page.goto('/admin/access-requests')
    await expect(page.getByTestId(`access-request-row-${id}`)).toBeVisible({ timeout: 15_000 })
    c.show()
    c.step('approve')
    await beat(page, 2500)
    await page.getByTestId(`access-request-note-${id}`).pressSequentially('OK for an hour', { delay: 50 })
    await beat(page, 600)
    await page.getByTestId(`access-request-approve-${id}`).click()
    await expect(page.getByTestId(`access-request-row-${id}`)).toHaveCount(0, { timeout: 10_000 })
    await page.getByTestId('access-requests-tab-history').click()
    await beat(page, 2500)
    c.step('audit')
    await page.getByTestId('sidebar-nav').locator('a[href="/admin/audit"]').click()
    await expect(page.locator('main tbody tr').first()).toBeVisible({ timeout: 15_000 })
    await beat(page, 1200)
    // Sign-in and access rows only (Area: Auth), not the dev cluster's other audit traffic.
    await page.locator('label').filter({ hasText: /^Area/ }).getByRole('button').first().click()
    await page.getByRole('button', { name: 'Auth', exact: true }).click()
    await page.getByRole('button', { name: /^Search$/ }).first().click()
    await expect(page.locator('main tbody tr').first()).toContainText('alex@example.com', { timeout: 15_000 })
    await beat(page, 4000)
    await c.save()
  } finally {
    await alex.done()
    await admin.dispose()
  }
})
