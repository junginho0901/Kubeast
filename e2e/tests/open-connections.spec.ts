import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test'

// A terminal, a followed log and a live list are authenticated once, when they open. They end when the session behind
// them stops standing (services/pkg/auth LiveSessions), within one check of 30 seconds and one cached answer, and say
// why. A global admin.* key opens pages, not clusters: only what its page reads. The node shell's pods keep their logs
// to those holding resource.node.shell. A list that stopped following says so. The users and objects are removed after.

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
