import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'

// What the fault tests under e2e/fault share: the dev install's kubectl, sign-in, the pods of a Deployment, a
// port-forward to one pod, a probe that keeps sending requests and writes down every answer, and the restore steps.
// The kubeconfig comes from `kind get kubeconfig`, never from the shell's KUBECONFIG, so a run cannot reach a real
// cluster by accident.

export const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
export const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
export const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'
export const NS = process.env.E2E_FAULT_NAMESPACE || 'kubeast'
export const CLUSTER = 'self'
const KIND = process.env.E2E_FAULT_KIND || 'kubeast'
const REPO = path.join(__dirname, '..', '..')

export const STAMP = Date.now().toString(36)
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const kcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-fault-'))
export const KUBECONFIG = path.join(kcDir, 'kubeconfig')
fs.writeFileSync(KUBECONFIG, execFileSync('kind', ['get', 'kubeconfig', '--name', KIND], { encoding: 'utf8' }), { mode: 0o600 })

// kubectl on the install's cluster; input goes to stdin (a password never goes on a command line).
export function kubectl(args: string[], opts: { input?: string; timeout?: number } = {}): string {
  return execFileSync('kubectl', ['--kubeconfig', KUBECONFIG, '--context', `kind-${KIND}`, ...args], {
    encoding: 'utf8', input: opts.input, timeout: opts.timeout ?? 120_000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

export function kubectlOk(args: string[], opts: { input?: string; timeout?: number } = {}): { ok: boolean; out: string } {
  try {
    return { ok: true, out: kubectl(args, opts) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() }
  }
}

// Another kind cluster's kubeconfig as the install's pods reach it (`--internal`: the control-plane container's name).
export function internalKubeconfig(kind: string): string | null {
  try {
    return execFileSync('kind', ['get', 'kubeconfig', '--internal', '--name', kind], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}

// kubectl on another kind cluster (the one a test drains or registers), null when there is no such kind cluster.
export function kindKubectl(kind: string): ((args: string[], input?: string) => string) | null {
  let kc: string
  try {
    kc = execFileSync('kind', ['get', 'kubeconfig', '--name', kind], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    return null
  }
  const file = path.join(kcDir, `kubeconfig-${kind}`)
  fs.writeFileSync(file, kc, { mode: 0o600 })
  return (args, input) => execFileSync('kubectl', ['--kubeconfig', file, '--context', `kind-${kind}`, ...args], {
    encoding: 'utf8', input, timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

export const psql = (sql: string) => kubectl(['-n', NS, 'exec', 'deploy/postgres', '--', 'psql', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql])

export async function login(request: APIRequestContext, email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token as string
}

export type Pod = { name: string; ready: boolean; restarts: number; deleting: boolean; ip: string }

// The pods of one app label in the install's namespace.
export function podsOf(app: string): Pod[] {
  const raw = JSON.parse(kubectl(['-n', NS, 'get', 'pods', '-l', `app=${app}`, '-o', 'json'])) as {
    items: { metadata: { name: string; deletionTimestamp?: string }; status: { podIP?: string; conditions?: { type: string; status: string }[]; containerStatuses?: { restartCount: number }[] } }[]
  }
  return raw.items.map((p) => ({
    name: p.metadata.name,
    ready: !!p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
    restarts: (p.status.containerStatuses ?? []).reduce((n, c) => n + c.restartCount, 0),
    deleting: !!p.metadata.deletionTimestamp,
    ip: p.status.podIP ?? '',
  }))
}

export const readyPods = (app: string) => podsOf(app).filter((p) => p.ready && !p.deleting)

export function deploymentExists(name: string): boolean {
  return kubectlOk(['-n', NS, 'get', 'deploy', name, '-o', 'name']).ok
}

export function replicasOf(deploy: string): number {
  return Number(kubectl(['-n', NS, 'get', 'deploy', deploy, '-o', 'jsonpath={.spec.replicas}']) || '0')
}

// An env value of a Deployment's first container: the value itself, or the ConfigMap key it names (envFrom included).
export function envOf(deploy: string, name: string): string | undefined {
  const spec = JSON.parse(kubectl(['-n', NS, 'get', 'deploy', deploy, '-o', 'jsonpath={.spec.template.spec.containers[0]}'])) as {
    env?: { name: string; value?: string; valueFrom?: { configMapKeyRef?: { name: string; key: string } } }[]
    envFrom?: { configMapRef?: { name: string } }[]
  }
  const direct = spec.env?.find((e) => e.name === name)
  if (direct?.value !== undefined) return direct.value
  const fromMap = (map: string, key: string) => {
    const r = kubectlOk(['-n', NS, 'get', 'configmap', map, '-o', `jsonpath={.data.${key}}`])
    return r.ok && r.out !== '' ? r.out : undefined
  }
  if (direct?.valueFrom?.configMapKeyRef) return fromMap(direct.valueFrom.configMapKeyRef.name, direct.valueFrom.configMapKeyRef.key)
  for (const ref of spec.envFrom ?? []) {
    if (!ref.configMapRef) continue
    const v = fromMap(ref.configMapRef.name, name)
    if (v !== undefined) return v
  }
  return undefined
}

// Restart counts of every pod in the namespace that is not being deleted: "server restarts 0" compares two of these
// over the pods present in both.
export function restartCounts(): Record<string, number> {
  const raw = JSON.parse(kubectl(['-n', NS, 'get', 'pods', '-o', 'json'])) as {
    items: { metadata: { name: string; deletionTimestamp?: string }; status: { containerStatuses?: { restartCount: number }[] } }[]
  }
  return Object.fromEntries(raw.items.filter((p) => !p.metadata.deletionTimestamp)
    .map((p) => [p.metadata.name, (p.status.containerStatuses ?? []).reduce((n, c) => n + c.restartCount, 0)]))
}

export function restartsSince(before: Record<string, number>): Record<string, number> {
  const now = restartCounts()
  return Object.fromEntries(Object.entries(now).filter(([name, n]) => name in before && n > before[name]).map(([name, n]) => [name, n - before[name]]))
}

// SIGKILL as a crash does it: no preStop, no grace, no shutdown code of the server.
export function killPod(name: string): number {
  const at = Date.now()
  kubectl(['-n', NS, 'delete', 'pod', name, '--grace-period=0', '--force', '--wait=false'])
  return at
}

// A planned stop: preStop, SIGTERM, the server's own shutdown.
export function stopPod(name: string): number {
  const at = Date.now()
  kubectl(['-n', NS, 'delete', 'pod', name, '--wait=false'])
  return at
}

// What must be put back even when a run is cut: a test registers it before it breaks something and drops it once it
// is put back. It runs on the worker's exit and on SIGINT, SIGTERM and SIGHUP (Ctrl-C, a stopped runner), synchronously;
// when no one else listens for that signal it then ends the process as the signal would have.
const undo = new Map<string, () => unknown>()
export function atExit(label: string, fn: () => unknown): () => void {
  undo.set(label, fn)
  return () => { undo.delete(label) }
}
function runUndo() {
  for (const [label, fn] of [...undo]) {
    undo.delete(label)
    try { fn() } catch (e) { process.stderr.write(`fault cleanup "${label}" failed: ${(e as Error).message}\n`) }
  }
}
process.on('exit', runUndo)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  const on = () => {
    runUndo()
    if (process.listenerCount(sig) === 1) { process.removeListener(sig, on); process.kill(process.pid, sig) }
  }
  process.on(sig, on)
}

// Below the Kubernetes API: a kind node is a Docker container named after the node, and `docker exec <node> crictl|ctr`
// reaches the containers on it (`E2E_FAULT_DOCKER` for another client of the same API).
const DOCKER = process.env.E2E_FAULT_DOCKER || 'docker'
const run = (argv: string[], timeout = 30_000) => execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

export type Container = { pod: string; name: string; node: string; id: string; restarts: number }

// A pod's container (the one named after its app, else the first): the node it runs on and its containerd id.
export function containerOf(pod: string): Container {
  const p = JSON.parse(kubectl(['-n', NS, 'get', 'pod', pod, '-o', 'json'])) as {
    metadata: { labels?: Record<string, string> }
    spec: { nodeName: string }
    status: { containerStatuses?: { name: string; containerID?: string; restartCount: number }[] }
  }
  const all = p.status.containerStatuses ?? []
  const c = all.find((s) => s.name === p.metadata.labels?.app) ?? all[0]
  if (!c?.containerID) throw new Error(`${pod} has no running container`)
  return { pod, name: c.name, node: p.spec.nodeName, id: c.containerID.replace(/^[a-z]+:\/\//, ''), restarts: c.restartCount }
}

// SIGKILL from the container runtime with no SIGTERM before it, as a crash or the OOM killer ends a process:
// `crictl stop --timeout 0` makes containerd skip the stop signal ("Kill container" in its log, no "Stop container … with
// signal terminated"); the kubelet then starts the container again in the same pod. A force delete is not this: the
// kubelet still sends SIGTERM and kills 2 s later (README "How the faults are made").
export function killNoSignal(pod: string): { at: number; container: Container } {
  const container = containerOf(pod)
  const at = Date.now()
  run([DOCKER, 'exec', container.node, 'crictl', 'stop', '--timeout', '0', container.id])
  return { at, container }
}

// How a pod's container ended last time (lastState.terminated), and its restarts now.
export function lastEnd(pod: string, name: string): { exitCode?: number; reason?: string; restarts: number; ready: boolean } {
  const s = (JSON.parse(kubectl(['-n', NS, 'get', 'pod', pod, '-o', 'json'])) as {
    status: { containerStatuses?: { name: string; ready: boolean; restartCount: number; lastState?: { terminated?: { exitCode: number; reason?: string } } }[] }
  }).status.containerStatuses?.find((c) => c.name === name)
  return { exitCode: s?.lastState?.terminated?.exitCode, reason: s?.lastState?.terminated?.reason, restarts: s?.restartCount ?? 0, ready: !!s?.ready }
}

// A container to freeze in place: the cgroup freezer stops every process in it, its connections stay open and nothing
// answers on them. In the install: `ctr -n k8s.io task pause` on the kind node (the kubelet still reads it as running,
// so no probe-driven restart within the chart's PostgreSQL probes for 30 s). A database outside kind (a container of
// the external-database layout, E2E_FAULT_PG_DOCKER): `docker pause`.
export type FreezeTarget = { what: string; pause: string[]; resume: string[]; paused: () => boolean }

export function freezeTargetOf(deploy: string): FreezeTarget | string {
  const pod = readyPods(deploy)[0]
  if (!pod) return `no ready ${deploy} pod`
  const c = containerOf(pod.name)
  const ctr = (verb: string) => [DOCKER, 'exec', c.node, 'ctr', '-n', 'k8s.io', 'task', verb, c.id]
  try { run(ctr('ls').slice(0, -1)) } catch (e) { return `cannot reach ${c.node}'s containerd with ${DOCKER} exec: ${(e as Error).message.split('\n')[0]}` }
  return {
    what: `${deploy} container ${c.id.slice(0, 12)} on ${c.node}`,
    pause: ctr('pause'),
    resume: ctr('resume'),
    paused: () => run([DOCKER, 'exec', c.node, 'ctr', '-n', 'k8s.io', 'task', 'ls']).split('\n').some((l) => l.startsWith(c.id) && /\bPAUSED\b/.test(l)),
  }
}

export function dockerFreezeTarget(name: string): FreezeTarget {
  return {
    what: `docker container ${name}`,
    pause: [DOCKER, 'pause', name],
    resume: [DOCKER, 'unpause', name],
    paused: () => run([DOCKER, 'inspect', '-f', '{{.State.Paused}}', name]) === 'true',
  }
}

// Freezes the target and hands back thaw(), which resumes it and returns when. Until thaw has run the target is
// resumed by the worker's exit or a signal (atExit), and a detached process resumes it `seconds` + 30 s after the
// freeze even if this worker is killed outright.
export function freeze(t: FreezeTarget, seconds: number): { at: number; thaw: () => number } {
  const backstop = spawn('sh', ['-c', `sleep ${seconds + 30}; exec "$@"`, 'resume', ...t.resume], { detached: true, stdio: 'ignore' })
  backstop.unref()
  let thawedAt = 0
  const thaw = () => {
    if (thawedAt) return thawedAt
    drop()
    try { run(t.resume) } catch (e) { if (t.paused()) throw e }
    thawedAt = Date.now()
    try { process.kill(-backstop.pid!, 'SIGKILL') } catch { /* it ended already */ }
    if (t.paused()) throw new Error(`${t.what} is still paused after resume`)
    return thawedAt
  }
  const drop = atExit(`resume ${t.what}`, thaw)
  const at = Date.now()
  try {
    run(t.pause)
  } catch (e) {
    thaw()
    throw e
  }
  return { at, thaw }
}

export function scale(deploy: string, replicas: number) {
  kubectl(['-n', NS, 'scale', `deploy/${deploy}`, `--replicas=${replicas}`])
}

export function rolledOut(deploy: string, timeoutSeconds = 180) {
  kubectl(['-n', NS, 'rollout', 'status', `deploy/${deploy}`, `--timeout=${timeoutSeconds}s`], { timeout: (timeoutSeconds + 10) * 1000 })
}

// Scales a Deployment to 0 for `seconds` and back to what it had, waiting for its rollout; the restore runs even when
// the body throws.
export async function stopFor(deploy: string, seconds: number, during: () => Promise<void> = async () => {}) {
  const had = replicasOf(deploy)
  scale(deploy, 0)
  try {
    await Promise.all([sleep(seconds * 1000), during()])
  } finally {
    scale(deploy, had)
    rolledOut(deploy)
  }
}

export function serverLog(deploy: string, sinceIso: string): string {
  return kubectlOk(['-n', NS, 'logs', `deploy/${deploy}`, '--all-containers', `--since-time=${sinceIso}`]).out
}

export function podLog(pod: string, sinceIso: string): string {
  return kubectlOk(['-n', NS, 'logs', pod, '--all-containers', `--since-time=${sinceIso}`]).out
}

// A port-forward to one pod, so a request reaches that server and no other.
export type Forward = { port: number; close: () => void }
const forwards = new Set<ChildProcess>()
process.on('exit', () => forwards.forEach((p) => p.kill('SIGKILL')))

export async function forwardTo(pod: string, port: number): Promise<Forward> {
  const child = spawn('kubectl', ['--kubeconfig', KUBECONFIG, '--context', `kind-${KIND}`, '-n', NS, 'port-forward', `pod/${pod}`, `:${port}`, '--address', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] })
  forwards.add(child)
  const local = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`port-forward to ${pod} did not start`)), 15_000)
    child.stdout.on('data', (b: Buffer) => {
      const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(b.toString())
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`port-forward to ${pod} ended`)) })
  })
  return { port: local, close: () => { child.kill('SIGKILL'); forwards.delete(child) } }
}

// An API context on one pod (through its port-forward), signed in with token.
export async function onPod(f: Forward, token: string): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: `http://127.0.0.1:${f.port}`, extraHTTPHeaders: bearer(token) })
}

