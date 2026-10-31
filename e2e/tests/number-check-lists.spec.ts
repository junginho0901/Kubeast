import { execSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type Page } from '@playwright/test'

// Every list screen's numbers are the cluster's: in namespace e2e-numbers of `self` (objects whose numbers are not
// zero and not alike, made here and removed after), each screen's rows are the cluster's objects, each column the
// API server also prints (the Table of `kubectl get`, Accept as=Table) holds the same value, the columns only Kubeast
// prints hold what the objects say, and the summary cards count what their labels mean. All values of a screen are
// compared before it fails (expect.soft), so one run lists every difference.

const NS = 'e2e-numbers'
const kindName = 'kubeast'

function kubeconfigText() {
  return execSync(`kind get kubeconfig --name ${kindName}`, { encoding: 'utf8' })
}
const kc = kubeconfigText()
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-check-')), 'kubeconfig')
fs.writeFileSync(kcPath, kc, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()

// The API server's Table — what `kubectl get` prints — through the kubeconfig's client certificate.
const pick = (k: string) => (kc.match(new RegExp(`${k}: (\\S+)`)) ?? [])[1] ?? ''
const server = new URL(pick('server'))
type Table = { columnDefinitions: { name: string }[]; rows: { cells: unknown[]; object: { metadata: { name: string } } }[] }
function apiTable(apiPath: string): Promise<Table> {
  return new Promise((resolve, reject) => {
    https.request({
      host: server.hostname, port: server.port, path: apiPath, method: 'GET',
      ca: Buffer.from(pick('certificate-authority-data'), 'base64'),
      cert: Buffer.from(pick('client-certificate-data'), 'base64'),
      key: Buffer.from(pick('client-key-data'), 'base64'),
      headers: { Accept: 'application/json;as=Table;g=meta.k8s.io;v=v1' },
    }, (r) => {
      let s = ''
      r.on('data', (c) => (s += c))
      r.on('end', () => (r.statusCode === 200 ? resolve(JSON.parse(s)) : reject(new Error(`${apiPath}: ${r.statusCode} ${s.slice(0, 200)}`))))
    }).on('error', reject).end()
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
const items = (plural: string): Obj[] => JSON.parse(kubectl(`get ${plural} -n ${NS} -o json`)).items
const cond = (o: Obj, type: string) => (o.status?.conditions ?? []).find((c: Obj) => c.type === type)?.status

const FIXTURE = fs.readFileSync(path.join(__dirname, 'number-check.fixture.yaml'), 'utf8')

// a screen value and the cluster's are the same when they say the same thing in Kubeast's words: an empty value
// is "-", booleans are Yes/No, access modes are spelled out, RESTARTS without kubectl's "(… ago)"
const EMPTY = new Set(['', '-', '<none>', 'none', 'n/a', '<unset>'])
const MODES: Record<string, string> = { rwo: 'readwriteonce', rox: 'readonlymany', rwx: 'readwritemany', rwop: 'readwriteoncepod' }
function sameValue(screen: string, cluster: string): boolean {
  const a = screen.trim().toLowerCase()
  const b = cluster.trim().toLowerCase()
  if (EMPTY.has(a) && EMPTY.has(b)) return true
  if ((a === 'yes' && b === 'true') || (a === 'no' && b === 'false')) return true
  const modes = (s: string) => s.split(/[\s,]+/).filter(Boolean).map((m) => MODES[m] ?? m).sort().join(',')
  if (modes(a) === modes(b)) return true
  return a.replace(/\s+/g, ' ') === b.replace(/\s+/g, ' ')
}
const norm = (h: string) => h.toLowerCase().replace(/[\s_()-]/g, '')

type Screen = {
  path: string
  api: string
  plural: string
  // screen header → Table column, where the names differ
  alias?: Record<string, string>
  // how a screen column differs from kubectl's on purpose: the cluster value is turned into Kubeast's first
  shape?: Record<string, (cluster: string, o: Obj) => string>
  // columns kubectl does not print: what the object says
  extra?: Record<string, (o: Obj) => string>
  // not compared, with why
  skip?: Record<string, string>
  // summary card label → the count that label means, over the namespace's objects
  cards?: (list: Obj[]) => Record<string, number>
}

// Healthy = all wanted replicas ready, Unavailable = none available, Degraded = the rest that want replicas, Idle =
// none wanted (the Deployments page has no Idle card)
const replicaCards = (desired: (o: Obj) => number, ready: (o: Obj) => number, available: (o: Obj) => number, idle = true) => (list: Obj[]) => ({
  Total: list.length,
  Healthy: list.filter((o) => desired(o) > 0 && ready(o) === desired(o)).length,
  ...(idle ? { Idle: list.filter((o) => desired(o) === 0).length } : {}),
  Degraded: list.filter((o) => desired(o) > 0 && available(o) > 0 && ready(o) < desired(o)).length,
  Unavailable: list.filter((o) => desired(o) > 0 && available(o) === 0).length,
})
const n = (v: unknown) => Number(v ?? 0)
const AGE = 'nice-to-have: dates-pages.spec.ts compares the Pods age with kubectl; the format is formatAge everywhere'

const SCREENS: Screen[] = [
  {
    path: '/workloads/pods', api: `/api/v1/namespaces/${NS}/pods`, plural: 'pods',
    alias: { 'Pod IP': 'IP' },
    shape: { Restarts: (v) => v.replace(/\s*\(.*\)$/, '') },
    skip: { Age: AGE },
    cards: (list) => {
      const running = list.filter((p) => p.status.phase === 'Running')
      const allReady = (p: Obj) => (p.status.containerStatuses ?? []).length > 0 && (p.status.containerStatuses ?? []).every((c: Obj) => c.ready)
      const restarts = (p: Obj) => [...(p.status.initContainerStatuses ?? []), ...(p.status.containerStatuses ?? [])].reduce((s: number, c: Obj) => s + n(c.restartCount), 0)
      const reasonError = (p: Obj) => [...(p.status.initContainerStatuses ?? []), ...(p.status.containerStatuses ?? [])].some((c: Obj) =>
        /error|failed|backoff|errimagepull|oomkilled/i.test(c.state?.waiting?.reason ?? c.state?.terminated?.reason ?? ''))
      return {
        Total: list.length,
        Ready: running.filter(allReady).length,
        'Not Ready': running.filter((p) => !allReady(p)).length,
        Pending: list.filter((p) => p.status.phase === 'Pending').length,
        Error: list.filter((p) => p.status.phase === 'Failed' || reasonError(p)).length,
        Restarted: list.filter((p) => restarts(p) > 0).length,
        Completed: list.filter((p) => p.status.phase === 'Succeeded').length,
      }
    },
  },
  {
    path: '/workloads/deployments', api: `/apis/apps/v1/namespaces/${NS}/deployments`, plural: 'deployments',
    alias: { Image: 'Images' },
    skip: { Status: 'the cards below check what the status buckets mean', Age: AGE },
    cards: replicaCards((o) => n(o.spec.replicas), (o) => n(o.status.readyReplicas), (o) => n(o.status.availableReplicas), false),
  },
  {
    path: '/workloads/statefulsets', api: `/apis/apps/v1/namespaces/${NS}/statefulsets`, plural: 'statefulsets',
    extra: {
      'Up to date': (o) => `${n(o.status.updatedReplicas ?? o.status.currentReplicas)}/${n(o.spec.replicas)}`,
      Available: (o) => String(n(o.status.availableReplicas)),
      Service: (o) => o.spec.serviceName ?? '-',
    },
    skip: { Status: 'the cards check the buckets', Age: AGE },
    cards: replicaCards((o) => n(o.spec.replicas), (o) => n(o.status.readyReplicas), (o) => n(o.status.availableReplicas)),
  },
  {
    path: '/workloads/daemonsets', api: `/apis/apps/v1/namespaces/${NS}/daemonsets`, plural: 'daemonsets',
    // kubectl prints READY as the ready count; Kubeast as ready/desired
    shape: { Ready: (v, o) => `${v}/${n(o.status.desiredNumberScheduled)}` },
    skip: { Status: 'the cards check the buckets', Age: AGE },
    cards: replicaCards((o) => n(o.status.desiredNumberScheduled), (o) => n(o.status.numberReady), (o) => n(o.status.numberAvailable)),
  },
  {
    path: '/workloads/replicasets', api: `/apis/apps/v1/namespaces/${NS}/replicasets`, plural: 'replicasets',
    extra: { Available: (o) => String(n(o.status.availableReplicas)) },
    skip: { Status: 'the cards check the buckets', Age: AGE },
    cards: replicaCards((o) => n(o.spec.replicas), (o) => n(o.status.readyReplicas), (o) => n(o.status.availableReplicas)),
  },
  {
    path: '/workloads/jobs', api: `/apis/batch/v1/namespaces/${NS}/jobs`, plural: 'jobs',
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Completed: list.filter((j) => cond(j, 'Complete') === 'True').length,
      Failed: list.filter((j) => cond(j, 'Failed') === 'True').length,
      Running: list.filter((j) => cond(j, 'Complete') !== 'True' && cond(j, 'Failed') !== 'True').length,
    }),
  },
  {
    path: '/workloads/cronjobs', api: `/apis/batch/v1/namespaces/${NS}/cronjobs`, plural: 'cronjobs',
    skip: { 'Next Run': 'a time computed from the schedule; dates-pages.spec.ts compares it', Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Active: list.filter((c) => (c.status.active ?? []).length > 0).length,
      Suspended: list.filter((c) => c.spec.suspend === true).length,
      Scheduled: list.filter((c) => !!c.status.lastScheduleTime).length,
    }),
  },
  {
    path: '/workloads/hpas', api: `/apis/autoscaling/v2/namespaces/${NS}/horizontalpodautoscalers`, plural: 'horizontalpodautoscalers',
    alias: { Min: 'MinPods', Max: 'MaxPods' },
    // Kubeast prints current/desired, desired "-" while the HPA has no current metric (HPATable.tsx)
    shape: { Replicas: (v, o) => `${v}/${(o.status.currentMetrics ?? []).some((m: Obj) => m.type) ? n(o.status.desiredReplicas) : '-'}` },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Active: list.filter((h) => cond(h, 'ScalingActive') === 'True').length,
      Inactive: list.filter((h) => cond(h, 'ScalingActive') !== 'True').length,
    }),
  },
  {
    path: '/workloads/pdbs', api: `/apis/policy/v1/namespaces/${NS}/poddisruptionbudgets`, plural: 'poddisruptionbudgets',
    extra: {
      Current: (o) => `${n(o.status.currentHealthy)}/${n(o.status.desiredHealthy)}`,
      Desired: (o) => String(n(o.status.desiredHealthy)),
    },
    skip: { Age: AGE },
    cards: (list) => {
      const healthy = (p: Obj) => n(p.status.disruptionsAllowed) > 0 || n(p.status.currentHealthy) >= n(p.status.desiredHealthy)
      return { Total: list.length, Healthy: list.filter(healthy).length, Disrupted: list.filter((p) => !healthy(p)).length }
    },
  },
  {
    path: '/network/services', api: `/api/v1/namespaces/${NS}/services`, plural: 'services',
    // kubectl prints 80/TCP; Kubeast prints the target port and the node port too
    extra: {
      Ports: (o) => (o.spec.ports ?? []).map((p: Obj) => `${p.protocol ?? 'TCP'} ${p.port}->${p.targetPort ?? p.port}${p.nodePort ? ` (node:${p.nodePort})` : ''}`).join(', '),
    },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      // by type: a headless Service is of type ClusterIP and is also counted under Headless
      ClusterIP: list.filter((s) => s.spec.type === 'ClusterIP').length,
      Exposed: list.filter((s) => s.spec.type === 'NodePort' || s.spec.type === 'LoadBalancer').length,
      Headless: list.filter((s) => s.spec.clusterIP === 'None').length,
    }),
  },
  {
    path: '/network/endpoints', api: `/api/v1/namespaces/${NS}/endpoints`, plural: 'endpoints',
    extra: {
      Ready: (o) => String((o.subsets ?? []).reduce((s: number, x: Obj) => s + (x.addresses ?? []).length, 0)),
      'Not Ready': (o) => String((o.subsets ?? []).reduce((s: number, x: Obj) => s + (x.notReadyAddresses ?? []).length, 0)),
    },
    skip: { Addresses: 'the address list; Ready and Not Ready count it', Ports: 'the port list', Age: AGE },
    cards: (list) => {
      const ready = (o: Obj) => (o.subsets ?? []).reduce((s: number, x: Obj) => s + (x.addresses ?? []).length, 0)
      const notReady = (o: Obj) => (o.subsets ?? []).reduce((s: number, x: Obj) => s + (x.notReadyAddresses ?? []).length, 0)
      return {
        Total: list.length,
        'With Ready': list.filter((o) => ready(o) > 0).length,
        'With NotReady': list.filter((o) => notReady(o) > 0).length,
        'Total Addresses': list.reduce((s, o) => s + ready(o) + notReady(o), 0),
      }
    },
  },
  {
    path: '/network/endpointslices', api: `/apis/discovery.k8s.io/v1/namespaces/${NS}/endpointslices`, plural: 'endpointslices',
    extra: {
      Service: (o) => o.metadata.labels?.['kubernetes.io/service-name'] ?? '-',
      Total: (o) => String((o.endpoints ?? []).length),
      Ready: (o) => String((o.endpoints ?? []).filter((e: Obj) => e.conditions?.ready !== false).length),
      'Not Ready': (o) => String((o.endpoints ?? []).filter((e: Obj) => e.conditions?.ready === false).length),
    },
    skip: { Age: AGE },
    cards: (list) => {
      const ready = (o: Obj) => (o.endpoints ?? []).filter((e: Obj) => e.conditions?.ready !== false).length
      const notReady = (o: Obj) => (o.endpoints ?? []).filter((e: Obj) => e.conditions?.ready === false).length
      return {
        Total: list.length,
        'With Ready': list.filter((o) => ready(o) > 0).length,
        'With Not Ready': list.filter((o) => notReady(o) > 0).length,
        'Total Endpoints': list.reduce((s, o) => s + (o.endpoints ?? []).length, 0),
      }
    },
  },
  {
    path: '/network/ingresses', api: `/apis/networking.k8s.io/v1/namespaces/${NS}/ingresses`, plural: 'ingresses',
    extra: { Routes: (o) => (o.spec.rules ?? []).flatMap((r: Obj) => (r.http?.paths ?? []).map((p: Obj) => `${r.host ?? '*'}:${p.path ?? '/'}`)).join(', ') },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      'With Class': list.filter((i) => !!i.spec.ingressClassName).length,
      'With TLS': list.filter((i) => (i.spec.tls ?? []).length > 0).length,
      'With Address': list.filter((i) => (i.status.loadBalancer?.ingress ?? []).length > 0).length,
    }),
  },
  {
    path: '/network/networkpolicies', api: `/apis/networking.k8s.io/v1/namespaces/${NS}/networkpolicies`, plural: 'networkpolicies',
    extra: {
      'Ingress Rules': (o) => String((o.spec.ingress ?? []).length),
      'Egress Rules': (o) => String((o.spec.egress ?? []).length),
    },
    skip: { Types: 'policy types as text', 'Default Deny': 'checked by the cards', Age: AGE },
    cards: (list) => {
      const types = (p: Obj): string[] => p.spec.policyTypes ?? ['Ingress']
      const all = (p: Obj) => Object.keys(p.spec.podSelector?.matchLabels ?? {}).length === 0 && (p.spec.podSelector?.matchExpressions ?? []).length === 0
      return {
        Total: list.length,
        'Default Deny Ingress': list.filter((p) => types(p).includes('Ingress') && (p.spec.ingress ?? []).length === 0).length,
        'Default Deny Egress': list.filter((p) => types(p).includes('Egress') && (p.spec.egress ?? []).length === 0).length,
        'Selects All Pods': list.filter(all).length,
      }
    },
  },
  {
    path: '/storage?tab=pvcs', api: `/api/v1/namespaces/${NS}/persistentvolumeclaims`, plural: 'persistentvolumeclaims',
    extra: { Requested: (o) => o.spec.resources?.requests?.storage ?? '-' },
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      Bound: list.filter((p) => p.status.phase === 'Bound').length,
      Pending: list.filter((p) => p.status.phase === 'Pending').length,
      Lost: list.filter((p) => p.status.phase === 'Lost').length,
    }),
  },
  {
    path: '/configuration/configmaps', api: `/api/v1/namespaces/${NS}/configmaps`, plural: 'configmaps',
    skip: { Age: AGE },
    cards: (list) => ({
      Total: list.length,
      'Total Data Keys': list.reduce((s, c) => s + Object.keys(c.data ?? {}).length + Object.keys(c.binaryData ?? {}).length, 0),
    }),
  },
  {
    path: '/configuration/secrets', api: `/api/v1/namespaces/${NS}/secrets`, plural: 'secrets',
    skip: { Age: AGE },
    cards: (list) => ({ Total: list.length, Opaque: list.filter((s) => s.type === 'Opaque').length }),
  },
  {
    path: '/security/serviceaccounts', api: `/api/v1/namespaces/${NS}/serviceaccounts`, plural: 'serviceaccounts',
    extra: { Secrets: (o) => String((o.secrets ?? []).length) },
    skip: { Age: AGE },
    cards: (list) => ({ Total: list.length, 'With Image Pull Secrets': list.filter((s) => (s.imagePullSecrets ?? []).length > 0).length }),
  },
  {
    path: '/security/roles', api: `/apis/rbac.authorization.k8s.io/v1/namespaces/${NS}/roles`, plural: 'roles',
    extra: { Rules: (o) => String((o.rules ?? []).length) },
    skip: { Age: AGE },
    cards: (list) => ({ Total: list.length, 'Total Rules': list.reduce((s, r) => s + (r.rules ?? []).length, 0) }),
  },
  {
    path: '/security/rolebindings', api: `/apis/rbac.authorization.k8s.io/v1/namespaces/${NS}/rolebindings`, plural: 'rolebindings',
    extra: { Subjects: (o) => String((o.subjects ?? []).length) },
    skip: { 'Role Ref': 'kubectl prints Role as Kind/name; the name is compared through the row', Age: AGE },
    cards: (list) => ({ Total: list.length, 'Total Subjects': list.reduce((s, r) => s + (r.subjects ?? []).length, 0) }),
  },
  {
    path: '/cluster/resourcequotas', api: `/api/v1/namespaces/${NS}/resourcequotas`, plural: 'resourcequotas',
    extra: { Resources: (o) => String(Object.keys(o.status?.hard ?? o.spec.hard ?? {}).length) },
    skip: { Age: AGE },
    cards: (list) => {
      const keys = (q: Obj) => Object.keys(q.status?.hard ?? q.spec.hard ?? {})
      return {
        Total: list.length,
        'With CPU Quota': list.filter((q) => keys(q).some((k) => k === 'cpu' || k === 'requests.cpu' || k === 'limits.cpu')).length,
        'With Memory Quota': list.filter((q) => keys(q).some((k) => k === 'memory' || k === 'requests.memory' || k === 'limits.memory')).length,
      }
    },
  },
  {
    path: '/cluster/limitranges', api: `/api/v1/namespaces/${NS}/limitranges`, plural: 'limitranges',
    skip: { Types: 'limit types as text', Age: AGE },
    cards: (list) => ({
      Total: list.length,
      'Container Limits': list.filter((l) => (l.spec.limits ?? []).some((x: Obj) => x.type === 'Container')).length,
      'Pod Limits': list.filter((l) => (l.spec.limits ?? []).some((x: Obj) => x.type === 'Pod')).length,
    }),
  },
]

