import { expect, test } from '@playwright/test'

import { beat, clip } from './clip'

// The dashboard of the second cluster (where the shop runs), its issues at a glance, then a switch to the
// other cluster from the sidebar.
test('dashboard', async ({ page }) => {
  const c = clip(page, 'dashboard')
  await page.goto('/?cluster=default')
  await page.waitForLoadState('networkidle')
  c.show()
  c.step('cards')
  await beat(page, 2500)
  c.step('issues')
  await page.locator('button').filter({ hasText: /Check issues/i }).first().click()
  await expect(page.locator('h2').filter({ hasText: /^Issues$/ }).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('checkout-api', { exact: false }).first()).toBeVisible({ timeout: 20_000 })
  await beat(page, 4500)
  await page.keyboard.press('Escape')
  await beat(page, 600)
  // Check issues sits at the bottom of the dashboard: back to the cards before the switch.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
  await beat(page, 900)

  c.step('switch')
  await page.getByTestId('cluster-picker').click()
  await beat(page, 800)
  await page.getByTestId('cluster-option-self').click()
  await expect(page).toHaveURL(/[?&]cluster=self/)
  await expect(page.getByTestId('cluster-switch-progress')).toBeHidden({ timeout: 30_000 })
  await beat(page, 3500)
  await c.save()
})
