import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// What a screen reader gets from Cluster View's node map: the canvas's name counts the nodes as `kubectl get nodes`
// does, and its live region names the cell a keyboard move reached, an arrow that could go no further (that cell
// again, read out again), and the node Enter opened; it says nothing when a pointer gives the focus or passes over the
// cells, and is emptied when the focus leaves. The line under the legend shows the same words and is hidden from
// assistive technology, so the tree holds them once. Seven cells are stood in (the node list's watch held in the
// browser, so no frame of the dev cluster's node comes in); the last test reads the dev cluster as it is.

const CLUSTER = 'self'

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cvspeech-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

// six nodes with pods, a seventh with none (no cell), and the pods no node took: 19 pods, 2 errors, 3 warnings
const STATUS: Record<string, string> = {
  'e2e-speech-a': 'Ready', 'e2e-speech-b': 'NotReady', 'e2e-speech-c': 'Ready,SchedulingDisabled', 'e2e-speech-d': 'Unknown,SchedulingDisabled',
  'e2e-speech-e': 'Ready', 'e2e-speech-f': 'Ready', 'e2e-speech-g': 'Ready',
}
const WITH_PODS = Object.keys(STATUS).slice(0, 6)
const podStandIn = (n: string, name: string) => ({ name, namespace: 'e2e', node_name: n, phase: 'Running', status: 'Running', ready: '1/1', restart_count: 0, containers: [{ name: 'c', ready: true, state: { running: {} } }], init_containers: [], created_at: new Date().toISOString() })

async function standIn(page: Page, lng: 'en' | 'ko') {
  await page.addInitScript((code) => { try { localStorage.setItem('i18nextLng', code) } catch { /* private mode */ } }, lng)
  const cells = [
    ...WITH_PODS.map((node, i) => ({ node, total: 3, ok: 3 - (i % 3 === 0 ? 0 : 1), warn: i % 3 === 2 ? 1 : 0, error: i % 3 === 1 ? 1 : 0 })),
    { node: '', total: 1, ok: 0, warn: 1, error: 0 },
  ]
  await page.route('**/api/v1/cluster/pods/nodes?**', (route) => route.fulfill({ json: { nodes: cells, total: 19, all: 19, revision: 'e2e-speech', source: 'index' } }))
  await page.route('**/api/v1/cluster/pods/on-node?**', (route) => {
    const n = new URL(route.request().url()).searchParams.get('node') ?? ''
    return route.fulfill({ json: [0, 1, 2].map((i) => podStandIn(n, `${n || 'unscheduled'}-p${i}`)) })
  })
  await page.route(/\/api\/v1\/cluster\/nodes(\?|$)/, async (route) => {
    const real = await (await route.fetch()).json() as Record<string, unknown>[]
    return route.fulfill({ json: Object.keys(STATUS).map((name) => ({ ...real[0], name, status: STATUS[name], roles: [] })) })
  })
  await page.routeWebSocket(/wsMultiplexer/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => {
      if (JSON.parse(String(message)).path === '/api/v1/nodes') return
      server.send(message)
    })
    server.onMessage((message) => ws.send(message))
  })
}

const canvasOf = (page: Page) => page.getByTestId('cluster-view-map').locator('canvas')
const live = (page: Page) => page.getByTestId('cluster-view-map-live')

async function openMap(page: Page) {
  await page.goto(`/cluster-view?cluster=${CLUSTER}`)
  await expect.poll(async () => JSON.parse((await canvasOf(page).getAttribute('data-cells')) ?? '[]').length, { timeout: 20_000 }).toBe(7)
  // every line the live region is given, in order: each is a node of its own, so the same words said again are read out again
  await page.evaluate(() => {
    const w = window as unknown as { __said: string[] }
    w.__said = []
    const region = document.querySelector('[data-testid="cluster-view-map-live"]')!
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) w.__said.push(n.textContent ?? '')
    }).observe(region, { childList: true, subtree: true, characterData: true })
  })
}
const said = (page: Page) => page.evaluate(() => (window as unknown as { __said: string[] }).__said)

// Tab from the search box until the canvas has the focus: a focus from the keyboard
async function tabToMap(page: Page) {
  await page.getByPlaceholder(/Search pod name|Pod 이름/i).focus()
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab')
    if (await canvasOf(page).evaluate((el) => el === document.activeElement)) return
  }
  throw new Error('Tab did not reach the node map')
}