// One answer the probe wrote down. status 0 = no answer within the probe's timeout, or the connection broke.
export type Answer = { at: number; path: string; status: number; ms: number; error?: string }

// Sends a request every `everyMs` to each path in turn (about 10 a second at the default, as step 3 §6 asks) until
// stopped, each with its own timeout, and keeps every answer.
export class Probe {
  readonly answers: Answer[] = []
  private running = true
  private loop: Promise<void>
  private inFlight = new Set<Promise<void>>()

  constructor(private request: APIRequestContext, private paths: string[], private headers: Record<string, string>,
    private everyMs = 100, private timeoutMs = 10_000) {
    this.loop = this.run()
  }

  private async run() {
    let i = 0
    while (this.running) {
      const p = this.paths[i++ % this.paths.length]
      const started = Date.now()
      const one = this.request.get(p, { headers: this.headers, timeout: this.timeoutMs, failOnStatusCode: false })
        .then((res) => { this.answers.push({ at: started, path: p, status: res.status(), ms: Date.now() - started }) })
        .catch((e: Error) => { this.answers.push({ at: started, path: p, status: 0, ms: Date.now() - started, error: e.message.split('\n')[0] }) })
      this.inFlight.add(one)
      void one.finally(() => this.inFlight.delete(one))
      await sleep(this.everyMs)
    }
  }

