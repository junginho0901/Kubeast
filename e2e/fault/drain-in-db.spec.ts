import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test'

import {
  CLUSTER, NS, Probe, STAMP, aroundKill, atExit, bearer, whenGone, deploymentExists, dockerFreezeTarget, envOf, expectProbeKeptSending, forwardTo, freeze, freezeTargetOf,
  killNoSignal, killPod, kindKubectl, kubectl, kubectlOk, lastEnd, listSocketBack, listSockets, login, onPod, psql, readyPods, restartCounts,
  restartsSince, rolledOut, show, sleep, stopFor, stopPod, undoPending, watchListSockets, wsSubscriptions, type Answer, type Forward, type FreezeTarget,
} from './shared'

// PR #858 (drain progress in the database): node_drains holds each drain's progress, its owner (the server running
// it) refreshes a heartbeat every 5 s, and an open row whose heartbeat is 20 s old reads as interrupted on any replica
// (the drain window polls every second, so about 21 s); a server that shuts down marks its own drains at once. The
// status answer lists the drain's nodes the cluster still has cordoned (`cordoned_nodes`).
//
// Step 3 §6 test 4 (start on server A, read on server B), test 5 / step 4 F-7 (the owner dies mid-drain: "interrupted"
// within 30 s, the node left cordoned and said so, Start again works) and F-9 (PostgreSQL off 60 s: no server restart,
// what a signed-in reader still sees written down, recovery without a restart, no audit row lost — writes during the
// outage are refused).
//
// W6-1 is test 5 with a kill no shutdown sees (SIGKILL from the container runtime, no SIGTERM: the drain is found stale,
// "stopped answering") while the same server also holds a terminal and the page's live list, read through the gateway.
// Q-52 freezes PostgreSQL 20 s and 30 s mid-drain (connections open, no answers; E2E_FAULT_FREEZE_SECONDS sets other
// seconds): the drain goes on.
//
// The drain runs on the kind cluster test2 (one node, as the action suite drains it): a namespace of the run holds one
// pod under a PodDisruptionBudget that refuses its eviction, so the drain keeps retrying (5 min) and stays open while a
// server is killed. The namespace is deleted and the node uncordoned after every case, also when the run is cut (atExit).
// Tests 4, 5 and W6-1 skip without two ready k8s-service pods; F-9 skips when PostgreSQL keeps no volume (stopping it
// would lose the dev database); Q-52 skips without a PostgreSQL to freeze.

const DRAIN_CLUSTER = process.env.E2E_FAULT_DRAIN_CLUSTER || 'test2'
const DRAIN_KIND = process.env.E2E_FAULT_DRAIN_KIND || 'test2'
const INTERRUPTED_WITHIN_MS = 30_000 // step 3 test 5 / step 4 F-7; the PR's own number is 20 s stale + 1 s poll
const K8S = 'k8s-service'
const remote = kindKubectl(DRAIN_KIND)
// W6-1 (step 3 §6 test 11, step 4 F-5): only requests the dead server held fail, none from 3 s after the kill; the live
// list's socket is open again within 5 s.
const STALE_WITHIN_MS = 3_000
const RECONNECT_MS = 5_000
// A recording's owner beats every 15 s; another process takes the row once the beat is 60 s old, looking every 30 s.
const RECORDING_TAKEN_WITHIN_MS = 150_000
// What k8s-service logs when it gets SIGTERM (cmd/server/main.go).
const SHUTDOWN_LINE = 'shutting down server'
const LIST_READS = [
  `/api/v1/cluster/pods/page?cluster=${CLUSTER}&namespace=${NS}&limit=5`,
  `/api/v1/cluster/overview?cluster=${CLUSTER}`,
  `/api/v1/cluster/nodes?cluster=${CLUSTER}`,
  `/api/v1/cluster/namespaces?cluster=${CLUSTER}`,
]
// Q-52: frozen 20 s, then 30 s, or the seconds of E2E_FAULT_FREEZE_SECONDS (comma-separated, e.g. `45` for a freeze past
// the 30 s statement_timeout); every read 200 within 30 s of the thaw; no request still waiting 10 s after it (a first
// line, to be set again from the first run).
// The drain gives up 5 min after it starts (node_drain.go) and the case removes its PDB only after the freeze, 30 s and
// the health check's write, so a freeze longer than FREEZE_MAX_SECONDS would end the drain before that.
const FREEZE_MAX_SECONDS = 180
const FREEZE_SECONDS = freezeSecondsOf(process.env.E2E_FAULT_FREEZE_SECONDS)

function freezeSecondsOf(value: string | undefined): number[] {
  if (!value?.trim()) return [20, 30]
  const listed = value.split(',').map((s) => s.trim())
  const wrong = listed.filter((s) => !/^\d+$/.test(s) || Number(s) < 1 || Number(s) > FREEZE_MAX_SECONDS)
  if (wrong.length > 0) throw new Error(`E2E_FAULT_FREEZE_SECONDS takes whole seconds from 1 to ${FREEZE_MAX_SECONDS}, comma-separated; not ${wrong.map((s) => JSON.stringify(s)).join(', ')}`)
  return [...new Set(listed.map(Number))]
}
const PG_DOCKER = process.env.E2E_FAULT_PG_DOCKER || ''
const READS_BACK_MS = 30_000
const HUNG_AFTER_THAW_MS = 10_000
const FREEZE_READS = [
  `/api/v1/cluster/pods/page?cluster=${CLUSTER}&namespace=${NS}&limit=5`,
  '/api/v1/clusters',
  `/api/v1/sessions?cluster=${CLUSTER}`,
  '/api/v1/auth/me',
]

