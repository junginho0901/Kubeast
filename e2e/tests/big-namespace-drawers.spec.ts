import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page, type Route } from '@playwright/test'

// The tables of the pods that use a ConfigMap, a Secret, a ServiceAccount, a RoleBinding's accounts and a NetworkPolicy's
// selector, on cluster `self` in a namespace of this run's. The server answers each table's first page from its pod rows;
// a namespace past the line (2 000 pods) is stood in by that answer's count, so the spec needs no large namespace. Below
// it the table reads the namespace whole and follows it live as before; past it no pod is read whole, no watch opens, the
// table says it reads its pages again and does. It does not skip. The namespace is removed after.

const NS = 'e2e-big-ns-drawers'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

const kubeconfig = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-big-ns-drawers-')), 'kubeconfig')
fs.writeFileSync(kcPath, kubeconfig, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

const deployment = (name: string, replicas: number, uses: boolean) => JSON.stringify({
  apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: NS },
  spec: {
    replicas,
    selector: { matchLabels: { app: name } },
    template: {
      metadata: { labels: { app: name } },
      spec: {
        terminationGracePeriodSeconds: 0,
        ...(uses ? { serviceAccountName: 'app' } : {}),
        containers: [{
          name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: ['sleep', '3600'],
          ...(uses ? {
            envFrom: [{ configMapRef: { name: 'shared-conf' } }],
            env: [{ name: 'TOKEN', valueFrom: { secretKeyRef: { name: 'shared-secret', key: 'token' } } }],
          } : {}),
        }],
      },
    },
  },
})

const FIXTURE = [
  `apiVersion: v1\nkind: Namespace\nmetadata: {name: ${NS}}`,
  `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: shared-conf, namespace: ${NS}}\ndata: {mode: e2e}`,
  `apiVersion: v1\nkind: Secret\nmetadata: {name: shared-secret, namespace: ${NS}}\nstringData: {token: not-a-real-token}`,
  `apiVersion: v1\nkind: ServiceAccount\nmetadata: {name: app, namespace: ${NS}}`,
  JSON.stringify({
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'app-view', namespace: NS },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' },
    subjects: [{ kind: 'ServiceAccount', name: 'app', namespace: NS }],
  }),
  JSON.stringify({
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name: 'web-only', namespace: NS },
    spec: { podSelector: { matchLabels: { app: 'web' } }, policyTypes: ['Ingress'] },
  }),
  deployment('web', 2, true),
  deployment('other', 1, false),
].join('\n---\n')

// the pods of the run's Deployment that names all of the objects, as kubectl lists them
const webPods = () => kubectl(`-n ${NS} get pods -l app=web -o jsonpath='{.items[*].metadata.name}'`).split(/\s+/).filter(Boolean).sort()

type Table = { kind: string; name: string; title: string; asks: Record<string, string>; bySelector?: boolean }
const tables: Table[] = [
  { kind: 'ConfigMap', name: 'shared-conf', title: 'Used By Pods', asks: { config_map: 'shared-conf' } },
  { kind: 'Secret', name: 'shared-secret', title: 'Used By Pods', asks: { secret: 'shared-secret' } },
  { kind: 'ServiceAccount', name: 'app', title: 'Pods Using This ServiceAccount', asks: { service_account: `${NS}/app` } },
  { kind: 'RoleBinding', name: 'app-view', title: 'Bound Pods via ServiceAccount Subjects', asks: { service_account: `${NS}/app` } },
  { kind: 'NetworkPolicy', name: 'web-only', title: 'Affected Pods', asks: { label_selector: 'app=web' }, bySelector: true },
]

const isTablePage = (url: URL, t: Table) =>
  url.pathname.endsWith('/cluster/pods/page') && url.searchParams.get('namespace') === NS &&
  Object.entries(t.asks).every(([k, v]) => url.searchParams.get(k) === v)

// What the browser asked: the table's pages, a whole read of the namespace's pods, and the watches it opened on them.
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

// The table's pages answered as for a namespace past the line: its pod count, and for a selector its matches, raised.
async function standInManyPods(page: Page, t: Table, matches: number) {
  await page.route((url) => isTablePage(url, t), async (route: Route) => {
    const response = await route.fetch()
    const body = await response.json()
    if (!body.unchanged) {
      body.stats = { ...body.stats, total: 5000 }
      if (t.bySelector) body.total = matches
    }
    await route.fulfill({ response, json: body })
  })
}

async function openDrawer(page: Page, t: Table) {
  await page.goto(`/configuration/configmaps?cluster=self&namespace=${NS}&detail=${t.kind}/${NS}/${t.name}`)
  return page.locator(DRAWER).last()
}

