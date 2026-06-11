import { test, expect, type Page } from '@playwright/test'

// Switching clusters must reset cluster-specific page state. A namespace chosen
// from a dropdown on cluster A must NOT persist onto cluster B (whose namespaces
// differ). The Layout remounts page content on a cluster change, so per-page
// state (selected namespace, filters) resets. Verified on the Timeline page,
// which also exercises the now-custom namespace dropdown (#3: it was a native
// <select>, the rest of the app uses CustomDropdown).

async function triggerText(page: Page): Promise<string> {
  return (await page.getByTestId('timeline-namespace').innerText()).trim()
}

test.describe('multi-cluster page state reset', () => {
  test('a selected namespace does not carry across a cluster switch', async ({ page }) => {
    await page.goto('/timeline?cluster=default')
    await page.waitForLoadState('networkidle')

    const dropdown = page.getByTestId('timeline-namespace')
    await expect(dropdown).toBeVisible({ timeout: 15000 })

    // Open the custom dropdown (a button + panel, not a native select) and pick
    // a namespace that is NOT the first option, so the selection is meaningful.
    await dropdown.click()
    // panel options live in the dropdown's own panel; pick the 2nd listed ns
    const panelOptions = page.locator('.absolute.top-full button')
    await expect(panelOptions.first()).toBeVisible()
    const count = await panelOptions.count()
    const pickIndex = count > 1 ? 1 : 0
    const chosen = (await panelOptions.nth(pickIndex).innerText()).trim()
    await panelOptions.nth(pickIndex).click()
    await expect(dropdown).toContainText(chosen)

    // Switch to self → page remounts → namespace selection must reset away from
    // the one we picked on default (self's namespaces differ).
    await page.getByTestId('cluster-picker').click()
    await page.getByTestId('cluster-option-self').click()

    await expect(dropdown).toBeVisible({ timeout: 15000 })
    await expect
      .poll(() => triggerText(page), { timeout: 15000 })
      .not.toBe(chosen)
  })
})
