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
} from 'react-flow-renderer'
import type { ResourceGraphNode, ResourceGraphEdge } from '@/services/api'
import { edgeStyles, kindIcon, statusColor, type GroupBy } from './constants'
import { applyElkLayout } from './elkLayout'

export interface ResourceGraphLayoutInput {
  graphData: { nodes: ResourceGraphNode[]; edges: ResourceGraphEdge[] } | undefined
  kindFilters: Set<string>
  edgeTypeFilters: Set<string>
  searchQuery: string
  statusFilter: 'all' | 'issues'
  groupBy: GroupBy
}

export function useResourceGraphLayout({
  graphData,
  kindFilters,
  edgeTypeFilters,
  searchQuery,
  statusFilter,
  groupBy,
}: ResourceGraphLayoutInput) {
  const [layoutReady, setLayoutReady] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])

  const { filteredNodes, filteredEdges } = useMemo(() => {
    if (!graphData?.nodes || !graphData?.edges) return { filteredNodes: [] as Node[], filteredEdges: [] as Edge[] }

    // Filter nodes
    let gNodes = graphData.nodes.filter(n => kindFilters.has(n.kind))

    if (statusFilter === 'issues') {
      const issueStatuses = ['failed', 'error', 'crashloopbackoff', 'imagepullbackoff', 'pending', 'terminating']
      gNodes = gNodes.filter(n => issueStatuses.some(s => n.status.toLowerCase().includes(s)))
    }

    const nodeIds = new Set(gNodes.map(n => n.id))

    // Build RF nodes
    const rfNodes: Node[] = gNodes.map(n => {
      const icon = kindIcon[n.kind] || '📄'
      const borderColor = statusColor(n.status)
      const isHighlighted = searchQuery && n.name.toLowerCase().includes(searchQuery.toLowerCase())
      return {
        id: n.id,
        data: {
          label: (
            <div className="flex items-center gap-1.5 px-2 py-1 min-w-0">
              <span className="text-base flex-shrink-0">{icon}</span>
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
          boxShadow: isHighlighted ? '0 0 0 3px #3b82f6' : undefined,
          opacity: searchQuery && !isHighlighted ? 0.3 : 1,
        },
      }
    })

    // Build RF edges
    const rfEdges: Edge[] = graphData.edges
      .filter(e => edgeTypeFilters.has(e.type) && nodeIds.has(e.source) && nodeIds.has(e.target))
      .map((e, i) => {
        const style = edgeStyles[e.type] || edgeStyles.owns
        return {
          id: `e-${i}`,
          source: e.source,
          target: e.target,
          animated: e.type === 'selects',
          style: { stroke: style.stroke, strokeDasharray: style.strokeDasharray, strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: style.stroke },
          label: style.label,
          labelStyle: { fill: style.stroke, fontSize: 10 },
          labelBgStyle: { fill: '#0f172a', fillOpacity: 0.8 },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
        }
      })

    return { filteredNodes: rfNodes, filteredEdges: rfEdges }
  }, [graphData, kindFilters, edgeTypeFilters, searchQuery, statusFilter])

  useEffect(() => {
    if (filteredNodes.length === 0 || !graphData?.nodes) {
      setNodes([])
      setEdges([])
      setLayoutReady(true)
      return
    }

    setLayoutReady(false)
    applyElkLayout(filteredNodes, filteredEdges, groupBy, graphData)
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
  }, [filteredNodes, filteredEdges, groupBy, graphData, setNodes, setEdges])

  return { nodes, edges, onNodesChange, onEdgesChange, layoutReady }
}
