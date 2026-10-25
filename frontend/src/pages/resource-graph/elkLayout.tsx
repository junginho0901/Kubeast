// ELK 기반 react-flow 레이아웃 함수
//
// frontend/src/pages/ResourceGraph.tsx 의 applyElkLayout 함수 추출.
// groupBy='none' = flat layered / 그 외 = compound (group container) 레이아웃.
// JSX 라벨 (Layers icon) 사용으로 .tsx 확장자.

import type { Node, Edge } from '@xyflow/react'
import { Position } from '@xyflow/react'
import ELK from 'elkjs/lib/elk.bundled.js'
import { Layers } from 'lucide-react'
import i18next from 'i18next'
import type { ResourceGraphNode, ResourceGraphEdge } from '@/services/api'
import { kindWeight, type GroupBy } from './constants'
import { isPeer, rowCenter, BOX_HEIGHT } from './traffic'

const elk = new ELK()

const kindPartition = (n: Node) =>
  String(-(kindWeight[(n.data?.raw as ResourceGraphNode | undefined)?.kind ?? ''] || 0))

// With traffic lines on screen the layout routes every line (routed): ELK draws right-angled routes between
// the boxes and places each line's count where it overlaps nothing, and the lines are drawn along those routes
// (RoutedEdge) instead of as free curves over the boxes. The traffic view lays the nodes out by its lines, left
// to right, without the kind rows; the both view keeps the rows.
export interface LayoutOptions {
  byTraffic?: boolean
  routed?: boolean
}

// What RoutedEdge draws: the points of the route and the middle of the count, in flow coordinates.
export interface EdgeRoute {
  points: { x: number; y: number }[]
  label?: { x: number; y: number }
}

const LABEL_HEIGHT = 16
const labelWidth = (text: string) => Math.ceil(text.length * 6.5) + 12

// A box with port rows (Traffic view) has fixed ports: one out on the right, one in on the left at the head and
// one at each row, where the lines to that port end.
type BoxLayout = { height: number; rows: string[] }
const boxLayout = (n: Node) => n.data?.layout as BoxLayout | undefined

function elkNode(n: Node, partition?: string) {
  const layout = boxLayout(n)
  const port = (id: string, x: number, y: number, side: string) => ({ id, x, y, width: 0, height: 0, layoutOptions: { 'elk.port.side': side } })
  return {
    id: n.id,
    width: 200,
    height: layout?.height ?? BOX_HEIGHT,
    layoutOptions: {
      ...(partition !== undefined ? { 'partitioning.partition': partition } : {}),
      ...(layout ? { 'elk.portConstraints': 'FIXED_POS' } : {}),
    },
    ...(layout ? {
      ports: [
        port(`${n.id}::out`, 200, BOX_HEIGHT / 2, 'EAST'),
        port(`${n.id}::in`, 0, BOX_HEIGHT / 2, 'WEST'),
        ...layout.rows.map((k, i) => port(`${n.id}::in::${k}`, 0, rowCenter(i), 'WEST')),
      ],
    } : {}),
  }
}

function elkEdge(e: Edge, id: string, routed: boolean, withRows: Set<string>) {
  const text = typeof e.label === 'string' ? e.label : ''
  const row = (e.data as { row?: string } | undefined)?.row
  return {
    id,
    sources: [withRows.has(e.source) ? `${e.source}::out` : e.source],
    targets: [withRows.has(e.target) ? (row ? `${e.target}::in::${row}` : `${e.target}::in`) : e.target],
    ...(routed && text ? { labels: [{ id: `${id}-l`, text, width: labelWidth(text), height: LABEL_HEIGHT }] } : {}),
  }
}

// withRoutes puts ELK's routes on the edges it laid out (edge coordinates at the root: elk.json.edgeCoords).
function withRoutes(edges: Edge[], laid: any[] | undefined, ids: string[]): Edge[] {
  const byId = new Map((laid ?? []).map((e: any) => [e.id, e]))
  return edges.map((e, i) => {
    const r = byId.get(ids[i])
    const s = r?.sections?.[0]
    if (!s) return e
    const l = r.labels?.[0]
    const route: EdgeRoute = {
      points: [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p: any) => ({ x: p.x, y: p.y })),
      label: l ? { x: l.x + l.width / 2, y: l.y + l.height / 2 } : undefined,
    }
    return { ...e, type: 'routed', data: { ...e.data, route } }
  })
}

const routedOptions = {
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.json.edgeCoords': 'ROOT',
  'elk.edgeLabels.placement': 'CENTER',
  'elk.spacing.edgeLabel': '4',
  'elk.spacing.edgeEdge': '14',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
}

