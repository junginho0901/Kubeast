import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Every drawer that lists events always has its Events section: the events kubectl describe lists about the object,
// "None" when it lists none, and — when the viewer may read the object but not its events — that they could not be
// read, with the cluster's reason, never a "None" for events nobody read. On `self`, in namespace e2e-drawer-events
// and with cluster-scoped objects named drev-*: an object of each kind whose drawer hid an empty Events section
// (made so that nothing records events about it — a pod no scheduler takes, a paused Deployment, a suspended CronJob),
// events written about a ConfigMap and an IngressClass, a claim that waits for its first consumer (the volume
// controller records that), each drawer opened by link and its Events section compared with kubectl; then a reader
// limited to the namespace, which the cluster lets get ConfigMaps and Leases there but not list events, opens one of
// each. Everything is removed after.

const NS = 'e2e-drawer-events'
const CLUSTER = 'self'
const NODE = 'kubeast-control-plane'
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
const id = Date.now().toString(36)
const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const READER_EMAIL = `e2e-drev-${id}@kubeast.local`
const READER_PW = `drev-${id}-pw`
const READER_GROUP = 'kubeast:role:read'

const kc = execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' })
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-drawer-events-')), 'kubeconfig')
fs.writeFileSync(kcPath, kc, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any

const pod = (schedulerName: string) => ({
  schedulerName, terminationGracePeriodSeconds: 0,
  containers: [{ name: 'app', image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command: ['sleep', '3600'] }],
})
const FIXTURE = [
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } },
  { apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'drev-sc' }, provisioner: 'kubernetes.io/no-provisioner', volumeBindingMode: 'WaitForFirstConsumer' },
  { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: 'drev-pv' },
    spec: { capacity: { storage: '1Mi' }, accessModes: ['ReadWriteOnce'], persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'drev-sc', hostPath: { path: '/tmp/drev-pv' } } },
  { apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: 'drev-pv-bound' },
    spec: { capacity: { storage: '1Mi' }, accessModes: ['ReadWriteOnce'], persistentVolumeReclaimPolicy: 'Retain', storageClassName: '', hostPath: { path: '/tmp/drev-pv-bound' },
      claimRef: { namespace: NS, name: 'drev-pvc-bound' } } },
  { apiVersion: 'networking.k8s.io/v1', kind: 'IngressClass', metadata: { name: 'drev-ic' }, spec: { controller: 'example.com/drev' } },
  { apiVersion: 'networking.k8s.io/v1', kind: 'IngressClass', metadata: { name: 'drev-ic-events' }, spec: { controller: 'example.com/drev' } },
  { apiVersion: 'storage.k8s.io/v1', kind: 'VolumeAttachment', metadata: { name: 'drev-va' }, spec: { attacher: 'drev.example.com', nodeName: NODE, source: { persistentVolumeName: 'drev-pv' } } },
  { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'drev-pod', namespace: NS }, spec: pod('drev-none') },
  { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'drev-deploy', namespace: NS },
    spec: { paused: true, replicas: 1, selector: { matchLabels: { app: 'drev-deploy' } }, template: { metadata: { labels: { app: 'drev-deploy' } }, spec: pod('drev-none') } } },
  { apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name: 'drev-cron', namespace: NS },
    spec: { schedule: '0 0 1 1 *', suspend: true, jobTemplate: { spec: { template: { spec: { ...pod('drev-none'), restartPolicy: 'Never' } } } } } },
  { apiVersion: 'v1', kind: 'Service', metadata: { name: 'drev-svc', namespace: NS }, spec: { ports: [{ port: 80, targetPort: 80 }] } },
  { apiVersion: 'v1', kind: 'Endpoints', metadata: { name: 'drev-ep', namespace: NS }, subsets: [{ addresses: [{ ip: '10.255.0.1' }], ports: [{ port: 80 }] }] },
  // the kinds whose drawers gained the section, one without events and one with; a PodTemplate has the fallback drawer
  ...['drev-ing', 'drev-ing-events'].map((name) => ({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name, namespace: NS },
    spec: { rules: [{ http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'drev-svc', port: { number: 80 } } } }] } }] } })),
  ...['drev-np', 'drev-np-events'].map((name) => ({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: { name, namespace: NS },
    spec: { podSelector: { matchLabels: { app: 'nothing-here' } }, policyTypes: ['Ingress'] } })),
  ...['drev-eps', 'drev-eps-events'].map((name) => ({ apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice', metadata: { name, namespace: NS, labels: { 'kubernetes.io/service-name': 'drev-svc' } },
    addressType: 'IPv4', ports: [{ port: 80, protocol: 'TCP' }], endpoints: [{ addresses: ['10.255.0.2'] }] })),
  ...['drev-pt', 'drev-pt-events'].map((name) => ({ apiVersion: 'v1', kind: 'PodTemplate', metadata: { name, namespace: NS },
    template: { metadata: { labels: { app: 'drev-pt' } }, spec: pod('drev-none') } })),
  { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'drev-cm', namespace: NS }, data: { k: 'v' } },
  { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'drev-cm-events', namespace: NS }, data: { k: 'v' } },
  { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'drev-secret', namespace: NS }, type: 'Opaque', stringData: { k: 'v' } },
  { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'drev-sa', namespace: NS } },
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: 'drev-role', namespace: NS }, rules: [{ apiGroups: [''], resources: ['configmaps'], verbs: ['get'] }] },
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'drev-rb', namespace: NS },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'drev-role' }, subjects: [{ kind: 'ServiceAccount', name: 'drev-sa', namespace: NS }] },
  { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'drev-pvc', namespace: NS },
    spec: { storageClassName: 'drev-sc', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Mi' } } } },
  { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'drev-pvc-bound', namespace: NS },
    spec: { storageClassName: '', volumeName: 'drev-pv-bound', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Mi' } } } },
  { apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', metadata: { name: 'drev-lease', namespace: NS }, spec: { holderIdentity: 'drev', leaseDurationSeconds: 3600 } },
  // the reader limited to the namespace acts as kubeast:role:read: here it may get ConfigMaps and Leases, not list events
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name: 'drev-reader', namespace: NS },
    rules: [{ apiGroups: [''], resources: ['configmaps'], verbs: ['get', 'list', 'watch'] }, { apiGroups: ['coordination.k8s.io'], resources: ['leases'], verbs: ['get', 'list', 'watch'] }] },
  { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'drev-reader', namespace: NS },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'drev-reader' }, subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: READER_GROUP }] },
]
const CLUSTER_SCOPED = 'volumeattachment/drev-va persistentvolume/drev-pv persistentvolume/drev-pv-bound ingressclass/drev-ic ingressclass/drev-ic-events storageclass/drev-sc'

