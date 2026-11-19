import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// One account holds at most multicluster.maxTerminalsPerAccount terminals and maxFollowedLogsPerAccount followed logs
// open on a k8s-service at once. With that many open, the next one is refused before it opens — the socket closes
// with 4429 `terminal_limit`, the stream sends the event `stream-limit` — the terminal and the Logs tab say why, a
// failed audit row is left, and once one closes a new one opens. The spec changes no value: it reads the caps from the
// Deployment that takes the streams (its env, else k8s-service's default 20; E2E_MAX_TERMINALS_PER_ACCOUNT and
// E2E_MAX_FOLLOWED_LOGS_PER_ACCOUNT stand for them when set), and runs only where one pod takes them, since each pod
// counts its own.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'
const KNS = process.env.E2E_KUBEAST_NAMESPACE || 'kubeast'
const CLUSTER = 'self'
const NS = 'default'
const STAMP = Date.now().toString(36)
const POD = `e2e-caps-${STAMP}`
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

const EN: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend/src/i18n/locales/en.json'), 'utf8'))
function tr(key: string): string {
  const value = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), EN)
  if (typeof value !== 'string') throw new Error(`the en catalog has no ${key}`)
  return value
}
const squash = (s: string) => s.replace(/\s+/g, '')

const kubeconfig = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-caps-')), 'kubeconfig')
fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
const kubectl = (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const tryKubectl = (args: string) => { try { return kubectl(args) } catch { return null } }

// The Deployment that takes terminals and followed logs: k8s-service-stream with streams on, else k8s-service.
const streamDeployment = () => (tryKubectl(`-n ${KNS} get deploy k8s-service-stream -o name`) ? 'k8s-service-stream' : 'k8s-service')
const streamPods = () => Number(tryKubectl(`-n ${KNS} get deploy ${streamDeployment()} -o jsonpath={.status.readyReplicas}`) || 0)

// A cap the install gave k8s-service: the override when set, else the Deployment's env, else k8s-service's default.
function capOf(env: string, override: string | undefined): number {
  if (override) return Number(override)
  const value = tryKubectl(`-n ${KNS} get deploy ${streamDeployment()} -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="${env}")].value}'`)
  return value ? Number(value) : 20
}
let MAX_TERMINALS = 0
let MAX_LOGS = 0

type Row = { TargetID: string; Result?: string; Error?: string }

async function accessToken(request: APIRequestContext): Promise<string> {
  const login = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(login.ok(), 'admin login').toBeTruthy()
  return (await login.json()).access_token as string
}

// The failed rows of action about this run's pod, whose name is the run's own (no time bound: the server keeps its own
// clock).
async function failedRows(request: APIRequestContext, action: string): Promise<Row[]> {
  const headers = { Authorization: `Bearer ${await accessToken(request)}`, 'X-Requested-With': 'XMLHttpRequest' }
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers, params: { cluster: '', limit: '100', action } })
  expect(res.ok()).toBeTruthy()
  return (((await res.json()).items || []) as Row[]).filter((r) => r.TargetID === POD && r.Result === 'failure')
}

type Held = { text: string; closed: { code: number; reason: string } | null }
type TermWindow = { __terms?: { ws: WebSocket; seen: Held }[]; __openTerm?: (i: number) => void }

