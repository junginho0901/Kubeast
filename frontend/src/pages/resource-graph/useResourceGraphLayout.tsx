// Resource graph 의 react-flow 노드/엣지 빌드 + ELK 레이아웃 적용 hook
//
// frontend/src/pages/ResourceGraph.tsx 의 filteredNodes/Edges useMemo + ELK
// useEffect 를 묶어 추출. 결과 nodes/edges + layoutReady 플래그 반환.

import { useEffect, useMemo, useState, type ReactElement } from 'react'
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
import { boxHeight, buildTraffic, byPort, endText, lineColor, portText, BOX_HEIGHT, ROW_HEIGHT, ROWS_PADDING, type GraphView, type PortEdge, type PortRow, type TrafficEdge } from './traffic'

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

// trafficEdge draws a line, or (Traffic view) its share to one port, which ends at that port's row of the box
// and so carries only its counts; elsewhere the port starts the line's number.
function trafficEdge(t: TrafficEdge | PortEdge): Edge {
  const color = lineColor[t.state]
  const share = 'lineId' in t ? t : undefined
  const [allowed, dropped] = share ? [share.allowed, share.dropped] : [t.line.allowed, t.line.dropped]
  const counts = t.state === 'allowed' ? count(allowed) : t.state === 'dropped' ? `✕ ${count(dropped)}` : `${count(allowed)} · ✕ ${count(dropped)}`
  const ports = share ? '' : portText(t.line.ports)
  const label = ports ? `${ports} · ${counts}` : counts
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
    ariaLabel: `${endText(t.line.from)} → ${endText(t.line.to)}${share?.rowText ? ` (${share.rowText})` : ''}`,
    data: { line: t.line, state: t.state, lineId: share?.lineId ?? t.id, row: share?.row },
  }
}

// rowsBlock lists a receiving box's ports under its head, one row each, where the lines to that port end.
function rowsBlock(rows: PortRow[]) {
  return (
    <div className="border-t border-slate-700" style={{ paddingTop: ROWS_PADDING / 2, paddingBottom: ROWS_PADDING / 2 }} data-testid="port-rows">
      {rows.map(r => (
        <div key={r.key} className="flex items-center justify-between px-2 font-mono text-[10px] text-slate-300" style={{ height: ROW_HEIGHT }} data-testid="port-row" data-port-text={r.text}>
          <span>{r.text}</span>
          <span>
            {r.allowed > 0 && <span style={{ color: lineColor.allowed }}>{count(r.allowed)}</span>}
            {r.allowed > 0 && r.dropped > 0 && <span className="text-slate-500"> · </span>}
            {r.dropped > 0 && <span style={{ color: lineColor.dropped }}>✕ {count(r.dropped)}</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

// withRows puts the head in BOX_HEIGHT and the rows under it, when the box has rows.
function withRows(head: ReactElement, rows: PortRow[] | undefined) {
  if (!rows) return head
  return (
    <div className="w-full">
      <div className="flex flex-col justify-center" style={{ height: BOX_HEIGHT }}>{head}</div>
      {rowsBlock(rows)}
    </div>
  )
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
    // the Traffic view splits the lines by port into the receiving boxes' rows
    const split = view === 'traffic' && withTraffic ? byPort(placed.edges) : undefined
    const rowsOf = split?.rows ?? new Map<string, PortRow[]>()
    const layoutOf = (id: string) => {
      const rows = rowsOf.get(id)
      return rows ? { height: boxHeight(rows.length), rows: rows.map(r => r.key) } : undefined
    }

    const nodeIds = new Set(gNodes.map(n => n.id))
    // routed lines start and end on the box the layout assumed (200 × 60), so the box is exactly that tall
    const boxSize = (id: string) => withTraffic ? { height: layoutOf(id)?.height ?? BOX_HEIGHT, display: 'flex', flexDirection: 'column' as const, justifyContent: 'center' } : {}

    // Build RF nodes
    const peerNodes: Node[] = placed.peers.map(p => ({
      id: p.id,
      data: {
        label: withRows(
          <div className="flex items-center gap-1.5 px-2 py-1 min-w-0" data-testid="traffic-peer">
            <span className="text-base shrink-0">{p.end.name ? kindIcon[p.end.kind ?? ''] || '📄' : p.end.namespace ? '🗂' : '🌐'}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] text-slate-400 leading-tight">{peerKindText(p.end)}</div>
              <div className="text-xs font-medium text-white truncate leading-tight" title={p.name}>{p.name}</div>
              {p.end.name && p.namespace && <div className="text-[10px] text-slate-400 leading-tight truncate">{p.namespace}</div>}
            </div>
          </div>,
          rowsOf.get(p.id),
        ),
        raw: p,
        layout: layoutOf(p.id),
      },
      position: { x: 0, y: 0 },
      style: { background: '#0f172a', border: '2px dashed #64748b', borderRadius: '8px', padding: 0, width: 200, ...boxSize(p.id) },
    }))
    const rfNodes: Node[] = gNodes.map(n => {
      const icon = kindIcon[n.kind] || '📄'
      const borderColor = statusColor(n.status)
      const isHighlighted = searchQuery && n.name.toLowerCase().includes(searchQuery.toLowerCase())
      return {
        id: n.id,
        data: {
          label: withRows(
            <div className="flex items-center gap-1.5 px-2 py-1 min-w-0">
              <span className="text-base shrink-0">{icon}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] text-slate-400 leading-tight">{n.kind}</div>
                <div className="text-xs font-medium text-white truncate leading-tight" title={n.name}>
                  {n.name}
                </div>
                {n.ready && <div className="text-[10px] text-slate-400 leading-tight">{n.ready}</div>}
              </div>
            </div>,
            rowsOf.get(n.id),
          ),
          raw: n,
          layout: layoutOf(n.id),
        },
        position: { x: 0, y: 0 },
        style: {
          background: '#1e293b',
          border: `2px solid ${borderColor}`,
          borderRadius: '8px',
          padding: 0,
          width: 200,
          ...boxSize(n.id),
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
    const lines = (split?.edges ?? placed.edges).map(trafficEdge)
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