// events written for the run, about objects nothing else records events for: kind, apiVersion, name, reason, type,
// minutes ago (the uid set as kubectl describe pairs them; a cluster-scoped object's in namespace default)
const WRITTEN: [string, string, string, string, string, number][] = [
  ['ConfigMap', 'v1', 'drev-cm-events', 'Synced', 'Normal', 3],
  ['ConfigMap', 'v1', 'drev-cm-events', 'Rejected', 'Warning', 1],
  ['Ingress', 'networking.k8s.io/v1', 'drev-ing-events', 'Sync', 'Normal', 2],
  ['NetworkPolicy', 'networking.k8s.io/v1', 'drev-np-events', 'Applied', 'Normal', 2],
  ['EndpointSlice', 'discovery.k8s.io/v1', 'drev-eps-events', 'Mirrored', 'Warning', 2],
  ['PodTemplate', 'v1', 'drev-pt-events', 'Seen', 'Normal', 2],
  ['IngressClass', 'networking.k8s.io/v1', 'drev-ic-events', 'Claimed', 'Normal', 2],
]
const eventName = (name: string, reason: string) => `${name}.drev-${reason.toLowerCase()}`
const EARLIER = 'E2EEarlierObject'

// the drawers read: kind, namespace ('' for a cluster-scoped object), name
const TARGETS: [string, string, string][] = [
  ['Pod', NS, 'drev-pod'], ['Deployment', NS, 'drev-deploy'], ['CronJob', NS, 'drev-cron'], ['Service', NS, 'drev-svc'], ['Endpoints', NS, 'drev-ep'],
  ['ConfigMap', NS, 'drev-cm'], ['ConfigMap', NS, 'drev-cm-events'], ['Secret', NS, 'drev-secret'], ['ServiceAccount', NS, 'drev-sa'],
  ['Role', NS, 'drev-role'], ['RoleBinding', NS, 'drev-rb'], ['PersistentVolumeClaim', NS, 'drev-pvc'], ['PersistentVolumeClaim', NS, 'drev-pvc-bound'],
  ['PersistentVolume', '', 'drev-pv'], ['StorageClass', '', 'drev-sc'], ['VolumeAttachment', '', 'drev-va'], ['IngressClass', '', 'drev-ic'],
  ['IngressClass', '', 'drev-ic-events'], ['Namespace', '', NS],
  ['Ingress', NS, 'drev-ing'], ['Ingress', NS, 'drev-ing-events'], ['NetworkPolicy', NS, 'drev-np'], ['NetworkPolicy', NS, 'drev-np-events'],
  ['EndpointSlice', NS, 'drev-eps'], ['EndpointSlice', NS, 'drev-eps-events'], ['PodTemplate', NS, 'drev-pt'], ['PodTemplate', NS, 'drev-pt-events'],
]
const link = (kind: string, ns: string, name: string) => `/?cluster=${CLUSTER}&detail=${encodeURIComponent(ns ? `${kind}/${ns}/${name}` : `${kind}/${name}`)}`

