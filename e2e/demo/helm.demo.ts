import { expect, test } from '@playwright/test'

import { beat, clip } from './clip'

// The shop's settings release (three revisions, put there by scripts/site-media.sh): history, the first revision
// against the current one, then the rollback preview, cancelled.
test('helm', async ({ page }) => {
  const c = clip(page, 'helm')
  await page.goto('/helm/releases?cluster=default')
  const row = page.locator('tbody tr', { hasText: 'storefront-settings' }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  c.show()
  c.step('history')
  await beat(page, 2000)
  await row.click()
  await expect(page.getByRole('button', { name: /^history$/i })).toBeVisible({ timeout: 20_000 })
  await beat(page, 2500)
  await page.getByRole('button', { name: /^history$/i }).click()
  await beat(page, 2000)

  const first = page.locator('table tbody tr').filter({ has: page.getByRole('button', { name: /rollback/i }) }).last()
  c.step('diff')
  await first.locator('td').first().click()
  const revision = page.locator('[role="dialog"], div.fixed.inset-0:has(button)').last()
  await expect(revision).toBeVisible()
  await beat(page, 1200)
  await revision.getByRole('button', { name: /diff/i }).first().click()
  await expect(revision.locator('.helm-diff2html')).toBeVisible({ timeout: 20_000 })
  await beat(page, 3500)
  await page.keyboard.press('Escape')
  await beat(page, 800)

  c.step('rollback')
  await first.getByRole('button', { name: /^rollback$/i }).click()
  await expect(page.locator('.helm-diff2html')).toBeVisible({ timeout: 20_000 })
  await beat(page, 3500)
  await page.getByRole('button', { name: /^cancel$/i }).click()
  await beat(page, 1200)
  await c.save()
})
