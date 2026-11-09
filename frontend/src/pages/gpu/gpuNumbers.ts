// The numbers the three GPU screens (Dashboard, Nodes, Pods) count from /cluster/gpu/dashboard and /cluster/gpu/metrics.
// The server counts the GPUs as kubectl describe node does (gpu_dashboard.go); these count the rows.

import type { GPUDashboardData, GPUDevicePlugin, GPUDeviceMetric, GPUMetricsData, GPUNodeInfo, GPUNodeVendor, GPUPodInfo, GPUVendor } from '@/services/api'
import { podNotRunning } from '@/utils/aiContext/podCounts'
import { nodeReadiness } from '@/utils/nodeStatus'
import { getStatusColor as podsListStatusColor } from '../workloads/pods/podHelpers'

// The companies Kubernetes' "Schedule GPUs" names, in the order the screens list them (gpu_dashboard.go gpuVendors).
export const GPU_VENDORS: GPUVendor[] = ['NVIDIA', 'AMD', 'Intel']
const AMD_PARTITION = /^amd\.com\/(spx|dpx|tpx|qpx|cpx)_nps[0-9]+$/

// The company of a resource each of whose devices is one GPU (gpu_dashboard.go gpuVendorOf): NVIDIA's GPUs and MIG
// profiles (renamed .shared by its sharing config too), AMD's GPUs and mixed-strategy partitions, Intel's GPUs by
// kernel driver; not Intel's monitoring resources or its older plugin's millicores, memory.max and tiles, not other
// accelerators.
export function gpuVendorOf(name: string): GPUVendor | undefined {
  if (name === 'nvidia.com/gpu' || name === 'nvidia.com/gpu.shared' || name.startsWith('nvidia.com/mig-')) return 'NVIDIA'
  if (name === 'amd.com/gpu' || AMD_PARTITION.test(name)) return 'AMD'
  if (name === 'gpu.intel.com/i915' || name === 'gpu.intel.com/xe') return 'Intel'
  return undefined
}

// Each company's GPUs in a node's capacity map, in the screens' order.
export function gpuCountsByVendor(resources: Record<string, string> | undefined): [GPUVendor, number][] {
  const by = new Map<GPUVendor, number>()
  for (const [name, value] of Object.entries(resources ?? {})) {
    const vendor = gpuVendorOf(name)
    if (vendor) by.set(vendor, (by.get(vendor) ?? 0) + Number(value))
  }
  return GPU_VENDORS.filter((v) => by.has(v)).map((v) => [v, by.get(v)!])
}

// The GPUs of every company in a node's capacity map, undefined for a node without any.
export function gpuCountOf(resources: Record<string, string> | undefined): number | undefined {
  const counts = gpuCountsByVendor(resources)
  return counts.length ? counts.reduce((sum, [, n]) => sum + n, 0) : undefined
}

// AMD's node labeller writes a property as amd.com/gpu.<name> (and a beta.amd.com copy) when the node's GPUs agree,
// else as amd.com/gpu.<name>.<value> per value (gpu_dashboard.go amdLabel).
function amdLabel(labels: Record<string, string>, name: string): string | undefined {
  const prefixes = ['amd.com/gpu.', 'beta.amd.com/gpu.']
  for (const p of prefixes) if (labels[p + name]) return labels[p + name]
  for (const p of prefixes) {
    const values = Object.keys(labels).filter((k) => k.startsWith(`${p}${name}.`)).map((k) => k.slice(`${p}${name}.`.length)).sort()
    if (values.length) return values.join(', ')
  }
  return undefined
}

// GPU Feature Discovery's label is a number of mebibytes, which it does not say (gpu_dashboard.go gfdMemory); AMD's
// writes its own unit. A value someone wrote by hand with a unit stays as written.
const gfdMemory = (label: string | undefined) => (label && /^\d+$/.test(label) ? `${label} MiB` : label)