// A drawer's Events section as read: per row its Type, Reason and Message (newest first, its first page), the pager
// ("1-10 / 12") and, without a table, its text; null when the drawer has no Events section.
type Events = { rows: string[][]; pager: string | null; text: string } | null
async function readEvents(page: Page): Promise<Events> {
  return page.locator(DRAWER).last().evaluate((root) => {
    const txt = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim()
    const sec = [...root.querySelectorAll('div.rounded-lg.border')].find((s) => {
      const t = s.firstElementChild?.firstElementChild
      return !!t && t.tagName === 'P' && txt(t) === 'Events'
    })
    if (!sec) return null
    const table = sec.querySelector('table')
    const pager = [...sec.querySelectorAll('span')].map(txt).find((s) => /^\d+-\d+ \/ \d+$/.test(s)) ?? null
    return {
      rows: table ? [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].slice(0, 3).map(txt)) : [],
      pager,
      text: table ? '' : txt(sec).slice(txt(sec.firstElementChild!).length).trim(),
    }
  })
}

// What kubectl describe lists about the object — the events of its kind, name and UID, in its namespace (a Namespace's
// in itself), a cluster-scoped object's in every namespace — as the section shows them: newest first, ten to a page,
// "None" without any. Rows of one time compare in any order.
function eventsWant(kind: string, ns: string, name: string): NonNullable<Events> {
  const where = kind === 'Namespace' ? `-n ${name}` : ns ? `-n ${ns}` : '-A'
  const uid = kubectl(`get ${kind.toLowerCase()} ${name} ${ns ? `-n ${ns}` : ''} -o jsonpath={.metadata.uid}`)
  const items: Obj[] = JSON.parse(kubectl(`get events ${where} --field-selector involvedObject.name=${name},involvedObject.kind=${kind},involvedObject.uid=${uid} -o json`)).items
  const last = (e: Obj) => Date.parse(e.series?.lastObservedTime ?? e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? '') || 0
  const rows = items.slice().sort((a, b) => last(b) - last(a)).map((e) => [e.type || '-', e.reason || '-', e.message || '-'])
  return { rows: rows.slice(0, 10), pager: rows.length > 10 ? `1-10 / ${rows.length}` : null, text: rows.length ? '' : 'None' }
}
const byText = (v: Events) => (v ? { ...v, rows: v.rows.map((r) => r.join(' | ')).sort() } : v)

