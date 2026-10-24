import { test, expect, type APIRequestContext } from '@playwright/test'

// Each AI tool call names the identity it reached the cluster as — the impersonation user and groups the service
// that called the cluster sent, the Kubeast role and scope behind them, read or write — in its audit row
// (after.access) and as the 🔐 line of the chat's tool block. The MCP endpoint drives exact calls as a Read user and
// a namespace-limited one; k8s-service answers the same identity in X-Kubeast-Access; a call refused before the
// cluster carries none. The chat case asks the dev model for one read and checks the line live and after a reload.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-access-pass1!'
const CLUSTER = 'self'
const NS = 'default'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

type Access = { cluster: string; kind: string; user?: string; groups?: string[]; role?: string; namespaces?: string[]; impersonation: boolean; mode?: string }

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function mcpCall(request: APIRequestContext, token: string, name: string, args: Record<string, unknown>) {
  const res = await request.post(MCP, {
    headers: { ...RPC, Authorization: `Bearer ${token}` },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    failOnStatusCode: false,
  })
  expect(res.status(), `${name}: ${await res.text()}`).toBe(200)
  return (await res.json()).result as { isError?: boolean; content?: { text: string }[] }
}

async function mcpRows(request: APIRequestContext, admin: string, email: string) {
  const res = await request.get('/api/v1/auth/admin/audit-logs?action=ai.mcp.call&limit=100', { headers: bearer(admin) })
  expect(res.ok()).toBeTruthy()
  return (((await res.json()).items ?? []) as any[]).filter((r) => (r.ActorEmail ?? r.actor_email) === email).map((r) => r.After ?? r.after)
}

function decodeAccess(header: string | undefined): Access {
  expect(header, 'X-Kubeast-Access header').toBeTruthy()
  return JSON.parse(Buffer.from(header as string, 'base64url').toString('utf8'))
}

