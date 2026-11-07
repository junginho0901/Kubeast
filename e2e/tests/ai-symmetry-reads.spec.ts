import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'

// What a screen knows, the AI reads the same way: get_cluster_overview answers the dashboard's numbers, hygiene_history its
// settings, a pod's log keeps its newest lines, can_i asks about one object as a drawer's Delete button does, cost's totals
// follow the namespace asked, policy_reports pages as the Policy Reports screen does, and the floating chat counts a
// VolumeAttachment's errors as the Errors card does and names the kinds the Resource Graph could not list.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-symmetry-reads1!'
const MCP = '/api/v1/ai/mcp'
const RPC = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
const stamp = () => Date.now().toString(36)
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const json = (text: string) => JSON.parse(text)

function kubectlFor(kindName: string) {
  const kubeconfig = execFileSync('kind', ['get', 'kubeconfig', '--name', kindName], { encoding: 'utf8' })
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-symmetry-reads-')), 'kubeconfig')
  fs.writeFileSync(file, kubeconfig, { mode: 0o600 })
  return (args: string[], input?: string) =>
    execFileSync('kubectl', ['--kubeconfig', file, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

async function login(request: APIRequestContext, email = EMAIL, password = PASSWORD): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createReadUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E symmetry reads', email, password: PW, role_id: member.id } })
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

// The floating chat's screen data as it is sent; the answer is stood in, so no model is called.
type Layer = { source: string; summary: string; data?: Record<string, unknown> }
type PageContext = { path: string; base?: Layer | null }
async function captureFloating(page: Page) {
  const sent: PageContext[] = []
  await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ json: { id: 'e2e-symreads-ctx', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
      : route.fallback(),
  )
  await page.route(/\/api\/v1\/sessions\/e2e-symreads-ctx(\?|$)/, (route) =>
    route.fulfill({ json: { id: 'e2e-symreads-ctx', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }),
  )
  await page.route(/\/api\/v1\/ai\/sessions\/e2e-symreads-ctx\/floating-chat/, (route) => {
    sent.push(route.request().postDataJSON().page_context)
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
  })
  return sent
}

async function askFloating(page: Page, sent: PageContext[]): Promise<PageContext> {
  if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
  const input = page.getByTestId('floating-chat-input')
  await expect(input).toBeVisible()
  const before = sent.length
  await input.fill('what is on this screen?')
  await input.press('Enter')
  await expect.poll(() => sent.length).toBe(before + 1)
  await expect(page.getByTestId('floating-chat-panel').getByRole('button', { name: 'Send' })).toBeVisible()
  return sent[sent.length - 1]
}

async function signedIn(browser: Browser, email: string) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(PW)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20000 })
  return { ctx, page }
}

test.describe('AI reads what the screens know', () => {
  test('get_cluster_overview answers the numbers of the dashboard\'s cards', async ({ request }) => {
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    const email = `e2e-symreads-ov-${stamp()}@kubeast.local`
    const userId = await createReadUser(request, admin, email)
    try {
      const reader = await login(request, email, PW)
      for (const token of [admin, reader]) {
        // pods come and go on a live cluster, so the two reads are compared until they fall between changes
        await expect(async () => {
          const out = await call(request, token, 'get_cluster_overview', { cluster: 'self' })
          expect(out.isError, out.text).toBe(false)
          const route = await request.get('/api/v1/cluster/overview?cluster=self', { headers: bearer(token) })
          expect(route.status()).toBe(200)
          expect(json(out.text)).toEqual(await route.json())
        }).toPass({ timeout: 30_000, intervals: [2_000] })
      }
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('hygiene_history says how often a sign-off is due, as the hygiene settings do', async ({ request }) => {
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    const route = await request.get('/api/v1/cluster/hygiene/config?cluster=self', { headers: bearer(admin) })
    expect(route.status()).toBe(200)
    const settings = await route.json()
    const out = await call(request, admin, 'hygiene_history', { cluster: 'self' })
    expect(out.isError, out.text).toBe(false)
    const told = json(out.text)
    expect(told.enabled).toBe(settings.enabled)
    expect(told.interval_days).toBe(settings.interval_days)

    const email = `e2e-symreads-hy-${stamp()}@kubeast.local`
    const userId = await createReadUser(request, admin, email)
    try {
      const refused = await call(request, await login(request, email, PW), 'hygiene_history', { cluster: 'self' })
      expect(refused.isError, refused.text).toBe(true)
      expect(refused.text).not.toContain('interval_days')
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('a pod\'s log longer than the tool\'s output keeps its newest lines', async ({ request }) => {
    const kubectl = kubectlFor('kubeast')
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    const ns = `e2e-symreads-log-${stamp()}`
    try {
      kubectl(['create', 'namespace', ns])
      // 2000 lines of about 1 KiB: the tool's whole window, past its 1 MiB of output
      const script = 'pad=$(printf "%01000d" 0); i=0; while [ $i -lt 2000 ]; do echo "oldest-$i $pad"; i=$((i+1)); done; echo e2e-newest-line; sleep 600'
      kubectl(['create', '-f', '-'], JSON.stringify({
        apiVersion: 'v1', kind: 'Pod', metadata: { name: 'long-log', namespace: ns },
        spec: { restartPolicy: 'Never', terminationGracePeriodSeconds: 0, containers: [{ name: 'app', image: 'python:3.12-alpine', command: ['sh', '-c', script] }] },
      }))
      await expect.poll(() => { try { return kubectl(['-n', ns, 'logs', 'long-log', '--tail', '1']) } catch { return '' } }, { timeout: 120_000, intervals: [2_000] }).toBe('e2e-newest-line')
      const out = await call(request, admin, 'k8s_get_pod_logs', { cluster: 'self', namespace: ns, pod_name: 'long-log', tail_lines: 2000 })
      expect(out.isError, out.text.slice(0, 200)).toBe(false)
      expect(out.text.trimEnd().endsWith('e2e-newest-line')).toBe(true)
      expect(out.text.split('\n')[0]).toContain('older lines cut by tool-server')
      expect(out.text).not.toContain('oldest-0 ')

      const found = await call(request, admin, 'k8s_get_pod_logs', { cluster: 'self', namespace: ns, pod_name: 'long-log', grep: 'newest' })
      expect(found.text).toContain('e2e-newest-line')
    } finally {
      kubectl(['delete', 'namespace', ns, '--wait=false', '--ignore-not-found'])
    }
  })

  test('can_i asks about one object, as a drawer\'s Delete button does', async ({ request }) => {
    const kubectl = kubectlFor('kubeast')
    const admin = await login(request)
    test.skip(!(await mcpOn(request, admin)), 'the MCP server is off (mcp.enabled)')
    const ns = `e2e-symreads-${stamp()}`
    const email = `e2e-symreads-${stamp()}@kubeast.local`
    let userId = ''
    try {
      kubectl(['create', 'namespace', ns])
      kubectl(['-n', ns, 'create', 'configmap', 'one'])
      kubectl(['-n', ns, 'create', 'configmap', 'other'])
      kubectl(['create', '-f', '-'], JSON.stringify({
        apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: 'delete-one', namespace: ns },
        rules: [{ apiGroups: [''], resources: ['configmaps'], resourceNames: ['one'], verbs: ['delete'] }],
      }))
      kubectl(['create', '-f', '-'], JSON.stringify({
        apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'delete-one', namespace: ns },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'delete-one' },
        // A Read grant on the whole cluster acts as this group; kubeast:role:read is one limited to namespaces.
        subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'kubeast:viewer' }],
      }))
      userId = await createReadUser(request, admin, email)
      const token = await login(request, email, PW)
      const asTool = async (name?: string) =>
        json((await call(request, token, 'can_i', { cluster: 'self', verb: 'delete', resource: 'configmaps', namespace: ns, ...(name ? { name } : {}) })).text)
      const asScreen = async (name?: string) => {
        const res = await request.get('/api/v1/cluster/can-i', {
          headers: bearer(token),
          params: { cluster: 'self', verb: 'delete', resource: 'configmaps', namespace: ns, ...(name ? { name } : {}) },
        })
        expect(res.status()).toBe(200)
        return (await res.json()).allowed
      }

      await expect.poll(async () => (await asTool('one')).allowed, 'the rule names this object').toBe(true)
      expect((await asTool('one')).name).toBe('one')
      expect((await asTool('other')).allowed, 'the rule does not name that one').toBe(false)
      const kind = await asTool()
      expect(kind.allowed, 'the rule does not allow the kind').toBe(false)
      expect(kind).not.toHaveProperty('name')
      for (const name of ['one', 'other', undefined]) {
        expect((await asTool(name)).allowed, `the tool and the screen's route agree on ${name ?? 'the kind'}`).toBe(await asScreen(name))
      }
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
      kubectl(['delete', 'namespace', ns, '--ignore-not-found', '--wait=false'])
    }
  })

  test('cost adds up the namespace it was asked about', async ({ request }) => {
    const token = await login(request)
    test.skip(!(await mcpOn(request, token)), 'the MCP server is off (mcp.enabled)')
    const clusters = ((await (await request.get('/api/v1/clusters?accessibleOnly=true', { headers: bearer(token) })).json()).items ?? []) as { id: string }[]
    let cluster = ''
    for (const c of clusters) {
      const status = await request.get(`/api/v1/cluster/cost/status?cluster=${c.id}`, { headers: bearer(token) })
      if (status.ok() && (await status.json()).available) cluster = c.id
    }
    test.skip(!cluster, 'no cluster with an OpenCost')

    const all = json((await call(request, token, 'cost', { cluster, window: '24h', aggregate: 'controller' })).text)
    // OpenCost's own buckets (__idle__ …) are not namespaces a tool can be asked about
    const namespaces = [...new Set((all.rows as { namespace: string }[]).map((r) => r.namespace))].filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n))
    expect(namespaces.length, 'the check needs two namespaces with costs').toBeGreaterThan(1)
    const one = json((await call(request, token, 'cost', { cluster, window: '24h', aggregate: 'controller', namespace: namespaces[0] })).text)
    expect(one.truncated, 'all of the namespace\'s rows came').toBeFalsy()
    expect(new Set((one.rows as { namespace: string }[]).map((r) => r.namespace))).toEqual(new Set([namespaces[0]]))
    for (const key of ['cpu_cost', 'ram_cost', 'gpu_cost', 'pv_cost', 'network_cost', 'load_balancer_cost', 'total_cost', 'cpu_core_hours', 'ram_byte_hours']) {
      const sum = (one.rows as Record<string, number>[]).reduce((total, row) => total + row[key], 0)
      expect(one.totals[key], `totals.${key} adds up the rows`).toBeCloseTo(sum, 6)
    }
    expect(one.totals.total_cost, 'less than the whole cluster').toBeLessThan(all.totals.total_cost)
  })

  test('policy_reports pages, sorts and picks a source as the screen\'s route does', async ({ request }) => {
    const token = await login(request)
    test.skip(!(await mcpOn(request, token)), 'the MCP server is off (mcp.enabled)')
    const clusters = ((await (await request.get('/api/v1/clusters?accessibleOnly=true', { headers: bearer(token) })).json()).items ?? []) as { id: string }[]
    let cluster = ''
    for (const c of clusters) {
      const status = await request.get(`/api/v1/cluster/policyreports/status?cluster=${c.id}`, { headers: bearer(token) })
      if (status.ok() && (await status.json()).installed) cluster = c.id
    }
    test.skip(!cluster, 'no cluster with policy reports')

    const RESULTS = 'pass,fail,warn,error,skip'
    const route = async (q: Record<string, string | number>) => {
      const res = await request.get('/api/v1/cluster/policyreports/results', { headers: bearer(token), params: { cluster, result: RESULTS, ...q } })
      expect(res.status()).toBe(200)
      return res.json()
    }
    const tool = async (a: Record<string, unknown>) => json((await call(request, token, 'policy_reports', { cluster, view: 'results', results: RESULTS, ...a })).text)
    const rowKey = (r: Record<string, string>) => [r.source, r.namespace, r.kind, r.name, r.policy, r.rule, r.result].join('/')

    const whole = await route({ limit: 2 })
    expect(whole.total, 'the check needs more than one page').toBeGreaterThan(2)
    const first = await tool({ limit: 2, sort: 'policy', dir: 'desc' })
    const screenFirst = await route({ limit: 2, sort: 'policy', dir: 'desc' })
    expect(first.total).toBe(screenFirst.total)
    expect(first.rows.map(rowKey)).toEqual(screenFirst.rows.map(rowKey))
    expect(first.next_offset).toBe(2)

    const second = await tool({ limit: 2, offset: 2, sort: 'policy', dir: 'desc' })
    const screenSecond = await route({ limit: 2, offset: 2, sort: 'policy', dir: 'desc' })
    expect(second.rows.map(rowKey)).toEqual(screenSecond.rows.map(rowKey))
    expect(second.rows.map(rowKey)).not.toEqual(first.rows.map(rowKey))

    const last = await tool({ limit: 2, offset: whole.total - 1, sort: 'policy', dir: 'desc' })
    expect(last.rows.length).toBe(1)
    expect(last).not.toHaveProperty('next_offset')

    const source = (first.rows as { source?: string }[])[0]?.source
    if (source) {
      const picked = await tool({ limit: 200, policy_source: source })
      expect(picked.total).toBe((await route({ limit: 1, source })).total)
      for (const row of picked.rows) expect(row.source).toBe(source)
    }

    const badSort = await call(request, token, 'policy_reports', { cluster, view: 'results', sort: 'severity' })
    expect(badSort.isError).toBe(true)
    expect(badSort.text).toMatch(/one of result/)
  })

  test('the floating chat counts a VolumeAttachment\'s errors as the Errors card does', async ({ page, request }) => {
    const kubectl = kubectlFor('kubeast')
    const run = stamp()
    const failed = `e2e-symreads-failed-${run}`
    const silent = `e2e-symreads-silent-${run}`
    const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    await login(request)
    try {
      const node = kubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}'])
      for (const [name, message] of [[failed, 'attach timed out'], [silent, '']]) {
        kubectl(['create', '-f', '-'], JSON.stringify({
          apiVersion: 'storage.k8s.io/v1', kind: 'VolumeAttachment', metadata: { name },
          spec: { attacher: 'symmetry.kubeast.io', nodeName: node, source: { persistentVolumeName: `pv-${name}` } },
        }))
        kubectl(['patch', 'volumeattachment', name, '--subresource=status', '--type=merge', `-p=${JSON.stringify({ status: { attached: false, attachError: { time: at, message } } })}`])
      }
      type Attachment = { status?: { attachError?: { message?: string }; detachError?: { message?: string } } }
      const listed = json(kubectl(['get', 'volumeattachments', '-o', 'json'])).items as Attachment[]
      const withMessage = listed.filter((v) => v.status?.attachError?.message || v.status?.detachError?.message).length

      const sent = await captureFloating(page)
      await page.goto('/storage?tab=volumeattachments&cluster=self')
      await expect(page.getByText(failed).first()).toBeVisible({ timeout: 30000 })
      await expect(page.getByText(silent).first()).toBeVisible()
      const asked = await askFloating(page, sent)
      const stats = (asked.base?.data as { stats?: { total?: number; with_error?: number } } | undefined)?.stats
      expect(stats?.total, 'every attachment kubectl lists').toBe(listed.length)
      expect(stats?.with_error, 'the errors that have a message').toBe(withMessage)
      const problems = ((asked.base?.data as { problematic_items?: { name: string }[] } | undefined)?.problematic_items ?? []).map((row) => row.name)
      expect(problems).toContain(failed)
      expect(problems).not.toContain(silent)
    } finally {
      kubectl(['delete', 'volumeattachment', failed, silent, '--ignore-not-found', '--wait=false'])
    }
  })

  test('the floating chat is told which kinds the Resource Graph could not list', async ({ browser, page, request }) => {
    const admin = await login(request)
    const email = `e2e-symreads-graph-${stamp()}@kubeast.local`
    const NS = 'kubeast'
    let userId = ''
    let ctx: Awaited<ReturnType<typeof signedIn>>['ctx'] | undefined
    try {
      userId = await createReadUser(request, admin, email)
      const reader = await login(request, email, PW)
      const res = await request.get(`/api/v1/resource-graph?namespaces=${NS}&cluster=self&group_pods=1`, { headers: bearer(reader) })
      expect(res.status()).toBe(200)
      const refused = ((await res.json()).forbidden_kinds ?? []) as string[]
      expect(refused, 'a Read user may not list Secrets').toContain('Secret')

      const signed = await signedIn(browser, email)
      ctx = signed.ctx
      const sent = await captureFloating(signed.page)
      await signed.page.goto(`/cluster/resource-graph?cluster=self&namespace=${NS}`)
      await expect(signed.page.getByTestId('resource-graph-forbidden')).toBeVisible({ timeout: 30000 })
      const asked = await askFloating(signed.page, sent)
      expect((asked.base?.data as { forbidden_kinds?: string[] } | undefined)?.forbidden_kinds, 'the same kinds as the page\'s notice').toEqual(refused)
      expect(asked.base?.summary).toContain(refused.join(', '))

      // an admin is refused nothing, so nothing is said
      const adminSent = await captureFloating(page)
      await page.goto(`/cluster/resource-graph?cluster=self&namespace=${NS}`)
      await expect(page.getByTestId('graph-node-count')).toBeVisible({ timeout: 30000 })
      const adminAsked = await askFloating(page, adminSent)
      expect((adminAsked.base?.data as { forbidden_kinds?: string[] } | undefined)?.forbidden_kinds).toBeUndefined()
    } finally {
      await ctx?.close()
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
