import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Cluster View fetches the node map from the server and each node box's pods when the box is on screen, watching that
// node (fieldSelector spec.nodeName); the boxes are paged by their pod cards under the map (at most 200 cards and ten
// boxes a page, a node of more pods than a page going on on the next). What it shows must still be the cluster's and
// follow it at once: the map's counts against kubectl, the map's colours against the cards', a pod made, deleted and
// replaced, a search that finds a pod on the last of 200 nodes the page never drew, only the boxes of the page near the
// screen watching, a map cell narrowing the boxes to its node and All nodes landing on that node's page, and every pod
// of a 250-pod node on one of two pages.

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
const card = (page: Page, name: string) => page.locator('[data-testid="cluster-view-node"] button', { hasText: name })
const BOXES_PER_PAGE = 10 // nodeBoxPages.ts NODE_BOXES_PER_PAGE
const CARDS_PER_PAGE = 200 // nodeBoxPages.ts POD_CARDS_PER_PAGE
const pager = (page: Page) => page.getByTestId('cluster-view-nodes-pager')
const podStandIn = (n: string, name: string) => ({ name, namespace: 'e2e', node_name: n, phase: 'Running', status: 'Running', ready: '1/1', restart_count: 0, containers: [{ name: 'c', ready: true, state: { running: {} } }], init_containers: [], created_at: new Date().toISOString() })

