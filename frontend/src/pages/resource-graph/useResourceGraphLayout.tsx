// Resource graph 의 react-flow 노드/엣지 빌드 + ELK 레이아웃 적용 hook
//
// frontend/src/pages/ResourceGraph.tsx 의 filteredNodes/Edges useMemo + ELK
// useEffect 를 묶어 추출. 결과 nodes/edges + layoutReady 플래그 반환.

import { useEffect, useMemo, useState } from 'react'
import {
  type Node,
  type Edge,
  useNodesState,
  useEdgesState,
  MarkerType,
} from '@xyflow/react'
import i18next from 'i18next'
import type { ResourceGraphNode, ResourceGraphEdge, TrafficEnd, TrafficLine } from '@/services/api'
import { edgeStyles, kindIcon, pointsUp, statusColor, type GroupBy } from './constants'
import { applyElkLayout } from './elkLayout'
import { buildTraffic, endText, lineColor, type GraphView, type TrafficEdge } from './traffic'

export interface ResourceGraphLayoutInput {
  graphData: { nodes: ResourceGraphNode[]; edges: ResourceGraphEdge[] } | undefined
  kindFilters: Set<string>
  edgeTypeFilters: Set<string>
  searchQuery: string
  statusFilter: 'all' | 'issues'
  groupBy: GroupBy
  view?: GraphView
  // the traffic lines, once read (undefined in the structure view or while loading)
  traffic?: TrafficLine[]
}

// count writes a line's number short: 1234 → 1.2k.
export function count(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function peerKindText(e: TrafficEnd): string {
  if (e.name) return e.kind || i18next.t('resourceGraph.traffic.peerPodOrWorkload', 'Pod or workload')
  if (e.namespace) return 'Namespace'
  return i18next.t('resourceGraph.traffic.peerOutside', 'Outside the pods')
}

function trafficEdge(t: TrafficEdge): Edge {
  const color = lineColor[t.state]
  const label = t.state === 'allowed' ? count(t.line.allowed) : t.state === 'dropped' ? `✕ ${count(t.line.dropped)}` : `${count(t.line.allowed)} · ✕ ${count(t.line.dropped)}`
  return {
    id: t.id,
    source: t.source,
    target: t.target,
    style: { stroke: color, strokeWidth: t.width, strokeDasharray: t.state === 'dropped' ? '6 4' : undefined },
    // the arrowhead keeps its size on a wide line
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14, markerUnits: 'userSpaceOnUse' },
    label,
    labelStyle: { fill: color, fontSize: 10, fontWeight: 600 },
    labelBgStyle: { fill: '#0f172a', fillOpacity: 0.9 },
    labelBgPadding: [4, 2] as [number, number],
    labelBgBorderRadius: 4,
    interactionWidth: 16,
    zIndex: 1,
    ariaLabel: `${endText(t.line.from)} → ${endText(t.line.to)}`,
    data: { line: t.line, state: t.state },
  }
}

