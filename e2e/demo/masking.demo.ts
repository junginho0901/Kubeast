import { expect, test } from '@playwright/test'

import { XRW, beat, clip, demoUser } from './clip'

// The chat asked for a ConfigMap that holds credentials: the tool result the model got shows them masked, and the
// audit log's row for that tool call counts what was masked. The switch to the admin's session is cut.
test('masking', async ({ page, playwright, baseURL }) => {
  const c = clip(page, 'masking')
  await page.goto('/')
  const admin = await playwright.request.newContext({ baseURL, storageState: '.auth/user.json', extraHTTPHeaders: XRW })
  const sam = await demoUser(admin, 'Sam Park', 'sam@example.com', 'Write')
  try {
    const adminCookies = await page.context().cookies()
    await sam.signIn(page)
    await page.goto('/ai-chat?cluster=default')
    await page.waitForLoadState('networkidle')
    const input = page.getByPlaceholder(/message/i)
    c.show()
    c.step('ask')
    await beat(page, 1000)
    await input.pressSequentially('Show me the checkout-config ConfigMap in the shop namespace.', { delay: 35 })
    await beat(page, 500)
    await page.getByRole('button', { name: /^send$/i }).click()
    await expect(input).toBeDisabled({ timeout: 10_000 })
    await expect(input).toBeEnabled({ timeout: 180_000 })
    // The answer shows the ConfigMap as the tool gave it to the model.
    const answer = page.locator('div.flex.gap-3.p-6:not(.flex-row-reverse)').last()
    await expect(answer).toContainText('REDACTED')
    await expect(answer).not.toContainText('Autumn-Sale-2026')
    c.step('masked')
    await answer.locator('pre').filter({ hasText: 'REDACTED' }).first().evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    await beat(page, 4500)
    await answer.getByText(/redact/i).last().evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    await beat(page, 3500)
    c.hide()

    await page.context().clearCookies()
    await page.context().addCookies(adminCookies)
    await page.goto('/admin/audit')
    await page.getByPlaceholder('k8s.pod.delete').fill('ai.tool.call')
    await page.getByPlaceholder('user@example.com').fill('sam@example.com')
    await page.getByRole('button', { name: /^Search$/ }).first().click()
    const row = page.locator('main tbody tr').filter({ hasText: /configmap/i }).first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    c.show()
    c.step('audit')
    await beat(page, 1500)
    await row.click()
    await expect(page.locator('main')).toContainText('redacted', { timeout: 10_000 })
    await page.locator('main').getByText('redacted').first().scrollIntoViewIfNeeded()
    await beat(page, 4500)
    await c.save()
  } finally {
    await sam.done()
    await admin.dispose()
  }
})
