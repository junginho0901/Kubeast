import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import type { GPUDashboardData, GPUDeviceMetric, GPUMetricsData, GPUPodInfo } from '@/services/api'
import GPUDashboard from './GPUDashboard'
import GPUNodesRealtimeMetrics from './gpu-nodes/GPUNodesRealtimeMetrics'
import { GPUPodsCharts } from './gpupods/GPUPodsCharts'
import { gpuPodsByNode } from './gpuNumbers'

// The GPU screens' per-node and per-host sections grow with the cluster (500 GPU nodes of 8 GPUs). Each shows a page
// of a fixed size with the footer every list has, in an order that does not move between refreshes; the cards and
// counts above them, and what the floating chat is told, stay about every node and GPU.

vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
const chat: { current: { summary?: string; data?: Record<string, any> } | null } = { current: null }
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: { summary?: string; data?: Record<string, any> } | null) => { chat.current = input } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})
const wrap = (body: ReturnType<typeof createElement>, qc = new QueryClient(), lng = 'en') =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
    createElement(QueryClientProvider, { client: qc }, body))))
const footer = (html: string, id: string) => html.match(new RegExp(`data-testid="${id}"[\\s\\S]*?(Showing [^<]+|\\d+개 중 [^<]+)`))?.[1] ?? null
const pad = (n: number) => String(n).padStart(2, '0')

// 25 nodes of 8, 4 or 2 GPUs, listed by the server in the reverse of their names
const nodes = Array.from({ length: 25 }, (_, i) => ({
  name: `n${pad(i)}`, gpu_capacity: [8, 4, 2][i % 3], gpu_allocatable: [8, 4, 2][i % 3], gpu_used: 1, status: 'Ready',
  gpu_vendors: [{ vendor: 'NVIDIA' as const, capacity: [8, 4, 2][i % 3], allocatable: [8, 4, 2][i % 3], used: 1, model: 'A100' }],
})).reverse()
const capacity = nodes.reduce((s, n) => s + n.gpu_capacity, 0)
const dashboard: GPUDashboardData = {
  total_gpu_capacity: capacity, total_gpu_allocatable: capacity, total_gpu_used: 25, total_gpu_waiting: 0,
  gpu_nodes: nodes, gpu_pods: [], device_plugins: [], dra_pods: [], mig_enabled: false, time_slicing_enabled: false, time_slicing_config: null,
}
// 11 hosts of two GPUs, in the order a Prometheus answer may give them
const HOSTS = ['host-7', 'host-10', 'host-2', 'host-11', 'host-1', 'host-9', 'host-4', 'host-3', 'host-8', 'host-6', 'host-5']
const gpu = (host: string, n: number): GPUDeviceMetric => ({
  uuid: `GPU-${host}-${n}`, gpu: String(n), hostname: host, model_name: 'A100', gpu_util: 10, memory_used_mb: 1, memory_free_mb: 1,
  memory_total_mb: 2, memory_util_percent: 50, memory_temp: 40,
})
const gpus = HOSTS.flatMap((h) => [gpu(h, 0), gpu(h, 1)])
const metrics: GPUMetricsData = {
  available: true, gpu_count: gpus.length, avg_gpu_util: 10, avg_memory_util: 50, total_memory_used_mb: 22, total_memory_free_mb: 22, total_memory_mb: 44, gpus,
}
const renderDashboard = (lng = 'en') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['gpu', 'dashboard'], dashboard)
  qc.setQueryData(['gpu', 'metrics'], metrics)
  return wrap(createElement(GPUDashboard), qc, lng)
}
const shown = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => m[1])

