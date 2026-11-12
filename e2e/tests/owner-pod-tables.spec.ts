import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Locator, type Page, type Route } from '@playwright/test'

// The pod tables of a Service, a PodDisruptionBudget, a ReplicaSet, a DaemonSet and a Job on cluster `self`, in a namespace
// of this run's. Each table's first page comes from the server's pod rows; a set past the line (300 pods) is stood in by
// that answer's count, so the spec needs no large workload. Below it the table reads its pods whole and follows them live
// as before; past it no pod is read whole, no watch opens and the table reads its pages again. A server that did not keep
// the owner is answered the old way. Two budgets whose selectors hold matchExpressions list what kubectl selects by them.
// It does not skip. The namespace is removed after.

const NS = 'e2e-owner-pod-tables'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

const kubeconfig = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-owner-pod-tables-')), 'kubeconfig')
fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const podSpec = {
  terminationGracePeriodSeconds: 0,
  tolerations: [{ operator: 'Exists' }],
  containers: [{ name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: ['sleep', '3600'] }],
}
const template = (app: string) => ({ metadata: { labels: { app } }, spec: podSpec })

const FIXTURE = [
  `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${NS}}`,
  JSON.stringify({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web', namespace: NS }, spec: { replicas: 2, selector: { matchLabels: { app: 'web' } }, template: template('web') } }),
  JSON.stringify({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'web', namespace: NS }, spec: { selector: { app: 'web' }, ports: [{ port: 80 }] } }),
  JSON.stringify({ apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: 'web', namespace: NS }, spec: { minAvailable: 1, selector: { matchLabels: { app: 'web' } } } }),
  JSON.stringify({ apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'agent', namespace: NS }, spec: { selector: { matchLabels: { app: 'agent' } }, template: template('agent') } }),
  JSON.stringify({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name: 'batch', namespace: NS }, spec: { parallelism: 1, completions: 1, template: { metadata: { labels: { app: 'batch' } }, spec: { ...podSpec, restartPolicy: 'Never' } } } }),
  // pods of one app that differ by tier, and budgets that pick among them with matchExpressions
  ...['front', 'back'].map((tier) => JSON.stringify({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: `tier-${tier}`, namespace: NS }, spec: { replicas: 1, selector: { matchLabels: { app: 'tiers', tier } }, template: { metadata: { labels: { app: 'tiers', tier } }, spec: podSpec } } })),
  JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'untiered', namespace: NS, labels: { app: 'tiers' } }, spec: podSpec }),
  JSON.stringify({ apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: 'tiers-front', namespace: NS }, spec: { minAvailable: 1, selector: { matchLabels: { app: 'tiers' }, matchExpressions: [{ key: 'tier', operator: 'In', values: ['front'] }] } } }),
  JSON.stringify({ apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: 'tiers-not-back', namespace: NS }, spec: { minAvailable: 1, selector: { matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['back'] }] } } }),
  // policy/v1: an empty selector protects every pod of the namespace, none protects no pod
  JSON.stringify({ apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: 'every-pod', namespace: NS }, spec: { minAvailable: 1, selector: {} } }),
  JSON.stringify({ apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { name: 'no-selector', namespace: NS }, spec: { minAvailable: 1 } }),
  // a Deployment that picks by a label and an expression, beside a pod its label alone would take; one with an expression only
  JSON.stringify({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'picky', namespace: NS }, spec: { replicas: 1, selector: { matchLabels: { app: 'picky' }, matchExpressions: [{ key: 'track', operator: 'In', values: ['stable'] }] }, template: { metadata: { labels: { app: 'picky', track: 'stable' } }, spec: podSpec } } }),
  JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'picky-stray', namespace: NS, labels: { app: 'picky', track: 'canary' } }, spec: podSpec }),
  JSON.stringify({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'picky-only', namespace: NS }, spec: { replicas: 1, selector: { matchExpressions: [{ key: 'picky-only', operator: 'Exists' }] }, template: { metadata: { labels: { 'picky-only': 'yes' } }, spec: podSpec } } }),
].join('\n---\n')

// each budget with matchExpressions and its selector as the API server writes it, which the drawer sends
const EXPRESSION_BUDGETS: [string, string][] = [['tiers-front', 'app=tiers,tier in (front)'], ['tiers-not-back', 'tier notin (back)']]

