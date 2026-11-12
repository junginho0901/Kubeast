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

  test('a second self cluster from the dialog is refused with the name it has', async ({ page }) => {
    const name = `e2e-ui-self-${Date.now()}`
    const items = (await (await page.request.get('/api/v1/clusters', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })).json()).items as { id: string; is_self_cluster: boolean }[]
    const self = items.find((c) => c.is_self_cluster)
    expect(self, 'the dev registry holds the kind cluster itself in-cluster').toBeTruthy()

    await page.goto('/admin/clusters')
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('register-cluster-btn').click()

    // self tab is enabled in k8s deployment mode
    const selfTab = page.getByTestId('register-tab-self')
    await expect(selfTab).toBeEnabled()
    await selfTab.click()
    await page.getByTestId('register-name').fill(name)
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/clusters' && r.request().method() === 'POST')
    await page.getByTestId('register-submit').click()
    expect((await answered).status()).toBe(409)

    // the window stays open with the reason, and the table gets no new row
    await expect(page.getByText(`This cluster is already registered as '${self!.id}'.`)).toBeVisible()
    await expect(page.getByTestId('register-name')).toHaveValue(name)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('clusters-table')).not.toContainText(name)
  })
})

// Requires a second cluster — auth.setup registers 'self' alongside 'default'.
test.describe('multi-cluster UI — switching (2 clusters)', () => {
  test('picker switches the active cluster and reflects it in ?cluster=', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const picker = page.getByTestId('cluster-picker')
    // auto-selects the canonical default cluster even though 'self' also exists
    await expect(picker).toContainText('default', { timeout: 15000 })

    // switch to 'self'
    await picker.click()
    await page.getByTestId('cluster-option-self').click()
    await expect(picker).toContainText('self')
    await expect(page).toHaveURL(/[?&]cluster=self/)

    // switch back to 'default'
    await picker.click()
    await page.getByTestId('cluster-option-default').click()
    await expect(picker).toContainText('default')
    await expect(page).toHaveURL(/[?&]cluster=default/)
  })
})