describe('GPU Dashboard', () => {
  it('draws one page of ten nodes in Node allocation, the most GPUs first and a tie by name, the footer counting every node', () => {
    const html = renderDashboard()
    expect({ nodes: shown(html, /data-testid="gpu-node-allocation" data-node="([^"]+)"/g), footer: footer(html, 'gpu-node-allocation-pager') }).toEqual({
      nodes: ['n00', 'n03', 'n06', 'n09', 'n12', 'n15', 'n18', 'n21', 'n24', 'n01'],
      footer: 'Showing 1-10 of 25',
    })
  })

  it('draws one page of four hosts in Real-time GPU, by host name, the footer and the count of GPUs about every host', () => {
    const html = renderDashboard()
    expect({
      hosts: shown(html, /data-testid="gpu-realtime-host" data-host="([^"]+)"/g),
      gpus: shown(html, /data-testid="gpu-realtime-gpu" data-uuid="([^"]+)"/g).length,
      footer: footer(html, 'gpu-realtime-pager'),
      detected: html.match(/data-testid="gpu-realtime-detected">([^<]+)</)?.[1],
    }).toEqual({ hosts: ['host-1', 'host-2', 'host-3', 'host-4'], gpus: 8, footer: 'Showing 1-4 of 11', detected: '22 GPUs detected' })
  })

  it('says the footers in the screen\'s language', () => {
    const html = renderDashboard('ko')
    expect([footer(html, 'gpu-node-allocation-pager'), footer(html, 'gpu-realtime-pager')]).toEqual(['25개 중 1-10 표시', '11개 중 1-4 표시'])
  })

  it('tells the floating chat about every node, not the page', () => {
    renderDashboard()
    expect(chat.current?.summary).toContain('노드 25개')
    expect(chat.current?.data?.cluster_gpu).toMatchObject({ total_capacity: capacity, ready_nodes: 25 })
  })
})

describe('GPU Nodes metrics', () => {
  it('draws one page of four hosts, by host name, with the footer counting every host', () => {
    const byHost = new Map(HOSTS.map((h) => [h, [gpu(h, 0), gpu(h, 1)]]))
    const html = wrap(createElement(GPUNodesRealtimeMetrics, { gpusByHost: byHost }))
    expect({ hosts: shown(html, /data-testid="gpu-nodes-host" data-host="([^"]+)"/g), footer: footer(html, 'gpu-nodes-host-pager') })
      .toEqual({ hosts: ['host-1', 'host-2', 'host-3', 'host-4'], footer: 'Showing 1-4 of 11' })
  })
})

describe('GPU Pods charts', () => {
  const tr = (key: string, fallback: string, options?: Record<string, unknown>) => i18n.t(key, { defaultValue: fallback, ...options })
  const usage = Array.from({ length: 25 }, (_, i) => [`n${pad(i)}`, { podCount: 1, totalGpu: 25 - i }] as [string, { podCount: number; totalGpu: number }])
  const statuses: [string, number][] = [['Running', 20], ['Pending', 3], ['Error', 1], ['Completed', 1]]

  it('draws one page of ten nodes in GPU Usage by Node with the footer counting every node, and every status', () => {
    const html = wrap(createElement(GPUPodsCharts, { nodeGpuUsage: usage, topStatuses: statuses, total: 25, tr }))
    expect({
      nodes: shown(html, /data-testid="gpu-pods-node-usage" data-node="([^"]+)"/g),
      footer: footer(html, 'gpu-pods-node-usage-pager'),
      statuses: (html.match(/data-testid="gpu-pods-status-row"/g) ?? []).length,
    }).toEqual({ nodes: usage.slice(0, 10).map(([n]) => n), footer: 'Showing 1-10 of 25', statuses: 4 })
  })

  it('orders nodes with as many GPUs by name, the pods no node took after them, so a page keeps its nodes', () => {
    const on = (name: string, node: string | null): GPUPodInfo => ({ name, namespace: 'ml', node_name: node, gpu_requested: 1, status: 'Running' })
    expect(gpuPodsByNode([on('a', 'n9'), on('b', null), on('c', 'n3'), on('d', 'n5')]).map(([n]) => n)).toEqual(['n3', 'n5', 'n9', ''])
  })
})
