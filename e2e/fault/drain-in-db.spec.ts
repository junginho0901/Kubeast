import { test, expect, type APIRequestContext } from '@playwright/test'

import {
  CLUSTER, NS, Probe, STAMP, bearer, forwardTo, killPod, kindKubectl, kubectl, login, onPod, readyPods, restartCounts, restartsSince,
  rolledOut, sleep, stopFor, stopPod, type Answer, type Forward,
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
// The drain runs on the kind cluster test2 (one node, as the action suite drains it): a namespace of the run holds one
// pod under a PodDisruptionBudget that refuses its eviction, so the drain keeps retrying (5 min) and stays open while a
// server is killed. The namespace is deleted and the node uncordoned after every case. Tests 4 and 5 skip without two
// ready k8s-service pods; F-9 skips when PostgreSQL keeps no volume (stopping it would lose the dev database).

const DRAIN_CLUSTER = process.env.E2E_FAULT_DRAIN_CLUSTER || 'test2'
const DRAIN_KIND = process.env.E2E_FAULT_DRAIN_KIND || 'test2'
const INTERRUPTED_WITHIN_MS = 30_000 // step 3 test 5 / step 4 F-7; the PR's own number is 20 s stale + 1 s poll
const K8S = 'k8s-service'
const remote = kindKubectl(DRAIN_KIND)

type Status = { id: string; node: string; status: string; message?: string; pods_total?: number; pods_done?: number; cordoned_nodes?: string[] | null }
type Row = { Action: string; Result: string; Error: string; TargetID: string; After: Record<string, unknown> | null }

function holdNode(ns: string): string {
  const node = remote!(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}'])
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
}

const cordoned = (node: string) => remote!(['get', 'node', node, '-o', 'jsonpath={.spec.unschedulable}']) === 'true'
const heldPods = (ns: string) => remote!(['-n', ns, 'get', 'pods', '-l', 'app=held', '-o', 'jsonpath={.items[*].metadata.name}']).split(/\s+/).filter(Boolean)

async function startDrain(api: APIRequestContext, node: string): Promise<string> {
  const res = await api.post(`/api/v1/nodes/${node}/drain?cluster=${DRAIN_CLUSTER}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, failOnStatusCode: false })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()).drain_id as string
}

async function statusOf(api: APIRequestContext, node: string, id: string): Promise<{ code: number; body: Status | null }> {
  const res = await api.get(`/api/v1/nodes/${node}/drain/status?drain_id=${id}&cluster=${DRAIN_CLUSTER}`, { timeout: 5_000, failOnStatusCode: false })
  return { code: res.status(), body: res.ok() ? ((await res.json()) as Status) : null }
}

async function auditRows(request: APIRequestContext, token: string, action: string, since: string): Promise<Row[]> {
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: bearer(token), params: { cluster: '', limit: '100', action, since } })
  expect(res.ok(), `audit read: ${res.status()}`).toBeTruthy()
  return ((await res.json()).items || []) as Row[]
}

test.describe('drain progress in the database (PR #858)', () => {
  test.describe.configure({ mode: 'serial' })

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
    const writes: { name: string; status: number }[] = []
    let drainDuring = 0
    let probe: Probe | null = null
    let left: string[] = []
    const maps = Array.from({ length: 10 }, (_, i) => `w6-pgoff-${STAMP}-${i}`)
    for (const name of maps) remote!(['-n', ns, 'create', 'configmap', name, '--from-literal=k=v'])
    try {
      probe = new Probe(request, reads, headers, 100, 10_000)
      await sleep(5_000)
      await stopFor('postgres', 60, async () => {
        await sleep(10_000)
        const drain = await request.post(`/api/v1/cluster/nodes/${node}/drain?cluster=${DRAIN_CLUSTER}`, { headers, failOnStatusCode: false, timeout: 15_000 }).catch(() => null)
        drainDuring = drain?.status() ?? 0
        // a ConfigMap delete on test2 every 3 s: refused (the ConfigMap stays), or done with its row once the database is back
        for (const name of maps) {
          const res = await request.delete(`/api/v1/cluster/namespaces/${ns}/configmaps/${name}?cluster=${DRAIN_CLUSTER}`, { headers, failOnStatusCode: false, timeout: 15_000 }).catch(() => null)
          writes.push({ name, status: res?.status() ?? 0 })
          await sleep(3_000)
        }
      })
      // recovery: every read answers 200 again without a restart
      await expect.poll(async () => {
        const codes = await Promise.all(reads.map(async (p) => (await request.get(p, { headers, failOnStatusCode: false, timeout: 10_000 }).catch(() => null))?.status() ?? 0))
        return codes.every((c) => c === 200)
      }, { message: 'every read answers 200 after PostgreSQL is back', timeout: 120_000, intervals: [2_000] }).toBe(true)
    } finally {
      const answers: Answer[] = probe ? await probe.stop() : []
      test.info().attach('reads-during-outage.json', { body: JSON.stringify(answers), contentType: 'application/json' })
      // what a signed-in reader still saw, per route (written down, not a pass line: step 4 F-9)
      const byPath = Object.fromEntries(reads.map((p) => [p, answers.filter((a) => a.path === p).reduce<Record<string, number>>((m, a) => ({ ...m, [a.status]: (m[a.status] ?? 0) + 1 }), {})]))
      test.info().attach('reads-by-route.json', { body: JSON.stringify(byPath, null, 2), contentType: 'application/json' })
      try { left = remote!(['-n', ns, 'get', 'configmaps', '-o', 'jsonpath={.items[*].metadata.name}']).split(/\s+/).filter(Boolean) } catch { left = [] }
      release(ns, node)
    }

    expect(restartsSince(before), 'restarts of the pods that stayed (PostgreSQL itself is replaced)').toEqual({})
    expect(drainDuring, 'a drain start while PostgreSQL was off is refused with 503 (its progress cannot be saved)').toBe(503)
    const accepted = writes.filter((w) => w.status >= 200 && w.status < 300).map((w) => w.name)
    test.info().annotations.push({ type: 'writes during the outage', description: writes.map((w) => `${w.name}=${w.status}`).join(' ') })
    const rows = await auditRows(request, token, 'k8s.configmap.delete', since)
    const recorded = rows.filter((r) => r.Result === 'success').map((r) => r.TargetID)
    expect(accepted.filter((n) => !recorded.includes(n)), 'deletes accepted during the outage with no audit row').toEqual([])
    // a refused delete changed nothing, an accepted one took the ConfigMap away
    expect(writes.filter((w) => w.status === 503 && !left.includes(w.name)).map((w) => w.name), 'refused deletes whose ConfigMap is gone').toEqual([])
    expect(accepted.filter((n) => left.includes(n)), 'accepted deletes whose ConfigMap is still there').toEqual([])
    expect(writes.filter((w) => !(w.status === 503 || (w.status >= 200 && w.status < 300))).map((w) => `${w.name}=${w.status}`), 'deletes answered other than done or 503').toEqual([])
  })
})
