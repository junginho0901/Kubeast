import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// Two AI tools called through the MCP endpoint, so the checks are exact and no model runs:
// - clusters_list: what the cluster picker lists (GET /api/v1/clusters?accessibleOnly=true) and, for a holder of
//   admin.clusters.list, Admin → Clusters, value for value; no kubeconfig or credential.
// - alert_investigate: the alert window's "Investigate now" (POST /api/v1/alerts/inbox/{id}/investigate): the same
//   investigation row, the same answer, the same audit rows, the button's permissions and refusals.
// The alerts carry a namespace label that is not a Kubernetes name, so auth-service refuses the investigator's token and
// a run ends before its first model call; the queue, the worker and the audit rows are the real ones. Running, finished
// and spent-budget rows are written into the dev database as the service writes them (inv-e2e-sym1-*) and removed after.

const INBOX_CLUSTER = 'self'
const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-sym1-pass1!'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const TOOL = 'alert_investigate'
const PICKER_FIELDS = ['id', 'display_name', 'mode', 'is_self_cluster', 'health_status', 'last_healthcheck_at'] as const
const ADMIN_SCREEN_FIELDS = ['api_server_url', 'created_by', 'prometheus_url', 'prometheus_cluster_label', 'prometheus_auth', 'prometheus_service',
  'log_search_url', 'log_search_tenant', 'log_search_cluster_label', 'log_search_auth'] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const badNamespace = (run: string) => `E2E_SYM1_${run}`

const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ai-sym1-')), 'kubeconfig')
fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string[]) => execFileSync('kubectl', ['--kubeconfig', kc, '--context', 'kind-kubeast', ...args], { encoding: 'utf8' }).trim()
const psql = (sql: string) => kubectl(['-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql])

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function call(request: APIRequestContext, token: string, name: string, args: Obj): Promise<{ isError: boolean; text: string }> {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: name === 'list_clusters' ? {} : { cluster: INBOX_CLUSTER, ...args } } },
    failOnStatusCode: false,
  })
  expect(res.status(), `${name}: ${await res.text()}`).toBe(200)
  const result = (await res.json()).result
  return { isError: !!result.isError, text: result.content?.[0]?.text as string }
}

async function answerOf(request: APIRequestContext, token: string, name: string, args: Obj): Promise<Obj> {
  const { isError, text } = await call(request, token, name, args)
  expect(isError, `${name}: ${text}`).toBe(false)
  return JSON.parse(text)
}

