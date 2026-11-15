import { test, expect, type Page } from '@playwright/test'

import {
  CLUSTER, NS, Probe, STAMP, aroundKill, atExit, bearer, forwardTo, killPod, kubectl, kubectlOk, listSocketBack, listSockets, login, readyPods,
  restartCounts, restartsSince, rolledOut, show, sleep, undoPending, watchListSockets, wsSubscriptions, type Answer, type Forward,
} from './shared'

// Step 4 F-5 and F-14, rows of W5 that none of the pull requests of the other files changes: a server force-killed
// (`kubectl delete --grace-period=0 --force`: SIGTERM, SIGKILL 2 s later) while reads run and a page holds a live list.
// - F-5: one of two k8s-service pods, the one holding the page's live list (its kubeast_ws_subscriptions went up when the
//   page opened the list): only the requests it held fail, none from 3 s after the kill, and the list's socket is open
//   again within 5 s.
// - F-14 with one gateway: how long no answer came is written down (no line); the page, never reloaded, shows a pod made
//   after the new gateway is ready within 30 s.
// - F-14 with two gateways: one killed, every answer 200.
// Each case holds the restarts of the pods that stayed to 0 and the gateway to no 502 (#883), waits for the Deployment
// to roll out again and attaches the answers, the times and the gateway's 502 and worker_connections lines.

const K8S = 'k8s-service'
const GATEWAY = 'gateway'
const STALE_WITHIN_MS = 3_000
const RECONNECT_MS = 5_000
const RECOVER_MS = 30_000
const READS = [
  `/api/v1/cluster/pods/page?cluster=${CLUSTER}&namespace=${NS}&limit=5`,
  `/api/v1/cluster/overview?cluster=${CLUSTER}`,
  `/api/v1/cluster/nodes?cluster=${CLUSTER}`,
  `/api/v1/cluster/namespaces?cluster=${CLUSTER}`,
]
const GATEWAY_READS = ['/healthz', '/api/v1/clusters', `/api/v1/cluster/pods/page?cluster=${CLUSTER}&namespace=${NS}&limit=5`]

const is502 = (a: Answer) => a.status === 502

// The gateway pods' log lines since `sinceIso` that say 502 or worker_connections.
function gatewayLines(sinceIso: string): string {
  const out = kubectlOk(['-n', NS, 'logs', '-l', `app=${GATEWAY}`, '--prefix', '--tail=-1', `--since-time=${sinceIso}`]).out
  return out.split('\n').filter((l) => /\s502\s|worker_connections/.test(l)).join('\n')
}

async function openLiveList(page: Page) {
  await page.addInitScript(watchListSockets)
  await page.goto(`/cluster-view?cluster=${CLUSTER}&namespace=${NS}`)
  await expect.poll(async () => (await listSockets(page)).some((s) => s.firstFrameAt), { message: 'the page\'s live list answers', timeout: 30_000 }).toBe(true)
}

