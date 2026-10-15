import { test, expect, type APIRequestContext } from '@playwright/test'

// The feature tools read Kubeast's own APIs through tool-server as the caller: issues (the dashboard's issue
// check), prometheus_query (PromQL through the cluster's Prometheus) and logsearch (the log store). They are
// offered only where the cluster serves the feature (k8s-service /features), and a missing feature or a
// refusal comes back as a result, not an error. Driven through the MCP endpoint, so the checks are exact.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

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

async function featuresOf(request: APIRequestContext, token: string, cluster: string) {
  const res = await request.get(`/api/v1/cluster/features?cluster=${cluster}`, { headers: bearer(token) })
  expect(res.ok(), `features ${cluster}`).toBeTruthy()
  return res.json()
}

async function mcpOn(request: APIRequestContext, token: string) {
  const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(token) })
  return config.ok() && (await config.json()).enabled
}

const json = (text: string) => JSON.parse(text)

test.describe('AI feature tools: issues, prometheus_query, logsearch', () => {
  test.setTimeout(180_000)

  test('issues reports the fixtures that are deliberately broken, narrowed by namespace and severity', async ({ request }) => {
    const token = await login(request)
    test.skip(!(await mcpOn(request, token)), 'the MCP server is off (mcp.enabled)')

    const all = json((await call(request, token, 'issues', { cluster: 'self' })).text)
    expect(all.namespace).toBe('all namespaces')
    expect(all.counts).toEqual(expect.objectContaining({ critical: expect.any(Number), warning: expect.any(Number), info: expect.any(Number) }))
    expect(all.total).toBe(all.issues.length)
    const names = all.issues.map((i: { kind: string; namespace?: string; name: string }) => `${i.kind}/${i.namespace}/${i.name}`)
    // deploy/kind/fixtures.yaml: an unschedulable Deployment and a failed Job in default.
    expect(names.some((n: string) => n.endsWith('/default/e2e-unschedulable')), names.join(' ')).toBe(true)
    expect(names.some((n: string) => n.startsWith('Job/default/e2e-failing-job')), names.join(' ')).toBe(true)
    for (const issue of all.issues) expect(['critical', 'warning', 'info']).toContain(issue.severity)

    const scoped = json((await call(request, token, 'issues', { cluster: 'self', namespace: 'default', severity: 'critical' })).text)
    expect(scoped.namespace).toBe('default')
    expect(scoped.issues.every((i: { namespace: string; severity: string }) => i.namespace === 'default' && i.severity === 'critical')).toBe(true)
    expect(scoped.counts.warning).toBe(0)
    expect(scoped.counts.info).toBe(0)

    const quiet = json((await call(request, token, 'issues', { cluster: 'self', namespace: 'kube-public' })).text)
    expect(quiet.total).toBe(0)
    expect(quiet.hint).toMatch(/Nothing is failing/)

    const bad = await call(request, token, 'issues', { cluster: 'self', severity: 'high' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/critical, warning, info/)
  })

  test('prometheus_query answers through the cluster that has Prometheus and says unavailable where none is reachable', async ({ request }) => {
    const token = await login(request)
    test.skip(!(await mcpOn(request, token)), 'the MCP server is off (mcp.enabled)')

    const clusters = ((await (await request.get('/api/v1/clusters?accessibleOnly=true', { headers: bearer(token) })).json()).items ?? []) as { id: string }[]
    const status: Record<string, boolean> = {}
    for (const c of clusters) {
      const res = await request.get(`/api/v1/cluster/prometheus/status?cluster=${c.id}`, { headers: bearer(token) })
      status[c.id] = res.ok() && !!(await res.json()).available
    }
    const withProm = Object.keys(status).find((id) => status[id])
    const without = Object.keys(status).find((id) => !status[id])
    test.skip(!withProm, 'no registered cluster reaches a Prometheus')

    const instant = json((await call(request, token, 'prometheus_query', { cluster: withProm, promql: 'up' })).text)
    expect(instant.range).toBe(false)
    expect(instant.series, JSON.stringify(instant)).toBeGreaterThan(0)
    expect(instant.results[0]).toEqual(expect.objectContaining({ metric: expect.any(Object), value: expect.anything() }))

    const range = json((await call(request, token, 'prometheus_query', { cluster: withProm, promql: 'up', range: true, since: '30m' })).text)
    expect(range.range).toBe(true)
    expect(range.since).toBe('30m0s')
    expect(range.step_seconds).toBe(15)
    expect(range.results[0].points.length).toBeGreaterThan(1)
    expect(range.results[0].points.length).toBeLessThanOrEqual(120)

    const none = json((await call(request, token, 'prometheus_query', { cluster: withProm, promql: 'no_such_metric_zz' })).text)
    expect(none.series).toBe(0)
    expect(none.hint).toMatch(/no series/)

    if (without) {
      const off = json((await call(request, token, 'prometheus_query', { cluster: without, promql: 'up' })).text)
      expect(off).toMatchObject({ status: 'unavailable', feature: 'prometheus' })
      expect(off.alternative).toMatch(/get_pod_metrics/)
    }

    const bad = await call(request, token, 'prometheus_query', { cluster: withProm, promql: 'up\nup' })
    expect(bad.isError).toBe(true)
  })

  test('logsearch reads the log store where it is configured and is unavailable elsewhere; list_clusters offers the tools per cluster', async ({ request }) => {
    const token = await login(request)
    test.skip(!(await mcpOn(request, token)), 'the MCP server is off (mcp.enabled)')

    const clusters = json((await call(request, token, 'list_clusters', {})).text).clusters as { id: string; tools: string[] }[]
    expect(clusters.length).toBeGreaterThan(0)
    for (const c of clusters) {
      const f = await featuresOf(request, token, c.id)
      expect(c.tools, `${c.id}: issues is always offered`).toContain('issues')
      expect(c.tools.includes('prometheus_query'), `${c.id}: prometheus_query follows features.prometheus.enabled`).toBe(!!f.prometheus?.enabled)
      const logOn = !!f.logSearch?.enabled && (f.logSearch?.clusters ?? []).includes(c.id)
      expect(c.tools.includes('logsearch'), `${c.id}: logsearch follows features.logSearch.clusters`).toBe(logOn)
    }

    const selfFeatures = await featuresOf(request, token, 'self')
    const logOnSelf = !!selfFeatures.logSearch?.enabled && (selfFeatures.logSearch?.clusters ?? []).includes('self')
    if (logOnSelf) {
      const lines = json((await call(request, token, 'logsearch', { cluster: 'self', namespace: 'kubeast', since: '1h', limit: 5 })).text)
      expect(lines.namespace).toBe('kubeast')
      expect(Array.isArray(lines.lines)).toBe(true)
      expect(lines.lines.length).toBeLessThanOrEqual(5)
      for (const l of lines.lines) expect(l).toEqual(expect.objectContaining({ namespace: 'kubeast', pod: expect.any(String), line: expect.any(String) }))
      // A pod that does not exist matches no stream. (A nonsense text would still match: k8s-service's own audit
      // line for the search carries the search text, and the store ingests k8s-service's logs too.)
      const nothing = json((await call(request, token, 'logsearch', { cluster: 'self', namespace: 'kubeast', pod: 'zz-no-such-pod', since: '1h' })).text)
      expect(nothing.lines).toEqual([])
      expect(nothing.hint).toMatch(/Widen since/)
    } else {
      // The tool is not offered for self, but a direct call still answers with a result the model can act on.
      const off = json((await call(request, token, 'logsearch', { cluster: 'self', namespace: 'kubeast' })).text)
      expect(off).toMatchObject({ status: 'unavailable', feature: 'logSearch' })
    }
  })
})
