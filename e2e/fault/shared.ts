import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
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

// kubectl that leaves the worker's event loop running, for calls made while a Probe sends: kubectl() (execFileSync)
// holds the loop until it returns, so the Probe sends nothing meanwhile and the request it had started is timed with
// the whole wait added (four rollout restarts of auth-service held it 24 s, and a 200 sent before them read 24 281 ms).
export function kubectlAsync(args: string[], opts: { timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('kubectl', ['--kubeconfig', KUBECONFIG, '--context', `kind-${KIND}`, ...args], {
      encoding: 'utf8', timeout: opts.timeout ?? 120_000,
    }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())))
  })
}

export function kubectlOk(args: string[], opts: { input?: string; timeout?: number } = {}): { ok: boolean; out: string } {
  try {
    return { ok: true, out: kubectl(args, opts) }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() }
  }
}

// A cluster the install has not registered, as two kubeconfigs its pods can use: an admin credential and a
// ServiceAccount token that may get namespace kube-system and nothing else. auth-service takes a new kubeconfig only for
// the cluster a registration points at (kube-system UID), so the cluster change these tests make is a credential change.
export type RotationCluster = { admin: string; limited: string; limitedUser: string }
export const ROTATION_NEEDS = 'needs E2E_FAULT_ROTATE_ADMIN_KUBECONFIG, E2E_FAULT_ROTATE_SA_KUBECONFIG and E2E_FAULT_ROTATE_SA_USER: '
  + 'a cluster the install has not registered, as admin and as a ServiceAccount that may get namespace kube-system only (README "A cluster for the credential change")'
export function rotationCluster(): RotationCluster | null {
  const admin = process.env.E2E_FAULT_ROTATE_ADMIN_KUBECONFIG
  const limited = process.env.E2E_FAULT_ROTATE_SA_KUBECONFIG
  const limitedUser = process.env.E2E_FAULT_ROTATE_SA_USER
  if (!admin || !limited || !limitedUser) return null
  return { admin: fs.readFileSync(admin, 'utf8'), limited: fs.readFileSync(limited, 'utf8'), limitedUser }
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
  return podRows(kubectl(['-n', NS, 'get', 'pods', '-l', `app=${app}`, '-o', 'json']))
}

