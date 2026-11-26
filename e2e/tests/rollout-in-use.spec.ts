import { execFile, execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { test, expect, type APIRequestContext, type Locator, type Page, type TestStepInfo } from '@playwright/test'
import { sessionToken } from './session-token'

// On `self`, k8s-service, then auth-service, then the gateway are rolled (kubectl rollout restart, each waited for) while
// a page holds a live list of the kubeast pods (Cluster View's node boxes watch them; the Pods page polls), a terminal and
// a followed log, and another context reads four routes about ten times a second. Held: every read answers 2xx within
// SLOW_MS; each closed list socket is answered again within 5 s and the boxes show each pod once, as kubectl lists them;
// the Logs tab shows each line once, as kubectl logs prints them; the terminal of the leaving k8s-service ends with the
// server's line and reason, and a fresh terminal answers after each rollout; each old pod is gone within its preStop and
// shutdown time, no container killed. A check the build cannot pass yet is skipped with the reason. Opt-in
// (E2E_ROLLOUT=1, project rollout): it restarts the install's services. The pod it makes is removed after; the
// Deployments keep the restartedAt annotation kubectl rollout restart writes.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'
const KUBEAST_NS = process.env.E2E_KUBEAST_NAMESPACE || 'kubeast'
const CLUSTER = 'self'
const NS = 'default'
const STAMP = Date.now().toString(36)
const POD = `e2e-rollout-${STAMP}`
const END_LINE = `rollout-end-${STAMP}`
const STORAGE = path.resolve(__dirname, '../.auth/user.json')

// in the order they are rolled
const DEPLOYS = ['k8s-service', 'auth-service', 'gateway'] as const
type Deploy = (typeof DEPLOYS)[number]

// k8s-service twice, auth-service twice, through the gateway with the page's session
const READ_ROUTES = [
  `/api/v1/cluster/pods/page?cluster=${CLUSTER}&namespace=${NS}&limit=5`,
  `/api/v1/cluster/namespaces?cluster=${CLUSTER}`,
  '/api/v1/clusters',
  '/api/v1/auth/me',
]
const READ_EVERY_MS = 100
const READ_ABORT_MS = 15_000
const SLOW_MS = 3_000
const RECONNECT_MS = 5_000
// a list reads itself again within 5 s of a RESYNC (useKubeWatchList RESYNC_READ_WITHIN_MS)
const LIST_SETTLE_MS = 12_000
const ROLLOUT_TIMEOUT_S = 300

// What a leaving server closes a socket with (services/pkg/probe) and the line its terminal ends with (lang=en); the
// stream server's drain ends a terminal with the same close and its own line.
const SHUTDOWN_CLOSE = { code: 1001, reason: 'server_shutdown' }
const LEAVING_NOTICE = /\[Kubeast\][^\r\n]*(the server is restarting|the server was replaced)/
const SESSION_ENDED_CLOSE_CODE = 4401

const kubeconfig = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-rollout-'))
const kcPath = path.join(kcDir, 'kubeconfig')
fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
const kubectl = (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
// While the rollouts run nothing blocks the event loop: the pod watch stamps its events on it.
const execFileAsync = promisify(execFile)
async function kubectlAsync(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync('kubectl', ['--kubeconfig', kcPath, ...args], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20 })
  return stdout.trim()
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function within(ms: number, ok: () => boolean | Promise<boolean>): Promise<boolean> {
  const until = Date.now() + ms
  for (;;) {
    if (await ok()) return true
    if (Date.now() >= until) return false
    await pause(250)
  }
}

type PodItem = {
  metadata: { name: string; deletionTimestamp?: string; labels?: Record<string, string> }
  spec?: { nodeName?: string }
  status?: { containerStatuses?: { name: string; state?: { terminated?: { exitCode: number; reason?: string } } }[] }
}

async function podsIn(selector: string[]): Promise<PodItem[]> {
  return (JSON.parse(await kubectlAsync(['-n', KUBEAST_NS, 'get', 'pods', ...selector, '-o', 'json'])) as { items: PodItem[] }).items
}
async function kubeastPods(): Promise<{ names: string[]; nodes: string[] }> {
  const items = await podsIn([])
  return { names: items.map((p) => p.metadata.name), nodes: [...new Set(items.map((p) => p.spec?.nodeName ?? '').filter(Boolean))] }
}

// What the install's Deployment gives a pod to leave in, and what its readiness asks.
type Facts = { preStopSeconds: number; graceSeconds: number; readinessPath: string }
function factsOf(deploy: Deploy): Facts {
  const spec = JSON.parse(kubectl(`-n ${KUBEAST_NS} get deploy ${deploy} -o json`)).spec.template.spec
  const container = spec.containers.find((c: { name: string }) => c.name === deploy) ?? spec.containers[0]
  const preStop = container.lifecycle?.preStop
  const slept = preStop?.sleep?.seconds ?? /\bsleep\s+(\d+)/.exec((preStop?.exec?.command ?? []).join(' '))?.[1] ?? 0
  return { preStopSeconds: Number(slept), graceSeconds: spec.terminationGracePeriodSeconds ?? 30, readinessPath: container.readinessProbe?.httpGet?.path ?? '' }
}

// worker_shutdown_timeout in the gateway's nginx.conf, in seconds; null without one (nginx waits for every connection).
function nginxShutdownSeconds(): number | null {
  const conf: string = JSON.parse(kubectl(`-n ${KUBEAST_NS} get configmap gateway-nginx -o json`)).data?.['nginx.conf'] ?? ''
  const m = /^\s*worker_shutdown_timeout\s+(\d+)(s|m)?\s*;/m.exec(conf)
  return m ? Number(m[1]) * (m[2] === 'm' ? 60 : 1) : null
}

// kubectl get --watch -o json writes one JSON object after another: each is handed on whole as it ends.
function jsonObjects(each: (value: unknown) => void) {
  let buf = ''
  let depth = 0
  let start = 0
  let inString = false
  let escaped = false
  return (chunk: string) => {
    let i = buf.length
    buf += chunk
    for (; i < buf.length; i++) {
      const c = buf[i]
      if (inString) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') inString = false
      } else if (c === '"') {
        inString = true
      } else if (c === '{') {
        if (depth++ === 0) start = i
      } else if (c === '}' && --depth === 0) {
        try {
          each(JSON.parse(buf.slice(start, i + 1)))
        } catch {
          // not an object kubectl wrote whole: the next one starts after it
        }
        buf = buf.slice(i + 1)
        i = -1
      }
    }
  }
}

// When each kubeast pod started to leave and was gone, and how its containers ended, as the watch delivers them.
type PodSeen = { app?: string; deletingAt?: number; deletedAt?: number; exits: Record<string, { exitCode: number; reason?: string }> }
function watchPods() {
  const pods = new Map<string, PodSeen>()
  let stderr = ''
  const child = spawn('kubectl', ['--kubeconfig', kcPath, '-n', KUBEAST_NS, 'get', 'pods', '--watch', '--output-watch-events', '-o', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', jsonObjects((value) => {
    const { type, object } = value as { type: string; object: PodItem }
    const name = object?.metadata?.name
    if (!name) return
    const seen = pods.get(name) ?? { app: object.metadata.labels?.app, exits: {} }
    if (object.metadata.deletionTimestamp && seen.deletingAt === undefined) seen.deletingAt = Date.now()
    for (const c of object.status?.containerStatuses ?? []) {
      const ended = c.state?.terminated
      if (ended) seen.exits[c.name] = { exitCode: ended.exitCode, reason: ended.reason }
    }
    if (type === 'DELETED') seen.deletedAt = Date.now()
    pods.set(name, seen)
  }))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => { stderr += d })
  return { pods, stderr: () => stderr, stop: () => { child.kill() } }
}
type PodWatch = ReturnType<typeof watchPods>