  async stop(): Promise<Answer[]> {
    this.running = false
    await this.loop
    await Promise.all([...this.inFlight])
    return this.answers.sort((a, b) => a.at - b.at)
  }
}

export const notOk = (answers: Answer[], ok: (a: Answer) => boolean = (a) => a.status === 200) => answers.filter((a) => !ok(a))

// The answers as one line each, for a failure message.
export const show = (answers: Answer[], limit = 20) => answers.slice(0, limit)
  .map((a) => `${new Date(a.at).toISOString()} ${a.path} ${a.status} ${a.ms}ms${a.error ? ` ${a.error}` : ''}`).join('\n')

// Screen words come from the en catalog, so a wording change follows.
const EN: unknown = JSON.parse(fs.readFileSync(path.join(REPO, 'frontend/src/i18n/locales/en.json'), 'utf8'))
export function tr(key: string): string {
  const value = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), EN)
  if (typeof value !== 'string') throw new Error(`the en catalog has no ${key}`)
  return value
}

export const items = <T>(raw: unknown): T[] => (Array.isArray(raw) ? raw : ((raw as { items?: T[] })?.items ?? [])) as T[]

// A pod's live WebSocket subscriptions (k8s-service's gauge kubeast_ws_subscriptions on /metrics), through a
// port-forward: which server holds a page's live list is the one whose count went up when the page opened it.
export async function wsSubscriptions(f: Forward): Promise<number> {
  const text = await (await fetch(`http://127.0.0.1:${f.port}/metrics`)).text()
  const m = /^kubeast_ws_subscriptions(?:\{[^}]*\})?\s+(\S+)$/m.exec(text)
  return m ? Number(m[1]) : Number.NaN
}

