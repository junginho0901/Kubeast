import { test, expect, type Page } from '@playwright/test'

// Multi-cluster "Top N by resource usage" isolation.
//
// The dashboard's top-pods/top-nodes query uses keepPreviousData
// (placeholderData) to avoid flicker on its 5s refresh. In v5 that callback
// receives the prior data even across a KEY change, so switching to a cluster
// that has no metrics-server briefly (and repeatedly) rendered the PREVIOUS
// cluster's top-N. The placeholderData now bails when the previous query's
// cluster differs, so nothing bleeds across a switch.
//
// In this 2-cluster env: 'default' (clarinet) runs metrics-server → has top-N
// (node "clarinet-dev-master"); 'self' (kind) has none.

async function pageHasClarinet(page: Page): Promise<boolean> {
  return (await page.content()).includes('clarinet')
}

test.describe('multi-cluster top-resources', () => {
  test('switching to a metrics-less cluster never shows the prior cluster top-N', async ({ page }) => {
    await page.goto('/?cluster=default')
    await page.waitForLoadState('networkidle')

    // sanity: default surfaces its own top nodes (clarinet-dev-master)
    await expect.poll(() => pageHasClarinet(page), { timeout: 15000 }).toBe(true)

    // switch to self (no metrics-server)
    await page.getByTestId('cluster-picker').click()
    await page.getByTestId('cluster-option-self').click()

    // over the next several seconds the prior cluster's top-N must never appear
    // (covers the flicker: it would otherwise blink in and out on each refetch).
    for (let i = 0; i < 18; i++) {
      expect(await pageHasClarinet(page), 'prior cluster top-N bled onto the new cluster').toBe(false)
      await page.waitForTimeout(300)
    }
  })
})
