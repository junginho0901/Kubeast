import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement, createRef, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GPUDashboardData, GPUDeviceMetric, GPUMetricsData } from '@/services/api'
import { RealtimeMetricsSection } from './gpu-dashboard/RealtimeMetricsSection'
import { SummaryCardsRow } from './gpu-dashboard/SummaryCardsRow'
import GPUNodesRealtimeMetrics from './gpu-nodes/GPUNodesRealtimeMetrics'
import { GPUPodsTable } from './gpupods/GPUPodsTable'
import { devicePluginBadges, gpuRealtimeAverages, missingPluginVendors, type PodGpuUsage } from './gpuNumbers'

const tr = (_key: string, fallback: string, options?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''))
const html = (el: ReactElement) => renderToStaticMarkup(el)
const text = (markup: string, testId: string) => markup.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`))?.[1]

const NO_SERIES: GPUMetricsData = {
  available: true, gpu_count: 0, avg_gpu_util: 0, avg_memory_util: 0, total_memory_used_mb: 0, total_memory_free_mb: 0, total_memory_mb: 0, gpus: [],
}
const SERIES: GPUMetricsData = { ...NO_SERIES, gpu_count: 2, avg_gpu_util: 40, avg_memory_util: 25, total_memory_used_mb: 2048, total_memory_mb: 8192 }

// Prometheus answering with no DCGM series is nothing read, not GPUs at 0%.
describe('the real-time GPU averages', () => {
  it('have no number without DCGM series', () => {
    expect(gpuRealtimeAverages(NO_SERIES)).toEqual({ util: null, memory: null })
  })

  it('keep a real 0% of GPUs read', () => {
    expect(gpuRealtimeAverages({ ...SERIES, avg_gpu_util: 0, avg_memory_util: 0 })).toEqual({ util: 0, memory: 0 })
    expect(gpuRealtimeAverages(SERIES)).toEqual({ util: 40, memory: 25 })
  })

  it('have no memory number when the GPUs have no memory series', () => {
    expect(gpuRealtimeAverages({ ...SERIES, avg_memory_util: 0, total_memory_mb: 0 })).toEqual({ util: 40, memory: null })
  })

  const section = (metrics: GPUMetricsData) =>
    html(createElement(RealtimeMetricsSection, { metricsAvailable: true, metrics, gpusByHost: new Map(), gpuPodKeys: new Set<string>(), tr }))

  it('the cards say "-" without DCGM series', () => {
    const m = section(NO_SERIES)
    expect(['gpu-realtime-avg-util', 'gpu-realtime-avg-mem', 'gpu-realtime-mem-used', 'gpu-realtime-count'].map((id) => text(m, id))).toEqual(['-', '-', '-', '-'])
    expect(m).not.toContain('0.0 GiB')
    expect(m).not.toContain('>0%<')
  })

  it('the cards keep the numbers of GPUs read', () => {
    const m = section(SERIES)
    expect(['gpu-realtime-avg-util', 'gpu-realtime-avg-mem', 'gpu-realtime-mem-used', 'gpu-realtime-count'].map((id) => text(m, id))).toEqual(['40%', '25%', '2.0 GiB', '2'])
  })

  it('the floating chat reads the same averages', () => {
    const src = readFileSync(fileURLToPath(new URL('./GPUDashboard.tsx', import.meta.url)), 'utf8')
    expect(src).toContain('avg_gpu_util: averages?.util')
    expect(src).toContain('avg_memory_util: averages?.memory')
    expect(src).toContain('avg_gpu_util_of: `${reportingUtil} of ${metrics.gpu_count} GPUs`')
  })
})

// A GPU missing a series is not a GPU at 0%: its number says "-", a real 0 stays 0, and the host's averages are of the
// GPUs that have one, as Prometheus's avg() is.
describe('a GPU that reports only some of its series', () => {
  const gpu = (uuid: string, util: number | null, memory: number | null, temp: number | null = null) => ({
    uuid, gpu: '0', hostname: 'n1', model_name: 'A100', gpu_util: util, memory_used_mb: memory === null ? null : memory * 10,
    memory_free_mb: memory === null ? null : (100 - memory) * 10, memory_total_mb: memory === null ? null : 1000, memory_util_percent: memory, memory_temp: temp,
  }) as unknown as GPUDeviceMetric
  const dashboardGpu = (g: GPUDeviceMetric) =>
    html(createElement(RealtimeMetricsSection, { metricsAvailable: true, metrics: SERIES, gpusByHost: new Map([['n1', [g]]]), gpuPodKeys: new Set<string>(), tr }))
  const nodesCard = (gpus: GPUDeviceMetric[]) => html(createElement(GPUNodesRealtimeMetrics, { gpusByHost: new Map([['n1', gpus]]) }))

  it('the dashboard says "-" for what it did not read, with an empty bar', () => {
    const m = dashboardGpu(gpu('a', null, null))
    expect(text(m, 'gpu-realtime-core')).toBe('-')
    expect(text(m, 'gpu-realtime-mem')).toBe('-')
    expect(m).not.toContain('NaN')
    expect(m).not.toContain('gpu-realtime-temp')
  })

  it('the dashboard keeps a real 0%', () => {
    const m = dashboardGpu(gpu('a', 0, 0, 40))
    expect(text(m, 'gpu-realtime-core')).toBe('0%')
    expect(text(m, 'gpu-realtime-mem')).toBe('0%')
    expect(m).toContain('40°C')
  })

  it('GPU Nodes says "-" for what it did not read', () => {
    const m = nodesCard([gpu('a', null, null)])
    expect(text(m, 'gpu-nodes-core')).toBe('-')
    expect(text(m, 'gpu-nodes-mem')).toBe('-')
    expect(text(m, 'gpu-nodes-avg-core')).toBe('Avg Core: -')
    expect(text(m, 'gpu-nodes-avg-mem')).toBe('Avg Mem: -')
    expect(m).not.toContain('NaN')
  })

  it('GPU Nodes averages the GPUs that have a number', () => {
    const m = nodesCard([gpu('a', 80, 40), gpu('b', null, null), gpu('c', 40, 20)])
    expect(text(m, 'gpu-nodes-avg-core')).toBe('Avg Core: 60%')
    expect(text(m, 'gpu-nodes-avg-mem')).toBe('Avg Mem: 30%')
  })

  it('the dashboard card says what its average leaves out, and only then', () => {
    const section = (gpus: GPUDeviceMetric[]) =>
      html(createElement(RealtimeMetricsSection, { metricsAvailable: true, metrics: { ...SERIES, gpu_count: gpus.length, gpus }, gpusByHost: new Map(), gpuPodKeys: new Set<string>(), tr }))
    expect(section([gpu('a', 80, 40), gpu('b', null, null), gpu('c', 40, 20)])).toContain('title="The 2 of 3 GPUs that report utilization"')
    expect(section([gpu('a', 80, 40), gpu('c', 40, 20)])).not.toContain('that report utilization')
  })

  it('an average the API has no number for is "-" on the card', () => {
    const none = { ...SERIES, avg_gpu_util: null, avg_memory_util: null, total_memory_used_mb: null, total_memory_free_mb: null, total_memory_mb: null } as unknown as GPUMetricsData
    expect(gpuRealtimeAverages(none)).toEqual({ util: null, memory: null })
    const m = html(createElement(RealtimeMetricsSection, { metricsAvailable: true, metrics: none, gpusByHost: new Map(), gpuPodKeys: new Set<string>(), tr }))
    expect(['gpu-realtime-avg-util', 'gpu-realtime-avg-mem', 'gpu-realtime-mem-used'].map((id) => text(m, id))).toEqual(['-', '-', '-'])
  })

  it('GPU Pods says "-" for what its GPUs did not report', () => {
    const table = (usage: PodGpuUsage) => html(createElement(GPUPodsTable, {
      pagedPods: [{ name: 'p', namespace: 'ml', phase: 'Running', status: 'Running', gpu_requested: 1 }], sortedPodsLength: 1, isLoading: false, metricsAvailable: true,
      podMetricsMap: new Map([['ml/p', usage]]), showCharts: false, sortKey: 'name', setSortKey: () => {}, sortDir: 'asc', setSortDir: () => {}, currentPage: 1, setCurrentPage: () => {},
      totalPages: 1, rowsPerPage: 25, tableContainerRef: createRef(), tableBodyRef: createRef(), theadRef: createRef(), firstRowRef: createRef(), openDetail: () => {}, tr,
    } as unknown as Parameters<typeof GPUPodsTable>[0]))
    const unread = table({ gpus: 1, gpu_util: null, memory_util_percent: null })
    expect(unread).not.toContain('>0%<')
    expect(unread).not.toContain('NaN')
    expect(table({ gpus: 1, gpu_util: 0, memory_util_percent: 0 })).toContain('>0%<')
  })
})

// Not found under the names Kubeast looks for says whose plugin and that it may run under another name: the same words
// for every company, and no claim that the GPUs do not work.
describe('a device plugin not found', () => {
  const data = (vendors: GPUDashboardData['device_plugins']): GPUDashboardData => ({
    total_gpu_capacity: 1, total_gpu_allocatable: 1, total_gpu_used: 0, total_gpu_waiting: 0, vendors: [], gpu_nodes: [], gpu_pods: [],
    device_plugins: vendors, mig_enabled: false, time_slicing_enabled: false,
  }) as unknown as GPUDashboardData
  const row = (plugins: GPUDashboardData['device_plugins']) => {
    const badges = devicePluginBadges(plugins)
    return html(createElement(SummaryCardsRow, { data: data(plugins), allocationRate: 0, devicePlugins: badges, tr }))
  }

  it('names each company whose plugin was not found, also when it is the only one', () => {
    expect(missingPluginVendors(devicePluginBadges([{ vendor: 'AMD', found: false }]))).toEqual(['AMD'])
    expect(missingPluginVendors(devicePluginBadges([{ vendor: 'NVIDIA', found: true, desired: 1, ready: 1 }, { vendor: 'AMD', found: false }, { vendor: 'Intel', found: false }]))).toEqual(['AMD', 'Intel'])
    expect(missingPluginVendors(devicePluginBadges([{ vendor: 'NVIDIA', found: true, desired: 2, ready: 1 }]))).toEqual([])
    expect(missingPluginVendors(devicePluginBadges(undefined))).toEqual([])
  })

  it('the note says it may run under another name, for the company it is about', () => {
    expect(text(row([{ vendor: 'AMD', found: false }]), 'gpu-plugin-note')).toBe('AMD device plugin: not under the names Kubeast looks for. It may run under another name; the GPU counts come from the nodes.')
    expect(text(row([{ vendor: 'NVIDIA', found: false }, { vendor: 'Intel', found: false }]), 'gpu-plugin-note')).toBe('NVIDIA, Intel device plugin: not under the names Kubeast looks for. It may run under another name; the GPU counts come from the nodes.')
  })

  it('without a company listed, the note names none', () => {
    expect(text(row([]), 'gpu-plugin-note')).toBe('Device plugin: not under the names Kubeast looks for. It may run under another name; the GPU counts come from the nodes.')
  })

  it('there is no note when each plugin was found', () => {
    expect(row([{ vendor: 'AMD', found: true, desired: 1, ready: 1 }])).not.toContain('gpu-plugin-note')
    expect(row([{ vendor: 'AMD', found: true, desired: 2, ready: 1 }])).not.toContain('gpu-plugin-note')
  })

  it('the badges keep their words', () => {
    const m = row([{ vendor: 'AMD', found: false }])
    expect(m).toContain('Device Plugin Not Found')
  })

  it('the floating chat is told the same', () => {
    const src = readFileSync(fileURLToPath(new URL('./GPUDashboard.tsx', import.meta.url)), 'utf8')
    expect(src).toContain("note: 'not under the names Kubeast looks for; it may run under another name'")
  })
})
