import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

import { CLUSTER, atExit, bearer, deploymentExists, envOf, killNoSignal, kubectl, kubectlOk, login, psql, readyPods, rolledOut, sleep, undoPending } from './shared'

// Threat model v0.7.8 row 1.9 (F-1 with a node shell open): a k8s-service killed with no SIGTERM (SIGKILL from the
// container runtime, as the OOM killer ends a process) cannot delete the node shell pod it made. Each shell has a row in
// node_shells naming that server (owner), refreshed every 15 s; once the row has had no refresh for 60 s a live
// k8s-service — another pod, or the killed pod's restarted container — deletes the pod, as the person who opened the
// shell, and writes the shell's k8s.session.end row with the reason server_gone.
//
// - NS-1 (any number of servers): the node shell pod is gone within 150 s of the kill (60 s stale, a sweep every 30 s,
//   and a restarted server's first minute of database contact), not before 40 s (it is the sweep, not the server's own
//   cleanup), its row is gone, and exactly one k8s.session.end row names it with server_gone.
// - NS-2 (two ready servers): a shell whose server stays alive keeps its pod Running and its socket open through the
//   same 150 s while the killed server's shell pod is deleted.
//
// Needs nodeShell.enabled (NODE_SHELL_ENABLED true on the server that opens terminals) and table node_shells; skips with
// the reason otherwise. Opens shells on the first node of self with the install's default image; the shells' pods are
// deleted at the end whatever happened.

const SERVER = deploymentExists('k8s-service-stream') ? 'k8s-service-stream' : 'k8s-service'
const SHELL_NS = (deploymentExists(SERVER) && envOf(SERVER, 'NODE_SHELL_NAMESPACE')) || 'kubeast-node-shell'
const GONE_WITHIN_MS = 150_000
const NOT_BEFORE_MS = 40_000

type Shell = { statuses: string[]; closed?: { code: number; at: number } }

