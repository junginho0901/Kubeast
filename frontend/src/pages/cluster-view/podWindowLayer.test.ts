import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import rowCases from '@/services/watchRows.cases.json'
import { enforceTokenBudget } from '@/utils/aiContext/tokenBudget'
import { ClusterViewContext, type ClusterViewContextValue } from './ClusterViewContext'
import { getHealthIcon } from './podHealth'
import { podToDetail, type DetailTab, type PodDetail } from './types'

// What the pod window tells the floating chat of the pod is what its Summary tab shows: State and Health, and the init
// containers they are read from beside the containers. The rows, and what each reads, are the server's own.

type Layer = { source?: string; summary: string; data?: Record<string, any> }
const layers = vi.hoisted(() => [] as (Layer | null)[])
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null) => { layers.push(input) } }))
vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))
vi.mock('./PodDetailTabs', () => ({ PodDetailTabs: () => null }))
vi.mock('./PodDetailTabBody', () => ({ PodDetailTabBody: () => null }))

import { PodDetailModal } from './PodDetailModal'
import { PodSummaryTab } from './PodSummaryTab'

const tr = (_key: string, fallback: string) => fallback
function layerOf(pod: PodDetail, o: { tab?: DetailTab; describe?: unknown; manifest?: string; reading?: boolean } = {}) {
  layers.length = 0
  const view = { selectedPod: pod, activeTab: o.tab ?? 'summary', closeDetailModal: () => {}, tr } as unknown as ClusterViewContextValue
  renderToStaticMarkup(createElement(ClusterViewContext.Provider, { value: view },
    createElement(PodDetailModal, { canExec: false, manifest: o.manifest, describeData: o.describe, podRead: o.reading ? 'reading' : 'none' })))
  return layers.at(-1)!
}
const dataOf = (pod: PodDetail, o?: Parameters<typeof layerOf>[1]) => layerOf(pod, o).data!
// as the hook registers it: within the layer's size
const sent = (layer: Layer) => JSON.parse(JSON.stringify(enforceTokenBudget({ source: 'PodDetailModal', summary: layer.summary, data: layer.data }).data))
const summaryTab = (pod: PodDetail) =>
  renderToStaticMarkup(createElement(PodSummaryTab, { pod, containerSearchQuery: '', onContainerSearchChange: () => {}, emptyValue: '-', tr }))

const rows = rowCases.filter((c) => c.resource === 'pods').map((c) => ({ name: c.name, row: c.after as any, server: (c.shows as any).health as string }))
const row = (name: string) => rows.find((r) => r.name === name)!.row
const SIDECAR_NOT_READY = row('a pod whose sidecar is up but not ready warns, as READY says')
const INIT_FAILED = row('a pod whose init container failed reads Init:Error with its restarts')
const init = (name: string, ready: boolean, state: object = { running: { started_at: '' } }) => ({ name, image: 'example.test/setup:1', ready, restart_count: 0, state })

describe("what Cluster View's pod window tells the floating chat of the pod", () => {
  it("is the State and Health the Summary tab shows of each server row, which are the server's", () => {
    expect(new Set(rows.map((r) => r.server)).size).toBeGreaterThan(5)
    for (const { name, row: pod, server } of rows) {
      const detail = podToDetail(pod)
      const { state, health } = dataOf(detail)
      expect(`${health} ${state}`, name).toBe(server)
      const html = summaryTab(detail)
      expect(/>State<\/p><p[^>]*>([^<]*)</.exec(html)?.[1], name).toBe(state)
      expect(html, name).toContain(`${renderToStaticMarkup(getHealthIcon(health, state))}<span class="text-ink font-medium">${state}<`)
    }
  })

  it('names each init container with its ready, state and restart count, a sidecar as one', () => {
    expect(sent(layerOf(podToDetail(SIDECAR_NOT_READY)))).toMatchObject({
      status: 'Running', state: 'NotReady', health: 'warn',
      containers: [{ name: 'app', ready: true }],
      init_containers: [{ name: 'side', ready: false, restart_count: 0, restart_policy: 'Always', state: { running: { started_at: '2026-11-01T00:00:30Z' } } }],
    })
    const failed = sent(layerOf(podToDetail(INIT_FAILED)))
    expect(failed).toMatchObject({ state: 'Error', health: 'error' })
    expect(failed.init_containers).toEqual([{ name: 'setup', ready: false, restart_count: 4, state: INIT_FAILED.init_containers[0].state }])
  })

  it('says none of it until a window opened from a box has read the pod', () => {
    const box = { name: 'web-1', namespace: 'demo', node_name: 'node-a', status: 'Running', phase: 'Running', restart_count: 0, health: 'ok', health_reason: 'Running' }
    const data = sent(layerOf(podToDetail(box), { reading: true }))
    expect(data).toMatchObject({ name: 'web-1', status: 'Running', containers_loading: true })
    for (const field of ['state', 'health', 'containers', 'init_containers']) expect(data, field).not.toHaveProperty(field)
  })

  it("keeps the ones not ready when the list is cut, at the Pod drawer's five", () => {
    const inits = [...Array.from({ length: 6 }, (_, i) => init(`done-${i}`, true)), init('last', false)]
    const names = (pod: object) => dataOf(podToDetail(pod)).init_containers.map((c: { name: string }) => c.name)
    expect(names({ ...SIDECAR_NOT_READY, init_containers: inits })).toEqual(['last', 'done-0', 'done-1', 'done-2', 'done-3'])
    expect(names({ ...SIDECAR_NOT_READY, init_containers: [] })).toEqual([])
  })

  it('does not repeat them beside the describe answer, which has them whole', () => {
    const pod = podToDetail(INIT_FAILED)
    expect(dataOf(pod, { tab: 'describe', describe: INIT_FAILED }).init_containers).toBeUndefined()
    expect(dataOf(pod, { tab: 'describe', describe: INIT_FAILED })).toMatchObject({ state: 'Error', describe: { init_containers: [{ name: 'setup' }] } })
    expect(dataOf(pod, { tab: 'describe' }).init_containers).toHaveLength(1)
    expect(dataOf(pod, { tab: 'logs', describe: INIT_FAILED }).init_containers).toHaveLength(1)
  })

  it("stays within a layer's size with the longest message a container may end on, the manifest beside it", () => {
    const long = { terminated: { exit_code: 1, reason: 'Error', message: 'x'.repeat(4096) } }
    const pod = podToDetail({ ...INIT_FAILED, init_containers: [init('setup', false, long)] })
    const data = sent(layerOf(pod, { tab: 'manifest', manifest: 'y: z\n'.repeat(2000) }))
    expect(data.__truncated__).toBeUndefined()
    expect(data).toMatchObject({ state: 'Error', init_containers: [{ name: 'setup', state: { terminated: { exit_code: 1, reason: 'Error' } } }] })
    expect(data.init_containers[0].state.terminated.message).toBe(`${'x'.repeat(300)}…`)
  })
})