// Each live list socket (`/wsMultiplexer`) a page opens — when it opened, its first frame, how it closed — kept on
// window.__mux by an init script, so a test reads whether a kill cut it and when a new one was open.
export type MuxSocket = { createdAt: number; openedAt?: number; firstFrameAt?: number; frames: number; closed?: { code: number; reason: string; at: number } }

export function watchListSockets() {
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
      this.addEventListener('message', () => { socket.frames += 1; socket.firstFrameAt ??= Date.now() })
      this.addEventListener('close', (e) => { socket.closed = { code: e.code, reason: e.reason, at: Date.now() } })
    }
  }
}

export const listSockets = (page: Page) => page.evaluate(() => (window as unknown as { __mux?: MuxSocket[] }).__mux ?? [])

// After a kill at `at`: the first list socket that closed then, and how long until a socket opened after it was open
// (null when none within `withinMs` of the close). cut is false when no socket closed.
export async function listSocketBack(page: Page, at: number, withinMs: number): Promise<{ cut: boolean; closedAt?: number; reopenMs: number | null; sockets: MuxSocket[] }> {
  const until = Date.now() + withinMs + 10_000
  for (;;) {
    const sockets = await listSockets(page)
    const cut = sockets.find((s) => s.closed && s.closed.at >= at - 500)
    if (cut) {
      const next = sockets.find((s) => s.createdAt >= cut.closed!.at - 50 && s.openedAt)
      if (next) return { cut: true, closedAt: cut.closed!.at, reopenMs: next.openedAt! - cut.closed!.at, sockets }
      if (Date.now() > cut.closed!.at + withinMs + 5_000) return { cut: true, closedAt: cut.closed!.at, reopenMs: null, sockets }
    } else if (Date.now() > at + 10_000) {
      return { cut: false, reopenMs: null, sockets }
    }
    if (Date.now() > until) return { cut: !!cut, closedAt: cut?.closed?.at, reopenMs: null, sockets }
    await sleep(250)
  }
}

// Answers of a probe around a kill: those that were not 200 before it, in the `graceMs` after it, and later.
export function aroundKill(answers: Answer[], at: number, graceMs: number, ok: (a: Answer) => boolean = (a) => a.status === 200) {
  const bad = answers.filter((a) => !ok(a))
  return {
    before: bad.filter((a) => a.at < at && a.at + a.ms < at),
    during: bad.filter((a) => !(a.at < at && a.at + a.ms < at) && a.at < at + graceMs),
    after: bad.filter((a) => a.at >= at + graceMs),
    window: bad.length ? { first: bad[0].at, last: Math.max(...bad.map((a) => a.at + a.ms)) } : null,
  }
}
