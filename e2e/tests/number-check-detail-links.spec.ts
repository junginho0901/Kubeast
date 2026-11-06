import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Locator, type Page } from '@playwright/test'

// Every screen that opens a drawer for an object it names passes the object's apiVersion, so one Kind of two groups
// opens the right group's object with its own CRD: on default, in a namespace of this run's own, a Widget of
// links-a.kubeast.io and one of links-b.kubeast.io with the same name, each controlling a pod, Warning events about
// both and a hand-written PolicyReport naming both, an HPA scaling the links-b one, and a cluster-scoped Gizmo of both
// groups with the same name. Each object is opened from Policy Reports, the dashboard's Issues and Optimization windows,
// Cluster Hygiene, the Alerts inbox (a kube-state-metrics custom resource state alert posted to the webhook), its pod's
// owner link, the HPA's scale target link and Advanced Search (the Gizmos with no namespace), and the drawer — the
// address (detail, detailApi), its Basic Info and its spec's color — is held to the object kubectl reads.

const RUN = Date.now().toString(36)
const NS = `e2e-dlinks-${RUN}`
const LABEL = 'kubeast.io/e2e=detail-links'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const GROUPS = ['links-a.kubeast.io', 'links-b.kubeast.io'] as const
type Group = (typeof GROUPS)[number]
const COLOR: Record<Group, string> = { 'links-a.kubeast.io': 'amber', 'links-b.kubeast.io': 'blue' }
const WIDGET = `dl-w-${RUN}`
const GIZMO = `dl-g-${RUN}`
const pod = (g: Group) => `dl-pod-${g.slice('links-'.length, 'links-'.length + 1)}-${RUN}`
const CRDS = GROUPS.flatMap((g) => [`widgets.${g}`, `gizmos.${g}`])
// the screen's words as the English catalog has them
const EN = JSON.parse(fs.readFileSync(path.join(__dirname, '../../frontend/src/i18n/locales/en.json'), 'utf8'))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const say = (key: string, fallback: string): string => key.split('.').reduce((o: any, k) => o?.[k], EN) ?? fallback
const BASIC = say('crInstanceInfo.basicInfo', 'Basic Info')
const SPEC = say('crInstanceInfo.spec', 'Spec')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any

function kubectlFor(kindName: string): ((args: string, input?: string) => string) | null {
  let kc: string
  try {
    kc = execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    return null
  }
  const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-detail-links-')), 'kubeconfig')
  fs.writeFileSync(kcPath, kc, { mode: 0o600 })
  return (args, input) => execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim()
}

const crd = (g: Group, kind: string, plural: string, scope: 'Namespaced' | 'Cluster') => ({
  apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: `${plural}.${g}` },
  spec: {
    group: g, scope, names: { kind, plural, singular: kind.toLowerCase(), listKind: `${kind}List` },
    versions: [{
      name: 'v1', served: true, storage: true,
      subresources: { status: {}, scale: { specReplicasPath: '.spec.replicas', statusReplicasPath: '.status.replicas' } },
      schema: { openAPIV3Schema: { type: 'object', properties: { spec: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true }, status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true } } } },
    }],
  },
})

// A drawer as the steps read it: the address and, of a custom resource's drawer, its Basic Info rows and spec color
type View = { detail: string | null; detailApi: string | null; basic: Record<string, string>; color: string | null }

async function readView(page: Page): Promise<View> {
  const url = new URL(page.url())
  const sections = await page.locator(DRAWER).last().evaluate((root, titles) => {
    const words = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const out: Record<string, Record<string, string>> = {}
    for (const sec of root.querySelectorAll('div.rounded-lg.border')) {
      const title = sec.firstElementChild?.firstElementChild
      if (!title || title.tagName !== 'P' || !titles.includes(words(title))) continue
      const rows: Record<string, string> = {}
      for (const g of sec.querySelectorAll('div.grid')) {
        if (g.children.length === 2 && [...g.children].every((c) => c.tagName === 'SPAN') && g.children[0].classList.contains('text-slate-400')) {
          rows[words(g.children[0])] = words(g.children[1])
        }
      }
      out[words(title)] = rows
    }
    return out
  }, [BASIC, SPEC])
  const basic = sections[BASIC] ?? {}
  return {
    detail: url.searchParams.get('detail'),
    detailApi: url.searchParams.get('detailApi'),
    basic: Object.fromEntries(['Kind', 'Name', 'Namespace', 'API Version', 'CRD'].filter((k) => k in basic).map((k) => [k, basic[k]])),
    color: sections[SPEC]?.color ?? null,
  }
}

