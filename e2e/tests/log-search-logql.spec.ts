import { test, expect, type APIRequestContext } from '@playwright/test'

// LogQL written by an admin (features.logSearch.logql, admin.logsearch.query), against the kind setup of
// scripts/kind-logsearch.sh: one Loki holding both clusters. A Job prints a unique line; the admin finds it
// with a hand-written query, and the query actually sent (effectiveQuery) carries the cluster and namespace
// matchers. A query naming the other cluster's label returns nothing from this cluster (the matcher is ANDed)
// and lines from the other one; a metric query and a broken query are refused; a Read user gets 403; every
// query leaves an audit row with the query as written and as sent; the Pod drawer's LogQL toggle runs it.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-logql-pass1!'
const CLUSTER = 'self'
const OTHER = 'default'
const NS = 'default'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

const logql = (request: APIRequestContext, token: string, cluster: string, q: string, rest = '&since=10m') =>
  request.get(`/api/v1/cluster/namespaces/${NS}/logsearch/query?cluster=${cluster}&q=${encodeURIComponent(q)}${rest}`, { headers: bearer(token), failOnStatusCode: false })
const logqlAll = (request: APIRequestContext, token: string, cluster: string, q: string, rest = '&since=1h') =>
  request.get(`/api/v1/cluster/logsearch/query?cluster=${cluster}&q=${encodeURIComponent(q)}${rest}`, { headers: bearer(token), failOnStatusCode: false })

