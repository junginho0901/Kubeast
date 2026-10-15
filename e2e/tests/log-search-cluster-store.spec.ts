import { test, expect, type APIRequestContext } from '@playwright/test'

// A cluster can name its own log store (Admin → Clusters → Edit): URL, credentials kept in a Secret, tenant and
// the value of its cluster label there — used for that cluster before the deployment's features.logSearch. On
// kind the deployment's store is the Loki behind the second cluster's HTTPS front and both clusters are in the
// map, so cluster "default" is pointed at that same front as its own store (its searches keep working and the
// status says "cluster"), then at a port nobody answers (that cluster's search fails while the other cluster's
// still works), a bad URL and tenant are refused, a stored token never shows in the audit row, and clearing the
// fields takes the cluster back to the deployment's store.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const OWN = 'default'
const OTHER = 'self'
const NS = 'default'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

const status = async (request: APIRequestContext, admin: string, cluster: string) =>
  (await request.get(`/api/v1/cluster/logsearch/status?cluster=${cluster}`, { headers: bearer(admin) })).json()
const search = (request: APIRequestContext, admin: string, cluster: string) =>
  request.get(`/api/v1/namespaces/${NS}/logsearch?cluster=${cluster}&since=5m`, { headers: bearer(admin), failOnStatusCode: false })
const patch = (request: APIRequestContext, admin: string, body: object) =>
  request.patch(`/api/v1/clusters/${OWN}`, { headers: bearer(admin), data: body, failOnStatusCode: false })
const cleared = { log_search_url: '', log_search_tenant: '', log_search_cluster_label: '', log_search_auth: { type: 'none' } }

test.describe("a cluster's own log store", () => {
  test.describe.configure({ mode: 'serial' })
  let admin = ''
  let globalURL = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request)
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    test.skip(!features.logSearch?.clusters?.includes(OWN) || !features.logSearch?.clusters?.includes(OTHER), 'log search is off for the dev clusters — run scripts/kind-logsearch.sh up')
    const before = await status(request, admin, OWN)
    test.skip(before.source !== 'global', `cluster ${OWN} already names its own store (${JSON.stringify(before)})`)
    globalURL = before.endpoint
  })

  test.afterAll(async ({ request }) => {
    if (admin) await patch(request, admin, cleared)
  })

  test('named, the store is used for that cluster only; unreachable, only that cluster fails', async ({ request }) => {
    // the unreachable store is given up after the search timeout (15 s), twice: the status and the search
    test.setTimeout(120_000)
    const res = await patch(request, admin, { log_search_url: globalURL, log_search_cluster_label: 'kubeast-b' })
    expect(res.status(), await res.text()).toBe(200)
    const meta = await res.json()
    expect(meta.log_search_url).toBe(globalURL)
    expect(meta.log_search_cluster_label).toBe('kubeast-b')
    expect(meta.log_search_auth).toBe(false)
    expect(await status(request, admin, OWN)).toMatchObject({ available: true, source: 'cluster', endpoint: globalURL, auth: false, cluster_label: 'kubeast-b', label_name: 'k8s_cluster_name' })
    expect(await status(request, admin, OTHER)).toMatchObject({ available: true, source: 'global', endpoint: globalURL })
    expect((await search(request, admin, OWN)).status()).toBe(200)
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    expect(features.logSearch.clusters).toContain(OWN)

    // a port nobody listens on: the search for this cluster fails, the other cluster's still answers
    expect((await patch(request, admin, { log_search_url: 'http://kubeast-b-control-plane:31999' })).status()).toBe(200)
    const down = await status(request, admin, OWN)
    expect(down.available).toBe(false)
    expect(down.source).toBe('cluster')
    expect(down.message).toBeTruthy()
    expect([502, 504]).toContain((await search(request, admin, OWN)).status())
    expect((await search(request, admin, OTHER)).status()).toBe(200)
  })

  test('a bad URL or tenant is refused; a stored token never appears in the audit row', async ({ request }) => {
    const badURL = await patch(request, admin, { log_search_url: 'loki:3100' })
    expect(badURL.status()).toBe(400)
    expect(await badURL.text()).toContain('log_search_url')
    const badTenant = await patch(request, admin, { log_search_tenant: 'team a' })
    expect(badTenant.status()).toBe(400)
    expect(await badTenant.text()).toContain('log_search_tenant')

    const token = `e2e-logstore-${Date.now().toString(36)}`
    const res = await patch(request, admin, { log_search_url: globalURL, log_search_tenant: 'team-a', log_search_auth: { type: 'bearer', token } })
    expect(res.status(), await res.text()).toBe(200)
    const meta = await res.json()
    expect(meta.log_search_auth).toBe(true)
    expect(meta.log_search_tenant).toBe('team-a')
    expect(JSON.stringify(meta)).not.toContain(token)
    // the dev Loki runs without auth or tenants, so a header it ignores still gets an answer
    expect(await status(request, admin, OWN)).toMatchObject({ available: true, source: 'cluster', auth: true, tenant: 'team-a' })

    type Row = { TargetID?: string; target_id?: string; After?: Record<string, unknown>; after?: Record<string, unknown> }
    const rows = ((await (await request.get('/api/v1/auth/admin/audit-logs?action=admin.cluster.update&limit=5', { headers: bearer(admin) })).json()).items ?? []) as Row[]
    const row = rows.find((r) => (r.TargetID ?? r.target_id) === OWN)
    expect((row?.After ?? row?.after)?.log_search_auth_change).toBe('set')
    expect(JSON.stringify(rows)).not.toContain(token)

    expect((await patch(request, admin, cleared)).status()).toBe(200)
    expect(await status(request, admin, OWN)).toMatchObject({ available: true, source: 'global', auth: false })
  })

  test('the edit dialog takes the store and the list shows it', async ({ page, request }) => {
    await page.goto('/admin/clusters')
    const row = page.locator('tbody tr').filter({ hasText: OWN }).filter({ hasNot: page.getByText('self', { exact: true }) }).first()
    await expect(row).toBeVisible({ timeout: 20000 })
    await row.getByRole('button', { name: /Edit|편집/ }).click()
    await page.getByTestId('edit-logsearch-url').fill(globalURL)
    await page.getByTestId('edit-logsearch-label').fill('kubeast-b')
    await page.getByTestId('edit-submit').click()

    await expect(row.getByTestId('cluster-logsearch-own')).toHaveAttribute('title', globalURL, { timeout: 15000 })
    expect(await status(request, admin, OWN)).toMatchObject({ source: 'cluster', endpoint: globalURL })
    await row.getByRole('button', { name: /Edit|편집/ }).click()
    await expect(page.getByTestId('edit-logsearch-url')).toHaveValue(globalURL)
    await page.getByTestId('edit-logsearch-check').click()
    await expect(page.getByTestId('edit-logsearch-status')).toContainText(/This cluster's store|이 클러스터의 저장소/, { timeout: 20000 })
    await expect(page.getByTestId('edit-logsearch-status')).toContainText(/OK|정상/)
  })
})
