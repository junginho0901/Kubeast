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
import { ResourceGraphHeader } from './resource-graph/ResourceGraphHeader'
import { TrafficPanel } from './resource-graph/TrafficPanel'

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

// A traffic line takes the keyboard focus but Enter opened nothing (onEdgeClick hears the pointer only).
describe('Resource Graph traffic line on Enter', () => {
  const trafficView = () => {
    const header = elementsOf(page(), (_p, type) => type === ResourceGraphHeader)[0].props as Props
    ;((header.extra as { props: Props }).props.setView as (v: string) => void)('traffic')
  }
  const key = (key: string, target: unknown, isComposing = false) =>
    (flow(page()).onKeyDown as (e: unknown) => void)({ key, target, nativeEvent: { isComposing } })
  const panel = (tree: unknown) => elementsOf(tree, (_p, type) => type === TrafficPanel)[0]?.props as Props | undefined

  it('opens the panel of the line with the focus, which Escape gives the focus back to', () => {
    trafficView()
    expect(panel(page())).toBeUndefined()
    const g = drawn('.react-flow__edge', 'line-1')
    key('Enter', g)
    const open = panel(page())
    expect(open?.line).toBe(line)
    expect((open?.opener as { current: unknown }).current, 'the line Escape focuses again').toBe(g)
    ;(open?.onClose as () => void)()
    expect(panel(page())).toBeUndefined()
  })

  it('opens nothing for a line of the structure, another key or an input method composing', () => {
    trafficView()
    key('Enter', drawn('.react-flow__edge', 'owns-1'))
    key(' ', drawn('.react-flow__edge', 'line-1'))
    key('Enter', drawn('.react-flow__edge', 'line-1'), true)
    expect(panel(page())).toBeUndefined()
    key('Enter', drawn('.react-flow__edge', 'line-1'))
    expect(panel(page())?.line, 'the same page opens it on Enter').toBe(line)
  })
})