test.describe('LogQL written by an admin', () => {
  let admin = ''
  const job = `e2e-logql-${Date.now().toString(36)}`
  const marker = `${job}-marker`
  let pod = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    if (!features.logSearch?.clusters?.includes(CLUSTER) || !features.logSearch?.logql) return
    const yaml = [
      'apiVersion: batch/v1',
      'kind: Job',
      `metadata: {name: ${job}, namespace: ${NS}}`,
      'spec:',
      '  backoffLimit: 0',
      '  template:',
      '    spec:',
      '      restartPolicy: Never',
      '      containers:',
      '        - name: say',
      '          image: docker.io/library/busybox:1.38.0',
      `          command: [sh, -c, "echo ${marker} level=error; echo ${marker} level=info"]`,
    ].join('\n')
    const create = await request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, { headers: bearer(admin), data: { yaml, namespace: NS } })
    expect(create.ok(), await create.text()).toBeTruthy()
    await expect.poll(async () => {
      const res = await logql(request, admin, CLUSTER, `{k8s_container_name="say"} |= "${marker}"`)
      const lines = res.ok() ? (await res.json()).lines : []
      pod = lines[0]?.pod ?? ''
      return lines.length
    }, { timeout: 120_000, intervals: [3000] }).toBe(2)
  })

  test.afterAll(async ({ request }) => {
    if (admin) await request.delete(`/api/v1/namespaces/${NS}/jobs/${job}?cluster=${CLUSTER}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test.beforeEach(() => {
    test.skip(!pod, 'LogQL queries are off for cluster self — scripts/kind-logsearch.sh up (features.logSearch.logql)')
  })

  test('a hand-written query runs with the cluster and namespace matchers added, pipeline and all', async ({ request }) => {
    const raw = `{k8s_container_name="say"} |= "${marker}" | logfmt | level="error"`
    const res = await logql(request, admin, CLUSTER, raw)
    expect(res.status(), await res.text()).toBe(200)
    const body = await res.json()
    expect(body.lines.map((l: { line: string }) => l.line)).toEqual([`${marker} level=error`])
    expect(body.effectiveQuery).toBe(`{k8s_cluster_name="kubeast", k8s_namespace_name="${NS}", k8s_container_name="say"} |= "${marker}" | logfmt | level="error"`)

    type Row = { Action?: string; action?: string; After?: Record<string, unknown>; after?: Record<string, unknown> }
    const rows = ((await (await request.get('/api/v1/auth/admin/audit-logs?action=k8s.pod.logs.logql&limit=10', { headers: bearer(admin) })).json()).items ?? []) as Row[]
    const row = rows.find((r) => (r.After ?? r.after)?.logql === raw)
    expect(row, 'an audit row with the query as written').toBeTruthy()
    expect((row?.After ?? row?.after)?.effective).toBe(body.effectiveQuery)
    expect((row?.After ?? row?.after)?.lines).toBe(1)
    expect(JSON.stringify(rows)).not.toContain(`${marker} level=error`)
  })

  test("naming the other cluster's label reaches nothing here and the other cluster's lines there", async ({ request }) => {
    const q = `{k8s_cluster_name="kubeast-b"}`
    const here = await logqlAll(request, admin, CLUSTER, q)
    expect(here.status(), await here.text()).toBe(200)
    const hereBody = await here.json()
    expect(hereBody.effectiveQuery).toBe(`{k8s_cluster_name="kubeast", k8s_cluster_name="kubeast-b"}`)
    expect(hereBody.lines).toEqual([])

    const there = await logqlAll(request, admin, OTHER, q)
    expect(there.status(), await there.text()).toBe(200)
    const thereBody = await there.json()
    expect(thereBody.effectiveQuery).toBe(`{k8s_cluster_name="kubeast-b", k8s_cluster_name="kubeast-b"}`)
    expect(thereBody.lines.length).toBeGreaterThan(0)
  })

  test('a metric query, a broken query and a Read user are refused', async ({ request }) => {
    const metric = await logql(request, admin, CLUSTER, `sum(rate({k8s_container_name="say"}[5m]))`)
    expect(metric.status()).toBe(400)
    expect(await metric.text()).toContain('metric')
    const broken = await logql(request, admin, CLUSTER, `{k8s_container_name="say"`)
    expect(broken.status()).toBe(400)
    expect(await broken.text()).toContain('unterminated')
    const hidden = await logql(request, admin, CLUSTER, `{k8s_container_name="say"} /* " */ {b="c"} /* " */`)
    expect([400, 502]).toContain(hidden.status())

    const id = Date.now().toString(36)
    const email = `e2e-logql-${id}@kubeast.local`
    let userId = ''
    try {
      const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
      const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
      const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E logql', email, password: PW, role_id: member.id } })
      expect(created.status()).toBe(201)
      userId = (await created.json()).id
      const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read' } })
      expect(grant.ok(), await grant.text()).toBeTruthy()
      const user = await login(request, email, PW)
      const res = await logql(request, user, CLUSTER, `{k8s_container_name="say"}`)
      expect(res.status()).toBe(403)
      expect(await res.text()).toContain('admin.logsearch.query')
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('a non-admin whose global role carries admin.logsearch.query alone runs LogQL with a Read grant', async ({ request }) => {
    // The global role puts its admin.* permissions in the token for every cluster; the cluster is still asked as the
    // Read group, which the standard RBAC binds — no other admin feature opens.
    const id = Date.now().toString(36)
    const email = `e2e-logql-dev-${id}@kubeast.local`
    let userId = ''
    let roleId = 0
    try {
      const role = await request.post('/api/v1/auth/admin/roles', {
        headers: bearer(admin), data: { name: `e2e-logql-dev-${id}`, description: 'e2e', permissions: ['admin.logsearch.query'] },
      })
      expect(role.status(), await role.text()).toBe(201)
      roleId = (await role.json()).id
      const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E logql dev', email, password: PW, role_id: roleId } })
      expect(created.status(), await created.text()).toBe(201)
      userId = (await created.json()).id
      const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read' } })
      expect(grant.ok(), await grant.text()).toBeTruthy()
      const dev = await login(request, email, PW)
      const res = await logql(request, dev, CLUSTER, `{k8s_container_name="say"} |= "${marker}"`)
      expect(res.status(), await res.text()).toBe(200)
      expect((await res.json()).lines).toHaveLength(2)
      const users = await request.get('/api/v1/auth/admin/users', { headers: bearer(dev), failOnStatusCode: false })
      expect(users.status(), 'another admin feature stays closed').toBe(403)
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
      if (roleId) await request.delete(`/api/v1/auth/admin/roles/${roleId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('the Pod drawer runs a LogQL query and shows what was sent', async ({ page }) => {
    await page.goto(`/workloads/pods?cluster=${CLUSTER}`)
    const row = page.locator('tbody:not([aria-hidden="true"]) tr', { hasText: pod }).first()
    await expect(row).toBeVisible({ timeout: 20000 })
    await row.click()
    await expect(page.getByTestId('pod-logs-container')).toBeVisible({ timeout: 20000 })
    await page.getByTestId('log-source-search').click()
    await expect(page.getByTestId('logsearch-output')).toContainText(marker, { timeout: 20000 })

    await page.getByTestId('logsearch-logql').click()
    await expect(page.getByTestId('logsearch-text')).toHaveCount(0)
    await page.getByTestId('logsearch-logql-query').fill(`{} |= "${marker}" | logfmt | level="info"`)
    await page.getByTestId('logsearch-submit').click()
    await expect(page.getByTestId('logsearch-line')).toHaveCount(1, { timeout: 20000 })
    await expect(page.getByTestId('logsearch-line-text')).toContainText(`${marker} level=info`)
    await expect(page.getByTestId('logsearch-effective')).toContainText(`k8s_cluster_name="kubeast", k8s_namespace_name="${NS}"`)

    await page.getByTestId('logsearch-logql-query').fill(`{`)
    await page.getByTestId('logsearch-submit').click()
    await expect(page.getByTestId('logsearch-error')).toContainText(/unterminated/, { timeout: 20000 })
  })
})
