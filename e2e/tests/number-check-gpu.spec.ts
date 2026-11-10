import { execSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { readEveryPage } from './list-pages'

// The GPU Dashboard, GPU Nodes and GPU Pods screens' numbers are the cluster's, on test2 with fake GPUs
// (scripts/kind-gpu.sh up: the node advertises nvidia.com/gpu and nvidia.com/mig-1g.5gb with GPU Feature Discovery's
// labels, and a stand-in dcgm-exporter is scraped by a Prometheus in `monitoring`, deploy/kind/gpu-metrics.yaml).
// GPUs in use are kubectl describe node's "Allocated resources" (the pods on a node that have not ended, init
// containers at their peak, sidecars added), pods no node has taken are waiting apart; a pod's Status is kubectl's
// STATUS and a node's too; the real-time numbers are what that Prometheus answers, a pod's GPUs read whether the
// scrape kept the exporter's pod label or renamed it exported_pod, and a GPU's pod is named when it asks for GPUs or
// holds a DRA claim (a pod of the DRA example driver's gpu.example.com). The GPU Pods charts list every status and
// node: for that test and the floating chat's, three Node objects without a kubelet and pods whose init container
// waits or fails are made and removed. The node drawer's GPU rows, the floating chat's numbers, the device plugin
// badge (the DaemonSet of NVIDIA's helm chart as its README installs it), MIG none, a cordoned node and a grant
// limited to namespaces ("-") too. The pods live in namespace e2e-gpu-num, made here and removed after; what the spec
// changes on the node and the exporter is put back.

const SCREENS = [
  { path: '/gpu/dashboard', cluster: 'test2' },
  { path: '/gpu/nodes', cluster: 'test2' },
  { path: '/gpu/pods', cluster: 'test2' },
]
const CLUSTER = SCREENS[0].cluster
const NODE = `${CLUSTER}-control-plane`
const NS = 'e2e-gpu-num'
const READ_GROUP = 'kubeast:role:read'
// NVIDIA k8s-device-plugin's chart as its README installs it: release nvdp, DaemonSet <release>-nvidia-device-plugin
const PLUGIN = { namespace: 'nvidia-device-plugin', name: 'nvdp-nvidia-device-plugin', release: 'nvdp' }
const DRA_CLASS = 'gpu.example.com' // the DRA example driver's (scripts/kind-gpu.sh up)
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
// The GPU Pods cards, a pod in one as on the Pods list: Failed the phase or a status naming an error, then the others by phase
const podCards = (pods: { phase: string; status: string }[]) => {
  const failing = (p: { phase: string; status: string }) => p.phase === 'Failed' || namesError(p.status)
  return {
    running: pods.filter((p) => !failing(p) && p.phase === 'Running').length,
    pending: pods.filter((p) => !failing(p) && p.phase === 'Pending').length,
    failed: pods.filter(failing).length,
  }
}
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
// a pod that asks for no extended resource and gets a GPU through a DRA claim (one of the example driver's devices)
const DRA = [
  { apiVersion: 'resource.k8s.io/v1', kind: 'ResourceClaim', metadata: { name: 'gpu-dra', namespace: NS },
    spec: { devices: { requests: [{ name: 'gpu', exactly: { deviceClassName: DRA_CLASS } }] } } },
  pod('gpu-dra', { resourceClaims: [{ name: 'gpu', resourceClaimName: 'gpu-dra' }],
    containers: [box('app', SLEEP, undefined, { resources: { claims: [{ name: 'gpu' }] } })] }),
]
const list = (items: Obj[]) => JSON.stringify({ apiVersion: 'v1', kind: 'List', items })

// DCGM series the stand-in exporter serves: /metrics as dcgm-exporter 4.8.4 writes them (hostname), scraped with the
// pod labels kept; /exported/metrics with the older Hostname, scraped by a target labelled as the exporter's own pod,
// so the pod labels become exported_pod and an idle GPU carries the exporter's pod. A pod on two GPUs, a GPU at 0 °C
// with a pod, idle GPUs on both, a GPU of the pod holding a DRA claim.
type G = { gpu: number; pod?: string; container?: string; util: number; used: number; free: number; temp: number }
const PLAIN: G[] = [
  { gpu: 0, pod: 'gpu-one', util: 30, used: 20000, free: 60000, temp: 41 },
  { gpu: 1, pod: 'gpu-two-cards', util: 50, used: 40000, free: 40000, temp: 0 },
  { gpu: 2, pod: 'gpu-two-cards', util: 70, used: 60000, free: 20000, temp: 55 },
  { gpu: 3, util: 0, used: 0, free: 80000, temp: 33 },
  { gpu: 8, pod: 'gpu-dra', util: 15, used: 8000, free: 72000, temp: 38 },
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
  return [...RUNNING, DRA[1]].every((p) => ready(p.metadata.name)) && by['gpu-done']?.status?.phase === 'Succeeded' && by['gpu-failed']?.status?.phase === 'Failed' &&
    by['gpu-waiting']?.status?.conditions?.some((c: Obj) => c.type === 'PodScheduled' && c.status === 'False')
}
// the pods an allocated claim is reserved for (status.reservedFor), as kubectl has the claims
const draHolders = () => new Set((JSON.parse(kubectl('get resourceclaims -A -o json')).items as Obj[])
  .filter((c) => c.status?.allocation)
  .flatMap((c) => (c.status.reservedFor ?? []).filter((r: Obj) => r.resource === 'pods' && !r.apiGroup).map((r: Obj) => `${c.metadata.namespace}/${r.name}`)))

// More statuses and nodes than the GPU Pods charts used to show (five and four): three Node objects without a kubelet,
// made as number-check-gpu-vendors.spec.ts makes its own (NotReady, a NoSchedule taint of their own and no
// kubernetes.io/os label so no DaemonSet lands there, nvidia.com/gpu 4 so kubectl describe node counts what is bound
// there), a pod bound to each (Pending), and two pods on test2's node whose init container waits (Init:0/1) or fails
// (Init:Error) — six statuses, five nodes with the pods no node took. Made for a test and removed after.
const FAKE = 'kubeast.dev/e2e-fake-gpu-node'
const FAR = [1, 2, 3].map((n) => ({ node: `${CLUSTER}-gpu-pods-${n}`, pod: `gpu-far-${n}`, gpus: n }))
const MORE_PODS = [
  pod('gpu-init-waits', { initContainers: [box('prep', SLEEP, MIG(1))], containers: [box('app', SLEEP, MIG(1))] }),
  pod('gpu-init-fails', { restartPolicy: 'Never', initContainers: [box('prep', ['sh', '-c', 'exit 1'], MIG(1))], containers: [box('app', SLEEP, MIG(1))] }),
  ...FAR.map((f) => {
    const p = pod(f.pod, { nodeName: f.node, tolerations: [{ operator: 'Exists' }], containers: [box('app', SLEEP, GPU(f.gpus))] })
    return { ...p, metadata: { ...p.metadata, labels: { [FAKE]: 'true' } } }
  }),
]
const fakeNode = (name: string) => ({
  apiVersion: 'v1', kind: 'Node', metadata: { name, labels: { 'kubernetes.io/hostname': name, [FAKE]: 'true' } },
  spec: { taints: [{ key: FAKE, value: 'true', effect: 'NoSchedule' }] },
})
function dropMore() {
  for (const s of [
    `delete pods -n ${NS} -l ${FAKE} --grace-period=0 --force --ignore-not-found`,
    `delete pods -n ${NS} gpu-init-waits gpu-init-fails --ignore-not-found --wait=true`,
    `delete nodes ${FAR.map((f) => f.node).join(' ')} --ignore-not-found --wait=true --timeout=120s`,
  ]) { try { kubectl(s) } catch { /* the next step still runs */ } }
}
async function addMore() {
  dropMore()
  try {
    kubectl('create -f -', list(FAR.map((f) => fakeNode(f.node))))
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    const r = { cpu: '8', memory: '64Gi', pods: '110', 'nvidia.com/gpu': '4' }
    const file = path.join(path.dirname(kcPath), 'fake-node-status.json')
    fs.writeFileSync(file, JSON.stringify({ status: { capacity: r, allocatable: r,
      conditions: [{ type: 'Ready', status: 'False', reason: 'KubeletNotReady', message: 'no kubelet (e2e)', lastHeartbeatTime: now, lastTransitionTime: now }] } }))
    for (const f of FAR) kubectl(`patch node ${f.node} --subresource=status --type=merge --patch-file ${file}`)
    kubectl('apply -f -', list(MORE_PODS))
    await waitFor('the pods of more statuses and nodes', () => {
      const by = Object.fromEntries(podsOf().map((p) => [p.metadata.name, p]))
      return !!by['gpu-init-waits']?.status?.initContainerStatuses?.[0]?.state?.running && by['gpu-init-fails']?.status?.phase === 'Failed' &&
        FAR.every((f) => by[f.pod]?.spec?.nodeName === f.node && by[f.pod]?.status?.phase === 'Pending')
    }, 120_000)
  } catch (e) {
    dropMore()
    throw e
  }
}

let prepared = ''
const nodeGpus = () => { try { return kubectl(`get node ${NODE} -o jsonpath='{.status.allocatable.nvidia\\.com/gpu}'`) } catch { return '' } }
const exporterThere = () => { try { return kubectl('-n monitoring get deploy dcgm-exporter -o name') !== '' } catch { return false } }
const draThere = () => { try { return kubectl(`get deviceclass ${DRA_CLASS} -o name`) !== '' } catch { return false } }

test.describe('number check — GPU Dashboard, GPU Nodes, GPU Pods', () => {
  test.beforeAll(async () => {
    test.setTimeout(400_000)
    if (!kc || !nodeGpus() || !exporterThere() || !draThere()) return
    // a stopped run's pods on the nodes without a kubelet would hold the namespace's deletion
    dropMore()
    kubectl(`delete namespace ${NS} --wait=true --timeout=180s --ignore-not-found`)
    kubectl('apply -f -', list([{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } }, ...ENDED]))
    await waitFor('the ended pods', () => podsOf().filter((p) => ended(p)).length === ENDED.length)
    kubectl('apply -f -', list([...RUNNING, WAITING, ...DRA]))
    await waitFor('the GPU pods settled', settled)
    writeMetrics('/www/metrics', exposition(PLAIN, 'hostname'))
    writeMetrics('/www/exported/metrics', exposition(EXPORTED, 'Hostname'))
    // the seed's GPUs gone and the nine here scraped
    await waitFor('the DCGM series in Prometheus', () => promValue(`count(${ALL_DCGM.replace('}', ',UUID=~"GPU-e2e-num-.*"}')})`) === 36 && promValue(`count(${ALL_DCGM})`) === 36, 60_000)
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
    // Node allocation is a page of nodes at a time: every page's bars
    const nodeBars = await readEveryPage(page, 'gpu-node-allocation-pager', () => page.locator('[data-testid="gpu-node-allocation"]').evaluateAll((els) => els.map((n) => [
      n.getAttribute('data-node') ?? '', {
        value: (n.querySelector('[data-testid="gpu-node-allocation-value"]') as HTMLElement | null)?.innerText.trim() ?? null,
        status: [...n.querySelectorAll('.badge')].map((b) => (b.textContent ?? '').trim()).join(','),
      }] as const)))
    const got = await page.evaluate(() => {
      const text = (el: Element | null) => (el as HTMLElement | null)?.innerText.trim() ?? null
      const all = (sel: string) => [...document.querySelectorAll(sel)]
      return {
        cards: Object.fromEntries(all('[data-testid="gpu-summary-card"]').map((c) => [text(c.querySelector('p')), text(c.querySelector('[data-testid="gpu-summary-value"]'))])),
        note: text(document.querySelector('[data-testid="gpu-summary-note"]')),
        readiness: text(document.querySelector('[data-testid="gpu-node-readiness"]')),
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
    const byName = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
    same('node bars', byName(Object.fromEntries(nodeBars)), byName(want.nodes))
    same('node bars listed once', nodeBars.length, c.nodes.length)
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
    // the chart's selector labels (templateLabels in its _helpers.tpl)
    const labels = { 'app.kubernetes.io/name': 'nvidia-device-plugin', 'app.kubernetes.io/instance': PLUGIN.release }
    const ds = JSON.stringify({
      apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: PLUGIN.name, namespace: PLUGIN.namespace, labels },
      spec: {
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: { terminationGracePeriodSeconds: 0, containers: [box('plugin', SLEEP, undefined, { readinessProbe: { exec: { command: ['test', '-f', '/tmp/ready'] }, periodSeconds: 2 } })] },
        },
      },
    })
    const dsStatus = () => JSON.parse(kubectl(`-n ${PLUGIN.namespace} get ds ${PLUGIN.name} -o json`)).status
    let made = false
    let madeNamespace = false
    try {
      test.skip(kubectl(`-n ${PLUGIN.namespace} get ds ${PLUGIN.name} --ignore-not-found -o name`) !== '', `${PLUGIN.namespace}/${PLUGIN.name} is there already`)
      await page.goto(url('/gpu/dashboard'))
      await expect(badge, 'no DaemonSet of the names Kubeast looks for').toHaveText('Device Plugin Not Found', { timeout: 30_000 })
      await expect(page.getByTestId('gpu-plugin-detail')).toHaveCount(0)
      await expect(page.getByTestId('gpu-plugin-note')).toHaveText(/^NVIDIA device plugin: not under the names Kubeast looks for\./)

      if (kubectl(`get namespace ${PLUGIN.namespace} --ignore-not-found -o name`) === '') {
        kubectl(`create namespace ${PLUGIN.namespace}`)
        madeNamespace = true
      }
      kubectl('apply -f -', ds)
      made = true
      await waitFor('the plugin pod scheduled, not ready', () => { const s = dsStatus(); return s.desiredNumberScheduled === 1 && s.numberReady === 0 }, 60_000)
      await expect(async () => {
        await page.reload()
        await expect(badge).toHaveText('Device Plugin Unhealthy', { timeout: 5_000 })
        await expect(page.getByTestId('gpu-plugin-note')).toHaveCount(0)
        await expect(page.getByTestId('gpu-plugin-detail')).toHaveText(new RegExp(`^Plugin: ${dsStatus().numberReady}/${dsStatus().desiredNumberScheduled} ready$`, 'i'), { timeout: 5_000 })
      }).toPass({ timeout: 60_000 })

      // scheduled is not started: exec needs the container running
      await waitFor('the plugin container running', () => kubectl(`-n ${PLUGIN.namespace} get pods -l app.kubernetes.io/instance=${PLUGIN.release} -o jsonpath={.items[0].status.containerStatuses[0].state.running.startedAt}`) !== '', 60_000)
      kubectl(`-n ${PLUGIN.namespace} exec ds/${PLUGIN.name} -- touch /tmp/ready`)
      await waitFor('the plugin pod ready', () => dsStatus().numberReady === 1, 60_000)
      await expect(async () => {
        await page.reload()
        await expect(badge).toHaveText('Device Plugin Healthy', { timeout: 5_000 })
        await expect(page.getByTestId('gpu-plugin-detail')).toHaveText(/^Plugin: 1\/1 ready$/i, { timeout: 5_000 })
      }).toPass({ timeout: 60_000 })
    } finally {
      if (made) kubectl(`-n ${PLUGIN.namespace} delete ds ${PLUGIN.name} --ignore-not-found --wait=true`)
      if (madeNamespace) kubectl(`delete namespace ${PLUGIN.namespace} --ignore-not-found --wait=true --timeout=120s`)
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
    // GPU Feature Discovery's label is a number of mebibytes: the screen gives it its unit
    const memory = (n: Cluster['nodes'][number]) => (n.labels['nvidia.com/gpu.memory'] ? `${n.labels['nvidia.com/gpu.memory']} MiB` : '-')
    const want = async () => {
      const c = await cluster()
      const ready = c.nodes.filter((n) => readinessOf(n.status) === 'Ready').length
      return {
        cards: { 'Total Nodes': String(c.nodes.length), Ready: String(ready), 'Not Ready': String(c.nodes.length - ready),
          'GPU Capacity': String(c.nodes.reduce((s, n) => s + n.capacity, 0)), Allocatable: String(c.nodes.reduce((s, n) => s + n.allocatable, 0)), 'In Use': String(c.used) },
        rows: c.nodes.map((n) => [n.name, label(n, 'gpu.product'), memory(n), String(n.capacity), String(n.allocatable), n.status, label(n, 'mig.strategy')]).sort(),
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
    // the hosts are a page at a time: every page's
    const readHosts = async () => Object.fromEntries(await readEveryPage(page, 'gpu-nodes-host-pager', () => page.locator('[data-testid="gpu-nodes-host"]').evaluateAll((els) => els.map((h) => [h.getAttribute('data-host') ?? '', {
      gpus: Object.fromEntries([...h.querySelectorAll('[data-testid="gpu-nodes-gpu"]')].map((g) => [g.getAttribute('data-uuid'),
        [g.querySelector('[data-testid="gpu-nodes-core"]')?.textContent, g.querySelector('[data-testid="gpu-nodes-mem"]')?.textContent]])),
      avg: [h.querySelector('[data-testid="gpu-nodes-avg-core"]')?.textContent, h.querySelector('[data-testid="gpu-nodes-avg-mem"]')?.textContent],
    }] as const))))
    await expect.poll(readHosts, { timeout: 45_000, message: 'real-time GPUs by host' }).toEqual(Object.fromEntries(hosts.map((h) => [h, {
      gpus: Object.fromEntries(Object.entries(perGpu).map(([u, v]) => [u, [`${Math.round(v)}%`, `${Math.round(memPct[u])}%`]])),
      avg: [`Avg Core: ${avgCore[h]}%`, `Avg Mem: ${avgMem[h]}%`],
    }])))
  })

  // ── GPU Pods ──────────────────────────────────────────────────────────────────────────────────────────────────────

  test('GPU Pods: the cards, rows with each pod\'s GPUs from Prometheus, and the charts of every status and node are the cluster\'s', async ({ page }) => {
    test.setTimeout(300_000)
    await prepare(page)
    // each pod's GPUs: the utilization their mean, the memory the used of their total — the pod as exported_pod or pod
    const util = Object.fromEntries(promQuery(`avg by (p_namespace, p_pod) (${coalesce('DCGM_FI_DEV_GPU_UTIL')})`)
      .map((s) => [`${s.metric.p_namespace}/${s.metric.p_pod}`, `${Math.round(Number(s.value[1]))}%`]))
    const used = `sum by (p_namespace, p_pod) (${coalesce('DCGM_FI_DEV_FB_USED')})`
    const mem = Object.fromEntries(promQuery(`${used} / (${used} + sum by (p_namespace, p_pod) (${coalesce('DCGM_FI_DEV_FB_FREE')})) * 100`)
      .map((s) => [`${s.metric.p_namespace}/${s.metric.p_pod}`, `${Math.round(Number(s.value[1]))}%`]))
    expect(Object.keys(util).filter((k) => k.startsWith(`${NS}/`)).sort(), 'pods named by pod and by exported_pod')
      .toEqual([`${NS}/gpu-dra`, `${NS}/gpu-init`, `${NS}/gpu-one`, `${NS}/gpu-two-boxes`, `${NS}/gpu-two-cards`])

    await addMore()
    try {
      await gpuPodsMatch(page, util, mem)
    } finally {
      dropMore()
    }
  })

  async function gpuPodsMatch(page: Page, util: Record<string, string>, mem: Record<string, string>) {
    await page.goto(url('/gpu/pods'))
    const want = async () => {
      const c = await cluster()
      return {
        cards: {
          'Total Pods': String(c.pods.length), Running: String(podCards(c.pods).running),
          Pending: String(podCards(c.pods).pending),
          Failed: String(podCards(c.pods).failed),
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

    // Metrics: GPUs and pods by node (the pods no node has taken as one row), the statuses kubectl prints — every one
    await page.getByRole('button', { name: /^(Metrics|메트릭)/ }).click()
    const c = await cluster()
    const { byNode, statuses } = chartsOf(c)
    // more than the five statuses and four nodes the charts used to cut to
    expect({ statuses: [...statuses.keys()].sort(), nodes: byNode.size }, 'the fixture\'s statuses and nodes')
      .toEqual({ statuses: ['Completed', 'Error', 'Init:0/1', 'Init:Error', 'Pending', 'Running'], nodes: 5 })
    // GPU Usage by Node is a page of nodes at a time: every page's
    const charts = async () => ({
      nodes: (await readEveryPage(page, 'gpu-pods-node-usage-pager', () => page.locator('[data-testid="gpu-pods-node-usage"]').evaluateAll((els) =>
        els.map((r) => [r.getAttribute('data-node'), (r as HTMLElement).innerText.replace(/\s+/g, '')])))).sort(),
      statuses: await page.locator('[data-testid="gpu-pods-status-row"]').evaluateAll((els) => els.map((r) => (r as HTMLElement).innerText.replace(/\s+/g, '')).sort()),
    })
    await expect.poll(charts, { timeout: 20_000, message: 'GPU Pods charts' }).toEqual({
      nodes: [...byNode].map(([n, e]) => [n, `${n || 'Notscheduled'}${e.pods}pod${e.pods === 1 ? '' : 's'}${e.gpus}GPU${e.gpus === 1 ? '' : 's'}`]).sort(),
      statuses: [...statuses].map(([s, n]) => `${s}${n}(${pct(n, c.pods.length)}%)`).sort(),
    })
  }
  test('GPU Pods: a pod crashing under the phase Running is in the Failed card and not in Running', async ({ page }) => {
    test.setTimeout(240_000)
    await prepare(page)
    const name = 'gpu-crash'
    kubectl('apply -f -', list([pod(name, { containers: [box('app', ['false'], GPU(1))] })]))
    try {
      // it goes between CrashLoopBackOff and Error and is Running for a moment: the cards are read with kubectl until both say so
      await expect.poll(async () => {
        await page.goto(url('/gpu/pods'))
        await page.locator('main table tbody tr').filter({ hasText: name }).first().waitFor({ timeout: 20_000 })
        const { cards } = await readPage(page)
        const c = await cluster()
        const crash = c.pods.find((p) => p.name === name)
        const want = podCards(c.pods)
        return {
          kubectl: { phase: crash?.phase, namesError: namesError(crash?.status ?? '') },
          cards: bare({ Running: cards.Running, Pending: cards.Pending, Failed: cards.Failed }) === bare({ Running: String(want.running), Pending: String(want.pending), Failed: String(want.failed) }),
          one: want.running + want.pending + want.failed + c.pods.filter((p) => p.phase === 'Succeeded').length === c.pods.length,
        }
      }, { timeout: 150_000, intervals: [3_000], message: 'the cards while kubectl prints it crashing' }).toEqual({ kubectl: { phase: 'Running', namesError: true }, cards: true, one: true })
    } finally {
      kubectl(`delete pod ${name} -n ${NS} --ignore-not-found --grace-period=0 --force`)
      await waitFor('the crashing pod gone', () => !podsOf().some((p) => p.metadata.name === name), 60_000)
    }
  })

  // the GPU Pods charts as kubectl has the pods: GPUs and pods by node ('' for no node), pods by STATUS
  function chartsOf(c: Cluster) {
    const byNode = new Map<string, { pods: number; gpus: number }>()
    for (const p of c.pods) { const e = byNode.get(p.node) ?? { pods: 0, gpus: 0 }; byNode.set(p.node, { pods: e.pods + 1, gpus: e.gpus + p.gpus }) }
    const statuses = new Map<string, number>()
    for (const p of c.pods) statuses.set(p.status, (statuses.get(p.status) ?? 0) + 1)
    return { byNode, statuses }
  }

  // ── real-time metrics on the dashboard ───────────────────────────────────────────────────────────────────────────

  test('GPU Dashboard: the real-time GPU numbers are what Prometheus answers, a GPU\'s pod named only when it asks for GPUs or holds a DRA claim', async ({ page }) => {
    test.setTimeout(150_000)
    await prepare(page)
    const q = (expr: string) => promValue(expr)
    const usedMiB = q('sum(DCGM_FI_DEV_FB_USED)')
    const totalMiB = usedMiB + q('sum(DCGM_FI_DEV_FB_FREE)')
    const c = await cluster()
    // the pods asking for GPUs and those an allocated ResourceClaim is reserved for
    const gpuPods = new Set([...c.pods.map((p) => p.key), ...draHolders()])
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
    // the fixture's edges: a GPU at 0 °C still names its pod; an idle GPU scraped as the exporter's pod names none; the
    // GPU of a pod asking for none but holding a DRA claim names it
    expect(want.gpus['GPU-e2e-num-1'], 'GPU 1').toMatchObject({ temp: null, pod: `Pod: ${NS}/gpu-two-cards` })
    expect(want.gpus['GPU-e2e-num-7'], 'GPU 7').toMatchObject({ pod: null })
    expect({ asks: c.pods.some((p) => p.key === `${NS}/gpu-dra`), gpu8: want.gpus['GPU-e2e-num-8']?.pod }, 'GPU 8')
      .toEqual({ asks: false, gpu8: `Pod: ${NS}/gpu-dra` })
    await page.goto(url('/gpu/dashboard'))
    await expect.poll(async () => ({
      ...(await page.evaluate(() => {
        const text = (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? null
        return {
          detected: text('[data-testid="gpu-realtime-detected"]'),
          count: text('[data-testid="gpu-realtime-count"]'),
          avgUtil: text('[data-testid="gpu-realtime-avg-util"]'),
          avgMem: text('[data-testid="gpu-realtime-avg-mem"]'),
          memUsed: text('[data-testid="gpu-realtime-mem-used"]'),
          memTotal: text('[data-testid="gpu-realtime-mem-total"]'),
        }
      })),
      // the hosts are a page at a time: every page's GPUs
      gpus: Object.fromEntries(await readEveryPage(page, 'gpu-realtime-pager', () => page.locator('[data-testid="gpu-realtime-gpu"]').evaluateAll((els) => els.map((g) => {
        const text = (sel: string) => (g.querySelector(sel) as HTMLElement | null)?.innerText.trim() ?? null
        return [g.getAttribute('data-uuid') ?? '', {
          host: g.closest('[data-testid="gpu-realtime-host"]')?.getAttribute('data-host'),
          core: text('[data-testid="gpu-realtime-core"]'), mem: text('[data-testid="gpu-realtime-mem"]'),
          temp: text('[data-testid="gpu-realtime-temp"]'), pod: text('[data-testid="gpu-realtime-pod"]'),
        }] as const
      })))),
    }), { timeout: 45_000, message: 'real-time GPU metrics' }).toEqual(want)
  })

  // ── the node drawer ───────────────────────────────────────────────────────────────────────────────────────────────

  test('the Node drawer\'s GPU rows are the node\'s labels and GPUs: the driver is cuda.driver, CUDA cuda.runtime', async ({ page }) => {
    await prepare(page)
    const n = JSON.parse(kubectl(`get node ${NODE} -o json`))
    const l = n.metadata.labels
    const want: [string, string][] = [
      // the node's GPUs are NVIDIA's (AMD's and Intel's: number-check-gpu-vendors.spec.ts)
      ['GPU Vendor', gpusIn(n.status.capacity) > 0 ? 'NVIDIA' : '-'],
      ['GPU Product', l['nvidia.com/gpu.product']],
      ['GPU Memory', `${l['nvidia.com/gpu.memory']} MiB`],
      ['GPU Count (Capacity)', String(gpusIn(n.status.capacity))],
      ['GPU Count (Allocatable)', String(gpusIn(n.status.allocatable))],
      ['MIG Strategy', l['nvidia.com/mig.strategy']],
      ['CUDA Version', l['nvidia.com/cuda.runtime-version.full']],
      ['Driver Version', l['nvidia.com/cuda.driver-version.full']],
      ['GPU Family', l['nvidia.com/gpu.family']],
      ['GPU Compute Capability', `${l['nvidia.com/gpu.compute.major']}.${l['nvidia.com/gpu.compute.minor']}`],
    ]
    expect(want.slice(5, 8), 'the labels kind-gpu.sh writes').toEqual([['MIG Strategy', 'mixed'], ['CUDA Version', '13.0'], ['Driver Version', '580.95.05']])
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
    test.setTimeout(300_000)
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

    // GPU Pods with more statuses and nodes than the charts used to show: the chat is told every one (compared by name)
    await addMore()
    try {
      const m = await cluster()
      const { byNode, statuses } = chartsOf(m)
      const byName = (s: Obj) => s && {
        ...s,
        by_status: s.by_status && [...s.by_status].sort((a: Obj, b: Obj) => a.status.localeCompare(b.status)),
        by_node: s.by_node && [...s.by_node].sort((a: Obj, b: Obj) => String(a.node ?? '').localeCompare(String(b.node ?? ''))),
      }
      await page.goto(url('/gpu/pods'))
      await expect.poll(async () => byName((await ask())?.stats), { timeout: 30_000 }).toEqual(byName({
        // as the table says: a pod crashing under the phase Running counts, a finished one does not
        total: m.pods.length, total_gpu_requested: m.used + m.waiting, not_running: m.pods.filter((p) => !['Running', 'Completed', 'Succeeded'].includes(p.status)).length,
        // the cards' numbers, which the table's words do not give
        ...podCards(m.pods), namespaces: new Set(m.pods.map((p) => p.namespace)).size,
        // every GPU pod here asks for NVIDIA's
        by_vendor: [{ vendor: 'NVIDIA', pods: m.pods.length, requested: m.used + m.waiting }],
        by_status: [...statuses].map(([status, pods]) => ({ status, pods })),
        by_node: [...byNode].map(([node, e]) => ({ node: node || null, pods: e.pods, gpus: e.gpus })),
      }))
      expect({ statuses: statuses.size, nodes: byNode.size }, 'more than five statuses and four nodes').toEqual({ statuses: 6, nodes: 5 })
    } finally {
      dropMore()
    }
  })

  // ── the AI tool ───────────────────────────────────────────────────────────────────────────────────────────────────────

  const mcpOn = async (request: APIRequestContext, headers: Record<string, string>) => {
    const config = await request.get('/api/v1/ai/mcp/config', { headers })
    return config.ok() && !!(await config.json()).enabled
  }
  const gpuTool = async (request: APIRequestContext, authorization: string) => {
    const res = await request.post('/api/v1/ai/mcp', {
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: authorization },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gpu', arguments: { cluster: CLUSTER } } },
      failOnStatusCode: false,
    })
    expect(res.status(), await res.text()).toBe(200)
    const result = (await res.json()).result
    expect(result.isError, result.content?.[0]?.text).toBeFalsy()
    return JSON.parse(result.content[0].text) as Obj
  }

  test('the AI tool gpu answers what the screens read and count, kubectl\'s GPUs and Prometheus\'s DCGM', async ({ page, request }) => {
    test.setTimeout(180_000)
    await prepare(page)
    const headers = await admin(request)
    test.skip(!(await mcpOn(request, headers)), 'needs the MCP server (mcp.enabled in the dev values)')
    const read = async (p: string) => {
      const res = await request.get(`/api/v1/cluster/${p}?cluster=${CLUSTER}`, { headers })
      expect(res.ok(), `${p}: ${res.status()}`).toBeTruthy()
      return res.json() as Obj
    }
    await expect(async () => {
      const c = await cluster()
      const [dashboard, metrics, classes, templates] = await Promise.all([read('gpu/dashboard'), read('gpu/metrics'), read('deviceclasses'), read('resourceclaimtemplates/all')])
      const tool = await gpuTool(request, headers.Authorization)

      const left = (n: { allocatable: number; used: number }) => Math.max(0, n.allocatable - n.used)
      const alloc = c.nodes.reduce((s, n) => s + n.allocatable, 0)
      expect({ capacity: tool.total_gpu_capacity, allocatable: tool.total_gpu_allocatable, used: tool.total_gpu_used, waiting: tool.total_gpu_waiting, free: tool.total_gpu_free, rate: tool.allocation_rate }, 'kubectl').toEqual({
        capacity: c.nodes.reduce((s, n) => s + n.capacity, 0), allocatable: alloc, used: c.used, waiting: c.waiting, free: c.nodes.reduce((s, n) => s + left(n), 0), rate: pct(c.used, alloc),
      })
      expect({ capacity: tool.total_gpu_capacity, allocatable: tool.total_gpu_allocatable, used: tool.total_gpu_used, waiting: tool.total_gpu_waiting }, 'the dashboard API').toEqual({
        capacity: dashboard.total_gpu_capacity, allocatable: dashboard.total_gpu_allocatable, used: dashboard.total_gpu_used, waiting: dashboard.total_gpu_waiting,
      })
      const ready = c.nodes.filter((n) => readinessOf(n.status) === 'Ready').length
      expect(tool.node_counts).toEqual({ total: c.nodes.length, ready, not_ready: c.nodes.length - ready })
      expect(tool.pod_counts).toEqual({
        total: c.pods.length,
        ...podCards(c.pods),
        requested: c.pods.filter((p) => !p.ended).reduce((s, p) => s + p.gpus, 0),
        namespaces: new Set(c.pods.map((p) => p.namespace)).size,
      })
      expect(Object.fromEntries(tool.gpu_nodes.map((n: Obj) => [n.name, [n.gpu_capacity, n.gpu_allocatable, n.gpu_used, n.gpu_free, n.status]])), 'each node').toEqual(
        Object.fromEntries(c.nodes.map((n) => [n.name, [n.capacity, n.allocatable, n.used, left(n), n.status]])))
      expect(Object.fromEntries(tool.gpu_pods.map((p: Obj) => [`${p.namespace}/${p.name}`, [p.gpu_requested, p.status, p.node_name ?? '']])), 'each pod').toEqual(
        Object.fromEntries(c.pods.map((p) => [p.key, [p.gpus, p.status, p.node]])))
      expect(tool.vendors.map(({ free: _free, nodes: _nodes, ...v }: Obj) => v)).toEqual(dashboard.vendors)
      expect(tool.device_plugins.map(({ state: _state, ...p }: Obj) => p)).toEqual(dashboard.device_plugins)
      expect({ mig: tool.mig_enabled, slicing: tool.time_slicing_enabled }).toEqual({ mig: dashboard.mig_enabled, slicing: dashboard.time_slicing_enabled })

      const { available, gpu_count, avg_gpu_util, avg_memory_util, total_memory_used_mb, total_memory_free_mb, total_memory_mb } = metrics
      expect(tool.utilization).toEqual({ available, gpu_count, avg_gpu_util, avg_memory_util, total_memory_used_mb, total_memory_free_mb, total_memory_mb })
      expect(tool.utilization.gpu_count, 'as Prometheus counts them').toBe(promValue('count(DCGM_FI_DEV_GPU_UTIL)'))
      expect(tool.utilization.avg_gpu_util).toBeCloseTo(promValue('avg(DCGM_FI_DEV_GPU_UTIL)'), 6)
      // a GPU's pod is named when it asks for GPUs or holds a DRA claim, a temperature of 0 is not there
      const gpuRow = (g: G) => tool.gpus.find((r: Obj) => r.uuid === `GPU-e2e-num-${g.gpu}`)
      for (const g of [...PLAIN, ...EXPORTED]) {
        expect({ util: gpuRow(g)?.gpu_util, used: gpuRow(g)?.memory_used_mb, temp: gpuRow(g)?.memory_temp, pod: gpuRow(g)?.pod }, `GPU ${g.gpu}`).toEqual({
          util: g.util, used: g.used, temp: g.temp || null, pod: g.pod ? `${NS}/${g.pod}` : undefined,
        })
      }
      // the screens' podGpuUsage: the mean of its GPUs, the used of their memory
      const usage = tool.gpu_pods.find((p: Obj) => p.name === 'gpu-two-cards')?.gpu_usage
      expect(usage).toEqual({ gpus: 2, gpu_util: 60, memory_util_percent: (100000 / 160000) * 100 })

      expect(tool.device_classes.map((d: Obj) => d.name)).toEqual(classes.map((d: Obj) => d.name))
      expect(tool.device_classes.map((d: Obj) => d.name)).toContain(DRA_CLASS)
      expect(tool.resource_claim_templates.map((t: Obj) => t.name)).toEqual(templates.map((t: Obj) => t.name))
      expect(tool.refused, 'an admin is refused nothing').toBeUndefined()
    }).toPass({ timeout: 90_000, intervals: [5_000] })
  })

  // A GPU missing a series: GPU 2 reports no utilization, GPU 0 no free memory and no temperature. The screens, the API and
  // the tool say "-" or null for those, and their averages are Prometheus's, which leaves a missing series out.
  test('a GPU that reports only some of its series reads "-" and null, not 0, and the averages are Prometheus\'s', async ({ page, request }) => {
    test.setTimeout(240_000)
    await prepare(page)
    const without = (body: string, gpu: number, names: string[]) =>
      body.split('\n').filter((l) => !(l.includes(`UUID="GPU-e2e-num-${gpu}"`) && names.some((n) => l.startsWith(`${n}{`)))).join('\n')
    const partial = without(without(exposition(PLAIN, 'hostname'), 2, ['DCGM_FI_DEV_GPU_UTIL']), 0, ['DCGM_FI_DEV_FB_FREE', 'DCGM_FI_DEV_MEMORY_TEMP'])
    const headers = await admin(request)
    const read = async () => {
      const res = await request.get(`/api/v1/cluster/gpu/metrics?cluster=${CLUSTER}`, { headers })
      expect(res.ok(), `gpu/metrics: ${res.status()}`).toBeTruthy()
      return res.json() as Promise<Obj>
    }
    const row = (rows: Obj[], gpu: number) => rows.find((r) => r.uuid === `GPU-e2e-num-${gpu}`)
    try {
      writeMetrics('/www/metrics', partial)
      await waitFor('the partial series in Prometheus', () => promValue('count(DCGM_FI_DEV_GPU_UTIL{UUID=~"GPU-e2e-num-.*"})') === 8 && promValue('count(DCGM_FI_DEV_FB_FREE{UUID=~"GPU-e2e-num-.*"})') === 8, 60_000)
      const avgUtil = promValue('avg(DCGM_FI_DEV_GPU_UTIL)')

      await test.step('the API', async () => {
        await expect(async () => {
          const metrics = await read()
          expect({ count: metrics.gpu_count, util: row(metrics.gpus, 2)?.gpu_util, total: row(metrics.gpus, 0)?.memory_total_mb, percent: row(metrics.gpus, 0)?.memory_util_percent, temp: row(metrics.gpus, 0)?.memory_temp })
            .toEqual({ count: 9, util: null, total: null, percent: null, temp: null })
          expect(metrics.avg_gpu_util).toBeCloseTo(avgUtil, 6)
          // both memory series only: GPU 0 reports used alone
          expect(metrics.total_memory_used_mb).toBe(promValue('sum(DCGM_FI_DEV_FB_USED and on (UUID) DCGM_FI_DEV_FB_FREE)'))
          expect(metrics.total_memory_free_mb).toBe(promValue('sum(DCGM_FI_DEV_FB_FREE)'))
        }).toPass({ timeout: 60_000, intervals: [3_000] })
      })

      await test.step('GPU Dashboard', async () => {
        await page.goto(url('/gpu/dashboard'))
        const gpu = (n: number) => page.locator(`[data-testid="gpu-realtime-gpu"][data-uuid="GPU-e2e-num-${n}"]`)
        await expect(gpu(2).getByTestId('gpu-realtime-core')).toHaveText('-', { timeout: 30_000 })
        await expect(gpu(0).getByTestId('gpu-realtime-mem')).toHaveText('-')
        await expect(gpu(0).getByTestId('gpu-realtime-temp')).toHaveCount(0)
        // a real 0% stays: GPU 3 idles at 0
        await expect(gpu(3).getByTestId('gpu-realtime-core')).toHaveText('0%')
        await expect(page.getByTestId('gpu-realtime-avg-util')).toHaveText(`${Math.round(avgUtil)}%`)
        await expect(page.getByTestId('gpu-realtime-avg-util')).toHaveAttribute('title', 'The 8 of 9 GPUs that report utilization')
      })

      await test.step('GPU Nodes', async () => {
        await page.goto(url('/gpu/nodes'))
        await page.getByRole('button', { name: /^(Metrics|메트릭)/ }).click()
        const gpu = (n: number) => page.locator(`[data-testid="gpu-nodes-gpu"][data-uuid="GPU-e2e-num-${n}"]`)
        await expect(gpu(2).getByTestId('gpu-nodes-core')).toHaveText('-', { timeout: 30_000 })
        await expect(gpu(0).getByTestId('gpu-nodes-mem')).toHaveText('-')
      })

      await test.step('the AI tool', async () => {
        test.skip(!(await mcpOn(request, headers)), 'needs the MCP server (mcp.enabled in the dev values)')
        await expect(async () => {
          const tool = await gpuTool(request, headers.Authorization)
          expect(row(tool.gpus, 2)?.gpu_util).toBeNull()
          expect(row(tool.gpus, 0)?.memory_used_mb).toBe(20000)
          expect(row(tool.gpus, 0)?.memory_free_mb).toBeNull()
          expect(tool.utilization.avg_gpu_util).toBeCloseTo(avgUtil, 6)
          expect(tool.utilization.note).toContain('1 of the 9 GPUs report no utilization series')
          // gpu-two-cards holds GPUs 1 and 2: the mean of the one that reports
          expect(tool.gpu_pods.find((p: Obj) => p.name === 'gpu-two-cards')?.gpu_usage).toEqual({ gpus: 2, gpu_util: 50, memory_util_percent: (100000 / 160000) * 100 })
          expect(tool.gpu_pods.find((p: Obj) => p.name === 'gpu-one')?.gpu_usage).toEqual({ gpus: 1, gpu_util: 30, memory_util_percent: null })
        }).toPass({ timeout: 60_000, intervals: [3_000] })
      })
    } finally {
      writeMetrics('/www/metrics', exposition(PLAIN, 'hostname'))
      await waitFor('the full series back in Prometheus', () => promValue('count(DCGM_FI_DEV_GPU_UTIL{UUID=~"GPU-e2e-num-.*"})') === 9 && promValue('count(DCGM_FI_DEV_FB_FREE{UUID=~"GPU-e2e-num-.*"})') === 9, 60_000)
    }
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

  test('a grant limited to namespaces reads "-" on the nodes\' GPU cards and is told why, and lists its own GPU pods', async ({ page, browser, request }) => {
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
      // the AI tool: what a card shows as "-" is null and its source named, not zero
      if (await mcpOn(request, headers)) {
        const signedIn = await request.post('/api/v1/auth/login', { data: { email, password } })
        expect(signedIn.ok(), `login ${email}`).toBeTruthy()
        const tool = await gpuTool(request, `Bearer ${(await signedIn.json()).access_token as string}`)
        expect({ capacity: tool.total_gpu_capacity, allocatable: tool.total_gpu_allocatable, used: tool.total_gpu_used, free: tool.total_gpu_free, nodes: tool.gpu_nodes, pods: tool.pod_counts, vendors: tool.vendors, gpus: tool.gpus })
          .toEqual({ capacity: null, allocatable: null, used: null, free: null, nodes: null, pods: null, vendors: null, gpus: null })
        expect(tool.refused.dashboard, 'the cluster refuses the nodes').toContain('forbidden')
        expect(tool.refused.metrics, 'the cluster\'s Prometheus spans the cluster').toContain('limited to namespaces')
        expect(tool.utilization.available).toBeNull()
        expect(tool.null_note).toContain('not counted, not zero')
      }
      await user.goto(url('/gpu/nodes'))
      await expect(user.getByTestId('table-forbidden'), 'GPU Nodes: the table says why').toHaveText(/permission/i, { timeout: 30_000 })
      await expect.poll(async () => (await readPage(user)).cards, { message: 'GPU Nodes: cards' }).toEqual(Object.fromEntries(['Total Nodes', 'Ready', 'Not Ready', 'GPU Capacity', 'Allocatable', 'In Use'].map((l) => [l, '-'])))
      // GPU Pods needs no node: the pods of its namespace that ask for GPUs, as kubectl has them, and no refusal
      const mine = (await cluster()).pods.filter((p) => p.namespace === NS)
      const refused: string[] = []
      user.on('response', (r) => { if (r.status() === 403) refused.push(new URL(r.url()).pathname) })
      await user.goto(url('/gpu/pods'))
      await expect.poll(async () => {
        const { rows, cards } = await readPage(user)
        return { total: cards['Total Pods'], namespaces: cards.Namespaces, rows: rows.map((r) => [r.Namespace, r.Name, r.GPUs, r.Status]).sort() }
      }, { timeout: 30_000, message: 'GPU Pods: its namespace\'s pods' }).toEqual({
        total: String(mine.length), namespaces: '1', rows: mine.map((p) => [p.namespace, p.name, String(p.gpus), p.status]).sort(),
      })
      await expect(user.getByTestId('forbidden-banner'), 'GPU Pods: nothing refused').toHaveCount(0)
      expect(refused, 'requests the cluster refused on GPU Pods').toEqual([])
    } finally {
      await ctx.close()
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers })
      kubectl(`delete rolebinding e2e-gpu-num-read -n ${NS} --ignore-not-found`)
    }
  })
})
