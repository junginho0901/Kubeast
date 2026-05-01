import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  Position,
  MarkerType,
  BackgroundVariant,
} from 'react-flow-renderer'
import 'react-flow-renderer/dist/style.css'
import 'react-flow-renderer/dist/theme-default.css'
import ELK from 'elkjs/lib/elk.bundled.js'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  CheckCircle,
  Search,
  Filter,
  Info,
  Layers,
  X,
} from 'lucide-react'
import { api, ResourceGraphNode, ResourceGraphEdge, ResourceGraphEdgeType } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAIContext } from '@/hooks/useAIContext'
import { buildResourceLink } from '@/utils/resourceLink'

// ────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────

const elk = new ELK()

// Kind → emoji icon
const kindIcon: Record<string, string> = {
  Pod: '🔵', Deployment: '🚀', ReplicaSet: '📋', StatefulSet: '📊',
  DaemonSet: '👾', Job: '⚡', CronJob: '⏰', Service: '🌐',
  Ingress: '🔀', ConfigMap: '📝', Secret: '🔑',
  PersistentVolumeClaim: '💿', PersistentVolume: '💾',
  StorageClass: '🗄', ServiceAccount: '👤', Role: '🔐', ClusterRole: '🔐',
  RoleBinding: '🔗', ClusterRoleBinding: '🔗',
  HorizontalPodAutoscaler: '📈', NetworkPolicy: '🛡',
  EndpointSlice: '📡', Endpoints: '📡',
}

// Kind weight for layered layout (higher = further left/top)
const kindWeight: Record<string, number> = {
  HorizontalPodAutoscaler: 1000,
  Ingress: 950,
  Service: 900,
  Deployment: 850, StatefulSet: 850, DaemonSet: 850,
  CronJob: 820, Job: 810,
  ReplicaSet: 800,
  Pod: 700,
  NetworkPolicy: 650,
  PersistentVolumeClaim: 600, PersistentVolume: 550, StorageClass: 500,
  ConfigMap: 400, Secret: 400,
  ServiceAccount: 300, Role: 250, ClusterRole: 250,
  RoleBinding: 200, ClusterRoleBinding: 200,
  EndpointSlice: 150, Endpoints: 150,
}

// Status → border color
function statusColor(status: string): string {
  const s = status.toLowerCase()
  if (['running', 'active', 'bound', 'succeeded', 'clusterip', 'nodeport', 'loadbalancer'].some(k => s.includes(k))) return '#22c55e'
  if (['pending', 'terminating', 'progressing'].some(k => s.includes(k))) return '#eab308'
  if (['failed', 'error', 'crashloopbackoff', 'imagepullbackoff'].some(k => s.includes(k))) return '#ef4444'
  return '#64748b'
}

// Edge type → style
const edgeStyles: Record<string, { stroke: string; strokeDasharray?: string; label: string }> = {
  owns:           { stroke: '#94a3b8', label: 'owns' },
  selects:        { stroke: '#3b82f6', strokeDasharray: '5 5', label: 'selects' },
  mounts:         { stroke: '#a855f7', strokeDasharray: '5 5', label: 'mounts' },
  routes:         { stroke: '#22c55e', label: 'routes' },
  binds:          { stroke: '#f97316', strokeDasharray: '5 5', label: 'binds' },
  bound_to:       { stroke: '#d946ef', label: 'bound_to' },
  provisions:     { stroke: '#6b7280', strokeDasharray: '8 4', label: 'provisions' },
  hpa_targets:    { stroke: '#eab308', label: 'targets' },
  network_policy: { stroke: '#ef4444', strokeDasharray: '4 4', label: 'policy' },
  endpoint_of:    { stroke: '#06b6d4', strokeDasharray: '4 4', label: 'endpoint' },
  sa_used_by:     { stroke: '#f97316', strokeDasharray: '4 4', label: 'uses SA' },
}

