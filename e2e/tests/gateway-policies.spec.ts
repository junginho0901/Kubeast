import { test, expect, type APIRequestContext } from '@playwright/test'

// Gateway → Policies lists every policy kind the cluster serves — labelled
// CRDs (GEP-713), the Envoy Gateway / Istio built-in table, configured
// extras — and says which kinds it scanned. The rows are custom resources,
// so the drawer is the generic one, named after the row's own kind; the
// upstream BackendTLSPolicy opens its own drawer.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

async function login(request: APIRequestContext, email: string, password: string) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

test.describe('gateway policies', () => {
  test('the page renders with the scanned-kinds line and the table', async ({ page }) => {
    await page.goto('/gateway/policies')
    await expect(page.getByRole('heading', { level: 1, name: /policies|정책/i })).toBeVisible()
    await expect(page.getByTestId('policy-kinds')).toBeVisible()
    await expect(page.getByRole('table')).toBeVisible()
    // either kinds are listed (chips) or the page says none are installed — never a blank line
    const kinds = page.getByTestId('policy-kinds')
    await expect(kinds).toContainText(/scanned kinds|조회한 종류/i)
    await expect.poll(async () => (await kinds.innerText()).replace(/\s+/g, ' ').trim().length).toBeGreaterThan(14)
  })

  test('the API answers with kinds and items, per kind source, for a registered cluster', async ({ request }) => {
    test.skip(!ADMIN_PASSWORD, 'E2E_USER_PASSWORD not set')
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    for (const cluster of ['self', 'test2']) {
      const res = await request.get(`/api/v1/cluster/gateway-policies/all?cluster=${cluster}`, { headers: admin, failOnStatusCode: false })
      if ([400, 404, 503].includes(res.status())) continue   // the cluster is not registered on this dev install
      expect(res.status(), `${cluster}: ${await res.text()}`).toBe(200)
      const body = await res.json()
      expect(Array.isArray(body.kinds)).toBeTruthy()
      expect(Array.isArray(body.items)).toBeTruthy()
      for (const k of body.kinds) {
        expect(['label', 'builtin', 'configured']).toContain(k.source)
        expect(k.plural, JSON.stringify(k)).toBeTruthy()
        expect(k.version, JSON.stringify(k)).toBeTruthy()
        // the admin can list everything: a kind that is served never carries an error
        expect(k.error, JSON.stringify(k)).toBeUndefined()
      }
      for (const it of body.items) {
        expect(it.kind && it.group && it.plural && it.name).toBeTruthy()
        expect(Array.isArray(it.targets)).toBeTruthy()
      }
      // the upstream BackendTLSPolicy CRD carries the GEP-713 label: when the kind is
      // served, label discovery (not the built-in table) must be what found it
      const btls = body.kinds.find((k: { plural: string }) => k.plural === 'backendtlspolicies')
      if (btls) expect(btls.source).toBe('label')
    }
  })

  test('a row opens a drawer named after its kind, not CustomResourceInstance', async ({ page, request }) => {
    test.skip(!ADMIN_PASSWORD, 'E2E_USER_PASSWORD not set')
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const cluster = 'test2'
    const res = await request.get(`/api/v1/cluster/gateway-policies/all?cluster=${cluster}`, { headers: admin, failOnStatusCode: false })
    test.skip(!res.ok(), `${cluster} is not registered on this dev install`)
    const kinds: { kind: string; group: string; version: string; plural: string }[] = (await res.json()).kinds
    const xbtp = kinds.find((k) => k.plural === 'xbackendtrafficpolicies')
    const btls = kinds.find((k) => k.plural === 'backendtlspolicies')
    test.skip(!xbtp || !btls, `the Gateway API experimental CRDs are not installed on ${cluster}`)

    const name = `e2e-policy-kind-${Date.now()}`
    const target = 'spec:\n  targetRefs:\n  - group: ""\n    kind: Service\n    name: kubernetes\n'
    const create = async (yaml: string) => {
      const r = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${cluster}`, { headers: admin, data: { namespace: 'default', yaml } })
      expect(r.ok(), await r.text()).toBeTruthy()
    }
    try {
      await create(`apiVersion: ${xbtp!.group}/${xbtp!.version}\nkind: ${xbtp!.kind}\nmetadata:\n  name: ${name}\n  namespace: default\n${target}`)
      await create(`apiVersion: ${btls!.group}/${btls!.version}\nkind: BackendTLSPolicy\nmetadata:\n  name: ${name}\n  namespace: default\n${target}  validation:\n    hostname: kubernetes.default.svc\n    wellKnownCACertificates: System\n`)
      await page.goto(`/gateway/policies?cluster=${cluster}`)
      const rowOf = (kind: string) => page.getByRole('row').filter({ hasText: name }).filter({ has: page.getByRole('cell', { name: kind, exact: true }) })
      const drawer = page.locator(DRAWER).last()
      const deleteButton = (kind: string) => drawer.getByRole('button', { name: new RegExp(`^(Delete ${kind}|${kind} 삭제)$`) })

      await rowOf(xbtp!.kind).click()
      await expect(drawer.getByText(xbtp!.kind, { exact: true }).first()).toBeVisible({ timeout: 15000 })
      await expect(deleteButton(xbtp!.kind)).toBeVisible()
      await expect(drawer).not.toContainText('CustomResourceInstance')
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()

      await rowOf('BackendTLSPolicy').click()
      await expect(drawer.getByText('BackendTLSPolicy', { exact: true }).first()).toBeVisible({ timeout: 15000 })
      await expect(deleteButton('BackendTLSPolicy')).toBeVisible()
      await expect(drawer).toContainText('kubernetes.default.svc')
    } finally {
      await request.delete(`/api/v1/cluster/custom-resources/${xbtp!.group}/${xbtp!.version}/${xbtp!.plural}/default/${name}?cluster=${cluster}`, { headers: admin, failOnStatusCode: false })
      await request.delete(`/api/v1/cluster/namespaces/default/backendtlspolicies/${name}?cluster=${cluster}`, { headers: admin, failOnStatusCode: false })
    }
  })
})
