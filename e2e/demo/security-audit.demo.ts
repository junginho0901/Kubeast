import { expect, test } from '@playwright/test'

import { beat, clip } from './clip'

// The admin's checks: the audit log's chain verified, who holds what access right now, and the risky settings of
// the shop's workloads.
test('security-audit', async ({ page }) => {
  const c = clip(page, 'security-audit')
  await page.goto('/admin/audit')
  await expect(page.getByTestId('audit-integrity')).toBeVisible({ timeout: 15_000 })
  await page.waitForLoadState('networkidle')
  c.show()
  c.step('verify')
  await beat(page, 1500)
  await page.getByTestId('audit-integrity-verify').click()
  await expect(page.getByTestId('audit-integrity-result')).toContainText(/intact/, { timeout: 60_000 })
  await beat(page, 3500)

  c.step('review')
  await page.getByTestId('sidebar-nav').locator('a[href="/admin/access-review"]').click()
  await expect(page.getByTestId('access-review-summary')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('access-review-row').first()).toBeVisible({ timeout: 15_000 })
  await beat(page, 3500)

  c.step('hygiene')
  await page.getByTestId('sidebar-nav').locator('a[href="/admin/cluster-hygiene"]').click()
  await expect(page.getByTestId('hygiene-finding-row').first()).toBeVisible({ timeout: 30_000 })
  await beat(page, 1200)
  await page.getByPlaceholder(/Search Namespace/).pressSequentially('shop', { delay: 80 })
  await expect(page.getByTestId('hygiene-finding-row').first()).toContainText('shop')
  await beat(page, 4500)
  await c.save()
})
