import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import { elementsOf, fakeRender, fakeUnmount } from '@/testing/fakeHooks'
import { fakeDocument } from '@/testing/fakeDocument'
import type { TrafficLine, TrafficResult } from '@/services/api'

// The Resource Graph page with its reads answered: what the graph (React Flow) is handed and what the page draws
// beside it, rendered with the fake hooks.
const g = vi.hoisted(() => ({ nodes: [] as unknown[], edges: [] as unknown[], traffic: undefined as unknown, opened: [] as unknown[], target: null as unknown }))
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
// the drawer as the page sees it: what it was asked to open, and the object it shows (null once closed)
vi.mock('@/components/ResourceDetailContext', () => ({
  useResourceDetail: () => ({ open: (t: unknown) => { g.opened.push(t); g.target = t }, target: g.target }),
}))
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
import { PodGroupList } from './resource-graph/PodGroupList'
import { PEER_KIND } from './resource-graph/traffic'

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
  g.opened = []
  g.target = null
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

// A box takes the keyboard focus but Enter only selected it (React Flow's own key; onNodeClick hears the pointer only).
describe('Resource Graph box on Enter', () => {
  const key = (key: string, target: unknown, isComposing = false) =>
    (flow(page()).onKeyDown as (e: unknown) => void)({ key, target, nativeEvent: { isComposing } })
  const click = (node: Node) => (flow(page()).onNodeClick as (e: unknown, n: Node) => void)({}, node)
  // a box as React Flow draws it: the node `div` with the focus, its data-id
  const box = (id: string) => {
    const el = { focus: vi.fn(), isConnected: true, getAttribute: (name: string) => (name === 'data-id' ? id : null), closest: (s: string) => (s === '.react-flow__node' ? el : null) }
    return el
  }
  const groupList = (tree: unknown) => elementsOf(tree, (_p, type) => type === PodGroupList)[0]?.props as Props | undefined
  const closeDrawer = () => {
    g.target = null
    page()
  }
  const groupRaw = { id: 'pods-web', kind: 'Pod', name: 'web (12)', namespace: 'default', status: 'Running', group: true, count: 12, ownerKind: 'Deployment', ownerName: 'web' }
  const peerRaw = (end: Record<string, string>) => ({ id: 'peer', kind: PEER_KIND, name: 'peer', namespace: 'default', status: '', end })

  it('opens the drawer of the box with the focus, as a press on it does', () => {
    click(nodes[0])
    const pressed = g.opened.splice(0)
    closeDrawer()
    key('Enter', box('n-web'))
    expect(pressed).toEqual([{ kind: 'Deployment', name: 'web', namespace: 'default' }])
    expect(g.opened, 'the same target as the press').toEqual(pressed)
  })

  it('gives the focus back to the box when its drawer closes, unless it was put somewhere else meanwhile', () => {
    const web = box('n-web')
    key('Enter', web)
    page()
    expect(web.focus, 'not while the drawer is open').not.toHaveBeenCalled()
    closeDrawer()
    expect(web.focus, 'the drawer took the focus with it').toHaveBeenCalledOnce()

    const db = box('n-db')
    key('Enter', db)
    page()
    ;(document as unknown as { activeElement: unknown }).activeElement = { put: 'elsewhere' }
    closeDrawer()
    expect(db.focus).not.toHaveBeenCalled()
    expect(web.focus, 'once only').toHaveBeenCalledOnce()
  })

  it('opens a group box’s pods window, as a press does, and no drawer', () => {
    const group: Node = { id: 'n-group', position: { x: 0, y: 0 }, data: { raw: groupRaw } }
    g.nodes = [...nodes, group]
    click(group)
    const pressed = groupList(page())?.group
    expect(pressed).toEqual(groupRaw)
    ;(groupList(page())?.onClose as () => void)()
    expect(groupList(page())).toBeUndefined()
    const el = box('n-group')
    key('Enter', el)
    expect(groupList(page())?.group, 'the same window as the press').toEqual(pressed)
    expect(g.opened).toEqual([])
    // the window gives the focus back to the box itself (ModalOverlay's opener), so a drawer the pointer opens later
    // does not give the focus to the group box when it closes
    ;(groupList(page())?.onClose as () => void)()
    click(nodes[0])
    page()
    closeDrawer()
    expect(el.focus).not.toHaveBeenCalled()
  })

  it('opens a peer’s object as a press does, and nothing for a peer outside the pods', () => {
    const peer: Node = { id: 'n-peer', position: { x: 0, y: 0 }, data: { raw: peerRaw({ kind: 'Deployment', name: 'api', namespace: 'shop' }) } }
    const outside: Node = { id: 'n-out', position: { x: 0, y: 0 }, data: { raw: peerRaw({ name: 'world' }) } }
    g.nodes = [...nodes, peer, outside]
    key('Enter', box('n-peer'))
    expect(g.opened).toEqual([{ kind: 'Deployment', name: 'api', namespace: 'shop' }])
    closeDrawer()
    const out = box('n-out')
    key('Enter', out)
    expect(g.opened, 'nothing more opened').toHaveLength(1)
    // a drawer the pointer opens later does not give the focus to that box when it closes
    click(nodes[0])
    page()
    closeDrawer()
    expect(out.focus).not.toHaveBeenCalled()
  })

  it('opens nothing on Space or Escape (React Flow selects with them) or on Enter while an input method composes', () => {
    key(' ', box('n-web'))
    key('Escape', box('n-web'))
    key('Enter', box('n-web'), true)
    expect(g.opened).toEqual([])
    expect(groupList(page())).toBeUndefined()
    key('Enter', box('n-web'))
    expect(g.opened, 'the same page opens it on Enter').toHaveLength(1)
  })
})