async function toolNames(request: APIRequestContext, token: string): Promise<string[]> {
  const res = await request.post(MCP, { headers: { ...RPC, Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
  expect(res.status(), await res.text()).toBe(200)
  return ((await res.json()).result.tools as { name: string }[]).map((t) => t.name)
}

async function auditRows(request: APIRequestContext, admin: string, action: string, since: string): Promise<Obj[]> {
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: bearer(admin), params: { action, since, limit: 100 } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()).items ?? []).map((i: Obj) => ({
    target: i.TargetID ?? i.target_id, targetType: i.TargetType ?? i.target_type, actor: i.ActorEmail ?? i.actor_email, result: i.Result ?? i.result,
    agent: i.UserAgent ?? i.user_agent, cluster: i.Cluster ?? i.cluster, after: i.After ?? i.after ?? {},
  }))
}

const pickerRow = (row: Obj) => Object.fromEntries(PICKER_FIELDS.map((f) => [f, row[f] ?? null]))

test.describe('AI tools: clusters_list and alert_investigate', () => {
  let admin = ''
  let adminEmail = ''
  let webhookToken = ''
  let investigationOn = false
  const userIds: string[] = []
  const roleIds: number[] = []

  test.beforeEach(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    test.skip(!config.ok() || !(await config.json()).enabled, 'the MCP server is off (mcp.enabled)')
    investigationOn = !!(await (await request.get(`/api/v1/cluster/features?cluster=${INBOX_CLUSTER}`, { headers: bearer(admin) })).json()).alertInvestigation?.enabled
    adminEmail ||= (await (await request.get('/api/v1/auth/me', { headers: bearer(admin) })).json()).email
    webhookToken ||= Buffer.from(kubectl(['-n', 'kubeast', 'get', 'secret', 'kubeast-secrets', '-o', 'jsonpath={.data.ALERT_WEBHOOK_TOKEN}']), 'base64').toString()
  })

  test.afterEach(async ({ request }) => {
    for (const id of userIds.splice(0)) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    for (const id of roleIds.splice(0)) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  async function user(request: APIRequestContext, label: string, role: string, namespaces?: string[]): Promise<{ email: string; token: string }> {
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = ((Array.isArray(raw) ? raw : raw.roles || raw.items || []) as { id: number; name: string }[]).find((r) => r.name.toLowerCase() === 'member')!
    const email = `e2e-sym1-${label}-${Date.now().toString(36)}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E sym1 ${label}`, email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    userIds.push(userId)
    const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${INBOX_CLUSTER}`, { headers: bearer(admin), data: { role, ...(namespaces ? { namespaces } : {}) } })
    expect(put.ok(), await put.text()).toBeTruthy()
    return { email, token: await login(request, email, PW) }
  }

  // A role with the tool and the button's permission, and without the admin screen of reports.
  async function askerRole(request: APIRequestContext, run: string): Promise<string> {
    const name = `e2e-sym1-asker-${run}`
    const role = await request.post('/api/v1/auth/admin/roles', {
      headers: bearer(admin),
      data: { name, description: 'e2e', permissions: ['menu.*', 'resource.*.read', 'resource.alert.investigate', 'ai.tool.*', 'ai.mcp.use'] },
    })
    expect(role.status(), await role.text()).toBe(201)
    roleIds.push((await role.json()).id)
    return name
  }

  const post = (request: APIRequestContext, status: string, labels: Obj, fingerprint: string, extra: Obj = {}) =>
    request.post(`/api/v1/alerts/webhook?cluster=${INBOX_CLUSTER}`, {
      headers: { Authorization: `Bearer ${webhookToken}` },
      data: {
        version: '4', groupKey: `{}:{alertname="${labels.alertname}"}`, status, receiver: 'kubeast', externalURL: 'http://alertmanager.e2e:9093',
        alerts: [{ status, labels, annotations: { summary: `sym1 ${labels.alertname}` }, startsAt: new Date(Date.now() - 3 * 60_000).toISOString(), fingerprint, ...extra }],
      },
    })

  async function newAlert(request: APIRequestContext, run: string, label: string, extraLabels: Obj = {}): Promise<{ id: string; labels: Obj; fingerprint: string }> {
    test.skip(!investigationOn, 'alert investigation (the webhook and the inbox) is off')
    const labels = { alertname: `E2ESym1${label}${run}`, severity: 'info', namespace: badNamespace(run), ...extraLabels }
    const fingerprint = `sym1-${label.toLowerCase()}-${Object.values(extraLabels).join('-')}-${run}`
    expect((await (await post(request, 'firing', labels, fingerprint)).json()).stored).toBe(1)
    const list = await (await request.get('/api/v1/alerts/inbox', { headers: bearer(admin), params: { cluster: INBOX_CLUSTER, q: run, limit: 50 } })).json()
    const item = (list.items as Obj[]).find((i) => i.fingerprint === fingerprint)
    expect(item, 'its inbox row').toBeTruthy()
    return { id: item.id, labels, fingerprint }
  }

  async function windowOf(request: APIRequestContext, token: string, id: string): Promise<Obj> {
    const res = await request.get(`/api/v1/alerts/inbox/${id}`, { headers: bearer(token) })
    expect(res.status(), await res.text()).toBe(200)
    return res.json()
  }

  const rowsOf = (fingerprint: string) => psql(`SELECT count(*) FROM alert_investigations WHERE cluster = '${INBOX_CLUSTER}' AND fingerprint = '${fingerprint}'`)

  async function cleanUp(request: APIRequestContext, run: string, ...alerts: { labels: Obj; fingerprint: string }[]) {
    psql(`DELETE FROM alert_investigations WHERE id LIKE 'inv-e2e-sym1-${run}-%' OR (cluster = '${INBOX_CLUSTER}' AND fingerprint LIKE 'sym1-%-${run}')`)
    for (const a of alerts) await post(request, 'resolved', a.labels, a.fingerprint, { endsAt: new Date().toISOString() })
  }

  // The alert as the service writes a row of it, with these columns besides (values as SQL).
  const insert = (alert: { labels: Obj; fingerprint: string }, id: string, columns: Record<string, string>) => psql(
    `INSERT INTO alert_investigations (id, cluster, fingerprint, alertname, severity, namespace, received_at, last_seen_at, ${Object.keys(columns).join(', ')})
     VALUES ('${id}', '${INBOX_CLUSTER}', '${alert.fingerprint}', '${alert.labels.alertname}', 'info', '${alert.labels.namespace}',
             now() at time zone 'utc', now() at time zone 'utc', ${Object.values(columns).join(', ')})`)

  test('clusters_list answers the picker and the Admin screen value for value, and no credential', async ({ request }) => {
    const picker = (await (await request.get('/api/v1/clusters?accessibleOnly=true', { headers: bearer(admin) })).json()).items as Obj[]
    const registry = (await (await request.get('/api/v1/clusters', { headers: bearer(admin) })).json()).items as Obj[]
    const answer = await answerOf(request, admin, 'clusters_list', {})
    expect(answer.total).toBe(registry.length)
    expect((answer.clusters as Obj[]).map(pickerRow)).toEqual(registry.map(pickerRow))
    expect((answer.clusters as Obj[]).filter((c) => c.current).map((c) => c.id)).toEqual([INBOX_CLUSTER])
    expect((answer.clusters as Obj[]).filter((c) => c.reachable).map((c) => c.id)).toEqual(picker.map((c) => c.id))
    for (const row of registry) {
      const toolRow = (answer.clusters as Obj[]).find((c) => c.id === row.id)
      for (const field of ADMIN_SCREEN_FIELDS) expect(toolRow[field] ?? null, `${row.id}.${field}`).toEqual(row[field] ?? null)
    }
    expect(JSON.stringify(answer).toLowerCase()).not.toContain('kubeconfig')

    const reader = await user(request, 'cl-read', 'Read')
    const own = (await (await request.get('/api/v1/clusters?accessibleOnly=true', { headers: bearer(reader.token) })).json()).items as Obj[]
    expect(own.map((c) => c.id)).toEqual([INBOX_CLUSTER])
    const readerAnswer = await answerOf(request, reader.token, 'clusters_list', {})
    expect(readerAnswer.clusters).toEqual([{ ...pickerRow(own[0]), current: true }])
    for (const c of registry) {
      if (c.api_server_url) expect(JSON.stringify(readerAnswer)).not.toContain(c.api_server_url)
    }
    // A cluster the reader holds no grant on is refused, not listed.
    const other = registry.find((c) => c.id !== INBOX_CLUSTER)
    if (other) {
      const refused = await call(request, reader.token, 'clusters_list', { cluster: other.id })
      expect(refused.isError).toBe(true)
      expect(refused.text).toMatch(/forbidden/)
    }

    const limited = await user(request, 'cl-limited', 'Read', ['default'])
    const limitedAnswer = await answerOf(request, limited.token, 'clusters_list', {})
    expect(limitedAnswer.clusters).toEqual([{ ...pickerRow(own[0]), current: true, namespaces: ['default'] }])
  })

  test("an investigation's token reads its own cluster through clusters_list and opens no other auth-service route", async ({ request }) => {
    test.skip(!investigationOn, 'alert investigation (the investigator token) is off')
    // Asked for as ai-service asks, from its pod; the answer printed holds statuses and bodies, not the token.
    const script = `
import json, os, urllib.error, urllib.request

AUTH = 'http://auth-service:8004'
CLUSTER = '${INBOX_CLUSTER}'

def call(method, url, headers, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={'Content-Type': 'application/json', **headers})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return {'status': res.status, 'body': res.read().decode()}
    except urllib.error.HTTPError as err:
        return {'status': err.code, 'body': err.read().decode()}

issued = call('POST', os.environ['AUTH_INVESTIGATOR_TOKEN_URL'], {'X-Internal-Token': os.environ['INTERNAL_API_TOKEN']}, {'cluster_id': CLUSTER})
if issued['status'] != 200:
    raise SystemExit('token refused: %d' % issued['status'])
token = {'Authorization': 'Bearer ' + json.loads(issued['body'])['access_token']}
print(json.dumps({
    'list': call('GET', AUTH + '/api/v1/clusters?accessibleOnly=true', token),
    'registry': call('GET', AUTH + '/api/v1/clusters', token),
    'tool': call('POST', os.environ.get('TOOL_SERVER_URL', 'http://tool-server:8086') + '/tools/call', token, {'name': 'clusters_list', 'arguments': {'cluster': CLUSTER}}),
    'others': {
        'POST /api/v1/clusters': call('POST', AUTH + '/api/v1/clusters', token, {}),
        'GET /api/v1/auth/me': call('GET', AUTH + '/api/v1/auth/me', token),
        'POST /api/v1/auth/refresh': call('POST', AUTH + '/api/v1/auth/refresh', token, {}),
        'GET /api/v1/auth/roles': call('GET', AUTH + '/api/v1/auth/roles', token),
        'POST /api/v1/auth/admin/roles': call('POST', AUTH + '/api/v1/auth/admin/roles', token, {'name': 'e2e-sym1-never', 'permissions': []}),
        'POST /api/v1/auth/access-requests': call('POST', AUTH + '/api/v1/auth/access-requests', token, {}),
    },
}))
`
    const out = JSON.parse(execFileSync('kubectl', ['--kubeconfig', kc, '--context', 'kind-kubeast', '-n', 'kubeast', 'exec', '-i', 'deploy/ai-service', '--', 'python', '-'], { input: script, encoding: 'utf8' })) as Obj
    const picker = ((await (await request.get('/api/v1/clusters?accessibleOnly=true', { headers: bearer(admin) })).json()).items as Obj[]).filter((c) => c.id === INBOX_CLUSTER)
    expect(picker.map((c) => c.id), 'the admin reads that cluster').toEqual([INBOX_CLUSTER])

    expect(out.list.status, out.list.body).toBe(200)
    expect((JSON.parse(out.list.body).items as Obj[]).map(pickerRow), 'the route: its own row').toEqual(picker.map(pickerRow))
    expect(out.tool.status, out.tool.body).toBe(200)
    const answer = JSON.parse(JSON.parse(out.tool.body).content)
    expect(answer.total, 'the tool: one row').toBe(1)
    expect((answer.clusters as Obj[]).map(pickerRow), 'the tool: its own row').toEqual(picker.map(pickerRow))
    expect(answer.clusters[0].current).toBe(true)

    expect(out.registry.status, 'the registry view takes admin.clusters.list').toBe(403)
    expect(out.registry.body).toContain('admin.clusters.list')
    for (const [route, res] of Object.entries(out.others) as [string, Obj][]) {
      expect.soft(res.status, route).toBe(403)
      expect.soft(res.body, route).toContain('does not take a system token')
    }
    const roles = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    expect(((Array.isArray(roles) ? roles : roles.roles || roles.items || []) as { name: string }[]).map((r) => r.name), 'nothing was made').not.toContain('e2e-sym1-never')
  })

  test('alert_investigate presses the button: its row, its answer and its audit rows', async ({ request }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const since = new Date(Date.now() - 5_000).toISOString()
    const alert = await newAlert(request, run, 'Press')
    try {
      const before = await windowOf(request, admin, alert.id)
      expect(before.investigation, 'info alerts are not investigated by the webhook').toBeNull()
      test.skip(['provider_paused', 'manual_off', 'manual_budget'].includes(before.investigate_now?.reason), `the dev install does not let anyone ask now (${before.investigate_now?.reason})`)

      // Nothing yet, and status_only starts nothing.
      const looked = await answerOf(request, admin, TOOL, { alert_id: alert.id, status_only: true })
      expect({ started: looked.started, investigation: looked.investigation, reason: looked.investigate_now.reason, allowed: looked.investigate_now.allowed, budget: looked.investigate_now.budget, used: looked.investigate_now.used })
        .toEqual({ started: false, investigation: null, reason: before.investigate_now.reason, allowed: before.investigate_now.allowed, budget: before.investigate_now.budget, used: before.investigate_now.used })
      expect(looked.report_link).toBeUndefined()
      expect(rowsOf(alert.fingerprint)).toBe('0')

      const first = await answerOf(request, admin, TOOL, { alert_id: alert.id })
      expect({ started: first.started, status: first.investigation.status, requested_by: first.investigation.requested_by }).toEqual({ started: true, status: 'queued', requested_by: adminEmail })
      const invId = first.investigation.id as string
      expect(rowsOf(alert.fingerprint)).toBe('1')
      const shown = await windowOf(request, admin, alert.id)
      expect(shown.investigation.id, 'the window shows the investigation the tool started').toBe(invId)
      for (const field of ['id', 'alertname', 'severity', 'namespace', 'status', 'summary', 'starts_at', 'labels', 'cluster']) expect(first.alert[field], `alert.${field}`).toEqual(shown[field])
      for (const field of ['permission', 'automatic', 'budget']) expect(first.investigate_now[field], `investigate_now.${field}`).toEqual(shown.investigate_now[field])
      expect(first.alert_link).toContain(`/alerts?alert=${alert.id}&cluster=${INBOX_CLUSTER}`)
      expect(first.report_link).toContain(`/admin/investigations?id=${invId}`)

      await expect.poll(async () => (await auditRows(request, admin, 'ai.investigation.request', since)).filter((r) => r.target === alert.id)
        .map((r) => ({ actor: r.actor, result: r.result, started: r.after.started, investigation_id: r.after.investigation_id, agent: r.agent, cluster: r.cluster })), { timeout: 15_000 })
        .toEqual([{ actor: adminEmail, result: 'success', started: true, investigation_id: invId, agent: 'kubeast-tool-server', cluster: INBOX_CLUSTER }])
      await expect.poll(async () => (await auditRows(request, admin, 'ai.mcp.call', since)).filter((r) => r.after.tool === TOOL && r.target === alert.id)
        .map((r) => ({ actor: r.actor, result: r.result, targetType: r.targetType, write: r.after.write })).at(-1), { timeout: 15_000 })
        .toEqual({ actor: adminEmail, result: 'success', targetType: 'alert', write: false })

      // The worker takes it and the investigator's token is refused: failed, and status_only reads why without a new run.
      await expect.poll(() => psql(`SELECT status FROM alert_investigations WHERE id = '${invId}'`), { timeout: 60_000 }).toBe('failed')
      const failed = await answerOf(request, admin, TOOL, { alert_id: alert.id, status_only: true })
      expect({ started: failed.started, status: failed.investigation.status, error: failed.error })
        .toEqual({ started: false, status: 'failed', error: psql(`SELECT error FROM alert_investigations WHERE id = '${invId}'`) })
      expect(rowsOf(alert.fingerprint), 'status_only started nothing').toBe('1')

      // While one runs a press starts nothing.
      const running = `inv-e2e-sym1-${run}-r`
      insert(alert, running, { status: `'running'`, started_at: `now() at time zone 'utc'` })
      const held = await answerOf(request, admin, TOOL, { alert_id: alert.id })
      expect({ started: held.started, id: held.investigation.id, status: held.investigation.status, reason: held.investigate_now.reason })
        .toEqual({ started: false, id: running, status: 'running', reason: 'investigating' })
      expect(rowsOf(alert.fingerprint)).toBe('2')

      // A finished one answers its report, and reading it is recorded.
      const report = `## Cause sym1 ${run}`
      psql(`UPDATE alert_investigations SET status = 'done', report = '${report}', model = 'e2e-model', total_tokens = 1234, finished_at = now() at time zone 'utc' WHERE id = '${running}'`)
      const done = await answerOf(request, admin, TOOL, { alert_id: alert.id })
      const detail = await (await request.get(`/api/v1/ai/investigations/${running}`, { headers: bearer(admin) })).json()
      expect({ started: done.started, report: done.report, truncated: done.report_truncated, model: done.model, tokens: done.total_tokens, tools: done.tool_call_count, finished: done.finished_at })
        .toEqual({ started: false, report: detail.report, truncated: false, model: detail.model, tokens: detail.total_tokens, tools: detail.tool_call_count, finished: detail.finished_at })
      expect(done.report).toBe(report)
      expect(rowsOf(alert.fingerprint)).toBe('2')
      await expect.poll(async () => (await auditRows(request, admin, 'ai.investigation.view', since)).filter((r) => r.target === running && r.after.from === 'inbox').map((r) => r.actor), { timeout: 15_000 })
        .toEqual([adminEmail])
    } finally {
      await cleanUp(request, run, alert)
    }
  })

  test('alert_investigate finds the alert by its name in this cluster, and asks when several match', async ({ request }) => {
    const run = Date.now().toString(36)
    const one = await newAlert(request, run, 'Name', { pod: 'web-1' })
    const two = await newAlert(request, run, 'Name', { pod: 'web-2' })
    const lone = await newAlert(request, run, 'Lone')
    try {
      const alertname = one.labels.alertname as string
      const ambiguous = await answerOf(request, admin, TOOL, { alertname })
      expect(ambiguous.status).toBe('ambiguous')
      expect(ambiguous.total).toBe(2)
      expect((ambiguous.alerts as Obj[]).map((a) => a.id).sort()).toEqual([one.id, two.id].sort())
      expect(rowsOf(one.fingerprint), 'nothing started on an ambiguous name').toBe('0')
      expect(rowsOf(two.fingerprint), 'nothing started on an ambiguous name').toBe('0')

      const narrowed = await answerOf(request, admin, TOOL, { alertname, alert_labels: { pod: 'web-2' }, status_only: true })
      expect(narrowed.alert.id).toBe(two.id)

      // The name is exact: this one's name is a part of none of the others', and a part of it matches nothing.
      const exact = await answerOf(request, admin, TOOL, { alertname: lone.labels.alertname, status_only: true })
      expect(exact.alert.id).toBe(lone.id)
      const part = await answerOf(request, admin, TOOL, { alertname: String(lone.labels.alertname).slice(0, -1), status_only: true })
      expect(part.status).toBe('not_found')

      const missing = await answerOf(request, admin, TOOL, { alertname: `E2ESym1Nothing${run}` })
      expect(missing.status).toBe('not_found')
      const noId = await answerOf(request, admin, TOOL, { alert_id: `00000000-0000-4000-8000-${run.padStart(12, '0').slice(-12)}` })
      expect(noId.status).toBe('not_found')

      const noName = await call(request, admin, TOOL, {})
      expect(noName.isError).toBe(true)
      expect(noName.text).toMatch(/alert_id or alertname/)
      const oddId = await call(request, admin, TOOL, { alert_id: '../../ai/mcp' })
      expect(oddId.isError).toBe(true)
      expect(oddId.text).toMatch(/alert_id/)
    } finally {
      await cleanUp(request, run, one, two, lone)
    }
  })

  test("alert_investigate asks what the button asks: Read and Write do not hold it, a role that adds it does", async ({ request }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const since = new Date(Date.now() - 5_000).toISOString()
    const alert = await newAlert(request, run, 'Role')
    try {
      // Read does not hold the tool; Write holds ai.tool.* and is told which permission of the button it lacks.
      for (const [label, role, why] of [['read', 'Read', `${TOOL} is not granted to you`], ['write', 'Write', 'resource.alert.investigate']] as const) {
        const { token } = await user(request, label, role)
        const names = await toolNames(request, token)
        expect(names, `${role}: not offered`).not.toContain(TOOL)
        expect(names, `${role}: the list is`).toContain('clusters_list')
        const refused = await call(request, token, TOOL, { alert_id: alert.id })
        expect(refused.isError, `${role}: refused`).toBe(true)
        expect(refused.text, `${role}: says why`).toContain(why)
      }
      expect(rowsOf(alert.fingerprint), 'nothing was queued').toBe('0')

      const state = (await windowOf(request, admin, alert.id)).investigate_now
      test.skip(['provider_paused', 'manual_off', 'manual_budget'].includes(state?.reason), `the dev install does not let anyone ask now (${state?.reason})`)
      const roleName = await askerRole(request, run)
      const asker = await user(request, 'asker', roleName)
      expect(await toolNames(request, asker.token)).toContain(TOOL)
      const answer = await answerOf(request, asker.token, TOOL, { alert_id: alert.id })
      expect({ started: answer.started, requested_by: answer.investigation.requested_by }).toEqual({ started: true, requested_by: asker.email })
      // No admin screen of reports for this role: the link is the alert window, whose Report button opens it.
      expect(answer.report_link).toBe(answer.alert_link)
      expect(answer.report_link).toContain(`/alerts?alert=${alert.id}&cluster=${INBOX_CLUSTER}`)
      await expect.poll(async () => (await auditRows(request, admin, 'ai.investigation.request', since)).filter((r) => r.target === alert.id).map((r) => ({ actor: r.actor, result: r.result })), { timeout: 15_000 })
        .toEqual([{ actor: asker.email, result: 'success' }])

      // The inbox is not for a grant limited to namespaces.
      const limited = await user(request, 'limited', roleName, ['default'])
      const scoped = await call(request, limited.token, TOOL, { alert_id: alert.id })
      expect(scoped.isError).toBe(true)
      expect(scoped.text).toMatch(/spans the cluster/)
    } finally {
      await cleanUp(request, run, alert)
    }
  })

  test("a spent budget refuses the tool with the window's reason, time and numbers", async ({ request }) => {
    const run = Date.now().toString(36)
    const alert = await newAlert(request, run, 'Budget')
    const spentId = `inv-e2e-sym1-${run}-b`
    try {
      const open = await windowOf(request, admin, alert.id)
      const budget = Number(open.investigate_now?.budget ?? 0)
      test.skip(budget === 0, 'the manual budget is 0 (none) on this install')
      psql(`INSERT INTO alert_investigations (id, cluster, fingerprint, alertname, severity, namespace, received_at, last_seen_at, status, requested_by, total_tokens)
            VALUES ('${spentId}', '${INBOX_CLUSTER}', 'sym1-spent-${run}', 'E2ESym1Spent', 'info', '', now() at time zone 'utc', now() at time zone 'utc', 'done', 'e2e-sym1-${run}@kubeast.local', ${budget})`)
      const shown = (await windowOf(request, admin, alert.id)).investigate_now
      expect(shown.reason).toBe('manual_budget')
      const answer = await answerOf(request, admin, TOOL, { alert_id: alert.id })
      expect({ status: answer.status, code: answer.code, until: answer.until, budget: answer.budget, used: answer.used })
        .toEqual({ status: 'rate_limited', code: 'manual_budget', until: shown.until, budget: shown.budget, used: shown.used })
      expect(rowsOf(alert.fingerprint), 'nothing was queued').toBe('0')
    } finally {
      await cleanUp(request, run, alert)
      psql(`DELETE FROM alert_investigations WHERE id = '${spentId}'`)
    }
  })

  test('list_clusters offers alert_investigate where the feature is on and the token holds the button', async ({ request }) => {
    const features = await (await request.get(`/api/v1/cluster/features?cluster=${INBOX_CLUSTER}`, { headers: bearer(admin) })).json()
    const adminClusters = JSON.parse((await call(request, admin, 'list_clusters', {})).text).clusters as { id: string; tools: string[] }[]
    const self = adminClusters.find((c) => c.id === INBOX_CLUSTER)!
    expect(self.tools.includes(TOOL)).toBe(!!features.alertInvestigation?.enabled)
    expect(self.tools).toContain('clusters_list')

    const { token } = await user(request, 'offer', 'Write')
    const writerClusters = JSON.parse((await call(request, token, 'list_clusters', {})).text).clusters as { id: string; tools: string[] }[]
    const writerSelf = writerClusters.find((c) => c.id === INBOX_CLUSTER)!
    expect(writerSelf.tools).not.toContain(TOOL)
    expect(writerSelf.tools).toContain('clusters_list')
  })
})
