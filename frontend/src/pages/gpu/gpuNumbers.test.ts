import { describe, expect, it } from 'vitest'
import type { GPUDeviceMetric, GPUNodeInfo, GPUPodInfo } from '@/services/api'
import { cudaVersion, devicePluginState, driverVersion, gpuCountOf, gpuNodeCounts, gpuPodCounts, podGpuUsage } from './gpuNumbers'

const node = (name: string, status: string): GPUNodeInfo => ({ name, status, gpu_capacity: 1, gpu_allocatable: 1, gpu_used: 0 })
const pod = (name: string, phase: string, status: string, gpus: number, namespace = 'ml'): GPUPodInfo =>
  ({ name, namespace, phase, status, gpu_requested: gpus })
const gpu = (uuid: string, pod: string, util: number, used: number, free: number): GPUDeviceMetric => ({
  uuid, gpu: '0', hostname: 'n1', model_name: 'A100', gpu_util: util, memory_used_mb: used, memory_free_mb: free,
  memory_total_mb: used + free, memory_util_percent: used + free > 0 ? (used / (used + free)) * 100 : 0, memory_temp: 0,
  ...(pod ? { exported_pod: pod, exported_namespace: 'ml' } : {}),
})

describe('GPU screen numbers', () => {
  // kubectl's STATUS starts with the readiness: a cordoned Ready node is ready, NotReady and Unknown are not
  it('counts a node ready by the readiness kubectl prints first', () => {
    const nodes = ['Ready', 'Ready,SchedulingDisabled', 'NotReady', 'NotReady,SchedulingDisabled', 'Unknown'].map((s, i) => node(`n${i}`, s))
    expect(gpuNodeCounts(nodes)).toEqual({ total: 5, ready: 2, notReady: 3 })
  })

  // Running and Pending by phase; Failed by phase or a status naming an error (a CrashLoopBackOff pod is Running and
  // failing); the GPUs still asked for leave out the pods that ended
  it('counts the pods by phase and kubectl STATUS, the GPUs of the pods not ended', () => {
    const pods = [
      pod('run', 'Running', 'Running', 1),
      pod('crash', 'Running', 'CrashLoopBackOff', 2),
      pod('wait', 'Pending', 'Pending', 1, 'other'),
      pod('init', 'Pending', 'Init:0/1', 1),
      pod('done', 'Succeeded', 'Completed', 4),
      pod('err', 'Failed', 'Error', 8),
    ]
    expect(gpuPodCounts(pods)).toEqual({ total: 6, running: 2, pending: 2, failed: 2, requested: 5, namespaces: 2 })
  })

  it('says a device plugin not found apart from one not ready', () => {
    expect(devicePluginState(null)).toBe('missing')
    expect(devicePluginState({ desired: 2, ready: 1, available: 1 })).toBe('unhealthy')
    expect(devicePluginState({ desired: 2, ready: 2, available: 2 })).toBe('healthy')
  })

  // a pod on two GPUs: the utilization the mean of both, the memory the used of their total — not the last GPU's
  it('reads every GPU of a pod', () => {
    const usage = podGpuUsage([gpu('a', 'two', 50, 2000, 2000), gpu('b', 'two', 70, 3000, 1000), gpu('c', 'one', 30, 1000, 3000), gpu('d', '', 0, 0, 4000)])
    expect(Object.fromEntries(usage)).toEqual({
      'ml/two': { gpus: 2, gpu_util: 60, memory_util_percent: 62.5 },
      'ml/one': { gpus: 1, gpu_util: 30, memory_util_percent: 25 },
    })
  })

  // nvidia.com/gpu and the MIG profiles of the mixed strategy add up; a node without either has no count
  it('counts whole GPUs and MIG devices', () => {
    expect(gpuCountOf({ cpu: '4', 'nvidia.com/gpu': '8', 'nvidia.com/mig-1g.5gb': '4', 'nvidia.com/mig-3g.20gb': '1' })).toBe(13)
    expect(gpuCountOf({ 'nvidia.com/mig-1g.5gb': '7' })).toBe(7)
    expect(gpuCountOf({ cpu: '4' })).toBeUndefined()
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
