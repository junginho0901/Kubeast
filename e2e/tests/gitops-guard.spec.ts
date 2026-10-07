import { test, expect, type APIRequestContext } from '@playwright/test'

// Argo CD guard (chart gitops.argocd, on in block mode in the dev values). The
// fixture Deployment e2e-argo-managed carries a tracking annotation that names
// itself, so the console shows the Application badge, k8s-service refuses
// writes to it with 409, and the drawer offers no delete or YAML apply. An
// unmanaged object is still written as before.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

async function login(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

test.describe('Argo CD guard', () => {
  test('features report the guard, a managed object is refused with 409, an unmanaged one is not', async ({ request }) => {
    test.skip(!ADMIN_PASSWORD, 'E2E_USER_PASSWORD not set')
    const admin = await login(request)
    const features = await (await request.get('/api/v1/cluster/features?cluster=self', { headers: admin })).json()
    test.skip(features.gitops?.argocd?.enabled !== true, 'gitops.argocd is off on this install')
    expect(features.gitops.argocd.mode).toBe('block')

    const managed = await request.get('/api/v1/cluster/namespaces/default/deployments/e2e-argo-managed/describe?cluster=self', { headers: admin, failOnStatusCode: false })
    test.skip(managed.status() === 404, 'fixture e2e-argo-managed is missing (deploy/kind/fixtures.yaml)')

    // Every write path answers 409 for the managed object: delete, rollback, YAML apply.
    const del = await request.delete('/api/v1/cluster/namespaces/default/deployments/e2e-argo-managed?cluster=self', { headers: admin, failOnStatusCode: false })
    expect(del.status(), await del.text()).toBe(409)
    expect((await del.json()).detail).toContain('managed by Argo CD application e2e-app')
    const rollback = await request.post('/api/v1/cluster/namespaces/default/deployments/e2e-argo-managed/rollback?cluster=self', { headers: admin, data: {}, failOnStatusCode: false })
    expect(rollback.status(), await rollback.text()).toBe(409)
    const apply = await request.post('/api/v1/cluster/namespaces/default/yaml/apply?cluster=self', {
      headers: admin, failOnStatusCode: false,
      data: { namespace: 'default', yaml: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: e2e-argo-managed\n  namespace: default\nspec:\n  replicas: 2\n' },
    })
    expect(apply.status(), await apply.text()).toBe(409)
    // Still there, untouched.
    expect((await request.get('/api/v1/cluster/namespaces/default/deployments/e2e-argo-managed/describe?cluster=self', { headers: admin })).status()).toBe(200)

    // An unmanaged object goes through the same routes as before.
    const name = `e2e-gitops-free-${Date.now().toString(36)}`
    const create = await request.post('/api/v1/cluster/resources/yaml/create?cluster=self', {
      headers: admin, data: { namespace: 'default', yaml: `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: default\ndata:\n  k: v\n` },
    })
    expect(create.ok(), await create.text()).toBeTruthy()
    try {
      const apply2 = await request.post('/api/v1/cluster/namespaces/default/yaml/apply?cluster=self', {
        headers: admin, failOnStatusCode: false,
        data: { namespace: 'default', yaml: `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: default\ndata:\n  k: v2\n` },
      })
      expect(apply2.status(), await apply2.text()).toBeLessThan(300)
    } finally {
      const del2 = await request.delete(`/api/v1/cluster/namespaces/default/configmaps/${name}?cluster=self`, { headers: admin, failOnStatusCode: false })
      expect(del2.status(), await del2.text()).toBeLessThan(300)
    }
  })

  test('the drawer shows the Application badge and no delete or YAML apply for a managed object', async ({ page, request }) => {
    test.skip(!ADMIN_PASSWORD, 'E2E_USER_PASSWORD not set')
    const admin = await login(request)
    const features = await (await request.get('/api/v1/cluster/features?cluster=self', { headers: admin })).json()
    test.skip(features.gitops?.argocd?.enabled !== true, 'gitops.argocd is off on this install')
    const managed = await request.get('/api/v1/cluster/namespaces/default/deployments/e2e-argo-managed/describe?cluster=self', { headers: admin, failOnStatusCode: false })
    test.skip(managed.status() === 404, 'fixture e2e-argo-managed is missing (deploy/kind/fixtures.yaml)')

    await page.goto('/workloads/deployments?cluster=self')
    await page.getByPlaceholder(/search/i).first().fill('e2e-argo-managed')
    await page.getByRole('cell', { name: 'e2e-argo-managed', exact: true }).first().click()
    const drawer = page.locator(DRAWER).last()
    await expect(drawer.getByTestId('argo-badge')).toContainText('e2e-app', { timeout: 15000 })
    await expect(drawer.getByRole('button', { name: /^(delete\b|.*삭제$)/i })).toHaveCount(0)
    await drawer.getByRole('button', { name: /^yaml$/i }).click()
    await expect(drawer.getByRole('button', { name: /^(edit|편집)$/i })).toHaveCount(0)

    // An unmanaged object keeps its buttons (the fixture StatefulSet's sibling: the CronJob).
    await page.keyboard.press('Escape')
    await page.goto('/workloads/cronjobs?cluster=self')
    await page.getByRole('cell', { name: 'e2e-fixture', exact: true }).first().click()
    await expect(drawer.getByText('e2e-fixture', { exact: true }).first()).toBeVisible({ timeout: 15000 })
    await expect(drawer.getByTestId('argo-badge')).toHaveCount(0)
    await expect(drawer.getByRole('button', { name: /^(delete\b|.*삭제$)/i })).toHaveCount(1)
  })
})
