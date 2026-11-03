import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Number check of Cluster View on cluster `self`: the map's legend adds up to the cluster's pods; with a namespace
// chosen each node's cell, box badge and the Unscheduled box are the pods kubectl lists on that node, in the colours
// the cards draw; the search counts the pods whose name or namespace has the text, out of all; a grant limited to a
// namespace maps that namespace's pods; and the floating chat is told the same numbers, a node ready as kubectl prints
// it. The colour of a pod is Kubeast's rule (podHealth), so against kubectl only the sums are compared, and the split
// against the cards and the pods made here, whose colours are known.

const SCREENS = [{ path: '/cluster-view', cluster: 'self' }]
const CLUSTER = SCREENS[0].cluster
const NS = 'e2e-cv-num'
const READ_GROUP = 'kubeast:role:read'
const RBAC = 'e2e-cv-num'
const box = (name: string, command: string[]) => ({ name, image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command })
const pod = (name: string, spec: object) => JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: NS }, spec: { terminationGracePeriodSeconds: 0, ...spec } })
// colours by podHealth: Running and ready, Succeeded → ok · Pending (an init container waiting, no node fits) → warn ·
// Failed → error
const FIXTURE = [
  `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${NS}}`,
  pod('e2e-cv-run-1', { containers: [box('app', ['sleep', '3600'])] }),
  pod('e2e-cv-run-2', { containers: [box('app', ['sleep', '3600'])] }),
  pod('e2e-cv-done', { restartPolicy: 'Never', containers: [box('app', ['true'])] }),
  pod('e2e-cv-failed', { restartPolicy: 'Never', containers: [box('app', ['sh', '-c', 'exit 1'])] }),
  pod('e2e-cv-init', { initContainers: [box('wait', ['sleep', '3600'])], containers: [box('app', ['sleep', '3600'])] }),
  pod('e2e-cv-unsched', { nodeSelector: { 'e2e-cv-num': 'no-such-node' }, containers: [box('app', ['sleep', '3600'])] }),
].join('\n---\n')
const KNOWN = { ok: 3, warn: 2, error: 1 }

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-numcv-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string, input?: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const k = kubectlFor('kubeast')

