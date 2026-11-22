import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

import {
  CLUSTER, NS, atExit, bearer, deploymentExists, dockerFreezeTarget, envOf, freeze, freezeTargetOf, killNoSignal, kubectl, kubectlOk,
  login, psql, readyPods, rolledOut, sleep, stopFor, undoPending, type FreezeTarget,
} from './shared'

// Threat model v0.7.8 row 1.9 (F-1 with a node shell open): a k8s-service killed with no SIGTERM (SIGKILL from the
// container runtime, as the OOM killer ends a process) cannot delete the node shell pod it made. Each shell has a row in
// node_shells naming that server (owner), refreshed every 15 s; once the row has had no refresh for 60 s a live
// k8s-service — another pod, or the killed pod's restarted container — deletes the pod, as the person who opened the
// shell, and writes the shell's k8s.session.end row with the reason server_gone. A server that cannot save its
// heartbeat for 45 s closes its own node shells first (reason heartbeat_lost).
//
// - NS-1 (any number of servers): the node shell pod is gone within 150 s of the kill (60 s stale, a sweep every 30 s,
//   and a restarted server's first minute of database contact), not before 40 s (it is the sweep, not the server's own
//   cleanup), its row is gone, and exactly one k8s.session.end row names it with server_gone.
// - NS-2 (two ready servers): the killed server's shell pods go within 150 s; each shell of the server that stays keeps
//   its pod Running, its own socket open and its row's owner through the same 150 s.
// - NS-3a (PostgreSQL frozen 20 s, a shell open): through the freeze and 150 s after it the pod stays Running, the
//   socket open and the row's owner the same.
// - NS-3b (PostgreSQL stopped 60 s, a shell open): the shell's own server closes it while PostgreSQL is off, not
//   before 30 s after the stop was asked (45 s from its last saved beat), with the notice and the close reason
//   heartbeat_lost; its pod goes, and its row is gone within 150 s of PostgreSQL coming back.
//
// Needs nodeShell.enabled (NODE_SHELL_ENABLED true on the server that opens terminals) and table node_shells; NS-3a a
// PostgreSQL it may freeze (the chart's, or E2E_FAULT_PG_DOCKER), NS-3b the chart's PostgreSQL with a
// PersistentVolumeClaim; each skips with the reason otherwise. Opens shells on the first node of self with the install's default
// image; the pods this file made are deleted at the end whatever happened, and no other node shell is touched.

const SERVER = deploymentExists('k8s-service-stream') ? 'k8s-service-stream' : 'k8s-service'
const SHELL_NS = (deploymentExists(SERVER) && envOf(SERVER, 'NODE_SHELL_NAMESPACE')) || 'kubeast-node-shell'
const PG_DOCKER = process.env.E2E_FAULT_PG_DOCKER || ''
const GONE_WITHIN_MS = 150_000
const NOT_BEFORE_MS = 40_000
const SELF_STOP_MS = 45_000
// Under the 30 s a break may last with no shell closed (the owner closes only once 45 s pass from its last saved beat,
// which can be 15 s before the freeze), with room for the thaw's own delay.
const FREEZE_S = 20

type Shell = { statuses: string[]; text: string; closed?: { code: number; reason: string; at: number } }

// The node shell pods this file made, deleted after each test.
const made = new Set<string>()