export async function applyElkLayout(
  rfNodes: Node[],
  rfEdges: Edge[],
  groupBy: GroupBy,
  graphData: { nodes: ResourceGraphNode[]; edges: ResourceGraphEdge[] },
  { byTraffic = false, routed = false }: LayoutOptions = {},
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (rfNodes.length === 0) return { nodes: [], edges: [] }
  const direction = byTraffic ? 'RIGHT' : 'DOWN'
  const targetPosition = byTraffic ? Position.Left : Position.Top
  const sourcePosition = byTraffic ? Position.Right : Position.Bottom

  // Build groups
  const groups = new Map<string, ResourceGraphNode[]>()
  const nodeIdToGroup = new Map<string, string>()

  if (groupBy !== 'none') {
    for (const n of graphData.nodes) {
      let key = ''
      if (isPeer(n)) key = groupBy === 'namespace' && n.namespace ? n.namespace : i18next.t('resourceGraph.traffic.peerGroup', 'outside this view')
      else if (groupBy === 'namespace') key = n.namespace || '(cluster)'
      else if (groupBy === 'node') key = n.nodeName || '(unscheduled)'
      else if (groupBy === 'instance') key = n.instanceLabel || '(ungrouped)'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(n)
      nodeIdToGroup.set(n.id, key)
    }
  }

  const rfNodeIds = new Set(rfNodes.map(n => n.id))
  const validEdges = rfEdges.filter(e => rfNodeIds.has(e.source) && rfNodeIds.has(e.target))
  const elkIds = validEdges.map((_, i) => `elk-e-${i}`)
  const withRows = new Set(rfNodes.filter(n => boxLayout(n)).map(n => n.id))

  if (groupBy === 'none') {
    // Flat layout
    const graph = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': direction,
        'elk.edgeRouting': 'SPLINES',
        'elk.spacing.nodeNode': '60',
        'elk.layered.spacing.nodeNodeBetweenLayers': byTraffic ? '140' : '80',
        'partitioning.activate': byTraffic ? 'false' : 'true',
        // unrelated workloads side by side; at the default 1.6 they stack and seem to connect
        'elk.aspectRatio': '2',
        'elk.nodeSize.minimum': '(200,60)',
        'elk.nodeSize.constraints': '[MINIMUM_SIZE]',
        ...(routed ? routedOptions : {}),
      },
      children: rfNodes.map(n => elkNode(n, kindPartition(n))),
      edges: validEdges.map((e, i) => elkEdge(e, elkIds[i], routed, withRows)),
    }

    const result = await elk.layout(graph)
    const posMap = new Map<string, { x: number; y: number }>()
    result.children?.forEach(c => posMap.set(c.id, { x: c.x!, y: c.y! }))
    return {
      nodes: rfNodes.map(n => ({
        ...n,
        position: posMap.get(n.id) || { x: 0, y: 0 },
        targetPosition,
        sourcePosition,
      })),
      edges: routed ? withRoutes(validEdges, result.edges, elkIds) : validEdges,
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
    // a group whose objects are all filtered out (or have no line, in the Traffic view) is not drawn
    if (memberRfNodes.length === 0) continue
    const intraEdges = validEdges.filter(e => memberIds.has(e.source) && memberIds.has(e.target))

    elkChildren.push({
      id: groupId,
      // routed: one layered layout through the groups (hierarchyHandling below), each line laid out at the root
      layoutOptions: routed
        ? { 'elk.padding': '[left=16, top=40, right=16, bottom=16]' }
        : intraEdges.length > 0
        ? {
            'elk.algorithm': 'layered',
            'elk.direction': direction,
            'elk.edgeRouting': 'SPLINES',
            'elk.spacing.nodeNode': '40',
            'elk.layered.spacing.nodeNodeBetweenLayers': byTraffic ? '120' : '60',
            'partitioning.activate': byTraffic ? 'false' : 'true',
            'elk.padding': '[left=16, top=40, right=16, bottom=16]',
          }
        : {
            'elk.algorithm': 'rectpacking',
            'elk.spacing.nodeNode': '20',
            'elk.padding': '[left=16, top=40, right=16, bottom=16]',
          },
      children: memberRfNodes.map(n => elkNode(n, kindPartition(n))),
      edges: routed ? [] : intraEdges.map((e, i) => ({
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
      'elk.direction': direction,
      'elk.edgeRouting': 'SPLINES',
      'elk.spacing.nodeNode': '80',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100',
      'elk.aspectRatio': '2',
      ...(routed ? { ...routedOptions, 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' } : {}),
    },
    children: elkChildren,
    edges: routed
      ? validEdges.map((e, i) => elkEdge(e, elkIds[i], true, withRows))
      : crossEdges.map((e, i) => ({
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
              {groupBy === 'namespace' ? i18next.t('resourceGraph.groupBy.namespace', 'Namespace') : groupBy === 'node' ? i18next.t('resourceGraph.glance.node', 'Node') : i18next.t('resourceGraph.glance.instance', 'Instance')}: {groupKey}
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
          parentId: group.id,
          extent: 'parent' as const,
          targetPosition,
          sourcePosition,
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
      targetPosition,
      sourcePosition,
    }))

  return {
    nodes: [...groupNodes, ...childNodes, ...standaloneNodes],
    edges: routed ? withRoutes(validEdges, result.edges, elkIds) : validEdges,
  }
}