type MuxSocket = { createdAt: number; openedAt?: number; firstFrameAt?: number; frames: number; closed?: { code: number; reason: string; at: number } }

// Keeps each multiplexer socket the page opens — when it opened, its first frame, how it closed — on window.__mux.
function watchSockets() {
  const sockets: MuxSocket[] = []
  ;(window as unknown as { __mux: MuxSocket[] }).__mux = sockets
  const Native = window.WebSocket
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      if (!String(url).includes('/wsMultiplexer')) return
      const socket: MuxSocket = { createdAt: Date.now(), frames: 0 }
      sockets.push(socket)
      this.addEventListener('open', () => { socket.openedAt = Date.now() })
      this.addEventListener('message', () => {
        socket.frames += 1
        socket.firstFrameAt ??= Date.now()
      })
      this.addEventListener('close', (e) => { socket.closed = { code: e.code, reason: e.reason, at: Date.now() } })
    }
  }
}

type LogStream = { createdAt: number; opens: number[]; errors: { at: number; state: number }[] }

// Keeps each followed log's EventSource — its opens and its errors with the state they left — on window.__streams.
function watchStreams() {
  const streams: LogStream[] = []
  ;(window as unknown as { __streams: LogStream[] }).__streams = streams
  const Native = window.EventSource
  window.EventSource = class extends Native {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init)
      if (!String(url).includes('/logs/stream')) return
      const stream: LogStream = { createdAt: Date.now(), opens: [], errors: [] }
      streams.push(stream)
      this.addEventListener('open', () => stream.opens.push(Date.now()))
      this.addEventListener('error', () => stream.errors.push({ at: Date.now(), state: this.readyState }))
    }
  }
}

