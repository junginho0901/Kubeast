import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'

// A terminal, a followed log and a live list are authenticated once, when they open. They end when the session behind
// them stops standing (services/pkg/auth LiveSessions), within one check of 30 seconds and one cached answer, and say
// why — also when the sign-in they opened with was signed out in another page. A global admin.* key opens pages, not
// clusters: only what its page reads. The node shell's pods keep their logs to those holding resource.node.shell. A
// list that stopped following says so. The users and objects are removed after.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'
const NS = process.env.E2E_KUBEAST_NAMESPACE || 'kubeast'
const SHELL_NS = 'kubeast-node-shell'
const PW = 'E2e-open-connections-throwaway-1!'
const STAMP = Date.now().toString(36)
const POD = `e2e-open-conn-${STAMP}`
const SESSION_END_WAIT = 75_000
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

const EN: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend/src/i18n/locales/en.json'), 'utf8'))
function tr(key: string): string {
  const value = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), EN)
  if (typeof value !== 'string') throw new Error(`the en catalog has no ${key}`)
  return value
}

const kubeconfig = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-open-conn-')), 'kubeconfig')
fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
const kubectl = (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

type RoleRow = { id: number; name: string }

async function createUser(request: APIRequestContext, admin: string, email: string, roleId: number): Promise<string> {
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E open connections', email, password: PW, role_id: roleId } })
  expect(res.status(), `create ${email}`).toBe(201)
  return (await res.json()).id
}

async function signIn(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(PW)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), undefined, { timeout: 20_000 })
  return page
}

type Opened = {
  socket?: { code: number; reason: string }
  terminal?: { code: number; reason: string; text: string }
  log?: { reason: string; lines: number }
}