function podRows(json: string): Pod[] {
  const raw = JSON.parse(json) as {
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

// podsOf and readyPods while a Probe sends (kubectlAsync).
export const podsOfAsync = async (app: string) => podRows(await kubectlAsync(['-n', NS, 'get', 'pods', '-l', `app=${app}`, '-o', 'json']))
export const readyPodsAsync = async (app: string) => (await podsOfAsync(app)).filter((p) => p.ready && !p.deleting)

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

// A force delete: no preStop, and SIGKILL 2 s after SIGTERM (the kubelet's shortest grace) — killNoSignal sends no SIGTERM.
export function killPod(name: string): number {
  const at = Date.now()
  kubectl(['-n', NS, 'delete', 'pod', name, '--grace-period=0', '--force', '--wait=false'])
  return at
}

// killPod while a Probe sends (kubectlAsync).
export async function killPodAsync(name: string): Promise<number> {
  const at = Date.now()
  await kubectlAsync(['-n', NS, 'delete', 'pod', name, '--grace-period=0', '--force', '--wait=false'])
  return at
}

// A planned stop: preStop, SIGTERM, the server's own shutdown.
export function stopPod(name: string): number {
  const at = Date.now()
  kubectl(['-n', NS, 'delete', 'pod', name, '--wait=false'])
  return at
}

// What must be put back even when a run is cut: a test registers it before it breaks something and drops it once it
// is put back. A test's own `finally` does not run when Playwright interrupts it (Ctrl-C, a test timeout: the body is
// left where it waits), so the list also runs, synchronously, in each fault file's afterEach (`undoPending`), on the
// worker's exit and on SIGINT, SIGTERM and SIGHUP; when no one else listens for that signal the process then ends as
// the signal would have. What must survive the worker being killed outright also has a detached process (`whenGone`).
const undo = new Map<string, () => unknown>()
export function atExit(label: string, fn: () => unknown): () => void {
  undo.set(label, fn)
  return () => { undo.delete(label) }
}
export function undoPending() {
  for (const [label, fn] of [...undo]) {
    undo.delete(label)
    try { fn() } catch (e) { process.stderr.write(`fault cleanup "${label}" failed: ${(e as Error).message}\n`) }
  }
}
// last: the port-forwards and the kubeconfig copy (the cleanup above still uses them)
function leave() {
  forwards.forEach((p) => p.kill('SIGTERM'))
  fs.rmSync(kcDir, { recursive: true, force: true })
}
process.on('exit', () => { undoPending(); leave() })
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  const on = () => {
    undoPending()
    if (process.listenerCount(sig) === 1) { leave(); process.removeListener(sig, on); process.kill(process.pid, sig) }
  }
  process.on(sig, on)
}

// A detached process that runs each `kubectl <args>` in turn on a kind cluster (the install's unless named) once this
// worker is gone, however it went (SIGKILL too; it looks every 2 s), unless stopped first. It reads the kubeconfig from
// kind again, since the worker's copy goes with the worker.
const shq = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`
export function whenGone(commands: string[][], kind = KIND): () => void {
  const run = commands.map((c) => `kubectl --kubeconfig "$kc" --context ${shq(`kind-${kind}`)} ${c.map(shq).join(' ')}`).join('; ')
  const script = `while kill -0 "$PARENT" 2>/dev/null; do sleep 2; done; kc=$(mktemp) || exit 1; kind get kubeconfig --name ${shq(kind)} > "$kc" && { ${run}; }; rm -f "$kc"`
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore', env: { ...process.env, PARENT: String(process.pid) } })
  child.unref()
  return () => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* it ran already */ } }
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

// rolledOut while a Probe sends (kubectlAsync).
export async function rolledOutAsync(deploy: string, timeoutSeconds = 180) {
  await kubectlAsync(['-n', NS, 'rollout', 'status', `deploy/${deploy}`, `--timeout=${timeoutSeconds}s`], { timeout: (timeoutSeconds + 10) * 1000 })
}

// Scales a Deployment to 0 and waits until none of its pods is left (podsOf counts a pod being deleted, which still
// answers through its preStop and grace: the bundled Redis has no preStop, only the 30 s default grace), so what a
// test does "with it off" starts only then.
// The scale back is registered with atExit and given to whenGone before the scale to 0; bringBack scales back, waits
// for the rollout and returns when.
export async function takeDown(deploy: string, goneWithinMs = 120_000): Promise<{ offAt: number; bringBack: () => Promise<number> }> {
  // its kubectl goes through kubectlAsync: a Probe may be sending (stopFor)
  const had = Number(await kubectlAsync(['-n', NS, 'get', 'deploy', deploy, '-o', 'jsonpath={.spec.replicas}']) || '0')
  if (had < 1) throw new Error(`${deploy} is already at 0 replicas — left by an interrupted run? Scale it back first (README "After a run that stopped half way")`)
  const stopWatcher = whenGone([['-n', NS, 'scale', `deploy/${deploy}`, `--replicas=${had}`]])
  const drop = atExit(`scale ${deploy} back to ${had}`, () => { scale(deploy, had); stopWatcher() })
  let back: Promise<number> | null = null
  const bringBack = () => (back ??= (async () => {
    await kubectlAsync(['-n', NS, 'scale', `deploy/${deploy}`, `--replicas=${had}`])
    drop()
    stopWatcher()
    await rolledOutAsync(deploy)
    return Date.now()
  })())
  try {
    await kubectlAsync(['-n', NS, 'scale', `deploy/${deploy}`, '--replicas=0'])
    await expect.poll(async () => (await podsOfAsync(deploy)).length, { message: `every ${deploy} pod gone`, timeout: goneWithinMs, intervals: [250] }).toBe(0)
  } catch (e) {
    await bringBack()
    throw e
  }
  return { offAt: Date.now(), bringBack }
}

// takeDown, then `during(offAt)` and at least `seconds` from the moment the last pod was gone, then bringBack; the times
// it went off and came back are returned for the test's timeline.
export async function stopFor(deploy: string, seconds: number, during: (offAt: number) => Promise<void> = async () => {}): Promise<{ offAt: number; onAt: number }> {
  const down = await takeDown(deploy)
  try {
    await Promise.all([sleep(seconds * 1000), during(down.offAt)])
  } finally {
    await down.bringBack()
  }
  return { offAt: down.offAt, onAt: await down.bringBack() }
}

// Every pod of the service (the chart's app label), as a request may land on any replica; with a label kubectl prints
// only the last 10 lines of each unless --tail says otherwise.
export function serverLog(app: string, sinceIso: string): string {
  return kubectlOk(['-n', NS, 'logs', '-l', `app=${app}`, '--all-containers', '--prefix', '--tail=-1', `--since-time=${sinceIso}`]).out
}

export function podLog(pod: string, sinceIso: string): string {
  return kubectlOk(['-n', NS, 'logs', pod, '--all-containers', `--since-time=${sinceIso}`]).out
}

// podLog while a Probe sends (kubectlAsync); a failed read is empty.
export const podLogAsync = (pod: string, sinceIso: string) => kubectlAsync(['-n', NS, 'logs', pod, '--all-containers', `--since-time=${sinceIso}`]).catch(() => '')

// A port-forward to one pod, so a request reaches that server and no other. kubectl runs under a small shell that ends
// it when told (close, the worker's exit or signal) and also when the worker is gone however it went (it looks every
// second), so a killed worker leaves no port-forward behind.
export type Forward = { port: number; close: () => void }
const forwards = new Set<ChildProcess>()

export async function forwardTo(pod: string, port: number): Promise<Forward> {
  const script = 'kubectl "$@" & c=$!; trap \'kill $c 2>/dev/null; exit 0\' TERM INT HUP; '
    + 'while kill -0 "$PARENT" 2>/dev/null && kill -0 $c 2>/dev/null; do sleep 1; done; kill $c 2>/dev/null'
  const child = spawn('sh', ['-c', script, 'port-forward', '--kubeconfig', KUBECONFIG, '--context', `kind-${KIND}`, '-n', NS, 'port-forward', `pod/${pod}`, `:${port}`, '--address', '127.0.0.1'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PARENT: String(process.pid) } })
  forwards.add(child)
  const local = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`port-forward to ${pod} did not start`)), 15_000)
    child.stdout.on('data', (b: Buffer) => {
      const m = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(b.toString())
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`port-forward to ${pod} ended`)) })
  })
  return { port: local, close: () => { child.kill('SIGTERM'); forwards.delete(child) } }
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

// The gateway's NodePort as a kind node reaches it: the node (the container `docker exec` names) and the URL, or null
// when the gateway Service has no NodePort or the node no InternalIP.
export function gatewayOnNode(node: string): { node: string; url: string } | null {
  const port = kubectlOk(['-n', NS, 'get', 'svc', 'gateway', '-o', 'jsonpath={.spec.ports[0].nodePort}']).out
  const ip = kubectlOk(['get', 'node', node, '-o', 'jsonpath={.status.addresses[?(@.type=="InternalIP")].address}']).out
  return /^\d+$/.test(port) && /^[\d.]+$/.test(ip) ? { node, url: `http://${ip}:${port}` } : null
}