type Status = { id: string; node: string; status: string; message?: string; pods_total?: number; pods_done?: number; cordoned_nodes?: string[] | null }
type Row = { Action: string; Result: string; Error: string; TargetID: string; After: Record<string, unknown> | null }

// A run cut half way still deletes the namespace and uncordons the node: atExit (Ctrl-C, a timeout through the
// afterEach, the worker's exit), and whenGone on test2 when the worker is killed outright.
const held = new Map<string, () => void>()

function holdNode(ns: string): string {
  const node = remote!(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}'])
  const stopWatcher = whenGone([['delete', 'namespace', ns, '--ignore-not-found', '--wait=false'], ['uncordon', node]], DRAIN_KIND)
  const drop = atExit(`delete namespace ${ns} on ${DRAIN_KIND} and uncordon ${node}`, () => {
    try { remote!(['delete', 'namespace', ns, '--ignore-not-found', '--wait=false']) } finally { remote!(['uncordon', node]); stopWatcher() }
  })
  held.set(ns, () => { drop(); stopWatcher() })
  remote!(['apply', '-f', '-'], `apiVersion: v1
kind: Namespace
metadata: {name: ${ns}, labels: {kubeast.io/e2e: w6-drain}}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: held, namespace: ${ns}}
spec:
  replicas: 1
  selector: {matchLabels: {app: held}}
  template:
    metadata: {labels: {app: held}}
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: held
          image: busybox:1.37
          imagePullPolicy: IfNotPresent
          command: ["sleep", "3600"]
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: {name: held, namespace: ${ns}}
spec:
  minAvailable: 1
  selector: {matchLabels: {app: held}}
`)
  remote!(['-n', ns, 'rollout', 'status', 'deploy/held', '--timeout=120s'])
  return node
}

function release(ns: string, node: string) {
  try { remote!(['delete', 'namespace', ns, '--ignore-not-found', '--wait=true', '--timeout=120s']) } catch { /* the uncordon below still runs */ }
  remote!(['uncordon', node])
  held.get(ns)?.()
  held.delete(ns)
}

const cordoned = (node: string) => remote!(['get', 'node', node, '-o', 'jsonpath={.spec.unschedulable}']) === 'true'
const heldPods = (ns: string) => remote!(['-n', ns, 'get', 'pods', '-l', 'app=held', '-o', 'jsonpath={.items[*].metadata.name}']).split(/\s+/).filter(Boolean)

// On one k8s-service pod (through its port-forward) the routes start at /api/v1; through the gateway at /api/v1/cluster.
const ON_POD = '/api/v1'
const VIA_GATEWAY = '/api/v1/cluster'

async function startDrain(api: APIRequestContext, node: string, prefix = ON_POD, headers: Record<string, string> = {}): Promise<string> {
  const res = await api.post(`${prefix}/nodes/${node}/drain?cluster=${DRAIN_CLUSTER}`, { headers: { 'X-Requested-With': 'XMLHttpRequest', ...headers }, failOnStatusCode: false })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).drain_id as string
}

async function statusOf(api: APIRequestContext, node: string, id: string, prefix = ON_POD, headers: Record<string, string> = {}, timeout = 5_000): Promise<{ code: number; body: Status | null }> {
  const res = await api.get(`${prefix}/nodes/${node}/drain/status?drain_id=${id}&cluster=${DRAIN_CLUSTER}`, { headers, timeout, failOnStatusCode: false })
  return { code: res.status(), body: res.ok() ? ((await res.json()) as Status) : null }
}

async function auditRows(request: APIRequestContext, token: string, action: string, since: string): Promise<Row[]> {
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: bearer(token), params: { cluster: '', limit: '100', action, since } })
  expect(res.ok(), `audit read: ${res.status()}`).toBeTruthy()
  return ((await res.json()).items || []) as Row[]
}

