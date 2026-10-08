import { test, expect } from '@playwright/test'

// Change History opens on every namespace: the dropdown's first option is
// "All namespaces" (the default), the page calls the cluster-wide timeline
// endpoint, and picking a namespace switches to the namespaced endpoint.
test.describe('timeline — all namespaces', () => {
  test('defaults to all namespaces and uses the cluster-wide endpoint', async ({ page }) => {
    const clusterWide = page.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/api\/v1\/cluster\/timeline\?/.test(r.url()),
    )
    await page.goto('/timeline?cluster=self')
    const res = await clusterWide
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.events)).toBe(true)
    expect(Array.isArray(body.rollout_history)).toBe(true)

    const dropdown = page.getByTestId('timeline-namespace')
    await expect(dropdown).toContainText(/All namespaces|전체 Namespace/)

    // choose a namespace → the namespaced endpoint, and the trigger shows it
    await dropdown.click()
    const options = page.locator('.absolute.top-full button')
    await expect(options.first()).toContainText(/All namespaces|전체 Namespace/)
    expect(await options.count()).toBeGreaterThan(1)
    const chosen = (await options.nth(1).innerText()).trim()
    const namespaced = page.waitForResponse((r) =>
      r.url().includes(`/api/v1/cluster/namespaces/${encodeURIComponent(chosen)}/timeline?`),
    )
    await options.nth(1).click()
    expect((await namespaced).status()).toBe(200)
    await expect(dropdown).toContainText(chosen)
  })
})
