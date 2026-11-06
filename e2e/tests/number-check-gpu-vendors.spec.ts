import { execSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// AMD's and Intel's GPUs on the GPU Dashboard, GPU Nodes, GPU Pods, the Node drawer and in the floating chat, counted
// by the rules NVIDIA's are (number-check-gpu.spec.ts): the GPU resources of the three companies Kubernetes' "Schedule
// GPUs" names — nvidia.com/gpu and nvidia.com/mig-*, amd.com/gpu and AMD's partitions, gpu.intel.com/i915 and
// gpu.intel.com/xe — and no other name (Intel's millicores, memory.max, tiles and monitoring resources are not
// devices). On test2 next to the NVIDIA GPUs of scripts/kind-gpu.sh up, this spec makes two Node objects without a
// kubelet (Kubernetes keeps a Node object until someone deletes it; kind has no cloud provider to delete it), one
// with AMD's GPUs and node labeller labels, one with Intel's (and the older Intel plugin's non-device resources) and
// NFD labels, a NoSchedule taint of its own and no kubernetes.io/os label so no DaemonSet places a pod there. Their
// pods are bound by spec.nodeName and stay Pending — kubectl describe node counts them, as it counts any pod on a node
// that has not ended — and tolerate every taint, so the node controller's NotReady taints evict none. Namespace
// e2e-gpu-vendors and the nodes are made here and removed after (pods first), also when a test fails.

const CLUSTER = 'test2'
const NODE = `${CLUSTER}-control-plane`
const NS = 'e2e-gpu-vendors'
const FAKE = 'kubeast.dev/e2e-fake-gpu-node'
const AMD_NODE = `${CLUSTER}-gpu-amd`
const INTEL_NODE = `${CLUSTER}-gpu-intel`
const AMD_PLUGIN = { namespace: 'kube-system', name: 'amdgpu-device-plugin-daemonset' } // ROCm's k8s-ds-amdgpu-dp.yaml
const DRAWER = 'div[class*="fixed"][class*="inset-y-0"][class*="right-0"]'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = any
type Table = { columnDefinitions: { name: string }[]; rows: { cells: unknown[]; object: Obj }[] }

// test2's kubectl, and the API server's Table — what `kubectl get` prints — through the kubeconfig's client certificate
const kc = (() => { try { return execSync(`kind get kubeconfig --name ${CLUSTER}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) } catch { return '' } })()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-number-gpu-vendors-'))
const kcPath = path.join(tmp, 'kubeconfig')
fs.writeFileSync(kcPath, kc, { mode: 0o600 })
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl --kubeconfig ${kcPath} --context kind-${CLUSTER} ${args}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim()
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
async function statusCells(apiPath: string): Promise<Record<string, string>> {
  const t = await apiTable(apiPath)
  const at = t.columnDefinitions.findIndex((c) => c.name === 'Status')
  return Object.fromEntries(t.rows.map((r) => [keyOf(r.object.metadata), String(r.cells[at] ?? '')]))
}

// ── the cluster as kubectl reads it ───────────────────────────────────────────────────────────────────────────────────

const VENDORS = ['NVIDIA', 'AMD', 'Intel'] as const
type Vendor = typeof VENDORS[number]
// the names whose devices are one GPU each, from each company's device plugin documentation
const vendorOf = (name: string): Vendor | undefined =>
  name === 'nvidia.com/gpu' || name === 'nvidia.com/gpu.shared' || name.startsWith('nvidia.com/mig-') ? 'NVIDIA'
    : name === 'amd.com/gpu' || /^amd\.com\/(spx|dpx|tpx|qpx|cpx)_nps\d+$/.test(name) ? 'AMD'
      : name === 'gpu.intel.com/i915' || name === 'gpu.intel.com/xe' ? 'Intel' : undefined
const byVendor = (entries: [string, number][]) => {
  const m = new Map<Vendor, number>()
  for (const [name, n] of entries) { const v = vendorOf(name); if (v) m.set(v, (m.get(v) ?? 0) + n) }
  return m
}
const gpusOf = (resources: Record<string, string> | undefined) => byVendor(Object.entries(resources ?? {}).map(([k, v]) => [k, Number(v)]))
const sum = (m: Map<Vendor, number>) => [...m.values()].reduce((s, n) => s + n, 0)
// a pod's request of one resource as the scheduler counts it (Kubernetes "Sidecar containers"): the containers and the
// sidecars summed, or an init container's (with the sidecars started before it) when higher
function podRequest(p: Obj, name: string): number {
  const req = (c: Obj) => Number(c.resources?.requests?.[name] ?? 0)
  let total = (p.spec.containers ?? []).reduce((s: number, c: Obj) => s + req(c), 0)
  let sidecars = 0
  let initPeak = 0
  for (const c of p.spec.initContainers ?? []) {
    if (c.restartPolicy === 'Always') { total += req(c); sidecars += req(c); initPeak = Math.max(initPeak, sidecars) } else initPeak = Math.max(initPeak, req(c) + sidecars)
  }
  return Math.max(total, initPeak)
}
function podGpus(p: Obj): Map<Vendor, number> {
  const names = new Set<string>()
  for (const c of [...(p.spec.containers ?? []), ...(p.spec.initContainers ?? [])]) for (const k of Object.keys(c.resources?.requests ?? {})) if (vendorOf(k)) names.add(k)
  return byVendor([...names].map((n) => [n, podRequest(p, n)]))
}
// kubectl describe node's "Allocated resources": each GPU resource's requests
function allocated(node: string): Map<Vendor, number> {
  const section = kubectl(`describe node ${node}`).split('Allocated resources:')[1]?.split(/\n\S/)[0] ?? ''
  return byVendor([...section.matchAll(/^\s+(\S+)\s+(\d+)\s+\d+\s*$/gm)].map((m) => [m[1], Number(m[2])]))
}
// each company's model and memory labels: GPU Feature Discovery, AMD's node labeller, Intel's NFD rules
const MODEL: Record<Vendor, string> = { NVIDIA: 'nvidia.com/gpu.product', AMD: 'amd.com/gpu.product-name', Intel: 'gpu.intel.com/product' }
const MEMORY: Record<Vendor, string | undefined> = { NVIDIA: 'nvidia.com/gpu.memory', AMD: 'amd.com/gpu.vram', Intel: undefined }
// NVIDIA's label is a number of mebibytes, which the screens give its unit; AMD's writes its own
const memoryOf = (v: Vendor, labels: Record<string, string>) => {
  const label = MEMORY[v] ? labels[MEMORY[v]!] : undefined
  return label && v === 'NVIDIA' ? `${label} MiB` : label
}
const ended = (p: Obj) => p.status?.phase === 'Succeeded' || p.status?.phase === 'Failed'
const readinessOf = (status: string) => { const first = status.split(',')[0]; return first === 'Ready' || first === 'NotReady' ? first : 'Unknown' }
const inOrder = <T,>(m: Map<Vendor, T>) => VENDORS.filter((v) => m.has(v)).map((v) => [v, m.get(v)!] as const)

type NodeRow = {
  name: string; capacity: number; allocatable: number; used: number; status: string; labels: Record<string, string>
  vendors: { vendor: Vendor; capacity: number; allocatable: number; used: number; model?: string; memory?: string }[]
}
type PodRow = { key: string; namespace: string; name: string; node: string; gpus: number; vendors: [Vendor, number][]; status: string; phase: string; ended: boolean }
type Cluster = { nodes: NodeRow[]; pods: PodRow[]; used: number; waiting: number; usedBy: Map<Vendor, number>; waitingBy: Map<Vendor, number> }
async function cluster(): Promise<Cluster> {
  const nodeStatus = await statusCells('/api/v1/nodes')
  const podStatus = await statusCells('/api/v1/pods')
  const nodeObjs: Obj[] = JSON.parse(kubectl('get nodes -o json')).items
  const podObjs: Obj[] = JSON.parse(kubectl('get pods -A -o json')).items
  const describe: Record<string, Map<Vendor, number>> = Object.fromEntries(nodeObjs.map((n) => [n.metadata.name, allocated(n.metadata.name)]))
  const usedBy = new Map<Vendor, number>()
  for (const m of Object.values(describe)) for (const [v, n] of m) usedBy.set(v, (usedBy.get(v) ?? 0) + n)
  const pods = podObjs.filter((p) => sum(podGpus(p)) > 0).map((p) => ({
    key: keyOf(p.metadata), namespace: p.metadata.namespace, name: p.metadata.name, node: p.spec.nodeName ?? '', gpus: sum(podGpus(p)),
    vendors: inOrder(podGpus(p)) as [Vendor, number][], status: podStatus[keyOf(p.metadata)] ?? '', phase: p.status?.phase ?? '', ended: ended(p),
  }))
  const waitingBy = new Map<Vendor, number>()
  for (const p of pods) if (!p.node && !p.ended) for (const [v, n] of p.vendors) waitingBy.set(v, (waitingBy.get(v) ?? 0) + n)
  const nodes = nodeObjs.filter((n) => sum(gpusOf(n.status.capacity)) > 0).map((n) => {
    const cap = gpusOf(n.status.capacity)
    const alloc = gpusOf(n.status.allocatable)
    const used = describe[n.metadata.name]
    const labels = n.metadata.labels ?? {}
    return {
      name: n.metadata.name, capacity: sum(cap), allocatable: sum(alloc), used: sum(used), status: nodeStatus[n.metadata.name], labels,
      vendors: VENDORS.filter((v) => cap.get(v) || alloc.get(v) || used.get(v)).map((v) => ({
        vendor: v, capacity: cap.get(v) ?? 0, allocatable: alloc.get(v) ?? 0, used: used.get(v) ?? 0, model: labels[MODEL[v]], memory: memoryOf(v, labels),
      })),
    }
  })
  return { nodes, pods, used: sum(usedBy), waiting: sum(waitingBy), usedBy, waitingBy }
}
// each company's GPUs on the nodes, in use and waiting (the dashboard's per-company totals)
function vendorTotals(c: Cluster) {
  const cap = new Map<Vendor, [number, number]>()
  for (const n of c.nodes) for (const v of n.vendors) { const e = cap.get(v.vendor) ?? [0, 0]; cap.set(v.vendor, [e[0] + v.capacity, e[1] + v.allocatable]) }
  return VENDORS.filter((v) => cap.has(v) || c.usedBy.has(v) || c.waitingBy.has(v))
    .map((v) => ({ vendor: v, capacity: cap.get(v)?.[0] ?? 0, allocatable: cap.get(v)?.[1] ?? 0, used: c.usedBy.get(v) ?? 0, waiting: c.waitingBy.get(v) ?? 0 }))
}
const bare = (v: unknown) => JSON.stringify(v).replace(/\\n|\s+/g, '')
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)
const names = (vendors: { vendor: Vendor }[]) => vendors.map((v) => v.vendor).join(', ')

// ── fixture ───────────────────────────────────────────────────────────────────────────────────────────────────────────

// AMD: four MI300X as ROCm's device plugin (single strategy) and node labeller write them. Intel: two Max 1550 as the
// Intel plugin up to v0.32 with NFD wrote them — gpu.intel.com/i915 and, not devices, i915_monitoring, millicores,
// memory.max and tiles.
const AMD_LABELS = {
  'amd.com/gpu.product-name': 'AMD_Instinct_MI300X', 'amd.com/gpu.vram': '192G', 'amd.com/gpu.family': 'AI', 'amd.com/gpu.driver-version': '6.12.12',
  'amd.com/gpu.device-id': '74a1', 'beta.amd.com/gpu.product-name': 'AMD_Instinct_MI300X', 'beta.amd.com/gpu.product-name.AMD_Instinct_MI300X': '4',
}
const INTEL_LABELS = {
  'gpu.intel.com/product': 'Max_1550', 'gpu.intel.com/family': 'Max_Series', 'gpu.intel.com/device.count': '2',
  'gpu.intel.com/device-id.0380-0bd5.present': 'true', 'gpu.intel.com/device-id.0380-0bd5.count': '2', 'intel.feature.node.kubernetes.io/gpu': 'true',
}
const AMD_GPUS = { 'amd.com/gpu': '4' }
const INTEL_GPUS = { 'gpu.intel.com/i915': '2', 'gpu.intel.com/i915_monitoring': '1', 'gpu.intel.com/millicores': '2000', 'gpu.intel.com/memory.max': '274877906944', 'gpu.intel.com/tiles': '4' }
const fakeNode = (name: string, labels: Record<string, string>) => ({
  apiVersion: 'v1', kind: 'Node',
  metadata: { name, labels: { 'kubernetes.io/hostname': name, [FAKE]: 'true', ...labels } },
  spec: { taints: [{ key: FAKE, value: 'true', effect: 'NoSchedule' }] },
})
// no kubelet fills the allocatable or posts a condition: both are written, Ready False as a kubelet that stopped
const nodeStatusPatch = (gpus: Record<string, string>) => {
  const r = { cpu: '8', memory: '64Gi', pods: '110', ...gpus }
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  return { status: { capacity: r, allocatable: r, conditions: [{ type: 'Ready', status: 'False', reason: 'KubeletNotReady', message: 'no kubelet (e2e)', lastHeartbeatTime: now, lastTransitionTime: now }] } }
}
const SLEEP = ['sleep', '3600']
const box = (name: string, command: string[], limits?: Record<string, string>, extra: Obj = {}) =>
  ({ name, image: 'busybox:1.37', imagePullPolicy: 'IfNotPresent', command, ...(limits ? { resources: { limits } } : {}), ...extra })
const pod = (name: string, spec: Obj) => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace: NS }, spec: { terminationGracePeriodSeconds: 0, ...spec } })
// bound to a node without a kubelet: Pending, and kept through the node controller's taints
const bound = (node: string) => ({ nodeName: node, tolerations: [{ operator: 'Exists' }] })
// NVIDIA 1 on test2's node; AMD 2 + 1 on the AMD node and 1 waiting; Intel 1 (its millicores and monitoring not GPUs);
// a pod asking only for millicores asks for no GPU
const PODS = [
  pod('nv-one', { containers: [box('app', SLEEP, { 'nvidia.com/gpu': '1' })] }),
  pod('amd-two', { ...bound(AMD_NODE), containers: [box('app', SLEEP, { 'amd.com/gpu': '2' })] }),
  pod('amd-one', { ...bound(AMD_NODE), containers: [box('app', SLEEP, { 'amd.com/gpu': '1' })] }),
  pod('intel-one', { ...bound(INTEL_NODE), containers: [box('app', SLEEP, { 'gpu.intel.com/i915': '1', 'gpu.intel.com/millicores': '500', 'gpu.intel.com/i915_monitoring': '1' })] }),
  pod('intel-millicores-only', { ...bound(INTEL_NODE), containers: [box('app', SLEEP, { 'gpu.intel.com/millicores': '250' })] }),
  pod('amd-waiting', { nodeSelector: { [NS]: 'no-such-node' }, containers: [box('app', SLEEP, { 'amd.com/gpu': '1' })] }),
]
const list = (items: Obj[]) => JSON.stringify({ apiVersion: 'v1', kind: 'List', items })

async function waitFor(what: string, ok: () => boolean | Promise<boolean>, ms = 120_000) {
  const deadline = Date.now() + ms
  for (;;) {
    try { if (await ok()) return } catch { /* not there yet */ }
    if (Date.now() > deadline) throw new Error(`${what} did not happen in ${ms / 1000} s`)
    await new Promise((r) => setTimeout(r, 2000))
  }
}
const settled = () => {
  const by: Record<string, Obj> = Object.fromEntries(JSON.parse(kubectl(`get pods -n ${NS} -o json`)).items.map((p: Obj) => [p.metadata.name, p]))
  return by['nv-one']?.status?.conditions?.some((c: Obj) => c.type === 'Ready' && c.status === 'True') &&
    ['amd-two', 'amd-one', 'intel-one', 'intel-millicores-only'].every((n) => by[n]?.spec?.nodeName && by[n]?.status?.phase === 'Pending') &&
    by['amd-waiting']?.status?.conditions?.some((c: Obj) => c.type === 'PodScheduled' && c.status === 'False')
}
// pods first (no kubelet confirms their deletion, so at once), then the nodes
function cleanUp() {
  const steps = [
    `delete pods -n ${NS} --all --grace-period=0 --force --ignore-not-found`,
    `delete namespace ${NS} --ignore-not-found --wait=true --timeout=120s`,
    `delete nodes -l ${FAKE} --ignore-not-found --wait=true --timeout=120s`,
  ]
  for (const s of steps) { try { kubectl(s) } catch { /* the next step still runs */ } }
}

let prepared = ''
const nodeGpus = () => { try { return kubectl(`get node ${NODE} -o jsonpath='{.status.allocatable.nvidia\\.com/gpu}'`) } catch { return '' } }

test.describe('number check — AMD and Intel GPUs on the GPU screens', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    if (!kc || !nodeGpus()) return
    cleanUp()
    try {
      kubectl('create -f -', list([fakeNode(AMD_NODE, AMD_LABELS), fakeNode(INTEL_NODE, INTEL_LABELS)]))
      for (const [name, gpus] of [[AMD_NODE, AMD_GPUS], [INTEL_NODE, INTEL_GPUS]] as const) {
        const file = path.join(tmp, `${name}-status.json`)
        fs.writeFileSync(file, JSON.stringify(nodeStatusPatch(gpus)))
        kubectl(`patch node ${name} --subresource=status --type=merge --patch-file ${file}`)
      }
      kubectl('apply -f -', list([{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } }, ...PODS]))
      await waitFor('the GPU pods settled', settled)
      prepared = 'yes'
    } catch (e) {
      cleanUp()
      throw e
    }
  })

  test.afterAll(() => {
    if (kc) cleanUp()
  })

  const admin = async (request: APIRequestContext) => {
    const res = await request.post('/api/v1/auth/login', { data: { email: process.env.E2E_USER_EMAIL || 'admin', password: process.env.E2E_USER_PASSWORD || '' } })
    expect(res.ok(), `admin login: ${res.status()}`).toBeTruthy()
    return { Authorization: `Bearer ${(await res.json()).access_token as string}`, 'X-Requested-With': 'XMLHttpRequest' }
  }
  async function prepare(page: Page) {
    test.skip(!prepared, `needs the fake NVIDIA GPUs of scripts/kind-gpu.sh up on ${CLUSTER}`)
    const body = await (await page.request.get('/api/v1/clusters', { headers: await admin(page.request) })).json()
    test.skip(!(Array.isArray(body) ? body : body.items ?? []).some((c: Obj) => c.id === CLUSTER), `needs the kind cluster ${CLUSTER}, registered as ${CLUSTER}`)
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
  // polled until the screen and kubectl agree, then the last reading compared so a failure shows both
  async function sameAsCluster(what: string, got: () => Promise<unknown>, want: () => Promise<unknown>, timeout = 60_000) {
    let last: { got: unknown; want: unknown } = { got: null, want: null }
    await expect.poll(async () => {
      last = { got: await got(), want: await want() }
      return bare(last.got) === bare(last.want)
    }, { timeout, message: what }).toBe(true).catch(() => undefined)
    expect(last.got, what).toEqual(last.want)
  }
  // the fixture's own numbers, so a cluster that lost them fails here and not by agreeing on nothing
  async function fixtureThere() {
    const c = await cluster()
    const of = (name: string) => c.nodes.find((n) => n.name === name)
    expect({
      amd: of(AMD_NODE)?.vendors, intel: of(INTEL_NODE)?.vendors.map((v) => [v.vendor, v.capacity, v.used]),
      waiting: Object.fromEntries(c.waitingBy), intelOne: c.pods.find((p) => p.name === 'intel-one')?.gpus,
      millicoresOnly: c.pods.some((p) => p.name === 'intel-millicores-only'),
    }, 'the fake AMD and Intel nodes and their pods').toEqual({
      amd: [{ vendor: 'AMD', capacity: 4, allocatable: 4, used: 3, model: 'AMD_Instinct_MI300X', memory: '192G' }],
      intel: [['Intel', 2, 1]], waiting: { AMD: 1 }, intelOne: 1, millicoresOnly: false,
    })
    return c
  }

  // ── GPU Dashboard ─────────────────────────────────────────────────────────────────────────────────────────────────

  test('GPU Dashboard: every company\'s GPUs are counted as kubectl describe node counts them, each node with its companies and models', async ({ page }) => {
    test.setTimeout(180_000)
    await prepare(page)
    await fixtureThere()
    await page.goto(url('/gpu/dashboard'))
    const got = () => page.evaluate(() => {
      const text = (el: Element | null) => (el as HTMLElement | null)?.innerText.trim() ?? null
      const all = (sel: string) => [...document.querySelectorAll(sel)]
      return {
        cards: Object.fromEntries(all('[data-testid="gpu-summary-card"]').map((c) => [text(c.querySelector('p')), text(c.querySelector('[data-testid="gpu-summary-value"]'))])),
        vendors: text(document.querySelector('[data-testid="gpu-summary-vendors"]')),
        note: text(document.querySelector('[data-testid="gpu-summary-note"]')),
        readiness: text(document.querySelector('[data-testid="gpu-node-readiness"]')),
        nodes: Object.fromEntries(all('[data-testid="gpu-node-allocation"]').map((n) => [n.getAttribute('data-node'), {
          value: text(n.querySelector('[data-testid="gpu-node-allocation-value"]')),
          status: [...n.querySelectorAll('.badge')].map((b) => (b.textContent ?? '').trim()).join(','),
          models: text(n.querySelector('[data-testid="gpu-node-allocation-models"]')),
        }])),
        models: all('[data-testid="gpu-model-row"]').map((r) => [...r.querySelectorAll('span')].slice(0, 2).map((s) => text(s))).sort(),
        podTotal: text(document.querySelector('[data-testid="gpu-pod-status-total"]')),
      }
    })
    const want = async () => {
      const c = await cluster()
      const cap = c.nodes.reduce((s, n) => s + n.capacity, 0)
      const alloc = c.nodes.reduce((s, n) => s + n.allocatable, 0)
      const ready = c.nodes.filter((n) => readinessOf(n.status) === 'Ready').length
      const models = new Map<string, number>()
      for (const n of c.nodes) for (const v of n.vendors) models.set(v.model ?? 'Unknown', (models.get(v.model ?? 'Unknown') ?? 0) + v.capacity)
      return {
        cards: { 'Total Capacity': String(cap), Allocatable: String(alloc), 'In Use': String(c.used), 'Allocation Rate': `${pct(c.used, alloc)}%` },
        vendors: vendorTotals(c).filter((v) => v.capacity > 0).map((v) => `${v.vendor} ${v.capacity}`).join(' · '),
        note: c.waiting > 0 ? `+${c.waiting} requested by pods waiting for a node` : null,
        readiness: `${ready} Ready${c.nodes.length - ready > 0 ? ` / ${c.nodes.length - ready} Not Ready` : ''}`,
        nodes: Object.fromEntries(c.nodes.map((n) => [n.name, {
          value: `${n.used}/${n.allocatable}(${pct(n.used, n.allocatable)}%)`, status: n.status,
          // the company before its model, not again when the model's label starts with the company's name
          models: n.vendors.map((v) => `${v.model?.toLowerCase().startsWith(v.vendor.toLowerCase()) ? v.model : `${v.vendor} ${v.model ?? 'Unknown'}`}${v.memory ? ` • ${v.memory}` : ''}`).join(' / '),
        }])),
        models: [...models].map(([m, n]) => [m, `${n} GPU (${pct(n, cap)}%)`]).sort(),
        podTotal: String(c.pods.length),
      }
    }
    await sameAsCluster('GPU Dashboard', got, want)
    // the three companies and the two NotReady nodes of the fixture are on screen; a model naming its company is not
    // named twice ("NVIDIA-A100…", "AMD_Instinct…"), one that does not is ("Intel Max_1550")
    const seen = await got() as Obj
    expect({ vendors: seen.vendors, readiness: seen.readiness, models: [NODE, AMD_NODE, INTEL_NODE].map((n) => seen.nodes[n]?.models) }, 'the companies and the nodes kubectl lists')
      .toEqual({ vendors: 'NVIDIA 12 · AMD 4 · Intel 2', readiness: '1 Ready / 2 Not Ready', models: ['NVIDIA-A100-SXM4-80GB • 81920 MiB', 'AMD_Instinct_MI300X • 192G', 'Intel Max_1550'] })
  })

  test('GPU Dashboard: each company gets its device plugin badge, found or not', async ({ page }) => {
    test.setTimeout(180_000)
    await prepare(page)
    // the badges and their details by their words, as main's page shows them too
    const badges = () => page.getByText(/Device Plugin (Healthy|Unhealthy|Not Found)$/).allInnerTexts()
    const details = () => page.getByText(/Plugin: \d+\/\d+ ready$/i).allInnerTexts()
    // a reload drops the page: read the badges once the dashboard has drawn them again
    const reloaded = async () => {
      await page.reload()
      await page.getByText(/Device Plugin (Healthy|Unhealthy|Not Found)$/).first().waitFor({ timeout: 15_000 })
    }
    const ds = JSON.stringify({
      apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: AMD_PLUGIN.name, namespace: AMD_PLUGIN.namespace },
      spec: {
        selector: { matchLabels: { app: 'e2e-gpu-vendors-plugin' } },
        template: {
          metadata: { labels: { app: 'e2e-gpu-vendors-plugin' } },
          spec: { terminationGracePeriodSeconds: 0, containers: [box('plugin', SLEEP, undefined, { readinessProbe: { exec: { command: ['test', '-f', '/tmp/ready'] }, periodSeconds: 2 } })] },
        },
      },
    })
    const dsStatus = () => JSON.parse(kubectl(`-n ${AMD_PLUGIN.namespace} get ds ${AMD_PLUGIN.name} -o json`)).status
    let made = false
    try {
      test.skip(kubectl(`-n ${AMD_PLUGIN.namespace} get ds ${AMD_PLUGIN.name} --ignore-not-found -o name`) !== '', `${AMD_PLUGIN.namespace}/${AMD_PLUGIN.name} is there already`)
      await page.goto(url('/gpu/dashboard'))
      await expect.poll(badges, { timeout: 30_000, message: 'no plugin of any company' })
        .toEqual(['NVIDIA Device Plugin Not Found', 'AMD Device Plugin Not Found', 'Intel Device Plugin Not Found'])
      expect(await details()).toEqual([])
      await expect(page.getByTestId('gpu-plugin-note')).toHaveText(/^NVIDIA, AMD, Intel device plugin: not under the names Kubeast looks for\./)

      kubectl('apply -f -', ds)
      made = true
      // only test2's own node takes it: the fake nodes' taint is not tolerated
      await waitFor('the AMD plugin pod scheduled, not ready', () => { const s = dsStatus(); return s.desiredNumberScheduled === 1 && s.numberReady === 0 }, 60_000)
      await expect(async () => {
        await reloaded()
        expect(await badges()).toEqual(['NVIDIA Device Plugin Not Found', 'AMD Device Plugin Unhealthy', 'Intel Device Plugin Not Found'])
        expect(await details()).toEqual([`AMD Plugin: ${dsStatus().numberReady}/${dsStatus().desiredNumberScheduled} Ready`])
      }).toPass({ timeout: 60_000 })

      await waitFor('the plugin container running', () => kubectl(`-n ${AMD_PLUGIN.namespace} get pods -l app=e2e-gpu-vendors-plugin -o jsonpath={.items[0].status.containerStatuses[0].state.running.startedAt}`) !== '', 60_000)
      kubectl(`-n ${AMD_PLUGIN.namespace} exec ds/${AMD_PLUGIN.name} -- touch /tmp/ready`)
      await waitFor('the plugin pod ready', () => dsStatus().numberReady === 1, 60_000)
      await expect(async () => {
        await reloaded()
        expect(await badges()).toEqual(['NVIDIA Device Plugin Not Found', 'AMD Device Plugin Healthy', 'Intel Device Plugin Not Found'])
        expect(await details()).toEqual(['AMD Plugin: 1/1 Ready'])
        await expect(page.getByTestId('gpu-plugin-note')).toHaveText(/^NVIDIA, Intel device plugin: not under the names Kubeast looks for\./)
      }).toPass({ timeout: 60_000 })
    } finally {
      if (made) kubectl(`-n ${AMD_PLUGIN.namespace} delete ds ${AMD_PLUGIN.name} --ignore-not-found --wait=true`)
    }
  })

  // ── GPU Nodes ─────────────────────────────────────────────────────────────────────────────────────────────────────

  // NVIDIA's label is mebibytes and AMD's says 192G: as text 192G comes first, as sizes it comes last
  test('GPU Nodes sorts by memory as sizes, across each company\'s units', async ({ page }) => {
    test.setTimeout(120_000)
    await prepare(page)
    const nvidia = kubectl(`get node ${NODE} -o jsonpath='{.metadata.labels.nvidia\\.com/gpu\\.memory}'`)
    expect(Number(nvidia), 'kubectl: mebibytes').toBeGreaterThan(0)
    expect(Number(nvidia), 'kubectl: less than AMD\'s 192G').toBeLessThan(192 * 1024)
    await page.goto(url('/gpu/nodes'))
    const names = async () => (await readPage(page)).rows.map((r) => r.Name)
    await expect.poll(async () => (await names()).sort(), { timeout: 30_000 }).toEqual([NODE, AMD_NODE, INTEL_NODE].sort())
    const header = page.locator('main table thead th').filter({ hasText: 'GPU Memory' })
    await header.click()
    await expect.poll(names, { message: 'going up: the node with no memory, then by size' }).toEqual([INTEL_NODE, NODE, AMD_NODE])
    await header.click()
    await expect.poll(names, { message: 'going down' }).toEqual([AMD_NODE, NODE, INTEL_NODE])
  })

  test('GPU Nodes: the cards, rows with each node\'s companies, and the model cards are kubectl\'s', async ({ page }) => {
    test.setTimeout(180_000)
    await prepare(page)
    await page.goto(url('/gpu/nodes'))
    const joined = (vals: (string | undefined)[]) => vals.filter(Boolean).join(', ') || '-'
    await sameAsCluster('GPU Nodes cards and rows', async () => {
      const { rows, cards } = await readPage(page)
      return { cards, rows: rows.map((r) => [r.Name, r.Vendor, r['GPU Model'], r['GPU Memory'], r.Capacity, r.Allocatable, r.Status, r['MIG Strategy']]).sort() }
    }, async () => {
      const c = await cluster()
      const ready = c.nodes.filter((n) => readinessOf(n.status) === 'Ready').length
      return {
        cards: { 'Total Nodes': String(c.nodes.length), Ready: String(ready), 'Not Ready': String(c.nodes.length - ready),
          'GPU Capacity': String(c.nodes.reduce((s, n) => s + n.capacity, 0)), Allocatable: String(c.nodes.reduce((s, n) => s + n.allocatable, 0)), 'In Use': String(c.used) },
        rows: c.nodes.map((n) => [n.name, names(n.vendors), joined(n.vendors.map((v) => v.model)), joined(n.vendors.map((v) => v.memory)),
          String(n.capacity), String(n.allocatable), n.status, n.labels['nvidia.com/mig.strategy'] ?? '-']).sort(),
      }
    })
    const c = await fixtureThere()
    expect(c.nodes.map((n) => [n.name, names(n.vendors), n.capacity, readinessOf(n.status)]).sort(), 'the three GPU nodes')
      .toEqual([[NODE, 'NVIDIA', 12, 'Ready'], [AMD_NODE, 'AMD', 4, 'NotReady'], [INTEL_NODE, 'Intel', 2, 'NotReady']])

    // Metrics: each model's nodes, capacity, allocatable and GPUs in use, a node's GPUs under its company's model
    await page.getByRole('button', { name: /^(Metrics|메트릭)/ }).click()
    const models = new Map<string, { n: number; cap: number; alloc: number; used: number }>()
    for (const n of c.nodes) for (const v of n.vendors) {
      const m = v.model ?? 'Unknown'
      const e = models.get(m) ?? { n: 0, cap: 0, alloc: 0, used: 0 }
      models.set(m, { n: e.n + 1, cap: e.cap + v.capacity, alloc: e.alloc + v.allocatable, used: e.used + v.used })
    }
    const readModels = () => page.locator('[data-testid="gpu-nodes-model"]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-model'),
      ...[...e.querySelectorAll('span')].map((s) => (s as HTMLElement).innerText.trim())]).sort())
    await expect.poll(readModels, { timeout: 20_000, message: 'model cards' }).toEqual([...models].map(([m, e]) => [m, m, `${e.n} node${e.n === 1 ? '' : 's'}`,
      'Capacity', String(e.cap), 'Allocatable', String(e.alloc), 'In Use', `${e.used} (${pct(e.used, e.alloc)}%)`]).sort())
  })

  // ── GPU Pods ──────────────────────────────────────────────────────────────────────────────────────────────────────

  test('GPU Pods: the cards and rows with each pod\'s companies are kubectl\'s; a pod asking only for millicores is none', async ({ page }) => {
    test.setTimeout(180_000)
    await prepare(page)
    await page.goto(url('/gpu/pods'))
    let want: Obj = null
    await sameAsCluster('GPU Pods cards and rows', async () => {
      const { rows, cards } = await readPage(page)
      return { cards, rows: rows.map((r) => [r.Namespace, r.Name, r.Node, r.GPUs, r.Vendor, r.Status]).sort() }
    }, async () => {
      const c = await cluster()
      const namesError = (s: string) => ['error', 'failed', 'backoff', 'errimagepull', 'oomkilled'].some((w) => s.toLowerCase().includes(w))
      want = {
        cards: {
          // a pod in one card: Failed the phase or a status naming an error, then the others by phase
          'Total Pods': String(c.pods.length), Running: String(c.pods.filter((p) => p.phase === 'Running' && !namesError(p.status)).length),
          Pending: String(c.pods.filter((p) => p.phase === 'Pending' && !namesError(p.status)).length),
          Failed: String(c.pods.filter((p) => p.phase === 'Failed' || namesError(p.status)).length),
          'GPUs Requested': String(c.used + c.waiting), Namespaces: String(new Set(c.pods.map((p) => p.namespace)).size),
        },
        rows: c.pods.map((p) => [p.namespace, p.name, p.node || '-', String(p.gpus), p.vendors.map(([v]) => v).join(', '), p.status]).sort(),
      }
      return want
    })
    const ours = (want.rows as string[][]).filter((r) => r[0] === NS)
    expect(ours, 'the fixture\'s pods, kubectl\'s STATUS').toEqual([
      [NS, 'amd-one', AMD_NODE, '1', 'AMD', 'Pending'],
      [NS, 'amd-two', AMD_NODE, '2', 'AMD', 'Pending'],
      [NS, 'amd-waiting', '-', '1', 'AMD', 'Pending'],
      [NS, 'intel-one', INTEL_NODE, '1', 'Intel', 'Pending'],
      [NS, 'nv-one', NODE, '1', 'NVIDIA', 'Running'],
    ])
  })

  // ── the node drawer ───────────────────────────────────────────────────────────────────────────────────────────────

  test('the Node drawer\'s GPU rows of an AMD and an Intel node are their companies\' labels and GPUs', async ({ page }) => {
    test.setTimeout(120_000)
    await prepare(page)
    const rows = (name: string): [string, string][] => {
      const n = JSON.parse(kubectl(`get node ${name} -o json`))
      const l = n.metadata.labels
      const count = (r: Record<string, string>) => String(sum(gpusOf(r)))
      if (name === AMD_NODE) {
        return [['GPU Vendor', 'AMD'], ['GPU Product', l['amd.com/gpu.product-name']], ['GPU Memory', l['amd.com/gpu.vram']],
          ['GPU Count (Capacity)', count(n.status.capacity)], ['GPU Count (Allocatable)', count(n.status.allocatable)],
          ['Driver Version', l['amd.com/gpu.driver-version']], ['GPU Family', l['amd.com/gpu.family']]]
      }
      return [['GPU Vendor', 'Intel'], ['GPU Product', l['gpu.intel.com/product']],
        ['GPU Count (Capacity)', count(n.status.capacity)], ['GPU Count (Allocatable)', count(n.status.allocatable)], ['GPU Family', l['gpu.intel.com/family']]]
    }
    expect([rows(AMD_NODE)[3], rows(INTEL_NODE)[2]], 'GPUs of the nodes kubectl lists (Intel\'s millicores and the rest left out)')
      .toEqual([['GPU Count (Capacity)', '4'], ['GPU Count (Capacity)', '2']])
    for (const name of [AMD_NODE, INTEL_NODE]) {
      await page.goto(url('/gpu/nodes', `&detail=${encodeURIComponent(`Node/${name}`)}`))
      await page.locator(DRAWER).last().waitFor({ timeout: 20_000 })
      await expect.poll(() => page.locator(DRAWER).last().evaluate((root) => {
        for (const p of root.querySelectorAll('div.rounded-lg.border > div.flex > p.text-xs')) {
          if ((p as HTMLElement).innerText.trim() !== 'GPU Info') continue
          return [...p.parentElement!.parentElement!.querySelectorAll('div.grid')].map((g) => [...g.children].map((s) => (s as HTMLElement).innerText.trim()))
        }
        return null
      }), { timeout: 20_000, message: `GPU Info of ${name}` }).toEqual(rows(name))
    }
  })

  // ── the AI tool ──────────────────────────────────────────────────────────────────────────────────────────────────────

  test('the AI tool gpu splits each company\'s numbers as the screens do, each as kubectl counts it', async ({ page, request }) => {
    test.setTimeout(180_000)
    await prepare(page)
    const headers = await admin(request)
    const config = await request.get('/api/v1/ai/mcp/config', { headers })
    test.skip(!config.ok() || !(await config.json()).enabled, 'needs the MCP server (mcp.enabled in the dev values)')
    await expect(async () => {
      const c = await fixtureThere()
      const res = await request.post('/api/v1/ai/mcp', {
        headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: headers.Authorization },
        data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gpu', arguments: { cluster: CLUSTER } } },
      })
      expect(res.status(), await res.text()).toBe(200)
      const tool = JSON.parse((await res.json()).result.content[0].text)

      // each company's left is what its own GPUs on each node have left
      const left = (v: { allocatable: number; used: number }) => Math.max(0, v.allocatable - v.used)
      const nodesOf = (vendor: Vendor) => c.nodes.flatMap((n) => n.vendors.filter((v) => v.vendor === vendor))
      expect(tool.vendors).toEqual(vendorTotals(c).map((v) => ({ ...v, free: nodesOf(v.vendor).reduce((s, e) => s + left(e), 0), nodes: nodesOf(v.vendor).length })))
      expect(tool.total_gpu_free).toBe(c.nodes.flatMap((n) => n.vendors).reduce((s, e) => s + left(e), 0))
      expect(tool.pod_vendors).toEqual(VENDORS.map((vendor) => {
        const of = c.pods.filter((p) => p.vendors.some(([v]) => v === vendor))
        return { vendor, pods: of.length, requested: of.filter((p) => !p.ended).reduce((s, p) => s + (p.vendors.find(([v]) => v === vendor)?.[1] ?? 0), 0) }
      }).filter((v) => v.pods > 0))
      for (const name of [AMD_NODE, INTEL_NODE]) {
        const want = c.nodes.find((n) => n.name === name)!
        const row = tool.gpu_nodes.find((n: Obj) => n.name === name)
        expect(row.gpu_vendors.map((v: Obj) => [v.vendor, v.capacity, v.allocatable, v.used, v.model]), name).toEqual(want.vendors.map((v) => [v.vendor, v.capacity, v.allocatable, v.used, v.model]))
        expect(row.gpu_free, name).toBe(want.vendors.reduce((s, e) => s + left(e), 0))
      }
      const models = new Map<string, { nodes: number; capacity: number; allocatable: number; used: number }>()
      for (const v of c.nodes.flatMap((n) => n.vendors)) {
        const e = models.get(v.model || 'Unknown') ?? { nodes: 0, capacity: 0, allocatable: 0, used: 0 }
        models.set(v.model || 'Unknown', { nodes: e.nodes + 1, capacity: e.capacity + v.capacity, allocatable: e.allocatable + v.allocatable, used: e.used + v.used })
      }
      expect(Object.fromEntries(tool.models.map(({ model, ...e }: Obj) => [model, e]))).toEqual(Object.fromEntries(models))
      expect(tool.device_plugins.map((p: Obj) => p.vendor), 'a plugin per company with GPUs').toEqual(expect.arrayContaining(['NVIDIA', 'AMD', 'Intel']))
    }).toPass({ timeout: 90_000, intervals: [5_000] })
  })

  // ── the floating chat ─────────────────────────────────────────────────────────────────────────────────────────────

  test('the floating chat is told each company\'s GPUs on each screen', async ({ page }) => {
    test.setTimeout(180_000)
    await prepare(page)
    const sent: { base?: { data?: Obj } | null }[] = []
    await page.route(/\/api\/v1\/sessions(\?|$)/, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ json: { id: 'e2e-gpu-vendors-1', title: 'New Chat', created_at: '', updated_at: '', message_count: 0 } })
        : route.fallback())
    await page.route(/\/api\/v1\/sessions\/e2e-gpu-vendors-\d+(\?|$)/, (route) =>
      route.fulfill({ json: { id: 'e2e-gpu-vendors-1', title: 'New Chat', created_at: '', updated_at: '', messages: [] } }))
    await page.route(/\/api\/v1\/ai\/sessions\/e2e-gpu-vendors-\d+\/floating-chat/, (route) => {
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
    const c = await fixtureThere()
    const notReady = c.nodes.filter((n) => readinessOf(n.status) !== 'Ready').length

    await page.goto(url('/gpu/dashboard'))
    await expect.poll(async () => {
      const data = await ask()
      return { vendors: data?.cluster_gpu?.vendors, capacity: data?.cluster_gpu?.total_capacity, notReady: (data?.interpretations ?? []).find((s: string) => s.includes('NotReady GPU')) }
    }, { timeout: 30_000, message: 'GPU Dashboard' }).toEqual({
      vendors: vendorTotals(c), capacity: c.nodes.reduce((s, n) => s + n.capacity, 0), notReady: expect.stringContaining(`NotReady GPU 노드 ${notReady}개`),
    })

    await page.goto(url('/gpu/nodes'))
    const byNodeVendor = VENDORS.map((vendor) => {
      const of = c.nodes.flatMap((n) => n.vendors.filter((v) => v.vendor === vendor))
      return { vendor, nodes: of.length, capacity: of.reduce((s, v) => s + v.capacity, 0), allocatable: of.reduce((s, v) => s + v.allocatable, 0), used: of.reduce((s, v) => s + v.used, 0) }
    }).filter((v) => v.nodes > 0)
    await expect.poll(async () => (await ask())?.stats?.by_vendor, { timeout: 30_000, message: 'GPU Nodes' }).toEqual(byNodeVendor)

    await page.goto(url('/gpu/pods'))
    const byPodVendor = VENDORS.map((vendor) => {
      const of = c.pods.filter((p) => p.vendors.some(([v]) => v === vendor))
      return { vendor, pods: of.length, requested: of.filter((p) => !p.ended).reduce((s, p) => s + (p.vendors.find(([v]) => v === vendor)?.[1] ?? 0), 0) }
    }).filter((v) => v.pods > 0)
    await expect.poll(async () => (await ask())?.stats?.by_vendor, { timeout: 30_000, message: 'GPU Pods' }).toEqual(byPodVendor)
  })
})
