import { test, expect, type APIRequestContext } from '@playwright/test'

// The Admin reads of what spans Kubeast (access_review, ai_usage, access_requests, audit_integrity) and a cluster's
// hygiene sign-offs (hygiene_history), called over MCP with no model and held to the API the same screen reads, value
// by value, page by page. Who gets them is held to the permission that screen asks, on every list and on the call.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-adminreads-pass1!'
const CLUSTER = 'self'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const TOOLS = ['access_review', 'ai_usage', 'access_requests', 'audit_integrity', 'hygiene_history']

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const stamp = () => Date.now().toString(36)
const rfc3339 = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

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

// Every page of a tool's rows, each page saying the same total; the text of the pages too, to look for what must not be there.
async function everyRow(request: APIRequestContext, token: string, name: string, args: object) {
  const rows: Obj[] = []
  const pages: string[] = []
  let offset = 0
  let total = -1
  for (;;) {
    const res = await call(request, token, name, { ...args, limit: 200, offset })
    expect(res.isError, `${name}: ${res.text}`).toBe(false)
    pages.push(res.text)
    const page = JSON.parse(res.text)
    if (total >= 0) expect(page.total).toBe(total)
    total = page.total
    expect(page.offset).toBe(offset)
    expect(page.returned).toBe(page.rows.length)
    rows.push(...page.rows)
    if (page.next_offset === undefined) break
    expect(page.next_offset).toBe(offset + page.rows.length)
    offset = page.next_offset
  }
  expect(rows.length).toBe(total)
  return { rows, total, text: pages.join('\n') }
}

async function api(request: APIRequestContext, token: string, path: string): Promise<{ body: Obj; total: string | undefined }> {
  const res = await request.get(path, { headers: bearer(token) })
  expect(res.status(), `${path}: ${await res.text()}`).toBe(200)
  return { body: await res.json(), total: res.headers()['x-kubeast-total'] }
}

async function auditRows(request: APIRequestContext, admin: string, action: string, since: string): Promise<Obj[]> {
  const q = new URLSearchParams({ action, actor_email: EMAIL, since, limit: '50' })
  return (await api(request, admin, `/api/v1/auth/admin/audit-logs?${q}`)).body.items ?? []
}

const field = (row: Obj, go: string, json: string) => row[go] ?? row[json]

// One read through a tool leaves the row of the tool call, on the cluster it was routed to, and this reads what the route itself wrote.
async function expectToolCallRow(request: APIRequestContext, admin: string, tool: string, since: string) {
  await expect.poll(async () => {
    const rows = await auditRows(request, admin, 'ai.mcp.call', since)
    return rows.filter((r) => field(r, 'TargetID', 'target_id') === tool).map((r) => field(r, 'Cluster', 'cluster'))[0]
  }, { timeout: 5_000, message: `the ai.mcp.call row of ${tool}` }).toBe(CLUSTER)
}

async function mcpOn(request: APIRequestContext, token: string): Promise<boolean> {
  const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(token) })
  return config.ok() && !!(await config.json()).enabled
}

async function roleId(request: APIRequestContext, admin: string, name: string): Promise<number> {
  const raw = (await api(request, admin, '/api/v1/auth/roles')).body
  const role = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: Obj) => r.name.toLowerCase() === name.toLowerCase())
  expect(role, `role ${name}`).toBeTruthy()
  return role.id
}