test.describe('drain progress in the database (PR #858)', () => {
  test.describe.configure({ mode: 'serial' })

  test.afterEach(() => undoPending())

  test.beforeEach(() => {
    test.skip(!remote, `needs the kind cluster ${DRAIN_KIND} registered as ${DRAIN_CLUSTER} (scripts/add-kind-cluster.sh test2)`)
  })

  test('test 4: a drain started on one server reads the same on another', async ({ request }) => {
    test.skip(readyPods(K8S).length < 2, 'needs two ready k8s-service pods (replicas.k8sService: 2 once M-7 lets the chart render it)')
    test.setTimeout(240_000)
    const token = await login(request)
    const [a, b] = readyPods(K8S).map((p) => p.name)
    const ns = `e2e-w6-drain4-${STAMP}`
    const node = holdNode(ns)
    const forwards: Forward[] = []
    try {
      const fa = await forwardTo(a, 8002); forwards.push(fa)
      const fb = await forwardTo(b, 8002); forwards.push(fb)
      const onA = await onPod(fa, token)
      const onB = await onPod(fb, token)
      const id = await startDrain(onA, node)
      // once the drain has counted the node's pods, both servers answer the same row
      await expect.poll(async () => (await statusOf(onA, node, id)).body?.pods_total ?? null, { timeout: 30_000 }).not.toBeNull()
      const fromA = (await statusOf(onA, node, id)).body
      const fromB = await statusOf(onB, node, id)
      expect(fromB.code, `${b} answers the drain ${a} started`).toBe(200)
      expect({ ...fromB.body, cordoned_nodes: undefined }).toEqual({ ...fromA, cordoned_nodes: undefined })
      expect(fromB.body!.status).toBe('draining')
    } finally {
      forwards.forEach((f) => f.close())
      release(ns, node)
    }
  })

  test('test 5 / F-7: the server running a drain is killed — interrupted within 30 s on the other, the node left cordoned and named, Start again works', async ({ request }) => {
    test.skip(readyPods(K8S).length < 2, 'needs two ready k8s-service pods (replicas.k8sService: 2 once M-7 lets the chart render it)')
    test.setTimeout(360_000)
    const token = await login(request)
    const [a, b] = readyPods(K8S).map((p) => p.name)
    const ns = `e2e-w6-drain5-${STAMP}`
    const node = holdNode(ns)
    const since = new Date(Date.now() - 2_000).toISOString()
    const forwards: Forward[] = []
    try {
      const fa = await forwardTo(a, 8002); forwards.push(fa)
      const fb = await forwardTo(b, 8002); forwards.push(fb)
      const onA = await onPod(fa, token)
      const onB = await onPod(fb, token)
      const id = await startDrain(onA, node)
      await expect.poll(async () => (await statusOf(onB, node, id)).body?.status, { timeout: 30_000 }).toBe('draining')
      expect(cordoned(node), 'the drain cordoned the node').toBe(true)

      const killedAt = killPod(a)
      let interruptedAt = 0
      let last: Status | null = null
      while (Date.now() - killedAt < INTERRUPTED_WITHIN_MS + 15_000) {
        last = (await statusOf(onB, node, id)).body
        if (last?.status === 'interrupted') { interruptedAt = Date.now(); break }
        await sleep(1_000)
      }
      test.info().annotations.push({ type: 'interrupted after', description: interruptedAt ? `${interruptedAt - killedAt} ms` : 'not within the wait' })
      expect(last?.status, `status read on ${b} after ${a} was killed`).toBe('interrupted')
      expect(interruptedAt - killedAt, 'ms from the kill to "interrupted"').toBeLessThanOrEqual(INTERRUPTED_WITHIN_MS)
      // a force delete still gives the process a SIGTERM about 2 s before SIGKILL (the kubelet's shortest grace), so the
      // server may mark its drain on the way out ("shut down") before the others find the heartbeat stale ("stopped
      // answering"); either reason says the drain's server went
      test.info().annotations.push({ type: 'reason', description: last?.message ?? '' })
      expect(/stopped answering|shut down/.test(last?.message ?? ''), `the reason names the server that went: ${last?.message}`).toBe(true)
      expect(last?.cordoned_nodes, 'the answer names the node left cordoned').toEqual([node])
      expect(cordoned(node), 'the node is still cordoned').toBe(true)
      // nothing evicts any more: the held pod stays where it was
      expect(heldPods(ns).length, 'the PDB-held pod is still there').toBe(1)

      // one finished row for the drain, written by the replica that found it
      await expect.poll(async () => (await auditRows(request, token, 'k8s.node.drain', since))
        .filter((r) => r.After?.drain_id === id && r.After?.phase === 'finished')
        .map((r) => `${r.Result} ${r.TargetID} ${r.After?.status}`), { timeout: 30_000 })
        .toEqual([`failure ${node} interrupted`])

      // Start again, on the server that is left
      const again = await startDrain(onB, node)
      expect(again, 'a new drain id').not.toBe(id)
      await expect.poll(async () => (await statusOf(onB, node, again)).body?.status, { timeout: 30_000 }).toBe('draining')
    } finally {
      forwards.forEach((f) => f.close())
      release(ns, node)
      rolledOut(K8S)
    }
  })

  test('F-7 planned: the server running a drain is stopped (SIGTERM) — it marks its own drain interrupted on its way out', async ({ request }) => {
    test.skip(readyPods(K8S).length < 2, 'needs two ready k8s-service pods (replicas.k8sService: 2 once M-7 lets the chart render it)')
    test.setTimeout(300_000)
    const token = await login(request)
    const [a, b] = readyPods(K8S).map((p) => p.name)
    const ns = `e2e-w6-drain5s-${STAMP}`
    const node = holdNode(ns)
    const forwards: Forward[] = []
    try {
      const fa = await forwardTo(a, 8002); forwards.push(fa)
      const fb = await forwardTo(b, 8002); forwards.push(fb)
      const onA = await onPod(fa, token)
      const onB = await onPod(fb, token)
      const id = await startDrain(onA, node)
      await expect.poll(async () => (await statusOf(onB, node, id)).body?.status, { timeout: 30_000 }).toBe('draining')
      const grace = Number(kubectl(['-n', NS, 'get', 'pod', a, '-o', 'jsonpath={.spec.terminationGracePeriodSeconds}']) || '30')
      const stoppedAt = stopPod(a)
      await expect.poll(async () => (await statusOf(onB, node, id)).body?.status, { timeout: grace * 1000 }).toBe('interrupted')
      test.info().annotations.push({ type: 'interrupted after', description: `${Date.now() - stoppedAt} ms (grace ${grace} s)` })
      const last = (await statusOf(onB, node, id)).body
      expect(last?.message ?? '', 'the reason names a server that shut down').toContain('shut down')
      expect(last?.cordoned_nodes).toEqual([node])
    } finally {
      forwards.forEach((f) => f.close())
      release(ns, node)
      rolledOut(K8S)
    }
  })

  test('W6-1: the server running a drain, a terminal and the page\'s live list is killed with no SIGTERM — reads error 0 from 3 s, the list is back within 5 s, the drain reads interrupted within 30 s on the other, no shutdown ran, the recording is taken over', async ({ page, request, browser }) => {
    test.skip(readyPods(K8S).length < 2, 'needs two ready k8s-service pods (replicas.k8sService: 2 once M-7 lets the chart render it)')
    test.setTimeout(600_000)
    const token = await login(request)
    const pods = readyPods(K8S).map((p) => p.name)
    const ns = `e2e-w6-nosig-${STAMP}`
    const target = `e2e-w6-nosig-${STAMP}`
    const since = new Date(Date.now() - 2_000).toISOString()
    const forwards: Forward[] = []
    const contexts: BrowserContext[] = []
    const timeline: Record<string, number | string | null> = {}
    let probe: Probe | null = null
    let answers: Answer[] = []
    let node = ''
    kubectl(['-n', 'default', 'run', target, '--image=busybox:1.37', '--image-pull-policy=IfNotPresent', '--restart=Never', '--command', '--', 'sleep', '3600'])
    const unrun = atExit(`delete pod default/${target}`, () => kubectl(['-n', 'default', 'delete', 'pod', target, '--ignore-not-found', '--wait=false']))
    try {
      kubectl(['-n', 'default', 'wait', '--for=condition=Ready', `pod/${target}`, '--timeout=120s'])
      node = holdNode(ns)
      const fwd: Record<string, Forward> = {}
      for (const p of pods) { fwd[p] = await forwardTo(p, 8002); forwards.push(fwd[p]) }

      // the page's live list, and the server that holds it: its subscriptions went up when the page opened the list
      const subsBefore = Object.fromEntries(await Promise.all(pods.map(async (p) => [p, await wsSubscriptions(fwd[p])] as const)))
      await page.addInitScript(watchListSockets)
      await page.goto(`/cluster-view?cluster=${CLUSTER}&namespace=${NS}`)
      await expect.poll(async () => (await listSockets(page)).some((s) => s.firstFrameAt), { message: 'the page\'s live list answers', timeout: 30_000 }).toBe(true)
      await sleep(3_000)
      const subsAfter = Object.fromEntries(await Promise.all(pods.map(async (p) => [p, await wsSubscriptions(fwd[p])] as const)))
      const rise = (p: string) => subsAfter[p] - subsBefore[p]
      const victim = pods.reduce((best, p) => (rise(p) > rise(best) ? p : best), pods[0])
      const other = pods.find((p) => p !== victim)!
      test.info().annotations.push({ type: 'killed', description: `${victim} (live list subscriptions +${rise(victim)}; ${other} +${rise(other)})` })
      expect([...Object.values(subsBefore), ...Object.values(subsAfter)].every(Number.isFinite), 'every k8s-service pod reports kubeast_ws_subscriptions on /metrics').toBe(true)
      expect(rise(victim), 'the subscriptions of one server went up when the page opened its live list').toBeGreaterThan(0)

      // a drain and a terminal on that server
      const onA = await onPod(fwd[victim], token)
      const onB = await onPod(fwd[other], token)
      const id = await startDrain(onA, node)
      await expect.poll(async () => (await statusOf(onB, node, id)).body?.status, { timeout: 30_000 }).toBe('draining')
      const termCtx = await browser.newContext({ baseURL: `http://127.0.0.1:${fwd[victim].port}` })
      contexts.push(termCtx)
      await termCtx.addCookies([{ name: 'kubeast.token', value: token, url: `http://127.0.0.1:${fwd[victim].port}` }])
      const term = await termCtx.newPage()
      await term.goto('/health')
      await term.evaluate(({ pod }) => {
        const w = window as unknown as { __term: { text: string; closed?: { code: number; at: number } } }
        w.__term = { text: '' }
        const ws = new WebSocket(`ws://${location.host}/api/v1/namespaces/default/pods/${pod}/exec/ws?container=${pod}&command=/bin/sh&cluster=self&lang=en`)
        ws.binaryType = 'arraybuffer'
        const decoder = new TextDecoder()
        ws.onmessage = (e) => { w.__term.text += typeof e.data === 'string' ? e.data : decoder.decode(new Uint8Array(e.data).slice(1)) }
        ws.onclose = (e) => { w.__term.closed = { code: e.code, at: Date.now() } }
      }, { pod: target })
      await expect.poll(() => term.evaluate(() => (window as unknown as { __term: { text: string } }).__term.text.length), { message: `a terminal on ${victim}`, timeout: 20_000 }).toBeGreaterThan(0)
      const recordingOn = !!psql(`SELECT count(*) FROM session_recordings WHERE target = '${target}' AND kind = 'exec'`).match(/^[1-9]/)
      const recordingBefore = recordingOn ? psql(`SELECT status || ' ' || COALESCE(owner, '') FROM session_recordings WHERE target = '${target}' AND kind = 'exec' ORDER BY started_at DESC LIMIT 1`) : ''

      const restartsBefore = restartCounts()
      probe = new Probe(request, LIST_READS, bearer(token), 100, 10_000)
      await sleep(5_000)
      const { at: killedAt, container } = killNoSignal(victim)
      timeline.killed = new Date(killedAt).toISOString()

      // ③ the drain, read on the server that is left
      let interruptedAt = 0
      let last: Status | null = null
      while (Date.now() - killedAt < INTERRUPTED_WITHIN_MS + 15_000) {
        last = (await statusOf(onB, node, id).catch(() => ({ code: 0, body: null }))).body
        if (last?.status === 'interrupted') { interruptedAt = Date.now(); break }
        await sleep(1_000)
      }
      timeline.drainInterruptedMs = interruptedAt ? interruptedAt - killedAt : null
      // ② the live list
      const list = await listSocketBack(page, killedAt, RECONNECT_MS)
      timeline.listReopenMs = list.reopenMs
      // ④ the container back in the same pod
      let readyAt = 0
      while (Date.now() - killedAt < 180_000) {
        const now = lastEnd(victim, container.name)
        if (now.ready && now.restarts > container.restarts) { readyAt = Date.now(); break }
        await sleep(1_000)
      }
      timeline.readyAgainMs = readyAt ? readyAt - killedAt : null
      await sleep(5_000)
      answers = await probe.stop()
      probe = null
      const end = lastEnd(victim, container.name)
      const previous = kubectlOk(['-n', NS, 'logs', victim, '-c', container.name, '--previous', '--tail=200']).out
      // ⑥ the terminal's recording row, which the dead process held
      let recordingAfter = ''
      if (recordingOn) {
        const until = killedAt + RECORDING_TAKEN_WITHIN_MS
        while (Date.now() < until) {
          recordingAfter = psql(`SELECT status || ' ' || COALESCE(owner, '') FROM session_recordings WHERE target = '${target}' AND kind = 'exec' ORDER BY started_at DESC LIMIT 1`)
          if (!/^(recording|uploading) /.test(recordingAfter)) { timeline.recordingTakenMs = Date.now() - killedAt; break }
          await sleep(5_000)
        }
      }
      const around = aroundKill(answers, killedAt, STALE_WITHIN_MS)
      timeline.errorWindow = around.window ? `${around.window.first - killedAt}..${around.window.last - killedAt} ms` : null
      test.info().attach('answers.json', { body: JSON.stringify(answers), contentType: 'application/json' })
      test.info().attach('timeline.json', { body: JSON.stringify({ ...timeline, victim, other, recordingBefore, recordingAfter, lastEnd: end, sockets: list.sockets }, null, 2), contentType: 'application/json' })
      // the 3 s and 5 s lines sit near the system's own times (one upstream in nginx, endpoint updates, the list's
      // reconnect backoff): a first red run is judged from these before anything changes (README "First runs")
      test.info().attach('errors-around-kill.json', { body: JSON.stringify(around, null, 2), contentType: 'application/json' })
      test.info().attach('killed-container-previous-log.txt', { body: previous, contentType: 'text/plain' })

      // ① reads
      expect(around.before.map((a) => `${a.path} ${a.status}`), 'reads that failed before the kill').toEqual([])
      expect(around.after.length, `reads not 200 from ${STALE_WITHIN_MS} ms after the kill:\n${show(around.after)}`).toBe(0)
      // ② the live list
      expect(list.cut, 'the page\'s live list socket on the killed server closed').toBe(true)
      expect(list.reopenMs, 'ms from its close to a new socket open').not.toBeNull()
      expect(list.reopenMs!, 'ms from its close to a new socket open').toBeLessThanOrEqual(RECONNECT_MS)
      // ③ the drain: interrupted within 30 s, by a server that found the heartbeat stale (no shutdown marked it)
      expect(last?.status, `status read on ${other} after ${victim} was killed`).toBe('interrupted')
      expect(interruptedAt - killedAt, 'ms from the kill to "interrupted"').toBeLessThanOrEqual(INTERRUPTED_WITHIN_MS)
      expect(last?.message ?? '', 'the reason is a server that stopped answering, not one that shut down').toContain('stopped answering')
      expect(last?.cordoned_nodes, 'the answer names the node left cordoned').toEqual([node])
      expect(cordoned(node), 'the node is still cordoned').toBe(true)
      // ④ no SIGTERM, no shutdown, the container back in its pod, the others untouched
      expect({ exitCode: end.exitCode, restarted: end.restarts - container.restarts }, `${victim}'s container ended by SIGKILL and started again once`).toEqual({ exitCode: 137, restarted: 1 })
      expect(previous, 'the killed server ran no shutdown (k8s-service logs it on SIGTERM)').not.toContain(SHUTDOWN_LINE)
      expect(readyAt, `${victim} ready again`).toBeGreaterThan(0)
      expect(Object.keys(restartsSince(restartsBefore)).filter((p) => p !== victim), 'restarts of the pods that were not killed').toEqual([])
      // ⑤ audit: one finished drain row; no session end said server_shutdown
      await expect.poll(async () => (await auditRows(request, token, 'k8s.node.drain', since))
        .filter((r) => r.After?.drain_id === id && r.After?.phase === 'finished')
        .map((r) => `${r.Result} ${r.TargetID} ${r.After?.status}`), { timeout: 30_000 })
        .toEqual([`failure ${node} interrupted`])
      const ends = (await auditRows(request, token, 'k8s.session.end', since)).filter((r) => r.TargetID === target)
      expect(ends.filter((r) => r.After?.reason === 'server_shutdown').length, 'session ends of the terminal recorded as server_shutdown').toBe(0)
      // ⑥ the recording row is not left held by the dead process
      if (recordingOn) {
        expect(recordingAfter.split(' ')[0], `the terminal's recording within ${RECORDING_TAKEN_WITHIN_MS} ms of the kill (was "${recordingBefore}")`).toMatch(/^(interrupted|uploaded)$/)
      } else {
        test.info().annotations.push({ type: 'not checked', description: 'the recording takeover: sessionRecording is off (no row for the terminal)' })
      }
    } finally {
      if (probe) await probe.stop()
      for (const c of contexts) await c.close()
      forwards.forEach((f) => f.close())
      if (node) release(ns, node)
      kubectl(['-n', 'default', 'delete', 'pod', target, '--ignore-not-found', '--wait=false'])
      unrun()
      rolledOut(K8S)
    }
  })

  test('F-9: PostgreSQL off for 60 s — no server restarts, a drain start is refused while it is off, reads recover by themselves, no accepted write lacks its audit row', async ({ request }) => {
    const volume = kubectl(['-n', NS, 'get', 'deploy', 'postgres', '-o', "jsonpath={.spec.template.spec.volumes[?(@.name=='data')].persistentVolumeClaim.claimName}"])
    test.skip(!volume, 'PostgreSQL keeps no PersistentVolumeClaim (external database or none): stopping it is not this test')
    test.setTimeout(600_000)
    const token = await login(request)
    const headers = bearer(token)
    const ns = `e2e-w6-pgoff-${STAMP}`
    const node = holdNode(ns)
    const since = new Date(Date.now() - 2_000).toISOString()
    const before = restartCounts()
    const reads = [
      `/api/v1/cluster/pods/page?cluster=${CLUSTER}&namespace=${NS}&limit=5`,
      `/api/v1/cluster/overview?cluster=${CLUSTER}`,
      `/api/v1/cluster/nodes?cluster=${DRAIN_CLUSTER}`,
      '/api/v1/clusters',
      `/api/v1/sessions?cluster=${CLUSTER}`,
    ]
    const writes: { name: string; status: number; at: number }[] = []
    let drainDuring = 0
    let probe: Probe | null = null
    let left: string[] = []
    let outage: { offAt: number; onAt: number } | null = null
    let answers: Answer[] = []
    const maps = Array.from({ length: 10 }, (_, i) => `w6-pgoff-${STAMP}-${i}`)
    for (const name of maps) remote!(['-n', ns, 'create', 'configmap', name, '--from-literal=k=v'])
    try {
      probe = new Probe(request, reads, headers, 100, 10_000)
      await sleep(5_000)
      // 60 s from the moment the PostgreSQL pod is gone, up to about 63 s with the 3 s pause after the last delete; a delete starts only while its whole 15 s wait fits
      outage = await stopFor('postgres', 60, async (offAt) => {
        await sleep(10_000)
        const drain = await request.post(`/api/v1/cluster/nodes/${node}/drain?cluster=${DRAIN_CLUSTER}`, { headers, failOnStatusCode: false, timeout: 15_000 }).catch(() => null)
        drainDuring = drain?.status() ?? 0
        // a ConfigMap delete on test2 every 3 s while it is off: refused (the ConfigMap stays), or done with its row
        for (const name of maps) {
          const left = 60_000 - (Date.now() - offAt)
          if (left < 15_000) break
          const at = Date.now()
          const res = await request.delete(`/api/v1/cluster/namespaces/${ns}/configmaps/${name}?cluster=${DRAIN_CLUSTER}`, { headers, failOnStatusCode: false, timeout: 15_000 }).catch(() => null)
          writes.push({ name, status: res?.status() ?? 0, at })
          await sleep(3_000)
        }
      })
      // recovery: every read answers 200 again without a restart
      await expect.poll(async () => {
        const codes = await Promise.all(reads.map(async (p) => (await request.get(p, { headers, failOnStatusCode: false, timeout: 10_000 }).catch(() => null))?.status() ?? 0))
        return codes.every((c) => c === 200)
      }, { message: 'every read answers 200 after PostgreSQL is back', timeout: 120_000, intervals: [2_000] }).toBe(true)
    } finally {
      answers = probe ? await probe.stop() : []
      test.info().attach('reads-during-outage.json', { body: JSON.stringify(answers), contentType: 'application/json' })
      // what a signed-in reader still saw, per route (written down, not a pass line: step 4 F-9)
      const byPath = Object.fromEntries(reads.map((p) => [p, answers.filter((a) => a.path === p).reduce<Record<string, number>>((m, a) => ({ ...m, [a.status]: (m[a.status] ?? 0) + 1 }), {})]))
      test.info().attach('reads-by-route.json', { body: JSON.stringify(byPath, null, 2), contentType: 'application/json' })
      test.info().attach('timeline.json', { body: JSON.stringify({ postgresGone: outage ? new Date(outage.offAt).toISOString() : null, postgresBack: outage ? new Date(outage.onAt).toISOString() : null, offMs: outage ? outage.onAt - outage.offAt : null, drainDuring, writes: writes.map((w) => ({ ...w, at: new Date(w.at).toISOString() })) }, null, 2), contentType: 'application/json' })
      try { left = remote!(['-n', ns, 'get', 'configmaps', '-o', 'jsonpath={.items[*].metadata.name}']).split(/\s+/).filter(Boolean) } catch { left = [] }
      release(ns, node)
    }

    // stopFor's kubectl leaves the probe sending while PostgreSQL goes and comes back
    expectProbeKeptSending(answers)
    expect(restartsSince(before), 'restarts of the pods that stayed (PostgreSQL itself is replaced)').toEqual({})
    expect(drainDuring, 'a drain start while PostgreSQL was off is refused with 503 (its progress cannot be saved)').toBe(503)
    const accepted = writes.filter((w) => w.status >= 200 && w.status < 300).map((w) => w.name)
    test.info().annotations.push({ type: 'writes during the outage', description: writes.map((w) => `${w.name}=${w.status}`).join(' ') })
    expect(writes.length, 'deletes sent during the outage').toBeGreaterThan(0)
    const rows = await auditRows(request, token, 'k8s.configmap.delete', since)
    const recorded = rows.filter((r) => r.Result === 'success').map((r) => r.TargetID)
    expect(accepted.filter((n) => !recorded.includes(n)), 'deletes accepted during the outage with no audit row').toEqual([])
    // a refused delete changed nothing, an accepted one took the ConfigMap away
    expect(writes.filter((w) => w.status === 503 && !left.includes(w.name)).map((w) => w.name), 'refused deletes whose ConfigMap is gone').toEqual([])
    expect(accepted.filter((n) => left.includes(n)), 'accepted deletes whose ConfigMap is still there').toEqual([])
    expect(writes.filter((w) => !(w.status === 503 || (w.status >= 200 && w.status < 300))).map((w) => `${w.name}=${w.status}`), 'deletes answered other than done or 503').toEqual([])
  })

  // Q-52 (W8 QA; the review fixes 2bd0055e · 0040ded0 · cb9e683e of #858): a pause of the database itself stops every
  // heartbeat at once, and no replica may judge a drain stale until its own calls have answered for 20 s again.
  for (const seconds of FREEZE_SECONDS) {
    test(`Q-52: PostgreSQL frozen ${seconds} s mid-drain — the drain goes on and finishes, the health check writes again, no restarts, reads 200 within 30 s, nothing hangs 10 s after`, async ({ request }) => {
      const target = PG_DOCKER ? dockerFreezeTarget(PG_DOCKER)
        : deploymentExists('postgres') ? freezeTargetOf('postgres')
          : 'the install runs no postgres Deployment and E2E_FAULT_PG_DOCKER names no container of the external database'
      test.skip(typeof target === 'string', typeof target === 'string' ? target : '')
      const t = target as FreezeTarget
      test.setTimeout(Math.max(600_000, (seconds + 570) * 1000))
      const token = await login(request)
      const headers = bearer(token)
      const ns = `e2e-w6-pgfreeze${seconds}-${STAMP}`
      const node = holdNode(ns)
      const before = restartCounts()
      const interval = Number(envOf(K8S, 'MC_HEALTHCHECK_INTERVAL_SEC') ?? '60')
      const statuses: { at: number; ms: number; code: number; status?: string; message?: string }[] = []
      const timeline: Record<string, number | string | null> = { what: t.what, seconds, healthcheckIntervalSec: interval }
      let probe: Probe | null = null
      let polling = true
      let poller: Promise<void> = Promise.resolve()
      let frozen: { at: number; thaw: () => number } | null = null
      let answers: Answer[] = []
      try {
        const id = await startDrain(request, node, VIA_GATEWAY, headers)
        await expect.poll(async () => (await statusOf(request, node, id, VIA_GATEWAY, headers)).body?.status, { timeout: 30_000 }).toBe('draining')
        // the drain window's poll: one read a second through the gateway, each waited for as long as it takes
        poller = (async () => {
          while (polling) {
            const at = Date.now()
            const r = await statusOf(request, node, id, VIA_GATEWAY, headers, (seconds + 40) * 1000).catch(() => ({ code: 0, body: null }))
            statuses.push({ at, ms: Date.now() - at, code: r.code, status: r.body?.status, message: r.body?.message })
            await sleep(1_000)
          }
        })()
        probe = new Probe(request, FREEZE_READS, headers, 100, (seconds + 40) * 1000)
        await sleep(5_000)

        frozen = freeze(t, seconds)
        timeline.frozen = new Date(frozen.at).toISOString()
        await sleep(seconds * 1000)
        const thawAt = frozen.thaw()
        timeline.thawed = new Date(thawAt).toISOString()
        const sql = deploymentExists('postgres')
        const dbThaw = sql ? psql("SELECT to_char(LOCALTIMESTAMP, 'YYYY-MM-DD HH24:MI:SS.US')") : ''

        // every read 200 again within 30 s, nothing reloaded or restarted
        let readsBackAt = 0
        while (Date.now() - thawAt < READS_BACK_MS + 30_000) {
          const codes = await Promise.all(FREEZE_READS.map(async (p) => (await request.get(p, { headers, failOnStatusCode: false, timeout: 10_000 }).catch(() => null))?.status() ?? 0))
          if (codes.every((c) => c === 200)) { readsBackAt = Date.now(); break }
          await sleep(1_000)
        }
        timeline.readsBackMs = readsBackAt ? readsBackAt - thawAt : null
        // the drain keeps going for 30 s after the thaw
        while (Date.now() - thawAt < 30_000) await sleep(1_000)
        // the health check writes clusters.health_status again (the replica holding its lock still does)
        let healthAt = 0
        if (interval > 0 && sql) {
          while (Date.now() - thawAt < (interval + 30) * 1000) {
            if (Number(psql(`SELECT count(*) FROM clusters WHERE last_healthcheck_at > '${dbThaw}'::timestamp`)) > 0) { healthAt = Date.now(); break }
            await sleep(2_000)
          }
          timeline.healthWrittenMs = healthAt ? healthAt - thawAt : null
        }
        // let the drain end: without the PDB the held pod is evicted and the drain finishes
        remote!(['-n', ns, 'delete', 'pdb', 'held'])
        await expect.poll(async () => (await statusOf(request, node, id, VIA_GATEWAY, headers)).body?.status, { message: 'the drain finishes once nothing refuses its eviction', timeout: 120_000, intervals: [1_000] }).toBe('success')
        polling = false
        await poller
        answers = await probe.stop()
        probe = null

        // still waiting 10 s after the thaw: sent before it and answered later than that, or sent after it and waiting longer
        const hung = answers.filter((a) => a.at + a.ms > thawAt + HUNG_AFTER_THAW_MS && (a.at < thawAt || a.ms > HUNG_AFTER_THAW_MS))
        const seen = [...new Set(statuses.map((s) => s.status ?? `no answer (${s.code})`))]
        test.info().attach('answers.json', { body: JSON.stringify(answers), contentType: 'application/json' })
        test.info().attach('drain-status.json', { body: JSON.stringify(statuses), contentType: 'application/json' })
        test.info().attach('timeline.json', { body: JSON.stringify({ ...timeline, drainStatusesSeen: seen }, null, 2), contentType: 'application/json' })

        expect(statuses.filter((s) => s.status === 'interrupted').map((s) => `${new Date(s.at).toISOString()} ${s.message}`), 'the drain read interrupted while or after PostgreSQL was frozen').toEqual([])
        expect(restartsSince(before), `restarts while PostgreSQL was frozen ${seconds} s (PostgreSQL included)`).toEqual({})
        expect(readsBackAt, 'every read answered 200 again').toBeGreaterThan(0)
        expect(readsBackAt - thawAt, 'ms from the thaw to every read 200').toBeLessThanOrEqual(READS_BACK_MS)
        expect(hung.length, `reads still unanswered ${HUNG_AFTER_THAW_MS} ms after the thaw:\n${show(hung)}`).toBe(0)
        if (interval > 0 && sql) {
          expect(healthAt, `clusters.last_healthcheck_at written after the thaw (every ${interval} s)`).toBeGreaterThan(0)
        } else {
          test.info().annotations.push({ type: 'not checked', description: interval > 0 ? 'the health check write: no postgres Deployment to read clusters from' : 'the health check write: multicluster.healthcheckIntervalSec is 0 (off)' })
        }
      } finally {
        frozen?.thaw()
        polling = false
        await poller
        if (probe) await probe.stop()
        release(ns, node)
      }
    })
  }
})
