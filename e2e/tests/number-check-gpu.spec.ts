import { execSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// The GPU Dashboard, GPU Nodes and GPU Pods screens' numbers are the cluster's, on test2 with fake GPUs
// (scripts/kind-gpu.sh up: the node advertises nvidia.com/gpu and nvidia.com/mig-1g.5gb with GPU Feature Discovery's
// labels, and a stand-in dcgm-exporter is scraped by a Prometheus in `monitoring`, deploy/kind/gpu-metrics.yaml).
// GPUs in use are kubectl describe node's "Allocated resources" (the pods on a node that have not ended, init
// containers at their peak, sidecars added), pods no node has taken are waiting apart; a pod's Status is kubectl's
// STATUS and a node's too; the real-time numbers are what that Prometheus answers, a pod's GPUs read whether the
// scrape kept the exporter's pod label or renamed it exported_pod. The node drawer's GPU rows, the floating chat's
// numbers, the device plugin badge, MIG none, a cordoned node and a grant limited to namespaces ("-") too. The pods
// live in namespace e2e-gpu-num, made here and removed after; what the spec changes on the node and the exporter is
// put back.

const SCREENS = [
  { path: '/gpu/dashboard', cluster: 'test2' },
  { path: '/gpu/nodes', cluster: 'test2' },
  { path: '/gpu/pods', cluster: 'test2' },
]
const CLUSTER = SCREENS[0].cluster
const NODE = `${CLUSTER}-control-plane`
const NS = 'e2e-gpu-num'
const READ_GROUP = 'kubeast:role:read'
const PLUGIN = { namespace: 'kube-system', name: 'nvidia-device-plugin' } // the last name Kubeast looks for
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'
// the badges and the counts next to a section title, found by what main's page shows too, so a reverse check on its
// build fails on the value and not on a test id it never had
const pluginBadge = (page: Page) => page.getByText(/^Device Plugin /).first()
const migBadge = (page: Page) => page.getByText(/^MIG (Enabled|Disabled)$/).first()
const besideTitle = (page: Page, title: string) => page.locator('h2', { hasText: new RegExp(`^${title}$`) }).locator('xpath=following-sibling::span[1]')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type Table = { columnDefinitions: { name: string }[]; rows: { cells: unknown[]; object: Obj }[] }

// test2's kubectl, and the API server's Table — what `kubectl get` prints — through the kubeconfig's client certificate
const kc = (() => { try { return execSync(`kind get kubeconfig --name ${CLUSTER}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) } catch { return '' } })()
const kcPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-gpu-')), 'kubeconfig')
fs.writeFileSync(kcPath, kc, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()
const pick = (k: string) => (kc.match(new RegExp(`${k}: (\\S+)`)) ?? [])[1] ?? ''
function apiTable(apiPath: string): Promise<Table> {
  const server = new URL(pick('server'))
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
const keyOf = (m: { name: string; namespace?: string }) => (m.namespace ? `${m.namespace}/${m.name}` : m.name)
// the Table's Status cell of each object
async function statusCells(apiPath: string): Promise<Record<string, string>> {
  const t = await apiTable(apiPath)
  const at = t.columnDefinitions.findIndex((c) => c.name === 'Status')
  return Object.fromEntries(t.rows.map((r) => [keyOf(r.object.metadata), String(r.cells[at] ?? '')]))
}

// test2's Prometheus, through the API server's service proxy
type Sample = { metric: Record<string, string>; value: [number, string] }
const promQuery = (q: string): Sample[] =>
  JSON.parse(kubectl(`get --raw '/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1/query?query=${encodeURIComponent(q)}'`)).data.result
const promValue = (q: string) => Number(promQuery(q)[0]?.value[1] ?? NaN)

// ── the cluster as kubectl reads it ───────────────────────────────────────────────────────────────────────────────────

const isGpu = (name: string) => name === 'nvidia.com/gpu' || name.startsWith('nvidia.com/mig-')
const gpusIn = (resources: Record<string, string> | undefined) =>
  Object.entries(resources ?? {}).filter(([k]) => isGpu(k)).reduce((s, [, v]) => s + Number(v), 0)
// a pod's request of one resource as the scheduler counts it (Kubernetes "Sidecar containers", resource sharing): the
// containers and the sidecars summed, or an init container's (with the sidecars started before it) when higher
function podRequest(p: Obj, name: string): number {
  const req = (c: Obj) => Number(c.resources?.requests?.[name] ?? 0)
  let sum = (p.spec.containers ?? []).reduce((s: number, c: Obj) => s + req(c), 0)
  let sidecars = 0
  let initPeak = 0
  for (const c of p.spec.initContainers ?? []) {
    if (c.restartPolicy === 'Always') {
      sum += req(c)
      sidecars += req(c)
      initPeak = Math.max(initPeak, sidecars)
    } else initPeak = Math.max(initPeak, req(c) + sidecars)
  }
  return Math.max(sum, initPeak)
}
function podGpus(p: Obj): number {
  const names = new Set<string>()
  for (const c of [...(p.spec.containers ?? []), ...(p.spec.initContainers ?? [])]) for (const k of Object.keys(c.resources?.requests ?? {})) if (isGpu(k)) names.add(k)
  return [...names].reduce((s, n) => s + podRequest(p, n), 0)
}
// kubectl describe node's "Allocated resources": the GPUs (nvidia.com/gpu and each nvidia.com/mig-*) requested
function allocated(node: string): number {
  const out = kubectl(`describe node ${node}`)
  const section = out.split('Allocated resources:')[1]?.split(/\n\S/)[0] ?? ''
  return [...section.matchAll(/^\s+(nvidia\.com\/(?:gpu|mig-\S+))\s+(\d+)\s+\d+/gm)].reduce((s, m) => s + Number(m[2]), 0)
}
const ended = (p: Obj) => p.status?.phase === 'Succeeded' || p.status?.phase === 'Failed'
const namesError = (s: string) => ['error', 'failed', 'backoff', 'errimagepull', 'oomkilled'].some((w) => s.toLowerCase().includes(w))
const readinessOf = (status: string) => { const first = status.split(',')[0]; return first === 'Ready' || first === 'NotReady' ? first : 'Unknown' }

type Cluster = {
  nodes: { name: string; capacity: number; allocatable: number; used: number; status: string; labels: Record<string, string> }[]
  pods: { key: string; namespace: string; name: string; node: string; gpus: number; status: string; phase: string; created: string; ended: boolean }[]
  used: number
  waiting: number
}
async function cluster(): Promise<Cluster> {
  const nodeStatus = await statusCells('/api/v1/nodes')
  const podStatus = await statusCells('/api/v1/pods')
  const nodeObjs: Obj[] = JSON.parse(kubectl('get nodes -o json')).items
  const podObjs: Obj[] = JSON.parse(kubectl('get pods -A -o json')).items
  const pods = podObjs.filter((p) => podGpus(p) > 0).map((p) => ({
    key: keyOf(p.metadata), namespace: p.metadata.namespace, name: p.metadata.name, node: p.spec.nodeName ?? '', gpus: podGpus(p),
    status: podStatus[keyOf(p.metadata)] ?? '', phase: p.status?.phase ?? '', created: p.metadata.creationTimestamp, ended: ended(p),
  }))
  const byNode: Record<string, number> = Object.fromEntries(nodeObjs.map((n) => [n.metadata.name, allocated(n.metadata.name)]))
  const nodes = nodeObjs.filter((n) => gpusIn(n.status.capacity) > 0).map((n) => ({
    name: n.metadata.name, capacity: gpusIn(n.status.capacity), allocatable: gpusIn(n.status.allocatable), used: byNode[n.metadata.name],
    status: nodeStatus[n.metadata.name], labels: n.metadata.labels ?? {},
  }))
  return {
    nodes, pods,
    // every node's Allocated resources (a pod on a node that no longer advertises GPUs counts there too)
    used: Object.values(byNode).reduce((s, n) => s + n, 0),
    waiting: pods.filter((p) => !p.node && !p.ended).reduce((s, p) => s + p.gpus, 0),
  }
}
// what a screen says and what the cluster says, compared without the spaces and line breaks the layout puts between
const bare = (v: unknown) => JSON.stringify(v).replace(/\\n|\s+/g, '')
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)

// ── fixture ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const SLEEP = ['sleep', '3600']
const box = (name: string, command: string[], gpus?: Record<string, string>, extra: Obj = {}) =>
  ({ name, image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command, ...(gpus ? { resources: { limits: gpus } } : {}), ...extra })
const pod = (name: string, spec: Obj) => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: NS }, spec: { terminationGracePeriodSeconds: 0, ...spec } })
const GPU = (n: number) => ({ 'nvidia.com/gpu': String(n) })
const MIG = (n: number) => ({ 'nvidia.com/mig-1g.5gb': String(n) })
// ended first (each holds a GPU while it runs), then the rest: on the node nvidia.com/gpu 1+2+2+2 = 7 of 8 (gpu-init's
// init container asks 2, its app 1) and nvidia.com/mig-1g.5gb 2 of 4 (a sidecar's and the app's); gpu-waiting fits no
// node; no-gpu asks for none
const ENDED = [
  pod('gpu-done', { restartPolicy: 'Never', containers: [box('app', ['true'], GPU(1))] }),
  pod('gpu-failed', { restartPolicy: 'Never', containers: [box('app', ['sh', '-c', 'exit 1'], GPU(1))] }),
]
const ONE = pod('gpu-one', { containers: [box('app', SLEEP, GPU(1))] })
const RUNNING = [
  ONE,
  pod('gpu-two-cards', { containers: [box('app', SLEEP, GPU(2))] }),
  pod('gpu-two-boxes', { containers: [box('a', SLEEP, GPU(1)), box('b', SLEEP, GPU(1))] }),
  pod('gpu-init', { initContainers: [box('prep', ['true'], GPU(2))], containers: [box('app', SLEEP, GPU(1))] }),
  pod('gpu-sidecar', { initContainers: [box('side', SLEEP, MIG(1), { restartPolicy: 'Always' })], containers: [box('app', SLEEP, MIG(1))] }),
  pod('no-gpu', { containers: [box('app', SLEEP)] }),
]
const WAITING = pod('gpu-waiting', { nodeSelector: { 'e2e-gpu-num': 'no-such-node' }, containers: [box('app', SLEEP, GPU(1))] })
const list = (items: Obj[]) => JSON.stringify({ apiVersion: 'v1', kind: 'List', items })

// DCGM series the stand-in exporter serves: /metrics as dcgm-exporter 4.8.4 writes them (hostname), scraped with the
// pod labels kept; /exported/metrics with the older Hostname, scraped by a target labelled as the exporter's own pod,
// so the pod labels become exported_pod and an idle GPU carries the exporter's pod. A pod on two GPUs, a GPU at 0 °C
// with a pod, idle GPUs on both.
type G = { gpu: number; pod?: string; container?: string; util: number; used: number; free: number; temp: number }
const PLAIN: G[] = [
  { gpu: 0, pod: 'gpu-one', util: 30, used: 20000, free: 60000, temp: 41 },
  { gpu: 1, pod: 'gpu-two-cards', util: 50, used: 40000, free: 40000, temp: 0 },
  { gpu: 2, pod: 'gpu-two-cards', util: 70, used: 60000, free: 20000, temp: 55 },
  { gpu: 3, util: 0, used: 0, free: 80000, temp: 33 },
]
const EXPORTED: G[] = [
  { gpu: 4, pod: 'gpu-two-boxes', container: 'a', util: 90, used: 10000, free: 70000, temp: 60 },
  { gpu: 5, pod: 'gpu-two-boxes', container: 'b', util: 10, used: 30000, free: 50000, temp: 0 },
  { gpu: 6, pod: 'gpu-init', util: 20, used: 5000, free: 75000, temp: 45 },
  { gpu: 7, util: 0, used: 0, free: 80000, temp: 35 },
]
function exposition(gpus: G[], host: 'hostname' | 'Hostname') {
  const labels = (g: G) => [`gpu="${g.gpu}"`, `UUID="GPU-e2e-num-${g.gpu}"`, `pci_bus_id="00000000:${(16 + g.gpu).toString(16).toUpperCase()}:00.0"`,
    `device="nvidia${g.gpu}"`, 'modelName="NVIDIA A100-SXM4-80GB"', `${host}="${NODE}"`,
    ...(g.pod ? [`pod="${g.pod}"`, `namespace="${NS}"`, `container="${g.container ?? 'app'}"`] : [])].join(',')
  const family = (name: string, help: string, v: (g: G) => number) =>
    [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...gpus.map((g) => `${name}{${labels(g)}} ${v(g)}`)].join('\n')
  return [
    family('DCGM_FI_DEV_GPU_UTIL', 'GPU utilization (in %).', (g) => g.util),
    family('DCGM_FI_DEV_FB_USED', 'Framebuffer memory used (in MiB).', (g) => g.used),
    family('DCGM_FI_DEV_FB_FREE', 'Framebuffer memory free (in MiB).', (g) => g.free),
    family('DCGM_FI_DEV_MEMORY_TEMP', 'Memory temperature (in C).', (g) => g.temp),
  ].join('\n') + '\n'
}
const writeMetrics = (file: string, body: string) =>
  kubectl(`-n monitoring exec -i deploy/dcgm-exporter -- sh -c 'cat > ${file}.tmp && mv ${file}.tmp ${file}'`, body)

// the GPU's pod and host as the series name them: exported_* where the scrape renamed it, else the plain label
const coalesce = (expr: string) =>
  ['pod', 'namespace'].reduce((e, l) => `label_replace(label_replace(${e}, "p_${l}", "$1", "${l}", "(.+)"), "p_${l}", "$1", "exported_${l}", "(.+)")`,
    `label_replace(label_replace(${expr}, "p_host", "$1", "Hostname", "(.+)"), "p_host", "$1", "hostname", "(.+)")`)
const ALL_DCGM = '{__name__=~"DCGM_FI_DEV_GPU_UTIL|DCGM_FI_DEV_FB_USED|DCGM_FI_DEV_FB_FREE|DCGM_FI_DEV_MEMORY_TEMP"}'

async function waitFor(what: string, ok: () => boolean | Promise<boolean>, ms = 150_000) {
  const deadline = Date.now() + ms
  for (;;) {
    try { if (await ok()) return } catch { /* not there yet */ }
    if (Date.now() > deadline) throw new Error(`${what} did not happen in ${ms / 1000} s`)
    await new Promise((r) => setTimeout(r, 2000))
  }
}
const podsOf = (): Obj[] => JSON.parse(kubectl(`get pods -n ${NS} -o json`)).items
const settled = () => {
  const by = Object.fromEntries(podsOf().map((p) => [p.metadata.name, p]))
  const ready = (n: string) => by[n]?.status?.conditions?.some((c: Obj) => c.type === 'Ready' && c.status === 'True')
  return RUNNING.every((p) => ready(p.metadata.name)) && by['gpu-done']?.status?.phase === 'Succeeded' && by['gpu-failed']?.status?.phase === 'Failed' &&
    by['gpu-waiting']?.status?.conditions?.some((c: Obj) => c.type === 'PodScheduled' && c.status === 'False')
}

let prepared = ''
const nodeGpus = () => { try { return kubectl(`get node ${NODE} -o jsonpath='{.status.allocatable.nvidia\\.com/gpu}'`) } catch { return '' } }
const exporterThere = () => { try { return kubectl('-n monitoring get deploy dcgm-exporter -o name') !== '' } catch { return false } }

test.describe('number check — GPU Dashboard, GPU Nodes, GPU Pods', () => {
  test.beforeAll(async () => {
    test.setTimeout(400_000)
    if (!kc || !nodeGpus() || !exporterThere()) return
    kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
    kubectl('apply -f -', list([{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } }, ...ENDED]))
    await waitFor('the ended pods', () => podsOf().filter((p) => ended(p)).length === ENDED.length)
    kubectl('apply -f -', list([...RUNNING, WAITING]))
    await waitFor('the GPU pods settled', settled)
    writeMetrics('/www/metrics', exposition(PLAIN, 'hostname'))
    writeMetrics('/www/exported/metrics', exposition(EXPORTED, 'Hostname'))
    // the seed's GPUs gone and the eight here scraped
    await waitFor('the DCGM series in Prometheus', () => promValue(`count(${ALL_DCGM.replace('}', ',UUID=~"GPU-e2e-num-.*"}')})`) === 32 && promValue(`count(${ALL_DCGM})`) === 32, 60_000)
    prepared = 'yes'
  })

  test.afterAll(() => {
    if (!prepared) return
    kubectl(`delete namespace ${NS} --wait=false --ignore-not-found`)
    kubectl("-n monitoring exec deploy/dcgm-exporter -- sh -c 'cp /seed/metrics /www/metrics && cp /seed/exported-metrics /www/exported/metrics'")
  })

  const admin = async (request: APIRequestContext) => {
    const res = await request.post('/api/v1/auth/login', { data: { email: process.env.E2E_USER_EMAIL || 'admin', password: process.env.E2E_USER_PASSWORD || '' } })
    expect(res.ok(), `admin login: ${res.status()}`).toBeTruthy()
    return { Authorization: `Bearer ${(await res.json()).access_token as string}`, 'X-Requested-With': 'XMLHttpRequest' }
  }
  const registeredOn = async (request: APIRequestContext, headers: Record<string, string>) => {
    const body = await (await request.get('/api/v1/clusters', { headers })).json()
    return (Array.isArray(body) ? body : body.items ?? []).find((c: Obj) => c.id === CLUSTER) as Obj | undefined
  }
  // Kubeast reads test2's Prometheus: a discovery made before kind-gpu.sh up found none and is kept ten minutes, so the
  // cluster's Prometheus setting is written back as it is, which drops it (auth-service → k8s-service invalidate)
  async function prepare(page: Page) {
    test.skip(!prepared, `needs fake GPUs on ${CLUSTER} (scripts/kind-gpu.sh up)`)
    const headers = await admin(page.request)
    const reg = await registeredOn(page.request, headers)
    test.skip(!reg, `needs the kind cluster ${CLUSTER}, registered as ${CLUSTER}`)
    const status = async () => (await page.request.get(`/api/v1/cluster/prometheus/status?cluster=${CLUSTER}`, { headers })).json()
    if ((await status()).source !== 'proxy') {
      const res = await page.request.patch(`/api/v1/clusters/${CLUSTER}`, { headers, data: { prometheus_service: reg.prometheus_service ?? '' } })
      expect(res.ok(), await res.text()).toBeTruthy()
    }
    await expect.poll(async () => (await status()).endpoint, { timeout: 30_000, message: `${CLUSTER} reads its Prometheus` })
      .toBe('monitoring/prometheus:9090 (via K8s API proxy)')
    await page.context().addInitScript(() => localStorage.setItem('kubeast.listPageSize', '100'))
    await page.setViewportSize({ width: 2560, height: 1400 })
  }
  const url = (p: string, extra = '') => `${p}?cluster=${CLUSTER}${extra}`

  // a page's summary boxes of two lines (label, number or "-") and its one table, a cell of badges as "a,b"
  async function readPage(page: Page) {
    return page.evaluate(() => {
      const cell = (td: Element) => {
        const badges = [...td.querySelectorAll('.badge')].map((b) => (b.textContent ?? '').trim())
        return badges.length ? badges.join(',') : (td as HTMLElement).innerText.trim()
      }
      const heads = [...document.querySelectorAll('main table thead th')].map((th) => (th as HTMLElement).innerText.trim())
      const rows = [...document.querySelectorAll('main table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map(cell))
        .filter((r) => r.length === heads.length && r.some((c) => c !== ''))
      const cards: Record<string, string> = {}
      for (const b of document.querySelectorAll('main div.rounded-lg.border')) {
        const lines = [...b.children] as HTMLElement[]
        if (lines.length === 2 && /^(\d+|-)$/.test(lines[1].innerText.trim())) cards[lines[0].innerText.trim()] = lines[1].innerText.trim()
      }
      return { heads, rows: rows.map((r) => Object.fromEntries(heads.map((h, i) => [h, r[i]]))), cards }
    })
  }

  // ── GPU Dashboard ─────────────────────────────────────────────────────────────────────────────────────────────────

  async function dashboardDiff(page: Page): Promise<string[]> {
    const c = await cluster()
    const got = await page.evaluate(() => {
      const text = (el: Element | null) => (el as HTMLElement | null)?.innerText.trim() ?? null
      const all = (sel: string) => [...document.querySelectorAll(sel)]
      return {
        cards: Object.fromEntries(all('[data-testid="gpu-summary-card"]').map((c) => [text(c.querySelector('p')), text(c.querySelector('[data-testid="gpu-summary-value"]'))])),
        note: text(document.querySelector('[data-testid="gpu-summary-note"]')),
        readiness: text(document.querySelector('[data-testid="gpu-node-readiness"]')),
        nodes: Object.fromEntries(all('[data-testid="gpu-node-allocation"]').map((n) => [n.getAttribute('data-node'), {
          value: text(n.querySelector('[data-testid="gpu-node-allocation-value"]')),
          status: [...n.querySelectorAll('.badge')].map((b) => (b.textContent ?? '').trim()).join(','),
        }])),
        models: all('[data-testid="gpu-model-row"]').map((r) => [...r.querySelectorAll('span')].slice(0, 2).map((s) => text(s))),
        podTotal: text(document.querySelector('[data-testid="gpu-pod-status-total"]')),
        statuses: all('[data-testid="gpu-pod-status-row"]').map((r) => [text(r.querySelector('.badge')), text(r.querySelector('span:last-child'))]),
        recent: all('[data-testid="gpu-recent-pods"] tbody tr').map((tr) => [...tr.querySelectorAll('td')].map((td) => text(td))),
      }
    })
    const cap = c.nodes.reduce((s, n) => s + n.capacity, 0)
    const alloc = c.nodes.reduce((s, n) => s + n.allocatable, 0)
    const ready = c.nodes.filter((n) => readinessOf(n.status) === 'Ready').length
    const models = new Map<string, number>()
    for (const n of c.nodes) models.set(n.labels['nvidia.com/gpu.product'] ?? 'Unknown', (models.get(n.labels['nvidia.com/gpu.product'] ?? 'Unknown') ?? 0) + n.capacity)
    const statuses = new Map<string, number>()
    for (const p of c.pods) statuses.set(p.status, (statuses.get(p.status) ?? 0) + 1)
    const want = {
      cards: { 'Total Capacity': String(cap), Allocatable: String(alloc), 'In Use': String(c.used), 'Allocation Rate': `${pct(c.used, alloc)}%` },
      note: c.waiting > 0 ? `+${c.waiting} requested by pods waiting for a node` : null,
      readiness: `${ready} Ready${c.nodes.length - ready > 0 ? ` / ${c.nodes.length - ready} Not Ready` : ''}`,
      nodes: Object.fromEntries(c.nodes.map((n) => [n.name, { value: `${n.used}/${n.allocatable}(${pct(n.used, n.allocatable)}%)`, status: n.status }])),
      models: [...models].map(([m, n]) => [m, `${n} GPU (${pct(n, cap)}%)`]).sort(),
      podTotal: String(c.pods.length),
      statuses: [...statuses].map(([s, n]) => [s, `${n} (${pct(n, c.pods.length)}%)`]).sort(),
    }
    const diffs: string[] = []
    const same = (what: string, a: unknown, b: unknown) => {
      if (bare(a) !== bare(b)) diffs.push(`${what}: screen ${JSON.stringify(a)}, cluster ${JSON.stringify(b)}`)
    }
    same('cards', got.cards, want.cards)
    same('waiting', got.note, want.note)
    same('readiness', got.readiness, want.readiness)
    same('node bars', got.nodes, want.nodes)
    same('models', [...got.models].sort(), want.models)
    same('pod status total', got.podTotal, want.podTotal)
    same('pod statuses', [...got.statuses].sort(), want.statuses)
    // the newest five: each row is a GPU pod as kubectl has it, none older than the fifth newest
    const newest = [...c.pods].sort((a, b) => b.created.localeCompare(a.created))
    const fifth = newest[Math.min(4, newest.length - 1)]?.created ?? ''
    same('recent count', got.recent.length, Math.min(5, c.pods.length))
    for (const r of got.recent) {
      const p = c.pods.find((x) => x.namespace === r[0] && x.name === r[1])
      if (!p) diffs.push(`recent ${r[0]}/${r[1]}: not a GPU pod`)
      else {
        same(`recent ${p.key}`, r.slice(2, 5), [p.node || '-', String(p.gpus), p.status])
        if (p.created < fifth) diffs.push(`recent ${p.key}: older than the fifth newest`)
      }
    }
    return diffs
  }

  test('GPU Dashboard: the cards, node bars, models, pod statuses and newest pods are kubectl\'s, and follow it', async ({ page }) => {
    test.setTimeout(240_000)
    await prepare(page)
    await page.goto(url('/gpu/dashboard'))
    await expect.poll(() => dashboardDiff(page), { timeout: 60_000, message: 'GPU Dashboard' }).toEqual([])
    // the fixture's own numbers, so a cluster that lost them fails here and not by agreeing on nothing
    const c = await cluster()
    expect({ used: c.used, waiting: c.waiting, onNode: c.nodes.find((n) => n.name === NODE)?.used }, 'describe node and the waiting pod').toEqual({ used: 9, waiting: 1, onNode: 9 })
    await expect(migBadge(page)).toHaveText('MIG Enabled')
    await expect(page.getByTestId('gpu-badge-timeslicing')).toHaveText('Time-Slicing Disabled')

    // a pod gone: Refresh reads the cluster again
    kubectl(`delete pod gpu-one -n ${NS} --wait=true`)
    await page.getByRole('button', { name: /^(Refresh|새로고침)$/ }).first().click()
    await expect.poll(() => dashboardDiff(page), { timeout: 60_000, message: 'GPU Dashboard after a pod was deleted' }).toEqual([])
    expect((await cluster()).used, 'one GPU fewer').toBe(8)
    kubectl('apply -f -', list([ONE]))
    await waitFor('gpu-one back', settled)
  })

  test('GPU Dashboard: the device plugin badge says not found, not ready and healthy apart', async ({ page }) => {
    test.setTimeout(180_000)
    await prepare(page)
    const badge = pluginBadge(page)
    const ds = JSON.stringify({
      apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: PLUGIN.name, namespace: PLUGIN.namespace },
      spec: {
        selector: { matchLabels: { app: 'e2e-gpu-num-plugin' } },
        template: {
          metadata: { labels: { app: 'e2e-gpu-num-plugin' } },
          spec: { terminationGracePeriodSeconds: 0, containers: [box('plugin', SLEEP, undefined, { readinessProbe: { exec: { command: ['test', '-f', '/tmp/ready'] }, periodSeconds: 2 } })] },
        },
      },
    })
    const dsStatus = () => JSON.parse(kubectl(`-n ${PLUGIN.namespace} get ds ${PLUGIN.name} -o json`)).status
    let made = false
    try {
      test.skip(kubectl(`-n ${PLUGIN.namespace} get ds ${PLUGIN.name} --ignore-not-found -o name`) !== '', `${PLUGIN.namespace}/${PLUGIN.name} is there already`)
      await page.goto(url('/gpu/dashboard'))
      await expect(badge, 'no DaemonSet of the names Kubeast looks for').toHaveText('Device Plugin Not Found', { timeout: 30_000 })
      await expect(page.getByTestId('gpu-plugin-detail')).toHaveCount(0)

      kubectl('apply -f -', ds)
      made = true
      await waitFor('the plugin pod scheduled, not ready', () => { const s = dsStatus(); return s.desiredNumberScheduled === 1 && s.numberReady === 0 }, 60_000)
      await expect(async () => {
        await page.reload()
        await expect(badge).toHaveText('Device Plugin Unhealthy', { timeout: 5_000 })
        await expect(page.getByTestId('gpu-plugin-detail')).toHaveText(new RegExp(`^Plugin: ${dsStatus().numberReady}/${dsStatus().desiredNumberScheduled} ready$`, 'i'), { timeout: 5_000 })
      }).toPass({ timeout: 60_000 })

      // scheduled is not started: exec needs the container running
      await waitFor('the plugin container running', () => kubectl(`-n ${PLUGIN.namespace} get pods -l app=e2e-gpu-num-plugin -o jsonpath={.items[0].status.containerStatuses[0].state.running.startedAt}`) !== '', 60_000)
      kubectl(`-n ${PLUGIN.namespace} exec ds/${PLUGIN.name} -- touch /tmp/ready`)
      await waitFor('the plugin pod ready', () => dsStatus().numberReady === 1, 60_000)
      await expect(async () => {
        await page.reload()
        await expect(badge).toHaveText('Device Plugin Healthy', { timeout: 5_000 })
        await expect(page.getByTestId('gpu-plugin-detail')).toHaveText(/^Plugin: 1\/1 ready$/i, { timeout: 5_000 })
      }).toPass({ timeout: 60_000 })
    } finally {
      if (made) kubectl(`-n ${PLUGIN.namespace} delete ds ${PLUGIN.name} --ignore-not-found --wait=true`)
    }
  })

  test('MIG none is MIG off, and a cordoned node is Ready,SchedulingDisabled and counted ready', async ({ page }) => {
    test.setTimeout(180_000)
    await prepare(page)
    try {
      kubectl(`label node ${NODE} --overwrite nvidia.com/mig.strategy=none`)
      kubectl(`cordon ${NODE}`)
      expect((await statusCells('/api/v1/nodes'))[NODE], 'kubectl get nodes').toBe('Ready,SchedulingDisabled')
      await expect(async () => {
        await page.goto(url('/gpu/dashboard'))
        await expect(migBadge(page)).toHaveText('MIG Disabled', { timeout: 5_000 })
        expect(await dashboardDiff(page)).toEqual([])
      }).toPass({ timeout: 60_000 })
      await page.goto(url('/gpu/nodes'))
      await expect.poll(async () => {
        const { rows, cards } = await readPage(page)
        const row = rows.find((r) => r.Name === NODE)
        return { status: row?.Status, mig: row?.['MIG Strategy'], ready: cards.Ready, notReady: cards['Not Ready'] }
      }, { timeout: 30_000 }).toEqual({ status: 'Ready,SchedulingDisabled', mig: 'none', ready: '1', notReady: '0' })
    } finally {
      kubectl(`uncordon ${NODE}`)
      kubectl(`label node ${NODE} --overwrite nvidia.com/mig.strategy=mixed`)
    }
  })

  // ── GPU Nodes ─────────────────────────────────────────────────────────────────────────────────────────────────────

  test('GPU Nodes: the cards, rows, models and real-time GPUs are the cluster\'s and Prometheus\'s', async ({ page }) => {
    test.setTimeout(180_000)
    await prepare(page)
    await page.goto(url('/gpu/nodes'))
    const label = (n: Cluster['nodes'][number], k: string) => n.labels[`nvidia.com/${k}`] ?? '-'
    const want = async () => {
      const c = await cluster()
      const ready = c.nodes.filter((n) => readinessOf(n.status) === 'Ready').length
      return {
        cards: { 'Total Nodes': String(c.nodes.length), Ready: String(ready), 'Not Ready': String(c.nodes.length - ready),
          'GPU Capacity': String(c.nodes.reduce((s, n) => s + n.capacity, 0)), Allocatable: String(c.nodes.reduce((s, n) => s + n.allocatable, 0)), 'In Use': String(c.used) },
        rows: c.nodes.map((n) => [n.name, label(n, 'gpu.product'), label(n, 'gpu.memory'), String(n.capacity), String(n.allocatable), n.status, label(n, 'mig.strategy')]).sort(),
      }
    }
    const got = async () => {
      const { rows, cards } = await readPage(page)
      return { cards, rows: rows.map((r) => [r.Name, r['GPU Model'], r['GPU Memory'], r.Capacity, r.Allocatable, r.Status, r['MIG Strategy']]).sort() }
    }
    // the same moment: polled until both say the same, then the last reading compared so a failure shows both
    let last: { got: unknown; want: unknown } = { got: null, want: null }
    await expect.poll(async () => {
      last = { got: await got(), want: await want() }
      return bare(last.got) === bare(last.want)
    }, { timeout: 60_000, message: 'GPU Nodes cards and rows' }).toBe(true).catch(() => undefined)
    expect(last.got, 'GPU Nodes: cards and rows').toEqual(last.want)
    expect((await cluster()).nodes.find((n) => n.name === NODE), 'the fake GPUs of kind-gpu.sh').toMatchObject({ capacity: 12, allocatable: 12 })

    // Metrics: each model's nodes, capacity, allocatable and GPUs in use; each host's GPUs as Prometheus answers
    await page.getByRole('button', { name: /^(Metrics|메트릭)/ }).click()
    const c = await cluster()
    const models = new Map<string, { n: number; cap: number; alloc: number; used: number }>()
    for (const n of c.nodes) {
      const m = n.labels['nvidia.com/gpu.product'] ?? 'Unknown'
      const e = models.get(m) ?? { n: 0, cap: 0, alloc: 0, used: 0 }
      models.set(m, { n: e.n + 1, cap: e.cap + n.capacity, alloc: e.alloc + n.allocatable, used: e.used + n.used })
    }
    const readModels = () => page.locator('[data-testid="gpu-nodes-model"]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-model'),
      ...[...e.querySelectorAll('span')].map((s) => (s as HTMLElement).innerText.trim())]))
    await expect.poll(readModels, { timeout: 20_000, message: 'model cards' }).toEqual([...models].map(([m, e]) => [m, m, `${e.n} node${e.n === 1 ? '' : 's'}`,
      'Capacity', String(e.cap), 'Allocatable', String(e.alloc), 'In Use', `${e.used} (${pct(e.used, e.alloc)}%)`]))

    const perGpu = Object.fromEntries(promQuery('DCGM_FI_DEV_GPU_UTIL').map((s) => [s.metric.UUID, Number(s.value[1])]))
    const memPct = Object.fromEntries(promQuery('DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100').map((s) => [s.metric.UUID, Number(s.value[1])]))
    const hosts = promQuery(`count by (p_host) (${coalesce('DCGM_FI_DEV_GPU_UTIL')})`).map((s) => s.metric.p_host)
    const avgCore = Object.fromEntries(promQuery(`avg by (p_host) (${coalesce('DCGM_FI_DEV_GPU_UTIL')})`).map((s) => [s.metric.p_host, Math.round(Number(s.value[1]))]))
    const avgMem = Object.fromEntries(promQuery(`avg by (p_host) (${coalesce('DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100')})`).map((s) => [s.metric.p_host, Math.round(Number(s.value[1]))]))
    expect(hosts, 'hostname and Hostname name one host').toEqual([NODE])
    const readHosts = () => page.locator('[data-testid="gpu-nodes-host"]').evaluateAll((els) => Object.fromEntries(els.map((h) => [h.getAttribute('data-host'), {
      gpus: Object.fromEntries([...h.querySelectorAll('[data-testid="gpu-nodes-gpu"]')].map((g) => [g.getAttribute('data-uuid'),
        [g.querySelector('[data-testid="gpu-nodes-core"]')?.textContent, g.querySelector('[data-testid="gpu-nodes-mem"]')?.textContent]])),
      avg: [h.querySelector('[data-testid="gpu-nodes-avg-core"]')?.textContent, h.querySelector('[data-testid="gpu-nodes-avg-mem"]')?.textContent],
    }])))
    await expect.poll(readHosts, { timeout: 45_000, message: 'real-time GPUs by host' }).toEqual(Object.fromEntries(hosts.map((h) => [h, {
      gpus: Object.fromEntries(Object.entries(perGpu).map(([u, v]) => [u, [`${Math.round(v)}%`, `${Math.round(memPct[u])}%`]])),
      avg: [`Avg Core: ${avgCore[h]}%`, `Avg Mem: ${avgMem[h]}%`],
    }])))
  })

  // ── GPU Pods ──────────────────────────────────────────────────────────────────────────────────────────────────────

  test('GPU Pods: the cards, rows with each pod\'s GPUs from Prometheus, and the charts are the cluster\'s', async ({ page }) => {
    test.setTimeout(180_000)
    await prepare(page)
    // each pod's GPUs: the utilization their mean, the memory the used of their total — the pod as exported_pod or pod
    const util = Object.fromEntries(promQuery(`avg by (p_namespace, p_pod) (${coalesce('DCGM_FI_DEV_GPU_UTIL')})`)
      .map((s) => [`${s.metric.p_namespace}/${s.metric.p_pod}`, `${Math.round(Number(s.value[1]))}%`]))
    const used = `sum by (p_namespace, p_pod) (${coalesce('DCGM_FI_DEV_FB_USED')})`
    const mem = Object.fromEntries(promQuery(`${used} / (${used} + sum by (p_namespace, p_pod) (${coalesce('DCGM_FI_DEV_FB_FREE')})) * 100`)
      .map((s) => [`${s.metric.p_namespace}/${s.metric.p_pod}`, `${Math.round(Number(s.value[1]))}%`]))
    expect(Object.keys(util).filter((k) => k.startsWith(`${NS}/`)).sort(), 'pods named by pod and by exported_pod').toEqual([`${NS}/gpu-init`, `${NS}/gpu-one`, `${NS}/gpu-two-boxes`, `${NS}/gpu-two-cards`])

    await page.goto(url('/gpu/pods'))
    const want = async () => {
      const c = await cluster()
      return {
        cards: {
          'Total Pods': String(c.pods.length), Running: String(c.pods.filter((p) => p.phase === 'Running').length),
          Pending: String(c.pods.filter((p) => p.phase === 'Pending').length),
          Failed: String(c.pods.filter((p) => p.phase === 'Failed' || namesError(p.status)).length),
          'GPUs Requested': String(c.used + c.waiting), Namespaces: String(new Set(c.pods.map((p) => p.namespace)).size),
        },
        rows: c.pods.map((p) => [p.namespace, p.name, p.node || '-', String(p.gpus), p.status, util[p.key] ?? '-', mem[p.key] ?? '-']).sort(),
      }
    }
    const got = async () => {
      const { rows, cards } = await readPage(page)
      return { cards, rows: rows.map((r) => [r.Namespace, r.Name, r.Node, r.GPUs, r.Status, r['GPU Utilization'], r['Memory Utilization']]).sort() }
    }
    let last: { got: unknown; want: unknown } = { got: null, want: null }
    await expect.poll(async () => {
      last = { got: await got(), want: await want() }
      return bare(last.got) === bare(last.want)
    }, { timeout: 60_000, message: 'GPU Pods' }).toBe(true).catch(() => undefined)
    expect(last.got, 'GPU Pods: cards and rows').toEqual(last.want)
    expect((last.want as Obj).rows.find((r: string[]) => r[1] === 'gpu-waiting'), 'the pod no node fits').toEqual([NS, 'gpu-waiting', '-', '1', 'Pending', '-', '-'])

    // Metrics: GPUs and pods by node (the pods no node has taken as one row), the statuses kubectl prints
    await page.getByRole('button', { name: /^(Metrics|메트릭)/ }).click()
    const c = await cluster()
    const byNode = new Map<string, { pods: number; gpus: number }>()
    for (const p of c.pods) { const e = byNode.get(p.node) ?? { pods: 0, gpus: 0 }; byNode.set(p.node, { pods: e.pods + 1, gpus: e.gpus + p.gpus }) }
    const statuses = new Map<string, number>()
    for (const p of c.pods) statuses.set(p.status, (statuses.get(p.status) ?? 0) + 1)
    const charts = () => page.evaluate(() => ({
      nodes: [...document.querySelectorAll('[data-testid="gpu-pods-node-usage"]')].map((r) => [r.getAttribute('data-node'), (r as HTMLElement).innerText.replace(/\s+/g, '')]).sort(),
      statuses: [...document.querySelectorAll('[data-testid="gpu-pods-status-row"]')].map((r) => (r as HTMLElement).innerText.replace(/\s+/g, '')).sort(),
    }))
    await expect.poll(charts, { timeout: 20_000, message: 'GPU Pods charts' }).toEqual({
      nodes: [...byNode].sort((a, b) => b[1].gpus - a[1].gpus).slice(0, 4)
        .map(([n, e]) => [n, `${n || 'Notscheduled'}${e.pods}pod${e.pods === 1 ? '' : 's'}${e.gpus}GPU${e.gpus === 1 ? '' : 's'}`]).sort(),
      statuses: [...statuses].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, n]) => `${s}${n}(${pct(n, c.pods.length)}%)`).sort(),
    })
  })

  // ── real-time metrics on the dashboard ───────────────────────────────────────────────────────────────────────────

  test('GPU Dashboard: the real-time GPU numbers are what Prometheus answers, a GPU\'s pod named only when it asks for GPUs', async ({ page }) => {
    test.setTimeout(150_000)
    await prepare(page)
    const q = (expr: string) => promValue(expr)
    const usedMiB = q('sum(DCGM_FI_DEV_FB_USED)')
    const totalMiB = usedMiB + q('sum(DCGM_FI_DEV_FB_FREE)')
    const c = await cluster()
    const gpuPods = new Set(c.pods.map((p) => p.key))
    const series = promQuery(coalesce('DCGM_FI_DEV_GPU_UTIL'))
    const temps = Object.fromEntries(promQuery('DCGM_FI_DEV_MEMORY_TEMP').map((s) => [s.metric.UUID, Number(s.value[1])]))
    const memPct = Object.fromEntries(promQuery('DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE) * 100').map((s) => [s.metric.UUID, Number(s.value[1])]))
    const want = {
      detected: `${q(`count(count by (UUID) (${ALL_DCGM}))`)} GPUs detected`,
      count: String(q(`count(count by (UUID) (${ALL_DCGM}))`)),
      avgUtil: `${Math.round(q('avg(DCGM_FI_DEV_GPU_UTIL)'))}%`,
      avgMem: `${Math.round((usedMiB / totalMiB) * 100)}%`,
      memUsed: `${(usedMiB / 1024).toFixed(1)} GiB`,
      memTotal: `/ ${(totalMiB / 1024).toFixed(1)} GiB`,
      gpus: Object.fromEntries(series.map((s) => {
        const key = `${s.metric.p_namespace}/${s.metric.p_pod}`
        const t = temps[s.metric.UUID]
        return [s.metric.UUID, {
          host: s.metric.p_host, core: `${Math.round(Number(s.value[1]))}%`, mem: `${Math.round(memPct[s.metric.UUID])}%`,
          temp: t > 0 ? `Temp: ${t}°C` : null, pod: s.metric.p_pod && gpuPods.has(key) ? `Pod: ${key}` : null,
        }]
      })),
    }
    // the fixture's edges: a GPU at 0 °C still names its pod; an idle GPU scraped as the exporter's pod names none
    expect(want.gpus['GPU-e2e-num-1'], 'GPU 1').toMatchObject({ temp: null, pod: `Pod: ${NS}/gpu-two-cards` })
    expect(want.gpus['GPU-e2e-num-7'], 'GPU 7').toMatchObject({ pod: null })
    await page.goto(url('/gpu/dashboard'))
    await expect.poll(() => page.evaluate(() => {
      const text = (sel: string, root: ParentNode = document) => (root.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? null
      return {
        detected: text('[data-testid="gpu-realtime-detected"]'),
        count: text('[data-testid="gpu-realtime-count"]'),
        avgUtil: text('[data-testid="gpu-realtime-avg-util"]'),
        avgMem: text('[data-testid="gpu-realtime-avg-mem"]'),
        memUsed: text('[data-testid="gpu-realtime-mem-used"]'),
        memTotal: text('[data-testid="gpu-realtime-mem-total"]'),
        gpus: Object.fromEntries([...document.querySelectorAll('[data-testid="gpu-realtime-gpu"]')].map((g) => [g.getAttribute('data-uuid'), {
          host: g.closest('[data-testid="gpu-realtime-host"]')?.getAttribute('data-host'),
          core: text('[data-testid="gpu-realtime-core"]', g), mem: text('[data-testid="gpu-realtime-mem"]', g),
          temp: text('[data-testid="gpu-realtime-temp"]', g), pod: text('[data-testid="gpu-realtime-pod"]', g),
        }])),
      }
    }), { timeout: 45_000, message: 'real-time GPU metrics' }).toEqual(want)
  })

  // ── the node drawer ───────────────────────────────────────────────────────────────────────────────────────────────

  test('the Node drawer\'s GPU rows are the node\'s labels and GPUs: the driver is cuda.driver, CUDA cuda.runtime', async ({ page }) => {
    await prepare(page)
    const n = JSON.parse(kubectl(`get node ${NODE} -o json`))
    const l = n.metadata.labels
    const want: [string, string][] = [
      ['GPU Product', l['nvidia.com/gpu.product']],
      ['GPU Memory', l['nvidia.com/gpu.memory']],
      ['GPU Count (Capacity)', String(gpusIn(n.status.capacity))],
      ['GPU Count (Allocatable)', String(gpusIn(n.status.allocatable))],
      ['MIG Strategy', l['nvidia.com/mig.strategy']],
      ['CUDA Version', l['nvidia.com/cuda.runtime-version.full']],
      ['Driver Version', l['nvidia.com/cuda.driver-version.full']],
      ['GPU Family', l['nvidia.com/gpu.family']],
      ['GPU Compute Capability', `${l['nvidia.com/gpu.compute.major']}.${l['nvidia.com/gpu.compute.minor']}`],
    ]
    expect(want.slice(4, 7), 'the labels kind-gpu.sh writes').toEqual([['MIG Strategy', 'mixed'], ['CUDA Version', '13.0'], ['Driver Version', '580.95.05']])
    await page.goto(url('/gpu/nodes', `&detail=${encodeURIComponent(`Node/${NODE}`)}`))
    await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
    await expect.poll(() => page.locator(DRAWER).last().evaluate((root) => {
      for (const p of root.querySelectorAll('div.rounded-lg.border > div.flex > p.text-xs')) {
        if ((p as HTMLElement).innerText.trim() !== 'GPU Info') continue
        return [...p.parentElement!.parentElement!.querySelectorAll('div.grid')].map((g) => [...g.children].map((s) => (s as HTMLElement).innerText.trim()))
      }
      return null
    }), { timeout: 20_000, message: 'GPU Info' }).toEqual(want)
  })

  // ── the floating chat and the answers stood in ────────────────────────────────────────────────────────────────────

  // the dashboard answer with nodes of every status kubectl prints (two ready), or with no GPU at all
  const NODE_STATUSES = ['Ready', 'Ready,SchedulingDisabled', 'NotReady', 'NotReady,SchedulingDisabled', 'Unknown']
  async function standIn(page: Page, change: (real: Obj) => Obj) {
    await page.route(/\/api\/v1\/cluster\/gpu\/dashboard(\?|$)/, async (route) => route.fulfill({ json: change(await (await route.fetch()).json()) }))
  }
  const everyStatus = (real: Obj) => ({ ...real, gpu_nodes: NODE_STATUSES.map((status, i) => ({ ...real.gpu_nodes[0], name: i ? `e2e-gpu-node-${i}` : real.gpu_nodes[0].name, status })) })

  test('the floating chat is told each screen\'s numbers, a node ready as kubectl prints it', async ({ page }) => {
    test.setTimeout(180_000)
    await prepare(page)
    await standIn(page, everyStatus)
    const sent: { base?: { data?: Obj } | null }[] = []
    await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ json: { id: 'e2e-gpu-ctx-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
        : route.fallback())
    await page.route(/\/api\/v1\/sessions\/e2e-gpu-ctx-\d+(\?|$)/, (route) =>
      route.fulfill({ json: { id: 'e2e-gpu-ctx-1', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }))
    await page.route(/\/api\/v1\/ai\/sessions\/e2e-gpu-ctx-\d+\/floating-chat/, (route) => {
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
    const c = await cluster()
    const cap = c.nodes.reduce((s, n) => s + n.capacity, 0) // the stand-in's nodes are copies of the real one
    const alloc = c.nodes.reduce((s, n) => s + n.allocatable, 0)

    await page.goto(url('/gpu/dashboard'))
    await expect(besideTitle(page, 'GPU Allocation by Node')).toHaveText('2 Ready / 3 Not Ready', { timeout: 30_000 })
    await expect.poll(async () => {
      const data = await ask()
      return { gpu: data?.cluster_gpu, notReady: (data?.interpretations ?? []).find((s: string) => s.includes('NotReady GPU')) }
    }, { timeout: 30_000 }).toMatchObject({
      gpu: { total_capacity: cap, total_allocatable: alloc, total_used: c.used, total_waiting: c.waiting, allocation_rate: pct(c.used, alloc), ready_nodes: 2 },
      notReady: expect.stringContaining('NotReady GPU 노드 3개'),
    })

    await page.goto(url('/gpu/nodes'))
    await expect.poll(async () => (await readPage(page)).cards, { timeout: 30_000 }).toMatchObject({ 'Total Nodes': '5', Ready: '2', 'Not Ready': '3' })
    await expect.poll(async () => (await ask())?.stats, { timeout: 30_000 }).toMatchObject({ total: 5, ready: 2, not_ready: 3, total_used: c.used })

    await page.goto(url('/gpu/pods'))
    await expect.poll(async () => (await ask())?.stats, { timeout: 30_000 }).toEqual({
      total: c.pods.length, total_gpu_requested: c.used + c.waiting, not_running: c.pods.filter((p) => p.phase !== 'Running').length,
    })
  })

  test('GPU Dashboard: no GPU on any node but pods asking for one shows the pods; nothing at all says so', async ({ page }) => {
    await prepare(page)
    const c = await cluster()
    await standIn(page, (real) => ({ ...real, total_gpu_capacity: 0, total_gpu_allocatable: 0, total_gpu_used: 0, gpu_nodes: [] }))
    await page.goto(url('/gpu/dashboard'))
    // the pods asking for GPUs are shown, not the page that says the cluster has none (once the page has drawn one)
    const none = page.getByText('No GPU resources detected in this cluster.')
    await none.or(page.locator('h2', { hasText: /^Pod Status$/ })).first().waitFor({ timeout: 15_000 })
    await expect(none).toHaveCount(0)
    await expect(besideTitle(page, 'Pod Status')).toHaveText(String(c.pods.length), { timeout: 30_000 })

    await page.unroute(/\/api\/v1\/cluster\/gpu\/dashboard(\?|$)/)
    await standIn(page, (real) => ({ ...real, total_gpu_capacity: 0, total_gpu_allocatable: 0, total_gpu_used: 0, total_gpu_waiting: 0, gpu_nodes: [], gpu_pods: [] }))
    await page.goto(url('/gpu/dashboard'))
    await expect(page.getByText('No GPU resources detected in this cluster.')).toHaveCount(1, { timeout: 30_000 })
  })

  // ── a grant limited to namespaces ─────────────────────────────────────────────────────────────────────────────────

  test('a grant limited to namespaces reads "-" on the GPU cards and is told why', async ({ page, browser, request }) => {
    test.setTimeout(150_000)
    await prepare(page)
    const headers = await admin(request)
    const id = Date.now().toString(36)
    const email = `e2e-gpu-scoped-${id}@kubeast.local`
    const password = `gpu-${id}-pw`
    const created = await request.post('/api/v1/auth/admin/users', { headers, data: { name: `E2E gpu ${id}`, email, password } })
    expect(created.status(), await created.text()).toBe(201)
    const userId = (await created.json()).id
    const binding = JSON.stringify({
      apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name: 'e2e-gpu-num-read', namespace: NS },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'view' },
      subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: READ_GROUP }],
    })
    const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080', viewport: { width: 2560, height: 1200 } })
    try {
      kubectl('apply -f -', binding)
      const put = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers, data: { role: 'Read', namespaces: [NS] } })
      expect(put.ok(), await put.text()).toBeTruthy()
      // the identity Kubeast acts as for the user may not list nodes, nor pods outside its namespace
      const as = `--as=${email} --as-group=kubeast:authenticated --as-group=${READ_GROUP}`
      const canI = (args: string) => { try { return kubectl(`auth can-i ${args} ${as}`) } catch (e) { return String((e as { stdout?: string }).stdout ?? '').trim() } }
      expect([canI('list nodes'), canI('list pods -A'), canI(`list pods -n ${NS}`)], 'nodes, every pod, its namespace\'s pods').toEqual(['no', 'no', 'yes'])

      const user = await ctx.newPage()
      await user.goto('/login')
      await user.locator('input[autocomplete="email"]').first().fill(email)
      await user.locator('input[type="password"]').first().fill(password)
      await user.locator('button[type="submit"]').first().click()
      await user.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
      await user.goto(url('/gpu/dashboard'))
      await expect(user.getByTestId('gpu-dashboard-forbidden')).toContainText(/permission/i, { timeout: 30_000 })
      for (const [p, labels] of [['/gpu/nodes', ['Total Nodes', 'Ready', 'Not Ready', 'GPU Capacity', 'Allocatable', 'In Use']],
        ['/gpu/pods', ['Total Pods', 'Running', 'Pending', 'Failed', 'GPUs Requested', 'Namespaces']]] as const) {
        await user.goto(url(p))
        await expect(user.getByTestId('table-forbidden'), `${p}: the table says why`).toHaveText(/permission/i, { timeout: 30_000 })
        await expect.poll(async () => (await readPage(user)).cards, { message: `${p}: cards` }).toEqual(Object.fromEntries(labels.map((l) => [l, '-'])))
      }
    } finally {
      await ctx.close()
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers })
      kubectl(`delete rolebinding e2e-gpu-num-read -n ${NS} --ignore-not-found`)
    }
  })
})