// A company's GPU model, memory, driver and family from the labels its tools write: NVIDIA's GPU Feature Discovery,
// AMD's node labeller, Intel's NFD rules (no memory or driver label).
export function gpuVendorLabels(vendor: GPUVendor, labels: Record<string, string>) {
  switch (vendor) {
    case 'NVIDIA':
      return { model: labels['nvidia.com/gpu.product'], memory: gfdMemory(labels['nvidia.com/gpu.memory']), driver: driverVersion(labels), family: labels['nvidia.com/gpu.family'] }
    case 'AMD':
      return { model: amdLabel(labels, 'product-name'), memory: amdLabel(labels, 'vram'), driver: labels['amd.com/gpu.driver-version'], family: amdLabel(labels, 'family') }
    case 'Intel':
      return { model: labels['gpu.intel.com/product'], memory: undefined, driver: undefined, family: labels['gpu.intel.com/family'] }
  }
}

export const vendorNames = (vendors: { vendor: GPUVendor }[] | undefined) => (vendors ?? []).map((v) => v.vendor).join(', ')

// A node bar's words for one company's GPUs: the company and its model ("Intel Max_1550"), the model alone when its
// label already starts with the company's name (NVIDIA-A100-SXM4-40GB, AMD_Instinct_MI300X), then the memory.
export function nodeVendorText(v: GPUNodeVendor, unknown = 'Unknown'): string {
  const named = v.model && v.model.toLowerCase().startsWith(v.vendor.toLowerCase()) ? v.model : `${v.vendor} ${v.model || unknown}`
  return `${named}${v.memory ? ` • ${v.memory}` : ''}`
}

export interface GPUModelEntry {
  count: number
  totalCapacity: number
  totalAllocatable: number
  totalUsed: number
}

// Every model with the nodes that have it and those nodes' GPUs of it — each company's GPUs of a node under its own
// model (a node of two companies is in two models), "Unknown" where its labeller wrote none; most GPUs first.
export function gpuModels(nodes: GPUNodeInfo[]): [string, GPUModelEntry][] {
  const map = new Map<string, GPUModelEntry>()
  for (const node of nodes) {
    for (const v of node.gpu_vendors ?? []) {
      const model = v.model || 'Unknown'
      const e = map.get(model) ?? { count: 0, totalCapacity: 0, totalAllocatable: 0, totalUsed: 0 }
      map.set(model, { count: e.count + 1, totalCapacity: e.totalCapacity + v.capacity, totalAllocatable: e.totalAllocatable + v.allocatable, totalUsed: e.totalUsed + v.used })
    }
  }
  return [...map.entries()].sort((a, b) => b[1].totalCapacity - a[1].totalCapacity)
}

// GPU Feature Discovery's labels: cuda.driver-version.* is the NVIDIA driver's version, cuda.runtime-version.* the CUDA
// version; cuda.driver.* and cuda.runtime.* are their deprecated names (gpu_dashboard.go gpuDriverVersion).
const gfdVersion = (labels: Record<string, string>, name: string, old: string, parts: string[]) => {
  if (labels[`nvidia.com/${name}.full`]) return labels[`nvidia.com/${name}.full`]
  const major = labels[`nvidia.com/${old}.major`]
  if (!major) return undefined
  return [major, ...parts.map((p) => labels[`nvidia.com/${old}.${p}`]).filter(Boolean)].join('.')
}
export const driverVersion = (labels: Record<string, string>) => gfdVersion(labels, 'cuda.driver-version', 'cuda.driver', ['minor', 'rev'])
export const cudaVersion = (labels: Record<string, string>) => gfdVersion(labels, 'cuda.runtime-version', 'cuda.runtime', ['minor'])

