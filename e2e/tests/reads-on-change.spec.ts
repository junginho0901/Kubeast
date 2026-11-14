import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'

// What a screen asks of the server while nothing changes, counted request by request on cluster `self` in a namespace of
// this file's: an open drawer whose watch answers reads its object when it changes and not on the clock, a watch that
// does not answer goes back to the clock, the pages of pods send the revision they hold, a Pod drawer reads when its own
// row changes, a list the server has no room to follow is read on the clock and follows again by itself, and a list whose
// socket came back is read once.

const NS = 'e2e-reads-on-change'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

const kubeconfig = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-reads-')), 'kubeconfig')
fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const EN: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend/src/i18n/locales/en.json'), 'utf8'))
function tr(key: string): string {
  const value = key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), EN)
  if (typeof value !== 'string') throw new Error(`the en catalog has no ${key}`)
  return value
}

// nothing is scheduled: no node meets the selector, and the object's own writes are the only changes
const deployment = (name: string) => JSON.stringify({
  apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: NS },
  spec: {
    replicas: 0,
    selector: { matchLabels: { app: name } },
    template: {
      metadata: { labels: { app: name } },
      spec: { nodeSelector: { 'kubeast.io/e2e': 'nowhere' }, containers: [{ name: 'app', image: 'busybox:1.37', command: ['sleep', '3600'] }] },
    },
  },
})
const pod = (name: string) => JSON.stringify({
  apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: NS },
  spec: { terminationGracePeriodSeconds: 0, containers: [{ name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: ['sleep', '3600'] }] },
})

// Counts the requests whose path and query a test names, from the moment the page exists.
function counter(page: Page, match: (url: URL) => boolean) {
  const seen: URL[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (match(url)) seen.push(url)
  })
  return { count: () => seen.length, seen }
}
const objectReads = (page: Page, name: string) =>
  counter(page, (u) => u.pathname === '/api/v1/cluster/resources/json' && u.searchParams.get('resource_name') === name)
const answerReads = (page: Page, name: string) =>
  counter(page, (u) => u.pathname === `/api/v1/cluster/namespaces/${NS}/deployments/${name}/describe`)