// Opens a node shell socket in page (signed-in cookie, through the gateway) under window.__shells[key].
async function openShell(page: Page, key: string, node: string) {
  await page.evaluate(({ key, node, cluster }) => {
    const w = window as unknown as { __shells?: Record<string, Shell>; __shellWs?: Record<string, WebSocket> }
    w.__shells ??= {}
    w.__shellWs ??= {}
    const seen: Shell = { statuses: [], text: '' }
    w.__shells[key] = seen
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/cluster/nodes/${node}/debug-shell/ws?cluster=${cluster}&lang=en&cols=80&rows=24`)
    w.__shellWs[key] = ws
    ws.binaryType = 'arraybuffer'
    const decoder = new TextDecoder()
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') { seen.text += decoder.decode(new Uint8Array(e.data).slice(1)); return }
      try {
        const m = JSON.parse(e.data) as { type?: string; status?: string }
        if (m.type === 'status' && m.status) { seen.statuses.push(m.status); return }
      } catch { /* screen text */ }
      seen.text += e.data
    }
    ws.onclose = (e) => { seen.closed = { code: e.code, reason: e.reason, at: Date.now() } }
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

// Opens a shell under key and returns the one new pod it made (the pods present before it are left out).
async function openShellPod(page: Page, key: string, node: string): Promise<ShellPod> {
  const before = new Set(shellPods().map((p) => p.name))
  await openShell(page, key, node)
  let found: ShellPod[] = []
  await expect.poll(() => { found = shellPods().filter((p) => !before.has(p.name) && p.id !== '' && !p.deleting); return found.length }, { timeout: 30_000 }).toBe(1)
  made.add(found[0].name)
  return found[0]
}

// The k8s-service pod a shell's owner names (its host name, before the slash).
const ownerPod = (owner: string) => owner.split('/')[0]
const rowOwner = (id: string) => psql(`SELECT COALESCE((SELECT owner FROM node_shells WHERE id = '${id}'), '')`).trim()

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

// Holds, every 5 s until untilMs from from, that the pod is Running, the socket open and the row's owner the same.
async function staysLive(page: Page, key: string, pod: ShellPod, from: number, untilMs: number) {
  while (Date.now() - from < untilMs) {
    const p = shellPods().find((x) => x.name === pod.name)
    expect(p && !p.deleting && p.phase === 'Running', `${pod.name} stays Running ${Date.now() - from} ms in`).toBe(true)
    expect((await shellOn(page, key)).closed, `the socket of ${pod.name} stays open`).toBeUndefined()
    expect(rowOwner(pod.id), `the row of ${pod.name} keeps its owner`).toBe(pod.owner)
    await sleep(5_000)
  }
}

test.describe('Node shell pods of a killed server (threat model 1.9, F-1 with a node shell)', () => {
  test.describe.configure({ mode: 'serial' })
  let node = ''

  test.beforeAll(() => {
    test.skip(!deploymentExists(SERVER), `no ${SERVER} Deployment`)
    test.skip(envOf(SERVER, 'NODE_SHELL_ENABLED') !== 'true', `node shell is off on ${SERVER} (nodeShell.enabled false, the default): turn it on for this run and back after`)
    test.skip(psql(`SELECT COALESCE(to_regclass('node_shells')::text, '')`).trim() !== 'node_shells', 'no table node_shells (migration 00030)')
    test.skip(psql(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'node_shells' AND column_name = 'released_at'`).trim() !== '1',
      'node_shells has no released_at: the database took an earlier build of migration 00030 — drop the table and goose_db_version row 30, then upgrade again')
    node = kubectl(['get', 'nodes', '-o', 'jsonpath={.items[0].metadata.name}']).trim()
    expect(node, 'a node of self').not.toBe('')
  })

  test.afterEach(() => {
    undoPending()
    for (const name of made) kubectlOk(['-n', SHELL_NS, 'delete', 'pod', name, '--ignore-not-found', '--wait=false', '--grace-period=0'])
    made.clear()
  })

  test('NS-1: the server holding a node shell is killed with no SIGTERM — its shell pod is deleted within 150 s, by a sweep, with one server_gone row', async ({ page, request }) => {
    test.setTimeout(360_000)
    const token = await login(request)
    const since = new Date(Date.now() - 2_000).toISOString()
    await page.goto('/color-mode.js')
    const pod = await openShellPod(page, 'one', node)
    const server = ownerPod(pod.owner)
    expect(readyPods(SERVER).map((p) => p.name), 'the owner annotation names a ready server').toContain(server)
    expect(rowOwner(pod.id), 'the shell has its row').toBe(pod.owner)

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
    await expect.poll(() => rowOwner(pod.id), { message: 'the row goes', timeout: 20_000 }).toBe('')
    await expect.poll(async () => (await auditRows(request, token, 'k8s.session.end', since)).filter((r) => r.After?.pod === pod.name).map((r) => r.After?.reason),
      { message: 'one k8s.session.end row of the shell, server_gone', timeout: 20_000 }).toEqual(['server_gone'])
  })

  test('NS-2: of two servers each holding a node shell, the one killed loses its shell pods and each shell of the other stays Running with its own socket open and its row', async ({ page, request }) => {
    test.setTimeout(420_000)
    test.skip(readyPods(SERVER).length < 2, `NS-2 needs two ready ${SERVER} pods (scripts/kind-fault-shape.sh s2)`)
    await login(request)
    await page.goto('/color-mode.js')
    // the gateway picks the server: open shells until two servers hold one; each socket key is paired with its pod
    const opened: { key: string; pod: ShellPod }[] = []
    for (let i = 0; i < 8 && new Set(opened.map((o) => ownerPod(o.pod.owner))).size < 2; i++) {
      const key = `s${i}`
      opened.push({ key, pod: await openShellPod(page, key, node) })
    }
    const owners = [...new Set(opened.map((o) => ownerPod(o.pod.owner)))]
    test.skip(owners.length < 2, `eight shells all landed on ${owners[0]}: the gateway did not spread them`)
    const [killed, kept] = owners
    const keptShells = opened.filter((o) => ownerPod(o.pod.owner) === kept)
    const killedShells = opened.filter((o) => ownerPod(o.pod.owner) === killed)

    const done = atExit(`rollout of ${SERVER}`, () => rolledOut(SERVER, 240))
    const { at } = killNoSignal(killed)
    try {
      for (const o of killedShells) {
        const ms = await goneAfter(o.pod.name, at, GONE_WITHIN_MS)
        expect(ms, `the killed server's shell pod ${o.pod.name} is gone within ${GONE_WITHIN_MS} ms`).toBeGreaterThan(0)
      }
      while (Date.now() - at < GONE_WITHIN_MS) await sleep(5_000)
      for (const o of keptShells) {
        const p = shellPods().find((x) => x.name === o.pod.name)
        expect(p && !p.deleting && p.phase === 'Running', `the live server's shell pod ${o.pod.name} stays Running`).toBe(true)
        expect((await shellOn(page, o.key)).closed, `the socket of ${o.pod.name} stays open`).toBeUndefined()
        expect(rowOwner(o.pod.id), `the row of ${o.pod.name} keeps its owner`).toBe(o.pod.owner)
      }
    } finally {
      rolledOut(SERVER, 240)
      done()
    }
  })

  test('NS-3a: PostgreSQL frozen 20 s with a node shell open — the shell, its pod and its row\'s owner stay through the freeze and 150 s after', async ({ page, request }) => {
    test.setTimeout(420_000)
    const target = PG_DOCKER ? dockerFreezeTarget(PG_DOCKER)
      : deploymentExists('postgres') ? freezeTargetOf('postgres')
        : 'the install runs no postgres Deployment and E2E_FAULT_PG_DOCKER names no container of the external database'
    test.skip(typeof target === 'string', typeof target === 'string' ? target : '')
    await login(request)
    await page.goto('/color-mode.js')
    const pod = await openShellPod(page, 'frozen', node)
    const ice = freeze(target as FreezeTarget, FREEZE_S)
    await sleep(FREEZE_S * 1000)
    const thawedAt = ice.thaw()
    await staysLive(page, 'frozen', pod, ice.at, (thawedAt - ice.at) + GONE_WITHIN_MS)
  })

  test('NS-3b: PostgreSQL stopped 60 s with a node shell open — the shell\'s own server closes it with the reason while PostgreSQL is off, its pod goes, its row goes once PostgreSQL is back', async ({ page, request }) => {
    test.setTimeout(600_000)
    const volume = deploymentExists('postgres')
      ? kubectl(['-n', NS, 'get', 'deploy', 'postgres', '-o', "jsonpath={.spec.template.spec.volumes[?(@.name=='data')].persistentVolumeClaim.claimName}"])
      : ''
    test.skip(!volume, 'PostgreSQL keeps no PersistentVolumeClaim (external database or none): stopping it is not this test')
    await login(request)
    await page.goto('/color-mode.js')
    const pod = await openShellPod(page, 'stopped', node)
    const asked = Date.now()
    const outage = await stopFor('postgres', 60, async () => {
      await expect.poll(async () => (await shellOn(page, 'stopped')).closed?.at ?? 0, { message: 'the shell closes while PostgreSQL is off', timeout: 120_000, intervals: [500] }).toBeGreaterThan(0)
    })
    const shell = await shellOn(page, 'stopped')
    test.info().annotations.push({ type: 'shell closed', description: `${shell.closed!.at - asked} ms after PostgreSQL was asked to stop, ${shell.closed!.at - outage.offAt} ms after its last pod was gone` })
    expect(shell.text, 'the terminal says why').toContain('could not write it to the database')
    expect(shell.closed!.reason, 'closed as heartbeat_lost').toBe('heartbeat_lost')
    expect(shell.closed!.at, 'closed while PostgreSQL was off').toBeLessThan(outage.onAt)
    // the owner counts 45 s from its last saved beat, which is at most 15 s before PostgreSQL was asked to stop
    expect(shell.closed!.at - asked, 'not before 45 s of beats not saved').toBeGreaterThanOrEqual(SELF_STOP_MS - 15_000)
    expect(await goneAfter(pod.name, asked, GONE_WITHIN_MS + 60_000), 'its pod goes').toBeGreaterThan(0)
    await expect.poll(() => rowOwner(pod.id), { message: 'its row goes once PostgreSQL is back', timeout: GONE_WITHIN_MS, intervals: [5_000] }).toBe('')
  })
})