// 200 nodes of six pods stood in for the map and the boxes; a search finds the pod e2e-target-pod on the last node
const NODES_200 = Array.from({ length: 200 }, (_, i) => `e2e-node-${String(i).padStart(3, '0')}`)
async function standIn200Nodes(page: Page) {
  const summary = (q: string | null) => {
    const list = q ? NODES_200.slice(-1) : NODES_200
    return { nodes: list.map((n) => ({ node: n, total: 6, ok: 6, warn: 0, error: 0 })), total: list.length * 6, all: NODES_200.length * 6, revision: `e2e-${q ?? ''}`, source: 'index' }
  }
  await page.route('**/api/v1/cluster/pods/nodes?**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q')
    return route.fulfill({ json: summary(q) })
  })
  await page.route('**/api/v1/cluster/pods/on-node?**', (route) => {
    const n = new URL(route.request().url()).searchParams.get('node') ?? ''
    return route.fulfill({ json: Array.from({ length: 6 }, (_, i) => podStandIn(n, n === NODES_200[199] && i === 0 ? 'e2e-target-pod' : `${n}-p${i}`)) })
  })
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
    await expect(box(page, node).locator('button').first()).toBeVisible()
    await expect(box(page, node).locator('button svg.lucide-circle-x, button svg.lucide-x-circle')).toHaveCount(errors)
  })

  test('a pod made, deleted and replaced shows in its node\'s box at once, and the map follows', async ({ page }) => {
    const name = `e2e-cvlive-${Date.now().toString(36)}`
    const node = kubectl('get nodes -o jsonpath={.items[0].metadata.name}')
    const leaving = () => kubectl(`get namespaces,pods -A -o 'jsonpath={.items[?(@.metadata.deletionTimestamp)].metadata.name}'`)
    const onNode = () => kubectl(`get pods -A --field-selector spec.nodeName=${node} -o name`).split('\n').filter(Boolean).length
    try {
      // earlier specs delete their namespaces without waiting: a pod still leaving would move the count on its own
      await expect.poll(leaving, { timeout: 90_000 }).toBe('')
      await page.goto(`/cluster-view?cluster=${CLUSTER}`)
      await expect(box(page, node).locator('button').first()).toBeVisible()
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
    // the boxes are the first page of the 200 nodes, ten of six pods: the footer counts the pods, the last node's box is
    // not drawn
    await expect(pager(page)).toContainText(/Showing 1-60 of 1200|1200개 중 1-60 표시/)
    await expect(box(page, nodes[199])).toHaveCount(0)

    await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill('e2e-target')
    await expect(page.getByTestId('cluster-view-search-count')).toContainText('6')
    await expect(card(page, 'e2e-target-pod')).toHaveCount(1)
    await expect(box(page, nodes[199])).toHaveCount(1)
    await expect(pager(page)).toContainText(/Showing 1-6 of 6|6개 중 1-6 표시/)

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

  test('on 200 nodes a cell narrows the boxes to its node, kept in the address, and All nodes lands on that node\'s page', async ({ page }) => {
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
      found = (await page.getByTestId('cluster-view-map-legend').innerText()).startsWith(`${target} `)
    }
    expect(found, `the legend names ${target} under the mouse`).toBe(true)
    await page.mouse.down()
    await page.mouse.up()
    // only its box, its cell outlined, its six pods counted, the way back shown
    await expect(page).toHaveURL(new RegExp(`[?&]node=${target}(&|$)`))
    await expect(page.getByTestId('cluster-view-node')).toHaveCount(1)
    await expect(box(page, target).locator('button')).toHaveCount(6)
    await expect(canvas).toHaveAttribute('data-page-cells', '15,16')
    await expect(pager(page)).toContainText(/Showing 1-6 of 6|6개 중 1-6 표시/)
    await expect(page.getByTestId('cluster-view-node-filter')).toContainText(target)
    // a reload keeps it
    await page.reload()
    await expect(page.getByTestId('cluster-view-node')).toHaveCount(1)
    await expect(box(page, target)).toHaveCount(1)

    await page.getByTestId('cluster-view-node-filter-all').click()
    await expect(page).not.toHaveURL(/[?&]node=/)
    await expect(page.getByTestId('cluster-view-node-filter')).toHaveCount(0)
    await expect(pager(page)).toContainText(/Showing 61-120 of 1200|1200개 중 61-120 표시/)
    await expect(canvas).toHaveAttribute('data-page-cells', '10,20')
    await expect(box(page, target)).toBeInViewport()
    await expect(box(page, NODES_200[0])).toHaveCount(0)
  })

  test('a node of 250 pods is cut over two pages, the rest under its header again, and no pod is left out', async ({ page }) => {
    // e2e-big comes first in the map's order (by name), then ten nodes of six pods: 250 + 60 pods
    const small = Array.from({ length: 10 }, (_, i) => `e2e-node-${String(i).padStart(3, '0')}`)
    const counts: Record<string, number> = { 'e2e-big': 250, ...Object.fromEntries(small.map((n) => [n, 6])) }
    await page.route('**/api/v1/cluster/pods/nodes?**', (route) => route.fulfill({
      json: { nodes: Object.entries(counts).map(([node, total]) => ({ node, total, ok: total, warn: 0, error: 0 })), total: 310, all: 310, revision: 'e2e-big', source: 'index' },
    }))
    await page.route('**/api/v1/cluster/pods/on-node?**', (route) => {
      const n = new URL(route.request().url()).searchParams.get('node') ?? ''
      return route.fulfill({ json: Array.from({ length: counts[n] ?? 0 }, (_, i) => podStandIn(n, `${n}-p${String(i).padStart(3, '0')}`)) })
    })
    const bigCards = () => box(page, 'e2e-big').locator('button div.truncate').allInnerTexts()
    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    await expect(box(page, 'e2e-big').locator('button')).toHaveCount(CARDS_PER_PAGE)
    await expect(page.getByTestId('cluster-view-node')).toHaveCount(1)
    await expect(box(page, 'e2e-big').getByTestId('cluster-view-node-part')).toHaveText(/Pods 1–200 of 250 · continues on the next page|Pod 250개 중 1–200번째입니다\. 다음 페이지에 이어집니다\./)
    await expect(pager(page)).toContainText(/Showing 1-200 of 310|310개 중 1-200 표시/)
    const first = await bigCards()

    await pager(page).getByRole('button', { name: /Next|다음/ }).click()
    await expect(box(page, 'e2e-big').locator('button')).toHaveCount(50)
    await expect(box(page, 'e2e-big').getByTestId('cluster-view-node-part')).toHaveText(/Continued: Pods 201–250 of 250|이어지는 부분입니다\. Pod 250개 중 201–250번째입니다\./)
    // the rest of the node and nine of the small nodes: ten boxes (drawn as they near the screen), their cells outlined
    await expect(page.getByTestId('cluster-view-page-nodes')).toHaveText(/Page 2 of 3: Nodes 1–10 of 11\.|3쪽 중 2쪽: Node 11개 중 1–10번째입니다\./)
    await expect(page.getByTestId('cluster-view-map').locator('canvas')).toHaveAttribute('data-page-cells', String([0, BOXES_PER_PAGE]))
    await expect(pager(page)).toContainText(/Showing 201-304 of 310|310개 중 201-304 표시/)
    const second = await bigCards()
    const all = Array.from({ length: 250 }, (_, i) => `e2e-big-p${String(i).padStart(3, '0')}`)
    expect([...first, ...second], 'every pod of the node once, over the two pages').toEqual(all)
  })

  test('a cell of the map shows only its node\'s box, and All nodes shows every node again', async ({ page }) => {
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
      found = (await page.getByTestId('cluster-view-map-legend').innerText()).startsWith(target)
    }
    expect(found).toBe(true)
    await page.mouse.down()
    await page.mouse.up()
    await expect(page.getByTestId('cluster-view-node')).toHaveCount(1)
    await expect(box(page, cells[last][0])).toBeInViewport()
    await expect(page.getByTestId('cluster-view-node-filter')).toContainText(target)
    await page.getByTestId('cluster-view-node-filter-all').click()
    await expect(page).not.toHaveURL(/[?&]node=/)
    await expect(page.getByTestId('cluster-view-node-filter')).toHaveCount(0)
    await expect(box(page, cells[last][0])).toBeInViewport()
  })
})
