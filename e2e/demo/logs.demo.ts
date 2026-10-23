import { expect, test } from '@playwright/test'

import { beat, clip } from './clip'

// Live logs from Cluster View: the storefront's requests as they come, then why checkout-api stops.
test('logs', async ({ page }) => {
  const c = clip(page, 'logs')
  await page.goto('/cluster-view?cluster=default')
  await expect(page.getByRole('heading', { name: /Cluster view/i })).toBeVisible({ timeout: 15_000 })
  await page.waitForLoadState('networkidle')
  c.show()
  c.step('stream')
  await beat(page, 1500)
  const search = page.getByPlaceholder(/Search pod name/i)
  await search.pressSequentially('storefront', { delay: 60 })
  await beat(page, 800)
  await page.locator('div.card button', { hasText: 'storefront' }).first().click()
  const logs = page.locator('pre.whitespace-pre-wrap').first()
  await expect(logs).toContainText('GET /', { timeout: 15_000 })
  await beat(page, 8000)
  await page.keyboard.press('Escape')
  await beat(page, 800)

  c.step('crash')
  await search.fill('')
  await search.pressSequentially('checkout', { delay: 60 })
  await beat(page, 800)
  await page.locator('div.card button', { hasText: 'checkout-api' }).first().click()
  await expect(logs).toContainText('PAYMENT_GATEWAY_URL', { timeout: 15_000 })
  await beat(page, 4000)
  await c.save()
})
