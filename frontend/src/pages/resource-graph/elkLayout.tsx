// ELK 기반 react-flow 레이아웃 함수
//
// frontend/src/pages/ResourceGraph.tsx 의 applyElkLayout 함수 추출.
// groupBy='none' = flat layered / 그 외 = compound (group container) 레이아웃.
// JSX 라벨 (Layers icon) 사용으로 .tsx 확장자.

import type { Node, Edge } from 'react-flow-renderer'
import { Position } from 'react-flow-renderer'
import ELK from 'elkjs/lib/elk.bundled.js'
import { Layers } from 'lucide-react'
import type { ResourceGraphNode, ResourceGraphEdge } from '@/services/api'
import { kindWeight, type GroupBy } from './constants'

const elk = new ELK()

export async function applyElkLayout(
  rfNodes: Node[],
  rfEdges: Edge[],
  groupBy: GroupBy,
  graphData: { nodes: ResourceGraphNode[]; edges: ResourceGraphEdge[] },
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (rfNodes.length === 0) return { nodes: [], edges: [] }

  // Build groups
  const groups = new Map<string, ResourceGraphNode[]>()
  const nodeIdToGroup = new Map<string, string>()

  if (groupBy !== 'none') {
    for (const n of graphData.nodes) {
      let key = ''
      if (groupBy === 'namespace') key = n.namespace || '(cluster)'
      else if (groupBy === 'node') key = n.nodeName || '(unscheduled)'
      else if (groupBy === 'instance') key = n.instanceLabel || '(ungrouped)'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(n)
      nodeIdToGroup.set(n.id, key)
    }
  }

  const rfNodeIds = new Set(rfNodes.map(n => n.id))
  const validEdges = rfEdges.filter(e => rfNodeIds.has(e.source) && rfNodeIds.has(e.target))

  if (groupBy === 'none') {
    // Flat layout
    const graph = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'DOWN',
        'elk.edgeRouting': 'SPLINES',
        'elk.spacing.nodeNode': '60',
        'elk.layered.spacing.nodeNodeBetweenLayers': '80',
        'partitioning.activate': 'true',
        'elk.nodeSize.minimum': '(200,60)',
        'elk.nodeSize.constraints': '[MINIMUM_SIZE]',
      },
      children: rfNodes.map(n => ({
        id: n.id,
        width: 200,
        height: 60,
        layoutOptions: {
          'partitioning.partition': String(-(kindWeight[n.data?.raw?.kind] || 0)),
        },
      })),
      edges: validEdges.map((e, i) => ({
        id: `elk-e-${i}`,
        sources: [e.source],
        targets: [e.target],
      })),
    }

    const result = await elk.layout(graph)
    const posMap = new Map<string, { x: number; y: number }>()
    result.children?.forEach(c => posMap.set(c.id, { x: c.x!, y: c.y! }))
    return {
      nodes: rfNodes.map(n => ({
        ...n,
        position: posMap.get(n.id) || { x: 0, y: 0 },
        targetPosition: Position.Top,
        sourcePosition: Position.Bottom,
      })),
      edges: validEdges,
    }
  }

  // Grouped layout
  const groupEntries = [...groups.entries()]
  const groupNodes: Node[] = []
  const childNodes: Node[] = []

  // Build ELK graph with compound nodes
  const elkChildren: any[] = []

  for (const [groupKey, members] of groupEntries) {
    const groupId = `group-${groupKey}`
    const memberIds = new Set(members.map(m => m.id))
    const memberRfNodes = rfNodes.filter(n => memberIds.has(n.id))
    const intraEdges = validEdges.filter(e => memberIds.has(e.source) && memberIds.has(e.target))

    elkChildren.push({
      id: groupId,
      layoutOptions: intraEdges.length > 0
        ? {
            'elk.algorithm': 'layered',
            'elk.direction': 'DOWN',
            'elk.edgeRouting': 'SPLINES',
            'elk.spacing.nodeNode': '40',
            'elk.layered.spacing.nodeNodeBetweenLayers': '60',
            'partitioning.activate': 'true',
            'elk.padding': '[left=16, top=40, right=16, bottom=16]',
          }
        : {
            'elk.algorithm': 'rectpacking',
            'elk.spacing.nodeNode': '20',
            'elk.padding': '[left=16, top=40, right=16, bottom=16]',
          },
      children: memberRfNodes.map(n => ({
        id: n.id,
        width: 200,
        height: 60,
        layoutOptions: {
          'partitioning.partition': String(-(kindWeight[n.data?.raw?.kind] || 0)),
        },
      })),
      edges: intraEdges.map((e, i) => ({
        id: `elk-ge-${groupKey}-${i}`,
        sources: [e.source],
        targets: [e.target],
      })),
    })
  }

  // Cross-group edges
  const crossEdges = validEdges.filter(e => {
    const sg = nodeIdToGroup.get(e.source)
    const tg = nodeIdToGroup.get(e.target)
    return sg !== tg
  })

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'SPLINES',
      'elk.spacing.nodeNode': '80',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100',
    },
    children: elkChildren,
    edges: crossEdges.map((e, i) => ({
      id: `elk-ce-${i}`,
      sources: [e.source],
      targets: [e.target],
    })),
  }

  const result = await elk.layout(graph)

  // Convert back to react-flow
  result.children?.forEach(group => {
    const groupKey = group.id.replace('group-', '')
    groupNodes.push({
      id: group.id,
      data: {
        label: (
          <div className="flex items-center gap-2 px-3 py-1.5">
            <Layers className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-xs font-semibold text-slate-300">
              {groupBy === 'namespace' ? 'NS' : groupBy === 'node' ? 'Node' : 'Instance'}: {groupKey}
            </span>
            <span className="text-[10px] text-slate-500">({group.children?.length || 0})</span>
          </div>
        ),
      },
      position: { x: group.x!, y: group.y! },
      style: {
        width: group.width,
        height: group.height,
        background: 'rgba(30, 41, 59, 0.3)',
        border: '1px solid #334155',
        borderRadius: '12px',
        padding: 0,
      },
      selectable: false,
      draggable: false,
    })

    group.children?.forEach((child: any) => {
      const rfNode = rfNodes.find(n => n.id === child.id)
      if (rfNode) {
        childNodes.push({
          ...rfNode,
          position: { x: child.x!, y: child.y! },
          parentNode: group.id,
          extent: 'parent' as const,
          targetPosition: Position.Top,
          sourcePosition: Position.Bottom,
        })
      }
    })
  })

  // Standalone nodes (not in any group)
  const groupedIds = new Set(childNodes.map(n => n.id))
  const standaloneNodes = rfNodes
    .filter(n => !groupedIds.has(n.id))
    .map((n, i) => ({
      ...n,
      position: { x: i * 250, y: ((result as any).height || 500) + 100 },
      targetPosition: Position.Top,
      sourcePosition: Position.Bottom,
    }))

  return {
    nodes: [...groupNodes, ...childNodes, ...standaloneNodes],
    edges: validEdges,
  }
}
