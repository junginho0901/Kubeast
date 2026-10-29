import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Cluster View fetches the node map from the server and each node box's pods when the box is on screen, watching that
// node (fieldSelector spec.nodeName). What it shows must still be the cluster's and follow it at once: the map's counts
// against kubectl, the map's colours against the cards', a pod made, deleted and replaced, a search that finds a pod on
// the last of 200 nodes the page never drew, and only the boxes near the screen watching.

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

  test('on 200 nodes the search finds a pod on the last node, and only the boxes near the screen watch', async ({ page }) => {
    const nodes = Array.from({ length: 200 }, (_, i) => `e2e-node-${String(i).padStart(3, '0')}`)
    const summary = (q: string | null) => {
      const list = q ? nodes.slice(-1) : nodes
      return { nodes: list.map((n) => ({ node: n, total: 6, ok: 6, warn: 0, error: 0 })), total: list.length * 6, all: nodes.length * 6, revision: `e2e-${q ?? ''}`, source: 'index' }
    }
    await page.route('**/api/v1/cluster/pods/nodes?**', (route) => {
      const q = new URL(route.request().url()).searchParams.get('q')
      return route.fulfill({ json: summary(q) })
    })
    await page.route('**/api/v1/cluster/pods/on-node?**', (route) => {
      const n = new URL(route.request().url()).searchParams.get('node') ?? ''
      const pods = Array.from({ length: 6 }, (_, i) => ({ name: n === nodes[199] && i === 0 ? 'e2e-target-pod' : `${n}-p${i}`, namespace: 'e2e', node_name: n, phase: 'Running', status: 'Running', ready: '1/1', restart_count: 0, containers: [{ name: 'c', ready: true, state: { running: {} } }], init_containers: [], created_at: new Date().toISOString() }))
      return route.fulfill({ json: pods })
    })
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
    // the last node's box is not drawn yet
    await expect(box(page, nodes[199])).toHaveCount(0)

    await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill('e2e-target')
    await expect(page.getByTestId('cluster-view-search-count')).toContainText('6')
    await expect(card(page, 'e2e-target-pod')).toHaveCount(1)
    await expect(box(page, nodes[199])).toHaveCount(1)

    // without the search, scroll through the boxes: the watches open are those of the boxes drawn now
    await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill('')
    await expect(box(page, nodes[0])).toHaveCount(1)
    for (let y = 0; y < 20; y++) await page.mouse.wheel(0, 2000)
    await page.waitForTimeout(1500)
    const drawn = await page.getByTestId('cluster-view-node').count()
    expect(drawn).toBeLessThan(30)
    expect(open.size).toBeLessThanOrEqual(drawn)
  })

  test('a cell of the map opens its node\'s box', async ({ page }) => {
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
    await expect(box(page, cells[last][0])).toBeInViewport()
  })
})