test.describe('servers force-killed under reads and live lists (F-5, F-14)', () => {
  test.describe.configure({ mode: 'serial' })

  test.afterEach(() => undoPending())

  test('F-5: one of two k8s-service pods force-killed — reads error 0 from 3 s after the kill, the live list it held is open again within 5 s', async ({ page, request }) => {
    test.skip(readyPods(K8S).length < 2, 'needs two ready k8s-service pods (scripts/kind-fault-shape.sh s2, once M-7 lets the chart render it)')
    test.setTimeout(300_000)
    const token = await login(request)
    const pods = readyPods(K8S).map((p) => p.name)
    const forwards: Forward[] = []
    let probe: Probe | null = null
    try {
      for (const p of pods) forwards.push(await forwardTo(p, 8002))
      const subs = async () => Promise.all(forwards.map((f) => wsSubscriptions(f)))
      const before = await subs()
      await openLiveList(page)
      await sleep(3_000)
      const after = await subs()
      expect([...before, ...after].every(Number.isFinite), 'every k8s-service pod reports kubeast_ws_subscriptions on /metrics').toBe(true)
      const rise = after.map((n, i) => n - before[i])
      const i = rise.indexOf(Math.max(...rise))
      const victim = pods[i]
      test.info().annotations.push({ type: 'killed', description: `${victim} (live list subscriptions ${rise.map((n, j) => `${pods[j]} +${n}`).join(', ')})` })
      expect(rise[i], 'the subscriptions of one server went up when the page opened its live list').toBeGreaterThan(0)
      forwards.forEach((f) => f.close())
      forwards.length = 0

      const restartsBefore = restartCounts()
      probe = new Probe(request, READS, bearer(token), 100, 10_000)
      await sleep(5_000)
      const killedAt = killPod(victim)
      const list = await listSocketBack(page, killedAt, RECONNECT_MS)
      rolledOut(K8S)
      await sleep(5_000)
      const answers = await probe.stop()
      probe = null
      const around = aroundKill(answers, killedAt, STALE_WITHIN_MS)
      test.info().attach('answers.json', { body: JSON.stringify(answers), contentType: 'application/json' })
      test.info().attach('timeline.json', {
        body: JSON.stringify({
          killed: new Date(killedAt).toISOString(), victim, errorWindow: around.window ? `${around.window.first - killedAt}..${around.window.last - killedAt} ms` : null,
          failedInGrace: around.during.length, listReopenMs: list.reopenMs, sockets: list.sockets,
        }, null, 2),
        contentType: 'application/json',
      })
      // judged first from these when a line is missed (README "First runs"); the lines are not loosened
      test.info().attach('errors-around-kill.json', { body: JSON.stringify(around, null, 2), contentType: 'application/json' })

      expect(around.before.map((a) => `${a.path} ${a.status}`), 'reads that failed before the kill').toEqual([])
      expect(around.after.length, `reads not 200 from ${STALE_WITHIN_MS} ms after the kill:\n${show(around.after)}`).toBe(0)
      expect(list.cut, 'the page\'s live list socket on the killed server closed').toBe(true)
      expect(list.reopenMs, 'ms from its close to a new socket open').not.toBeNull()
      expect(list.reopenMs!, 'ms from its close to a new socket open').toBeLessThanOrEqual(RECONNECT_MS)
      expect(restartsSince(restartsBefore), 'restarts of the pods that stayed').toEqual({})
    } finally {
      if (probe) await probe.stop()
      forwards.forEach((f) => f.close())
      rolledOut(K8S)
    }
  })

  test('F-14 (one gateway): the gateway force-killed — how long nothing answered is written down, the page shows a pod made after the new gateway is ready within 30 s without a reload, no 502', async ({ page, request }) => {
    const gateways = readyPods(GATEWAY)
    test.skip(gateways.length !== 1, `the one-gateway case; the install has ${gateways.length} ready gateway pods (two: the case below)`)
    test.setTimeout(300_000)
    const token = await login(request)
    const since = new Date(Date.now() - 2_000).toISOString()
    const added = `e2e-w6-gw-${STAMP}`
    const unrun = atExit(`delete pod default/${added}`, () => kubectl(['-n', 'default', 'delete', 'pod', added, '--ignore-not-found', '--wait=false']))
    let probe: Probe | null = null
    try {
      await page.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=default`)
      await expect(page.locator('table tbody tr').first(), 'the Pods list of default').toBeVisible({ timeout: 30_000 })
      const restartsBefore = restartCounts()
      probe = new Probe(request, GATEWAY_READS, bearer(token), 100, 5_000)
      await sleep(3_000)
      const killed = gateways[0].name
      const killedAt = killPod(killed)
      // ready = a gateway pod other than the killed one is Ready (rollout status may still read the old state at first)
      await expect.poll(() => readyPods(GATEWAY).some((p) => p.name !== killed), { message: 'a new gateway pod is ready', timeout: 180_000, intervals: [250] }).toBe(true)
      const readyAt = Date.now()
      rolledOut(GATEWAY)
      kubectl(['-n', 'default', 'run', added, '--image=busybox:1.37', '--image-pull-policy=IfNotPresent', '--restart=Never', '--command', '--', 'sleep', '600'])
      await expect(page.locator('table').first(), 'the list, never reloaded, follows again').toContainText(added, { timeout: RECOVER_MS })
      const shownAt = Date.now()
      await sleep(3_000)
      const answers = await probe.stop()
      probe = null
      const around = aroundKill(answers, killedAt, 0)
      test.info().attach('answers.json', { body: JSON.stringify(answers), contentType: 'application/json' })
      test.info().attach('timeline.json', {
        body: JSON.stringify({
          killed: new Date(killedAt).toISOString(), readyAfterMs: readyAt - killedAt, shownAfterReadyMs: shownAt - readyAt,
          errorWindow: around.window ? `${around.window.first - killedAt}..${around.window.last - killedAt} ms` : null, failed: around.during.length + around.after.length,
        }, null, 2),
        contentType: 'application/json',
      })
      test.info().attach('gateway-502-and-worker-lines.txt', { body: gatewayLines(since), contentType: 'text/plain' })

      expect(around.before.map((a) => `${a.path} ${a.status}`), 'reads that failed before the kill').toEqual([])
      expect(shownAt - readyAt, 'ms from the new gateway ready to the page showing the new pod').toBeLessThanOrEqual(RECOVER_MS)
      expect(answers.filter(is502).length, `502 answers:\n${show(answers.filter(is502))}`).toBe(0)
      expect(restartsSince(restartsBefore), 'restarts of the pods that stayed').toEqual({})
    } finally {
      if (probe) await probe.stop()
      kubectl(['-n', 'default', 'delete', 'pod', added, '--ignore-not-found', '--wait=false'])
      unrun()
      rolledOut(GATEWAY)
    }
  })

  test('F-14 (two gateways): one gateway force-killed — every answer 200, no 502', async ({ request }) => {
    const gateways = readyPods(GATEWAY)
    test.skip(gateways.length < 2, 'needs two ready gateway pods (scripts/kind-fault-shape.sh s2-gateway)')
    test.setTimeout(300_000)
    const token = await login(request)
    const since = new Date(Date.now() - 2_000).toISOString()
    let probe: Probe | null = null
    try {
      const restartsBefore = restartCounts()
      probe = new Probe(request, GATEWAY_READS, bearer(token), 100, 10_000)
      await sleep(5_000)
      const killedAt = killPod(gateways[0].name)
      rolledOut(GATEWAY)
      await sleep(10_000)
      const answers = await probe.stop()
      probe = null
      const bad = answers.filter((a) => a.status !== 200)
      test.info().attach('answers.json', { body: JSON.stringify(answers), contentType: 'application/json' })
      test.info().attach('timeline.json', { body: JSON.stringify({ killed: new Date(killedAt).toISOString(), victim: gateways[0].name, failed: bad.length }, null, 2), contentType: 'application/json' })
      test.info().attach('gateway-502-and-worker-lines.txt', { body: gatewayLines(since), contentType: 'text/plain' })

      expect(answers.length, 'the probe kept sending').toBeGreaterThan(100)
      expect(bad.length, `answers other than 200 with one of two gateways killed:\n${show(bad)}`).toBe(0)
      expect(answers.filter(is502).length, '502 answers').toBe(0)
      expect(restartsSince(restartsBefore), 'restarts of the pods that stayed').toEqual({})
    } finally {
      if (probe) await probe.stop()
      rolledOut(GATEWAY)
    }
  })
})
