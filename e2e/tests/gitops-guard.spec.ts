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
    const started = Date.now()
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
    // Each refusal is a k8s.gitops.refuse row (a blocked attempt, like a permission refusal).
    type Row = { Action: string; TargetID: string; Namespace: string; Result: string; After: { app?: string; method?: string }; CreatedAt: string }
    await expect.poll(async () => {
      const rows: Row[] = (await (await request.get('/api/v1/auth/admin/audit-logs?action=k8s.gitops.refuse&limit=10', { headers: admin })).json()).items
      return rows.filter((r) => r.TargetID === 'e2e-argo-managed' && r.Namespace === 'default' && r.Result === 'failure' && r.After?.app === 'e2e-app'
        && Date.parse(r.CreatedAt) >= started - 5_000)
        .map((r) => r.After.method).sort()
    }, { timeout: 10_000 }).toEqual(['DELETE', 'POST', 'POST'])
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

  test('a YAML apply answers for the object it goes to: refused for a managed one whatever the body says, written for a free one, nothing for someone without the permission', async ({ request }) => {
    test.skip(!ADMIN_PASSWORD, 'E2E_USER_PASSWORD not set')
    const admin = await login(request)
    const features = await (await request.get('/api/v1/cluster/features?cluster=self', { headers: admin })).json()
    test.skip(features.gitops?.argocd?.mode !== 'block', 'gitops.argocd is not in block mode on this install')
    const describe = '/api/v1/cluster/namespaces/default/deployments/e2e-argo-managed/describe?cluster=self'
    const managed = await request.get(describe, { headers: admin, failOnStatusCode: false })
    test.skip(managed.status() === 404, 'fixture e2e-argo-managed is missing (deploy/kind/fixtures.yaml)')
    const replicas = (d: { replicas?: number; desired?: number; spec?: { replicas?: number } }) => d?.replicas ?? d?.desired ?? d?.spec?.replicas
    const before = replicas(await managed.json())
    expect(typeof before, 'the fixture reports its replicas').toBe('number')

    const apply = '/api/v1/cluster/resources/yaml/apply?cluster=self'
    const address = { resource_type: 'deployments', namespace: 'default', name: 'e2e-argo-managed' }
    const bodies = [
      { ...address, yaml: 'spec:\n  replicas: 0\n' },
      { ...address, yaml: 'metadata:\n  labels:\n    e2e-gitops: x\n' },
      { ...address, yaml: 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: e2e-gitops-another\nspec:\n  replicas: 0\n' },
      { resource_type: 'deployments', namespace: 'default', resource_name: 'e2e-argo-managed', yaml: 'spec:\n  replicas: 0\n' },
    ]
    const started = Date.now()
    for (const data of bodies) {
      const res = await request.post(apply, { headers: admin, data, failOnStatusCode: false })
      expect(res.status(), await res.text()).toBe(409)
      expect((await res.json()).detail).toBe('managed by Argo CD application e2e-app; change it in Git')
    }
    type Row = { TargetID: string; TargetType: string; Namespace: string; Result: string; ActorEmail: string; After: { app?: string; method?: string; path?: string }; CreatedAt: string }
    const rows = async (action: string) => ((await (await request.get(`/api/v1/auth/admin/audit-logs?action=${action}&limit=50`, { headers: admin })).json()).items as Row[])
      .filter((r) => Date.parse(r.CreatedAt) >= started - 5_000)
    await expect.poll(async () => (await rows('k8s.gitops.refuse'))
      .filter((r) => r.After?.path === '/api/v1/resources/yaml/apply' && r.TargetID === 'e2e-argo-managed' && r.Namespace === 'default' && r.Result === 'failure' && r.After?.app === 'e2e-app')
      .length, { timeout: 10_000 }).toBe(bodies.length)
    expect(replicas(await (await request.get(describe, { headers: admin })).json()), 'replicas unchanged').toBe(before)

    // A free object takes the same bodies and shows the change.
    const name = `e2e-gitops-free-${Date.now().toString(36)}`
    const create = await request.post('/api/v1/cluster/resources/yaml/create?cluster=self', {
      headers: admin, data: { namespace: 'default', yaml: `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: default\ndata:\n  k: v\n` },
    })
    expect(create.ok(), await create.text()).toBeTruthy()
    const email = `e2e-gitops-read-${Date.now().toString(36)}@kubeast.local`
    const password = 'E2e-gitops-pass1!'
    let userId = ''
    try {
      const patched = await request.post(apply, { headers: admin, failOnStatusCode: false, data: { resource_type: 'configmaps', namespace: 'default', name, yaml: 'data:\n  k: v2\n' } })
      expect(patched.status(), await patched.text()).toBe(200)
      const yaml = await (await request.get(`/api/v1/cluster/resources/yaml?resource_type=configmaps&namespace=default&resource_name=${name}&cluster=self`, { headers: admin })).json()
      expect(yaml.yaml).toMatch(/k: v2/)

      // Someone who may only read: the handler's 403, no Application name, no refusal row, one denied row.
      const raw = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
      const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
      const made = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E gitops read', email, password, role_id: member.id } })
      expect(made.status(), await made.text()).toBe(201)
      userId = (await made.json()).id
      const granted = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/self`, { headers: admin, data: { role: 'Read' } })
      expect(granted.ok(), await granted.text()).toBeTruthy()
      const signedIn = await request.post('/api/v1/auth/login', { data: { email, password } })
      expect(signedIn.ok(), 'reader login').toBeTruthy()
      const reader = { Authorization: `Bearer ${(await signedIn.json()).access_token as string}` }
      const refused = await request.post(apply, { headers: reader, data: bodies[0], failOnStatusCode: false })
      const text = await refused.text()
      expect(refused.status(), text).toBe(403)
      expect(text).toContain('resource.deployment.edit')
      expect(text).not.toContain('e2e-app')
      await expect.poll(async () => (await rows('k8s.access.denied')).filter((r) => r.ActorEmail === email).length, { timeout: 10_000 }).toBe(1)
      expect((await rows('k8s.gitops.refuse')).filter((r) => r.ActorEmail === email)).toEqual([])
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: admin, failOnStatusCode: false })
      const del = await request.delete(`/api/v1/cluster/namespaces/default/configmaps/${name}?cluster=self`, { headers: admin, failOnStatusCode: false })
      expect(del.status(), await del.text()).toBeLessThan(300)
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
    // re-QA #62: no rollback either (the server refuses it with 409), and the drawer says why
    await expect(drawer.getByTestId('argo-blocked-hint')).toBeVisible()
    await expect(drawer.getByText(/^(Basic Info|기본 정보)$/).first()).toBeVisible()
    await expect(drawer.getByRole('button', { name: /^(rollback|롤백)$/i })).toHaveCount(0)
    await drawer.getByRole('button', { name: /^yaml$/i }).click()
    await expect(drawer.getByRole('button', { name: /^(edit|편집)$/i })).toHaveCount(0)

    // An unmanaged object keeps its buttons (the fixture StatefulSet's sibling: the CronJob).
    await page.keyboard.press('Escape')
    await page.goto('/workloads/cronjobs?cluster=self')
    await page.getByRole('cell', { name: 'e2e-fixture', exact: true }).first().click()
    await expect(drawer.getByText('e2e-fixture', { exact: true }).first()).toBeVisible({ timeout: 15000 })
    await expect(drawer.getByTestId('argo-badge')).toHaveCount(0)
    await expect(drawer.getByRole('button', { name: /^(delete\b|.*삭제$)/i })).toHaveCount(1)
    await expect(drawer.getByTestId('argo-blocked-hint')).toHaveCount(0)
  })

  test('in warn mode, declining the warning writes nothing, calls nothing applied and keeps the edit', async ({ page, request }) => {
    test.skip(!ADMIN_PASSWORD, 'E2E_USER_PASSWORD not set')
    const admin = await login(request)
    const features = await (await request.get('/api/v1/cluster/features?cluster=self', { headers: admin })).json()
    test.skip(features.gitops?.argocd?.enabled !== true, 'gitops.argocd is off on this install')
    const managed = await request.get('/api/v1/cluster/namespaces/default/deployments/e2e-argo-managed/describe?cluster=self', { headers: admin, failOnStatusCode: false })
    test.skip(managed.status() === 404, 'fixture e2e-argo-managed is missing (deploy/kind/fixtures.yaml)')

    // The screen is told warn; the server stays in block mode, so a write that does go out is refused and changes nothing.
    await page.route('**/api/v1/cluster/features**', async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      await route.fulfill({ response: res, json: { ...body, gitops: { ...body.gitops, argocd: { ...body.gitops.argocd, mode: 'warn' } } } })
    })
    const writes: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/yaml/apply')) writes.push(r.url())
    })

    await page.goto('/workloads/deployments?cluster=self')
    await page.getByPlaceholder(/search/i).first().fill('e2e-argo-managed')
    await page.getByRole('cell', { name: 'e2e-argo-managed', exact: true }).first().click()
    const drawer = page.locator(DRAWER).last()
    await expect(drawer.getByTestId('argo-badge')).toContainText('e2e-app', { timeout: 15000 })
    await drawer.getByRole('button', { name: /^yaml$/i }).click()
    await drawer.getByRole('button', { name: /^(edit|편집)$/i }).click()
    const apply = drawer.getByRole('button', { name: /^(apply|적용)$/i })
    const dialog = page.getByTestId('confirm-dialog')

    await apply.click()
    await expect(dialog).toContainText('e2e-app')
    await dialog.getByRole('button', { name: /^(cancel|취소)$/i }).click()
    await expect(dialog).toHaveCount(0)
    await expect(drawer.getByText(/^(Applied|적용됨)$/)).toHaveCount(0)
    await expect(apply, 'the edit stays').toHaveCount(1)
    await expect(drawer.getByRole('button', { name: /^(edit|편집)$/i }), 'the edit stays').toHaveCount(0)
    expect(writes).toEqual([])

    // Going ahead sends the write, and what the server answers is what is said.
    await apply.click()
    await dialog.getByTestId('confirm-dialog-ok').click()
    await expect(drawer.getByText('managed by Argo CD application e2e-app; change it in Git').first()).toBeVisible({ timeout: 15000 })
    await expect(drawer.getByText(/^(Applied|적용됨)$/)).toHaveCount(0)
    expect(writes).toHaveLength(1)
  })
})