async function makeUser(request: APIRequestContext, admin: string, email: string, globalRole: number, grant: string): Promise<string> {
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E admin reads', email, password: PW, role_id: globalRole } })
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

test.describe('the AI reads what the Admin screens read', () => {
  test('access_review: the cards, every section, the search and the past sign-offs are the report the screen reads', async ({ request }) => {
    test.setTimeout(120_000)
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    const config = (await api(request, admin, '/api/v1/auth/access-review/config')).body
    test.skip(!config.enabled, 'access review is off (auth.accessReview.enabled)')

    const s = stamp()
    const started = rfc3339(Date.now() - 1000)
    const keyName = `e2e-adminreads-${s}`
    const made = await request.post('/api/v1/auth/api-keys', { headers: bearer(admin), data: { name: keyName, expires_in_days: 1, cluster_ids: [CLUSTER], role_ceiling: 'Read' } })
    expect(made.status(), await made.text()).toBe(201)
    const key = await made.json()
    try {
      // One window for both: without it a report with no sign-off yet counts from the moment it is read.
      const since = rfc3339(Date.now() - 60 * 60 * 1000)
      const report = (await api(request, admin, `/api/v1/auth/admin/access-review?since=${since}`)).body

      const summary = await answer(request, admin, 'access_review', { since_time: since })
      expect(summary.section).toBe('summary')
      expect(summary.summary).toEqual(report.summary)
      expect(summary.settings).toEqual(report.settings)
      expect(summary.last_review).toEqual(report.last_review)
      expect(summary.since).toBe(report.since)
      expect(summary.overdue).toBe(report.overdue)
      expect(summary.next_due_at).toEqual(report.next_due_at)
      expect(summary.sections).toEqual({
        users: report.users.length,
        cluster_roles: report.cluster_roles.length,
        api_keys: report.api_keys.length,
        api_keys_expired: report.api_keys.filter((k: Obj) => k.flags.includes('expired')).length,
        access_requests: report.access_requests.length,
        access_requests_total: report.access_requests_total,
        roles: report.roles.length,
      })

      let everyText = ''
      for (const section of ['users', 'cluster_roles', 'api_keys', 'access_requests', 'roles']) {
        const { rows, total, text } = await everyRow(request, admin, 'access_review', { review_section: section, since_time: since })
        expect(rows, section).toEqual(report[section])
        expect(total, section).toBe(report[section].length)
        everyText += text
      }
      // The key of this run is listed by what a list shows of it, and its value is nowhere.
      expect(typeof key.key).toBe('string')
      expect(key.key.startsWith(key.key_prefix)).toBe(true)
      expect(everyText).not.toContain(key.key)
      const found = await answer(request, admin, 'access_review', { review_section: 'api_keys', search: keyName, since_time: since })
      expect(found.total).toBe(1)
      expect(found.rows[0].name).toBe(keyName)
      expect(found.rows[0].key_prefix).toBe(key.key_prefix)
      expect(Object.keys(found.rows[0])).not.toContain('key')

      // A global admin has no grant row: the answer counts them.
      const grants = await answer(request, admin, 'access_review', { review_section: 'cluster_roles', since_time: since })
      expect(grants.full_admins).toBe(report.summary.full_admins)
      expect(grants.note).toContain('every cluster')

      // The read is the route's own row, Kubeast-wide so with no cluster, beside the row of the tool call.
      const reads = (await auditRows(request, admin, 'admin.review.read', started)).filter((r) => field(r, 'TargetType', 'target_type') === 'access-review')
      expect(reads.length).toBeGreaterThan(0)
      for (const row of reads) expect(field(row, 'Cluster', 'cluster') ?? '').toBe('')
      await expectToolCallRow(request, admin, 'access_review', started)

      // A sign-off made by hand: listed first with the server's total, and opened as the report it stored.
      const signed = await request.post('/api/v1/auth/admin/access-review/signoff', { headers: bearer(admin), data: { note: `e2e admin reads ${s}` } })
      expect(signed.status(), await signed.text()).toBe(201)
      const signoff = await signed.json()
      const pastPage = await api(request, admin, '/api/v1/auth/admin/access-review/history?limit=25&offset=0')
      const past = await answer(request, admin, 'access_review', { review_section: 'history' })
      expect(past.section).toBe('history')
      expect(String(past.total)).toBe(pastPage.total)
      expect(pastPage.body[0].id).toBe(signoff.id)
      expect(past.rows[0]).toEqual({ id: signoff.id, reviewed_by_email: pastPage.body[0].reviewed_by_email, reviewed_at: pastPage.body[0].reviewed_at, note: `e2e admin reads ${s}`, counts: pastPage.body[0].counts })
      expect(past.rows.map((r: Obj) => r.id)).toEqual(pastPage.body.map((r: Obj) => r.id))

      const stored = (await api(request, admin, `/api/v1/auth/admin/access-review/history/${signoff.id}`)).body
      const opened = await answer(request, admin, 'access_review', { review_id: signoff.id })
      expect(opened.signed_off).toEqual({ id: stored.id, reviewed_by_email: stored.reviewed_by_email, reviewed_at: stored.reviewed_at, note: stored.note })
      expect(opened.summary).toEqual(stored.snapshot.summary)
      const openedUsers = await everyRow(request, admin, 'access_review', { review_id: signoff.id, review_section: 'users' })
      expect(openedUsers.rows).toEqual(stored.snapshot.users)

      const gone = await answer(request, admin, 'access_review', { review_id: 'no-such-review' })
      expect(gone.status).toBe('not_found')
      expect(gone.hint).toContain('review_section=history')
    } finally {
      await request.delete(`/api/v1/auth/api-keys/${key.id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('ai_usage: every grouping answers the rows, totals and cut of the API for the same period', async ({ request }) => {
    test.setTimeout(120_000)
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')

    // The period ends before this test's own calls, so an investigation finishing meanwhile does not move the numbers.
    const until = rfc3339(Date.now())
    const since = rfc3339(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const started = rfc3339(Date.now() - 1000)
    for (const group of ['user', 'model', 'cluster']) {
      const q = new URLSearchParams({ since, until, group })
      const usage = (await api(request, admin, `/api/v1/auth/admin/ai-usage?${q}`)).body
      const args = { usage_group: group, since_time: since, until_time: until }
      const { rows, total } = await everyRow(request, admin, 'ai_usage', args)
      expect(rows, group).toEqual(usage.rows)
      expect(total, group).toBe(usage.rows.length)
      const first = await answer(request, admin, 'ai_usage', args)
      expect(first.group).toBe(group)
      expect(first.since).toBe(usage.since)
      expect(first.until).toBe(usage.until)
      expect(first.totals).toEqual(usage.totals)
      expect(first.truncated).toBe(usage.truncated)
      expect(first.listed_limit).toBe(usage.limit)
      const cuts = ['chat', 'investigation'].filter((source) => usage.totals[source].truncated).map((source) => ({ source, shown: usage.totals[source].rows, groups: usage.totals[source].groups }))
      expect(first.cuts ?? []).toEqual(cuts)
      expect(first.partial_tokens !== undefined).toBe(usage.rows.some((r: Obj) => r.token_requests < r.requests))
    }

    const reads = (await auditRows(request, admin, 'admin.audit.read', started)).filter((r) => field(r, 'TargetType', 'target_type') === 'ai-usage')
    expect(reads.length).toBeGreaterThan(0)
    for (const row of reads) expect(field(row, 'Cluster', 'cluster') ?? '').toBe('')
    await expectToolCallRow(request, admin, 'ai_usage', started)

    const refused = await call(request, admin, 'ai_usage', { usage_group: 'team' })
    expect(refused.isError).toBe(true)
  })

  test('access_requests: the pending and decided tabs are the API pages, and reading one decides nothing', async ({ request }) => {
    test.setTimeout(120_000)
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    const config = (await api(request, admin, '/api/v1/auth/access-requests/config')).body
    test.skip(!config.enabled, 'access requests are off (auth.accessRequests.enabled)')

    const s = stamp()
    const email = `e2e-adminreads-rq-${s}@kubeast.local`
    const reason = `e2e admin reads ${s}`
    let userId = ''
    try {
      userId = await makeUser(request, admin, email, await roleId(request, admin, 'Member'), 'Read')
      const user = await login(request, email, PW)
      const filed = await request.post('/api/v1/auth/access-requests', { headers: bearer(user), data: { cluster_id: CLUSTER, role: 'Write', duration_minutes: 30, reason } })
      expect(filed.status(), await filed.text()).toBe(201)
      const id = (await filed.json()).id as string
      // What the screen shows of a row, without the ids it does not.
      const shown = ({ user_id: _user, decided_by: _decider, ...row }: Obj) => row

      const pending = await api(request, admin, '/api/v1/auth/admin/access-requests?status=pending&limit=25&offset=0')
      const tab = await answer(request, admin, 'access_requests')
      expect(tab.status).toBe('pending')
      expect(tab.enabled).toBe(true)
      expect(String(tab.total)).toBe(pending.total)
      expect(tab.rows).toEqual(pending.body.map(shown))

      const q = new URLSearchParams({ status: 'pending', q: reason, limit: '25', offset: '0' })
      const searched = await api(request, admin, `/api/v1/auth/admin/access-requests?${q}`)
      expect(searched.total).toBe('1')
      const mine = await answer(request, admin, 'access_requests', { search: reason })
      expect(mine.total).toBe(1)
      expect(mine.rows).toEqual(searched.body.map(shown))
      expect(mine.rows[0]).toMatchObject({ id, user_email: email, role: 'Write', duration_minutes: 30, reason, status: 'pending' })

      // Reading it left it pending and granted nothing.
      const still = await api(request, admin, `/api/v1/auth/admin/access-requests?${q}`)
      expect(still.body[0].status).toBe('pending')
      const grants = (await api(request, admin, `/api/v1/auth/admin/users/${userId}/cluster-roles`)).body
      expect(grants[CLUSTER]).toBe('Read')

      const rejected = await request.post(`/api/v1/auth/admin/access-requests/${id}/reject`, { headers: bearer(admin), data: { note: `no ${s}` } })
      expect(rejected.status(), await rejected.text()).toBe(200)
      expect((await answer(request, admin, 'access_requests', { search: reason })).total).toBe(0)
      const decidedQ = new URLSearchParams({ status: 'decided', q: reason, limit: '25', offset: '0' })
      const decidedApi = await api(request, admin, `/api/v1/auth/admin/access-requests?${decidedQ}`)
      const decided = await answer(request, admin, 'access_requests', { status: 'decided', search: reason })
      expect(decided.total).toBe(1)
      expect(decided.rows).toEqual(decidedApi.body.map(shown))
      expect(decided.rows[0]).toMatchObject({ status: 'rejected', decision_note: `no ${s}`, decided_by_email: EMAIL })

      const page = await answer(request, admin, 'access_requests', { status: 'decided', limit: 1 })
      const wholeTab = await api(request, admin, '/api/v1/auth/admin/access-requests?status=decided&limit=1&offset=0')
      expect(String(page.total)).toBe(wholeTab.total)
      expect(page.rows).toEqual(wholeTab.body.map(shown))

      const bad = await call(request, admin, 'access_requests', { status: 'denied' })
      expect(bad.isError).toBe(true)
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('audit_integrity: the chain state of the API, without running a verification', async ({ request }) => {
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    const started = rfc3339(Date.now() - 1000)

    // The sealer moves on while this reads, so the tool's number lies between two reads of the API.
    const before = (await api(request, admin, '/api/v1/auth/admin/audit/integrity')).body
    const state = await answer(request, admin, 'audit_integrity')
    const after = (await api(request, admin, '/api/v1/auth/admin/audit/integrity')).body
    expect(state.enabled).toBe(before.enabled)
    if (!before.enabled) {
      expect(state.note).toContain('audit.integrity.enabled')
      expect(state.sealed_through_seq).toBeUndefined()
      return
    }
    expect(state.sealed_through_seq).toBeGreaterThanOrEqual(before.sealed_through_seq)
    expect(state.sealed_through_seq).toBeLessThanOrEqual(after.sealed_through_seq)
    expect(state.oldest_seq).toBe(before.oldest_seq)
    expect(state.seal_seconds).toBe(before.seal_seconds)
    expect(state.anchor_sink).toBe(before.anchor_sink)
    expect(state.anchor_hours).toBe(before.anchor_hours)
    expect(state.last_anchor).toEqual(after.last_anchor)
    expect(state.note).toContain('does not check')
    expect(await auditRows(request, admin, 'admin.audit.verify', started)).toEqual([])
  })

  test('hygiene_history: the sign-offs of the API, and the report one stored', async ({ request }) => {
    test.setTimeout(180_000)
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    const config = (await api(request, admin, `/api/v1/cluster/hygiene/config?cluster=${CLUSTER}`)).body
    test.skip(!config.enabled, 'the hygiene report is off (features.hygiene.enabled)')

    const note = `e2e admin reads ${stamp()}`
    const signed = await request.post(`/api/v1/cluster/hygiene/signoff?cluster=${CLUSTER}`, { headers: bearer(admin), data: { note }, timeout: 120_000 })
    expect(signed.status(), await signed.text()).toBe(201)
    const signoff = await signed.json()

    const listed = (await api(request, admin, `/api/v1/cluster/hygiene/history?cluster=${CLUSTER}`)).body as Obj[]
    const history = await answer(request, admin, 'hygiene_history')
    expect(history.cluster).toBe(CLUSTER)
    expect(history.returned).toBe(listed.length)
    expect(history.rows).toEqual(listed.map(({ reviewed_by: _by, ...row }: Obj) => row))
    expect(history.rows[0].id).toBe(signoff.id)
    expect(history.rows[0].note).toBe(note)
    expect(history.truncated === true).toBe(listed.length >= 100)

    const stored = (await api(request, admin, `/api/v1/cluster/hygiene/snapshot/${signoff.id}?cluster=${CLUSTER}`)).body
    const opened = await answer(request, admin, 'hygiene_history', { review_id: signoff.id })
    expect(opened.signed_off.note).toBe(note)
    expect(opened.signed_off.counts).toEqual(stored.counts)
    expect(opened.report.counts).toEqual(stored.snapshot.report.counts)
    expect(opened.report.findings_total).toBe(stored.snapshot.report.findings.length)
    expect(opened.report.findings).toEqual(stored.snapshot.report.findings.slice(0, 200))

    const critical = await answer(request, admin, 'hygiene_history', { review_id: signoff.id, severity: 'critical' })
    expect(critical.report.findings_total).toBe(stored.snapshot.report.findings.filter((f: Obj) => f.severity === 'critical').length)

    const gone = await answer(request, admin, 'hygiene_history', { review_id: 'no-such-review' })
    expect(gone.status).toBe('not_found')
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
      const readerEmail = `e2e-adminreads-r-${s}@kubeast.local`
      users.push(await makeUser(request, admin, readerEmail, await roleId(request, admin, 'Member'), 'Read'))
      const reader = await login(request, readerEmail, PW)
      expect(await toolsOffered(request, reader)).toEqual({ listed: [], here: [] })
      for (const tool of TOOLS) {
        const refused = await call(request, reader, tool)
        expect(refused.isError, `${tool}: ${refused.text}`).toBe(true)
      }

      // A Write grant holds ai.tool.*; the admin.* permission of one screen, in the global role, opens that screen's tool only.
      for (const [permission, tools] of [
        ['admin.review.read', ['access_review']],
        ['admin.audit.read', ['ai_usage', 'audit_integrity']],
        ['admin.users.update', ['access_requests']],
        ['admin.hygiene.read', ['hygiene_history']],
      ] as [string, string[]][]) {
        const name = `e2e-adminreads-${permission.replace(/\./g, '-')}-${s}`
        const made = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name, description: 'e2e', permissions: [permission] } })
        expect(made.status(), await made.text()).toBeLessThan(300)
        const role = (await made.json()).id as number
        roles.push(role)
        const email = `${name}@kubeast.local`
        users.push(await makeUser(request, admin, email, role, 'Write'))
        const token = await login(request, email, PW)
        expect(await toolsOffered(request, token), permission).toEqual({ listed: tools, here: tools })
        for (const tool of TOOLS.filter((t) => !tools.includes(t))) {
          const refused = await call(request, token, tool)
          expect(refused.isError, `${permission} calling ${tool}: ${refused.text}`).toBe(true)
        }
        for (const tool of tools) {
          const ran = await call(request, token, tool)
          expect(ran.isError, `${permission} calling ${tool}: ${ran.text}`).toBe(false)
          expect(JSON.parse(ran.text).status, `${permission} calling ${tool}`).not.toBe('forbidden')
        }
      }

      // The admin holds all of them.
      expect(await toolsOffered(request, admin)).toEqual({ listed: TOOLS, here: TOOLS })
    } finally {
      for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
      for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