// Opens a node shell socket in page (signed-in cookie, through the gateway) under window.__shells[key].
async function openShell(page: Page, key: string, node: string) {
  await page.evaluate(({ key, node, cluster }) => {
    const w = window as unknown as { __shells?: Record<string, Shell>; __shellWs?: Record<string, WebSocket> }
    w.__shells ??= {}
    w.__shellWs ??= {}
    const seen: Shell = { statuses: [] }
    w.__shells[key] = seen
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/cluster/nodes/${node}/debug-shell/ws?cluster=${cluster}&lang=en&cols=80&rows=24`)
    w.__shellWs[key] = ws
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      try {
        const m = JSON.parse(e.data) as { type?: string; status?: string }
        if (m.type === 'status' && m.status) seen.statuses.push(m.status)
      } catch { /* screen text */ }
    }
    ws.onclose = (e) => { seen.closed = { code: e.code, at: Date.now() } }
  }, { key, node, cluster: CLUSTER })
  await expect.poll(async () => (await shellOn(page, key)).statuses, { message: `shell ${key} starts`, timeout: 120_000 }).toContain('starting')
}

const shellOn = (page: Page, key: string) => page.evaluate((k) => (window as unknown as { __shells: Record<string, Shell> }).__shells[k], key)

type ShellPod = { name: string; id: string; owner: string; phase: string; deleting: boolean }

function shellPods(): ShellPod[] {
  const list = JSON.parse(kubectl(['-n', SHELL_NS, 'get', 'pods', '-l', 'app=node-debugger', '-o', 'json'])) as {
    items: { metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string>; deletionTimestamp?: string }; status: { phase?: string } }[]
  }
  return list.items.map((p) => ({ name: p.metadata.name, id: p.metadata.labels?.['kubeast.io/node-shell-id'] ?? '', owner: p.metadata.annotations?.['kubeast.io/node-shell-owner'] ?? '',
    phase: p.status.phase ?? '', deleting: !!p.metadata.deletionTimestamp }))
}

// The shell pods that came since before, once each has its row label.
async function newShellPods(before: Set<string>, count: number): Promise<ShellPod[]> {
  let found: ShellPod[] = []
  await expect.poll(() => { found = shellPods().filter((p) => !before.has(p.name) && p.id !== '' && !p.deleting); return found.length }, { timeout: 30_000 }).toBeGreaterThanOrEqual(count)
  return found
}

// The k8s-service pod a shell's owner names (its host name, before the slash).
const ownerPod = (owner: string) => owner.split('/')[0]

async function auditRows(request: APIRequestContext, token: string, action: string, since: string) {
  const res = await request.get('/api/v1/auth/admin/audit-logs', { headers: bearer(token), params: { cluster: '', limit: '100', action, since } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()).items || []) as { TargetID: string; After: Record<string, unknown> | null }[]
}

// Waits until the pod is gone or being deleted; returns the ms since from, or 0 when it was not within limit.
async function goneAfter(name: string, from: number, limitMs: number): Promise<number> {
  while (Date.now() - from < limitMs) {
    const p = shellPods().find((x) => x.name === name)
    if (!p || p.deleting) return Date.now() - from
    await sleep(1_000)
  }
  return 0
}

test.describe('Node shell pods of a killed server (threat model 1.9, F-1 with a node shell)', () => {
  test.describe.configure({ mode: 'serial' })
  let node = ''

  test.beforeAll(() => {
    test.skip(!deploymentExists(SERVER), `no ${SERVER} Deployment`)
    test.skip(envOf(SERVER, 'NODE_SHELL_ENABLED') !== 'true', `node shell is off on ${SERVER} (nodeShell.enabled false, the default): turn it on for this run and back after`)
    test.skip(psql(`SELECT COALESCE(to_regclass('node_shells')::text, '')`).trim() !== 'node_shells', 'no table node_shells (migration 00030)')
    node = kubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}']).trim()
    expect(node, 'a node of self').not.toBe('')
  })

  test.afterEach(() => {
    undoPending()
    if (deploymentExists(SERVER)) kubectlOk(['-n', SHELL_NS, 'delete', 'pods', '-l', 'app=node-debugger', '--ignore-not-found', '--wait=false', '--grace-period=0'])
  })

  test('NS-1: the server holding a node shell is killed with no SIGTERM — its shell pod is deleted within 150 s, by a sweep, with one server_gone row', async ({ page, request }) => {
    test.setTimeout(360_000)
    const token = await login(request)
    const since = new Date(Date.now() - 2_000).toISOString()
    const before = new Set(shellPods().map((p) => p.name))
    await page.goto('/color-mode.js')
    await openShell(page, 'one', node)
    const [pod] = await newShellPods(before, 1)
    const server = ownerPod(pod.owner)
    expect(readyPods(SERVER).map((p) => p.name), 'the owner annotation names a ready server').toContain(server)
    expect(psql(`SELECT count(*) FROM node_shells WHERE id = '${pod.id}'`).trim(), 'the shell has its row').toBe('1')

    const done = atExit(`rollout of ${SERVER}`, () => rolledOut(SERVER, 240))
    const { at } = killNoSignal(server)
    let ms = 0
    try {
      ms = await goneAfter(pod.name, at, GONE_WITHIN_MS)
    } finally {
      rolledOut(SERVER, 240)
      done()
    }
    test.info().annotations.push({ type: 'shell pod gone after', description: ms ? `${ms} ms` : `not within ${GONE_WITHIN_MS} ms` })
    expect(ms, `the shell pod ${pod.name} is gone within ${GONE_WITHIN_MS} ms of the kill`).toBeGreaterThan(0)
    expect(ms, 'not before the row could be stale: the sweep deleted it').toBeGreaterThanOrEqual(NOT_BEFORE_MS)
    await expect.poll(() => psql(`SELECT count(*) FROM node_shells WHERE id = '${pod.id}'`).trim(), { message: 'the row goes', timeout: 20_000 }).toBe('0')
    await expect.poll(async () => (await auditRows(request, token, 'k8s.session.end', since)).filter((r) => r.After?.pod === pod.name).map((r) => r.After?.reason),
      { message: 'one k8s.session.end row of the shell, server_gone', timeout: 20_000 }).toEqual(['server_gone'])
  })

  test('NS-2: of two servers each holding a node shell, the one killed loses its shell pod and the other\'s shell stays Running with its socket open', async ({ page, request }) => {
    test.setTimeout(420_000)
    test.skip(readyPods(SERVER).length < 2, `NS-2 needs two ready ${SERVER} pods (scripts/kind-fault-shape.sh s2)`)
    await login(request)
    const before = new Set(shellPods().map((p) => p.name))
    await page.goto('/color-mode.js')
    // the gateway picks the server: open shells until two servers hold one
    const opened: ShellPod[] = []
    for (let i = 0; i < 8 && new Set(opened.map((p) => ownerPod(p.owner))).size < 2; i++) {
      await openShell(page, `s${i}`, node)
      const now = await newShellPods(before, i + 1)
      opened.splice(0, opened.length, ...now)
    }
    const owners = [...new Set(opened.map((p) => ownerPod(p.owner)))]
    test.skip(owners.length < 2, `eight shells all landed on ${owners[0]}: the gateway did not spread them`)
    const [killed, kept] = owners
    const keptPods = opened.filter((p) => ownerPod(p.owner) === kept)
    const killedPods = opened.filter((p) => ownerPod(p.owner) === killed)

    const done = atExit(`rollout of ${SERVER}`, () => rolledOut(SERVER, 240))
    const { at } = killNoSignal(killed)
    try {
      for (const p of killedPods) {
        const ms = await goneAfter(p.name, at, GONE_WITHIN_MS)
        expect(ms, `the killed server's shell pod ${p.name} is gone within ${GONE_WITHIN_MS} ms`).toBeGreaterThan(0)
      }
      while (Date.now() - at < GONE_WITHIN_MS) await sleep(5_000)
      const now = shellPods()
      for (const p of keptPods) {
        const still = now.find((x) => x.name === p.name)
        expect(still && !still.deleting && still.phase === 'Running', `the live server's shell pod ${p.name} stays Running`).toBe(true)
      }
      const keys = await page.evaluate(() => Object.keys((window as unknown as { __shells: Record<string, Shell> }).__shells))
      const keptOpen = []
      for (const k of keys) keptOpen.push((await shellOn(page, k)).closed === undefined)
      expect(keptOpen.filter(Boolean).length, 'the sockets of the live server\'s shells stay open').toBeGreaterThanOrEqual(keptPods.length)
    } finally {
      rolledOut(SERVER, 240)
      done()
    }
  })
})
