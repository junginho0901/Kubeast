import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// The Admin reads of Kubeast's own records (investigations, ai_models, session_recordings) and an alert window's report
// (alerts_inbox with with_report), called over MCP with no model and held to the API the same screen reads, value by
// value. What the screens keep to themselves stays out: a recording's content is never read, and no model's key or
// address is in an answer. Who gets them is held to the permission each screen asks. clusters_list's time of the last
// check is held to the periodic check it describes.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-adminrecords-pass1!'
const CLUSTER = 'self'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const TOOLS = ['investigations', 'ai_models', 'session_recordings']
const MODEL_STUB = 'http://model-stub.kubeast-devtools.svc.cluster.local:8090/ok'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any

const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-admin-records-')), 'kubeconfig')
fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
const kubectl = (args: string[]) => execFileSync('kubectl', ['--kubeconfig', kc, '--context', 'kind-kubeast', ...args], { encoding: 'utf8' }).trim()
const psql = (sql: string) => kubectl(['-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql])

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const stamp = () => Date.now().toString(36)
const rfc3339 = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const field = (row: Obj, go: string, json: string) => row[go] ?? row[json]
const without = (row: Obj, ...names: string[]) => Object.fromEntries(Object.entries(row).filter(([name]) => !names.includes(name)))

async function login(request: APIRequestContext, email = EMAIL, password = PASSWORD): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function rpc(request: APIRequestContext, token: string, method: string, params?: object): Promise<Obj> {
  const res = await request.post(MCP, { headers: { ...RPC, Authorization: `Bearer ${token}` }, data: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } })
  expect(res.status(), `${method}: ${await res.text()}`).toBe(200)
  return (await res.json()).result
}

async function call(request: APIRequestContext, token: string, name: string, args: object = {}) {
  const result = await rpc(request, token, 'tools/call', { name, arguments: { cluster: CLUSTER, ...args } })
  return { isError: !!result.isError, text: result.content?.[0]?.text as string }
}

async function answer(request: APIRequestContext, token: string, name: string, args: object = {}): Promise<Obj> {
  const res = await call(request, token, name, args)
  expect(res.isError, `${name}: ${res.text}`).toBe(false)
  return JSON.parse(res.text)
}

async function api(request: APIRequestContext, token: string, url: string, params: Record<string, string> = {}): Promise<Obj> {
  const res = await request.get(url, { headers: bearer(token), params })
  expect(res.status(), `${url}: ${await res.text()}`).toBe(200)
  return res.json()
}

async function auditRows(request: APIRequestContext, admin: string, action: string, since: string): Promise<Obj[]> {
  return (await api(request, admin, '/api/v1/auth/admin/audit-logs', { action, since, limit: '100' })).items ?? []
}

async function mcpOn(request: APIRequestContext, token: string): Promise<boolean> {
  const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(token) })
  return config.ok() && !!(await config.json()).enabled
}

async function roleId(request: APIRequestContext, admin: string, name: string): Promise<number> {
  const raw = await api(request, admin, '/api/v1/auth/roles')
  const role = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: Obj) => r.name.toLowerCase() === name.toLowerCase())
  expect(role, `role ${name}`).toBeTruthy()
  return role.id
}

async function makeUser(request: APIRequestContext, admin: string, email: string, globalRole: number, grant: string): Promise<string> {
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E admin records', email, password: PW, role_id: globalRole } })
  expect(res.status(), `create ${email}: ${res.status() === 201 ? '' : await res.text()}`).toBe(201)
  const id = (await res.json()).id as string
  const put = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: grant } })
  expect(put.ok(), `grant ${grant}: ${await put.text()}`).toBeTruthy()
  return id
}