// the section read until it is what kubectl lists (20 s), each time against kubectl read anew
async function compareEvents(page: Page, label: string, want: () => NonNullable<Events>) {
  const same = await expect.poll(async () => JSON.stringify(byText(await readEvents(page))) === JSON.stringify(byText(want())), { timeout: 20_000, intervals: [1000] })
    .toBe(true).then(() => true, () => false)
  if (!same) expect.soft(byText(await readEvents(page)), label).toEqual(byText(want()))
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

function cleanup() {
  kubectl(`delete namespace ${NS} --wait=true --timeout=120s --ignore-not-found`)
  // the bound volume goes once its claim has gone with the namespace
  kubectl(`delete ${CLUSTER_SCOPED} --ignore-not-found --wait=true --timeout=90s`)
  const defaultEvents = WRITTEN.filter(([kind]) => kind === 'IngressClass').map(([, , name, reason]) => eventName(name, reason))
  kubectl(`delete events -n default ${defaultEvents.join(' ')} --ignore-not-found`)
}

test.describe('number check — every drawer\'s Events section', () => {
  let admin = ''
  let readerId = ''

  test.beforeAll(async ({ request }) => {
    test.setTimeout(240_000)
    cleanup()
    kubectl('apply -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: FIXTURE }))
    // the events written about objects that exist, with their uid
    const items = WRITTEN.map(([kind, apiVersion, name, reason, type, ago]) => {
      const ns = kind === 'IngressClass' ? '' : NS
      const uid = kubectl(`get ${kind.toLowerCase()} ${name} ${ns ? `-n ${ns}` : ''} -o jsonpath={.metadata.uid}`)
      const at = new Date(Date.now() - ago * 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
      return {
        apiVersion: 'v1', kind: 'Event', metadata: { name: eventName(name, reason), namespace: ns || 'default' },
        involvedObject: { apiVersion, kind, name, uid, ...(ns ? { namespace: ns } : {}) },
        reason, message: `${reason} by the e2e run`, type, count: 1, firstTimestamp: at, lastTimestamp: at, source: { component: 'e2e' },
      }
    })
    // and one about an earlier ConfigMap of the same name, which kubectl describe does not list
    const earlier = { ...items[0], metadata: { ...items[0].metadata, name: eventName('drev-cm-events', 'EarlierObject') }, reason: EARLIER, involvedObject: { ...items[0].involvedObject, uid: '00000000-0000-4000-8000-0000000e2e01' } }
    kubectl('create -f -', JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [...items, earlier] }))
    // settled: the bound claim bound, the waiting claim's event recorded
    const deadline = Date.now() + 90_000
    for (;;) {
      const bound = kubectl(`get pvc drev-pvc-bound -n ${NS} -o jsonpath={.status.phase}`) === 'Bound'
      const waiting = eventsWant('PersistentVolumeClaim', NS, 'drev-pvc').rows.length > 0
      if (bound && waiting) break
      if (Date.now() > deadline) throw new Error(`fixture did not settle (bound ${bound}, waiting claim event ${waiting})`)
      await new Promise((r) => setTimeout(r, 2000))
    }
    // the reader limited to the namespace
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E drawer events ${id}`, email: READER_EMAIL, password: READER_PW } })
    expect(created.status(), await created.text()).toBe(201)
    readerId = (await created.json()).id
    const put = await request.put(`/api/v1/auth/admin/users/${readerId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: [NS] } })
    expect(put.ok(), await put.text()).toBeTruthy()
  })

  test.afterAll(async ({ request }) => {
    if (readerId) await request.delete(`/api/v1/auth/admin/users/${readerId}`, { headers: bearer(admin) })
    cleanup()
  })

  test('each drawer\'s Events section: the events kubectl lists, "None" without any', async ({ page }) => {
    test.setTimeout(300_000)
    for (const [kind, ns, name] of TARGETS) await test.step(`${kind}/${ns ? `${ns}/` : ''}${name}`, async () => {
      await page.goto(link(kind, ns, name))
      await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
      await compareEvents(page, `${kind}/${name}`, () => eventsWant(kind, ns, name))
      if (name === 'drev-cm-events') expect((await readEvents(page))?.rows.map((r) => r[1]) ?? [], 'an earlier ConfigMap\'s event').not.toContain(EARLIER)
    })
  })

  test('the window of a kind with no drawer of its own tells the floating chat what it shows', async ({ page }) => {
    test.setTimeout(120_000)
    const sent: { overlays: { source: string; data?: Obj }[] }[] = []
    await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ json: { id: 'e2e-drev-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
        : route.fallback())
    await page.route(/\/api\/v1\/sessions\/e2e-drev-\d+(\?|$)/, (route) =>
      route.fulfill({ json: { id: 'e2e-drev-1', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }))
    await page.route(/\/api\/v1\/ai\/sessions\/e2e-drev-\d+\/floating-chat/, (route) => {
      sent.push(route.request().postDataJSON().page_context)
      return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"content":"ok"}\n\ndata: [DONE]\n\n' })
    })
    kubectl(`annotate podtemplate drev-pt -n ${NS} e2e.kubeast.io/note=drev-note-value --overwrite`)
    kubectl(`label podtemplate drev-pt -n ${NS} e2e-label=shown --overwrite`)
    const want: Obj = JSON.parse(kubectl(`get podtemplate drev-pt -n ${NS} -o json`))
    await page.goto(link('PodTemplate', NS, 'drev-pt'))
    await expect(page.locator(DRAWER).last()).toContainText('e2e-label:shown', { timeout: 20_000 })
    await page.getByTestId('floating-chat-toggle').click()
    const input = page.getByTestId('floating-chat-input')
    await expect.poll(async () => {
      const before = sent.length
      await input.fill('what is on this screen?')
      await input.press('Enter')
      await expect.poll(() => sent.length).toBe(before + 1)
      await expect(page.getByTestId('floating-chat-panel').getByRole('button', { name: /^(Send|보내기)$/ })).toBeVisible()
      const data = sent[sent.length - 1].overlays.find((o) => o.source === 'PodTemplateInfo')?.data
      return { apiVersion: data?.api_version, uid: data?.uid, created: data?.created_at, label: data?.labels?.['e2e-label'], annotated: data?.annotations?.includes('e2e.kubeast.io/note') }
    }, { timeout: 30_000 }).toEqual({ apiVersion: 'v1', uid: want.metadata.uid, created: want.metadata.creationTimestamp, label: 'shown', annotated: true })
    expect(JSON.stringify(sent[sent.length - 1].overlays.find((o) => o.source === 'PodTemplateInfo'))).not.toContain('drev-note-value')
  })

  test('a reader the cluster lets read the object but not its events is told so, with the cluster\'s reason', async ({ browser }) => {
    test.setTimeout(120_000)
    // what the cluster answers that identity (Kubeast impersonates the user's email in the role's group)
    const as = `--as=${READER_EMAIL} --as-group=${READER_GROUP}`
    expect(kubectl(`get configmap drev-cm -n ${NS} ${as} -o jsonpath={.metadata.name}`), 'the reader may get the ConfigMap').toBe('drev-cm')
    let refusal = ''
    try {
      kubectl(`get events -n ${NS} ${as}`)
    } catch (err) {
      refusal = String((err as { stderr?: string }).stderr ?? '').replace(/^Error from server \(Forbidden\): /, '').trim()
    }
    test.skip(!refusal, `the cluster lets ${READER_GROUP} list events in ${NS} (bound elsewhere), so nothing is refused`)
    expect(refusal, 'the cluster refuses the reader the events').toMatch(/^events is forbidden: User ".+" cannot list resource "events"/)

    const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080' })
    try {
      const page = await ctx.newPage()
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill(READER_EMAIL)
      await page.locator('input[type="password"]').first().fill(READER_PW)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
      for (const [kind, name] of [['ConfigMap', 'drev-cm'], ['Lease', 'drev-lease']]) await test.step(`${kind}/${NS}/${name} as the reader`, async () => {
        await page.goto(link(kind, NS, name))
        await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
        await compareEvents(page, `${kind}/${name} as the reader`, () => ({ rows: [], pager: null, text: `Could not load the events: ${refusal}` }))
      })
    } finally {
      await ctx.close()
    }
  })
})