// The pod names each node's own view in Cluster View (?node=) shows, page by page: a box of the overview draws at most 12.
const nodeViews = new Map<string, Page>()
async function gridNames(page: Page, listed: { names: string[]; nodes: string[] }): Promise<string[]> {
  const names: string[] = []
  const most = Math.ceil(listed.names.length / 60) + 2
  for (const node of listed.nodes) {
    let view = nodeViews.get(node)
    if (!view) {
      view = nodeViews.size === 0 ? page : await page.context().newPage()
      nodeViews.set(node, view)
      await view.goto(`/cluster-view?cluster=${CLUSTER}&namespace=${KUBEAST_NS}&node=${encodeURIComponent(node)}`)
    }
    const pager = view.getByTestId('cluster-view-node-pods-pager')
    if ((await pager.count()) === 0) continue
    const turn = async (button: Locator) => {
      const was = await pager.innerText()
      await button.click({ timeout: 5_000 })
      return within(5_000, async () => (await pager.innerText()) !== was)
    }
    const prev = pager.getByRole('button', { name: /Prev|이전/ })
    const next = pager.getByRole('button', { name: /Next|다음/ })
    let moved = true
    for (let i = 0; moved && await prev.isEnabled(); i++) moved = i < most && await turn(prev)
    for (let i = 0; moved; i++) {
      names.push(...await view.locator('[data-testid="cluster-view-node"] [data-testid="cluster-view-pod"]').evaluateAll((cards) => cards.map((c) => c.querySelector('[title]')?.getAttribute('title') ?? '')))
      if (!(await next.isEnabled())) break
      moved = i < most && await turn(next)
    }
    if (!moved) names.push(`(the pages of ${node} did not turn)`)
  }
  return names
}
const twice = (names: string[]) => names.filter((n, i) => names.indexOf(n) !== i)
const sameOnce = (shown: string[], listed: string[]) => twice(shown).length === 0 && JSON.stringify([...shown].sort()) === JSON.stringify([...listed].sort())

type ListSeen = { shown: string[]; listed: string[]; settledMs: number | null }
async function listAgainstKubectl(page: Page): Promise<ListSeen> {
  const from = Date.now()
  let seen: ListSeen = { shown: [], listed: [], settledMs: null }
  await within(LIST_SETTLE_MS, async () => {
    const listed = await kubeastPods()
    const shown = await gridNames(page, listed)
    seen = { shown, listed: listed.names, settledMs: sameOnce(shown, listed.names) ? Date.now() - from : null }
    return seen.settledMs !== null
  })
  return seen
}