async function toolsOffered(request: APIRequestContext, token: string) {
  const listed = (await rpc(request, token, 'tools/list')).tools.map((t: { name: string }) => t.name) as string[]
  const result = await rpc(request, token, 'tools/call', { name: 'list_clusters', arguments: {} })
  const clusters = JSON.parse(result.content[0].text).clusters as { id: string; tools: string[] }[]
  const here = clusters.find((c) => c.id === CLUSTER)?.tools ?? []
  return { listed: TOOLS.filter((t) => listed.includes(t)), here: TOOLS.filter((t) => here.includes(t)) }
}

test.describe('the AI reads what the Admin screens read of Kubeast\'s own records', () => {
  test('session_recordings: the rows of the API, filtered and paged, and nothing of what the terminal showed', async ({ request }) => {
    test.setTimeout(120_000)
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')

    const run = stamp()
    const ids = [`e2e-p5-rec-${run}-1`, `e2e-p5-rec-${run}-2`]
    const place = `e2e-p5-place-${run}`
    const since = rfc3339(Date.now() - 2_000)
    try {
      psql(`INSERT INTO session_recordings (id, kind, user_email, cluster, namespace, target, container, storage, status, started_at, bytes, uploaded_bytes, parts, truncated, location) VALUES
        ('${ids[0]}', 'exec', 'e2e-p5-${run}@kubeast.local', '${CLUSTER}', 'shop', 'web-1', 'app', 's3', 'uploaded', now() - interval '1 minute', 4096, 4096, 2, false, '${place}'),
        ('${ids[1]}', 'node-shell', 'e2e-p5-${run}@kubeast.local', 'e2e-p5-other-${run}', NULL, 'node-1', NULL, 's3', 'interrupted', now(), 100, 0, 0, true, '${place}')`)
      const route = (params: Record<string, string>) => api(request, admin, '/api/v1/cluster/recordings', { cluster: '', ...params })

      const every = await answer(request, admin, 'session_recordings', { actor_email: `e2e-p5-${run}`, limit: 25 })
      const listed = (await route({ user: `e2e-p5-${run}` })) as Obj[]
      expect(listed.map((r) => r.id)).toEqual([ids[1], ids[0]])
      expect(every.rows).toEqual(listed.map((r) => without(r, 'user_id')))
      expect(every.returned).toBe(2)
      expect(every.next_offset).toBeUndefined()
      expect(every.enabled).toBe((await api(request, admin, '/api/v1/cluster/recordings/config')).enabled)

      const shell = await answer(request, admin, 'session_recordings', { actor_email: `e2e-p5-${run}`, recording_kind: 'node-shell' })
      expect(shell.rows.map((r: Obj) => r.id)).toEqual([ids[1]])
      const here = await answer(request, admin, 'session_recordings', { actor_email: `e2e-p5-${run}`, cluster_id: CLUSTER })
      expect(here.rows.map((r: Obj) => r.id)).toEqual([ids[0]])

      const first = await answer(request, admin, 'session_recordings', { actor_email: `e2e-p5-${run}`, limit: 1 })
      expect(first.rows.map((r: Obj) => r.id)).toEqual([ids[1]])
      expect(first.next_offset).toBe(1)
      const second = await answer(request, admin, 'session_recordings', { actor_email: `e2e-p5-${run}`, limit: 1, offset: 1 })
      expect(second.rows.map((r: Obj) => r.id)).toEqual([ids[0]])
      expect(second.next_offset).toBeUndefined()

      const one = await call(request, admin, 'session_recordings', { recording_id: ids[0] })
      expect(one.isError, one.text).toBe(false)
      const stored = await api(request, admin, `/api/v1/cluster/recordings/${ids[0]}`, { cluster: '' })
      expect(JSON.parse(one.text).recording).toEqual(without(stored, 'user_id'))
      expect(JSON.parse(one.text).note).toContain('Session recordings screen')
      expect(one.text).not.toContain(place)
      expect((await answer(request, admin, 'session_recordings', { recording_id: `e2e-p5-gone-${run}` })).status).toBe('not_found')

      // The tool's own row names the recording, and nothing read its content.
      await expect.poll(async () => {
        const rows = await auditRows(request, admin, 'ai.mcp.call', since)
        const row = rows.find((r) => field(r, 'TargetID', 'target_id') === ids[0])
        return row && [field(row, 'TargetType', 'target_type'), field(row, 'Cluster', 'cluster')]
      }, { timeout: 5_000, message: 'the ai.mcp.call row of the recording' }).toEqual(['session_recording', CLUSTER])
      const viewed = (await auditRows(request, admin, 'admin.session.read', since)).filter((r) => ids.includes(field(r, 'TargetID', 'target_id')))
      expect(viewed).toEqual([])
    } finally {
      psql(`DELETE FROM session_recordings WHERE id IN ('${ids[0]}', '${ids[1]}')`)
    }
  })

  test('investigations: the list of the API, every report value for value, and opening one is recorded', async ({ request }) => {
    test.setTimeout(120_000)
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')

    const run = stamp()
    const cluster = `e2e-p5-c-${run}`
    const ids = [`inv-e2e-p5-${run}-1`, `inv-e2e-p5-${run}-2`]
    const since = rfc3339(Date.now() - 2_000)
    try {
      // Two hours old and without tokens, in a cluster of the run: outside the investigator's caps and the other reports' pages.
      psql(`INSERT INTO alert_investigations (id, cluster, fingerprint, alertname, severity, namespace, status, skip_reason, labels, annotations, received_at, last_seen_at, iterations, tool_calls, report, error, provider, model, requested_by) VALUES
        ('${ids[0]}', '${cluster}', 'fp-1', 'E2eP5Done', 'warning', 'shop', 'done', '', '{"pod":"web-1"}', '{"summary":"load"}', now() at time zone 'utc' - interval '2 hours', now() at time zone 'utc' - interval '2 hours', 2,
         '[{"tool":"k8s_get_resources","args":{"resource_type":"pods"},"step":1,"result_chars":10}]', 'The load comes from web-1 ${run}.', '', 'stub', 'small', ''),
        ('${ids[1]}', '${cluster}', 'fp-2', 'E2eP5Skipped', 'info', '', 'skipped', 'hourly cap (6 per hour)', '{}', '{}', now() at time zone 'utc' - interval '3 hours', now() at time zone 'utc' - interval '3 hours', 0,
         '[]', '', '', '', '', '')`)

      const route = (params: Record<string, string>) => api(request, admin, '/api/v1/ai/investigations', { cluster: '', ...params })
      const page = await answer(request, admin, 'investigations', { cluster_id: cluster })
      const listed = await route({ cluster, limit: '25', offset: '0' })
      expect(listed.items.map((r: Obj) => r.id)).toEqual(ids)
      expect(page.rows).toEqual(listed.items.map((r: Obj) => without(r, 'skip_reason_key', 'skip_reason_args')))
      expect(page.total).toBe(listed.total)
      expect(page.cluster_filter).toBe(cluster)

      const skipped = await answer(request, admin, 'investigations', { cluster_id: cluster, status: 'skipped' })
      expect(skipped.rows.map((r: Obj) => r.id)).toEqual([ids[1]])
      expect(skipped.rows[0].skip_reason).toBe('hourly cap (6 per hour)')
      const firstPage = await answer(request, admin, 'investigations', { cluster_id: cluster, limit: 1 })
      expect(firstPage.next_offset).toBe(1)
      const nothing = await answer(request, admin, 'investigations', { cluster_id: `${cluster}-none` })
      expect(nothing.total).toBe(0)
      expect(nothing.rows).toEqual([])

      // Of every cluster until one is asked, as the screen lists them.
      await expect.poll(async () => {
        const [tool, screen] = await Promise.all([answer(request, admin, 'investigations', { limit: 1 }), route({ limit: '1' })])
        return tool.total === screen.total
      }, { timeout: 15_000, message: 'the total of every cluster' }).toBe(true)

      const opened = await answer(request, admin, 'investigations', { investigation_id: ids[0] })
      const stored = await api(request, admin, `/api/v1/ai/investigations/${ids[0]}`, { cluster: '' })
      expect(stored.report).toContain(run)
      expect(opened).toEqual(without(stored, 'skip_reason_key', 'skip_reason_args'))
      expect((await answer(request, admin, 'investigations', { investigation_id: `inv-e2e-p5-gone-${run}` })).status).toBe('not_found')

      // The route's own row, marked as read by a tool, beside the tool's.
      await expect.poll(async () => {
        const rows = await auditRows(request, admin, 'ai.investigation.view', since)
        return rows.filter((r) => field(r, 'TargetID', 'target_id') === ids[0] && field(r, 'UserAgent', 'user_agent') === 'kubeast-tool-server').length
      }, { timeout: 5_000, message: 'the ai.investigation.view row of the tool read' }).toBe(1)
      await expect.poll(async () => {
        const rows = await auditRows(request, admin, 'ai.mcp.call', since)
        const row = rows.find((r) => field(r, 'TargetID', 'target_id') === ids[0])
        return row && field(row, 'TargetType', 'target_type')
      }, { timeout: 5_000, message: 'the ai.mcp.call row of the report' }).toBe('investigation')
    } finally {
      psql(`DELETE FROM alert_investigations WHERE id IN ('${ids[0]}', '${ids[1]}')`)
    }
  })

  test('alerts_inbox with_report: the report the alert window opens, for whoever reads the inbox, and only when asked', async ({ request }) => {
    test.setTimeout(120_000)
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    const features = await api(request, admin, '/api/v1/cluster/features')
    test.skip(!features.alertInvestigation?.enabled, 'alert investigation (the webhook and the inbox) is off')

    const run = stamp()
    const fingerprint = `p5-report-${run}`
    const invId = `inv-e2e-p5-report-${run}`
    const email = `e2e-adminrecords-inbox-${run}@kubeast.local`
    const labels = { alertname: `E2EP5Report${run}`, severity: 'info', namespace: `E2E_P5_${run}` }
    const token = Buffer.from(kubectl(['-n', 'kubeast', 'get', 'secret', 'kubeast-secrets', '-o', 'jsonpath={.data.ALERT_WEBHOOK_TOKEN}']), 'base64').toString()
    const post = (status: string) => request.post(`/api/v1/alerts/webhook?cluster=${CLUSTER}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        version: '4', groupKey: `{}:{alertname="${labels.alertname}"}`, status, receiver: 'kubeast', externalURL: 'http://alertmanager.e2e:9093',
        alerts: [{ status, labels, annotations: { summary: 'p5 report' }, startsAt: new Date(Date.now() - 3 * 60_000).toISOString(), fingerprint }],
      },
    })
    let userId = ''
    try {
      expect((await (await post('firing')).json()).stored).toBe(1)
      const list = await api(request, admin, '/api/v1/alerts/inbox', { cluster: CLUSTER, q: run, limit: '50' })
      const item = (list.items as Obj[]).find((i) => i.fingerprint === fingerprint)
      expect(item, 'its inbox row').toBeTruthy()

      const none = await answer(request, admin, 'alerts_inbox', { alert_id: item.id, with_report: true })
      expect(none.report_error).toContain('no investigation')
      expect(none.investigation_report).toBeUndefined()

      psql(`INSERT INTO alert_investigations (id, cluster, fingerprint, alertname, severity, namespace, status, labels, annotations, received_at, last_seen_at, iterations, tool_calls, report, error, provider, model, requested_by)
            VALUES ('${invId}', '${CLUSTER}', '${fingerprint}', '${labels.alertname}', 'info', '${labels.namespace}', 'done', '{}', '{}', now() at time zone 'utc', now() at time zone 'utc', 1,
                    '[{"tool":"k8s_get_events","args":{},"step":1}]', 'What it found ${run}.', '', 'stub', 'small', '')`)

      // A Read grant reads the inbox, as on the screen, and holds neither admin.investigations.read nor the button's permission.
      userId = await makeUser(request, admin, email, await roleId(request, admin, 'Member'), 'Read')
      const reader = await login(request, email, PW)
      const since = rfc3339(Date.now() - 2_000)
      const plain = await answer(request, reader, 'alerts_inbox', { alert_id: item.id })
      expect(plain.investigation_report).toBeUndefined()
      expect(plain.investigation.id).toBe(invId)
      const viewsBefore = (await auditRows(request, admin, 'ai.investigation.view', since)).filter((r) => field(r, 'TargetID', 'target_id') === invId)
      expect(viewsBefore).toEqual([])

      const read = await answer(request, reader, 'alerts_inbox', { alert_id: item.id, with_report: true })
      const route = await api(request, reader, `/api/v1/alerts/inbox/${item.id}/investigation`)
      expect(route.report).toContain(run)
      expect(read.investigation_report).toEqual(without(route, 'skip_reason_key', 'skip_reason_args'))

      await expect.poll(async () => {
        const rows = await auditRows(request, admin, 'ai.investigation.view', since)
        return rows.filter((r) => field(r, 'TargetID', 'target_id') === invId && field(r, 'UserAgent', 'user_agent') === 'kubeast-tool-server' && field(r, 'ActorEmail', 'actor_email') === email).length
      }, { timeout: 5_000, message: 'the ai.investigation.view row of the tool read' }).toBe(1)
    } finally {
      await post('resolved')
      psql(`DELETE FROM alert_investigations WHERE id = '${invId}'`)
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('ai_models: name, provider, use and limits of the API, and no key, address, header or certificate', async ({ request }) => {
    test.setTimeout(120_000)
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')

    const run = stamp()
    const name = `e2e-p5-model-${run}`
    const secrets = { headerName: `X-E2e-P5-${run}`, keyEnv: `KUBEAST_AI_KEY_E2E_P5_${run.toUpperCase()}`, modelAddress: `${MODEL_STUB}` }
    // Off, so nothing runs on it: only the fields its row must and must not carry matter here.
    const made = await request.post('/api/v1/ai/model-configs', {
      headers: bearer(admin),
      data: {
        name, provider: 'openai', model: 'stub-small', base_url: secrets.modelAddress, api_key_env: secrets.keyEnv, extra_headers: { [secrets.headerName]: 'e2e' },
        enabled: false, is_default: false, tier: 'economy', options: { max_tokens: 1234, tool_result_chars: 5000, temperature: 0.1 },
      },
    })
    test.skip(!made.ok(), `the dev install does not take this model (${made.status()}): deploy/kind/devtools.yaml and ai.baseUrlAllowedHosts`)
    const id = (await made.json()).id as number
    try {
      const res = await call(request, admin, 'ai_models')
      expect(res.isError, res.text).toBe(false)
      const models = JSON.parse(res.text)
      const configs = (await api(request, admin, '/api/v1/ai/model-configs')) as Obj[]
      expect(models.total).toBe(configs.length)
      // key_env_set as the card draws it: the variable beside a key, "No key env" without one, nothing where the provider takes none.
      expect(models.rows).toEqual(configs.map((c) => ({
        id: c.id, name: c.name, provider: c.provider, model: c.model, enabled: c.enabled, is_default: c.is_default, tier: c.tier, used_for: c.used_for,
        key_env_set: c.api_key_env ? true : c.provider === 'ollama' ? null : false,
        max_tokens: c.options?.max_tokens ?? null, tool_result_chars: c.options?.tool_result_chars ?? null,
      })))
      const mine = (models.rows as Obj[]).find((r) => r.id === id)
      expect(mine).toMatchObject({ name, key_env_set: true, max_tokens: 1234, tool_result_chars: 5000, enabled: false, used_for: [] })

      // The Active badge's model: the row the chat runs on.
      const chat = configs.find((c) => (c.used_for ?? []).includes('chat'))
      expect(models.active ?? null).toBe(chat?.name ?? null)
      expect(models.providers).toEqual(Object.fromEntries(Object.entries((await api(request, admin, '/api/v1/ai/model-configs/providers')).providers).map(([key, value]: [string, Obj]) => [key, { available: value.available, ...(value.reason === undefined ? {} : { reason: value.reason }) }])))

      for (const held of [secrets.headerName, secrets.keyEnv, secrets.modelAddress, 'api_key', 'base_url', 'extra_headers', 'ca_cert', 'temperature']) {
        expect(res.text.includes(held), `the answer holds ${held}`).toBe(false)
      }
    } finally {
      await request.delete(`/api/v1/ai/model-configs/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('who gets them: only the permission of the screen opens a tool, on both lists and on the call', async ({ request }) => {
    test.setTimeout(120_000)
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')

    const s = stamp()
    const users: string[] = []
    const roles: number[] = []
    try {
      // A Read grant holds ai.mcp.use and the read tools, none of these.
      const readerEmail = `e2e-adminrecords-r-${s}@kubeast.local`
      users.push(await makeUser(request, admin, readerEmail, await roleId(request, admin, 'Member'), 'Read'))
      const reader = await login(request, readerEmail, PW)
      expect(await toolsOffered(request, reader)).toEqual({ listed: [], here: [] })
      for (const tool of TOOLS) {
        const refused = await call(request, reader, tool)
        expect(refused.isError, `${tool}: ${refused.text}`).toBe(true)
      }

      // A Write grant holds ai.tool.*; the admin.* permission of one screen, in the global role, opens that screen's tool only.
      for (const [permission, tool] of [
        ['admin.investigations.read', 'investigations'],
        ['admin.ai_models.*', 'ai_models'],
        ['admin.sessions.read', 'session_recordings'],
      ] as [string, string][]) {
        const name = `e2e-adminrecords-${permission.replace(/\.\*$/, '').replace(/[._]/g, '-')}-${s}`
        const made = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name, description: 'e2e', permissions: [permission] } })
        expect(made.status(), await made.text()).toBeLessThan(300)
        const role = (await made.json()).id as number
        roles.push(role)
        const email = `${name}@kubeast.local`
        users.push(await makeUser(request, admin, email, role, 'Write'))
        const token = await login(request, email, PW)
        expect(await toolsOffered(request, token), permission).toEqual({ listed: [tool], here: [tool] })
        for (const other of TOOLS.filter((t) => t !== tool)) {
          const refused = await call(request, token, other)
          expect(refused.isError, `${permission} calling ${other}: ${refused.text}`).toBe(true)
        }
        const ran = await call(request, token, tool)
        expect(ran.isError, `${permission} calling ${tool}: ${ran.text}`).toBe(false)
        expect(JSON.parse(ran.text).status, `${permission} calling ${tool}`).not.toBe('forbidden')
      }

      // The admin holds all of them.
      expect(await toolsOffered(request, admin)).toEqual({ listed: TOOLS, here: TOOLS })
    } finally {
      for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
      for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('clusters_list: the time of the last check moves by itself, as the tool says', async ({ request }) => {
    test.setTimeout(240_000)
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')

    const self = async () => (await answer(request, admin, 'clusters_list')).clusters.find((c: Obj) => c.id === CLUSTER)
    const first = await self()
    expect(first.health_status).toBe('healthy')
    const seen = first.last_healthcheck_at as string
    expect(seen, 'the checker has run').toBeTruthy()
    // Two periods of the default 60 seconds, with nobody pressing Test.
    await expect.poll(async () => (await self()).last_healthcheck_at as string, { timeout: 150_000, intervals: [10_000], message: 'last_healthcheck_at' }).not.toBe(seen)
  })
})