test.describe('Cluster View — what a screen reader gets from the node map', () => {
  test('names the nodes as listed, each cell a key reaches, the ends and the node Enter opens (English)', async ({ page }) => {
    await standIn(page, 'en')
    await openMap(page)
    const canvas = canvasOf(page)
    // seven nodes listed (one with no pod, so no cell) and not the Unscheduled cell, a full stop before the marks
    await expect(canvas).toHaveAttribute('aria-label', 'Node map: 7 nodes, 19 pods (2 errors, 3 warnings). 2 nodes not Ready, 2 SchedulingDisabled.')
    await expect(live(page)).toHaveText('')

    await tabToMap(page)
    await expect(live(page)).toHaveText('e2e-speech-a · 3 pods · 0 errors · 0 warnings')
    // the first cell: an arrow back stays and says so, the second time too
    await page.keyboard.press('ArrowLeft')
    await expect(live(page)).toHaveText('e2e-speech-a · 3 pods · 0 errors · 0 warnings (end)')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => said(page)).toEqual([
      'e2e-speech-a · 3 pods · 0 errors · 0 warnings',
      'e2e-speech-a · 3 pods · 0 errors · 0 warnings (end)',
      'e2e-speech-a · 3 pods · 0 errors · 0 warnings (end)',
    ])
    await page.keyboard.press('ArrowRight')
    await expect(live(page)).toHaveText('e2e-speech-b · NotReady · 3 pods · 1 error · 0 warnings')
    await page.keyboard.press('ArrowRight')
    await expect(live(page)).toHaveText('e2e-speech-c · Ready,SchedulingDisabled · 3 pods · 0 errors · 1 warning')
    // the words are in the tree once: the line under the legend shows them and is hidden from assistive technology
    await expect(page.getByTestId('cluster-view-map-hover')).toHaveText('e2e-speech-c · Ready,SchedulingDisabled · 3 pods · 0 errors · 1 warning')
    await expect(page.getByTestId('cluster-view-map-hover')).toHaveAttribute('aria-hidden', 'true')
    const tree = await page.getByTestId('cluster-view-map').ariaSnapshot()
    expect(tree.split('e2e-speech-c · Ready,SchedulingDisabled').length - 1).toBe(1)
    // one row: down goes to the last cell, the pods no node took; right from there stays
    await page.keyboard.press('ArrowDown')
    await expect(live(page)).toHaveText('Unscheduled · 1 pod · 0 errors · 1 warning')
    await page.keyboard.press('ArrowRight')
    await expect(live(page)).toHaveText('Unscheduled · 1 pod · 0 errors · 1 warning (end)')

    // Enter opens the cell reached: the node's own view, the focus still on the map, and the region says which
    await page.keyboard.press('ArrowLeft')
    await expect(live(page)).toHaveText('e2e-speech-f · 3 pods · 0 errors · 1 warning')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/[?&]node=e2e-speech-f(&|$)/)
    await expect(page.getByTestId('cluster-view-node-view-name')).toHaveText('e2e-speech-f')
    await expect(live(page)).toHaveText('e2e-speech-f opened · 3 pods')
    expect(await canvas.evaluate((el) => el === document.activeElement)).toBe(true)

    // leaving the map empties the region
    await page.keyboard.press('Tab')
    await expect(live(page)).toHaveText('')
  })

  test('says nothing for a pointer\'s focus or a mouse over the cells, then names the cell an arrow reaches', async ({ page }) => {
    await standIn(page, 'en')
    await openMap(page)
    const canvas = canvasOf(page)
    const box = (await canvas.boundingBox())!
    // a press right of the cells (no cell: nothing opens), then the mouse over the first cell
    await page.mouse.click(box.x + box.width - 5, box.y + 5)
    expect(await canvas.evaluate((el) => el === document.activeElement)).toBe(true)
    await page.mouse.move(box.x + 6, box.y + 6)
    await expect(page.getByTestId('cluster-view-map-hover')).toHaveText('e2e-speech-a · 3 pods · 0 errors · 0 warnings')
    await expect(live(page)).toHaveText('')
    expect(await said(page)).toEqual([])
    await page.keyboard.press('ArrowRight')
    await expect(live(page)).toHaveText('e2e-speech-b · NotReady · 3 pods · 1 error · 0 warnings')
    await expect(page).not.toHaveURL(/[?&]node=/)
  })

  test('says the same in Korean', async ({ page }) => {
    await standIn(page, 'ko')
    await openMap(page)
    await expect(canvasOf(page)).toHaveAttribute('aria-label', 'Node 지도: Node 7개, Pod 19개(오류 2, 주의 3). Ready가 아닌 Node 2개, SchedulingDisabled 2개입니다.')
    await tabToMap(page)
    await expect(live(page)).toHaveText('e2e-speech-a · Pod 3개 · 오류 0 · 주의 0')
    await page.keyboard.press('ArrowLeft')
    await expect(live(page)).toHaveText('e2e-speech-a · Pod 3개 · 오류 0 · 주의 0 (끝)')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/[?&]node=e2e-speech-a(&|$)/)
    await expect(live(page)).toHaveText('e2e-speech-a 열림 · Pod 3개')
  })

  test('counts the dev cluster\'s nodes in the map\'s name as kubectl get nodes lists them', async ({ page }) => {
    const kubectl = kubectlFor('kubeast')
    const nodes = kubectl('get nodes -o name').split('\n').filter(Boolean).length
    await page.addInitScript(() => { try { localStorage.setItem('i18nextLng', 'en') } catch { /* private mode */ } })
    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    await expect(canvasOf(page)).toHaveAttribute('aria-label', new RegExp(`^Node map: ${nodes} nodes?, \\d+ pods?`), { timeout: 20_000 })
  })
})
