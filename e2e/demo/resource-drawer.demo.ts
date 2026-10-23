import { expect, test } from '@playwright/test'

import { beat, clip } from './clip'

// The storefront Deployment in its drawer, then a YAML edit (replicas 2 → 3) applied in place.
test('resource-drawer', async ({ page }) => {
  const c = clip(page, 'resource-drawer')
  await page.goto('/workloads/deployments?cluster=default')
  await expect(page.locator('main tbody tr').first()).toBeVisible({ timeout: 30_000 })
  c.show()
  c.step('find')
  await beat(page, 1500)
  await page.getByPlaceholder(/search/i).first().pressSequentially('storefront', { delay: 60 })
  await beat(page, 800)
  await page.getByRole('cell', { name: 'storefront', exact: true }).first().click()
  const drawer = page.locator('div[class*="fixed"][class*="inset-y-0"][class*="right-0"]').last()
  await expect(drawer).toBeVisible()
  c.step('drawer')
  await beat(page, 3000)

  c.step('edit')
  await drawer.getByRole('button', { name: /^YAML$/ }).first().click()
  await beat(page, 1500)
  await drawer.getByRole('button', { name: 'Edit', exact: true }).click()
  await drawer.locator('.monaco-editor .view-line').first().click()
  // Monaco takes the user agent's keys: Desktop Chrome is a Windows agent, so Control.
  // The find box selects the first match as it is typed (Enter would move on to status' availableReplicas).
  await page.keyboard.press('Control+F')
  await page.keyboard.type('replicas: 2', { delay: 50 })
  await page.keyboard.press('Escape')
  await beat(page, 800)
  await page.keyboard.type('replicas: 3', { delay: 80 })
  await beat(page, 1200)
  await drawer.getByRole('button', { name: /^apply$/i }).click()
  await expect(drawer.getByRole('button', { name: 'Edit', exact: true })).toBeVisible({ timeout: 20_000 })
  await beat(page, 1500)
  c.step('applied')
  await drawer.getByRole('button', { name: /^Info$/ }).first().click()
  await expect(drawer.getByText('Desired: 3')).toBeVisible({ timeout: 15_000 })
  await beat(page, 3500)
  await c.save()
})
