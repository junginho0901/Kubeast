import { test, expect, type APIRequestContext } from '@playwright/test'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Alert → AI investigation (features.alertInvestigation on in the dev values). The webhook takes Alertmanager's
// message with the Bearer token from kubeast-secrets; a queued alert is investigated by the worker with the read-only
// tools as kubeast:investigator and the report comes back through /api/v1/ai/investigations. The model is the dev
// Ollama one, so the report's wording is not asserted — its shape, the tools used and the audit rows are. The last
// test goes through the real Alertmanager on the second cluster (deploy/kind/alertmanager.yaml), fed with amtool.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const READ_TOOLS = new Set([
  'get_cluster_overview', 'get_pod_metrics', 'get_node_metrics', 'k8s_get_resources', 'k8s_get_resource_yaml', 'k8s_get_pod_logs',
  'k8s_get_events', 'k8s_get_available_api_resources', 'k8s_get_cluster_configuration', 'k8s_check_service_connectivity', 'k8s_describe_resource',
  'k8s_find_resource', 'k8s_explain', 'issues', 'prometheus_query', 'prometheus_metrics', 'prometheus_labels',
  'prometheus_rules', 'prometheus_targets', 'logsearch', 'loki_query', 'loki_labels', 'loki_patterns',
  'traces_search', 'traces_get', 'traces_tags', 'traces_metrics', 'traces_compare', 'alerts_list',
  'policy_reports', 'helm_read', 'cost', 'optimization', 'can_i', 'resource_graph',
  'k8s_jq_query', 'k8s_tabular_query', 'k8s_count', 'gitops_status',
])
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