// Opens n terminal sockets on the pod as PodExecTerminal does, kept on window.__terms.
async function openTerminals(page: Page, n: number) {
  await page.evaluate(
    ({ ns, pod, cluster, n }) => {
      const w = window as unknown as TermWindow
      const terms = (w.__terms = w.__terms || [])
      w.__openTerm = w.__openTerm || ((i: number) => {
        const seen: Held = { text: '', closed: null }
        const decoder = new TextDecoder()
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/cluster/namespaces/${ns}/pods/${pod}/exec/ws?container=${pod}&command=/bin/sh&cluster=${cluster}&lang=en`)
        ws.binaryType = 'arraybuffer'
        ws.onmessage = (e) => { seen.text += typeof e.data === 'string' ? e.data : decoder.decode(new Uint8Array(e.data).slice(1)) }
        ws.onclose = (e) => { seen.closed = { code: e.code, reason: e.reason } }
        terms[i] = { ws, seen }
      })
      const from = terms.length
      for (let i = 0; i < n; i++) w.__openTerm(from + i)
    },
    { ns: NS, pod: POD, cluster: CLUSTER, n },
  )
}

// Opens again the terminals refused at the cap: an earlier spec's terminal can hold its place for a moment after its
// page closed.
const reopenRefused = (page: Page) => page.evaluate(() => {
  const w = window as unknown as TermWindow
  w.__terms!.forEach((t, i) => { if (t.seen.closed?.code === 4429) w.__openTerm!(i) })
})

const terminals = (page: Page) => page.evaluate(() => ((window as unknown as { __terms: { seen: Held }[] }).__terms).map((t) => t.seen))

type Follow = { lines: number; limit: string | null; ended: boolean; stop: () => void }

// Follows the pod's log as the Logs tab asks for it, from this process as the same account (its token): a browser keeps
// at most six connections to one host over HTTP/1.1, the kind gateway's, so twenty EventSources would wait there.
function follow(token: string): Follow {
  const abort = new AbortController()
  const f: Follow = { lines: 0, limit: null, ended: false, stop: () => abort.abort() }
  void (async () => {
    try {
      const res = await fetch(`${BASE}/api/v1/cluster/namespaces/${NS}/pods/${POD}/logs/stream?container=${POD}&tail_lines=5&cluster=${CLUSTER}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: abort.signal,
      })
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let event = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          if (line.startsWith('event: ')) event = line.slice(7)
          if (line.startsWith('data: ')) {
            if (event === 'stream-limit') f.limit = line.slice(6)
            else f.lines++
            event = ''
          }
        }
      }
    } catch { /* stopped */ }
    f.ended = true
  })()
  return f
}

