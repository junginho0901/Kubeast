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
