import { expect, test } from '@playwright/test'

import { beat, clip } from './clip'

// Change History of the shop namespace, then its Resource Graph: how its objects connect, who actually talks to
// whom (Hubble, on the Cilium cluster where scripts/site-media.sh puts e2e/demo/shop-traffic.yaml) and why the
// dropped connection is dropped.
const CLUSTER = process.env.E2E_CILIUM_CLUSTER || 'kubeast-cilium'
const DROPPED = '[aria-label="shop/storefront → shop/payments (TCP 80)"]'

test('changes', async ({ page }) => {
  const c = clip(page, 'changes')
  await page.goto(`/timeline?cluster=${CLUSTER}`)
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
  await beat(page, 3500)
  c.hide()

  await page.goto(`/cluster/resource-graph?cluster=${CLUSTER}&namespace=shop`)
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 30_000 })
  await beat(page, 1000)
  c.show()
  c.step('graph')
  await beat(page, 3000)
  c.step('traffic')
  await page.getByTestId('graph-view-traffic').click()
  await expect(page.locator(DROPPED)).toHaveCount(1, { timeout: 30_000 })
  await beat(page, 2500)
  await page.locator('[data-testid="rf__node-Deployment/shop/storefront"]').hover()
  await beat(page, 2000)
  c.step('why')
  await page.locator(`${DROPPED} .react-flow__edge-textwrapper`).click()
  await expect(page.getByTestId('traffic-panel')).toBeVisible()
  await beat(page, 1500)
  await page.getByTestId('traffic-panel-why').click()
  await expect(page.getByTestId('netpol-check-overall')).toHaveText('Denied', { timeout: 20_000 })
  await beat(page, 3000)
  await c.save()
})