test.describe('what a screen asks of the server', () => {
  // A failed test starts a new worker, which runs these again: the namespace the last one left is gone before it comes back.
  test.beforeAll(() => {
    test.setTimeout(180_000)
    kubectl(`delete namespace ${NS} --ignore-not-found --wait=true --timeout=120s`)
    kubectl('apply -f -', `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${NS}}`)
    for (const name of ['quiet', 'busy', 'refused']) kubectl('apply -f -', deployment(name))
  })
  test.afterAll(() => {
    test.setTimeout(180_000)
    kubectl(`delete namespace ${NS} --ignore-not-found --wait=true --timeout=120s`)
  })

  test('a quiet drawer reads its object and its answer once, and a change reaches the screen and both reads within seconds', async ({ page }) => {
    test.setTimeout(120_000)
    const object = objectReads(page, 'quiet')
    const answer = answerReads(page, 'quiet')
    await page.goto(`/workloads/deployments?cluster=self&namespace=${NS}&detail=Deployment/${NS}/quiet`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer).toContainText('quiet', { timeout: 20_000 })
    await expect.poll(object.count, { timeout: 20_000 }).toBe(1)

    await page.waitForTimeout(30_000)
    expect(object.count(), 'the object in 30 quiet seconds').toBe(1)
    expect(answer.count(), 'the answer in 30 quiet seconds').toBe(1)

    kubectl(`-n ${NS} label deployment quiet e2e-reads=one --overwrite`)
    await expect(drawer, 'the screen after a change').toContainText('e2e-reads:one', { timeout: 3_000 })
    await expect.poll(object.count, { timeout: 3_000, message: 'the object after a change' }).toBe(2)
    await expect.poll(answer.count, { timeout: 3_000, message: 'the answer after a change' }).toBe(2)
  })

  test('a drawer whose object keeps changing shows each change and reads once in five seconds at most, and the last one after', async ({ page }) => {
    test.setTimeout(120_000)
    const answer = answerReads(page, 'busy')
    const object = objectReads(page, 'busy')
    await page.goto(`/workloads/deployments?cluster=self&namespace=${NS}&detail=Deployment/${NS}/busy`)
    const drawer = page.locator(DRAWER).last()
    await expect(drawer).toContainText('busy', { timeout: 20_000 })
    await expect.poll(answer.count, { timeout: 20_000 }).toBe(1)
    await expect.poll(object.count, { timeout: 20_000 }).toBe(1)

    const started = Date.now()
    let last = 0
    while (Date.now() - started < 20_000) {
      last += 1
      kubectl(`-n ${NS} annotate deployment busy e2e-reads=${last} --overwrite`)
      kubectl(`-n ${NS} label deployment busy e2e-reads=${last} --overwrite`)
      await expect(drawer, 'each change shows without waiting for a read').toContainText(`e2e-reads:${last}`, { timeout: 3_000 })
    }
    const seconds = (Date.now() - started) / 1000
    expect(answer.count(), `the answer in ${seconds} s of ${last} changes`).toBeLessThanOrEqual(1 + Math.ceil(seconds / 5) + 1)
    expect(object.count(), `the object in ${seconds} s of ${last} changes`).toBeLessThanOrEqual(1 + Math.ceil(seconds / 10) + 1)

    // what only a read brings comes after the last change
    const annotations = JSON.parse(kubectl(`get deployment busy -n ${NS} -o json`)).metadata.annotations
    expect(annotations['e2e-reads']).toBe(String(last))
    const atLast = answer.count()
    await expect.poll(answer.count, { timeout: 7_000 }).toBe(atLast + 1)
    await page.waitForTimeout(12_000)
    expect(answer.count(), 'nothing more once it stays').toBe(atLast + 1)
  })

  test('a drawer whose watch does not answer reads its object on the clock, and stops when it answers', async ({ page }) => {
    test.setTimeout(120_000)
    let answer: ((frame: object) => void) | undefined
    let asked: { clusterId: string; path: string; query: string } | undefined
    await page.routeWebSocket(/wsMultiplexer/, (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => {
        const msg = JSON.parse(String(message))
        if (msg.type === 'REQUEST' && decodeURIComponent(msg.query).includes('metadata.name=refused')) {
          asked = msg
          ws.send(JSON.stringify({ ...msg, type: 'ERROR', error: { message: 'deployments is forbidden', reason: 'forbidden' } }))
          return
        }
        server.send(message)
      })
      server.onMessage((message) => ws.send(message))
      answer = (frame) => ws.send(JSON.stringify(frame))
    })
    const object = objectReads(page, 'refused')
    await page.goto(`/workloads/deployments?cluster=self&namespace=${NS}&detail=Deployment/${NS}/refused`)
    await expect(page.locator(DRAWER).last()).toContainText('refused', { timeout: 20_000 })
    await expect.poll(() => Boolean(asked), { timeout: 20_000 }).toBe(true)
    await expect(page.getByTestId('watch-problem-notice')).toHaveAttribute('data-problem', 'forbidden', { timeout: 20_000 })

    const before = object.count()
    await page.waitForTimeout(25_000)
    expect(object.count() - before, 'reads in 25 s without a watch').toBeGreaterThanOrEqual(2)

    answer!({ ...asked, type: 'RESYNC' })
    await expect(page.getByTestId('watch-problem-notice')).toHaveCount(0, { timeout: 5_000 })
    // the read that RESYNC asks for, within its spread
    await page.waitForTimeout(12_000)
    const settled = object.count()
    await page.waitForTimeout(25_000)
    expect(object.count(), 'reads in 25 s with a watch that answers').toBe(settled)
  })

  test('the Dashboard asks for the problem pods with the revision it holds', async ({ page }) => {
    test.setTimeout(90_000)
    const health = counter(page, (u) => u.pathname === '/api/v1/cluster/pods/page' && u.searchParams.get('sort') === 'health' && u.searchParams.get('limit') === '10')
    const first = page.waitForResponse((r) => r.url().includes('/api/v1/cluster/pods/page') && new URL(r.url()).searchParams.get('sort') === 'health')
    await page.goto('/?cluster=self')
    const body = await (await first).json() as { revision: string }
    expect(body.revision, 'the informers answer this cluster').not.toBe('')
    await expect.poll(health.count, { timeout: 45_000 }).toBeGreaterThanOrEqual(2)
    expect(health.seen[0].searchParams.get('revision')).toBeNull()
    expect(health.seen[1].searchParams.get('revision')).toBeTruthy()
  })

  test('the Dashboard\'s Pods window polls with the revision it holds', async ({ page }) => {
    test.setTimeout(120_000)
    const windowReads = counter(page, (u) => u.pathname === '/api/v1/cluster/pods/page' && u.searchParams.get('limit') === '50')
    await page.goto('/?cluster=self')
    await page.getByTestId('stat-pods').click()
    await expect.poll(windowReads.count, { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
    expect(windowReads.seen[0].searchParams.get('revision')).toBeNull()
    expect(windowReads.seen[1].searchParams.get('revision')).toBeTruthy()
  })

  test('an open Pod drawer on the Pods page reads when its own row changes, not when another pod\'s does', async ({ page }) => {
    test.setTimeout(150_000)
    for (const name of ['keep-one', 'keep-two']) kubectl('apply -f -', pod(name))
    kubectl(`-n ${NS} wait pod keep-one keep-two --for=condition=Ready --timeout=60s`)
    const describes = counter(page, (u) => u.pathname === `/api/v1/cluster/namespaces/${NS}/pods/keep-one/describe`)
    await page.goto(`/workloads/pods?cluster=self&namespace=${NS}&detail=Pod/${NS}/keep-one`)
    const rows = page.locator('main tbody tr')
    await expect(rows.filter({ hasText: 'keep-two' }), 'the other pod is on the page').toHaveCount(1, { timeout: 20_000 })
    await expect.poll(describes.count, { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
    await page.waitForTimeout(5_000)
    const before = describes.count()

    kubectl(`-n ${NS} delete pod keep-two --wait=false`)
    await expect(rows.filter({ hasText: 'keep-two' }), 'the page saw the other pod go').toHaveCount(0, { timeout: 30_000 })
    await page.waitForTimeout(8_000)
    expect(describes.count(), 'reads after another pod changed').toBe(before)

    kubectl(`-n ${NS} delete pod keep-one --wait=false`)
    await expect.poll(describes.count, { timeout: 30_000, message: 'reads after its own row changed' }).toBeGreaterThan(before)
  })

  // The page shows another namespace, so its rows cannot speak for the drawer's pod: the drawer's own read of the object
  // follows it, and another pod moving the page's revision reads nothing of it.
  test('an open Pod drawer whose pod is not on the Pods page reads when its own object changes, not when the page\'s pods do', async ({ page }) => {
    test.setTimeout(150_000)
    const VIEW = `${NS}-view`
    kubectl('apply -f -', `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${VIEW}}`)
    try {
      kubectl('apply -f -', pod('away-one'))
      kubectl('apply -f -', pod('shown-one').replace(`"namespace":"${NS}"`, `"namespace":"${VIEW}"`))
      kubectl(`-n ${NS} wait pod away-one --for=condition=Ready --timeout=60s`)
      kubectl(`-n ${VIEW} wait pod shown-one --for=condition=Ready --timeout=60s`)
      const describes = counter(page, (u) => u.pathname === `/api/v1/cluster/namespaces/${NS}/pods/away-one/describe`)
      await page.goto(`/workloads/pods?cluster=self&namespace=${VIEW}&detail=Pod/${NS}/away-one`)
      const rows = page.locator('main tbody tr')
      await expect(rows.filter({ hasText: 'shown-one' }), 'the page shows the other namespace').toHaveCount(1, { timeout: 20_000 })
      await expect(rows.filter({ hasText: 'away-one' }), 'the drawer\'s pod is not on the page').toHaveCount(0)
      await expect.poll(describes.count, { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
      await page.waitForTimeout(5_000)
      const before = describes.count()

      kubectl(`-n ${VIEW} delete pod shown-one --wait=false`)
      await expect(rows.filter({ hasText: 'shown-one' }), 'the page saw its pod go').toHaveCount(0, { timeout: 30_000 })
      await page.waitForTimeout(8_000)
      expect(describes.count(), 'reads after a pod of the page changed').toBe(before)

      kubectl(`-n ${NS} label pod away-one kubeast.io/e2e-reads=changed`)
      await expect.poll(describes.count, { timeout: 30_000, message: 'reads after its own object changed' }).toBeGreaterThan(before)
      await expect(page.locator(DRAWER).last().getByText('kubeast.io/e2e-reads').first()).toBeVisible({ timeout: 10_000 })
    } finally {
      kubectl(`-n ${NS} delete pod away-one --ignore-not-found --wait=false`)
      kubectl(`delete namespace ${VIEW} --ignore-not-found --wait=false`)
    }
  })

  test('a list the server has no room to follow says why, is read on the clock and follows again by itself', async ({ page }) => {
    test.setTimeout(420_000)
    const path = `/api/v1/namespaces/${NS}/configmaps`
    let room = false
    let refused = 0
    let requests = 0
    await page.routeWebSocket(/wsMultiplexer/, (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => {
        const msg = JSON.parse(String(message))
        if (msg.type === 'REQUEST' && msg.path === path) {
          requests += 1
          if (!room) {
            refused += 1
            ws.send(JSON.stringify({ type: 'ERROR', clusterId: msg.clusterId, path: msg.path, query: msg.query, error: { message: 'max subscriptions reached for the server (2000), cannot create new watch', reason: 'limit', limit_scope: 'server' } }))
            return
          }
        }
        server.send(message)
      })
      server.onMessage((message) => ws.send(message))
    })
    const lists = counter(page, (u) => u.pathname === `/api/v1/cluster/namespaces/${NS}/configmaps`)
    await page.goto(`/configuration/configmaps?cluster=self&namespace=${NS}`)
    const notice = page.getByTestId('watch-problem-notice')
    await expect(notice).toHaveAttribute('data-problem', 'server_limit', { timeout: 20_000 })
    await expect(notice).toContainText(tr('layout.watchProblem.serverLimit'))
    await expect.poll(lists.count, { timeout: 20_000 }).toBeGreaterThanOrEqual(1)

    // the list is read while it does not follow, and shows what changed by that read
    kubectl(`-n ${NS} create configmap read-on-the-clock --from-literal=a=1`)
    await expect(page.locator('main tbody tr').filter({ hasText: 'read-on-the-clock' }), 'a row by the next read').toHaveCount(1, { timeout: 90_000 })
    await expect.poll(() => refused, { timeout: 70_000, message: 'it asks for its place again' }).toBeGreaterThanOrEqual(2)

    room = true
    const askedBefore = requests
    // each refusal doubles the wait: up to 180 s after the third of those above
    await expect.poll(() => requests, { timeout: 190_000, message: 'it asks with room there' }).toBeGreaterThan(askedBefore)
    await expect(notice, 'the notice goes').toHaveCount(0, { timeout: 15_000 })

    // and follows again, with no reload: this row comes well before the next minute
    kubectl(`-n ${NS} create configmap live-again --from-literal=a=1`)
    await expect(page.locator('main tbody tr').filter({ hasText: 'live-again' }), 'a row by the watch').toHaveCount(1, { timeout: 5_000 })
  })

  // Nothing tells a list of a delete while its socket is gone, and the watch that opens on the next socket sends the
  // objects there are: the list says it missed the gap, and the server's RESYNC has it read once.
  test('a list whose socket came back leaves out a row deleted meanwhile, with one read and no reload', async ({ page }) => {
    test.setTimeout(120_000)
    for (const name of ['gone-meanwhile', 'stays']) kubectl(`-n ${NS} create configmap ${name} --from-literal=a=1`)
    const sockets: { page: WebSocketRoute; server: WebSocketRoute; relay: boolean }[] = []
    await page.routeWebSocket(/wsMultiplexer/, (ws) => {
      const server = ws.connectToServer()
      const socket = { page: ws, server, relay: true }
      sockets.push(socket)
      ws.onMessage((message) => server.send(message))
      server.onMessage((message) => { if (socket.relay) ws.send(message) })
    })
    const lists = counter(page, (u) => u.pathname === `/api/v1/cluster/namespaces/${NS}/configmaps`)
    await page.goto(`/configuration/configmaps?cluster=self&namespace=${NS}`)
    const row = (name: string) => page.locator('main tbody tr').filter({ has: page.getByRole('cell', { name, exact: true }) })
    await expect(row('gone-meanwhile')).toHaveCount(1, { timeout: 20_000 })
    await expect(row('stays')).toHaveCount(1)
    await expect.poll(lists.count, { timeout: 10_000 }).toBeGreaterThanOrEqual(1)

    // the socket brings nothing more, the object goes, then the socket closes
    const first = sockets[sockets.length - 1]
    first.relay = false
    kubectl(`-n ${NS} delete configmap gone-meanwhile --wait=true`)
    await page.waitForTimeout(2_000)
    await expect(row('gone-meanwhile'), 'nothing told the list').toHaveCount(1)
    const readsBefore = lists.count()
    const socketsBefore = sockets.length
    await first.server.close()
    await first.page.close()
    await expect.poll(() => sockets.length, { timeout: 40_000, message: 'the page opens another socket' }).toBeGreaterThan(socketsBefore)

    // the read waits up to five seconds after the watch is on
    await expect(row('gone-meanwhile')).toHaveCount(0, { timeout: 20_000 })
    await expect(row('stays')).toHaveCount(1)
    await page.waitForTimeout(6_000)
    expect(lists.count() - readsBefore, 'one read of the list').toBe(1)
  })
})