// Opens the three kinds of connection from the page, as its screens do, and keeps how each ended on window.
async function openConnections(page: Page) {
  await page.evaluate(
    ({ pod }) => {
      const seen: Opened = {}
      ;(window as unknown as { __seen: Opened }).__seen = seen
      const base = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`
      const socket = new WebSocket(`${base}/api/v1/cluster/wsMultiplexer?cluster=self`)
      socket.onopen = () => socket.send(JSON.stringify({ type: 'REQUEST', clusterId: 'self', path: '/api/v1/namespaces/default/pods', query: 'watch=1' }))
      socket.onclose = (e) => { seen.socket = { code: e.code, reason: e.reason } }

      let text = ''
      const decoder = new TextDecoder()
      // kubectl run names the container after the pod.
      const terminal = new WebSocket(`${base}/api/v1/cluster/namespaces/default/pods/${pod}/exec/ws?container=${pod}&command=/bin/sh&cluster=self&lang=en`)
      terminal.binaryType = 'arraybuffer'
      terminal.onmessage = (e) => { text += typeof e.data === 'string' ? e.data : decoder.decode(new Uint8Array(e.data).slice(1)) }
      terminal.onclose = (e) => { seen.terminal = { code: e.code, reason: e.reason, text } }

      let lines = 0
      const log = new EventSource(`/api/v1/cluster/namespaces/default/pods/${pod}/logs/stream?container=${pod}&tail_lines=5&cluster=self`, { withCredentials: true })
      log.onmessage = () => { lines += 1 }
      log.addEventListener('session-ended', (e) => {
        seen.log = { reason: (e as MessageEvent).data, lines }
        log.close()
      })
    },
    { pod: POD },
  )
}

const seenOn = (page: Page) => page.evaluate(() => (window as unknown as { __seen: Opened }).__seen)

test.describe.serial('open connections and what a global key opens', () => {
  let admin = ''
  let roleId = 0
  const users: string[] = []
  const customRoles: number[] = []

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const roles = (await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()) as RoleRow[]
    roleId = roles.find((r) => r.name.toLowerCase() === 'member')!.id
    kubectl(`-n default run ${POD} --image=python:3.12-alpine --restart=Never --command -- sh -c 'i=0; while true; do echo line $i; i=$((i+1)); sleep 1; done'`)
    kubectl(`-n default wait --for=condition=Ready pod/${POD} --timeout=120s`)
  })

  test.afterAll(async ({ request }) => {
    for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    for (const id of customRoles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    kubectl(`-n default delete pod ${POD} --ignore-not-found --wait=false`)
  })

  test('a changed grant ends an open list, terminal and followed log, each with its reason', async ({ request, browser }) => {
    test.setTimeout(SESSION_END_WAIT + 60_000)
    const email = `e2e-open-conn-a-${STAMP}@kubeast.local`
    const id = await createUser(request, admin, email, roleId)
    users.push(id)
    expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Admin' } })).ok()).toBeTruthy()
    const page = await signIn(browser, email)
    // A file of the same origin, so no screen of the app answers the session's end by going to the sign-in page, taking
    // what these connections saw along.
    await page.goto('/color-mode.js')
    await openConnections(page)
    await page.waitForTimeout(3_000)
    expect(await seenOn(page), 'nothing ends on its own').toEqual({})

    expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })).ok()).toBeTruthy()

    await expect.poll(async () => {
      const seen = await seenOn(page)
      return Boolean(seen.socket && seen.terminal && seen.log)
    }, { timeout: SESSION_END_WAIT, intervals: [2_000] }).toBe(true)
    const seen = await seenOn(page)
    expect(seen.socket).toEqual({ code: 4401, reason: 'session_revoked' })
    expect(seen.terminal?.code).toBe(4401)
    expect(seen.terminal?.reason).toBe('session_revoked')
    expect(seen.terminal?.text).toContain('your account or access changed')
    expect(seen.log?.reason).toBe('session_revoked')
    expect(seen.log?.lines ?? 0).toBeGreaterThan(0)

    const rows = (await (await request.get(`/api/v1/auth/admin/audit-logs?action=k8s.session.end&actor_email=${encodeURIComponent(email)}&limit=20`, { headers: bearer(admin) })).json()) as { items?: { ActorEmail?: string; After?: { stream?: string; reason?: string } }[] }
    const streams = (rows.items ?? []).filter((r) => r.ActorEmail === email).map((r) => r.After?.stream).sort()
    expect(streams).toEqual(['exec', 'pod-logs'])
    await page.context().close()
  })

  test('a page holding a live list goes to the sign-in page when the session is over, and says so', async ({ request, browser }) => {
    test.setTimeout(SESSION_END_WAIT + 60_000)
    const email = `e2e-open-conn-b-${STAMP}@kubeast.local`
    const id = await createUser(request, admin, email, roleId)
    users.push(id)
    expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })).ok()).toBeTruthy()
    const page = await signIn(browser, email)
    await page.goto('/workloads/pods?cluster=self')

    expect((await request.delete(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin) })).ok()).toBeTruthy()

    await expect(page).toHaveURL(/\/login/, { timeout: SESSION_END_WAIT })
    await expect(page.getByText(tr('login.sessionEnded'))).toHaveText(tr('login.sessionEnded'))
    await page.context().close()
  })

  test('signing out in one page ends what another page of the same browser holds open, and its token is refused', async ({ request, browser }) => {
    test.setTimeout(SESSION_END_WAIT + 90_000)
    const email = `e2e-open-conn-f-${STAMP}@kubeast.local`
    const id = await createUser(request, admin, email, roleId)
    users.push(id)
    expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Admin' } })).ok()).toBeTruthy()
    const page = await signIn(browser, email)
    const copied = (await page.context().cookies()).find((c) => c.name === 'kubeast.token')?.value ?? ''
    expect(copied, 'the sign-in left its cookie').not.toBe('')
    // The second page of the same browser: a file of the same origin, so no screen answers the end for it.
    const other = await page.context().newPage()
    await other.goto('/color-mode.js')
    await openConnections(other)
    await other.waitForTimeout(3_000)
    expect(await seenOn(other), 'nothing ends on its own').toEqual({})

    await page.getByRole('button', { name: /Log out|로그아웃/ }).click()
    await expect(page).toHaveURL(/\/login/)

    // auth-service reads the sign-in on every request: refused at once, refresh with the expired session's answer.
    const refreshed = await request.post('/api/v1/auth/refresh', { headers: bearer(copied), failOnStatusCode: false })
    expect(refreshed.status()).toBe(401)
    expect((await refreshed.json()).detail).toBe('Session expired; sign in again')
    expect((await request.get('/api/v1/auth/me', { headers: bearer(copied), failOnStatusCode: false })).status()).toBe(401)

    await expect.poll(async () => {
      const seen = await seenOn(other)
      return Boolean(seen.socket && seen.terminal && seen.log)
    }, { timeout: SESSION_END_WAIT, intervals: [2_000] }).toBe(true)
    const seen = await seenOn(other)
    expect(seen.socket).toEqual({ code: 4401, reason: 'session_signed_out' })
    expect(seen.terminal?.code).toBe(4401)
    expect(seen.terminal?.reason).toBe('session_signed_out')
    expect(seen.terminal?.text).toContain('this sign-in was signed out')
    expect(seen.log?.reason).toBe('session_signed_out')

    // k8s-service reads it through a cached answer of at most 30 seconds.
    await expect.poll(async () => (await request.get('/api/v1/cluster/namespaces/default/pods?cluster=self', { headers: bearer(copied), failOnStatusCode: false })).status(),
      { timeout: 45_000, intervals: [2_000] }).toBe(401)

    type Row = { ActorEmail?: string; Result?: string; Error?: string; After?: { stream?: string; reason?: string; auth_time?: string } }
    const rows = async (action: string) => ((await (await request.get(`/api/v1/auth/admin/audit-logs?action=${action}&actor_email=${encodeURIComponent(email)}&limit=20`, { headers: bearer(admin) })).json()) as { items?: Row[] }).items?.filter((r) => r.ActorEmail === email) ?? []
    const signOuts = await rows('user.logout')
    expect(signOuts.map((r) => r.Result)).toEqual(['success'])
    expect(signOuts[0].After?.auth_time, 'the row names the sign-in that ended').toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect((await rows('k8s.session.end')).map((r) => [r.After?.stream, r.After?.reason]).sort()).toEqual([['exec', 'session_signed_out'], ['pod-logs', 'session_signed_out']])
    expect((await rows('user.token.refresh')).filter((r) => r.Result === 'failure').map((r) => r.Error)).toEqual(['session_signed_out'])
    await page.context().close()
  })

  test('a global admin key opens what its page reads and no cluster', async ({ request }) => {
    const roleName = `e2e-open-conn-keys-${STAMP}`
    const role = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name: roleName, description: 'e2e global keys', permissions: ['admin.audit.read', 'admin.hygiene.read'] } })
    expect(role.ok(), await role.text()).toBeTruthy()
    const created = (await role.json()) as { id: number }
    customRoles.push(created.id)
    const email = `e2e-open-conn-c-${STAMP}@kubeast.local`
    users.push(await createUser(request, admin, email, created.id))
    const token = await login(request, email, PW)
    const status = async (p: string) => (await request.get(`/api/v1/cluster${p}${p.includes('?') ? '&' : '?'}cluster=self`, { headers: bearer(token), failOnStatusCode: false })).status()

    expect(await status('/overview')).toBe(403)
    expect(await status('/prometheus/query?query=up')).toBe(403)
    expect(await status('/namespaces/default/pods')).toBe(403)
    expect(await status('/prometheus/status')).toBe(403)
    expect(await status('/features')).toBe(200)
    expect(await status('/hygiene')).not.toBe(403)
  })

  test('a store status names its address only to whoever registers clusters', async ({ request }) => {
    const email = `e2e-open-conn-d-${STAMP}@kubeast.local`
    const id = await createUser(request, admin, email, roleId)
    users.push(id)
    expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })).ok()).toBeTruthy()
    const token = await login(request, email, PW)
    const asReader = await (await request.get('/api/v1/cluster/prometheus/status?cluster=self', { headers: bearer(token) })).json()
    const asAdmin = await (await request.get('/api/v1/cluster/prometheus/status?cluster=self', { headers: bearer(admin) })).json()
    expect(asReader.endpoint).toBeUndefined()
    expect(asReader.source).toBe(asAdmin.source)
    expect(asReader.available).toBe(asAdmin.available)
    if (asAdmin.source !== 'none') expect(typeof asAdmin.endpoint).toBe('string')
  })

  test('a node shell pod keeps its log to those holding the node shell, and Kubeast\'s own pods stay readable', async ({ request }) => {
    const email = `e2e-open-conn-e-${STAMP}@kubeast.local`
    const id = await createUser(request, admin, email, roleId)
    users.push(id)
    expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Write' } })).ok()).toBeTruthy()
    const token = await login(request, email, PW)
    const shellLog = await request.get(`/api/v1/cluster/namespaces/${SHELL_NS}/pods/node-debugger-none/logs?container=debugger&cluster=self`, { headers: bearer(token), failOnStatusCode: false })
    expect(shellLog.status()).toBe(403)
    expect((await shellLog.json()).reason).toBe('protected_namespace')

    const own = kubectl(`-n ${NS} get pods -l app=frontend -o jsonpath={.items[0].metadata.name}`)
    const ownLog = await request.get(`/api/v1/cluster/namespaces/${NS}/pods/${own}/logs?tail_lines=1&cluster=self`, { headers: bearer(token), failOnStatusCode: false })
    expect(ownLog.status()).toBe(200)
  })

  test('a list that stopped following says so, and the notice goes when the watch is back', async ({ page }) => {
    let answer: ((frame: object) => void) | undefined
    let asked: { clusterId: string; path: string; query: string } | undefined
    await page.routeWebSocket(/wsMultiplexer/, (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => {
        const msg = JSON.parse(String(message))
        if (!asked && msg.type === 'REQUEST') asked = msg
        server.send(message)
      })
      // From the first frame the test writes, only its own: any frame of the real watch means it answers again.
      let relay = true
      server.onMessage((message) => { if (relay) ws.send(message) })
      answer = (frame) => {
        relay = false
        ws.send(JSON.stringify(frame))
      }
    })
    // A list that watches; the Pods list polls.
    await page.goto('/workloads/deployments?cluster=self')
    await expect.poll(() => Boolean(asked), { timeout: 20_000 }).toBe(true)
    const notice = page.getByTestId('watch-problem-notice')

    answer!({ ...asked, type: 'ERROR', error: { message: 'max subscriptions reached', reason: 'limit' } })
    await expect(notice).toHaveAttribute('data-problem', 'limit')
    await expect(notice).toContainText(tr('layout.watchProblem.limit'))

    answer!({ ...asked, type: 'RESYNC' })
    await expect(notice).toHaveCount(0)

    answer!({ ...asked, type: 'ERROR', error: { message: 'no such kind', reason: 'not_served' } })
    await expect(notice).toHaveCount(0)
  })
})

test.describe('a list that does not follow, and what the floating chat is told', () => {
  type Layer = { source: string; summary: string; data?: Record<string, unknown> }

  async function captureFloating(page: Page) {
    const sent: { overlays: Layer[] }[] = []
    await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ json: { id: 'e2e-open-conn-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
        : route.fallback())
    await page.route(/\/api\/v1\/sessions\/e2e-open-conn-\d+(\?|$)/, (route) =>
      route.fulfill({ json: { id: 'e2e-open-conn-1', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }))
    await page.route(/\/api\/v1\/ai\/sessions\/e2e-open-conn-\d+\/floating-chat/, (route) => {
      sent.push(route.request().postDataJSON().page_context)
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
    })
    return async () => {
      if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
      const input = page.getByTestId('floating-chat-input')
      await expect(input).toBeVisible()
      const before = sent.length
      await input.fill('what is on this screen?')
      await input.press('Enter')
      await expect.poll(() => sent.length).toBe(before + 1)
      await expect(page.getByTestId('floating-chat-panel').getByRole('button', { name: /^(Send|보내기)$/ })).toBeVisible()
      return sent[sent.length - 1]
    }
  }

  test('a watch the cluster refuses says so beside a notice about another list, and tells the floating chat', async ({ page }) => {
    let answer: ((frame: object) => void) | undefined
    let asked: { clusterId: string; path: string; query: string } | undefined
    await page.routeWebSocket(/wsMultiplexer/, (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => {
        const msg = JSON.parse(String(message))
        if (msg.type === 'REQUEST' && msg.path === '/api/v1/nodes') asked = msg
        server.send(message)
      })
      // From the first frame the test writes, only its own: any frame of the real watch means it answers again.
      let relay = true
      server.onMessage((message) => { if (relay) ws.send(message) })
      answer = (frame) => {
        relay = false
        ws.send(JSON.stringify(frame))
      }
    })
    // another list on the page is refused: the banner names that one and not these rows
    await page.route('**/api/v1/cluster/metrics/nodes*', (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ detail: 'metrics is forbidden' }) }))
    const ask = await captureFloating(page)
    await page.goto('/cluster/nodes?cluster=self')
    await expect.poll(() => Boolean(asked), { timeout: 20_000 }).toBe(true)
    await expect(page.getByTestId('forbidden-banner')).toHaveCount(1, { timeout: 20_000 })
    const notice = page.getByTestId('watch-problem-notice')
    await expect(notice).toHaveCount(0)

    answer!({ ...asked, type: 'ERROR', error: { message: 'nodes is forbidden', reason: 'forbidden' } })
    await expect(notice).toHaveAttribute('data-problem', 'forbidden')
    await expect(notice).toContainText(tr('layout.watchProblem.forbidden'))
    await expect(page.getByTestId('forbidden-banner')).toHaveCount(1)
    await expect.poll(async () => (await ask()).overlays.find((o) => o.source === 'WatchProblemNotice')?.data, { timeout: 20_000 })
      .toEqual({ live_updates: 'stopped', reason: 'forbidden' })

    answer!({ ...asked, type: 'RESYNC' })
    await expect(notice).toHaveCount(0)
    await expect.poll(async () => (await ask()).overlays.some((o) => o.source === 'WatchProblemNotice'), { timeout: 20_000 }).toBe(false)
  })

  test('a role that may list a kind and may not watch it reads so on the page, from the cluster\'s own refusal', async ({ request, browser }) => {
    test.setTimeout(90_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const roles = (await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()) as RoleRow[]
    const namespace = `e2e-open-conn-list-${STAMP}`
    const email = `e2e-open-conn-list-${STAMP}@kubeast.local`
    let id = ''
    kubectl(`create namespace ${namespace}`)
    try {
      kubectl(`-n ${namespace} create role e2e-list-only --verb=list --resource=configmaps`)
      kubectl(`-n ${namespace} create rolebinding e2e-list-only --role=e2e-list-only --group=kubeast:role:read`)
      id = await createUser(request, admin, email, roles.find((r) => r.name.toLowerCase() === 'member')!.id)
      expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read', namespaces: [namespace] } })).ok()).toBeTruthy()

      const page = await signIn(browser, email)
      const refusals: { message: string; reason: string }[] = []
      await page.routeWebSocket(/wsMultiplexer/, (ws) => {
        const server = ws.connectToServer()
        ws.onMessage((message) => server.send(message))
        server.onMessage((message) => {
          const frame = JSON.parse(String(message))
          if (frame.type === 'ERROR' && frame.path === `/api/v1/namespaces/${namespace}/configmaps`) refusals.push(frame.error)
          ws.send(message)
        })
      })
      await page.goto(`/configuration/configmaps?cluster=self&namespace=${namespace}`)
      await expect(page.locator('main tbody tr').filter({ hasText: 'kube-root-ca.crt' }), 'the list answers').toHaveCount(1, { timeout: 30_000 })
      const notice = page.getByTestId('watch-problem-notice')
      await expect(notice).toHaveAttribute('data-problem', 'forbidden', { timeout: 20_000 })
      await expect(notice).toContainText(tr('layout.watchProblem.forbidden'))
      await expect.poll(() => refusals.length, { timeout: 20_000 }).toBeGreaterThan(0)
      expect(refusals[0].reason).toBe('forbidden')
      expect(refusals[0].message).toContain('cannot watch resource "configmaps"')
      await page.context().close()
    } finally {
      if (id) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
      kubectl(`delete namespace ${namespace} --ignore-not-found --wait=false`)
    }
  })

  // The cluster's RBAC is what the two lists answer by, as before; the watches stop asking it.
  test('a grant limited to a namespace is refused a kind of the cluster once, and its lists answer as they did', async ({ request, browser }) => {
    test.setTimeout(150_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const roles = (await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()) as RoleRow[]
    const namespace = `e2e-open-conn-scope-${STAMP}`
    const email = `e2e-open-conn-scope-${STAMP}@kubeast.local`
    let id = ''
    kubectl(`create namespace ${namespace}`)
    try {
      kubectl(`-n ${namespace} create rolebinding e2e-view --clusterrole=view --group=kubeast:role:read`)
      id = await createUser(request, admin, email, roles.find((r) => r.name.toLowerCase() === 'member')!.id)
      expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read', namespaces: [namespace] } })).ok()).toBeTruthy()
      const token = await login(request, email, PW)

      const page = await signIn(browser, email)
      const refusals = new Map<string, { message: string; reason: string }[]>()
      await page.routeWebSocket(/wsMultiplexer/, (ws) => {
        const server = ws.connectToServer()
        ws.onMessage((message) => server.send(message))
        server.onMessage((message) => {
          const frame = JSON.parse(String(message))
          if (frame.type === 'ERROR') refusals.set(frame.path, [...(refusals.get(frame.path) ?? []), frame.error])
          ws.send(message)
        })
      })
      const notice = page.getByTestId('watch-problem-notice')

      // the list of namespaces is narrowed to the grant and answers
      const listed = await request.get('/api/v1/cluster/namespaces?cluster=self', { headers: bearer(token) })
      expect(listed.status()).toBe(200)
      expect((await listed.json()).map((n: { name: string }) => n.name)).toEqual([namespace])
      await page.goto('/cluster/namespaces?cluster=self')
      await expect(page.locator('main tbody tr').filter({ hasText: namespace })).toHaveCount(1, { timeout: 20_000 })
      await expect(notice).toHaveAttribute('data-problem', 'scope', { timeout: 20_000 })
      await expect(notice).toContainText(tr('layout.watchProblem.scope'))
      await expect(page.getByTestId('forbidden-banner')).toHaveCount(0)
      // past the five seconds the cluster's own refusal comes back at
      await page.waitForTimeout(12_000)
      expect((refusals.get('/api/v1/namespaces') ?? []).map((e) => e.reason)).toEqual(['scope'])

      // the list of nodes is the cluster's to refuse, and that page says it
      const nodes = await request.get('/api/v1/cluster/nodes?cluster=self', { headers: bearer(token), failOnStatusCode: false })
      expect(nodes.status()).toBe(403)
      await page.goto('/cluster/nodes?cluster=self')
      await expect(page.getByTestId('forbidden-banner')).toHaveCount(1, { timeout: 20_000 })
      await page.waitForTimeout(12_000)
      expect((refusals.get('/api/v1/nodes') ?? []).map((e) => e.reason)).toEqual(['scope'])
      await expect(notice).toHaveCount(0)
      await page.context().close()
    } finally {
      if (id) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
      kubectl(`delete namespace ${namespace} --ignore-not-found --wait=false`)
    }
  })
})
