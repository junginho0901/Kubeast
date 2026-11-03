// The numbers the three GPU screens (Dashboard, Nodes, Pods) count from /cluster/gpu/dashboard and /cluster/gpu/metrics.
// The server counts the GPUs as kubectl describe node does (gpu_dashboard.go); these count the rows.

import type { GPUDashboardData, GPUDeviceMetric, GPUNodeInfo, GPUPodInfo } from '@/services/api'
import { nodeReadiness } from '@/utils/nodeStatus'

// A GPU is nvidia.com/gpu or a MIG profile nvidia.com/mig-* (gpu_dashboard.go isGPUResource), in a node's capacity map.
export function gpuCountOf(resources: Record<string, string> | undefined): number | undefined {
  let total: number | undefined
  for (const [name, value] of Object.entries(resources ?? {})) {
    if (name === 'nvidia.com/gpu' || name.startsWith('nvidia.com/mig-')) total = (total ?? 0) + Number(value)
  }
  return total
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

export function gpuNodeCounts(nodes: GPUNodeInfo[]) {
  const ready = nodes.filter((n) => nodeReadiness(n.status) === 'Ready').length
  return { total: nodes.length, ready, notReady: nodes.length - ready }
}

// A status that names an error, as the Pods list's Error card reads it (pods_page.go statusNamesError).
export function statusNamesError(status: string): boolean {
  const s = (status || '').toLowerCase()
  return ['error', 'failed', 'backoff', 'errimagepull', 'oomkilled'].some((w) => s.includes(w))
}

const ended = (p: GPUPodInfo) => p.phase === 'Succeeded' || p.phase === 'Failed'

// The GPU Pods cards: Running and Pending by phase, Failed the phase or a status naming an error (the Pods list's
// Error card), and the GPUs still asked for — of the pods not Succeeded or Failed, on a node or waiting for one.
export function gpuPodCounts(pods: GPUPodInfo[]) {
  return {
    total: pods.length,
    running: pods.filter((p) => p.phase === 'Running').length,
    pending: pods.filter((p) => p.phase === 'Pending').length,
    failed: pods.filter((p) => p.phase === 'Failed' || statusNamesError(p.status)).length,
    requested: pods.filter((p) => !ended(p)).reduce((sum, p) => sum + p.gpu_requested, 0),
    namespaces: new Set(pods.map((p) => p.namespace)).size,
  }
}

export type DevicePluginState = 'healthy' | 'unhealthy' | 'missing'

// Not found under any name Kubeast looks for is not the same as found and not ready.
export function devicePluginState(status: GPUDashboardData['device_plugin_status']): DevicePluginState {
  if (!status) return 'missing'
  return status.ready >= status.desired ? 'healthy' : 'unhealthy'
}

export interface PodGpuUsage {
  gpus: number
  gpu_util: number
  memory_util_percent: number
}

// Each pod's GPUs from DCGM, keyed namespace/name: the utilization the mean of its GPUs' (as the dashboard's average),
// the memory the used of their total (as the dashboard's memory average).
export function podGpuUsage(gpus: GPUDeviceMetric[] | undefined): Map<string, PodGpuUsage> {
  const sums = new Map<string, { n: number; util: number; used: number; total: number }>()
  for (const g of gpus ?? []) {
    if (!g.exported_pod || !g.exported_namespace) continue
    const key = `${g.exported_namespace}/${g.exported_pod}`
    const s = sums.get(key) ?? { n: 0, util: 0, used: 0, total: 0 }
    s.n += 1
    s.util += g.gpu_util
    s.used += g.memory_used_mb
    s.total += g.memory_total_mb
    sums.set(key, s)
  }
  return new Map([...sums].map(([key, s]) => [key, { gpus: s.n, gpu_util: s.util / s.n, memory_util_percent: s.total > 0 ? (s.used / s.total) * 100 : 0 }]))
}
