import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

import { CLUSTER, NS, Probe, STAMP, type Answer, bearer, deploymentExists, killPod, kubectl, login, readyPods, rolledOut, show, sleep, tr } from './shared'

// W4 (PRs #823 SERVER_ROLE, #824 the stream server's drain, #825 chart streams.enabled): terminals and followed logs run
// on k8s-service-stream, the lists on k8s-service (role api). Step 4 §5-2:
// - F-1 stream server killed: list screens error 0 · the terminal shows why within 5 s · the followed log is back
//   within 10 s with no line missing (or shown twice).
// - F-2 stream server replaced on purpose: the replacement itself is stream-server.spec.ts (#825: the notice, the
//   1001 close, Reconnect, the log going on). Here: a session that ends within the wait is closed as its own end, not
//   cut by the replacement.
// - F-3 api server (k8s-service) killed, one replica: the open terminal and followed log do not break, and a list
//   page comes back by itself (no reload) once the server is back.
//
// Each case skips without k8s-service-stream (streams.enabled false). A busybox pod of the run prints a numbered line
// every second in `default` on self and is removed after. Killed pods are replaced by their Deployment; each case waits
// for the rollout. Not here: F-4 (recording store cut) and F-16 (a token expiring under an open connection), whose
// pass lines step 4 leaves to "see what it does now" first.

const STREAM = 'k8s-service-stream'
const API = 'k8s-service'
const POD_NS = 'default'
const POD = `e2e-w6-seq-${STAMP}`

type Terminal = { text: string; closed?: { code: number; reason: string; at: number } }

