import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { TopResources } from '@/services/api'
import { useDashboardAIContext } from './useDashboardAIContext'

// What the Dashboard tells the floating chat of its top pods and nodes is what those cards show: rows, the cluster's
// refusal, the read's failure, or no rows.
type Layer = { data?: Record<string, unknown> } | null
const chat: { current: Layer } = { current: null }
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer) => { chat.current = input } }))

const PODS_REFUSED = 'pods.metrics.k8s.io is forbidden: User "u1" cannot list resource "pods" in API group "metrics.k8s.io" in the namespace "web"'
const NODES_FAILED = 'the server is currently unable to handle the request (get nodes.metrics.k8s.io)'
const overview = { pod_status: { Running: 1 }, total_pods: 1, node_count: 1 }
const node = { name: 'n1', cpu: '250m', cpu_percent: '6%', memory: '512Mi', memory_percent: '7%' }

function layer(topResources: TopResources) {
  chat.current = null
  function Probe() {
    useDashboardAIContext({ overview, nodes: [], topResources, problemPods: undefined })
    return null
  }
  renderToStaticMarkup(createElement(Probe))
  // read through the declared type: the render set it, which the narrowing after `= null` above does not see
  return (chat.current as Layer)?.data ?? {}
}

describe("the Dashboard's top pods and nodes in the floating chat", () => {
  it('a part the cluster refused goes as refused with its reason, not as no rows', () => {
    const data = layer({ top_pods: [], pod_metrics_error: PODS_REFUSED, pod_metrics_refused: true, top_nodes: [node] })
    expect(data.top_pods).toBeUndefined()
    expect(data.top_pods_refused).toEqual({ reason: PODS_REFUSED })
    expect(data.top_nodes).toEqual([node])
  })

  it('a part whose read failed goes as failed with its reason', () => {
    const data = layer({ top_pods: [{ namespace: 'web', name: 'p', cpu: '5m', memory: '10Mi' }], top_nodes: [], node_metrics_error: NODES_FAILED } as TopResources)
    expect(data.top_nodes).toBeUndefined()
    expect(data.top_nodes_error).toEqual({ reason: NODES_FAILED })
    expect(data.top_pods).toEqual([{ namespace: 'web', name: 'p', cpu: '5m', memory: '10Mi', cpu_percent: undefined, memory_percent: undefined }])
  })

  it('a part read empty goes as zero rows', () => {
    const data = layer({ top_pods: [], top_nodes: [] })
    expect(data.top_pods).toEqual([])
    expect(data.top_nodes).toEqual([])
    expect(data).not.toHaveProperty('top_pods_refused')
    expect(data).not.toHaveProperty('top_nodes_error')
  })
})

// The summary cards show "—" while the overview read is failed, the last answer still held beside the error: the chat
// gets no number of that answer, and the failure with the server's reason.
describe("the Dashboard's summary numbers in the floating chat when their read did not answer", () => {
  const counted = { cluster_version: 'v1.34.1', total_namespaces: 7, total_pods: 42, total_services: 9, total_deployments: 11, total_pvcs: 3, total_pvs: 2, node_count: 4, pod_status: { Running: 40, Pending: 2 }, refused: [] }
  const failed = { response: { status: 500, data: { detail: 'listing namespaces timed out' } }, message: 'Request failed with status code 500' }
  const refused = { response: { status: 403, data: { detail: 'namespaces is forbidden: User "kubeast:user:7" cannot list resource "namespaces"' } }, message: 'Request failed with status code 403' }

  function told(overview: unknown, overviewError: unknown) {
    chat.current = null
    function Probe() {
      useDashboardAIContext({ overview, overviewError, nodes: [], topResources: { top_pods: [], top_nodes: [node] }, problemPods: undefined })
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    return chat.current as { summary?: string; data?: Record<string, any> } | null
  }

  it('a re-read that failed goes as failed with its status and reason, without the last answer\'s numbers', () => {
    const got = told(counted, failed)
    expect(got?.data?.cluster_failed).toEqual({ status: 500, reason: 'listing namespaces timed out' })
    expect(got?.data?.cluster).toEqual({ version: 'v1.34.1' })
    expect(got?.data).not.toHaveProperty('pod_status')
    expect(got?.data).not.toHaveProperty('interpretations')
    expect(got?.summary).toBe('클러스터 요약 — 불러오지 못함: listing namespaces timed out')
    expect(got?.data?.top_nodes).toEqual([node])
  })

  it('a refused read goes as refused with the server\'s reason', () => {
    const got = told(counted, refused)
    expect(got?.data?.cluster_refused).toBe(refused.response.data.detail)
    expect(got?.data).not.toHaveProperty('cluster_failed')
    expect(got?.data?.cluster).toEqual({ version: 'v1.34.1' })
    expect(got?.summary).toBe(`클러스터 요약 — 볼 권한 없음: ${refused.response.data.detail}`)
  })

  it('a first read that failed goes as failed, not as nothing', () => {
    const got = told(undefined, { message: 'Network Error' })
    expect(got?.data?.cluster_failed).toEqual({ reason: 'Network Error' })
    expect(got?.data).not.toHaveProperty('cluster')
    expect(got?.summary).toBe('클러스터 요약 — 불러오지 못함: Network Error')
  })

  it('nothing while the first read is on its way, and the numbers once it answered', () => {
    expect(told(undefined, null)).toBeNull()
    const got = told(counted, null)
    expect(got?.data?.cluster).toMatchObject({ total_pods: 42, node_count: 4 })
    expect(got?.data?.pod_status).toEqual({ Running: 40, Pending: 2 })
    expect(got?.data).not.toHaveProperty('cluster_failed')
    expect(got?.summary).toBe('⚠️ 클러스터 — 노드 4개, Pod 40/42 Running, 문제 2')
  })
})
