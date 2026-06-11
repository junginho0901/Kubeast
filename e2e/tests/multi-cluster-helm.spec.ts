import { test, expect, type Page } from '@playwright/test'

// Helm releases must follow the selected cluster. The release list is fed by an
// SSE watch that was pinned to cluster 'default' in the frontend, so switching
// clusters left the previous cluster's releases on screen (and clicking one
// 404'd, since it doesn't exist on the new cluster). The watch + list query are
// now keyed to the current cluster.
//
// In this env: 'default' (clarinet) has many releases (ingress-nginx, …);
// 'self' (kind) has none.

async function hasIngressNginx(page: Page): Promise<boolean> {
  return (await page.content()).includes('ingress-nginx')
}

test.describe('multi-cluster helm releases', () => {
  test('the release list follows the selected cluster', async ({ page }) => {
    // The helm page holds a long-lived SSE stream, so it never reaches
    // 'networkidle' — wait for the DOM only.
    await page.goto('/helm/releases?cluster=default')
    await page.waitForLoadState('domcontentloaded')

    // default surfaces its own releases (watch streams them in)
    await expect.poll(() => hasIngressNginx(page), { timeout: 20000 }).toBe(true)

    // switch to self (no helm releases) → the prior cluster's releases must clear
    await page.getByTestId('cluster-picker').click()
    await page.getByTestId('cluster-option-self').click()

    await expect
      .poll(() => hasIngressNginx(page), { timeout: 20000 })
      .toBe(false)
  })
})