async function openTerminal(page: Page) {
  await page.goto('/color-mode.js')
  await page.evaluate(({ ns, pod, cluster }) => {
    const seen: Terminal = { text: '' }
    const w = window as unknown as { __term: Terminal; __ws: WebSocket }
    w.__term = seen
    const decoder = new TextDecoder()
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/cluster/namespaces/${ns}/pods/${pod}/exec/ws?container=${pod}&command=/bin/sh&cluster=${cluster}&lang=en`)
    w.__ws = ws
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (e) => { seen.text += typeof e.data === 'string' ? e.data : decoder.decode(new Uint8Array(e.data).slice(1)) }
    ws.onclose = (e) => { seen.closed = { code: e.code, reason: e.reason, at: Date.now() } }
  }, { ns: POD_NS, pod: POD, cluster: CLUSTER })
  await expect.poll(async () => (await terminalOn(page)).text.length, { timeout: 20_000 }).toBeGreaterThan(0)
}

const terminalOn = (page: Page) => page.evaluate(() => (window as unknown as { __term: Terminal }).__term)
const typeIn = (page: Page, line: string) => page.evaluate((l) => (window as unknown as { __ws: WebSocket }).__ws.send(`${l}\r`), line)

async function openLogsTab(page: Page) {
  await page.goto(`/cluster-view?cluster=${CLUSTER}`)
  await expect(page.getByRole('heading', { name: /클러스터 뷰|Cluster view/i })).toHaveText(/클러스터 뷰|Cluster view/i, { timeout: 15_000 })
  await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill(POD)
  await page.locator('div.card button', { hasText: POD }).first().click()
  const area = page.locator('pre.whitespace-pre-wrap').first()
  await expect(area).toContainText('seq-3', { timeout: 20_000 })
  return area
}

// The numbered lines the tab shows, in order.
async function seqShown(area: ReturnType<Page['locator']>): Promise<number[]> {
  return (await area.innerText()).split('\n').map((l) => /seq-(\d+)\b/.exec(l)?.[1]).filter((n): n is string => !!n).map(Number)
}

// Numbers missing between the first and the last shown, and numbers shown twice.
function gaps(seq: number[]): { missing: number[]; twice: number[] } {
  const missing: number[] = []
  const twice = seq.filter((n, i) => seq.indexOf(n) !== i)
  for (let i = 1; i < seq.length; i++) for (let n = seq[i - 1] + 1; n < seq[i]; n++) missing.push(n)
  return { missing, twice }
}

const listReads = [
  `/api/v1/cluster/pods/page?cluster=${CLUSTER}&namespace=${POD_NS}&limit=5`,
  `/api/v1/cluster/overview?cluster=${CLUSTER}`,
  `/api/v1/cluster/nodes?cluster=${CLUSTER}`,
]

async function auditRows(request: APIRequestContext, token: string, action: string, since: string) {
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: bearer(token), params: { cluster: '', limit: '100', action, since } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()).items || []) as { TargetID: string; After: Record<string, unknown> | null }[]
}

test.describe('W4 stream server faults (PRs #823–#825, F-1 · F-2 · F-3)', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(() => {
    test.skip(!deploymentExists(STREAM), 'no k8s-service-stream: the dev install runs with streams.enabled false')
    kubectl(['-n', POD_NS, 'run', POD, '--image=busybox:1.37', '--image-pull-policy=IfNotPresent', '--restart=Never', '--command', '--',
      'sh', '-c', 'i=0; while true; do echo seq-$i; i=$((i+1)); sleep 1; done'], {})
    kubectl(['-n', POD_NS, 'wait', '--for=condition=Ready', `pod/${POD}`, '--timeout=120s'])
  })

  test.afterAll(() => {
    if (deploymentExists(STREAM)) kubectl(['-n', POD_NS, 'delete', 'pod', POD, '--ignore-not-found', '--wait=false'])
  })

  test('F-1: the stream server is killed — lists answer 200, the terminal says why within 5 s, the log is back within 10 s with no line missing', async ({ page, request }) => {
    test.setTimeout(240_000)
    const token = await login(request)
    const area = await openLogsTab(page)
    const drawer = await page.context().newPage()
    await drawer.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=${POD_NS}&detail=Pod/${POD_NS}/${POD}`)
    await drawer.getByTitle(/Open terminal|터미널 열기/).first().click()
    await expect(drawer.locator('.xterm-rows')).toContainText(/Connected\.|연결됨\./, { timeout: 20_000 })
    const raw = await page.context().newPage()
    await openTerminal(raw)

    const probe = new Probe(request, listReads, bearer(token), 100, 10_000)
    let answers: Answer[] = []
    let killedAt = 0
    try {
      await sleep(3_000)
      const lastBefore = Math.max(...await seqShown(area))
      const pod = readyPods(STREAM)[0]
      expect(pod, 'a ready stream server').toBeTruthy()
      killedAt = killPod(pod.name)

      await expect.poll(async () => (await terminalOn(raw)).closed?.at ?? 0, { message: 'the terminal socket closes', timeout: 15_000 }).toBeGreaterThan(0)
      expect((await terminalOn(raw)).closed!.at - killedAt, 'ms from the kill to the terminal closing').toBeLessThanOrEqual(5_000)
      await expect(drawer.locator('.xterm-rows'), 'the terminal window says why within 5 s').toContainText(tr('pods.exec.disconnected'), { timeout: Math.max(1, 5_000 - (Date.now() - killedAt)) })

      // a line printed after the kill reaches the tab within 10 s
      let backAt = 0
      while (Date.now() - killedAt < 30_000) {
        if (Math.max(...await seqShown(area)) > lastBefore + 1) { backAt = Date.now(); break }
        await sleep(250)
      }
      test.info().annotations.push({ type: 'log back after', description: backAt ? `${backAt - killedAt} ms` : 'not within 30 s' })
      expect(backAt, 'the followed log came back').toBeGreaterThan(0)
      expect(backAt - killedAt, 'ms from the kill to a new line on the tab').toBeLessThanOrEqual(10_000)
      await sleep(5_000)
      const { missing, twice } = gaps(await seqShown(area))
      expect(missing, 'lines missing from the tab').toEqual([])
      expect(twice, 'lines shown twice').toEqual([])
    } finally {
      answers = await probe.stop()
      test.info().attach('list-reads.json', { body: JSON.stringify(answers), contentType: 'application/json' })
      rolledOut(STREAM)
    }
    const bad = answers.filter((a) => a.status !== 200)
    expect(bad.length, `list reads not answered 200 while the stream server was down:\n${show(bad)}`).toBe(0)
  })

  test('F-2: during a planned replacement, a terminal that ends itself within the wait closes as its own end, not cut by the replacement', async ({ page, request }) => {
    test.setTimeout(360_000)
    const token = await login(request)
    const since = new Date(Date.now() - 2_000).toISOString()
    await openTerminal(page)
    kubectl(['-n', NS, 'rollout', 'restart', `deploy/${STREAM}`])
    try {
      await expect.poll(async () => (await terminalOn(page)).text, { message: 'the replacement tells the terminal', timeout: 180_000 }).toContain('this terminal closes in')
      await typeIn(page, 'exit')
      await expect.poll(async () => (await terminalOn(page)).closed?.at ?? 0, { message: 'the terminal closes after exit', timeout: 15_000 }).toBeGreaterThan(0)
      const t = await terminalOn(page)
      expect(t.closed!.reason, 'closed by its own exit').not.toBe('server_shutdown')
      expect(t.closed!.code, 'not the replacement\'s 1001').not.toBe(1001)
      expect(t.text).not.toContain('the server was replaced')
    } finally {
      rolledOut(STREAM, 300)
    }
    const ends = (await auditRows(request, token, 'k8s.session.end', since)).filter((r) => r.TargetID === POD)
    expect(ends.filter((r) => r.After?.reason === 'server_shutdown').length, 'session ends of this pod recorded as server_shutdown').toBe(0)
  })

  test('F-3: the api server is killed (one replica) — the open terminal and followed log go on, and a list page shows a new pod by itself once it is back', async ({ page, request }) => {
    test.setTimeout(300_000)
    test.skip(readyPods(API).length !== 1, 'F-3 is the one-replica case; with two api servers it is F-5 (W5)')
    const area = await openLogsTab(page)
    const raw = await page.context().newPage()
    await openTerminal(raw)
    const list = await page.context().newPage()
    await list.goto(`/workloads/pods?cluster=${CLUSTER}&namespace=${POD_NS}`)
    await expect(list.locator('table').first()).toContainText(POD, { timeout: 20_000 })
    const added = `e2e-w6-after-${STAMP}`
    try {
      const lastBefore = Math.max(...await seqShown(area))
      killPod(readyPods(API)[0].name)
      await sleep(3_000)
      rolledOut(API, 240)

      // the terminal kept its socket and still runs commands
      expect((await terminalOn(raw)).closed, 'the terminal socket stayed open').toBeUndefined()
      await typeIn(raw, `echo alive-${STAMP}`)
      await expect.poll(async () => ((await terminalOn(raw)).text.match(new RegExp(`alive-${STAMP}`, 'g')) ?? []).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
      // the followed log went on without a gap
      expect(Math.max(...await seqShown(area)), 'new lines kept coming').toBeGreaterThan(lastBefore + 3)
      const { missing, twice } = gaps(await seqShown(area))
      expect(missing, 'lines missing from the tab').toEqual([])
      expect(twice, 'lines shown twice').toEqual([])

      // the list page, never reloaded, shows a pod made after the server came back
      kubectl(['-n', POD_NS, 'run', added, '--image=busybox:1.37', '--image-pull-policy=IfNotPresent', '--restart=Never', '--command', '--', 'sleep', '600'])
      await expect(list.locator('table').first(), 'the list follows again without a reload').toContainText(added, { timeout: 30_000 })
    } finally {
      kubectl(['-n', POD_NS, 'delete', 'pod', added, '--ignore-not-found', '--wait=false'])
    }
  })
})
