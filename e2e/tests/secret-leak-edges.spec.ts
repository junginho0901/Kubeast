import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// What stays out of a tool's answer, an audit row and a window, called over MCP and the API with no model: a Secret in the
// shapes kubectl does not print, a terminal's command in its row, what a read took out in its row's count, a server's
// answer to a connection test, and a link in a report, which opens beside the console.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'self'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const STUB = 'http://model-stub.kubeast-devtools.svc.cluster.local:8090'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any

const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-leak-edges-')), 'kubeconfig')
fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string[], input?: string) =>
  execFileSync('kubectl', ['--kubeconfig', kc, '--context', 'kind-kubeast', ...args], { encoding: 'utf8', input }).trim()

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const stamp = () => Date.now().toString(36)

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), `login: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function mcpOn(request: APIRequestContext, token: string): Promise<boolean> {
  const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(token) })
  return config.ok() && !!(await config.json()).enabled
}

async function toolText(request: APIRequestContext, token: string, name: string, args: object): Promise<string> {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { cluster: CLUSTER, ...args } } },
  })
  expect(res.status(), `${name}: ${await res.text()}`).toBe(200)
  const result = (await res.json()).result
  expect(!!result.isError, `${name}: ${result.content?.[0]?.text}`).toBe(false)
  return result.content?.[0]?.text as string
}

async function auditRows(request: APIRequestContext, admin: string, action: string, since: string): Promise<Obj[]> {
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: bearer(admin), params: { action, since, limit: '100' } })
  expect(res.status(), `audit: ${await res.text()}`).toBe(200)
  return (await res.json()).items ?? []
}

const afterOf = (row: Obj) => row.After ?? row.after ?? {}

test.describe('what stays out', () => {
  const run = stamp()
  const ns = `e2e-leak-${run}`

  test.beforeAll(() => {
    kubectl(['create', 'namespace', ns])
  })

  test.afterAll(() => {
    try {
      kubectl(['delete', 'namespace', ns, '--ignore-not-found', '--wait=false'])
    } catch {
      // best effort
    }
  })

  test('a Secret in flow YAML or as escaped JSON does not reach a tool answer', async ({ request }) => {
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    const flowValue = `fake-flow-${run}`
    const escapedValue = `fake-escaped-${run}`
    kubectl(['apply', '-f', '-'], JSON.stringify({
      apiVersion: 'v1', kind: 'List', items: [
        { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'flow', namespace: ns }, data: { LINE: `{kind: Secret, data: {note: ${flowValue}}}` } },
        { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'escaped', namespace: ns }, data: {
          LINE: `msg="{\\"kind\\":\\"Secret\\",\\"data\\":{\\"note\\":\\"${escapedValue}\\"}}"`, LOG_LEVEL: 'debug',
        } },
      ],
    }))
    const flow = await toolText(request, admin, 'k8s_get_resource_yaml', { resource_type: 'configmap', resource_name: 'flow', namespace: ns })
    expect(flow).not.toContain(flowValue)
    expect(flow).toContain('<REDACTED:secret>')
    const escaped = await toolText(request, admin, 'k8s_get_resource_yaml', { resource_type: 'configmap', resource_name: 'escaped', namespace: ns })
    expect(escaped).not.toContain(escapedValue)
    expect(escaped).toContain('<REDACTED:secret>')
    expect(escaped, 'the rest of the object stays').toContain('LOG_LEVEL: debug')
  })

  test('the names and paths a reader needs stay under keys named like a credential', async ({ request }) => {
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    kubectl(['apply', '-f', '-'], JSON.stringify({
      apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'names', namespace: ns },
      data: { existingSecret: 'my-tls', tlsSecret: 'my-tls', PWD: '/home/me/My Docs', foo_pass: '3', ARGS: '--from-file=token=./token.txt', LOG: 'DB_PASSWORD=fake-pass-1 psql -h db' },
    }))
    const text = await toolText(request, admin, 'k8s_get_resource_yaml', { resource_type: 'configmap', resource_name: 'names', namespace: ns })
    for (const kept of ['existingSecret: my-tls', 'tlsSecret: my-tls', 'PWD: /home/me/My Docs', '--from-file=token=./token.txt', 'psql -h db']) expect(text).toContain(kept)
    expect(text).toMatch(/foo_pass: "?3"?/)
    expect(text).not.toContain('fake-pass-1')
  })

  test('a query over Secrets says in its row what the read took out', async ({ request }) => {
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    kubectl(['create', 'secret', 'generic', 'counted', '-n', ns, '--from-literal=a=fake-1', '--from-literal=b=fake-2'])
    const since = new Date(Date.now() - 5_000).toISOString()
    const text = await toolText(request, admin, 'k8s_jq_query', { resource_type: 'secrets', namespace: ns, jq: '.items[].metadata.name' })
    expect(text).toContain('counted')
    await expect.poll(async () => {
      const rows = (await auditRows(request, admin, 'ai.mcp.call', since)).filter((r) => afterOf(r).tool === 'k8s_jq_query')
      return afterOf(rows[0] ?? {}).redacted?.kinds?.secret
    }, { timeout: 15_000 }).toBe(2)
  })

  test('a terminal command is masked in its row', async ({ page, request }) => {
    const admin = await login(request)
    const pods = kubectl(['-n', 'kubeast', 'get', 'pods', '-o', 'name']).split('\n').map((p) => p.replace('pod/', ''))
    const pod = pods.find((p) => p.startsWith('frontend-'))
    expect(pod, 'a frontend pod').toBeTruthy()
    const value = `fake-terminal-${run}`
    const since = new Date(Date.now() - 5_000).toISOString()
    const command = encodeURIComponent(`mysql -h db --password=${value}`)
    await page.goto('/')
    await page.evaluate((url) => new Promise<void>((resolve) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(`${proto}//${location.host}${url}`)
      const done = () => { try { socket.close() } catch { /* closed */ } resolve() }
      socket.onmessage = done
      socket.onclose = done
      socket.onerror = done
      setTimeout(done, 8_000)
    }), `/api/v1/cluster/namespaces/kubeast/pods/${pod}/exec/ws?cluster=${CLUSTER}&command=${command}&cols=80&rows=24`)
    await expect.poll(async () => {
      const rows = (await auditRows(request, admin, 'k8s.pod.exec', since)).filter((r) => JSON.stringify(r).includes(pod as string))
      return rows.map((r) => afterOf(r).command)[0]
    }, { timeout: 15_000 }).toBe('mysql -h db --password=<REDACTED:password>')
    const all = JSON.stringify(await auditRows(request, admin, 'k8s.pod.exec', since))
    expect(all).not.toContain(value)
  })

  test('a connection test says the provider\'s error and nothing else of its answer', async ({ request }) => {
    const admin = await login(request)
    const res = await request.post('/api/v1/ai/model-configs/test', {
      headers: bearer(admin), timeout: 60_000, failOnStatusCode: false,
      data: { provider: 'custom', model: `e2e-${run}`, base_url: `${STUB}/no-such-case/v1`, api_key: 'e2e-key' },
    })
    test.skip(res.status() === 400, 'the dev model-stub is not on the allow list (ai.baseUrlAllowedHosts)')
    expect(await res.json()).toEqual({ success: false, message: 'HTTP 404: no such case' })
  })

  test('a link in an investigation report opens beside the console', async ({ page, request }) => {
    const admin = await login(request)
    const features = await (await request.get('/api/v1/cluster/features', { headers: bearer(admin) })).json()
    test.skip(!features.alertInvestigation?.enabled, 'alert investigation is off')
    const now = new Date().toISOString()
    const id = `inv-e2e-link-${run}`
    await page.route(`**/api/v1/ai/investigations/${id}*`, (route) => route.fulfill({
      json: {
        id, cluster: CLUSTER, alertname: 'E2ELink', severity: 'info', namespace: '', status: 'done', skip_reason: '', received_at: now, started_at: now, finished_at: now,
        repeat_count: 1, last_seen_at: now, model: 'e2e', total_tokens: 1, iterations: 1, tool_call_count: 0, duration_ms: 1, fingerprint: 'f', labels: {}, annotations: {},
        starts_at: now, generator_url: '', alertmanager_url: '', report: '[runbook](https://example.test/runbook)', tool_calls: [], error: '',
      },
    }))
    await page.goto(`/admin/investigations?id=${id}`)
    const link = page.getByTestId('investigation-report').getByRole('link', { name: 'runbook' })
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(link).toHaveAttribute('href', 'https://example.test/runbook')
  })
})