function kubectlFor(kindName: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-alerts-'))
  const kcPath = path.join(dir, 'kubeconfig')
  fs.writeFileSync(kcPath, execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' }), { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

const webhookToken = () =>
  Buffer.from(kubectlFor('kubeast')('-n kubeast get secret kubeast-secrets -o jsonpath={.data.ALERT_WEBHOOK_TOKEN}').trim(), 'base64').toString()

async function login(request: APIRequestContext, email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

function message(alerts: Array<Record<string, unknown>>) {
  return { version: '4', groupKey: '{}:{alertname="e2e"}', status: 'firing', receiver: 'kubeast', externalURL: 'http://alertmanager.e2e:9093', alerts }
}

function firing(name: string, fingerprint: string, labels: Record<string, string> = {}) {
  return {
    status: 'firing',
    labels: { alertname: name, severity: 'critical', namespace: 'default', deployment: 'e2e-unschedulable', ...labels },
    annotations: { summary: 'Deployment default/e2e-unschedulable has had no ready replica for 10 minutes.' },
    startsAt: new Date().toISOString(),
    generatorURL: 'http://prometheus.e2e/graph',
    fingerprint,
  }
}

type Row = { id: string; status: string; cluster: string; alertname: string; repeat_count: number }

async function findRow(request: APIRequestContext, admin: string, alertname: string, cluster: string): Promise<Row | undefined> {
  const res = await request.get('/api/v1/ai/investigations', { headers: bearer(admin), params: { cluster, limit: 50 } })
  expect(res.status()).toBe(200)
  return ((await res.json()).items as Row[]).find((r) => r.alertname === alertname)
}

async function waitFinished(request: APIRequestContext, admin: string, alertname: string, cluster: string, timeoutMs: number): Promise<Row> {
  let row: Row | undefined
  await expect
    .poll(async () => {
      row = await findRow(request, admin, alertname, cluster)
      return row?.status
    }, { timeout: timeoutMs, intervals: [3_000] })
    .toMatch(/^(done|failed)$/)
  return row as Row
}

async function activeModel(request: APIRequestContext, admin: string): Promise<{ provider: string; model: string }> {
  return (await request.get('/api/v1/ai/model-configs/active', { headers: bearer(admin) })).json()
}

async function auditRows(request: APIRequestContext, admin: string, action: string, since: string) {
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: bearer(admin), params: { action, since, limit: 50 } })
  expect(res.ok()).toBeTruthy()
  return (((await res.json()).items ?? []) as Array<Record<string, any>>).map((i) => ({ ...i, after: i.After ?? i.after ?? {} }))
}

test.describe('alert investigation', () => {
  test('the webhook wants the token, a known cluster and an Alertmanager message; it filters and counts', async ({ request }) => {
    const token = webhookToken()
    const name = `E2EGate${Date.now()}`
    const body = message([firing(name, `gate-${Date.now()}`, { severity: 'info' }), { ...firing(name, 'gate-resolved'), status: 'resolved' }])
    const post = (url: string, headers: Record<string, string>, data: unknown = body) =>
      request.post(url, { headers, data, failOnStatusCode: false })
    expect((await post('/api/v1/alerts/webhook?cluster=self', {})).status()).toBe(401)
    expect((await post('/api/v1/alerts/webhook?cluster=self', { Authorization: 'Bearer wrong' })).status()).toBe(401)
    const auth = { Authorization: `Bearer ${token}` }
    expect((await post('/api/v1/alerts/webhook', auth)).status()).toBe(400)
    expect((await post('/api/v1/alerts/webhook?cluster=no-such-cluster', auth)).status()).toBe(404)
    expect((await post('/api/v1/alerts/webhook?cluster=self', auth, { alerts: 'nope' })).status()).toBe(400)
    const ok = await post('/api/v1/alerts/webhook?cluster=self', auth)
    expect(ok.status()).toBe(200)
    expect(await ok.json()).toMatchObject({ accepted: 0, filtered: 1, resolved: 1 })
    const admin = await login(request)
    expect(await findRow(request, admin, name, 'self'), 'a filtered alert leaves no row').toBeUndefined()
  })

  test('a firing alert is investigated with read-only tools, audited, and a repeat only counts', async ({ request }) => {
    test.setTimeout(420_000)
    const token = webhookToken()
    const admin = await login(request)
    const active = await activeModel(request, admin)
    const since = new Date(Date.now() - 5_000).toISOString()
    const name = `E2EInvestigation${Date.now()}`
    const fp = `inv-${Date.now()}`
    const res = await request.post('/api/v1/alerts/webhook?cluster=self', { headers: { Authorization: `Bearer ${token}` }, data: message([firing(name, fp)]) })
    expect(res.status()).toBe(200)
    expect(await res.json()).toMatchObject({ accepted: 1, duplicate: 0 })

    const row = await waitFinished(request, admin, name, 'self', 360_000)
    const detail = await request.get(`/api/v1/ai/investigations/${row.id}`, { headers: bearer(admin) })
    expect(detail.status()).toBe(200)
    const d = await detail.json()
    expect(d.status, `investigation error: ${d.error}`).toBe('done')
    expect(d.report.length).toBeGreaterThan(40)
    expect(d.namespace).toBe('default')
    // The default model ran it, whichever provider that is (an API key or the Claude subscription).
    expect([d.provider, d.model]).toEqual([active.provider, active.model])
    expect(d.iterations).toBeGreaterThanOrEqual(1)
    for (const call of d.tool_calls as Array<{ tool: string }>) expect(READ_TOOLS.has(call.tool), `tool ${call.tool}`).toBe(true)
    // A model that calls tools (not the dev Ollama one) read the cluster: at least one call came back without an error.
    if (d.provider !== 'ollama') {
      const ok = (d.tool_calls as Array<{ tool: string; error?: string }>).filter((c) => !c.error)
      expect(ok.length, `tool calls: ${JSON.stringify(d.tool_calls)}`).toBeGreaterThan(0)
    }

    const runs = (await auditRows(request, admin, 'ai.investigation.run', since)).filter((r) => r.after.investigation_id === row.id)
    expect(runs).toHaveLength(1)
    expect(runs[0].ActorUserID ?? runs[0].actor_user_id).toBe('system')
    expect(runs[0].ActorEmail ?? runs[0].actor_email).toBe('kubeast:investigator')
    expect(runs[0].after.link).toBe(`http://localhost:30080/admin/investigations?id=${row.id}`)
    expect(runs[0].after.tool_calls).toBe(d.tool_calls.length)
    const views = (await auditRows(request, admin, 'ai.investigation.view', since)).filter((r) => (r.TargetID ?? r.target_id) === row.id)
    expect(views.length).toBeGreaterThanOrEqual(1)
    if (d.tool_calls.length > 0) {
      const toolRows = (await auditRows(request, admin, 'ai.tool.call', since)).filter((r) => r.after.investigation_id === row.id)
      expect(toolRows.length).toBe(d.tool_calls.length)
      expect(toolRows.every((r) => (r.ActorEmail ?? r.actor_email) === 'kubeast:investigator')).toBe(true)
    }

    const again = await request.post('/api/v1/alerts/webhook?cluster=self', { headers: { Authorization: `Bearer ${token}` }, data: message([firing(name, fp)]) })
    expect(await again.json()).toMatchObject({ accepted: 0, duplicate: 1 })
    expect((await findRow(request, admin, name, 'self'))?.repeat_count).toBe(2)
  })

  test('the reports need admin.investigations.read', async ({ request }) => {
    const admin = await login(request)
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-alerts-${Date.now().toString(36)}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E alerts reader', email, password: 'E2e-alerts-throwaway-1!', role_id: member.id } })
    expect(created.status()).toBe(201)
    const userId = (await created.json()).id as string
    try {
      await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })
      const reader = await login(request, email, 'E2e-alerts-throwaway-1!')
      expect((await request.get('/api/v1/ai/investigations', { headers: bearer(reader), failOnStatusCode: false })).status()).toBe(403)
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('the real Alertmanager on the second cluster delivers an amtool alert and it is investigated there', async ({ request }) => {
    test.setTimeout(420_000)
    const admin = await login(request)
    const name = `E2EAlertmanager${Date.now()}`
    kubectlFor('kubeast-b')(
      `-n monitoring exec deploy/alertmanager -- amtool alert add ${name} severity=warning namespace=kube-system ` +
        `--annotation=summary=CoreDNS-check --alertmanager.url=http://localhost:9093`,
    )
    await expect.poll(async () => (await findRow(request, admin, name, 'default'))?.cluster, { timeout: 60_000, intervals: [2_000] }).toBe('default')
    const row = await waitFinished(request, admin, name, 'default', 360_000)
    const d = await (await request.get(`/api/v1/ai/investigations/${row.id}`, { headers: bearer(admin) })).json()
    expect(d.status, `investigation error: ${d.error}`).toBe('done')
    expect(d.alertmanager_url).toContain('9093')
    expect(d.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(d.namespace).toBe('kube-system')
  })
})
