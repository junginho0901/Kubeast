import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Cluster View fetches the node map from the server and each node box's pods when the box is on screen, watching that
// node (fieldSelector spec.nodeName); the boxes are paged ten at a time under the map, each drawing at most twelve pod
// cards (problems first) with "show all", and a map cell or "show all" opens the node's own view, its pods by name
// sixty a page. What it shows must still be the cluster's and follow it at once: the map's counts against kubectl, the
// map's colours against the cards', a pod made, deleted and replaced, a search that finds a pod on the last of 200
// nodes the page never drew, only the boxes of the page near the screen watching, a map cell opening the node's own view
// (kept in the address) and All nodes going back to its page, every pod of a 250-pod node on the five pages of its own
// view, a search opening that view on the page of the pod it found, and the NotReady and cordoned marks the node list
// gives (stood in: no spec changes the dev cluster's node).

const CLUSTER = 'self'

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cvlive-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const kubectl = kubectlFor('kubeast')
const tryKubectl = (args: string) => { try { return kubectl(args) } catch { return null } }

type Cell = [node: string, ok: number, warn: number, error: number]
const total = (c: Cell) => c[1] + c[2] + c[3]
const mapCells = async (page: Page): Promise<Cell[]> =>
  JSON.parse((await page.getByTestId('cluster-view-map').locator('canvas').getAttribute('data-cells')) ?? '[]')
const box = (page: Page, node: string) => page.locator(`[data-testid="cluster-view-node"][data-node="${node}"]`)
const card = (page: Page, name: string) => page.locator('[data-testid="cluster-view-node"] [data-testid="cluster-view-pod"]', { hasText: name })
const BOXES_PER_PAGE = 10 // nodeBoxPages.ts NODE_BOXES_PER_PAGE
const PREVIEW_CARDS = 12 // nodeBoxPages.ts BOX_PREVIEW_CARDS
const NODE_PODS_PER_PAGE = 60 // nodeBoxPages.ts NODE_PODS_PER_PAGE
const podStandIn = (n: string, name: string, phase = 'Running') => ({ name, namespace: 'e2e', node_name: n, phase, status: phase, ready: phase === 'Running' ? '1/1' : '0/1', restart_count: 0, containers: [{ name: 'c', ready: phase === 'Running', state: { running: {} } }], init_containers: [], created_at: new Date().toISOString() })

// 200 nodes of six pods stood in for the map and the boxes; a search finds the pod e2e-target-pod on the last node. The
// summary counts what a search matches as the server's does (podRowHas: name, namespace, node).
const NODES_200 = Array.from({ length: 200 }, (_, i) => `e2e-node-${String(i).padStart(3, '0')}`)
const pods200 = (n: string) => Array.from({ length: 6 }, (_, i) => podStandIn(n, n === NODES_200[199] && i === 0 ? 'e2e-target-pod' : `${n}-p${i}`))
async function standIn200Nodes(page: Page) {
  const summary = (q: string) => {
    const nodes = NODES_200.map((node) => ({ node, total: pods200(node).filter((p) => [p.name, p.namespace, p.node_name].some((v) => v.includes(q))).length }))
      .filter((c) => c.total > 0).map((c) => ({ ...c, ok: c.total, warn: 0, error: 0 }))
    return { nodes, total: nodes.reduce((t, c) => t + c.total, 0), all: NODES_200.length * 6, revision: `e2e-${q}`, source: 'index' }
  }
  await page.route('**/api/v1/cluster/pods/nodes?**', (route) => route.fulfill({ json: summary(new URL(route.request().url()).searchParams.get('q') ?? '') }))
  await page.route('**/api/v1/cluster/pods/on-node?**', (route) => route.fulfill({ json: pods200(new URL(route.request().url()).searchParams.get('node') ?? '') }))
}