// The Node drawer's GPU rows: the companies with GPUs on the node (or whose labeller named a model there), each one's
// model, memory, driver and family from its own labels (joined for a node of two), the GPUs of all of them, and
// NVIDIA's MIG, CUDA and compute capability; a row without a value is left out.
export function nodeGpuRows(labels: Record<string, string>, capacity: Record<string, string>, allocatable: Record<string, string>): [string, string][] {
  const withGpus = gpuCountsByVendor(capacity).map(([v]) => v)
  const vendors = GPU_VENDORS.filter((v) => withGpus.includes(v) || gpuVendorLabels(v, labels).model)
  const each = (pick: (l: ReturnType<typeof gpuVendorLabels>) => string | undefined) =>
    vendors.map((v) => pick(gpuVendorLabels(v, labels))).filter(Boolean).join(', ')
  const count = (resources: Record<string, string>) => {
    const n = gpuCountOf(resources)
    return n === undefined ? '' : String(n)
  }
  const major = labels['nvidia.com/gpu.compute.major']
  const rows: [string, string | undefined][] = [
    ['GPU Vendor', vendors.join(', ')],
    ['GPU Product', each((l) => l.model)],
    ['GPU Memory', each((l) => l.memory)],
    ['GPU Count (Capacity)', count(capacity)],
    ['GPU Count (Allocatable)', count(allocatable)],
    ['MIG Strategy', labels['nvidia.com/mig.strategy']],
    ['CUDA Version', cudaVersion(labels)],
    ['Driver Version', each((l) => l.driver)],
    ['GPU Family', each((l) => l.family)],
    ['GPU Compute Capability', major ? `${major}.${labels['nvidia.com/gpu.compute.minor'] || '0'}` : undefined],
  ]
  return rows.filter((r): r is [string, string] => !!r[1])
}

export function gpuNodeCounts(nodes: GPUNodeInfo[]) {
  const ready = nodes.filter((n) => nodeReadiness(n.status) === 'Ready').length
  return { total: nodes.length, ready, notReady: nodes.length - ready }
}

// A status that names an error, as the Pods list's Error card reads it (pods_page.go statusNamesError).
export function statusNamesError(status: string): boolean {
  const s = (status || '').toLowerCase()
  return ['error', 'failed', 'backoff', 'errimagepull', 'oomkilled'].some((w) => s.includes(w))
}

// A status's colour on the two GPU pod lists is the Pods list's.
export const gpuPodStatusColor = podsListStatusColor

// The bar of a status in a distribution says what its badge says; a pod that finished needs nothing, each screen draws it its way.
export function gpuPodStatusBar(status: string, finished: string): string {
  switch (gpuPodStatusColor(status)) {
    case 'badge-error':
      return 'bg-red-500'
    case 'badge-warning':
      return 'bg-yellow-500'
    case 'badge-success':
      return status === 'Running' ? 'bg-emerald-500' : finished
    default:
      return 'bg-slate-500'
  }
}

const ended = (p: GPUPodInfo) => p.phase === 'Succeeded' || p.phase === 'Failed'

// The GPU Pods cards, a pod in one as on the Pods list: Failed the phase or a status naming an error (its Error card),
// then Running and Pending by phase; and the GPUs still asked for — of the pods not Succeeded or Failed, on a node or
// waiting for one.
export function gpuPodCounts(pods: GPUPodInfo[]) {
  const failing = (p: GPUPodInfo) => p.phase === 'Failed' || statusNamesError(p.status)
  const healthy = pods.filter((p) => !failing(p))
  return {
    total: pods.length,
    running: healthy.filter((p) => p.phase === 'Running').length,
    pending: healthy.filter((p) => p.phase === 'Pending').length,
    failed: pods.length - healthy.length,
    requested: pods.filter((p) => !ended(p)).reduce((sum, p) => sum + p.gpu_requested, 0),
    namespaces: new Set(pods.map((p) => p.namespace)).size,
  }
}

// What the floating chat is told is not running: what the table says, not the phase the cards count.
export function gpuPodsNotRunning(pods: GPUPodInfo[]): GPUPodInfo[] {
  return pods.filter(podNotRunning)
}