const podsOf = (selector: string) => kubectl(`-n ${NS} get pods -l ${selector} -o jsonpath='{.items[*].metadata.name}'`).split(/\s+/).filter(Boolean).sort()
const everyPod = () => kubectl(`-n ${NS} get pods -o jsonpath='{.items[*].metadata.name}'`).split(/\s+/).filter(Boolean).sort()

// The selectors the browser asked the namespace's pods by: reads of the server's page or of them whole, and watches. A read
// or watch with no selector, every pod of the namespace, is "(all)".
function askedSelectors(page: Page) {
  let asked = new Set<string>()
  page.on('request', (r) => {
    const url = new URL(r.url())
    if ((url.pathname.endsWith('/cluster/pods/page') && url.searchParams.get('namespace') === NS) || url.pathname.endsWith(`/cluster/namespaces/${NS}/pods`)) {
      asked.add(`read ${url.searchParams.get('label_selector') || '(all)'}`)
    }
  })
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const msg = JSON.parse(String(f.payload)) as { type?: string; path?: string; query?: string }
    if (msg.type === 'REQUEST' && msg.path === `/api/v1/namespaces/${NS}/pods`) asked.add(`watch ${new URLSearchParams(msg.query ?? '').get('labelSelector') || '(all)'}`)
  }))
  return { reset: () => { asked = new Set<string>() }, list: () => [...asked].sort() }
}

// The pods on the Protected Pods table's page (ten a page): each must be one the budget protects.
// The section's own box: `has` is queried inside each box, so its locator starts from the page, not the drawer.
const protectedShown = (drawer: Locator) =>
  drawer.locator('div.rounded-lg').filter({ has: drawer.page().getByText(/^Protected Pods \(\d+\)$/) }).last().locator('tbody tr td:first-child').allTextContents()

type Layer = { source: string; data?: { pods?: { name: string }[] } & Record<string, unknown> }

// What the window tells the floating chat, read by asking it once (the chat's answer is stood in).
async function captureFloating(page: Page) {
  const sent: { overlays: Layer[] }[] = []
  await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ json: { id: 'e2e-owner-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
      : route.fallback())
  await page.route(/\/api\/v1\/sessions\/e2e-owner-\d+(\?|$)/, (route) =>
    route.fulfill({ json: { id: 'e2e-owner-1', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }))
  await page.route(/\/api\/v1\/ai\/sessions\/e2e-owner-\d+\/floating-chat/, (route) => {
    sent.push(route.request().postDataJSON().page_context)
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
  })
  return async () => {
    if ((await page.getByTestId('floating-chat-panel').count()) === 0) await page.getByTestId('floating-chat-toggle').click()
    const input = page.getByTestId('floating-chat-input')
    await expect(input).toBeVisible()
    const before = sent.length
    await input.fill('what is on this screen?')
    await input.press('Enter')
    await expect.poll(() => sent.length).toBe(before + 1)
    await expect(page.getByTestId('floating-chat-panel').getByRole('button', { name: 'Send' })).toBeVisible()
    return sent[sent.length - 1]
  }
}
const webReplicaSet = () => kubectl(`-n ${NS} get rs -l app=web -o jsonpath='{.items[0].metadata.name}'`)

// `pods`: the label that lists the table's pods with kubectl (a workload's own selector holds labels the controller adds)
type Table = { kind: string; name: () => string; title: string; pods: string; owner?: () => string }
const tables: Table[] = [
  { kind: 'Service', name: () => 'web', title: 'Matching Pods', pods: 'app=web' },
  { kind: 'PodDisruptionBudget', name: () => 'web', title: 'Protected Pods', pods: 'app=web' },
  { kind: 'ReplicaSet', name: webReplicaSet, title: 'Pods', pods: 'app=web', owner: () => `ReplicaSet/${webReplicaSet()}` },
  { kind: 'DaemonSet', name: () => 'agent', title: 'Pods', pods: 'app=agent', owner: () => 'DaemonSet/agent' },
  { kind: 'Job', name: () => 'batch', title: 'Pods', pods: 'job-name=batch', owner: () => 'Job/batch' },
]

// a workload's table asks by its owner; a Service's and a PDB's by their selector, app=web
const isTablePage = (url: URL, t: Table) =>
  url.pathname.endsWith('/cluster/pods/page') && url.searchParams.get('namespace') === NS &&
  (t.owner ? url.searchParams.get('owner') === t.owner() : url.searchParams.get('label_selector') === 'app=web' && !url.searchParams.has('owner'))

// What the browser asked: the table's pages, a whole read of the set's pods, and the watches it opened on them.
function watchTraffic(page: Page, t: Table) {
  const seen = { pages: 0, whole: 0, watches: 0 }
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (isTablePage(url, t)) seen.pages += 1
    if (url.pathname.endsWith(`/cluster/namespaces/${NS}/pods`)) seen.whole += 1
  })
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const msg = JSON.parse(String(f.payload)) as { type?: string; path?: string }
    if (msg.type === 'REQUEST' && msg.path === `/api/v1/namespaces/${NS}/pods`) seen.watches += 1
  }))
  return seen
}