type Pod = { metadata: { name: string; namespace: string; deletionTimestamp?: string }; spec: { nodeName?: string } }
const pods = (scope: string): Pod[] => JSON.parse(k(`get pods ${scope} -o json`)).items
// pods per node ("" = not scheduled), by name for a stable comparison
const perNode = (list: Pod[]) => {
  const out: Record<string, number> = {}
  for (const p of list) out[p.spec.nodeName ?? ''] = (out[p.spec.nodeName ?? ''] ?? 0) + 1
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

test.beforeAll(() => {
  // a run before this one leaves the namespace terminating: new objects, not its last ones
  k(`delete namespace/${NS} --ignore-not-found --timeout=120s`)
  k('apply -f -', FIXTURE)
  // the pods have reached the states their colours are known by
  k(`-n ${NS} wait pod/e2e-cv-run-1 pod/e2e-cv-run-2 --for=condition=Ready --timeout=120s`)
  k(`-n ${NS} wait pod/e2e-cv-done --for=jsonpath={.status.phase}=Succeeded --timeout=120s`)
  k(`-n ${NS} wait pod/e2e-cv-failed --for=jsonpath={.status.phase}=Failed --timeout=120s`)
})

test.afterAll(() => {
  k(`delete namespace/${NS} --wait=false --ignore-not-found`)
  k(`delete clusterrolebinding/${RBAC}-imp clusterrole/${RBAC}-imp --ignore-not-found`)
})

type Cell = [node: string, ok: number, warn: number, error: number]
const mapCells = async (page: Page): Promise<Cell[]> =>
  JSON.parse((await page.getByTestId('cluster-view-map').locator('canvas').getAttribute('data-cells')) ?? '[]')
const cellTotals = (cells: Cell[]) => Object.fromEntries(cells.map(([n, ok, warn, error]) => [n, ok + warn + error]).sort(([a], [b]) => (a < b ? -1 : 1)))
const sumLevels = (cells: Cell[]) => cells.reduce((t, [, ok, warn, error]) => ({ ok: t.ok + ok, warn: t.warn + warn, error: t.error + error }), { ok: 0, warn: 0, error: 0 })
// the legend's three numbers, as written (the legend shows them while no cell is hovered)
async function legend(page: Page) {
  const text = (await page.getByTestId('cluster-view-map-legend').innerText()).replace(/\s+/g, ' ')
  const num = (label: RegExp) => Number(label.exec(text)?.[1] ?? NaN)
  return { error: num(/(?:Error|오류) (\d+)/), warn: num(/(?:Warning|경고|주의) (\d+)/), ok: num(/(?:Healthy|정상) (\d+)/) }
}
const nodeBox = (page: Page, node: string) => page.locator(`[data-testid="cluster-view-node"][data-node="${node}"]`)
const badge = async (page: Page, node: string) => Number(/(\d+)/.exec(await nodeBox(page, node).locator('.badge').first().innerText())?.[1] ?? NaN)
// a box's cards by the icon each draws: green check, yellow alert, red x
async function cardLevels(page: Page, node: string) {
  const cards = nodeBox(page, node).locator('button')
  const n = (sel: string) => cards.locator(sel).count()
  return {
    ok: await n('svg.lucide-circle-check, svg.lucide-check-circle, svg.lucide-circle-check-big, svg.lucide-check-circle-2'),
    warn: await n('svg.lucide-circle-alert, svg.lucide-alert-circle'),
    error: await n('svg.lucide-circle-x, svg.lucide-x-circle'),
  }
}
async function chooseNamespace(page: Page, ns: string) {
  await page.getByRole('button', { name: /All namespaces|전체 네임스페이스/ }).first().click()
  await page.getByRole('button', { name: ns, exact: true }).click()
}

test.describe('Cluster View — number check', () => {
  test('the legend adds up to the cluster\'s pods; a namespace\'s cells, boxes and Unscheduled box are kubectl\'s', async ({ page }) => {
    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    await expect(page.getByTestId('cluster-view-map')).toBeVisible()
    // every namespace: the legend's three add up to the cluster's pods and are the cells' (pods come and go: polled,
    // then the last reading compared, so a failure shows the numbers)
    let last = { legend: { ok: 0, warn: 0, error: 0 }, cells: { ok: 0, warn: 0, error: 0 }, cluster: 0 }
    const same = () => last.legend.ok + last.legend.warn + last.legend.error === last.cluster &&
      (['ok', 'warn', 'error'] as const).every((l) => last.legend[l] === last.cells[l])
    await expect.poll(async () => {
      last = { legend: await legend(page), cells: sumLevels(await mapCells(page)), cluster: pods('-A').length }
      return same()
    }, { timeout: 20_000 }).toBe(true).catch(() => undefined)
    expect(last.legend.ok + last.legend.warn + last.legend.error, `legend ${JSON.stringify(last.legend)} = the cluster's pods`).toBe(last.cluster)
    expect(last.legend, 'legend = the cells').toEqual(last.cells)

    await chooseNamespace(page, NS)
    const want = perNode(pods(`-n ${NS}`))
    expect(Object.values(want).reduce((a, b) => a + b, 0), 'the fixture\'s pods').toBe(6)
    expect(want[''], 'one pod no node fits').toBe(1)
    await expect.poll(async () => cellTotals(await mapCells(page)), { timeout: 15_000 }).toEqual(want)
    expect(sumLevels(await mapCells(page)), 'the colours of the pods made here').toEqual(KNOWN)
    expect(await legend(page)).toEqual(KNOWN)

    // each node's box: the badge is kubectl's count, the cards' icons the cell's colours; the pods no node fits are
    // the box named Unscheduled
    for (const [node, total] of Object.entries(want)) {
      const b = nodeBox(page, node)
      await b.scrollIntoViewIfNeeded()
      await expect(b.locator('button')).toHaveCount(total, { timeout: 15_000 })
      expect.soft(await badge(page, node), `badge of ${node || 'Unscheduled'}`).toBe(total)
      const cell = (await mapCells(page)).find(([n]) => n === node)!
      expect.soft(await cardLevels(page, node), `cards of ${node || 'Unscheduled'}`).toEqual({ ok: cell[1], warn: cell[2], error: cell[3] })
    }
    await expect(nodeBox(page, '').locator('h2')).toHaveText(/Unscheduled|스케줄/)
  })

  test('the search counts the pods whose name or namespace has the text, out of all', async ({ page }) => {
    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    await expect(page.getByTestId('cluster-view-map')).toBeVisible()
    await chooseNamespace(page, NS)
    const search = page.getByPlaceholder(/Search pod name|Pod 이름/i)
    const count = page.getByTestId('cluster-view-search-count')
    const nsPods = pods(`-n ${NS}`)

    // a name part: two of the namespace's six, each node's box badge the pods found on it
    await search.fill('cv-run')
    const runs = nsPods.filter((p) => p.metadata.name.includes('cv-run'))
    await expect(count).toHaveText(new RegExp(`\\b${runs.length}\\b.*\\(\\D*${nsPods.length}\\D*\\)`))
    await expect.poll(async () => cellTotals(await mapCells(page)), { timeout: 10_000 }).toEqual(perNode(runs))
    for (const [node, total] of Object.entries(perNode(runs))) {
      await expect(nodeBox(page, node).locator('button')).toHaveCount(total, { timeout: 15_000 })
      expect.soft(await badge(page, node), `badge of ${node} while searching`).toBe(total)
    }

    // the namespace's name: all six, so no "(out of …)"
    await search.fill(NS)
    await expect(count).toHaveText(new RegExp(`\\b${nsPods.length}\\b`))
    await expect(count).not.toContainText('(')

    // every namespace: the pods whose name or namespace has the text, out of the cluster's
    await page.getByRole('button', { name: NS, exact: true }).first().click()
    await page.getByRole('button', { name: /All namespaces|전체 네임스페이스/ }).last().click()
    await search.fill('e2e-cv-')
    await expect.poll(async () => {
      const all = pods('-A')
      const found = all.filter((p) => p.metadata.name.includes('e2e-cv-') || p.metadata.namespace.includes('e2e-cv-'))
      const text = await count.innerText()
      return new RegExp(`\\b${found.length}\\b.*\\(\\D*${all.length}\\D*\\)`).test(text)
    }, { timeout: 15_000 }).toBe(true)
  })

  test('a grant limited to a namespace maps that namespace\'s pods and no other', async ({ browser, request }) => {
    test.setTimeout(90_000)
    const admin = process.env.E2E_USER_EMAIL || 'admin'
    const login = async (email: string, password: string) => {
      const res = await request.post('/api/v1/auth/login', { data: { email, password } })
      expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
      return (await res.json()).access_token as string
    }
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
    const adminToken = await login(admin, process.env.E2E_USER_PASSWORD || '')
    const id = Date.now().toString(36)
    const email = `e2e-cv-scoped-${id}@kubeast.local`
    const password = `cv-${id}-pw`
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(adminToken), data: { name: `E2E cluster view ${id}`, email, password } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080' })
    try {
      // the scoped group may be impersonated on self and reads (view) in NS only
      k(`delete clusterrolebinding/${RBAC}-imp clusterrole/${RBAC}-imp --ignore-not-found`)
      k(`create clusterrole ${RBAC}-imp --verb=impersonate --resource=groups --resource-name=${READ_GROUP}`)
      k(`create clusterrolebinding ${RBAC}-imp --clusterrole=${RBAC}-imp --serviceaccount=kubeast:k8s-service`)
      k(`-n ${NS} create rolebinding ${RBAC}-view --clusterrole=view --group=${READ_GROUP}`)
      const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(adminToken), data: { role: 'Read', namespaces: [NS] } })
      expect(put.ok(), await put.text()).toBeTruthy()
      const as = `--as=${email} --as-group=kubeast:authenticated --as-group=${READ_GROUP}`
      await expect.poll(() => { try { return pods(`-n ${NS} ${as}`).length } catch { return -1 } }, { timeout: 20_000 }).toBe(6)
      expect(() => k(`get pods -n kube-system ${as}`), 'the cluster refuses it elsewhere').toThrow(/forbidden/)

      const page = await ctx.newPage()
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill(email)
      await page.locator('input[type="password"]').first().fill(password)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
      await page.goto(`/cluster-view?cluster=${CLUSTER}`)
      await expect(page.getByTestId('cluster-view-map')).toBeVisible({ timeout: 20_000 })
      await expect.poll(async () => cellTotals(await mapCells(page)), { timeout: 20_000 }).toEqual(perNode(pods(`-n ${NS} ${as}`)))
      expect(await legend(page)).toEqual(KNOWN)
    } finally {
      await ctx.close()
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(adminToken) })
    }
  })

  test('the floating chat is told the map\'s numbers, a node ready as kubectl prints it', async ({ page }) => {
    // nodes as k8s-service writes kubectl's STATUS: two are ready (the first part is Ready)
    const STATUSES = ['Ready', 'NotReady', 'Unknown', 'Ready,SchedulingDisabled', 'NotReady,SchedulingDisabled']
    await page.route(/\/api\/v1\/cluster\/nodes(\?|$)/, async (route) => {
      const real = await (await route.fetch()).json() as { name: string; status: string }[]
      return route.fulfill({ json: STATUSES.map((status, i) => ({ ...real[0], name: i === 0 ? real[0].name : `e2e-cv-node-${i}`, status })) })
    })
    const sent: { path: string; base?: { data?: { stats?: Record<string, number>; filters?: Record<string, string> } } | null }[] = []
    await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ json: { id: 'e2e-cv-ctx-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
        : route.fallback())
    await page.route(/\/api\/v1\/sessions\/e2e-cv-ctx-\d+(\?|$)/, (route) =>
      route.fulfill({ json: { id: 'e2e-cv-ctx-1', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }))
    await page.route(/\/api\/v1\/ai\/sessions\/e2e-cv-ctx-\d+\/floating-chat/, (route) => {
      sent.push(route.request().postDataJSON().page_context)
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
    })
    const ask = async () => {
      if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
      const input = page.getByTestId('floating-chat-input')
      await expect(input).toBeVisible()
      const before = sent.length
      await input.fill('what is on this screen?')
      await input.press('Enter')
      await expect.poll(() => sent.length).toBe(before + 1)
      await expect(page.getByTestId('floating-chat-panel').getByRole('button', { name: 'Send' })).toBeVisible()
      return sent[sent.length - 1].base?.data
    }

    await page.goto(`/cluster-view?cluster=${CLUSTER}`)
    await expect(page.getByTestId('cluster-view-map')).toBeVisible()
    await chooseNamespace(page, NS)
    await expect.poll(async () => cellTotals(await mapCells(page)), { timeout: 15_000 }).toEqual(perNode(pods(`-n ${NS}`)))
    await expect.configure({ soft: true }).poll(async () => (await ask())?.stats, { timeout: 15_000 }).toMatchObject({
      total_nodes: STATUSES.length, ready_nodes: 2, total_pods: 6, warning_pods: KNOWN.warn, error_pods: KNOWN.error,
    })

    // searched: the counts are of the pods found, named with the search next to the whole
    await page.getByPlaceholder(/Search pod name|Pod 이름/i).fill('cv-run')
    await expect(page.getByTestId('cluster-view-search-count')).toContainText('2')
    await expect.poll(async () => {
      const data = await ask()
      return { filters: data?.filters, matched: data?.stats?.matched_pods, total: data?.stats?.total_pods, error: data?.stats?.error_pods }
    }, { timeout: 15_000 }).toEqual({ filters: { namespace: NS, search: 'cv-run' }, matched: 2, total: 6, error: 0 })
  })
})