// $1 base URL, $2 seconds at most, $3 seconds between requests, $4 each request's timeout, $5 stop file, then the paths.
// The token comes on stdin and goes to a 0600 header file the script removes.
const NODE_PROBE_SCRIPT = `IFS= read -r t
umask 077
h=$(mktemp); printf 'Authorization: Bearer %s\\nX-Requested-With: XMLHttpRequest\\n' "$t" > "$h"; t=
base=$1; end=$(( $(date +%s) + $2 )); every=$3; tmo=$4; stop=$5; shift 5
i=0
while [ ! -e "$stop" ] && [ "$(date +%s)" -lt "$end" ]; do
  n=$(( i % $# + 1 )); eval p=\\\${$n}; i=$(( i + 1 ))
  ( at=$(date +%s%3N); r=$(curl -s -o /dev/null -m "$tmo" -H @"$h" -w '%{http_code} %{time_total}' "$base$p"); echo "$at $p $r $?" ) &
  sleep "$every"
done
wait
rm -f "$h" "$stop"`

// A Probe that sends from inside a kind node (curl through `docker exec`), for an address the laptop reaches only
// through Docker Desktop's published port, which takes a connection while nothing behind it answers and passes it on
// later: a slow 200 the node itself never sees (kind on Docker Desktop only). Its times are the node's clock, compared
// only with each other; it ends at stop() or after maxSeconds.
export class NodeProbe {
  private out = ''
  private readonly stopFile = `/tmp/e2e-fault-node-probe-${STAMP}-${Math.random().toString(36).slice(2, 8)}`
  private readonly done: Promise<void>
  private readonly undo: () => void

  constructor(private node: string, base: string, paths: string[], token: string, everyMs = 100, timeoutMs = 10_000, maxSeconds = 600) {
    const child = spawn(DOCKER, ['exec', '-i', node, 'sh', '-c', NODE_PROBE_SCRIPT, 'sh', base, String(maxSeconds), String(everyMs / 1000), String(timeoutMs / 1000), this.stopFile, ...paths], { stdio: ['pipe', 'pipe', 'ignore'] })
    child.stdout!.on('data', (b: Buffer) => { this.out += b.toString() })
    this.done = new Promise((resolve) => child.on('close', () => resolve()))
    child.stdin!.end(`${token}\n`)
    this.undo = atExit(`stop the node probe on ${node}`, () => run([DOCKER, 'exec', node, 'touch', this.stopFile]))
  }

  async stop(): Promise<Answer[]> {
    await new Promise<void>((resolve) => execFile(DOCKER, ['exec', this.node, 'touch', this.stopFile], () => resolve()))
    await this.done
    this.undo()
    return this.out.split('\n').flatMap((line) => {
      const [at, path, code, total, rc] = line.trim().split(' ')
      if (!rc) return []
      return [{ at: Number(at), path, status: Number(code), ms: Math.round(Number(total) * 1000), ...(rc !== '0' ? { error: `curl exit ${rc}` } : {}) }]
    }).sort((a, b) => a.at - b.at)
  }
}

export const notOk = (answers: Answer[], ok: (a: Answer) => boolean = (a) => a.status === 200) => answers.filter((a) => !ok(a))

// The longest time between two requests of a Probe (answers in send order). Well past its everyMs, something held the
// worker's event loop: nothing was sent then, and the answer on its way was timed with the hold added.
export const longestGap = (answers: Answer[]) => answers.reduce((m, a, i) => (i ? Math.max(m, a.at - answers[i - 1].at) : m), 0)

// The longest gap a test lets a Probe have: below the 5 s a test calls a hang, so a hold alone cannot make an answer
// read as one.
export const SEND_GAP_MS = 2_000
export function expectProbeKeptSending(answers: Answer[]) {
  expect(longestGap(answers), `ms between two requests of the probe (more than ${SEND_GAP_MS}: the worker's event loop was held)`).toBeLessThanOrEqual(SEND_GAP_MS)
}

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
