import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import { elementsOf, fakeRender, fakeUnmount } from '@/testing/fakeHooks'
import { fakeDocument } from '@/testing/fakeDocument'
import type { TrafficLine, TrafficResult } from '@/services/api'

// The Resource Graph page with its reads answered: what the graph (React Flow) is handed and what the page draws
// beside it, rendered with the fake hooks.
const g = vi.hoisted(() => ({ nodes: [] as unknown[], edges: [] as unknown[], traffic: undefined as unknown }))
vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
vi.mock('react-router-dom', () => ({ useSearchParams: () => [new URLSearchParams()] }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery:({ queryKey }: { queryKey: unknown[] }) => {
    const data = queryKey[0] === 'namespaces' ? [{ name: 'default' }]
      : queryKey[0] === 'resource-graph' ? { nodes: [{ id: 'web', kind: 'Deployment', name: 'web', namespace: 'default', status: 'Available' }], edges: [] }
        : queryKey[0] === 'network-traffic' ? g.traffic : undefined
    return { data, isLoading: false, isFetching: false, error: null, refetch: async () => ({}) }
  },
}))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
vi.mock('@/hooks/usePrometheusQuery', () => ({ useClusterFeatures: () => ({ data: { networkFlows: { enabled: true, clusters: ['self'] } } }), prometheusNotAnswering: () => null }))
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => true }) }))
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'self' }) }))
vi.mock('@/services/confirm', () => ({ useConfirm: () => async () => true }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {}, target: null }) }))
vi.mock('@/components/resource-detail/NetworkPolicyCheckModal', () => ({ default: () => null }))
vi.mock('@xyflow/react', () => ({
  ReactFlow: function ReactFlow() { return null },
  Controls: () => null, Background: () => null, MiniMap: () => null, BackgroundVariant: { Dots: 'dots' },
  Handle: () => null, Position: {}, BaseEdge: () => null, EdgeLabelRenderer: () => null,
}))
vi.mock('./resource-graph/useResourceGraphLayout', () => ({
  useResourceGraphLayout: () => ({ nodes: g.nodes, edges: g.edges, onNodesChange: () => {}, onEdgesChange: () => {}, layoutReady: true, selfLoops: 0, routed: true, shown: { nodes: 2, edges: 1 } }),
}))

import ResourceGraph from './ResourceGraph'
import { Glance } from './resource-graph/Glance'

const { install } = fakeDocument()
const line: TrafficLine = {
  from: { namespace: 'default', kind: 'Deployment', name: 'web' },
  to: { namespace: 'default', kind: 'Deployment', name: 'db' },
  allowed: 4,
  dropped: 0,
}
const traffic: TrafficResult = { available: true, source: 'relay', namespaces: ['default'], since: '5m', lines: [line] }
const raw = (name: string) => ({ id: name, kind: 'Deployment', name, namespace: 'default', status: 'Available' })
const nodes: Node[] = [
  { id: 'n-web', position: { x: 0, y: 0 }, data: { raw: raw('web') } },
  { id: 'n-db', position: { x: 0, y: 0 }, data: { raw: raw('db') } },
]
const edges: Edge[] = [
  { id: 'line-1', source: 'n-web', target: 'n-db', data: { line } },
  { id: 'owns-1', source: 'n-web', target: 'n-db', data: {} },
]
beforeEach(() => {
  install()
  g.nodes = nodes
  g.edges = edges
  g.traffic = traffic
})
afterEach(() => {
  fakeUnmount()
  vi.unstubAllGlobals()
})

type Props = Record<string, unknown>
const page = () => fakeRender(() => ResourceGraph())
const flow = (tree: unknown) => elementsOf(tree, (_p, type) => typeof type === 'function' && type.name === 'ReactFlow')[0].props as Props
const glanceProps = (tree: unknown) => elementsOf(tree, (_p, type) => type === Glance)[0].props as Props
// a box or line element as React Flow draws it, with its data-id
const drawn = (cls: string, id: string | null, rect = { right: 300, top: 120 }) => {
  const el = {
    focus: vi.fn(),
    getBoundingClientRect: () => rect,
    getAttribute: (name: string) => (name === 'data-id' ? id : null),
    closest: (selector: string) => (selector === cls ? el : null),
  }
  return el
}

describe('Resource Graph glance', () => {
  it('shows the box the pointer is on, keeps it while the pointer is on the glance, and hands the glance its pointer', () => {
    ;(flow(page()).onNodeMouseEnter as (e: unknown, n: Node) => void)({ currentTarget: drawn('.react-flow__node', 'n-web') }, nodes[0])
    let glance = glanceProps(page())
    expect((glance.node as { name: string }).name).toBe('web')
    expect(glance.position).toMatchObject({ x: 300, y: 120 })
    ;(flow(page()).onNodeMouseLeave as () => void)()
    ;(glanceProps(page()).onMouseEnter as () => void)()
    glance = glanceProps(page())
    expect((glance.node as { name: string }).name, 'the pointer moved onto the glance').toBe('web')
    ;(glance.onMouseLeave as () => void)()
    expect(glanceProps(page()).node).toBeNull()
  })

  it('shows the box with the keyboard focus, heard on React Flow’s own box', () => {
    ;(flow(page()).onFocus as (e: unknown) => void)({ target: drawn('.react-flow__node', 'n-db', { right: 500, top: 40 }) })
    const glance = glanceProps(page())
    expect((glance.node as { name: string }).name).toBe('db')
    expect(glance.position).toMatchObject({ x: 500, y: 40 })
    ;(flow(page()).onBlur as () => void)()
    expect(glanceProps(page()).node).toBeNull()
  })
})
