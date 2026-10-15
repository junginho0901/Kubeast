import { test, expect, type APIRequestContext } from '@playwright/test'

// The second batch of feature tools: helm_read (releases read-only), policy_reports, cost, optimization, can_i,
// resource_graph and the Admin-only hygiene — all through k8s-service as the caller. Where the cluster lacks the
// feature the call answers unavailable; where the caller lacks the permission k8s-service asks for, the tool is
// not offered (list_clusters). Driven through the MCP endpoint, so the checks are exact.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-tools3-pass1!'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const stamp = () => Date.now().toString(36)

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email = EMAIL, password = PASSWORD): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createReadUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E tools3', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  const id = (await res.json()).id as string
  const grant = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })
  expect(grant.ok(), 'grant Read on self').toBeTruthy()
  return id
}

async function call(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    failOnStatusCode: false,
  })
  expect(res.status(), `${name}: ${await res.text()}`).toBe(200)
  const result = (await res.json()).result
  return { isError: !!result.isError, text: result.content?.[0]?.text as string }
}

async function mcpOn(request: APIRequestContext, token: string) {
  const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(token) })
  return config.ok() && (await config.json()).enabled
}

const json = (text: string) => JSON.parse(text)

test.describe('AI feature tools 2: helm_read, policy_reports, cost, optimization, can_i, resource_graph, hygiene', () => {
  test.setTimeout(240_000)

  test('helm_read lists, reads sections, history, images and the diff between revisions, read-only', async ({ request }) => {
    const token = await login(request)
    test.skip(!(await mcpOn(request, token)), 'the MCP server is off (mcp.enabled)')

    const list = json((await call(request, token, 'helm_read', { cluster: 'self' })).text)
    const kubeast = list.items.find((r: { name: string; namespace: string }) => r.name === 'kubeast' && r.namespace === 'kubeast')
    expect(kubeast, JSON.stringify(list).slice(0, 300)).toBeTruthy()
    expect(list.namespace).toBe('all namespaces')
    const revision = Number(kubeast.revision)
    expect(revision).toBeGreaterThan(1)

    const get = json((await call(request, token, 'helm_read', { cluster: 'self', what: 'get', namespace: 'kubeast', release: 'kubeast' })).text)
    expect(get.manifest).toBeUndefined()
    expect(get.manifest_note).toMatch(/what=manifest/)
    expect(get.values !== undefined || get.values_note !== undefined).toBe(true)
    expect(get.revision).toBe(revision)

    const values = json((await call(request, token, 'helm_read', { cluster: 'self', what: 'values', namespace: 'kubeast', release: 'kubeast' })).text)
    expect(values.section).toBe('values')
    expect(values.content).toMatch(/image/)

    const history = json((await call(request, token, 'helm_read', { cluster: 'self', what: 'history', namespace: 'kubeast', release: 'kubeast' })).text)
    expect(history.items_total).toBeGreaterThan(1)
    expect(history.items.some((h: { revision: number }) => h.revision === revision)).toBe(true)

    const images = json((await call(request, token, 'helm_read', { cluster: 'self', what: 'images', namespace: 'kubeast', release: 'kubeast' })).text)
    expect(images.items_total).toBeGreaterThan(0)

    const diff = json((await call(request, token, 'helm_read', { cluster: 'self', what: 'diff', namespace: 'kubeast', release: 'kubeast', from: revision - 1, to: revision })).text)
    expect(diff.from).toBe(revision - 1)
    expect(diff.to).toBe(revision)
    expect(typeof diff.diff).toBe('string')

    const rev = json((await call(request, token, 'helm_read', { cluster: 'self', what: 'revision', namespace: 'kubeast', release: 'kubeast', revision: revision - 1, section: 'values' })).text)
    expect(rev.revision).toBe(revision - 1)
    expect(rev.section).toBe('values')

    const missing = json((await call(request, token, 'helm_read', { cluster: 'self', what: 'get', namespace: 'kubeast', release: 'zz-no-such-release' })).text)
    expect(missing.status).toBe('not_found')

    const bad = await call(request, token, 'helm_read', { cluster: 'self', what: 'uninstall', namespace: 'kubeast', release: 'kubeast' })
    expect(bad.isError).toBe(true)
  })

  test('policy_reports and cost answer where the feature is served and say unavailable elsewhere', async ({ request }) => {
    const token = await login(request)
    test.skip(!(await mcpOn(request, token)), 'the MCP server is off (mcp.enabled)')

    const clusters = ((await (await request.get('/api/v1/clusters?accessibleOnly=true', { headers: bearer(token) })).json()).items ?? []) as { id: string }[]
    const installed: Record<string, boolean> = {}
    const costOn: Record<string, boolean> = {}
    for (const c of clusters) {
      const pr = await request.get(`/api/v1/cluster/policyreports/status?cluster=${c.id}`, { headers: bearer(token) })
      installed[c.id] = pr.ok() && !!(await pr.json()).installed
      const cs = await request.get(`/api/v1/cluster/cost/status?cluster=${c.id}`, { headers: bearer(token) })
      costOn[c.id] = cs.ok() && !!(await cs.json()).available
    }
    const withReports = Object.keys(installed).find((id) => installed[id])
    const withoutReports = Object.keys(installed).find((id) => !installed[id])
    if (withReports) {
      const summary = json((await call(request, token, 'policy_reports', { cluster: withReports })).text)
      expect(summary.view).toBe('summary')
      expect(summary.totals).toEqual(expect.objectContaining({ pass: expect.any(Number), fail: expect.any(Number) }))
      expect(summary.policies_total).toBeGreaterThan(0)
      const fails = json((await call(request, token, 'policy_reports', { cluster: withReports, view: 'results', results: 'fail', limit: 20 })).text)
      expect(fails.view).toBe('results')
      expect(fails.rows.length).toBeLessThanOrEqual(20)
      for (const row of fails.rows) expect(row.result).toBe('fail')
    }
    if (withoutReports) {
      const off = json((await call(request, token, 'policy_reports', { cluster: withoutReports })).text)
      expect(off).toMatchObject({ status: 'unavailable', feature: 'policyReports' })
    }

    const withCost = Object.keys(costOn).find((id) => costOn[id])
    const withoutCost = Object.keys(costOn).find((id) => !costOn[id])
    if (withCost) {
      const cost = json((await call(request, token, 'cost', { cluster: withCost, window: '24h' })).text)
      expect(cost.window).toBe('24h')
      expect(cost.aggregate).toBe('namespace')
      expect(cost.rows_total).toBeGreaterThan(0)
      expect(cost.rows[0]).toEqual(expect.objectContaining({ namespace: expect.any(String), total_cost: expect.any(Number) }))
      const one = json((await call(request, token, 'cost', { cluster: withCost, namespace: 'kube-system', aggregate: 'controller' })).text)
      expect(one.namespace).toBe('kube-system')
      for (const row of one.rows) expect(row.namespace).toBe('kube-system')
    }
    if (withoutCost) {
      const off = json((await call(request, token, 'cost', { cluster: withoutCost })).text)
      expect(off).toMatchObject({ status: 'unavailable', feature: 'cost' })
    }
    const bad = await call(request, token, 'cost', { cluster: 'self', window: '2d' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/one of 1h/)
  })

  test('optimization, can_i and resource_graph read as the caller; hygiene is the Admin report', async ({ request }) => {
    const token = await login(request)
    test.skip(!(await mcpOn(request, token)), 'the MCP server is off (mcp.enabled)')

    const opt = json((await call(request, token, 'optimization', { cluster: 'self', namespace: 'kubeast' })).text)
    expect(opt.namespace).toBe('kubeast')
    expect(opt.rows_total).toBeGreaterThan(0)
    expect(opt.rows[0]).toEqual(expect.objectContaining({ kind: expect.any(String), name: expect.any(String), container: expect.any(String) }))
    expect(opt.totals).toEqual(expect.objectContaining({ pods: expect.any(Number) }))

    const canList = json((await call(request, token, 'can_i', { cluster: 'self', verb: 'list', resource: 'pods', namespace: 'kubeast' })).text)
    expect(canList).toMatchObject({ allowed: true, verb: 'list', resource: 'pods', namespace: 'kubeast' })
    const canNodes = json((await call(request, token, 'can_i', { cluster: 'self', verb: 'get', resource: 'nodes' })).text)
    expect(canNodes.allowed).toBe(true)
    expect(canNodes.namespace).toBe('cluster scope')
    const badVerb = await call(request, token, 'can_i', { cluster: 'self', verb: 'Delete', resource: 'pods' })
    expect(badVerb.isError).toBe(true)

    const graph = json((await call(request, token, 'resource_graph', { cluster: 'self', namespace: 'kubeast' })).text)
    expect(graph.namespace).toBe('kubeast')
    expect(graph.counts_by_kind.Deployment).toBeGreaterThan(0)
    expect(graph.nodes.some((n: { kind: string; name: string }) => n.kind === 'Deployment' && n.name === 'auth-service')).toBe(true)
    expect(graph.edges_total).toBeGreaterThan(0)

    const config = await request.get('/api/v1/cluster/hygiene/config?cluster=self', { headers: bearer(token) })
    const hygieneOn = config.ok() && !!(await config.json()).enabled
    const hygiene = json((await call(request, token, 'hygiene', { cluster: 'self' })).text)
    if (hygieneOn) {
      expect(hygiene.cluster).toBe('self')
      expect(hygiene.report.counts).toBeTruthy()
      expect(Array.isArray(hygiene.report.findings)).toBe(true)
      const critical = json((await call(request, token, 'hygiene', { cluster: 'self', severity: 'critical' })).text)
      for (const f of critical.report.findings) expect(f.severity).toBe('critical')
    } else {
      expect(hygiene).toMatchObject({ status: 'unavailable', feature: 'hygiene' })
    }
  })

  test('list_clusters offers hygiene to Admin only and the feature tools as the features say', async ({ request }) => {
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')

    const adminClusters = json((await call(request, admin, 'list_clusters', {})).text).clusters as { id: string; tools: string[] }[]
    const self = adminClusters.find((c) => c.id === 'self')!
    expect(self.tools).toContain('hygiene')
    expect(self.tools).toContain('helm_read')
    expect(self.tools).toContain('can_i')
    const features = await (await request.get('/api/v1/cluster/features?cluster=self', { headers: bearer(admin) })).json()
    expect(self.tools.includes('cost')).toBe(!!features.cost?.enabled)
    expect(self.tools.includes('policy_reports')).toBe(!!features.policyReports?.enabled)

    const email = `e2e-tools3-r-${stamp()}@kubeast.local`
    let userId = ''
    try {
      userId = await createReadUser(request, admin, email)
      const reader = await login(request, email, PW)
      const readClusters = json((await call(request, reader, 'list_clusters', {})).text).clusters as { id: string; tools: string[] }[]
      const readSelf = readClusters.find((c) => c.id === 'self')!
      expect(readSelf.tools).not.toContain('hygiene')
      expect(readSelf.tools).toContain('helm_read')
      expect(readSelf.tools).toContain('resource_graph')
      // A Read user calling the Admin report directly is refused at the tool server.
      const refused = await call(request, reader, 'hygiene', { cluster: 'self' })
      expect(refused.isError).toBe(true)
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin) })
    }
  })
})