// The GPU Pods charts: each STATUS and its pods, and each node ('' for the pods no node has taken) with its pods and
// the GPUs they ask for, the most first — every one of them.
export function gpuPodStatuses(pods: GPUPodInfo[]): [string, number][] {
  const by = new Map<string, number>()
  for (const p of pods) by.set(p.status, (by.get(p.status) ?? 0) + 1)
  return [...by].sort((a, b) => b[1] - a[1])
}

export function gpuPodsByNode(pods: GPUPodInfo[]): [string, { podCount: number; totalGpu: number }][] {
  const by = new Map<string, { podCount: number; totalGpu: number }>()
  for (const p of pods) {
    const e = by.get(p.node_name || '') ?? { podCount: 0, totalGpu: 0 }
    by.set(p.node_name || '', { podCount: e.podCount + 1, totalGpu: e.totalGpu + p.gpu_requested })
  }
  // ties by node name, the pods no node took after them, so the chart's pages keep their nodes between refreshes
  return [...by].sort((a, b) => b[1].totalGpu - a[1].totalGpu || byNodeName(a[0], b[0]))
}

// Node and host names in the order people read them (node-2 before node-10); '' (no node) last.
export function byNodeName(a: string, b: string): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0
  return a.localeCompare(b, undefined, { numeric: true })
}

// The GPUs of each host, hosts by name: a Prometheus answer gives them in any order, and a page of hosts must not
// change its hosts from one refresh to the next.
export function hostsByName(gpusByHost: Map<string, GPUDeviceMetric[]>): [string, GPUDeviceMetric[]][] {
  return [...gpusByHost].sort((a, b) => byNodeName(a[0], b[0]))
}

// The pods a GPU's DCGM series may name (namespace/name): those asking for GPUs and those an allocated DRA claim is
// reserved for. An exporter scraped as its own pod labels an idle GPU's series with that pod, which is neither.
export function gpuHolderPods(data: Pick<GPUDashboardData, 'gpu_pods' | 'dra_pods'>): Set<string> {
  return new Set([...data.gpu_pods, ...(data.dra_pods ?? [])].map((p) => `${p.namespace}/${p.name}`))
}

// The pod a GPU's series names when it is one of those, else ''.
export function gpuSeriesPod(gpu: GPUDeviceMetric, holders: Set<string>): string {
  const key = `${gpu.exported_namespace}/${gpu.exported_pod}`
  return gpu.exported_pod && holders.has(key) ? key : ''
}

export type DevicePluginState = 'healthy' | 'unhealthy' | 'missing'

// Not found under any name Kubeast looks for is not the same as found and not ready.
export function devicePluginState(plugin: GPUDevicePlugin | null | undefined): DevicePluginState {
  if (!plugin?.found) return 'missing'
  return (plugin.ready ?? 0) >= (plugin.desired ?? 0) ? 'healthy' : 'unhealthy'
}

export interface DevicePluginBadge {
  // the company, named on the badge only when the badges are of more than one
  vendor?: GPUVendor
  state: DevicePluginState
  plugin?: GPUDevicePlugin
}

// One badge per company the server lists (its GPUs or its plugin found); with none, one "not found" badge.
export function devicePluginBadges(plugins: GPUDevicePlugin[] | undefined): DevicePluginBadge[] {
  const list = plugins ?? []
  if (list.length === 0) return [{ state: 'missing' }]
  return list.map((p) => ({ vendor: list.length > 1 ? p.vendor : undefined, state: devicePluginState(p), plugin: p }))
}

// The companies whose plugin was looked for and not found, named also when a badge leaves the company out.
export function missingPluginVendors(badges: DevicePluginBadge[]): GPUVendor[] {
  return badges.flatMap((b) => (b.state === 'missing' && b.plugin ? [b.plugin.vendor] : []))
}

// The averages of the GPUs DCGM reports. No series to average is nothing read, not GPUs at 0%: the cards say "-" and the
// floating chat null.
export function gpuRealtimeAverages(metrics: Pick<GPUMetricsData, 'gpu_count' | 'avg_gpu_util' | 'avg_memory_util' | 'total_memory_mb'>) {
  return {
    util: metrics.gpu_count > 0 ? metrics.avg_gpu_util : null,
    memory: (metrics.total_memory_mb ?? 0) > 0 ? metrics.avg_memory_util : null,
  }
}

