import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GPUDashboardData, GPUMetricsData } from '@/services/api'
import { RealtimeMetricsSection } from './gpu-dashboard/RealtimeMetricsSection'
import { SummaryCardsRow } from './gpu-dashboard/SummaryCardsRow'
import { devicePluginBadges, gpuRealtimeAverages, missingPluginVendors } from './gpuNumbers'

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