test.describe('Cluster View — node map, boxes on screen, live', () => {
  test('the map counts each node\'s pods as the cluster has them, in the cards\' colours', async ({ page }) => {
    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    await expect(page.getByTestId('cluster-view-map')).toBeVisible()
    // the cluster's pods per node ("" = not scheduled), against the map's cells (polled: pods come and go)
    const perNode = () => {
      const out: Record<string, number> = {}
      for (const p of JSON.parse(kubectl('get pods -A -o json')).items as { spec: { nodeName?: string } }[]) out[p.spec.nodeName ?? ''] = (out[p.spec.nodeName ?? ''] ?? 0) + 1
      return out
    }
    const norm = (o: Record<string, number>) => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)))
    await expect.poll(async () => {
      const shown = Object.fromEntries((await mapCells(page)).map(([n, ok, warn, error]) => [n, ok + warn + error]))
      return norm(shown) === norm(perNode())
    }, { timeout: 20_000 }).toBe(true)

    // the node box's red icons are the map's errors for that node (the server and the page colour alike)
    const node = kubectl('get nodes -o jsonpath={.items[0].metadata.name}')
    const errors = (await mapCells(page)).find(([n]) => n === node)?.[3] ?? 0
    // the box draws its errors first, up to its twelve cards
    await expect(box(page, node).getByTestId('cluster-view-pod').first()).toBeVisible()
    await expect(box(page, node).getByTestId('cluster-view-pod').locator('svg.lucide-circle-x, svg.lucide-x-circle')).toHaveCount(Math.min(errors, PREVIEW_CARDS))
  })

  test('a pod made, deleted and replaced shows in its node\'s own view at once, and the map follows', async ({ page }) => {
    const name = `e2e-cvlive-${Date.now().toString(36)}`
    const node = kubectl('get nodes -o jsonpath={.items[0].metadata.name}')
    const leaving = () => kubectl(`get namespaces,pods -A -o 'jsonpath={.items[?(@.metadata.deletionTimestamp)].metadata.name}'`)
    // the namespace default, whose pods on the node fit one page of the node's own view
    const onNode = () => kubectl(`-n default get pods --field-selector spec.nodeName=${node} -o name`).split('\n').filter(Boolean).length
    try {
      // earlier specs delete their namespaces without waiting: a pod still leaving would move the count on its own
      await expect.poll(leaving, { timeout: 90_000 }).toBe('')
      expect(onNode(), 'the node\'s pods in default fit one page').toBeLessThan(NODE_PODS_PER_PAGE)
      await page.goto(`/cluster-view?cluster=${CLUSTER}&namespace=default&node=${node}`)
      await expect(box(page, node).getByTestId('cluster-view-pod').first()).toBeVisible()
      await expect.poll(async () => total((await mapCells(page)).find(([n]) => n === node)!), { timeout: 10_000 }).toBe(onNode())
      const before = (await mapCells(page)).find(([n]) => n === node)!

      kubectl(`-n default create deployment ${name} --image=registry.k8s.io/pause:3.10`)
      await expect(card(page, name)).toHaveCount(1, { timeout: 15_000 })
      await expect.poll(async () => total((await mapCells(page)).find(([n]) => n === node)!), { timeout: 10_000 }).toBe(total(before) + 1)

      // the pod dies and its Deployment makes another: the old card goes, a new one comes
      const first = kubectl(`-n default get pods -l app=${name} -o jsonpath={.items[0].metadata.name}`)
      kubectl(`-n default delete pod ${first} --grace-period=0 --force --wait=false`)
      await expect(card(page, first)).toHaveCount(0, { timeout: 15_000 })
      await expect.poll(async () => {
        const now = tryKubectl(`-n default get pods -l app=${name} -o jsonpath={.items[0].metadata.name}`)
        return now && now !== first ? await card(page, now).count() : 0
      }, { timeout: 20_000 }).toBe(1)

      kubectl(`-n default delete deployment ${name} --wait=false`)
      await expect(card(page, name)).toHaveCount(0, { timeout: 20_000 })
      await expect.poll(async () => total((await mapCells(page)).find(([n]) => n === node)!), { timeout: 15_000 }).toBe(total(before))
    } finally {
      tryKubectl(`-n default delete deployment ${name} --ignore-not-found --wait=false`)
    }
  })

  test('on 200 nodes the search finds a pod on the last node, and only the boxes of the page near the screen watch', async ({ page }) => {
    const nodes = NODES_200
    await standIn200Nodes(page)
    const open = new Set<string>()
    page.on('websocket', (ws) => ws.on('framesent', (f) => {
      const msg = JSON.parse(String(f.payload)) as { type: string; query?: string; path?: string }
      if (!msg.query?.includes('spec.nodeName')) return
      const key = `${msg.path}?${msg.query}`
      if (msg.type === 'REQUEST') open.add(key)
      if (msg.type === 'CLOSE') open.delete(key)
    }))

    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    await expect(page.getByTestId('cluster-view-map')).toBeVisible()
    expect((await mapCells(page)).length).toBe(200)
    // the boxes are the first page of the 200 nodes: the last node's box is not drawn
    await expect(page.getByTestId('cluster-view-nodes-pager')).toContainText(/Showing 1-10 of 200|200개 중 1-10 표시/)
    await expect(box(page, nodes[199])).toHaveCount(0)

    await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill('e2e-target')
    await expect(page.getByTestId('cluster-view-search-count')).toContainText(/(Results|검색 결과): 1 /)
    await expect(card(page, 'e2e-target-pod')).toHaveCount(1)
    await expect(box(page, nodes[199])).toHaveCount(1)
    await expect(page.getByTestId('cluster-view-nodes-pager')).toContainText(/Showing 1-1 of 1|1개 중 1-1 표시/)

    // without the search, scroll through the page: the boxes drawn are the page's at most, and the watches open are
    // those of the boxes drawn now
    await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill('')
    await expect(box(page, nodes[0])).toHaveCount(1)
    for (let y = 0; y < 20; y++) await page.mouse.wheel(0, 2000)
    await page.waitForTimeout(1500)
    const drawn = await page.getByTestId('cluster-view-node').count()
    expect(drawn).toBeLessThanOrEqual(BOXES_PER_PAGE)
    expect(open.size).toBeLessThanOrEqual(drawn)
  })

  test('on 200 nodes a cell opens the node\'s own view, kept in the address, and All nodes goes back to its page', async ({ page }) => {
    await standIn200Nodes(page)
    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    const canvas = page.getByTestId('cluster-view-map').locator('canvas')
    await expect(canvas).toBeVisible()
    await expect(canvas).toHaveAttribute('data-page-cells', '0,10')
    // node 15 is the sixth box of the second page; its cell is on the map's first row (cells of about 30 px)
    const target = NODES_200[15]
    const at = (await canvas.boundingBox())!
    let found = false
    for (let x = 4; x < Math.min(at.width, 900) && !found; x += 6) {
      await page.mouse.move(at.x + x, at.y + 6)
      found = (await page.getByTestId('cluster-view-map-hover').innerText()).startsWith(`${target} `)
    }
    expect(found, `the legend names ${target} under the mouse`).toBe(true)
    await page.mouse.down()
    await page.mouse.up()
    // its own view: its box alone with its six pods, its cell outlined, the way back above it
    await expect(page).toHaveURL(new RegExp(`[?&]node=${target}(&|$)`))
    await expect(page.getByTestId('cluster-view-node')).toHaveCount(1)
    await expect(box(page, target).getByTestId('cluster-view-pod')).toHaveCount(6)
    await expect(canvas).toHaveAttribute('data-page-cells', '15,16')
    await expect(page.getByTestId('cluster-view-node-view-name')).toHaveText(target)
    await expect(page.getByTestId('cluster-view-node-pods-pager')).toContainText(/Showing 1-6 of 6|6개 중 1-6 표시/)
    await expect(page.getByTestId('cluster-view-nodes-pager')).toHaveCount(0)
    // a reload opens it again
    await page.reload()
    await expect(page.getByTestId('cluster-view-node')).toHaveCount(1)
    await expect(box(page, target)).toHaveCount(1)

    await page.getByTestId('cluster-view-all-nodes').click()
    await expect(page).not.toHaveURL(/[?&]node=/)
    await expect(page.getByTestId('cluster-view-nodes-pager')).toContainText(/Showing 11-20 of 200|200개 중 11-20 표시/)
    await expect(canvas).toHaveAttribute('data-page-cells', '10,20')
    await expect(box(page, target)).toBeInViewport()
    await expect(box(page, NODES_200[0])).toHaveCount(0)
  })

  // e2e-big comes first in the map's order (by name), then ten nodes of six pods; every 25th pod of e2e-big from p005 is
  // Failed. A search counts the pods whose name has it, as the server's does.
  async function standInBigNode(page: Page) {
    const small = Array.from({ length: 10 }, (_, i) => `e2e-node-${String(i).padStart(3, '0')}`)
    const podsOf = (n: string) => n === 'e2e-big'
      ? Array.from({ length: 250 }, (_, i) => podStandIn(n, `${n}-p${String(i).padStart(3, '0')}`, i % 25 === 5 ? 'Failed' : 'Running'))
      : small.includes(n) ? Array.from({ length: 6 }, (_, i) => podStandIn(n, `${n}-p${i}`)) : []
    await page.route('**/api/v1/cluster/pods/nodes?**', (route) => {
      const q = new URL(route.request().url()).searchParams.get('q') ?? ''
      const nodes = ['e2e-big', ...small].map((node) => {
        const pods = podsOf(node).filter((p) => p.name.includes(q))
        const error = pods.filter((p) => p.phase === 'Failed').length
        return { node, total: pods.length, ok: pods.length - error, warn: 0, error }
      }).filter((n) => n.total > 0)
      const total = nodes.reduce((t, n) => t + n.total, 0)
      return route.fulfill({ json: { nodes, total, all: 310, revision: `e2e-big-${q}`, source: 'index' } })
    })
    await page.route('**/api/v1/cluster/pods/on-node?**', (route) => route.fulfill({ json: podsOf(new URL(route.request().url()).searchParams.get('node') ?? '') }))
  }

  test('a node of 250 pods shows twelve cards, problems first, and every pod on the five pages of its own view', async ({ page }) => {
    await standInBigNode(page)
    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    const big = box(page, 'e2e-big')
    await expect(big.getByTestId('cluster-view-pod')).toHaveCount(PREVIEW_CARDS)
    await expect(big.getByTestId('cluster-view-node-shown')).toHaveText(/Showing 12 of 250 Pods|Pod 250개 중 12개를 보여 줍니다\./)
    // the ten Failed pods first, then the rest by name
    const preview = await big.locator('[data-testid="cluster-view-pod"] div.truncate').allInnerTexts()
    expect(preview).toEqual([...Array.from({ length: 10 }, (_, i) => `e2e-big-p${String(5 + 25 * i).padStart(3, '0')}`), 'e2e-big-p000', 'e2e-big-p001'])

    await big.getByTestId('cluster-view-node-more').click()
    await expect(page).toHaveURL(/[?&]node=e2e-big(&|$)/)
    const pager = page.getByTestId('cluster-view-node-pods-pager')
    const seen: string[] = []
    for (let p = 1; p <= 5; p++) {
      const first = p * 60 - 59
      await expect(pager).toContainText(new RegExp(`Showing ${first}-${Math.min(p * 60, 250)} of 250|250개 중 ${first}-${Math.min(p * 60, 250)} 표시`))
      seen.push(...await big.locator('[data-testid="cluster-view-pod"] div.truncate').allInnerTexts())
      if (p < 5) await pager.getByRole('button', { name: /Next|다음/ }).click()
    }
    expect(seen, 'every pod once, by name, over the five pages').toEqual(Array.from({ length: 250 }, (_, i) => `e2e-big-p${String(i).padStart(3, '0')}`))

    // a search typed in the node's own view goes to the page of its first match, that card marked
    const search = page.getByPlaceholder(/Search pod name|Pod 이름/i)
    await search.fill('e2e-big-p20')
    await expect(pager).toContainText(/Showing 181-240 of 250|250개 중 181-240 표시/)
    await expect(big.locator('[data-testid="cluster-view-pod"][data-focus="true"]')).toContainText('e2e-big-p200')
    await expect(page.getByTestId('cluster-view-node-matches')).toContainText(/: 10 on this Node|10개 있습니다/)

    // problem pods only: the ten Failed ones, on one page; the matches counted among them (e2e-big-p205 is one)
    await page.getByTestId('cluster-view-problems-only').check()
    await expect(big.getByTestId('cluster-view-pod')).toHaveCount(10)
    await expect(pager).toContainText(/Showing 1-10 of 10|10개 중 1-10 표시/)
    await expect(page.getByTestId('cluster-view-node-matches')).toContainText(/: 1 on this Node|1개 있습니다/)
  })

  test('a search opens the node\'s own view on the page of the pod it found, that card outlined', async ({ page }) => {
    await standInBigNode(page)
    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill('e2e-big-p130')
    await expect(page.getByTestId('cluster-view-search-count')).toContainText('1')
    const big = box(page, 'e2e-big')
    await expect(big.getByTestId('cluster-view-pod')).toHaveCount(1)
    await big.getByTestId('cluster-view-node-more').click()
    await expect(page).toHaveURL(/[?&]pod=e2e%2Fe2e-big-p130(&|$)/)
    await expect(page.getByTestId('cluster-view-node-pods-pager')).toContainText(/Showing 121-180 of 250|250개 중 121-180 표시/)
    await expect(big.locator('[data-testid="cluster-view-pod"][data-focus="true"]')).toContainText('e2e-big-p130')
    await expect(big.locator('[data-testid="cluster-view-pod"][data-match="true"]')).toHaveCount(1)
  })

  test('a node not Ready or cordoned is marked on its cell, in the legend and on its box, and follows a watch frame', async ({ page }) => {
    // the map, the boxes and the node list stood in, and the node list's watch held in the browser (the dev cluster's node
    // is never changed): kubectl's STATUS per node, then a MODIFIED frame on that watch
    const status: Record<string, string> = { 'e2e-mark-a': 'Ready', 'e2e-mark-b': 'NotReady', 'e2e-mark-c': 'Ready,SchedulingDisabled', 'e2e-mark-d': 'Unknown,SchedulingDisabled' }
    const names = Object.keys(status)
    let row: Record<string, unknown> = {}
    await page.route('**/api/v1/cluster/pods/nodes?**', (route) => route.fulfill({
      json: { nodes: names.map((node) => ({ node, total: 2, ok: 2, warn: 0, error: 0 })), total: 8, all: 8, revision: 'e2e-marks', source: 'index' },
    }))
    await page.route('**/api/v1/cluster/pods/on-node?**', (route) => {
      const n = new URL(route.request().url()).searchParams.get('node') ?? ''
      return route.fulfill({ json: [0, 1].map((i) => podStandIn(n, `${n}-p${i}`)) })
    })
    await page.route(/\/api\/v1\/cluster\/nodes(\?|$)/, async (route) => {
      const real = await (await route.fetch()).json() as Record<string, unknown>[]
      row = real[0]
      return route.fulfill({ json: names.map((name) => ({ ...row, name, status: status[name], roles: [] })) })
    })
    let send: ((frame: object) => void) | undefined
    let asked: { clusterId: string; path: string; query: string } | undefined
    await page.routeWebSocket(/wsMultiplexer/, (ws) => {
      const server = ws.connectToServer()
      ws.onMessage((message) => {
        const msg = JSON.parse(String(message))
        // the node list's watch stays in the browser, so no frame of the dev cluster's node comes in
        if (msg.path === '/api/v1/nodes') {
          if (msg.type === 'REQUEST') asked = msg
          return
        }
        server.send(message)
      })
      server.onMessage((message) => ws.send(message))
      send = (frame) => ws.send(JSON.stringify(frame))
    })
    const canvas = page.getByTestId('cluster-view-map').locator('canvas')
    const badges = (node: string) => box(page, node).getByTestId('cluster-view-node-status')

    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    await expect(canvas).toHaveAttribute('data-node-marks', JSON.stringify({ 'e2e-mark-b': 'NotReady', 'e2e-mark-c': 'Ready,SchedulingDisabled', 'e2e-mark-d': 'Unknown,SchedulingDisabled' }))
    await expect(page.getByTestId('cluster-view-map-not-ready')).toHaveText(/(Node not Ready|Ready가 아닌 Node) 2/)
    await expect(page.getByTestId('cluster-view-map-cordoned')).toHaveText(/SchedulingDisabled 2/)
    await expect(badges('e2e-mark-a')).toHaveCount(0)
    await expect(badges('e2e-mark-b')).toHaveText(['NotReady'])
    await expect(badges('e2e-mark-c')).toHaveText(['SchedulingDisabled'])
    await expect(badges('e2e-mark-d')).toHaveText(['Unknown', 'SchedulingDisabled'])

    // a watch frame: e2e-mark-a turns NotReady and e2e-mark-c is uncordoned, with no reload
    await expect.poll(() => Boolean(asked), { timeout: 20_000 }).toBe(true)
    const frame = (name: string, s: string) => ({ ...asked, type: 'DATA', data: { type: 'MODIFIED', object: { ...row, name, status: s, roles: [] } } })
    send!(frame('e2e-mark-a', 'NotReady'))
    send!(frame('e2e-mark-c', 'Ready'))
    await expect(canvas).toHaveAttribute('data-node-marks', JSON.stringify({ 'e2e-mark-a': 'NotReady', 'e2e-mark-b': 'NotReady', 'e2e-mark-d': 'Unknown,SchedulingDisabled' }), { timeout: 10_000 })
    await expect(page.getByTestId('cluster-view-map-not-ready')).toHaveText(/(Node not Ready|Ready가 아닌 Node) 3/)
    await expect(page.getByTestId('cluster-view-map-cordoned')).toHaveText(/SchedulingDisabled 1/)
    await expect(badges('e2e-mark-a')).toHaveText(['NotReady'])
    await expect(badges('e2e-mark-c')).toHaveCount(0)

    // the legend's count opens the first such node's own view
    await page.getByTestId('cluster-view-map-cordoned').click()
    await expect(page.getByTestId('cluster-view-node-view-name')).toHaveText('e2e-mark-d')
    await expect(badges('e2e-mark-d')).toHaveText(['Unknown', 'SchedulingDisabled'])
  })

  test('a cell of the map opens its node\'s own view, and All nodes brings the overview back', async ({ page }) => {
    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    const canvas = page.getByTestId('cluster-view-map').locator('canvas')
    await expect(canvas).toBeVisible()
    const cells = await mapCells(page)
    test.skip(cells.length < 2, 'one node only')
    const last = cells.length - 1
    // hover along the first row until the legend names the last node's cell, then click it
    const at = (await canvas.boundingBox())!
    const target = cells[last][0] || 'Unscheduled'
    let found = false
    for (let x = 4; x < Math.min(at.width, 600) && !found; x += 6) {
      await page.mouse.move(at.x + x, at.y + 6)
      found = (await page.getByTestId('cluster-view-map-hover').innerText()).startsWith(target)
    }
    expect(found).toBe(true)
    await page.mouse.down()
    await page.mouse.up()
    await expect(page.getByTestId('cluster-view-node')).toHaveCount(1)
    await expect(page.getByTestId('cluster-view-node-view-name')).toHaveText(target)
    await expect(box(page, cells[last][0])).toBeInViewport()
    // opening it was a history entry: Back returns to every node of this page, Forward opens it again
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/cluster-view\\?cluster=${CLUSTER}$`))
    await expect(page.getByTestId('cluster-view-nodes')).toBeVisible()
    await expect(page.getByTestId('cluster-view-node-view')).toHaveCount(0)
    await page.goForward()
    await expect(page.getByTestId('cluster-view-node-view-name')).toHaveText(target)
    await page.getByTestId('cluster-view-all-nodes').click()
    await expect(page).not.toHaveURL(/[?&]node=/)
    await expect(page.getByTestId('cluster-view-node-view')).toHaveCount(0)
    await expect(box(page, cells[last][0])).toBeInViewport()
    // All Nodes was a history entry too: Back opens the node's own view again
    await page.goBack()
    await expect(page.getByTestId('cluster-view-node-view-name')).toHaveText(target)
  })
})