// A percent as the GPU screens print it: "-" for a value that is not there.
export const gpuPercentText = (value: number | null): string => (value === null ? '-' : `${Math.round(value)}%`)

// The GPUs of a list that report a utilization series, which an average of them leaves the others out of.
export const gpusReportingUtil = (gpus: GPUDeviceMetric[]): number => gpus.filter((g) => g.gpu_util !== null).length

const meanOf = (values: Array<number | null>): number | null => {
  const read = values.filter((v): v is number => v !== null)
  return read.length > 0 ? read.reduce((sum, v) => sum + v, 0) / read.length : null
}

// A host's averages: the mean of its GPUs that have the number.
export function gpuHostAverages(gpus: GPUDeviceMetric[]) {
  return { util: meanOf(gpus.map((g) => g.gpu_util)), memory: meanOf(gpus.map((g) => g.memory_util_percent)) }
}

// The GPUs of each company in use and waiting, its nodes' capacity and allocatable (for the floating chat).
export function gpuVendorCounts(nodes: GPUNodeInfo[]) {
  const by = new Map<GPUVendor, { nodes: number; capacity: number; allocatable: number; used: number }>()
  for (const n of nodes) {
    for (const v of n.gpu_vendors ?? []) {
      const e = by.get(v.vendor) ?? { nodes: 0, capacity: 0, allocatable: 0, used: 0 }
      by.set(v.vendor, { nodes: e.nodes + 1, capacity: e.capacity + v.capacity, allocatable: e.allocatable + v.allocatable, used: e.used + v.used })
    }
  }
  return GPU_VENDORS.filter((v) => by.has(v)).map((vendor) => ({ vendor, ...by.get(vendor)! }))
}

// The pods asking for each company's GPUs and the GPUs they still ask for (not Succeeded or Failed).
export function gpuPodVendorCounts(pods: GPUPodInfo[]) {
  const by = new Map<GPUVendor, { pods: number; requested: number }>()
  for (const p of pods) {
    for (const v of p.gpu_vendors ?? []) {
      const e = by.get(v.vendor) ?? { pods: 0, requested: 0 }
      by.set(v.vendor, { pods: e.pods + 1, requested: e.requested + (ended(p) ? 0 : v.requested) })
    }
  }
  return GPU_VENDORS.filter((v) => by.has(v)).map((vendor) => ({ vendor, ...by.get(vendor)! }))
}

export interface PodGpuUsage {
  gpus: number
  gpu_util: number | null
  memory_util_percent: number | null
}

// Each pod's GPUs from DCGM, keyed namespace/name: the utilization the mean of those that report it (as the dashboard's
// average), the memory the used of the total of those that report both its series (as the dashboard's memory average).
export function podGpuUsage(gpus: GPUDeviceMetric[] | undefined): Map<string, PodGpuUsage> {
  const sums = new Map<string, { n: number; reporting: number; util: number; used: number; total: number }>()
  for (const g of gpus ?? []) {
    if (!g.exported_pod || !g.exported_namespace) continue
    const key = `${g.exported_namespace}/${g.exported_pod}`
    const s = sums.get(key) ?? { n: 0, reporting: 0, util: 0, used: 0, total: 0 }
    s.n += 1
    if (g.gpu_util !== null) {
      s.reporting += 1
      s.util += g.gpu_util
    }
    if (g.memory_total_mb !== null) {
      s.used += g.memory_used_mb ?? 0
      s.total += g.memory_total_mb
    }
    sums.set(key, s)
  }
  return new Map([...sums].map(([key, s]) => [key, {
    gpus: s.n,
    gpu_util: s.reporting > 0 ? s.util / s.reporting : null,
    memory_util_percent: s.total > 0 ? (s.used / s.total) * 100 : null,
  }]))
}