test.describe('terminals and followed logs past an account\'s cap', () => {
  test.beforeAll(() => {
    test.skip(streamPods() !== 1, 'more than one pod takes terminals and followed logs: each counts its own, so the next one may go to another pod')
    MAX_TERMINALS = capOf('MAX_TERMINALS_PER_ACCOUNT', process.env.E2E_MAX_TERMINALS_PER_ACCOUNT)
    MAX_LOGS = capOf('MAX_FOLLOWED_LOGS_PER_ACCOUNT', process.env.E2E_MAX_FOLLOWED_LOGS_PER_ACCOUNT)
    test.skip(MAX_TERMINALS <= 0 && MAX_LOGS <= 0, 'both caps are 0 on this install: there is no cap to reach')
    kubectl(`-n ${NS} run ${POD} --image=busybox:1.37 --image-pull-policy=IfNotPresent --restart=Never --command -- sh -c 'for i in 1 2 3 4 5; do echo caps-line-$i; done; sleep 3600'`)
    kubectl(`-n ${NS} wait --for=condition=Ready pod/${POD} --timeout=120s`)
  })

  test.afterAll(() => {
    kubectl(`-n ${NS} delete pod ${POD} --ignore-not-found --wait=false`)
  })

  test('a terminal past the cap is refused, the terminal says why, and one closed lets a new one open', async ({ page, request }) => {
    test.skip(MAX_TERMINALS <= 0, 'multicluster.maxTerminalsPerAccount is 0 on this install: no cap')
    test.setTimeout(180_000)

    const raw = await page.context().newPage()
    await raw.goto('/color-mode.js')
    await openTerminals(raw, MAX_TERMINALS)
    await expect.poll(async () => {
      await reopenRefused(raw)
      return (await terminals(raw)).filter((t) => t.text.length > 0 && !t.closed).length
    }, { timeout: 60_000, intervals: [2_000] }).toBe(MAX_TERMINALS)
    const failedBefore = (await failedRows(request, 'k8s.pod.exec')).length // refusals while an earlier spec's terminal drained

    // One more, as the API sees it: closed with the code and reason the screen reads, no shell.
    await openTerminals(raw, 1)
    await expect.poll(async () => (await terminals(raw))[MAX_TERMINALS].closed, { timeout: 20_000 }).toEqual({ code: 4429, reason: 'terminal_limit' })
    expect((await terminals(raw))[MAX_TERMINALS].text).toBe('')

    // One more from the Pod drawer: the terminal says why and offers Reconnect.
    await page.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=${NS}&detail=${encodeURIComponent(`Pod/${NS}/${POD}`)}`)
    const drawer = page.locator(DRAWER).last()
    await drawer.getByTitle(tr('pods.exec.openExec')).first().click({ timeout: 20_000 })
    const rows = page.locator('.xterm-rows').last()
    await expect.poll(async () => squash((await rows.textContent()) || ''), { timeout: 20_000 }).toContain(squash(tr('serverShutdown.terminalLimit')))
    const reconnect = page.getByRole('button', { name: tr('serverShutdown.reconnect'), exact: true })
    await expect(reconnect).toHaveCount(1)

    const failed = await failedRows(request, 'k8s.pod.exec')
    expect(failed.length - failedBefore, JSON.stringify(failed)).toBe(2) // the socket above and the drawer's terminal
    for (const r of failed) expect(r.Error).toContain(`this account has ${MAX_TERMINALS} open on this server`)

    // One of the open terminals closes. The server gives its place back once the shell has hung up, a moment later, so
    // Reconnect is pressed again while the new attempt is refused; the one that opens answers an echo.
    await raw.evaluate(() => (window as unknown as { __terms: { ws: WebSocket }[] }).__terms[0].ws.close())
    await expect.poll(async () => (await terminals(raw))[0].closed !== null, { timeout: 10_000 }).toBe(true)
    const refusedText = squash(tr('serverShutdown.terminalLimit'))
    await expect.poll(async () => {
      const shown = squash((await rows.textContent()) || '')
      if (shown.includes(refusedText)) {
        await reconnect.click({ timeout: 2_000 }).catch(() => undefined)
        return 'refused'
      }
      return shown.includes(squash(tr('pods.exec.connected'))) ? 'open' : 'connecting'
    }, { timeout: 30_000, intervals: [1_000] }).toBe('open')
    const marker = `caps-ok-${STAMP}`
    await rows.click()
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    // the line typed (the terminal's echo) and the shell's answer
    await expect.poll(async () => ((await rows.textContent()) || '').split(marker).length - 1, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    expect(squash((await rows.textContent()) || '')).not.toContain(refusedText)

    await raw.evaluate(() => (window as unknown as { __terms: { ws: WebSocket }[] }).__terms.forEach((t) => t.ws.close()))
    await raw.close()
  })

  test('a followed log past the cap is refused, the Logs tab says why, and one closed lets a new one open', async ({ page, request }) => {
    test.skip(MAX_LOGS <= 0, 'multicluster.maxFollowedLogsPerAccount is 0 on this install: no cap')
    test.setTimeout(180_000)

    const token = await accessToken(request)
    const held = Array.from({ length: MAX_LOGS }, () => follow(token))
    try {
      await expect.poll(() => {
        // a stream an earlier spec left can hold its place for a moment after its page closed
        held.forEach((f, i) => { if (f.limit) held[i] = follow(token) })
        return held.filter((f) => f.lines >= 5 && !f.ended).length
      }, { timeout: 60_000, intervals: [2_000] }).toBe(MAX_LOGS)
      const failedBefore = (await failedRows(request, 'k8s.pod.logs.read')).length

      // One more, as the API sees it: the event alone, then the answer ends.
      const extra = follow(token)
      await expect.poll(() => extra.ended, { timeout: 20_000 }).toBe(true)
      expect(extra.limit).toBe('followed_log_limit')
      expect(extra.lines).toBe(0)

      // The Cluster View Logs tab says why in place of the lines.
      await page.goto(`/cluster-view?cluster=${CLUSTER}`)
      await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill(POD)
      await page.locator('div.card button', { hasText: POD }).first().click()
      const area = page.locator('pre.whitespace-pre-wrap').first()
      await expect(area).toContainText(`» ${tr('serverShutdown.followLimit')}`, { timeout: 20_000 })
      expect(await area.innerText()).not.toContain('caps-line-')

      const failed = await failedRows(request, 'k8s.pod.logs.read')
      expect(failed.length - failedBefore, JSON.stringify(failed)).toBe(2) // the stream above and the Logs tab
      for (const r of failed) expect(r.Error).toContain(`this account has ${MAX_LOGS} open on this server`)

      // One of them closes; the tab opened again follows the log.
      held[0].stop()
      await expect.poll(async () => {
        await page.reload()
        await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill(POD)
        await page.locator('div.card button', { hasText: POD }).first().click()
        await page.waitForTimeout(1_000)
        return (await page.locator('pre.whitespace-pre-wrap').first().innerText()).includes('caps-line-5')
      }, { timeout: 45_000, intervals: [3_000] }).toBe(true)
    } finally {
      held.forEach((f) => f.stop())
    }
  })
})