async function openDrawer(page: Page, t: Table) {
  await page.goto(`/configuration/configmaps?cluster=self&namespace=${NS}&detail=${t.kind}/${NS}/${t.name()}`)
  return page.locator(DRAWER).last()
}

const titleOf = (t: Table) => new RegExp(`^${t.title} \\(\\d+\\)$`)

test.describe('the pod tables of a Service, a PodDisruptionBudget and the workloads, few pods and many', () => {
  test.beforeAll(() => {
    test.setTimeout(240_000)
    kubectl(`delete namespace ${NS} --ignore-not-found --timeout=120s`)
    kubectl('apply -f -', FIXTURE)
    kubectl(`-n ${NS} rollout status deployment/web --timeout=120s`)
    kubectl(`-n ${NS} rollout status daemonset/agent --timeout=120s`)
    kubectl(`-n ${NS} rollout status deployment/tier-front --timeout=120s`)
    kubectl(`-n ${NS} rollout status deployment/tier-back --timeout=120s`)
    kubectl(`-n ${NS} rollout status deployment/picky --timeout=120s`)
    kubectl(`-n ${NS} rollout status deployment/picky-only --timeout=120s`)
    kubectl(`-n ${NS} wait pod/picky-stray pod/untiered --for=condition=Ready --timeout=120s`)
    // the Job's pod is made after the apply returns
    for (let i = 0; i < 60 && podsOf('job-name=batch').length === 0; i++) execSync('sleep 1')
    kubectl(`-n ${NS} wait pod -l job-name=batch --for=condition=Ready --timeout=120s`)
  })

  test.afterAll(() => {
    kubectl(`delete namespace ${NS} --ignore-not-found --wait=false`)
  })

  test('below the line the ReplicaSet\'s table reads its pods whole once, follows them by a watch and polls nothing', async ({ page }) => {
    test.setTimeout(150_000)
    const t = tables[2]
    const seen = watchTraffic(page, t)
    const drawer = await openDrawer(page, t)
    const before = podsOf('app=web')
    await expect(drawer.getByText(titleOf(t))).toHaveText(`${t.title} (${before.length})`, { timeout: 30_000 })
    for (const name of before) await expect(drawer.getByRole('cell', { name, exact: true })).toHaveCount(1)
    await expect(drawer.getByTestId('drawer-pods-read-every')).toHaveCount(0)
    await page.waitForTimeout(8_000)
    expect(seen.pages, 'the first page is read once and not polled').toBe(1)
    expect(seen.whole, 'its pods are read whole').toBeGreaterThanOrEqual(1)
    expect(seen.watches, 'its pods are followed').toBeGreaterThanOrEqual(1)

    kubectl(`-n ${NS} scale deployment/web --replicas=${before.length + 1}`)
    await expect.poll(() => podsOf('app=web').length, { timeout: 60_000 }).toBe(before.length + 1)
    await expect(drawer.getByText(titleOf(t))).toHaveText(`${t.title} (${before.length + 1})`, { timeout: 30_000 })
    expect(seen.pages, 'a new pod comes by the watch, not a read of the page').toBe(1)
    kubectl(`-n ${NS} scale deployment/web --replicas=${before.length}`)
    await expect.poll(() => podsOf('app=web').length, { timeout: 60_000 }).toBe(before.length)
  })

  test('a PodDisruptionBudget whose selector has matchExpressions lists the pods kubectl selects by it, and reads and follows them by that selector', async ({ page }) => {
    test.setTimeout(150_000)
    const asked = askedSelectors(page)
    for (const [name, selector] of EXPRESSION_BUDGETS) {
      asked.reset()
      const drawer = await openDrawer(page, { kind: 'PodDisruptionBudget', name: () => name, title: 'Protected Pods', pods: selector })
      const pods = podsOf(`'${selector}'`)
      expect(pods.length, `kubectl selects pods by ${selector}`).toBeGreaterThan(0)
      await expect(drawer.getByText(/^Protected Pods \(\d+\)$/)).toHaveText(`Protected Pods (${pods.length})`, { timeout: 30_000 })
      const shown = await protectedShown(drawer)
      expect(shown.length, 'the first page of the table').toBe(Math.min(10, pods.length))
      expect(shown.filter((p) => !pods.includes(p)), 'every pod on the page is one kubectl selects').toEqual([])
      // a pod of the same app that the budget does not pick is not in its table
      for (const other of podsOf('app=tiers').filter((p) => !pods.includes(p))) await expect(drawer.getByRole('cell', { name: other, exact: true })).toHaveCount(0)
      await expect.poll(() => asked.list(), { timeout: 10_000 }).toEqual([`read ${selector}`, `watch ${selector}`])
    }
  })

  test('a PodDisruptionBudget with an empty selector lists every pod of its namespace, and one with no selector lists none and says why', async ({ page }) => {
    test.setTimeout(150_000)
    const asked = askedSelectors(page)
    const every = await openDrawer(page, { kind: 'PodDisruptionBudget', name: () => 'every-pod', title: 'Protected Pods', pods: '' })
    const pods = everyPod()
    await expect(every.getByText(/^Protected Pods \(\d+\)$/)).toHaveText(`Protected Pods (${pods.length})`, { timeout: 30_000 })
    await expect(every.getByText('The selector is empty, so this PodDisruptionBudget protects every pod of its namespace.')).toHaveCount(1)
    const shown = await protectedShown(every)
    expect(shown.length, 'the first page of the table').toBe(Math.min(10, pods.length))
    expect(shown.filter((p) => !pods.includes(p)), 'every pod on the page is one of the namespace').toEqual([])
    // a pod here matches several budgets and the controller recounts one of them, picked arbitrarily, per pod change: touch this one so it recounts
    const recounted = () => {
      kubectl(`-n ${NS} annotate pdb every-pod e2e-recount=${Date.now()} --overwrite`)
      return kubectl(`-n ${NS} get pdb every-pod -o jsonpath='{.status.expectedPods}'`)
    }
    await expect.poll(recounted, { message: 'the disruption controller expects every pod', timeout: 30_000 }).toBe(String(pods.length))
    await expect.poll(() => asked.list(), { timeout: 10_000 }).toEqual(['read (all)', 'watch (all)'])

    asked.reset()
    const none = await openDrawer(page, { kind: 'PodDisruptionBudget', name: () => 'no-selector', title: 'Protected Pods', pods: '' })
    await expect(none.getByText(/^Protected Pods \(\d+\)$/)).toHaveText('Protected Pods (0)', { timeout: 30_000 })
    await expect(none.getByText('This PodDisruptionBudget has no selector, so it protects no pod.')).toHaveCount(1)
    for (const pod of pods) await expect(none.getByRole('cell', { name: pod, exact: true })).toHaveCount(0)
    await expect.poll(() => kubectl(`-n ${NS} get pdb no-selector -o jsonpath='{.status.expectedPods}'`) || '0', { message: 'the disruption controller expects no pod', timeout: 30_000 }).toBe('0')
    await page.waitForTimeout(3_000)
    expect(asked.list().filter((a) => a.startsWith('watch')), 'no pod of the namespace is watched for it').toEqual([])
  })

  test('a Deployment whose selector has a matchExpressions term holds the pods it selects, not a pod its label alone would take', async ({ page }) => {
    test.setTimeout(150_000)
    const asked = askedSelectors(page)
    const ask = await captureFloating(page)
    const selector = 'app=picky,track in (stable)'
    const pods = podsOf(`'${selector}'`)
    expect(podsOf('app=picky'), 'its label alone takes the stray pod too').toEqual([...pods, 'picky-stray'].sort())
    const drawer = await openDrawer(page, { kind: 'Deployment', name: () => 'picky', title: 'Owned ReplicaSets', pods: selector })
    await expect(drawer.getByText(/^Owned ReplicaSets \(\d+\)$/)).toHaveText('Owned ReplicaSets (1)', { timeout: 30_000 })
    await expect.poll(async () => {
      const layer = (await ask()).overlays.find((o) => o.source === 'WorkloadInfo')
      return (layer?.data?.pods ?? []).map((p) => p.name).sort()
    }, { timeout: 20_000 }).toEqual(pods)
    expect(asked.list()).toEqual([`read ${selector}`, `watch ${selector}`])

    // a selector of an expression only: the window still lists the Deployment's ReplicaSets
    const owned = kubectl(`-n ${NS} get rs -l picky-only -o jsonpath='{.items[*].metadata.name}'`).split(/\s+/).filter(Boolean)
    expect(owned.length, 'kubectl lists its ReplicaSet').toBe(1)
    const only = await openDrawer(page, { kind: 'Deployment', name: () => 'picky-only', title: 'Owned ReplicaSets', pods: 'picky-only' })
    await expect(only.getByText(/^Owned ReplicaSets \(\d+\)$/)).toHaveText(`Owned ReplicaSets (${owned.length})`, { timeout: 30_000 })
    await expect(only.getByRole('cell', { name: owned[0], exact: true })).toHaveCount(1)
  })

  for (const t of tables) {
    test(`past the line the ${t.kind}'s table reads no pod whole, opens no watch, says so and shows the server's rows`, async ({ page }) => {
      test.setTimeout(120_000)
      const seen = watchTraffic(page, t)
      const pods = podsOf(t.pods)
      await page.route((url) => isTablePage(url, t), async (route: Route) => {
        const response = await route.fetch()
        const body = await response.json()
        if (!body.unchanged) {
          body.stats = { ...body.stats, total: 5000 }
          body.total = 2500
        }
        await route.fulfill({ response, json: body })
      })
      const drawer = await openDrawer(page, t)
      await expect(drawer.getByText(titleOf(t))).toHaveText(`${t.title} (2500)`, { timeout: 30_000 })
      for (const name of pods) await expect(drawer.getByRole('cell', { name, exact: true })).toHaveCount(1)
      // what passed the line: the workload's own pods, else the selector's matches
      await expect(drawer.getByTestId('drawer-pods-read-every')).toHaveText(t.owner
        ? `This ${t.kind} has too many pods to follow live, so this table is read again every 3 seconds.`
        : 'Too many pods match this selector to follow live, so this table is read again every 3 seconds.')
      await page.waitForTimeout(8_000)
      expect(seen.whole, 'no pod is read whole').toBe(0)
      expect(seen.watches, 'no watch of the pods opens').toBe(0)
      expect(seen.pages, 'the page is read again').toBeGreaterThanOrEqual(2)
    })
  }

  test('from a server that does not say it kept the owner the DaemonSet\'s table takes none of its rows and reads its pods whole', async ({ page }) => {
    test.setTimeout(120_000)
    const t = tables[3]
    const seen = watchTraffic(page, t)
    // as a k8s-service from before the owner was named answers: the selector's filters only, and a pod not the DaemonSet's
    await page.route((url) => isTablePage(url, t), async (route: Route) => {
      const response = await route.fetch()
      const body = await response.json()
      if (body.filters) delete body.filters.owner
      body.items = [...(body.items ?? []), { name: 'not-its-pod', namespace: NS, status: 'Running', phase: 'Running', ready: '1/1', restart_count: 0, node_name: '', pod_ip: '', created_at: '' }]
      body.total = 5000
      await route.fulfill({ response, json: body })
    })
    const drawer = await openDrawer(page, t)
    const pods = podsOf(t.pods)
    await expect(drawer.getByText(titleOf(t))).toHaveText(`${t.title} (${pods.length})`, { timeout: 30_000 })
    for (const name of pods) await expect(drawer.getByRole('cell', { name, exact: true })).toHaveCount(1)
    await expect(drawer.getByRole('cell', { name: 'not-its-pod', exact: true })).toHaveCount(0)
    await expect(drawer.getByTestId('drawer-pods-read-every')).toHaveCount(0)
    expect(seen.whole, 'its pods are read whole').toBeGreaterThanOrEqual(1)
    expect(seen.watches, 'its pods are followed').toBeGreaterThanOrEqual(1)
  })
})
