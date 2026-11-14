import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test'

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
