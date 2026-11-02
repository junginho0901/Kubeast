import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Dashboard lists: right after a sign-in (which clears the stored cluster) the Nodes card shows the nodes of the
// cluster the picker selects, not of the server's default cluster asked while the selection was empty; the card
// shows at most 8 nodes, those not Ready first, and links to the Nodes page; the node bars put every node under its
// readiness as kubectl prints it (a cordoned node under Ready, its card and window rows with both parts); the window
// behind a stat card pages its list 50 at a time. The stand-in tests give the page lists dev does not have, through
// page.route; the cordon test cordons test2's node for its run.

const nodesCard = (page: Page) => page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Nodes', exact: true }) })
const nodeNames = (page: Page) => nodesCard(page).locator('button p[title]').evaluateAll((els) => els.map((e) => e.getAttribute('title')))
const pagerText = (page: Page) => page.getByTestId('resource-modal-pager').locator('div').first().innerText()
const nodeBars = (page: Page) => page.locator('.card').filter({ has: page.getByRole('heading', { name: /^Node (status|상태)$/ }) }).locator('svg title').allTextContents()
const readiness = (status: string) => { const first = status.split(',')[0]; return first === 'Ready' || first === 'NotReady' ? first : 'Unknown' }

function kubectlFor(kindName: string) {
  const kubeconfig = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-dashlists-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
  return (args: string) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

test.describe('Dashboard lists', () => {
  test('after a fresh sign-in the Nodes card shows the selected cluster’s nodes and opens them', async ({ browser }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto('/login')
    await page.locator('input[autocomplete="email"]').first().fill(process.env.E2E_USER_EMAIL ?? '')
    await page.locator('input[type="password"]').first().fill(process.env.E2E_USER_PASSWORD ?? '')
    await page.locator('button[type="submit"]').first().click()
    await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'))
    // no reload: the sign-in lands on the dashboard while the selection is still empty, and the picker then
    // selects `default` — the card must list that cluster's nodes, not those of the server's default cluster
    await page.waitForURL((u) => u.pathname === '/')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('kubeast:current-cluster'))).toBe('default')
    const res = await page.request.get('/api/v1/cluster/nodes?cluster=default')
    expect(res.ok()).toBe(true)
    const expected = ((await res.json()) as { name: string }[]).map((n) => n.name).sort()
    await expect.poll(async () => (await nodeNames(page)).sort(), { timeout: 15_000 }).toEqual(expected)

    const describe = page.waitForResponse((r) => r.url().includes(`/cluster/nodes/${expected[0]}/describe`))
    await nodesCard(page).locator('button').filter({ hasText: expected[0] }).first().click()
    expect((await describe).status()).toBe(200)
    await expect(page.getByText('Failed to load node details')).toHaveCount(0)
    await ctx.close()
  })

  test('the Nodes card shows at most 8 nodes, those not Ready first, and links to the Nodes page', async ({ page }) => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({
      name: `e2e-node-${String(i + 1).padStart(2, '0')}`,
      status: i === 5 || i === 9 ? 'NotReady' : 'Ready',
      version: 'v1.37.0',
      roles: ['worker'],
      internal_ip: `10.0.0.${i + 1}`,
    }))
    await page.route(/\/api\/v1\/cluster\/nodes(\?|$)/, (route) => route.fulfill({ json: nodes }))
    await page.goto('/')
    await expect.poll(() => nodeNames(page)).toHaveLength(8)
    const names = await nodeNames(page)
    expect(names.slice(0, 2)).toEqual(['e2e-node-06', 'e2e-node-10'])
    expect(names.slice(2)).toEqual(['e2e-node-01', 'e2e-node-02', 'e2e-node-03', 'e2e-node-04', 'e2e-node-05', 'e2e-node-07'])
    const all = page.getByTestId('dashboard-nodes-all')
    await expect(all).toHaveAttribute('href', '/cluster/nodes')
    await expect(all).toContainText('12')
  })

  test('the node bars put every node under its readiness as kubectl prints it, cordoned ones under Ready with their own badge', async ({ page }) => {
    // every STATUS kubectl's printNode writes; soft, so a run on old code records each difference
    const statuses = ['Ready', 'NotReady', 'Unknown', 'Ready,SchedulingDisabled', 'NotReady,SchedulingDisabled', 'Ready']
    const nodes = statuses.map((status, i) => ({ name: `e2e-node-${i + 1}`, status, version: 'v1.37.0', roles: ['worker'], internal_ip: `10.0.0.${i + 1}` }))
    await page.route(/\/api\/v1\/cluster\/nodes(\?|$)/, (route) => route.fulfill({ json: nodes }))
    await page.goto('/')
    await expect.poll(() => nodeNames(page)).toHaveLength(nodes.length)
    expect.soft(await nodeBars(page), 'one bar per readiness, adding up to the nodes').toEqual(['Ready: 3', 'NotReady: 2', 'Unknown: 1'])
    // not Ready first, then the cordoned Ready one, then the rest
    expect.soft(await nodeNames(page)).toEqual(['e2e-node-2', 'e2e-node-3', 'e2e-node-5', 'e2e-node-4', 'e2e-node-1', 'e2e-node-6'])
    const badges = await nodesCard(page).getByTestId('dashboard-node-status').evaluateAll((els) => els.map((e) => [...e.querySelectorAll('.badge')].map((b) => `${b.textContent}:${b.className.match(/badge-\w+/)?.[0]}`).join(' ')))
    expect.soft(badges).toEqual([
      'NotReady:badge-error', 'Unknown:badge-error', 'NotReady:badge-error SchedulingDisabled:badge-warning',
      'Ready:badge-success SchedulingDisabled:badge-warning', 'Ready:badge-success', 'Ready:badge-success',
    ])
    // the Ready bar opens the window with the three Ready nodes, the cordoned one among them
    await page.locator('.card').filter({ has: page.getByRole('heading', { name: /^Node (status|상태)$/ }) }).locator('svg g').filter({ has: page.locator('title', { hasText: /^Ready:/ }) }).first().click()
    const rows = page.getByTestId('resource-modal-node-status')
    await expect.soft(rows).toHaveCount(3)
    expect.soft((await rows.evaluateAll((els) => els.map((e) => [...e.querySelectorAll('.badge')].map((b) => b.textContent).join(' ')))).sort())
      .toEqual(['Ready', 'Ready', 'Ready SchedulingDisabled'])
  })

  test('a cordoned node of a real cluster is counted under Ready, as kubectl get nodes prints it', async ({ page }) => {
    let kubectl: ((args: string) => string) | null = null
    try { kubectl = kubectlFor('test2') } catch { test.skip(true, 'kind cluster test2 not found') }
    const k = kubectl!
    const kubectlNodes = () => k('get nodes --no-headers').split('\n').filter(Boolean).map((l) => { const [name, status] = l.split(/\s+/); return { name, status } })
    const node = kubectlNodes()[0].name
    try {
      k(`cordon ${node}`)
      const want = kubectlNodes()
      expect(want.find((n) => n.name === node)?.status).toBe('Ready,SchedulingDisabled')
      const bars = ['Ready', 'NotReady', 'Unknown'].map((r) => `${r}: ${want.filter((n) => readiness(n.status) === r).length}`)
      await expect(async () => {
        await page.goto('/?cluster=test2')
        await expect.poll(() => nodeNames(page), { timeout: 10_000 }).toHaveLength(want.length)
        expect(await nodeBars(page), 'the bars as kubectl counts the nodes').toEqual(bars)
      }).toPass({ timeout: 60_000 })
      const card = nodesCard(page).locator('button').filter({ hasText: node }).getByTestId('dashboard-node-status')
      expect.soft(await card.locator('.badge').allInnerTexts()).toEqual(want.find((n) => n.name === node)!.status.split(','))
    } finally {
      k(`uncordon ${node}`)
    }
  })

  test('the window behind a stat card pages its list 50 at a time', async ({ page }) => {
    const pods = Array.from({ length: 120 }, (_, i) => ({
      name: `e2e-pod-${String(i + 1).padStart(3, '0')}`,
      namespace: 'e2e-lists',
      phase: 'Running',
      status: 'Running',
      node_name: 'e2e-node',
      containers: [],
    }))
    // the window asks the Pods list's server page: the stand-in cuts the 120 pods as the server would
    await page.route(/\/api\/v1\/cluster\/pods\/page(\?|$)/, (route) => {
      const u = new URL(route.request().url())
      const q = (u.searchParams.get('q') ?? '').toLowerCase()
      const offset = Number(u.searchParams.get('offset') ?? 0)
      const limit = Number(u.searchParams.get('limit') ?? 50)
      const matched = pods.filter((p) => p.name.includes(q))
      return route.fulfill({ json: {
        items: matched.slice(offset, offset + limit).map((p) => ({ ...p, ready: '1/1', restart_count: 0, pod_ip: '', created_at: '' })),
        total: matched.length,
        stats: { total: pods.length, ready: pods.length, not_ready: 0, pending: 0, error: 0, restarted: 0, completed: 0, top_reasons: [] },
        revision: '', source: 'index',
      } })
    })
    await page.goto('/')
    await page.getByTestId('stat-pods').click()
    const pager = page.getByTestId('resource-modal-pager')
    await expect.poll(() => pagerText(page)).toMatch(/1-50 of 120|120개 중 1-50/)
    await expect(page.getByText('e2e-pod-050', { exact: true })).toBeVisible()
    await expect(page.getByText('e2e-pod-051', { exact: true })).toHaveCount(0)
    await pager.getByRole('button').last().click()
    await expect.poll(() => pagerText(page)).toMatch(/51-100 of 120|120개 중 51-100/)
    await expect(page.getByText('e2e-pod-051', { exact: true })).toBeVisible()
    await pager.getByRole('button').last().click()
    await expect.poll(() => pagerText(page)).toMatch(/101-120 of 120|120개 중 101-120/)
    await expect(page.getByText('e2e-pod-120', { exact: true })).toBeVisible()
    // a search starts again from the first page
    await page.getByPlaceholder(/Search|검색/).last().fill('e2e-pod-1')
    await expect.poll(() => pagerText(page)).toMatch(/1-21 of 21|21개 중 1-21/)
  })

  test('the Namespaces window counts each namespace’s pods, Services and Deployments as kubectl lists them, and a search says how many of how many', async ({ page }) => {
    const k = kubectlFor('kubeast')
    const perNs = (kind: string) => {
      const m = new Map<string, number>()
      for (const ns of k(`get ${kind} -A --no-headers -o custom-columns=NS:.metadata.namespace`).split('\n').filter(Boolean)) m.set(ns, (m.get(ns) ?? 0) + 1)
      return m
    }
    const names = k('get namespaces --no-headers -o custom-columns=N:.metadata.name').split('\n').filter(Boolean).sort()
    await page.goto('/?cluster=self')
    await page.getByTestId('stat-namespaces').click()
    const rows = page.getByTestId('resource-modal-namespace-counts')
    // pods come and go while the suite runs: read kubectl and the window again until they agree
    await expect(async () => {
      const [pods, svc, dep] = [perNs('pods'), perNs('services'), perNs('deployments')]
      const want = Object.fromEntries(names.map((n) => [n, [pods.get(n) ?? 0, svc.get(n) ?? 0, dep.get(n) ?? 0].join(' ')]))
      // each row: the namespace (its h3) and the three numbers of its summary line
      const seen = await rows.evaluateAll((els) => els.map((e) => [
        e.parentElement?.querySelector('h3')?.textContent ?? '',
        (e.textContent ?? '').match(/\d+|-/g)?.join(' ') ?? '',
      ]))
      expect(seen.length, 'a row per namespace').toBe(names.length)
      expect(Object.fromEntries(seen), 'pods, Services and Deployments per namespace').toEqual(want)
    }).toPass({ timeout: 60_000 })

    // a search keeps some of them: the header says how many of how many, as the pager does
    await page.getByPlaceholder(/Search|검색/).last().fill('kube')
    const kept = names.filter((n) => n.includes('kube')).length
    expect(kept).toBeGreaterThan(0)
    await expect(page.getByTestId('resource-modal-total')).toHaveText(new RegExp(`^(${kept} of ${names.length}|${names.length}개 중 ${kept}개)$`))
    await page.getByPlaceholder(/Search|검색/).last().fill('')
    await expect(page.getByTestId('resource-modal-total')).toHaveText(new RegExp(`^(Total ${names.length}|총 ${names.length})$`))
  })

  test('the Issues total says how many of how many while a search narrows the list', async ({ page }) => {
    await page.goto('/?cluster=self')
    // the answer the modal draws from
    const answer = page.waitForResponse((r) => r.url().includes('/api/v1/cluster/issues'))
    await page.locator('button').filter({ hasText: /Check issues|이슈 확인/ }).first().click()
    const res = await answer
    expect(res.ok(), `issues ${res.status()}`).toBe(true)
    type Row = { kind: string; severity: string; namespace?: string; name: string; reason?: string; message?: string }
    const all = (await res.json()).issues as Row[]
    // the modal's search: kind, severity, namespace, name, reason and message
    const failing = all.filter((i) => [i.kind, i.severity, i.namespace, i.name, i.reason, i.message].filter(Boolean).join(' ').toLowerCase().includes('e2e-failing-job')).length
    expect(failing, 'the fixture\'s failed Job is an issue').toBeGreaterThan(0)
    const total = page.getByTestId('issues-total')
    await expect(total).toHaveText(String(all.length), { timeout: 20_000 })
    await page.getByPlaceholder(/Search issues|이슈 검색/).fill('e2e-failing-job')
    await expect(total).toHaveText(new RegExp(`^(${failing} of ${all.length}|${all.length}개 중 ${failing}개)$`))
  })
})