export function useResourceGraphLayout({
  graphData,
  kindFilters,
  edgeTypeFilters,
  searchQuery,
  statusFilter,
  groupBy,
  view = 'structure',
  traffic,
}: ResourceGraphLayoutInput) {
  const [layoutReady, setLayoutReady] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const { filteredNodes, filteredEdges, routed, layoutData, selfLoops } = useMemo(() => {
    if (!graphData?.nodes || !graphData?.edges) return { filteredNodes: [] as Node[], filteredEdges: [] as Edge[], routed: false, layoutData: graphData, selfLoops: 0 }

    // Filter nodes
    let gNodes = graphData.nodes.filter(n => kindFilters.has(n.kind))

    if (statusFilter === 'issues') {
      const issueStatuses = ['failed', 'error', 'crashloopbackoff', 'imagepullbackoff', 'pending', 'terminating']
      gNodes = gNodes.filter(n => issueStatuses.some(s => n.status.toLowerCase().includes(s)))
    }

    // Traffic lines: their ends on the nodes shown, or on stand-ins. The traffic view keeps only the nodes
    // that have a line.
    const withTraffic = view !== 'structure' && !!traffic
    const placed = withTraffic ? buildTraffic(traffic, new Map(gNodes.map(n => [n.id, n]))) : { peers: [], edges: [], selfLoops: 0 }
    if (view === 'traffic') {
      const ends = new Set(placed.edges.flatMap(e => [e.source, e.target]))
      gNodes = gNodes.filter(n => ends.has(n.id))
    }

    const nodeIds = new Set(gNodes.map(n => n.id))
    // routed lines start and end on the box the layout assumed (200 × 60), so the box is exactly that tall
    const boxSize = withTraffic ? { height: 60, display: 'flex', flexDirection: 'column' as const, justifyContent: 'center' } : {}

    // Build RF nodes
    const peerNodes: Node[] = placed.peers.map(p => ({
      id: p.id,
      data: {
        label: (
          <div className="flex items-center gap-1.5 px-2 py-1 min-w-0" data-testid="traffic-peer">
            <span className="text-base shrink-0">{p.end.name ? kindIcon[p.end.kind ?? ''] || '📄' : p.end.namespace ? '🗂' : '🌐'}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] text-slate-400 leading-tight">{peerKindText(p.end)}</div>
              <div className="text-xs font-medium text-white truncate leading-tight" title={p.name}>{p.name}</div>
              {p.end.name && p.namespace && <div className="text-[10px] text-slate-400 leading-tight truncate">{p.namespace}</div>}
            </div>
          </div>
        ),
        raw: p,
      },
      position: { x: 0, y: 0 },
      style: { background: '#0f172a', border: '2px dashed #64748b', borderRadius: '8px', padding: 0, width: 200, ...boxSize },
    }))
    const rfNodes: Node[] = gNodes.map(n => {
      const icon = kindIcon[n.kind] || '📄'
      const borderColor = statusColor(n.status)
      const isHighlighted = searchQuery && n.name.toLowerCase().includes(searchQuery.toLowerCase())
      return {
        id: n.id,
        data: {
          label: (
            <div className="flex items-center gap-1.5 px-2 py-1 min-w-0">
              <span className="text-base shrink-0">{icon}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] text-slate-400 leading-tight">{n.kind}</div>
                <div className="text-xs font-medium text-white truncate leading-tight" title={n.name}>
                  {n.name}
                </div>
                {n.ready && <div className="text-[10px] text-slate-400 leading-tight">{n.ready}</div>}
              </div>
            </div>
          ),
          raw: n,
        },
        position: { x: 0, y: 0 },
        style: {
          background: '#1e293b',
          border: `2px solid ${borderColor}`,
          borderRadius: '8px',
          padding: 0,
          width: 200,
          ...boxSize,
          boxShadow: isHighlighted ? '0 0 0 3px #3b82f6' : undefined,
          opacity: searchQuery && !isHighlighted ? 0.3 : 1,
        },
      }
    })

    // Build RF edges
    const kindOf = new Map(gNodes.map(n => [n.id, n.kind]))
    const rfEdges: Edge[] = (view === 'traffic' ? [] : graphData.edges)
      .filter(e => edgeTypeFilters.has(e.type) && nodeIds.has(e.source) && nodeIds.has(e.target))
      .map((e, i) => {
        const style = edgeStyles[e.type] || edgeStyles.owns
        const arrow = { type: MarkerType.ArrowClosed, color: style.stroke }
        const up = pointsUp(kindOf.get(e.source) ?? '', kindOf.get(e.target) ?? '')
        return {
          id: `e-${i}`,
          source: up ? e.target : e.source,
          target: up ? e.source : e.target,
          animated: e.type === 'selects',
          style: { stroke: style.stroke, strokeDasharray: style.strokeDasharray, strokeWidth: 1.5 },
          ...(up ? { markerStart: arrow } : { markerEnd: arrow }),
          label: style.label,
          labelStyle: { fill: style.stroke, fontSize: 10 },
          labelBgStyle: { fill: '#0f172a', fillOpacity: 0.8 },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
        }
      })

    // with traffic on, every line is laid out and routed around the boxes
    const lines = placed.edges.map(trafficEdge)
    const data = placed.peers.length > 0 ? { nodes: [...graphData.nodes, ...placed.peers], edges: graphData.edges } : graphData
    return { filteredNodes: [...rfNodes, ...peerNodes], filteredEdges: [...rfEdges, ...lines], routed: withTraffic, layoutData: data, selfLoops: placed.selfLoops }
  }, [graphData, kindFilters, edgeTypeFilters, searchQuery, statusFilter, view, traffic])

  useEffect(() => {
    if (filteredNodes.length === 0 || !layoutData?.nodes) {
      setNodes([])
      setEdges([])
      setLayoutReady(true)
      return
    }

    setLayoutReady(false)
    applyElkLayout(filteredNodes, filteredEdges, groupBy, layoutData, { byTraffic: view === 'traffic', routed })
      .then(({ nodes: ln, edges: le }) => {
        setNodes(ln)
        setEdges(le)
        setLayoutReady(true)
      })
      .catch(err => {
        console.error('ELK layout error:', err)
        // Fallback: simple grid
        setNodes(filteredNodes.map((n, i) => ({
          ...n,
          position: { x: (i % 8) * 250, y: Math.floor(i / 8) * 100 },
        })))
        setEdges(filteredEdges)
        setLayoutReady(true)
      })
  }, [filteredNodes, filteredEdges, routed, groupBy, layoutData, view, setNodes, setEdges])

  return { nodes, edges, onNodesChange, onEdgesChange, layoutReady, selfLoops, routed }
}
