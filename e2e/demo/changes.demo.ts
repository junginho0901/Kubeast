import { expect, test } from '@playwright/test'

import { beat, clip } from './clip'

// Change History of the shop namespace, then the Resource Graph of the same namespace and a node's drawer.
test('changes', async ({ page }) => {
  const c = clip(page, 'changes')
  await page.goto('/timeline?cluster=default')
  const namespace = page.getByTestId('timeline-namespace')
  await expect(namespace).toBeVisible({ timeout: 20_000 })
  await page.waitForLoadState('networkidle')
  c.show()
  c.step('timeline')
  await beat(page, 1500)
  await namespace.click()
  await beat(page, 600)
  await page.locator('.absolute.top-full button', { hasText: /^shop$/ }).click()
  await expect(namespace).toContainText('shop')
  await beat(page, 4000)
  c.hide()

  await page.goto('/cluster/resource-graph?cluster=default&namespace=shop')
  const nodes = page.locator('.react-flow__node')
  await expect(nodes.first()).toBeVisible({ timeout: 30_000 })
  await beat(page, 1000)
  c.show()
  c.step('graph')
  await beat(page, 3500)
  c.step('drawer')
  await page.locator('.react-flow__node [title="storefront"]').first().click()
  await expect(page.locator('div[class*="fixed"][class*="inset-y-0"][class*="right-0"]').last()).toBeVisible()
  await beat(page, 3000)
  await c.save()
})