const SOURCE_GROUPS = [
  { id: 'workloads', label: 'Workloads', kinds: ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob'], default: true },
  { id: 'network', label: 'Network', kinds: ['Service', 'Ingress', 'Endpoints', 'EndpointSlice', 'NetworkPolicy'], default: true },
  { id: 'storage', label: 'Storage', kinds: ['PersistentVolumeClaim', 'PersistentVolume', 'StorageClass'], default: true },
  { id: 'security', label: 'Security', kinds: ['ServiceAccount', 'Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding'], default: false },
  { id: 'configuration', label: 'Configuration', kinds: ['ConfigMap', 'Secret', 'HorizontalPodAutoscaler'], default: false },
]

const ALL_KINDS = SOURCE_GROUPS.flatMap(g => g.kinds)
const DEFAULT_KINDS = new Set(SOURCE_GROUPS.filter(g => g.default).flatMap(g => g.kinds))
const ALL_EDGE_TYPES: ResourceGraphEdgeType[] = [
  'owns', 'selects', 'mounts', 'routes', 'binds',
  'bound_to', 'provisions', 'hpa_targets', 'network_policy', 'endpoint_of', 'sa_used_by',
]

type GroupBy = 'none' | 'namespace' | 'node' | 'instance'

// ────────────────────────────────────────────
// ELK Layout
// ────────────────────────────────────────────

async function applyElkLayout(
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

// ────────────────────────────────────────────
// Glance (Hover Preview)
// ────────────────────────────────────────────

function Glance({ node, position }: { node: ResourceGraphNode | null; position: { x: number; y: number } }) {
  if (!node) return null

  const borderColor = statusColor(node.status)

  return (
    <div
      className="fixed z-[200] bg-slate-800 border border-slate-600 rounded-lg shadow-2xl p-3 min-w-[220px] max-w-[300px] pointer-events-none"
      style={{ left: position.x + 16, top: position.y - 10 }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base">{kindIcon[node.kind] || '📄'}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] text-slate-400">{node.kind}</div>
          <div className="text-xs font-semibold text-white truncate">{node.name}</div>
        </div>
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: borderColor, boxShadow: `0 0 6px ${borderColor}` }} />
      </div>

      <div className="space-y-1 text-[10px]">
        <div className="flex justify-between"><span className="text-slate-400">Status</span><span className="text-white">{node.status}</span></div>
        {node.ready && <div className="flex justify-between"><span className="text-slate-400">Ready</span><span className="text-white">{node.ready}</span></div>}
        {node.namespace && <div className="flex justify-between"><span className="text-slate-400">Namespace</span><span className="text-white">{node.namespace}</span></div>}
        {node.nodeName && <div className="flex justify-between"><span className="text-slate-400">Node</span><span className="text-white">{node.nodeName}</span></div>}
        {node.ownerKind && <div className="flex justify-between"><span className="text-slate-400">Owner</span><span className="text-white">{node.ownerKind}</span></div>}
        {node.instanceLabel && <div className="flex justify-between"><span className="text-slate-400">Instance</span><span className="text-white">{node.instanceLabel}</span></div>}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────
// Main Component
// ────────────────────────────────────────────

export default function ResourceGraph() {
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()

  // State
  const [selectedNamespaces, setSelectedNamespaces] = useState<Set<string>>(new Set())
  const [isNsDropdownOpen, setIsNsDropdownOpen] = useState(false)
  const nsDropdownRef = useRef<HTMLDivElement>(null)
  const [kindFilters, setKindFilters] = useState<Set<string>>(new Set(DEFAULT_KINDS))
  const [edgeTypeFilters, setEdgeTypeFilters] = useState<Set<string>>(new Set(ALL_EDGE_TYPES))
  const [showFilters, setShowFilters] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [statusFilter, setStatusFilter] = useState<'all' | 'issues'>('all')
  const [glanceNode, setGlanceNode] = useState<ResourceGraphNode | null>(null)
  const [glancePos, setGlancePos] = useState({ x: 0, y: 0 })
  const [layoutReady, setLayoutReady] = useState(false)

  // Data fetching
  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
  })

  const nsArray = useMemo(() => {
    if (selectedNamespaces.size === 0) return undefined
    return [...selectedNamespaces]
  }, [selectedNamespaces])

  const hasSelection = selectedNamespaces.size > 0

  const { data: graphData, isLoading } = useQuery({
    queryKey: ['resource-graph', nsArray],
    queryFn: () => api.getResourceGraph(nsArray),
    enabled: hasSelection,
  })

  // 플로팅 AI 위젯용 스냅샷
  // visible_items: 화면에 그려진 노드 중 (1) 검색·필터 통과 + (2) 문제 있는 것 우선,
  // 토큰 한도 안에서 30 개 cap. 사용자가 그래프에 보이는 박스에 대해 묻기 위함.
  const aiSnapshot = useMemo(() => {
    if (!graphData) return null
    const totalNodes = graphData.nodes?.length ?? 0
    const totalEdges = graphData.edges?.length ?? 0
    const byKind: Record<string, number> = {}
    for (const n of graphData.nodes ?? []) {
      byKind[n.kind] = (byKind[n.kind] ?? 0) + 1
    }
    return {
      source: 'base' as const,
      summary: `리소스 그래프 · ${nsArray?.join(', ') ?? '선택 없음'} · 노드 ${totalNodes}개, 엣지 ${totalEdges}개`,
      data: {
        filters: {
          namespaces: nsArray,
          kind_filters: Array.from(kindFilters),
          edge_type_filters: Array.from(edgeTypeFilters),
          search: searchQuery || undefined,
          group_by: groupBy,
          status_filter: statusFilter,
        },
        stats: { total_nodes: totalNodes, total_edges: totalEdges, by_kind: byKind },
      },
    }
  }, [graphData, nsArray, kindFilters, edgeTypeFilters, searchQuery, groupBy, statusFilter])

  useAIContext(aiSnapshot, [aiSnapshot])

  // Close dropdown on outside click
  useEffect(() => {
    if (!isNsDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (nsDropdownRef.current && !nsDropdownRef.current.contains(event.target as globalThis.Node)) {
        setIsNsDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isNsDropdownOpen])

  // Build react-flow nodes and edges, apply ELK layout
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

  // Apply ELK layout
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])

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
  }, [filteredNodes, filteredEdges, groupBy, graphData])

  // Interactions
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const raw = node.data?.raw as ResourceGraphNode | undefined
    if (raw) {
      openDetail({ kind: raw.kind, name: raw.name, namespace: raw.namespace })
    }
  }, [openDetail])

  const onNodeMouseEnter = useCallback((_: React.MouseEvent, node: Node) => {
    const raw = node.data?.raw as ResourceGraphNode | undefined
    if (raw) {
      setGlanceNode(raw)
      // Position relative to viewport
      const rect = (_.target as HTMLElement).getBoundingClientRect()
      setGlancePos({ x: rect.right, y: rect.top })
    }
  }, [])

  const onNodeMouseLeave = useCallback(() => {
    setGlanceNode(null)
  }, [])

  // Source group toggles
  const toggleSourceGroup = (groupId: string) => {
    const group = SOURCE_GROUPS.find(g => g.id === groupId)
    if (!group) return
    setKindFilters(prev => {
      const next = new Set(prev)
      const allEnabled = group.kinds.every(k => next.has(k))
      if (allEnabled) {
        group.kinds.forEach(k => next.delete(k))
      } else {
        group.kinds.forEach(k => next.add(k))
      }
      return next
    })
  }

  const toggleNs = (ns: string) => {
    setSelectedNamespaces(prev => {
      const next = new Set(prev)
      if (next.has(ns)) next.delete(ns)
      else next.add(ns)
      return next
    })
  }

  const toggleEdgeType = (type: string) => {
    setEdgeTypeFilters(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  const nodeCount = graphData?.nodes?.length || 0
  const edgeCount = graphData?.edges?.length || 0

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 64px)' }}>
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-slate-700">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-bold text-white">
            {t('resourceGraph.title', 'Resource Graph')}
          </h1>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>{nodeCount} nodes</span>
            <span>·</span>
            <span>{edgeCount} edges</span>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Namespace selector (multi-select) */}
          <div className="relative" ref={nsDropdownRef}>
            <button
              type="button"
              onClick={() => setIsNsDropdownOpen(!isNsDropdownOpen)}
              className="h-9 px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 flex items-center gap-2 min-w-[180px] justify-between"
            >
              <span className="truncate">
                {selectedNamespaces.size === 0
                  ? 'Select Namespace...'
                  : [...selectedNamespaces].join(', ')}
              </span>
              <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isNsDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            {isNsDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[100] max-h-[280px] overflow-y-auto">
                {selectedNamespaces.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelectedNamespaces(new Set())}
                    className="w-full px-4 py-2 text-left text-xs text-slate-400 hover:bg-slate-600 transition-colors border-b border-slate-600"
                  >
                    Clear selection
                  </button>
                )}
                {(namespaces || []).map(ns => (
                  <button
                    key={ns.name}
                    type="button"
                    onClick={() => toggleNs(ns.name)}
                    className="w-full px-4 py-2 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2"
                  >
                    {selectedNamespaces.has(ns.name) && <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />}
                    <span className={selectedNamespaces.has(ns.name) ? 'font-medium' : ''}>{ns.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Search */}
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder={t('resourceGraph.search', 'Search resources...')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="h-9 w-full pl-8 pr-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
                <X className="w-3.5 h-3.5 text-slate-400 hover:text-white" />
              </button>
            )}
          </div>

          {/* Group By */}
          <div className="flex items-center gap-1 bg-slate-700 rounded-lg p-0.5">
            {([['none', 'None'], ['namespace', 'NS'], ['node', 'Node'], ['instance', 'Instance']] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setGroupBy(val)}
                className={`px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                  groupBy === val ? 'bg-primary-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Status filter */}
          <button
            type="button"
            onClick={() => setStatusFilter(prev => prev === 'all' ? 'issues' : 'all')}
            className={`h-9 px-3 rounded-lg text-sm flex items-center gap-1.5 transition-colors ${
              statusFilter === 'issues' ? 'bg-red-600/30 text-red-300 border border-red-500/50' : 'bg-slate-700 text-slate-300 hover:bg-slate-600 border border-slate-600'
            }`}
          >
            ⚠ {t('resourceGraph.issuesOnly', 'Issues')}
          </button>

          {/* Filter toggle */}
          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            className={`h-9 px-3 rounded-lg text-sm flex items-center gap-1.5 transition-colors ${
              showFilters ? 'bg-primary-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            <Filter className="w-4 h-4" />
            {t('resourceGraph.filter', 'Filter')}
          </button>
        </div>

        {/* Filter panel */}
        {showFilters && (
          <div className="mt-3 p-3 bg-slate-800 border border-slate-700 rounded-lg grid grid-cols-2 gap-4">
            {/* Source groups */}
            <div>
              <div className="text-xs font-medium text-slate-400 mb-2">{t('resourceGraph.sources', 'Sources')}</div>
              <div className="flex flex-wrap gap-1.5">
                {SOURCE_GROUPS.map(group => {
                  const allEnabled = group.kinds.every(k => kindFilters.has(k))
                  const someEnabled = group.kinds.some(k => kindFilters.has(k))
                  return (
                    <button
                      key={group.id}
                      type="button"
                      onClick={() => toggleSourceGroup(group.id)}
                      className={`px-2.5 py-1 rounded text-xs transition-colors ${
                        allEnabled
                          ? 'bg-primary-600/30 text-primary-300 border border-primary-500/50'
                          : someEnabled
                          ? 'bg-primary-600/10 text-primary-400 border border-primary-500/30'
                          : 'bg-slate-700 text-slate-500 border border-slate-600'
                      }`}
                    >
                      {group.label}
                    </button>
                  )
                })}
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {ALL_KINDS.map(kind => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => {
                      setKindFilters(prev => {
                        const next = new Set(prev)
                        if (next.has(kind)) next.delete(kind)
                        else next.add(kind)
                        return next
                      })
                    }}
                    className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                      kindFilters.has(kind)
                        ? 'bg-slate-600 text-white'
                        : 'bg-slate-800 text-slate-600'
                    }`}
                  >
                    {kindIcon[kind] || '📄'} {kind}
                  </button>
                ))}
              </div>
            </div>

            {/* Edge types */}
            <div>
              <div className="text-xs font-medium text-slate-400 mb-2">{t('resourceGraph.legend', 'Edge Types')}</div>
              <div className="flex flex-wrap gap-1.5">
                {ALL_EDGE_TYPES.map(type => {
                  const style = edgeStyles[type]
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => toggleEdgeType(type)}
                      className={`px-2 py-0.5 rounded text-xs flex items-center gap-1.5 transition-colors ${
                        edgeTypeFilters.has(type)
                          ? 'bg-slate-700 border border-slate-500'
                          : 'bg-slate-800 text-slate-500 border border-slate-700'
                      }`}
                    >
                      <span
                        className="inline-block w-4 h-0.5"
                        style={{
                          backgroundColor: style.stroke,
                          borderTop: style.strokeDasharray ? `2px dashed ${style.stroke}` : undefined,
                          height: style.strokeDasharray ? 0 : 2,
                        }}
                      />
                      <span style={{ color: edgeTypeFilters.has(type) ? style.stroke : undefined }}>
                        {style.label}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Graph */}
      <div className="flex-1 relative" style={{ minHeight: 0 }}>
        {!hasSelection ? (
          <div className="w-full h-full flex flex-col items-center justify-center text-slate-400">
            <div className="max-w-lg text-center">
              <div className="text-6xl mb-6 opacity-30">🔗</div>
              <h2 className="text-xl font-bold text-white mb-3">Resource Graph</h2>
              <p className="text-sm text-slate-400 mb-6 leading-relaxed">
                쿠버네티스 리소스 간의 관계를 그래프로 시각화합니다.<br />
                Deployment → ReplicaSet → Pod, Service → Pod, Ingress → Service,<br />
                PVC → PV → StorageClass 등 다양한 관계를 한눈에 파악할 수 있습니다.
              </p>
              <div className="grid grid-cols-3 gap-3 mb-8 text-[11px]">
                <div className="bg-slate-800 rounded-lg p-3 border border-slate-700">
                  <div className="text-lg mb-1">📊</div>
                  <div className="text-slate-300 font-medium">그룹핑</div>
                  <div className="text-slate-500 mt-1">Namespace / Node /<br/>Instance 별 묶기</div>
                </div>
                <div className="bg-slate-800 rounded-lg p-3 border border-slate-700">
                  <div className="text-lg mb-1">🔍</div>
                  <div className="text-slate-300 font-medium">필터링</div>
                  <div className="text-slate-500 mt-1">리소스 타입, 상태,<br/>엣지 타입별 필터</div>
                </div>
                <div className="bg-slate-800 rounded-lg p-3 border border-slate-700">
                  <div className="text-lg mb-1">👆</div>
                  <div className="text-slate-300 font-medium">인터랙션</div>
                  <div className="text-slate-500 mt-1">호버로 프리뷰,<br/>클릭으로 상세 보기</div>
                </div>
              </div>
              <p className="text-sm text-slate-500">
                왼쪽 상단 드롭다운에서 네임스페이스를 선택하세요
              </p>
            </div>
          </div>
        ) : isLoading || !layoutReady ? (
          <div className="w-full h-full flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
          </div>
        ) : nodeCount === 0 ? (
          <div className="w-full h-full flex flex-col items-center justify-center text-slate-400">
            <Info className="w-12 h-12 mb-3" />
            <p className="text-sm">{t('resourceGraph.noData', 'No resources found')}</p>
          </div>
        ) : (
          <div style={{ width: '100%', height: '100%' }} className="[&_.react-flow\_\_attribution]:!hidden">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={onNodeClick}
              onNodeMouseEnter={onNodeMouseEnter}
              onNodeMouseLeave={onNodeMouseLeave}
              fitView
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.05}
              maxZoom={2}
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#334155" />
              <Controls className="!bg-slate-800 !border-slate-700 !rounded-lg [&>button]:!bg-slate-700 [&>button]:!border-slate-600 [&>button]:!text-white [&>button:hover]:!bg-slate-600" />
              <MiniMap
                nodeColor={node => {
                  const raw = node.data?.raw as ResourceGraphNode | undefined
                  return raw ? statusColor(raw.status) : '#64748b'
                }}
                maskColor="rgba(15, 23, 42, 0.7)"
                style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
              />
            </ReactFlow>
          </div>
        )}

        {/* Glance */}
        <Glance node={glanceNode} position={glancePos} />

        {/* Legend (bottom left) */}
        <div className="absolute bottom-4 left-4 bg-slate-800/90 border border-slate-700 rounded-lg p-3 text-xs space-y-1.5 z-10 backdrop-blur-sm">
          <div className="font-medium text-slate-300 mb-1">{t('resourceGraph.legend', 'Legend')}</div>
          {ALL_EDGE_TYPES.filter(type => edgeTypeFilters.has(type)).slice(0, 7).map(type => {
            const style = edgeStyles[type]
            return (
              <div key={type} className="flex items-center gap-2">
                <svg width="24" height="8" className="flex-shrink-0">
                  <line x1="0" y1="4" x2="20" y2="4" stroke={style.stroke} strokeWidth="2" strokeDasharray={style.strokeDasharray || ''} />
                  <polygon points="20,1 24,4 20,7" fill={style.stroke} />
                </svg>
                <span style={{ color: style.stroke }}>{style.label}</span>
              </div>
            )
          })}
          <div className="border-t border-slate-700 pt-1.5 mt-1.5 space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded border-2 border-green-500" />
              <span className="text-slate-400">Running / Active</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded border-2 border-yellow-500" />
              <span className="text-slate-400">Pending</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded border-2 border-red-500" />
              <span className="text-slate-400">Failed / Error</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
