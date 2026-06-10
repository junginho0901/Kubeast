import { test, expect } from '@playwright/test'

// Global cluster-switch indicator.
//
// Switching clusters clears the cluster-scoped query cache and refetches against
// the newly selected (often remote, slower) cluster. Without feedback the UI
// looks frozen. ClusterSwitchProgress shows a pulsing bar + "Switching to X…"
// pill (data-testid="cluster-switch-progress") for the duration of the switch.

test.describe('multi-cluster switch indicator', () => {
  test('switching clusters shows a transient progress indicator', async ({ page }) => {
    // Start on the fast in-cluster 'self'; switch to the external 'default'
    // (remote → slower refetch) so the indicator is reliably observable.
    await page.goto('/?cluster=self')
    await page.waitForLoadState('networkidle')

    const picker = page.getByTestId('cluster-picker')
    await expect(picker).toContainText('self', { timeout: 15000 })

    // Switch to default → the indicator should appear while the new cluster loads.
    await picker.click()
    await page.getByTestId('cluster-option-default').click()

    const indicator = page.getByTestId('cluster-switch-progress')
    await expect(indicator).toBeVisible({ timeout: 5000 })
    await expect(indicator).toContainText(/default/i)

    // …and it must clear once the switch settles (never sticks).
    await expect(indicator).toBeHidden({ timeout: 30000 })
  })
})
