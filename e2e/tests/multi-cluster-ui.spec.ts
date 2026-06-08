import { test, expect } from '@playwright/test'

// Multi-cluster UI — cluster context (step 09).
//
// The selected cluster lives in the URL query (?cluster=), is mirrored into a
// module ref, and the axios interceptor injects it into every backend API call.
// A localStorage fallback covers navigations that arrive without the query.
// (The ClusterPicker UI that lets a user switch is step 11; here we assert the
// plumbing — that the selection actually reaches the backend.)

const CLUSTER_LS_KEY = 'kubeast:current-cluster'

function clusterParamIs(value: string) {
  return (req: { url(): string }) => {
    if (!req.url().includes('/api/v1/')) return false
    try {
      return new URL(req.url()).searchParams.get('cluster') === value
    } catch {
      return false
    }
  }
}

test.describe('multi-cluster UI — cluster context (step 09)', () => {
  test('?cluster= in the URL is injected into backend API calls', async ({ page }) => {
    const req = page.waitForRequest(clusterParamIs('default'), { timeout: 20000 })
    await page.goto('/?cluster=default')
    await page.waitForLoadState('domcontentloaded')
    expect(new URL((await req).url()).searchParams.get('cluster')).toBe('default')
  })

  test('falls back to the localStorage selection when the query is absent', async ({ page }) => {
    // Seed a prior selection (what the picker would persist in step 11).
    await page.goto('/?cluster=default')
    await page.evaluate(
      (k) => localStorage.setItem(k, 'default'),
      CLUSTER_LS_KEY,
    )

    // Navigate WITHOUT the query → the provider should fall back to localStorage
    // and the interceptor should still inject ?cluster=default.
    const req = page.waitForRequest(clusterParamIs('default'), { timeout: 20000 })
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    expect(new URL((await req).url()).searchParams.get('cluster')).toBe('default')
  })
})

test.describe('multi-cluster UI — picker + admin clusters (step 11)', () => {
  test('admin clusters page + sidebar picker show the registered cluster', async ({ page }) => {
    await page.goto('/admin/clusters')
    await page.waitForLoadState('domcontentloaded')
    const table = page.getByTestId('clusters-table')
    await expect(table).toBeVisible({ timeout: 15000 })
    await expect(table).toContainText('default')
    // the sidebar picker reflects the selected cluster
    await expect(page.getByTestId('cluster-picker')).toContainText('default')
  })

  test('register a self cluster via the dialog → appears → delete (self-cleaning)', async ({ page }) => {
    const name = `e2e-ui-self-${Date.now()}`
    const slug = name // Slugify keeps lowercase + digits + dashes unchanged

    await page.goto('/admin/clusters')
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('register-cluster-btn').click()

    // self tab is enabled in k8s deployment mode
    const selfTab = page.getByTestId('register-tab-self')
    await expect(selfTab).toBeEnabled()
    await selfTab.click()
    await page.getByTestId('register-name').fill(name)
    await page.getByTestId('register-submit').click()

    // rollout-free: the new cluster shows up in the table right away
    await expect(page.getByTestId('clusters-table')).toContainText(name, { timeout: 15000 })

    // delete it → gone
    await page.getByTestId(`delete-cluster-${slug}`).click()
    await page.getByTestId('delete-confirm').click()
    await expect(page.getByTestId('clusters-table')).not.toContainText(name, { timeout: 15000 })
  })
})