test.describe('AI tool access trail', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)
  const id = Date.now().toString(36)
  const userIds: string[] = []
  let admin = ''
  let mcpOn = false
  const people: Record<string, { email: string; token: string }> = {}

  async function user(request: APIRequestContext, name: string, grant: object) {
    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const email = `e2e-access-${name}-${id}@kubeast.local`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E access ${name}`, email, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    userIds.push(userId)
    const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: grant })
    expect(put.ok(), await put.text()).toBeTruthy()
    people[name] = { email, token: await login(request, email, PW) }
  }

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const config = await request.get('/api/v1/ai/mcp/config', { headers: bearer(admin) })
    mcpOn = config.ok() && (await config.json()).enabled
    await user(request, 'read', { role: 'Read' })
    await user(request, 'scoped', { role: 'Read', namespaces: [NS] })
  })

  test.afterAll(async ({ request }) => {
    for (const u of userIds) await request.delete(`/api/v1/auth/admin/users/${u}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test('k8s-service answers the identity a request reaches the cluster as', async ({ request }) => {
    for (const [name, groups] of [['read', ['kubeast:authenticated', 'kubeast:viewer']], ['scoped', ['kubeast:authenticated', 'kubeast:role:read']]] as const) {
      const res = await request.get(`/api/v1/namespaces/${NS}/pods?cluster=${CLUSTER}`, { headers: bearer(people[name].token), failOnStatusCode: false })
      const access = decodeAccess(res.headers()['x-kubeast-access'])
      expect(access).toEqual({
        cluster: CLUSTER, kind: 'person', user: people[name].email, groups: [...groups], role: 'Read',
        ...(name === 'scoped' ? { namespaces: [NS] } : {}), impersonation: true,
      })
    }
  })

  test('an MCP call records who the cluster saw; a call refused before the cluster records none', async ({ request }) => {
    test.skip(!mcpOn, 'the MCP server is off (mcp.enabled)')
    const read = await mcpCall(request, people.read.token, 'k8s_get_resources', { cluster: CLUSTER, resource_type: 'pods', namespace: NS })
    expect(read.isError ?? false, read.content?.[0]?.text).toBe(false)
    const scoped = await mcpCall(request, people.scoped.token, 'k8s_get_resources', { cluster: CLUSTER, resource_type: 'pods', namespace: NS })
    // outside the granted namespace: refused by the scope gate, nothing goes to the cluster
    const refused = await mcpCall(request, people.scoped.token, 'k8s_get_resources', { cluster: CLUSTER, resource_type: 'pods', namespace: 'kube-system' })
    expect(refused.isError).toBe(true)

    await expect.poll(async () => (await mcpRows(request, admin, people.read.email)).length, { timeout: 15_000 }).toBe(1)
    const [readRow] = await mcpRows(request, admin, people.read.email)
    expect(readRow.access).toEqual({
      cluster: CLUSTER, kind: 'person', user: people.read.email, groups: ['kubeast:authenticated', 'kubeast:viewer'], role: 'Read', impersonation: true, mode: 'read',
    })
    const scopedRows = await mcpRows(request, admin, people.scoped.email)
    expect(scopedRows).toHaveLength(2)
    const inScope = scopedRows.find((r) => r.access)
    expect(inScope?.access, `scoped call: ${scoped.content?.[0]?.text}`).toEqual({
      cluster: CLUSTER, kind: 'person', user: people.scoped.email, groups: ['kubeast:authenticated', 'kubeast:role:read'], role: 'Read', namespaces: [NS], impersonation: true, mode: 'read',
    })
    expect(scopedRows.filter((r) => !r.access)).toHaveLength(1)
  })

  test('the chat shows the 🔐 line under the tool name, live and after a reload', async ({ page, request }) => {
    test.setTimeout(6 * 60 * 1000)
    const me = await (await request.get('/api/v1/auth/me', { headers: bearer(admin) })).json()
    const email = String(me.email ?? me.user?.email)
    const title = `e2e-access-${id}`
    const created = await request.post(`/api/v1/sessions?cluster=${CLUSTER}`, { headers: bearer(admin), data: { title } })
    expect(created.ok()).toBeTruthy()
    const sessionId = (await created.json()).id as string
    try {
      await page.goto(`/ai-chat?cluster=${CLUSTER}`)
      await page.waitForLoadState('networkidle')
      await page.getByText(title, { exact: true }).first().click({ timeout: 15_000 })
      const input = page.getByPlaceholder(/메시지|message/i)
      await input.fill('Use the k8s_get_resources tool once to list the pods in namespace kube-system, then answer in one line.')
      await page.getByRole('button', { name: /^전송$|^send$/i }).click()
      await expect(input).toBeDisabled({ timeout: 15_000 })
      await expect(input).toBeEnabled({ timeout: 180_000 })

      // the saved answer: each call that reached the cluster carries the admin's identity, and its block the line
      const detail = await (await request.get(`/api/v1/sessions/${sessionId}`, { headers: bearer(admin) })).json()
      const answer = (detail.messages as Array<{ role: string; content: string; tool_calls?: Array<{ function: string; access?: Access }> }>).filter((m) => m.role === 'assistant').pop()!
      const reads = (answer.tool_calls ?? []).filter((tc) => tc.function === 'k8s_get_resources')
      expect(reads.length, JSON.stringify(answer.tool_calls)).toBeGreaterThan(0)
      for (const tc of reads) expect(tc.access).toMatchObject({ cluster: CLUSTER, kind: 'person', user: email, impersonation: true, mode: 'read' })
      expect(answer.content.split('🔐 Ran as:').length - 1).toBe((answer.tool_calls ?? []).filter((tc) => tc.access).length)

      const check = async () => {
        // a tool block renders as MarkdownDisclosure: .md-details > button.md-summary + the body
        const block = page.locator('.md-details').filter({ has: page.locator('> button.md-summary', { hasText: 'k8s_get_resources' }) }).last()
        await block.locator('> button.md-summary').click()
        const line = block.getByTestId('md-details-body').first().locator('p').filter({ hasText: '🔐 Ran as:' }).first()
        await expect(line).toBeVisible()
        const text = (await line.innerText()).replace(/\s+/g, ' ')
        expect(text).toContain(email)
        for (const g of reads[0].access!.groups ?? []) expect(text).toContain(g)
        expect(text).toMatch(/global admin|role \S+/)
        expect(text).toContain('read-only')
      }
      // live: the stream manager put the line under the block's name
      await check()
      // saved: the same line from the stored answer
      const renamed = (await (await request.get(`/api/v1/sessions/${sessionId}`, { headers: bearer(admin) })).json()).title as string
      await page.reload()
      await page.waitForLoadState('networkidle')
      await page.getByText(renamed, { exact: true }).first().click({ timeout: 15_000 })
      await check()
    } finally {
      await request.delete(`/api/v1/sessions/${sessionId}`, { headers: bearer(admin) })
    }
  })
})