test.describe('a drawer\'s table of the pods that use its object, in a namespace of few pods and of many', () => {
  test.beforeAll(() => {
    test.setTimeout(240_000)
    kubectl(`delete namespace ${NS} --ignore-not-found --timeout=120s`)
    kubectl('apply -f -', FIXTURE)
    kubectl(`-n ${NS} rollout status deployment/web --timeout=120s`)
    kubectl(`-n ${NS} rollout status deployment/other --timeout=120s`)
  })

  test.afterAll(() => {
    kubectl(`delete namespace ${NS} --ignore-not-found --wait=false`)
  })

  test('below the line the ConfigMap\'s table reads the namespace whole once, follows it by a watch and polls nothing', async ({ page }) => {
    test.setTimeout(150_000)
    const t = tables[0]
    const seen = watchTraffic(page, t)
    const drawer = await openDrawer(page, t)
    const before = webPods()
    await expect(drawer.getByText(new RegExp(`${t.title} \\(\\d+\\)`))).toHaveText(`${t.title} (${before.length})`, { timeout: 30_000 })
    for (const name of before) await expect(drawer.getByRole('cell', { name, exact: true })).toHaveCount(1)
    await expect(drawer.getByTestId('drawer-pods-read-every')).toHaveCount(0)
    await page.waitForTimeout(8_000)
    expect(seen.pages, 'the first page is read once and not polled').toBe(1)
    expect(seen.whole, 'the namespace is read whole').toBeGreaterThanOrEqual(1)
    expect(seen.watches, 'its pods are followed').toBeGreaterThanOrEqual(1)

    kubectl(`-n ${NS} scale deployment/web --replicas=${before.length + 1}`)
    await expect.poll(() => webPods().length, { timeout: 60_000 }).toBe(before.length + 1)
    await expect(drawer.getByText(new RegExp(`${t.title} \\(\\d+\\)`))).toHaveText(`${t.title} (${before.length + 1})`, { timeout: 30_000 })
    expect(seen.pages, 'a new pod comes by the watch, not a read of the page').toBe(1)
  })

  for (const t of tables) {
    test(`past the line the ${t.kind}'s table reads no pod whole, opens no watch, says so and shows the server's rows`, async ({ page }) => {
      test.setTimeout(120_000)
      const seen = watchTraffic(page, t)
      const pods = webPods()
      const matches = 2500
      await standInManyPods(page, t, matches)
      const drawer = await openDrawer(page, t)
      // a selector's count is the server's (stood in); the others count the pods the server kept
      const count = t.bySelector ? matches : pods.length
      await expect(drawer.getByText(new RegExp(`${t.title} \\(\\d+\\)`))).toHaveText(`${t.title} (${count})`, { timeout: 30_000 })
      for (const name of pods) await expect(drawer.getByRole('cell', { name, exact: true })).toHaveCount(1)
      // what passed the line: the selector's matches, else the namespace's pods
      await expect(drawer.getByTestId('drawer-pods-read-every')).toHaveText(t.bySelector
        ? 'Too many pods match this selector to follow live, so this table is read again every 3 seconds.'
        : 'This namespace has too many pods to follow live, so this table is read again every 3 seconds.')
      await page.waitForTimeout(8_000)
      expect(seen.whole, 'no pod of the namespace is read whole').toBe(0)
      expect(seen.watches, 'no watch of the namespace\'s pods opens').toBe(0)
      expect(seen.pages, 'the page is read again').toBeGreaterThanOrEqual(2)
    })
  }

  test('from a server that does not say it applied the condition the ConfigMap\'s table takes none of its rows and reads the namespace whole', async ({ page }) => {
    test.setTimeout(120_000)
    const t = tables[0]
    const seen = watchTraffic(page, t)
    // as a k8s-service from before the condition answers: no filters, and pods that do not use the ConfigMap
    await page.route((url) => isTablePage(url, t), async (route: Route) => {
      const response = await route.fetch()
      const body = await response.json()
      delete body.filters
      body.items = [...(body.items ?? []), { name: 'not-using-it', namespace: NS, status: 'Running', phase: 'Running', ready: '1/1', restart_count: 0, node_name: '', pod_ip: '', created_at: '' }]
      body.total = (body.total ?? 0) + 1
      body.stats = { ...body.stats, total: 5000 }
      await route.fulfill({ response, json: body })
    })
    const drawer = await openDrawer(page, t)
    const pods = webPods()
    await expect(drawer.getByText(new RegExp(`${t.title} \\(\\d+\\)`))).toHaveText(`${t.title} (${pods.length})`, { timeout: 30_000 })
    for (const name of pods) await expect(drawer.getByRole('cell', { name, exact: true })).toHaveCount(1)
    await expect(drawer.getByRole('cell', { name: 'not-using-it', exact: true })).toHaveCount(0)
    await expect(drawer.getByTestId('drawer-pods-read-every')).toHaveCount(0)
    expect(seen.whole, 'the namespace is read whole').toBeGreaterThanOrEqual(1)
    expect(seen.watches, 'its pods are followed').toBeGreaterThanOrEqual(1)
  })

  test('past the line the ConfigMap\'s table shows a new pod on its next read', async ({ page }) => {
    test.setTimeout(150_000)
    const t = tables[0]
    const seen = watchTraffic(page, t)
    await standInManyPods(page, t, 0)
    const drawer = await openDrawer(page, t)
    const before = webPods()
    await expect(drawer.getByText(new RegExp(`${t.title} \\(\\d+\\)`))).toHaveText(`${t.title} (${before.length})`, { timeout: 30_000 })

    kubectl(`-n ${NS} scale deployment/web --replicas=${before.length + 1}`)
    await expect.poll(() => webPods().length, { timeout: 60_000 }).toBe(before.length + 1)
    await expect(drawer.getByText(new RegExp(`${t.title} \\(\\d+\\)`))).toHaveText(`${t.title} (${before.length + 1})`, { timeout: 20_000 })
    for (const name of webPods()) await expect(drawer.getByRole('cell', { name, exact: true })).toHaveCount(1)
    expect(seen.whole).toBe(0)
    expect(seen.watches).toBe(0)
  })
})
