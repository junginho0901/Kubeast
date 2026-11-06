import { describe, expect, it } from 'vitest'
import type { GPUDeviceMetric, GPUNodeInfo, GPUPodInfo, GPUVendor } from '@/services/api'
import {
  cudaVersion, devicePluginBadges, devicePluginState, driverVersion, gpuCountOf, gpuCountsByVendor, gpuHolderPods, gpuModels, gpuNodeCounts,
  gpuPodCounts, gpuPodStatuses, gpuPodsByNode, gpuPodsNotRunning, gpuPodVendorCounts, gpuSeriesPod, gpuVendorCounts, gpuVendorLabels, gpuVendorOf, nodeGpuRows,
  nodeVendorText, podGpuUsage,
} from './gpuNumbers'
import { getStatusColor as dashboardStatusColor } from './gpu-dashboard/helpers'
import { getStatusColor as gpuPodsStatusColor } from './gpupods/gpuPodsHelpers'

const node = (name: string, status: string): GPUNodeInfo => ({ name, status, gpu_capacity: 1, gpu_allocatable: 1, gpu_used: 0 })
const pod = (name: string, phase: string, status: string, gpus: number, namespace = 'ml'): GPUPodInfo =>
  ({ name, namespace, phase, status, gpu_requested: gpus })
const gpu = (uuid: string, pod: string, util: number, used: number, free: number): GPUDeviceMetric => ({
  uuid, gpu: '0', hostname: 'n1', model_name: 'A100', gpu_util: util, memory_used_mb: used, memory_free_mb: free,
  memory_total_mb: used + free, memory_util_percent: used + free > 0 ? (used / (used + free)) * 100 : 0, memory_temp: 0,
  ...(pod ? { exported_pod: pod, exported_namespace: 'ml' } : {}),
})