type Term = { text: string; openedAt?: number; closed?: { code: number; reason: string; at: number } }

// Opens a terminal on the pod as PodExecTerminal does and keeps what it showed and how it ended on window.__terms.
async function openTerminal(page: Page): Promise<number> {
  return page.evaluate(
    ({ ns, pod, cluster }) => {
      const w = window as unknown as { __terms?: Term[]; __termSockets?: WebSocket[] }
      const terms = (w.__terms ??= [])
      const sockets = (w.__termSockets ??= [])
      const seen: Term = { text: '' }
      const decoder = new TextDecoder()
      // kubectl run names the container after the pod.
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/cluster/namespaces/${ns}/pods/${pod}/exec/ws?container=${pod}&command=/bin/sh&cluster=${cluster}&lang=en`)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => { seen.openedAt = Date.now() }
      ws.onmessage = (e) => { seen.text += typeof e.data === 'string' ? e.data : decoder.decode(new Uint8Array(e.data).slice(1)) }
      ws.onclose = (e) => { seen.closed = { code: e.code, reason: e.reason, at: Date.now() } }
      terms.push(seen)
      sockets.push(ws)
      return terms.length - 1
    },
    { ns: NS, pod: POD, cluster: CLUSTER },
  )
}
const terminalAt = (page: Page, n: number) => page.evaluate((i) => (window as unknown as { __terms: Term[] }).__terms[i], n)
const closeTerminal = (page: Page, n: number) => page.evaluate((i) => (window as unknown as { __termSockets: WebSocket[] }).__termSockets[i].close(), n)

// Whether terminal n prints back a line it is sent.
async function answers(page: Page, n: number, marker: string, ms = 15_000): Promise<boolean> {
  const out = new RegExp(`(^|\\n)${marker}\\r?\\n`)
  // a fresh one is still connecting: the line goes once it is open
  if (!(await within(ms, async () => { const t = await terminalAt(page, n); return Boolean(t.openedAt || t.closed) })) || (await terminalAt(page, n)).closed) return false
  await page.evaluate(({ i, line }) => (window as unknown as { __termSockets: WebSocket[] }).__termSockets[i].send(line), { i: n, line: `echo ${marker}\r` })
  return within(ms, async () => out.test((await terminalAt(page, n)).text))
}

type Read = { route: string; at: number; status: number; ms: number; error?: string }
const failedRead = (r: Read) => r.status < 200 || r.status > 299 || Boolean(r.error)

// Sends a GET every READ_EVERY_MS from the page, round the routes, and keeps each answer's status and time on window.
async function startReads(page: Page) {
  await page.evaluate(
    ({ routes, everyMs, abortMs }) => {
      const w = window as unknown as { __reads: Read[]; __readsSent: number; __stopReads: () => void }
      w.__reads = []
      w.__readsSent = 0
      let next = 0
      const timer = setInterval(() => {
        const route = routes[next++ % routes.length]
        const at = Date.now()
        const started = performance.now()
        const abort = new AbortController()
        const cut = setTimeout(() => abort.abort(), abortMs)
        const done = (status: number, error?: string) => w.__reads.push({ route, at, status, ms: Math.round(performance.now() - started), ...(error ? { error } : {}) })
        w.__readsSent += 1
        fetch(route, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, cache: 'no-store', signal: abort.signal })
          .then(async (res) => {
            try {
              await res.arrayBuffer()
              done(res.status)
            } catch (e) {
              done(res.status, `answer cut: ${String(e)}`)
            }
          })
          .catch((e) => done(0, abort.signal.aborted ? `no answer in ${abortMs} ms` : String(e)))
          .finally(() => clearTimeout(cut))
      }, everyMs)
      w.__stopReads = () => clearInterval(timer)
    },
    { routes: READ_ROUTES, everyMs: READ_EVERY_MS, abortMs: READ_ABORT_MS },
  )
}
const readsSoFar = (page: Page) => page.evaluate(() => (window as unknown as { __reads: Read[] }).__reads)
async function stopReads(page: Page): Promise<Read[]> {
  await page.evaluate(() => (window as unknown as { __stopReads: () => void }).__stopReads())
  await within(READ_ABORT_MS + 5_000, () => page.evaluate(() => {
    const w = window as unknown as { __reads: Read[]; __readsSent: number }
    return w.__reads.length >= w.__readsSent
  }))
  return readsSoFar(page)
}

type Row = { Action: string; TargetID: string; After: Record<string, unknown> | null }

async function auditRows(request: APIRequestContext, action: string, since: string): Promise<Row[]> {
  const login = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(login.ok(), 'admin login').toBeTruthy()
  const headers = { Authorization: `Bearer ${sessionToken(login)}`, 'X-Requested-With': 'XMLHttpRequest' }
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers, params: { cluster: '', limit: '100', action, since } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()).items || []) as Row[]
}

// A check the install's build cannot pass yet is skipped with its reason, in its step and on the test.
function skipUnless(step: TestStepInfo, ok: boolean, reason: string) {
  if (ok) return
  test.info().annotations.push({ type: 'skip', description: reason })
  step.skip(true, reason)
}

type Step = {
  deploy: Deploy
  oldPods: string[]
  newPods: string[]
  startedAt: number
  rolledAt?: number
  doneAt?: number
  rollout: string
  list?: ListSeen
  // the terminal open as the rollout started: how it ended, its last text, and whether it still answered; then a fresh one
  terminal: { closed?: Term['closed']; text: string; keptAnswers: boolean | null; freshAnswers: boolean }
}

test.describe('rolling the install\'s services while it is in use', () => {
  let facts = {} as Record<Deploy, Facts>
  let nginxShutdown: number | null = null
  let streamServer = false
  let watch: PodWatch | null = null

  test.beforeAll(() => {
    facts = Object.fromEntries(DEPLOYS.map((d) => [d, factsOf(d)])) as Record<Deploy, Facts>
    nginxShutdown = nginxShutdownSeconds()
    streamServer = kubectl(`-n ${KUBEAST_NS} get deploy -o name`).split('\n').includes('deployment.apps/k8s-service-stream')
    kubectl(`-n ${NS} run ${POD} --image=busybox:1.37 --image-pull-policy=IfNotPresent --restart=Never --command -- sh -c 'i=0; while [ ! -e /tmp/stop ]; do i=$((i+1)); echo rollout-line-$i; sleep 1; done; echo ${END_LINE}; sleep 3600'`)
    kubectl(`-n ${NS} wait --for=condition=Ready pod/${POD} --timeout=120s`)
  })

  test.afterAll(() => {
    watch?.stop()
    kubectl(`-n ${NS} delete pod ${POD} --ignore-not-found --wait=false`)
    // a run cut short leaves no Deployment halfway through its rollout
    for (const d of DEPLOYS) {
      try {
        kubectl(`-n ${KUBEAST_NS} rollout status deploy/${d} --timeout=${ROLLOUT_TIMEOUT_S}s`)
      } catch {
        // the test reports a rollout that did not finish
      }
    }
    fs.rmSync(kcDir, { recursive: true, force: true })
  })

  test('k8s-service, auth-service and the gateway roll one after another under a live list, a terminal, a followed log and reads', async ({ page, browser, request }) => {
    test.setTimeout(25 * 60_000)
    const since = new Date(Date.now() - 2000).toISOString()
    const readsContext = await browser.newContext({ baseURL: BASE, storageState: STORAGE, viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    try {
      watch = watchPods()
      await expect.poll(() => watch!.pods.size, { message: 'the pod watch lists the kubeast pods', timeout: 20_000 }).toBeGreaterThan(0)

      // the live list: Cluster View's own view of each node the kubeast pods are on, as kubectl lists them
      await page.addInitScript(watchSockets)
      await expect.poll(async () => {
        const listed = await kubeastPods()
        return sameOnce(await gridNames(page, listed), listed.names)
      }, { message: 'the boxes show the kubeast pods', timeout: 30_000 }).toBe(true)

      // the followed log: the Logs tab of the pod's card
      const logs = await page.context().newPage()
      await logs.addInitScript(watchStreams)
      await logs.goto(`/cluster-view?cluster=${CLUSTER}`)
      await expect(logs.getByRole('heading', { name: /클러스터 뷰|Cluster view/i })).toBeVisible({ timeout: 15_000 })
      await logs.getByPlaceholder(/Search pod name|Pod 이름/i).fill(POD)
      await logs.getByTestId('cluster-view-node').locator('button').filter({ hasText: POD }).first().click()
      const area = logs.locator('pre.whitespace-pre-wrap').first()
      await expect(area).toContainText('rollout-line-1', { timeout: 20_000 })

      // the terminal
      const term = await page.context().newPage()
      await term.goto('/color-mode.js')
      let current = await openTerminal(term)
      expect(await answers(term, current, `rollout-first-${STAMP}`, 20_000), 'the first terminal answers').toBe(true)

      // the reads, healthy before any rollout
      const reader = await readsContext.newPage()
      await reader.goto('/color-mode.js')
      await startReads(reader)
      const readsFrom = Date.now()
      await reader.waitForTimeout(5_000)
      const baseline = await readsSoFar(reader)
      expect(baseline.length, 'reads in the first 5 s').toBeGreaterThanOrEqual(30)
      expect(baseline.filter(failedRead), 'reads before any rollout').toEqual([])

      const steps: Step[] = []
      for (const [n, deploy] of DEPLOYS.entries()) {
        const oldPods = (await podsIn(['-l', `app=${deploy}`])).filter((p) => !p.metadata.deletionTimestamp).map((p) => p.metadata.name)
        const step: Step = { deploy, oldPods, newPods: [], startedAt: Date.now(), rollout: '', terminal: { text: '', keptAnswers: null, freshAnswers: false } }
        steps.push(step)
        await kubectlAsync(['-n', KUBEAST_NS, 'rollout', 'restart', `deploy/${deploy}`])
        step.rollout = await kubectlAsync(['-n', KUBEAST_NS, 'rollout', 'status', `deploy/${deploy}`, `--timeout=${ROLLOUT_TIMEOUT_S}s`], (ROLLOUT_TIMEOUT_S + 30) * 1000)
          .catch((e: { stderr?: string; message?: string }) => `not rolled out: ${e.stderr || e.message}`)
        step.rolledAt = Date.now()
        expect(step.rollout, `kubectl rollout status deploy/${deploy}`).toContain('successfully rolled out')
        // the old pods leave in their own time: preStop, the shutdown, at most the grace period
        await within((facts[deploy].graceSeconds + 30) * 1000, () => oldPods.every((name) => watch!.pods.get(name)?.deletedAt !== undefined))
        step.doneAt = Date.now()
        step.newPods = (await podsIn(['-l', `app=${deploy}`])).map((p) => p.metadata.name)
        step.list = await listAgainstKubectl(page)

        const before = await terminalAt(term, current)
        step.terminal.closed = before.closed
        step.terminal.text = before.text.slice(-500)
        if (!before.closed) step.terminal.keptAnswers = await answers(term, current, `rollout-kept-${n}-${STAMP}`)
        const fresh = await openTerminal(term)
        step.terminal.freshAnswers = await answers(term, fresh, `rollout-fresh-${n}-${STAMP}`, 20_000)
        if (!before.closed) await closeTerminal(term, current)
        current = fresh
      }

      const reads = await stopReads(reader)
      const readsTo = Date.now()
      const mux = await page.evaluate(() => (window as unknown as { __mux: MuxSocket[] }).__mux)
      const streams = await logs.evaluate(() => (window as unknown as { __streams: LogStream[] }).__streams)

      // the pod ends its log with a line of its own; then the tab is held to kubectl logs
      await kubectlAsync(['-n', NS, 'exec', POD, '--', 'touch', '/tmp/stop'])
      const logEnded = await within(20_000, async () => (await area.innerText()).includes(END_LINE))
      const shown = (await area.innerText()).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\S+\s/, ''))
      const printed = (await kubectlAsync(['-n', NS, 'logs', POD])).split('\n').map((l) => l.trim()).filter(Boolean)
      watch.stop()

      const during = (at: number) => steps.find((s) => at >= s.startedAt && at <= (s.doneAt ?? Number.POSITIVE_INFINITY))?.deploy ?? 'between rollouts'
      // a socket that opened and closed, and the first later one that got a frame (an attempt refused on the way is not it)
      const closes = mux.filter((s) => s.openedAt !== undefined && s.closed).map((s) => {
        const closed = s.closed!
        const next = mux.find((o) => o.createdAt >= closed.at && o.firstFrameAt !== undefined)
        return { code: closed.code, reason: closed.reason, during: during(closed.at), answeredAgainMs: next?.firstFrameAt ? next.firstFrameAt - closed.at : null }
      })
      const leftPods = Object.fromEntries(steps.flatMap((s) => s.oldPods).map((name) => [name, watch!.pods.get(name) ?? null]))
      await test.info().attach('rollout-in-use.json', {
        body: JSON.stringify({ facts, nginxShutdown, streamServer, steps, closes, mux, streams, leftPods, reads }, null, 2),
        contentType: 'application/json',
      })

      await test.step('every read answered 2xx within SLOW_MS through the three rollouts', async (step) => {
        const without = DEPLOYS.filter((d) => facts[d].preStopSeconds <= 0)
        skipUnless(step, without.length === 0, `no preStop wait on ${without.join(', ')} (podShutdown.preStopSeconds): a leaving pod still takes requests while its endpoint goes`)
        const seconds = (readsTo - readsFrom) / 1000
        const failed = reads.filter(failedRead).map((r) => ({ ...r, during: during(r.at) }))
        const slow = reads.filter((r) => r.ms > SLOW_MS).map((r) => ({ ...r, during: during(r.at) }))
        expect.soft(reads.length, `reads sent in ${Math.round(seconds)} s`).toBeGreaterThanOrEqual(Math.floor((seconds * 1000 / READ_EVERY_MS) * 0.7))
        expect.soft(failed, `${failed.length} of ${reads.length} reads answered other than 2xx`).toEqual([])
        expect.soft(slow, `${slow.length} of ${reads.length} reads took past ${SLOW_MS} ms`).toEqual([])
      })

      await test.step('each closed list socket is answered again within 5 s, and the boxes show each pod once, as kubectl lists them', async () => {
        // the socket is k8s-service's, which the first rollout replaces
        expect.soft(closes.length, 'list socket closes').toBeGreaterThan(0)
        const late = closes.filter((c) => c.code === SESSION_ENDED_CLOSE_CODE || c.answeredAgainMs === null || c.answeredAgainMs > RECONNECT_MS)
        expect.soft(late, `list socket closes: ${JSON.stringify(closes)}`).toEqual([])
        for (const s of steps) {
          const seen = s.list ?? { shown: [], listed: [], settledMs: null }
          expect.soft({ shown: [...seen.shown].sort(), twice: twice(seen.shown) }, `the boxes within ${LIST_SETTLE_MS / 1000} s after the old ${s.deploy} pods left`)
            .toEqual({ shown: [...seen.listed].sort(), twice: [] })
        }
      })

      await test.step('the list socket of the leaving k8s-service closes with the server\'s reason', async (step) => {
        skipUnless(step, facts['k8s-service'].readinessPath === '/readyz', `k8s-service's readiness asks ${facts['k8s-service'].readinessPath || 'nothing'}, not /readyz: this build does not close its sockets with ${SHUTDOWN_CLOSE.code} ${SHUTDOWN_CLOSE.reason} as it leaves`)
        expect.soft(closes.filter((c) => c.during === 'k8s-service').map(({ code, reason }) => ({ code, reason }))).toEqual([SHUTDOWN_CLOSE])
      })

      await test.step('the Logs tab follows through the rollouts with each line once, as kubectl logs prints them', async () => {
        const history = `its streams: ${JSON.stringify(streams)}`
        expect.soft(logEnded, `the tab shows ${END_LINE}, which the pod printed after the last rollout; ${history}`).toBe(true)
        expect.soft(twice(shown), `lines shown twice; ${history}`).toEqual([])
        const from = printed.indexOf(shown[0])
        expect.soft(from, `the tab's first line ${JSON.stringify(shown[0])} is in kubectl logs`).toBeGreaterThanOrEqual(0)
        expect.soft(shown, `the tab against kubectl logs from its first line; ${history}`).toEqual(printed.slice(Math.max(from, 0)))
      })

      await test.step('the terminal of the leaving k8s-service shows the server\'s line, closes with its reason and leaves a k8s.session.end row', async (step) => {
        skipUnless(step, !streamServer, 'terminals run on k8s-service-stream (streams.enabled): the k8s-service rollout does not hold them')
        skipUnless(step, facts['k8s-service'].readinessPath === '/readyz', `k8s-service's readiness asks ${facts['k8s-service'].readinessPath || 'nothing'}, not /readyz: this build does not tell a terminal it leaves`)
        const k8s = steps.find((s) => s.deploy === 'k8s-service')!.terminal
        expect.soft(k8s.closed ? { code: k8s.closed.code, reason: k8s.closed.reason } : null).toEqual(SHUTDOWN_CLOSE)
        expect.soft(k8s.text, 'what the terminal showed last').toMatch(LEAVING_NOTICE)
        const ends = (await auditRows(request, 'k8s.session.end', since)).filter((r) => r.TargetID === POD && r.After?.stream === 'exec')
        expect.soft(ends.map((r) => r.After)).toEqual([{ stream: 'exec', reason: SHUTDOWN_CLOSE.reason }])
      })

      await test.step('a fresh terminal answers after each rollout, and the one open across the auth-service rollout stays open', async () => {
        expect.soft(steps.map((s) => ({ deploy: s.deploy, fresh: s.terminal.freshAnswers }))).toEqual(DEPLOYS.map((d) => ({ deploy: d, fresh: true })))
        const auth = steps.find((s) => s.deploy === 'auth-service')!.terminal
        expect.soft({ closed: auth.closed ?? null, answers: auth.keptAnswers }, 'the terminal open as auth-service rolled').toEqual({ closed: null, answers: true })
      })

      for (const s of steps) {
        await test.step(`the old ${s.deploy} pods are gone within preStop and their shutdown time, none killed`, async (step) => {
          const { preStopSeconds, graceSeconds } = facts[s.deploy]
          if (s.deploy === 'gateway') {
            skipUnless(step, nginxShutdown !== null && nginxShutdown < graceSeconds - preStopSeconds, `the gateway's nginx.conf has no worker_shutdown_timeout below its ${graceSeconds - preStopSeconds} s of shutdown: nginx holds an open WebSocket until the grace period kills it`)
          }
          // the grace period is the preStop wait and the 30 s the shutdown fits in; a container killed at its end exits 137
          const left = s.oldPods.map((name) => {
            const seen = watch!.pods.get(name)
            return {
              name,
              tookMs: seen?.deletingAt !== undefined && seen.deletedAt !== undefined ? seen.deletedAt - seen.deletingAt : null,
              killed: Object.entries(seen?.exits ?? {}).filter(([, x]) => x.exitCode === 137).map(([c, x]) => `${c} ${x.reason ?? ''}`.trim()),
            }
          })
          expect.soft(s.oldPods.length, `old ${s.deploy} pods`).toBeGreaterThan(0)
          expect.soft(s.newPods.filter((name) => s.oldPods.includes(name)), `${s.deploy} pods after the rollout`).toEqual([])
          expect.soft(left.filter((p) => p.tookMs === null || p.tookMs > graceSeconds * 1000 || p.killed.length > 0),
            `within ${graceSeconds} s (preStop ${preStopSeconds} s + shutdown ${graceSeconds - preStopSeconds} s): ${JSON.stringify(left)}; watch: ${watch!.stderr() || 'no error'}`).toEqual([])
        })
      }
    } finally {
      await readsContext.close()
    }
  })
})