type ScreenRead = { heads: string[]; rows: string[][]; cards: Record<string, number> }
async function readScreen(page: Page): Promise<ScreenRead> {
  return page.evaluate(() => {
    const heads = [...document.querySelectorAll('main thead th')].map((th) => (th as HTMLElement).innerText.trim())
    const rows = [...document.querySelectorAll('main tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => (td as HTMLElement).innerText.trim()))
    const cards: Record<string, number> = {}
    // a summary card: a bordered box of two lines, the label and a number
    for (const box of document.querySelectorAll('main div.rounded-lg.border')) {
      const lines = [...box.children] as HTMLElement[]
      if (lines.length === 2 && /^\d+$/.test(lines[1].innerText.trim())) cards[lines[0].innerText.trim()] = Number(lines[1].innerText.trim())
    }
    return { heads, rows, cards }
  })
}

test.describe('number check — list screens', () => {
  test.beforeAll(async () => {
    test.setTimeout(200_000)
    kubectl('apply -f -', FIXTURE)
    // settled: the ready Deployment and the StatefulSet ready, both Jobs finished, the crashing Pod restarted
    const deadline = Date.now() + 150_000
    for (;;) {
      const got = kubectl(`get deploy/num-ready sts/num-db job/num-done job/num-fail pod/num-crash -n ${NS} -o jsonpath='{.items[*].status.readyReplicas} {.items[*].status.succeeded} {.items[*].status.failed} {.items[4].status.containerStatuses[0].restartCount}'`)
      const [deployReady, stsReady, , , restarts] = got.split(/\s+/)
      const jobs = items('jobs')
      const done = jobs.every((j) => cond(j, 'Complete') === 'True' || cond(j, 'Failed') === 'True')
      if (deployReady === '3' && stsReady === '2' && done && Number(restarts) >= 1) break
      if (Date.now() > deadline) throw new Error(`fixture did not settle: ${got}`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  })

  // waits, so a worker started after a failure does not apply into a namespace still being removed
  test.afterAll(() => {
    kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
  })

  test('a Running pod that is not ready reads Running, drawn yellow with its ready count on hover', async ({ page }) => {
    const pods = items('pods').filter((p) => p.metadata.labels?.app === 'num-notready')
    expect(pods.map((p) => p.status.phase)).toEqual(pods.map(() => 'Running'))
    await page.addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
    await page.goto(`/workloads/pods?cluster=self&namespace=${NS}`)
    for (const p of pods) {
      const statuses: Obj[] = p.status.containerStatuses ?? []
      const ready = `${statuses.filter((c) => c.ready).length}/${statuses.length}`
      const badge = page.locator('main tbody tr').filter({ hasText: p.metadata.name }).getByTestId('pod-status-not-ready')
      await expect(badge).toHaveText('Running', { timeout: 20_000 })
      await expect(badge).toHaveClass(/badge-warning/)
      await expect(badge).toHaveAttribute('title', new RegExp(`(Not ready|준비 안 됨) \\(${ready}\\)`))
    }
    // the Pod drawer's Status tile says the same
    const first = pods[0]
    await page.goto(`/workloads/pods?cluster=self&namespace=${NS}&detail=${encodeURIComponent(`Pod/${NS}/${first.metadata.name}`)}`)
    const tile = page.getByTestId('pod-drawer-status-not-ready')
    await expect(tile).toHaveText('Running', { timeout: 20_000 })
    await expect(tile).toHaveClass(/badge-warning/)
  })

  // one test, a step per screen: the fixture is made once and a screen that differs does not stop the others
  test('every list screen shows the rows, columns and cards the cluster has', async ({ page }) => {
    test.setTimeout(600_000)
    await page.addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
    for (const s of SCREENS) await test.step(s.path, async () => {
      await page.goto(`${s.path}${s.path.includes('?') ? '&' : '?'}cluster=self&namespace=${NS}`)
      const table = await apiTable(s.api)
      const want = table.rows.map((r) => r.object.metadata.name).sort()
      // the rows on screen are the cluster's objects (re-read until the list has caught up)
      const names = async () => {
        const { heads, rows } = await readScreen(page)
        const nameAt = heads.findIndex((h) => /^name$/i.test(h))
        return rows.map((r) => r[nameAt]).filter(Boolean).sort()
      }
      try {
        await expect.poll(names, { timeout: 20_000 }).toEqual(want)
      } catch {
        expect.soft(await names(), `${s.path}: names on screen`).toEqual(want)
      }

      // the cluster again, then the screen, so a value that moves (RESTARTS) is read close together
      const fresh = await apiTable(s.api)
      const objects = Object.fromEntries(items(s.plural).map((o) => [o.metadata.name, o]))
      const { heads, rows, cards } = await readScreen(page)
      const nameAt = heads.findIndex((h) => /^name$/i.test(h))
      const tableCols = fresh.columnDefinitions.map((c) => norm(c.name))
      const byName = Object.fromEntries(fresh.rows.map((r) => [r.object.metadata.name, r.cells.map((c) => String(c ?? ''))]))
      const unknown: string[] = []
      for (const row of rows) {
        const name = row[nameAt]
        if (!name || !byName[name]) continue
        heads.forEach((h, i) => {
          if (!h || i === nameAt || s.skip?.[h] !== undefined) return
          const o = objects[name]
          const extra = s.extra?.[h]
          if (extra) {
            expect.soft(row[i], `${s.path} · ${name} · ${h} (from the object)`).toBe(extra(o))
            return
          }
          const j = tableCols.indexOf(norm(s.alias?.[h] ?? h))
          if (j < 0) {
            if (!unknown.includes(h)) unknown.push(h)
            return
          }
          const cluster = s.shape?.[h] ? s.shape[h](byName[name][j], o) : byName[name][j]
          expect.soft(sameValue(row[i], cluster), `${s.path} · ${name} · ${h}: screen "${row[i]}", kubectl "${byName[name][j]}"`).toBe(true)
        })
      }
      expect.soft(unknown, `${s.path}: columns with nothing to compare against`).toEqual([])
      if (s.cards) {
        const expected = s.cards(Object.values(objects))
        for (const [label, value] of Object.entries(expected)) {
          expect.soft(cards[label], `${s.path} · card "${label}" (cards on screen: ${JSON.stringify(cards)})`).toBe(value)
        }
      }
    })
  })
})