describe('GPU screen numbers', () => {
  it('draws a pod being deleted as a warning on both pod lists', () => {
    expect(gpuPodsStatusColor('Terminating')).toBe('badge-warning')
    expect(dashboardStatusColor('Terminating')).toBe('badge-warning')
  })

  // kubectl's STATUS starts with the readiness: a cordoned Ready node is ready, NotReady and Unknown are not
  it('counts a node ready by the readiness kubectl prints first', () => {
    const nodes = ['Ready', 'Ready,SchedulingDisabled', 'NotReady', 'NotReady,SchedulingDisabled', 'Unknown'].map((s, i) => node(`n${i}`, s))
    expect(gpuNodeCounts(nodes)).toEqual({ total: 5, ready: 2, notReady: 3 })
  })

  // Failed is the phase or a status naming an error (a CrashLoopBackOff pod, whose phase is Running), then Running and
  // Pending by the phase; the GPUs still asked for leave out the pods that ended
  it('counts the pods by phase and kubectl STATUS, the GPUs of the pods not ended', () => {
    const pods = [
      pod('run', 'Running', 'Running', 1),
      pod('crash', 'Running', 'CrashLoopBackOff', 2),
      pod('wait', 'Pending', 'Pending', 1, 'other'),
      pod('init', 'Pending', 'Init:0/1', 1),
      pod('done', 'Succeeded', 'Completed', 4),
      pod('err', 'Failed', 'Error', 8),
    ]
    expect(gpuPodCounts(pods)).toEqual({ total: 6, running: 1, pending: 2, failed: 2, requested: 5, namespaces: 2 })
  })

  // As the Pods list's cards: Running, Pending and Failed hold no pod twice, so they and the ended pods add up to Total
  it('puts a pod in one card', () => {
    const pods = [
      pod('run', 'Running', 'Running', 1),
      pod('crash', 'Running', 'CrashLoopBackOff', 1),
      pod('oom', 'Running', 'OOMKilled', 1),
      pod('leaving', 'Running', 'Terminating', 1),
      pod('wait', 'Pending', 'Pending', 1),
      pod('pull', 'Pending', 'ImagePullBackOff', 1),
      pod('initcrash', 'Pending', 'Init:CrashLoopBackOff', 1),
      pod('init', 'Pending', 'Init:0/1', 1),
      pod('initerr', 'Failed', 'Init:Error', 1),
      pod('err', 'Failed', 'Error', 1),
      pod('done', 'Succeeded', 'Completed', 1),
      pod('lost', 'Unknown', 'Unknown', 1),
    ]
    const { total, running, pending, failed } = gpuPodCounts(pods)
    expect({ running, pending, failed }).toEqual({ running: 2, pending: 2, failed: 6 })
    const noCard = pods.filter((p) => p.phase === 'Succeeded' || p.phase === 'Unknown').length
    expect(running + pending + failed + noCard).toBe(total)
  })

  // what the floating chat is told is what the table says: a crash under the phase Running counts, a finished pod does not
  it('counts the pods not running by kubectl\'s STATUS, not the phase', () => {
    const pods = [
      pod('run', 'Running', 'Running', 1),
      pod('crash', 'Running', 'CrashLoopBackOff', 2),
      pod('leaving', 'Running', 'Terminating', 1),
      pod('wait', 'Pending', 'Pending', 1),
      pod('done', 'Succeeded', 'Completed', 4),
      pod('err', 'Failed', 'Error', 8),
    ]
    expect(gpuPodsNotRunning(pods).map((p) => p.name)).toEqual(['crash', 'leaving', 'wait', 'err'])
  })

  it('says a device plugin not found apart from one not ready', () => {
    expect(devicePluginState(null)).toBe('missing')
    expect(devicePluginState({ vendor: 'NVIDIA', found: false })).toBe('missing')
    expect(devicePluginState({ vendor: 'NVIDIA', found: true, desired: 2, ready: 1, available: 1 })).toBe('unhealthy')
    expect(devicePluginState({ vendor: 'NVIDIA', found: true, desired: 2, ready: 2, available: 2 })).toBe('healthy')
  })

  // one badge per company the server lists, named only when there are several; none listed is one "not found"
  it('gives each company its device plugin badge', () => {
    expect(devicePluginBadges(undefined).map((b) => [b.vendor, b.state])).toEqual([[undefined, 'missing']])
    expect(devicePluginBadges([{ vendor: 'AMD', found: true, desired: 1, ready: 1 }]).map((b) => [b.vendor, b.state])).toEqual([[undefined, 'healthy']])
    expect(devicePluginBadges([
      { vendor: 'NVIDIA', found: false },
      { vendor: 'AMD', found: true, desired: 2, ready: 1 },
      { vendor: 'Intel', found: true, desired: 1, ready: 1 },
    ]).map((b) => [b.vendor, b.state])).toEqual([['NVIDIA', 'missing'], ['AMD', 'unhealthy'], ['Intel', 'healthy']])
  })

  // a pod on two GPUs: the utilization the mean of both, the memory the used of their total — not the last GPU's
  it('reads every GPU of a pod', () => {
    const usage = podGpuUsage([gpu('a', 'two', 50, 2000, 2000), gpu('b', 'two', 70, 3000, 1000), gpu('c', 'one', 30, 1000, 3000), gpu('d', '', 0, 0, 4000)])
    expect(Object.fromEntries(usage)).toEqual({
      'ml/two': { gpus: 2, gpu_util: 60, memory_util_percent: 62.5 },
      'ml/one': { gpus: 1, gpu_util: 30, memory_util_percent: 25 },
    })
  })

  // a GPU missing a series counts for what it has: the mean of the GPUs that report, the used of the memory that adds up
  it('reads a pod\'s GPUs for the series they report', () => {
    const partial = (uuid: string, pod: string, util: number | null, used: number | null, free: number | null) => ({
      ...gpu(uuid, pod, 0, 0, 0), gpu_util: util, memory_used_mb: used, memory_free_mb: free,
      memory_total_mb: used === null || free === null ? null : used + free,
      memory_util_percent: used === null || free === null || used + free === 0 ? null : (used / (used + free)) * 100,
    }) as unknown as GPUDeviceMetric
    const usage = podGpuUsage([
      partial('a', 'two', 80, 2000, 2000), partial('b', 'two', null, 1000, null),
      partial('c', 'none', null, null, null),
      partial('d', 'idle', 0, 0, 4000),
    ])
    expect(Object.fromEntries(usage)).toEqual({
      'ml/two': { gpus: 2, gpu_util: 80, memory_util_percent: 50 },
      'ml/none': { gpus: 1, gpu_util: null, memory_util_percent: null },
      'ml/idle': { gpus: 1, gpu_util: 0, memory_util_percent: 0 },
    })
  })

  // nvidia.com/gpu and the MIG profiles of the mixed strategy add up; a node without either has no count
  it('counts whole GPUs and MIG devices', () => {
    expect(gpuCountOf({ cpu: '4', 'nvidia.com/gpu': '8', 'nvidia.com/mig-1g.5gb': '4', 'nvidia.com/mig-3g.20gb': '1' })).toBe(13)
    expect(gpuCountOf({ 'nvidia.com/mig-1g.5gb': '7' })).toBe(7)
    expect(gpuCountOf({ cpu: '4' })).toBeUndefined()
  })

  // AMD's GPUs and mixed-strategy partitions, Intel's GPUs by kernel driver; Intel's monitoring resources and its older
  // plugin's millicores, memory.max and tiles are no GPUs, nor are other accelerators
  it('counts every company\'s GPUs and only the names that count devices', () => {
    expect(gpuCountsByVendor({
      'gpu.intel.com/i915': '2', 'gpu.intel.com/xe': '1', 'gpu.intel.com/millicores': '3000', 'gpu.intel.com/memory.max': '68719476736',
      'gpu.intel.com/tiles': '4', 'gpu.intel.com/monitoring': '1', 'gpu.intel.com/i915_monitoring': '1',
      'amd.com/cpx_nps4': '16', 'amd.com/spx_nps1': '1', 'amd.com/gpu': '2', 'nvidia.com/gpu': '1',
      'habana.ai/gaudi': '8', 'aws.amazon.com/neuron': '2', cpu: '64',
    })).toEqual([['NVIDIA', 1], ['AMD', 19], ['Intel', 3]])
    expect(gpuCountOf({ 'gpu.intel.com/millicores': '1000', 'gpu.intel.com/xe_monitoring': '1', 'habana.ai/gaudi': '8' })).toBeUndefined()
    // NVIDIA's sharing config with renameByDefault advertises each replica as nvidia.com/gpu.shared (and mig-*.shared)
    expect(gpuCountsByVendor({ 'nvidia.com/gpu.shared': '40', 'nvidia.com/mig-1g.5gb.shared': '8' })).toEqual([['NVIDIA', 48]])
    expect(['amd.com/qpx_nps8', 'amd.com/dpx_nps2', 'amd.com/cpx', 'amd.com/xilinx_u250'].map(gpuVendorOf)).toEqual(['AMD', 'AMD', undefined, undefined])
  })

  // AMD's labeller: the value, its beta copy, or one label per value when the node's GPUs differ; Intel's product label
  it('reads each company\'s model, memory, driver and family from its own labels', () => {
    expect(gpuVendorLabels('AMD', { 'amd.com/gpu.product-name': 'AMD_Instinct_MI300X', 'amd.com/gpu.vram': '192G', 'amd.com/gpu.driver-version': '6.12.12', 'amd.com/gpu.family': 'AI' }))
      .toEqual({ model: 'AMD_Instinct_MI300X', memory: '192G', driver: '6.12.12', family: 'AI' })
    expect(gpuVendorLabels('AMD', { 'beta.amd.com/gpu.product-name.AMD_Instinct_MI325X': '1', 'beta.amd.com/gpu.product-name.AMD_Instinct_MI300X': '1', 'beta.amd.com/gpu.vram': '256G' }))
      .toEqual({ model: 'AMD_Instinct_MI300X, AMD_Instinct_MI325X', memory: '256G', driver: undefined, family: undefined })
    expect(gpuVendorLabels('Intel', { 'gpu.intel.com/product': 'Max_1550', 'gpu.intel.com/family': 'Max_Series' }))
      .toEqual({ model: 'Max_1550', memory: undefined, driver: undefined, family: 'Max_Series' })
  })

  // a node bar names the company before the model, not twice when the model's label starts with it (any case)
  it('names the company on a node bar once', () => {
    const g = (vendor: GPUVendor, model?: string, memory?: string) => ({ vendor, capacity: 1, allocatable: 1, used: 0, model, memory })
    expect([
      nodeVendorText(g('NVIDIA', 'NVIDIA-A100-SXM4-40GB', '40960')), nodeVendorText(g('AMD', 'AMD_Instinct_MI300X', '192G')),
      nodeVendorText(g('NVIDIA', 'nvidia-l4')), nodeVendorText(g('Intel', 'Max_1550')), nodeVendorText(g('NVIDIA', 'Tesla-T4')),
      nodeVendorText(g('AMD'), '알 수 없음'),
    ]).toEqual(['NVIDIA-A100-SXM4-40GB • 40960', 'AMD_Instinct_MI300X • 192G', 'nvidia-l4', 'Intel Max_1550', 'NVIDIA Tesla-T4', 'AMD 알 수 없음'])
  })

  // GPU Feature Discovery writes a number of mebibytes; AMD's node labeller writes its own unit; Intel writes no memory
  it('gives a GPU memory label its unit', () => {
    expect(gpuVendorLabels('NVIDIA', { 'nvidia.com/gpu.memory': '23034' }).memory).toBe('23034 MiB')
    expect(gpuVendorLabels('AMD', { 'amd.com/gpu.vram': '192G' }).memory).toBe('192G')
    expect(gpuVendorLabels('Intel', {}).memory).toBeUndefined()
    expect(gpuVendorLabels('NVIDIA', {}).memory).toBeUndefined()
    // a label someone wrote by hand with its own unit stays as written
    expect(gpuVendorLabels('NVIDIA', { 'nvidia.com/gpu.memory': '24GB' }).memory).toBe('24GB')
  })

  // the drawer: whose GPUs, each company's labels, the GPUs of all of them (not Intel's millicores)
  it('gives the Node drawer each company\'s GPU rows', () => {
    const amd = { 'amd.com/gpu.product-name': 'AMD_Instinct_MI300X', 'amd.com/gpu.vram': '192G', 'amd.com/gpu.driver-version': '6.12.12', 'amd.com/gpu.family': 'AI' }
    expect(nodeGpuRows(amd, { 'amd.com/gpu': '8', cpu: '64' }, { 'amd.com/gpu': '7' })).toEqual([
      ['GPU Vendor', 'AMD'], ['GPU Product', 'AMD_Instinct_MI300X'], ['GPU Memory', '192G'], ['GPU Count (Capacity)', '8'],
      ['GPU Count (Allocatable)', '7'], ['Driver Version', '6.12.12'], ['GPU Family', 'AI'],
    ])
    const mixed = { 'nvidia.com/gpu.product': 'NVIDIA-L4', 'nvidia.com/gpu.memory': '23034', 'nvidia.com/cuda.driver-version.full': '580.95.05', 'gpu.intel.com/product': 'Arc_Pro_B60', 'gpu.intel.com/family': 'B_Series' }
    const res = { 'nvidia.com/gpu': '1', 'gpu.intel.com/xe': '1', 'gpu.intel.com/millicores': '1000' }
    expect(nodeGpuRows(mixed, res, res)).toEqual([
      ['GPU Vendor', 'NVIDIA, Intel'], ['GPU Product', 'NVIDIA-L4, Arc_Pro_B60'], ['GPU Memory', '23034 MiB'], ['GPU Count (Capacity)', '2'],
      ['GPU Count (Allocatable)', '2'], ['Driver Version', '580.95.05'], ['GPU Family', 'B_Series'],
    ])
    expect(nodeGpuRows({}, { cpu: '4' }, { cpu: '4' })).toEqual([])
  })

  // a node of two companies is in two models, each with its own GPUs; the company counts add up per company
  it('counts each company\'s GPUs of a node under its own model and company', () => {
    const nodes: GPUNodeInfo[] = [
      { ...node('mixed', 'Ready'), gpu_capacity: 2, gpu_vendors: [
        { vendor: 'NVIDIA', capacity: 1, allocatable: 1, used: 1, model: 'NVIDIA-L4' },
        { vendor: 'Intel', capacity: 1, allocatable: 1, used: 0 },
      ] },
      { ...node('amd', 'NotReady'), gpu_capacity: 8, gpu_vendors: [{ vendor: 'AMD', capacity: 8, allocatable: 8, used: 3, model: 'AMD_Instinct_MI300X' }] },
      { ...node('l4', 'Ready'), gpu_capacity: 2, gpu_vendors: [{ vendor: 'NVIDIA', capacity: 2, allocatable: 2, used: 0, model: 'NVIDIA-L4' }] },
    ]
    expect(gpuModels(nodes)).toEqual([
      ['AMD_Instinct_MI300X', { count: 1, totalCapacity: 8, totalAllocatable: 8, totalUsed: 3 }],
      ['NVIDIA-L4', { count: 2, totalCapacity: 3, totalAllocatable: 3, totalUsed: 1 }],
      ['Unknown', { count: 1, totalCapacity: 1, totalAllocatable: 1, totalUsed: 0 }],
    ])
    expect(gpuVendorCounts(nodes)).toEqual([
      { vendor: 'NVIDIA', nodes: 2, capacity: 3, allocatable: 3, used: 1 },
      { vendor: 'AMD', nodes: 1, capacity: 8, allocatable: 8, used: 3 },
      { vendor: 'Intel', nodes: 1, capacity: 1, allocatable: 1, used: 0 },
    ])
    const pods: GPUPodInfo[] = [
      { ...pod('a', 'Running', 'Running', 2), gpu_vendors: [{ vendor: 'AMD', requested: 2 }] },
      { ...pod('done', 'Succeeded', 'Completed', 4), gpu_vendors: [{ vendor: 'AMD', requested: 4 }] },
      { ...pod('both', 'Pending', 'Pending', 2), gpu_vendors: [{ vendor: 'NVIDIA', requested: 1 }, { vendor: 'Intel', requested: 1 }] },
    ]
    expect(gpuPodVendorCounts(pods)).toEqual([
      { vendor: 'NVIDIA', pods: 1, requested: 1 }, { vendor: 'AMD', pods: 2, requested: 2 }, { vendor: 'Intel', pods: 1, requested: 1 },
    ])
  })

  // the GPU Pods charts list every status and every node (the pods no node took as ''), the most first — not the top
  // five statuses and four nodes
  it('lists every status and every node of the GPU pods, the most first', () => {
    const on = (p: GPUPodInfo, node?: string): GPUPodInfo => (node ? { ...p, node_name: node } : p)
    const pods = [
      on(pod('r1', 'Running', 'Running', 1), 'n1'), on(pod('r2', 'Running', 'Running', 2), 'n1'), on(pod('r3', 'Running', 'Running', 1), 'n2'),
      on(pod('crash', 'Running', 'CrashLoopBackOff', 1), 'n3'), on(pod('init', 'Pending', 'Init:0/1', 1), 'n4'),
      on(pod('ierr', 'Failed', 'Init:Error', 3), 'n5'), on(pod('done', 'Succeeded', 'Completed', 1), 'n6'),
      on(pod('err', 'Failed', 'Error', 1), 'n2'), pod('wait', 'Pending', 'Pending', 2),
    ]
    expect(gpuPodStatuses(pods)).toEqual([
      ['Running', 3], ['CrashLoopBackOff', 1], ['Init:0/1', 1], ['Init:Error', 1], ['Completed', 1], ['Error', 1], ['Pending', 1],
    ])
    expect(gpuPodsByNode(pods)).toEqual([
      ['n1', { podCount: 2, totalGpu: 3 }], ['n5', { podCount: 1, totalGpu: 3 }], ['n2', { podCount: 2, totalGpu: 2 }], ['', { podCount: 1, totalGpu: 2 }],
      ['n3', { podCount: 1, totalGpu: 1 }], ['n4', { podCount: 1, totalGpu: 1 }], ['n6', { podCount: 1, totalGpu: 1 }],
    ])
  })

  // a GPU's pod is named when the pod asks for GPUs or an allocated DRA claim is reserved for it; the exporter's own pod
  // on an idle GPU's series, and a series of no pod, name none
  it('names a GPU\'s pod when it asks for GPUs or holds a DRA claim', () => {
    const holders = gpuHolderPods({ gpu_pods: [pod('asks', 'Running', 'Running', 1)], dra_pods: [{ namespace: 'ml', name: 'claims' }] })
    expect([...holders].sort()).toEqual(['ml/asks', 'ml/claims'])
    expect(gpuSeriesPod(gpu('g0', 'asks', 1, 1, 1), holders)).toBe('ml/asks')
    expect(gpuSeriesPod(gpu('g1', 'claims', 1, 1, 1), holders)).toBe('ml/claims')
    expect(gpuSeriesPod({ ...gpu('g2', '', 0, 0, 1), exported_pod: 'dcgm-exporter', exported_namespace: 'monitoring' }, holders)).toBe('')
    expect(gpuSeriesPod(gpu('g3', '', 0, 0, 1), holders)).toBe('')
    expect([...gpuHolderPods({ gpu_pods: [] })]).toEqual([])
  })

  // GPU Feature Discovery: cuda.driver-version is the driver (550.107.02), cuda.runtime-version the CUDA (12.5)
  it('reads the driver and the CUDA version from their own labels', () => {
    const labels = {
      'nvidia.com/cuda.driver.major': '550', 'nvidia.com/cuda.driver.minor': '107', 'nvidia.com/cuda.driver.rev': '02',
      'nvidia.com/cuda.runtime.major': '12', 'nvidia.com/cuda.runtime.minor': '5',
    }
    expect({ driver: driverVersion(labels), cuda: cudaVersion(labels) }).toEqual({ driver: '550.107.02', cuda: '12.5' })
    const full = { ...labels, 'nvidia.com/cuda.driver-version.full': '580.95.05', 'nvidia.com/cuda.runtime-version.full': '13.0' }
    expect({ driver: driverVersion(full), cuda: cudaVersion(full) }).toEqual({ driver: '580.95.05', cuda: '13.0' })
    expect(driverVersion({})).toBeUndefined()
  })
})