// what the drawer of the object must show, from kubectl: the address names the object and its apiVersion
// (detailApi=<group>/<version>, which a reload opens again), the drawer its CRD's custom resource
function wantOf(o: Obj, plural: string): View {
  const [group] = o.apiVersion.split('/')
  const ns = o.metadata.namespace
  return {
    detail: [o.kind, ns, o.metadata.name].filter(Boolean).join('/'),
    detailApi: o.apiVersion,
    basic: { Kind: o.kind, Name: o.metadata.name, ...(ns ? { Namespace: ns } : {}), 'API Version': o.apiVersion, CRD: `${plural}.${group}` },
    color: o.spec.color,
  }
}

// opens a drawer one way: false when the way is not there (a row the screen does not list, a link it does not draw)
async function opened(page: Page, open: () => Promise<void>): Promise<boolean> {
  try {
    await open()
    await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

// the drawer opened one way, read until it equals the object's (20 s), else its difference (null: no drawer) kept and
// the next step run
async function compare(page: Page, what: string, open: (p: Page) => Promise<void>, want: () => View) {
  await test.step(what, async () => {
    if (await opened(page, () => open(page))) {
      try {
        await expect.poll(() => readView(page), { timeout: 20_000 }).toEqual(want())
        return
      } catch {
        expect.soft(await readView(page), what).toEqual(want())
        return
      }
    }
    expect.soft(null, `${what}: no drawer opened`).toEqual(want())
  })
}

// rows that read the same (one per group), each opened in turn on the same screen (the drawer closed with Escape in
// between — Advanced Search lists the types in the order their answers came, so a reload may swap the rows): the rows
// are as many as the groups and the drawers they open are both groups' objects
async function compareRows(page: Page, what: string, open: (p: Page) => Promise<Locator>, wants: () => View[]) {
  await test.step(what, async () => {
    const want = wants()
    let rows: Locator
    try {
      rows = await open(page)
    } catch (e) {
      expect.soft(String(e), `${what}: the screen opened`).toBe('')
      return
    }
    await expect.soft(rows, `${what}: a row per group`).toHaveCount(want.length, { timeout: 30_000 })
    const count = Math.max(1, Math.min(await rows.count(), want.length))
    const seen: (View | null)[] = []
    for (let i = 0; i < count; i++) {
      if (i > 0) {
        await page.keyboard.press('Escape')
        await expect.poll(() => new URL(page.url()).searchParams.get('detail'), { timeout: 10_000 }).toBeNull().catch(() => undefined)
      }
      if (!(await opened(page, () => rows.nth(i).click({ timeout: 30_000 })))) {
        seen.push(null)
        continue
      }
      // read once the drawer has loaded: until it shows one of the objects (20 s), else as it is
      const shown = async () => {
        const v = await readView(page)
        return want.some((w) => JSON.stringify(w) === JSON.stringify(v))
      }
      await expect.poll(shown, { timeout: 20_000 }).toBe(true).catch(() => undefined)
      seen.push(await readView(page))
    }
    const byApi = (a: View | null, b: View | null) => String(a?.basic['API Version'] ?? '').localeCompare(String(b?.basic['API Version'] ?? '')) || String(a?.detailApi).localeCompare(String(b?.detailApi))
    expect.soft([...seen].sort(byApi), what).toEqual([...want].sort(byApi))
  })
}

test.describe('number check — the drawer a screen opens for one Kind of two groups', () => {
  test('each screen opens the right group\'s object, with its apiVersion in the address', async ({ page }) => {
    test.setTimeout(900_000)
    const k = kubectlFor('kubeast-b')
    const clusters = await (await page.request.get('/api/v1/clusters')).json()
    const registered = (Array.isArray(clusters) ? clusters : clusters.items ?? []).some((x: Obj) => x.id === 'default')
    test.skip(!k || !registered, 'needs the second kind cluster (kubeast-b), registered as default')
    const kc = k!
    const cleanup = () => {
      kc(`delete namespace -l ${LABEL} --wait=false --ignore-not-found`)
      kc(`delete crd ${CRDS.join(' ')} --ignore-not-found --wait=true --timeout=180s`)
    }
    cleanup()
    try {
      kc('apply --server-side --field-manager=e2e-detail-links -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: GROUPS.flatMap((g) => [crd(g, 'Widget', 'widgets', 'Namespaced'), crd(g, 'Gizmo', 'gizmos', 'Cluster')]) }))
      kc(`wait --for=condition=Established ${CRDS.map((c) => `crd/${c}`).join(' ')} --timeout=60s`)
      kc(`create namespace ${NS}`)
      kc(`label namespace ${NS} ${LABEL}`)
      kc('apply --server-side --field-manager=e2e-detail-links -f -', JSON.stringify({
        apiVersion: 'v1', kind: 'List', items: GROUPS.flatMap((g) => [
          { apiVersion: `${g}/v1`, kind: 'Widget', metadata: { name: WIDGET, namespace: NS }, spec: { color: COLOR[g], replicas: 1 } },
          { apiVersion: `${g}/v1`, kind: 'Gizmo', metadata: { name: GIZMO }, spec: { color: COLOR[g] } },
        ]),
      }))
      const get = (g: Group, plural: string, name: string, ns?: string) => JSON.parse(kc(`get ${plural}.${g} ${name}${ns ? ` -n ${ns}` : ''} -o json`))
      const widget = (g: Group) => get(g, 'widgets', WIDGET, NS)
      const gizmo = (g: Group) => get(g, 'gizmos', GIZMO)
      const widgetWant = (g: Group) => () => wantOf(widget(g), 'widgets')
      const bothWidgets = () => GROUPS.map((g) => wantOf(widget(g), 'widgets'))

      // a pod each Widget controls (pause, no memory limit: a Cluster Hygiene finding and an Optimization row), an HPA
      // scaling the links-b one, Warning events about both and a report naming both (where default serves reports)
      const polr = kc('api-resources --api-group=wgpolicyk8s.io -o name').includes('policyreports')
      const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
      kc('apply --server-side --field-manager=e2e-detail-links -f -', JSON.stringify({
        apiVersion: 'v1', kind: 'List', items: [
          ...GROUPS.map((g) => ({
            apiVersion: 'v1', kind: 'Pod',
            metadata: { name: pod(g), namespace: NS, ownerReferences: [{ apiVersion: `${g}/v1`, kind: 'Widget', name: WIDGET, uid: widget(g).metadata.uid, controller: true }] },
            spec: { terminationGracePeriodSeconds: 0, containers: [{ name: 'app', image: 'registry.k8s.io/pause:3.10', imagePullPolicy: 'IfNotPresent' }] },
          })),
          {
            apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler', metadata: { name: `dl-hpa-${RUN}`, namespace: NS },
            spec: { scaleTargetRef: { apiVersion: 'links-b.kubeast.io/v1', kind: 'Widget', name: WIDGET }, minReplicas: 1, maxReplicas: 2 },
          },
          {
            apiVersion: 'wgpolicyk8s.io/v1alpha2', kind: 'PolicyReport', metadata: { name: `dl-polr-${RUN}`, namespace: NS },
            summary: { pass: 0, fail: 2, warn: 0, error: 0, skip: 0 },
            results: GROUPS.map((g) => ({
              policy: 'dl-links', rule: 'check', result: 'fail', source: 'kyverno', message: `the ${g} widget fails ${RUN}`,
              resources: [{ apiVersion: `${g}/v1`, kind: 'Widget', name: WIDGET, namespace: NS }],
            })),
          },
        ].filter((o) => o.kind !== 'PolicyReport' || polr),
      }))
      kc('create -f -', JSON.stringify({
        apiVersion: 'v1', kind: 'List', items: GROUPS.map((g, i) => ({
          apiVersion: 'v1', kind: 'Event', metadata: { name: `${WIDGET}.${g}`, namespace: NS },
          involvedObject: { apiVersion: `${g}/v1`, kind: 'Widget', name: WIDGET, namespace: NS, uid: widget(g).metadata.uid },
          reason: 'LinksCheck', message: `the ${g} widget warns ${RUN}`, type: 'Warning', count: 1,
          firstTimestamp: ago(90 + i * 10), lastTimestamp: ago(30 + i * 10), source: { component: 'e2e-detail-links' },
        })),
      }))
      kc(`wait --for=condition=Ready ${GROUPS.map((g) => `pod/${pod(g)}`).join(' ')} -n ${NS} --timeout=120s`)
      // the server keeps a cluster's API resources for a minute: wait until it lists the kinds this run made
      await expect.poll(async () => {
        const lists = await (await page.request.get('/api/v1/cluster/api-resources?cluster=default')).json() as { groupVersion: string; resources: { name: string }[] }[]
        return GROUPS.every((g) => ['widgets', 'gizmos'].every((plural) => lists.some((l) => l.groupVersion === `${g}/v1` && l.resources.some((r) => r.name === plural))))
      }, { timeout: 75_000, message: 'the API resources of default list both groups\' Widgets and Gizmos' }).toBe(true)
      const link = (detail: string) => (p: Page) => p.goto(`/?cluster=default&detail=${encodeURIComponent(detail)}`).then(() => undefined)

      // Policy Reports: each result row (its message names the group) opens its resource
      if (polr) {
        for (const g of GROUPS) {
          await compare(page, `Policy Reports · Widget.${g}`, async (p) => {
            await p.goto('/security/policyreports?cluster=default')
            await p.getByTestId('policy-reports-namespace').click()
            await p.getByTestId(`policy-reports-namespace-opt-${NS}`).click()
            await p.getByTestId('policy-reports-tab-results').click()
            // the server keeps a read for a minute: the refresh reads the reports now
            await p.getByRole('button', { name: say('policyReports.refresh', 'Refresh'), exact: true }).click()
            await p.getByTestId('policy-report-row').filter({ hasText: `the ${g} widget fails ${RUN}` }).first().click({ timeout: 30_000 })
          }, widgetWant(g))
        }
      } else {
        test.info().annotations.push({ type: 'skip', description: 'Policy Reports: default serves no PolicyReport' })
      }

      // the dashboard's Issues: a row per Widget (its newest Warning event's message names the group)
      for (const g of GROUPS) {
        await compare(page, `Issues · Widget.${g}`, async (p) => {
          await p.goto('/?cluster=default')
          await p.locator('button').filter({ hasText: /Check issues|이슈 확인/ }).first().click()
          await p.getByTestId('issues-kind-Widget').getByTestId('issue-row').filter({ hasText: `the ${g} widget warns ${RUN}` }).first().click({ timeout: 30_000 })
        }, widgetWant(g))
      }

      // the dashboard's Optimization window: the two Widgets' rows read the same (Widget/<name>, container app)
      await compareRows(page, 'Optimization · both Widgets', async (p) => {
        await p.goto('/?cluster=default')
        await p.locator('button').filter({ hasText: /Optimization suggestions|최적화 제안/ }).first().click()
        await p.locator('button[title="Select namespace"], button[title="Namespace 선택"]').first().click()
        await p.getByRole('button', { name: NS, exact: true }).click()
        await p.getByTestId('optimization-table').waitFor({ timeout: 30_000 })
        return p.getByTestId('optimization-row').filter({ hasText: `Widget/${WIDGET}` }).getByTestId('optimization-open')
      }, bothWidgets)

      // Cluster Hygiene: the two Widgets' "no memory limit" rows read the same
      await compareRows(page, 'Cluster Hygiene · both Widgets', async (p) => {
        await p.goto('/admin/cluster-hygiene?cluster=default')
        await p.getByTestId('hygiene-cluster').click()
        await p.getByTestId('hygiene-cluster-opt-default').click()
        await p.getByTestId('hygiene-summary').waitFor({ timeout: 90_000 })
        await p.getByPlaceholder(say('clusterHygiene.search', 'Search Namespace, name, message...')).fill(WIDGET)
        return p.getByTestId('hygiene-finding-row').filter({ hasText: `Widget/${WIDGET}` }).filter({ hasText: say('clusterHygiene.message.memoryLimit', 'no memory limit') })
      }, bothWidgets)

      // a pod's owner link, the HPA's scale target link
      for (const g of GROUPS) {
        await compare(page, `owner link · pod of Widget.${g}`, async (p) => {
          await link(`Pod/${NS}/${pod(g)}`)(p)
          await p.locator(DRAWER).last().getByRole('button', { name: WIDGET, exact: true }).click({ timeout: 30_000 })
        }, widgetWant(g))
      }
      await compare(page, 'scale target link · HPA of Widget.links-b.kubeast.io', async (p) => {
        await link(`HorizontalPodAutoscaler/${NS}/dl-hpa-${RUN}`)(p)
        await p.locator(DRAWER).last().getByRole('button', { name: WIDGET, exact: true }).click({ timeout: 30_000 })
      }, widgetWant('links-b.kubeast.io'))

      // the Alerts inbox: kube-state-metrics custom resource state alerts about each Widget, posted to the webhook
      const kb = kubectlFor('kubeast')
      const features = await (await page.request.get('/api/v1/cluster/features')).json()
      if (kb && features.alertInvestigation?.enabled) {
        const token = Buffer.from(kb('-n kubeast get secret kubeast-secrets -o jsonpath={.data.ALERT_WEBHOOK_TOKEN}'), 'base64').toString()
        const alertname = `E2EDetailLinks${RUN}`
        // one alert keeps its start, as Alertmanager's does: the inbox knows a resolved notification by it
        const startsAt = ago(120)
        const post = (status: 'firing' | 'resolved') => page.request.post('/api/v1/alerts/webhook?cluster=default', {
          headers: { Authorization: `Bearer ${token}` },
          data: {
            version: '4', groupKey: `{}:{alertname="${alertname}"}`, status, receiver: 'kubeast', externalURL: 'http://alertmanager.e2e:9093',
            alerts: GROUPS.map((g) => ({
              status,
              labels: { alertname, severity: 'info', namespace: NS, customresource_group: g, customresource_version: 'v1', customresource_kind: 'Widget', name: WIDGET },
              annotations: { summary: `the ${g} widget is not ready ${RUN}` },
              startsAt, ...(status === 'resolved' ? { endsAt: ago(1) } : {}),
              fingerprint: `dlinks-${RUN}-${g}`,
            })),
          },
        })
        expect((await post('firing')).ok(), 'the webhook took the alerts').toBe(true)
        try {
          const items = (await (await page.request.get('/api/v1/alerts/inbox', { params: { cluster: 'default', q: RUN, limit: 200 } })).json()).items as Obj[]
          for (const g of GROUPS) {
            const row = items.find((i) => i.alertname === alertname && (i.summary ?? '').includes(g))
            await compare(page, `Alerts inbox · Widget.${g}`, async (p) => {
              await p.goto('/alerts?cluster=default')
              await p.getByTestId('alert-tab-firing').click()
              await p.getByTestId(`alert-row-${row?.id}`).getByTestId('alert-object').click({ timeout: 30_000 })
            }, widgetWant(g))
          }
        } finally {
          await post('resolved')
        }
        const rows = (await (await page.request.get('/api/v1/alerts/inbox', { params: { cluster: 'default', q: RUN, limit: 200 } })).json()).items as Obj[]
        expect(rows.filter((i) => i.alertname === alertname).map((i) => i.status), 'each alert closed by its resolved notification').toEqual(['resolved', 'resolved'])
      } else {
        test.info().annotations.push({ type: 'skip', description: 'Alerts inbox: alert investigation (the webhook) is off' })
      }

      // Advanced Search: the two cluster-scoped Gizmos read the same (no namespace)
      await page.addInitScript((t) => localStorage.setItem('advanced-search-resources', JSON.stringify(t)), GROUPS.map((g) => `gizmos.${g}`))
      // (every object of the two kinds, all namespaces: this run's two Gizmos)
      await compareRows(page, 'Advanced Search · both Gizmos', async (p) => {
        await p.goto('/cluster/search?cluster=default')
        await p.locator('.monaco-editor').first().click()
        await p.keyboard.type('true')
        return p.locator('table tbody tr').getByRole('button', { name: GIZMO, exact: true })
      }, () => GROUPS.map((g) => wantOf(gizmo(g), 'gizmos')))
    } finally {
      cleanup()
    }
  })
})
