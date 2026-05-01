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
import dagre from 'dagre'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronDown, CheckCircle, Search, Filter, Info } from 'lucide-react'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAIContext } from '@/hooks/useAIContext'
import { buildResourceLink } from '@/utils/resourceLink'

// Kind → emoji icon (matching ResourceDetailDrawer)
const kindIcon: Record<string, string> = {
  Pod: '🔵', Deployment: '🚀', ReplicaSet: '📋', StatefulSet: '📊',
  DaemonSet: '👾', Job: '⚡', CronJob: '⏰', Service: '🌐',
  Ingress: '🔀', ConfigMap: '📝', Secret: '🔑',
  PersistentVolumeClaim: '💿', PersistentVolume: '💾',
  ServiceAccount: '👤', Role: '🔐', ClusterRole: '🔐',
  RoleBinding: '🔗', ClusterRoleBinding: '🔗',
}

// Status → border color
function statusColor(status: string): string {
  const s = status.toLowerCase()
  if (['running', 'active', 'bound', 'succeeded'].some((k) => s.includes(k))) return '#22c55e'
  if (['pending', 'terminating'].some((k) => s.includes(k))) return '#eab308'
  if (['failed', 'error', 'crashloopbackoff'].some((k) => s.includes(k))) return '#ef4444'
  return '#64748b'
}

// Edge type → style
const edgeStyles: Record<string, { stroke: string; strokeDasharray?: string; label: string }> = {
  owns:    { stroke: '#94a3b8', label: 'owns' },
  selects: { stroke: '#3b82f6', strokeDasharray: '5 5', label: 'selects' },
  mounts:  { stroke: '#a855f7', strokeDasharray: '5 5', label: 'mounts' },
  routes:  { stroke: '#22c55e', label: 'routes' },
  binds:   { stroke: '#f97316', strokeDasharray: '5 5', label: 'binds' },
}

const ALL_KINDS = [
  'Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'Pod',
  'Service', 'Ingress', 'Job', 'CronJob',
  'ConfigMap', 'Secret', 'PersistentVolumeClaim', 'PersistentVolume',
  'ServiceAccount', 'Role', 'ClusterRole', 'RoleBinding',
]

const ALL_EDGE_TYPES = ['owns', 'selects', 'mounts', 'routes', 'binds'] as const

// Dagre layout
function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB',
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 80 })

  for (const node of nodes) {
    g.setNode(node.id, { width: 200, height: 60 })
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  const layoutedNodes = nodes.map((node) => {
    const pos = g.node(node.id)
    return {
      ...node,
      position: { x: pos.x - 100, y: pos.y - 30 },
      targetPosition: direction === 'TB' ? Position.Top : Position.Left,
      sourcePosition: direction === 'TB' ? Position.Bottom : Position.Right,
    }
  })

  return { nodes: layoutedNodes, edges }
}

export default function DependencyGraph() {
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()

  // Namespace selection
  const [selectedNamespace, setSelectedNamespace] = useState<string>('default')
  const [isNsDropdownOpen, setIsNsDropdownOpen] = useState(false)
  const nsDropdownRef = useRef<HTMLDivElement>(null)

  // Filters
  const [showFilters, setShowFilters] = useState(false)
  const [kindFilters, setKindFilters] = useState<Set<string>>(new Set(ALL_KINDS))
  const [edgeTypeFilters, setEdgeTypeFilters] = useState<Set<string>>(new Set(ALL_EDGE_TYPES))

  // Search
  const [searchQuery, setSearchQuery] = useState('')

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
  })

  const { data: graphData, isLoading } = useQuery({
    queryKey: ['dependency-graph', selectedNamespace],
    queryFn: () => api.getDependencyGraph(selectedNamespace),
    enabled: !!selectedNamespace,
  })

  // 플로팅 AI 위젯용 스냅샷
  const aiSnapshot = useMemo(() => {
    if (!graphData) return null
    const totalNodes = graphData.nodes?.length ?? 0
    const totalEdges = graphData.edges?.length ?? 0
    const byKind: Record<string, number> = {}
    for (const n of graphData.nodes ?? []) {
      byKind[n.kind] = (byKind[n.kind] ?? 0) + 1
    }

    // 화면 필터(kind / search) 통과 + 문제 있는 노드 우선 → 상위 30개
    const allNodes = graphData.nodes ?? []
    const q = (searchQuery || '').trim().toLowerCase()
    const filteredNodes = allNodes.filter((n: any) => {
      if (kindFilters.size > 0 && !kindFilters.has(n.kind)) return false
      if (q && !(n.name?.toLowerCase().includes(q) || (n.namespace || '').toLowerCase().includes(q))) return false
      return true
    })
    const isProblem = (n: { status?: string }) => {
      const s = (n.status || '').toLowerCase()
      return s !== '' && s !== 'running' && s !== 'ready' && s !== 'active' && s !== 'bound' && s !== 'succeeded'
    }
    const sorted = [...filteredNodes].sort((a: any, b: any) =>
      (isProblem(a) ? 0 : 1) - (isProblem(b) ? 0 : 1),
    )
    const TOP_N = 30
    const visibleItems = sorted.slice(0, TOP_N).map((n: any) => ({
      kind: n.kind,
      name: n.name,
      namespace: n.namespace || undefined,
      status: n.status,
      _link: buildResourceLink(n.kind, n.namespace || selectedNamespace, n.name),
    }))
    const problematicCount = filteredNodes.filter(isProblem).length

    return {
      source: 'base' as const,
      summary: `의존성 그래프 · ${selectedNamespace} · 노드 ${totalNodes}개, 엣지 ${totalEdges}개`,
      data: {
        filters: {
          namespace: selectedNamespace,
          kind_filters: Array.from(kindFilters),
          edge_type_filters: Array.from(edgeTypeFilters),
          search: searchQuery || undefined,
        },
        stats: { total_nodes: totalNodes, total_edges: totalEdges, by_kind: byKind },
      },
    }
  }, [graphData, selectedNamespace, kindFilters, edgeTypeFilters, searchQuery])

  useAIContext(aiSnapshot, [aiSnapshot])

  // Close ns dropdown on outside click
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

  // Build react-flow nodes and edges
  const { initialNodes, initialEdges } = useMemo(() => {
    if (!graphData) return { initialNodes: [] as Node[], initialEdges: [] as Edge[] }

    const filteredNodes = graphData.nodes.filter((n) => kindFilters.has(n.kind))
    const nodeIds = new Set(filteredNodes.map((n) => n.id))

    const rfNodes: Node[] = filteredNodes.map((n) => {
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
                {n.ready && (
                  <div className="text-[10px] text-slate-400 leading-tight">{n.ready}</div>
                )}
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
        },
      }
    })

    const rfEdges: Edge[] = graphData.edges
      .filter((e) => edgeTypeFilters.has(e.type) && nodeIds.has(e.source) && nodeIds.has(e.target))
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

    const layouted = getLayoutedElements(rfNodes, rfEdges)
    return { initialNodes: layouted.nodes, initialEdges: layouted.edges }
  }, [graphData, kindFilters, edgeTypeFilters, searchQuery])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Update nodes/edges when data changes
  useEffect(() => {
    setNodes(initialNodes)
    setEdges(initialEdges)
  }, [initialNodes, initialEdges, setNodes, setEdges])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const raw = node.data?.raw
    if (raw) {
      openDetail({ kind: raw.kind, name: raw.name, namespace: raw.namespace })
    }
  }, [openDetail])

  const toggleKind = (kind: string) => {
    setKindFilters((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  const toggleEdgeType = (type: string) => {
    setEdgeTypeFilters((prev) => {
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
          <h1 className="text-xl font-bold text-white">{t('dependencyGraph.title', '리소스 의존성 그래프')}</h1>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>{nodeCount} nodes</span>
            <span>·</span>
            <span>{edgeCount} edges</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Namespace selector */}
          <div className="relative" ref={nsDropdownRef}>
            <button
              type="button"
              onClick={() => setIsNsDropdownOpen(!isNsDropdownOpen)}
              className="h-9 px-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500 flex items-center gap-2 min-w-[180px] justify-between"
            >
              <span className="truncate">{selectedNamespace}</span>
              <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${isNsDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            {isNsDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[100] max-h-[240px] overflow-y-auto">
                {(namespaces || []).map((ns) => (
                  <button
                    key={ns.name}
                    type="button"
                    onClick={() => { setSelectedNamespace(ns.name); setIsNsDropdownOpen(false) }}
                    className="w-full px-4 py-2 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2"
                  >
                    {selectedNamespace === ns.name && <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />}
                    <span className={selectedNamespace === ns.name ? 'font-medium' : ''}>{ns.name}</span>
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
              placeholder={t('dependencyGraph.search', '리소스 검색...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 w-full pl-8 pr-3 bg-slate-700 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          {/* Filter toggle */}
          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            className={`h-9 px-3 rounded-lg text-sm flex items-center gap-1.5 transition-colors ${
              showFilters ? 'bg-primary-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
            }`}
          >
            <Filter className="w-4 h-4" />
            {t('dependencyGraph.filter', '필터')}
          </button>
        </div>

        {/* Filter panel */}
        {showFilters && (
          <div className="mt-3 p-3 bg-slate-800 border border-slate-700 rounded-lg grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-medium text-slate-400 mb-2">Kind</div>
              <div className="flex flex-wrap gap-1.5">
                {ALL_KINDS.map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => toggleKind(kind)}
                    className={`px-2 py-0.5 rounded text-xs transition-colors ${
                      kindFilters.has(kind)
                        ? 'bg-primary-600/30 text-primary-300 border border-primary-500/50'
                        : 'bg-slate-700 text-slate-500 border border-slate-600'
                    }`}
                  >
                    {kindIcon[kind] || '📄'} {kind}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-slate-400 mb-2">{t('dependencyGraph.legend', '범례')}</div>
              <div className="flex flex-wrap gap-1.5">
                {ALL_EDGE_TYPES.map((type) => {
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
                        {t(`dependencyGraph.${type}`, style.label)}
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
        {isLoading ? (
          <div className="w-full h-full flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
          </div>
        ) : nodeCount === 0 ? (
          <div className="w-full h-full flex flex-col items-center justify-center text-slate-400">
            <Info className="w-12 h-12 mb-3" />
            <p className="text-sm">{t('dependencyGraph.noData', '이 네임스페이스에 리소스가 없습니다')}</p>
          </div>
        ) : (
          <div style={{ width: '100%', height: '100%' }} className="[&_.react-flow\_\_attribution]:!hidden">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.1}
            maxZoom={2}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#334155" />
            <Controls className="!bg-slate-800 !border-slate-700 !rounded-lg [&>button]:!bg-slate-700 [&>button]:!border-slate-600 [&>button]:!text-white [&>button:hover]:!bg-slate-600" />
            <MiniMap
              nodeColor={(node) => {
                const raw = node.data?.raw
                return raw ? statusColor(raw.status) : '#64748b'
              }}
              maskColor="rgba(15, 23, 42, 0.7)"
              style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
            />
          </ReactFlow>
          </div>
        )}

        {/* 범례 (왼쪽 하단) */}
        <div className="absolute bottom-4 left-4 bg-slate-800/90 border border-slate-700 rounded-lg p-3 text-xs space-y-1.5 z-10 backdrop-blur-sm">
          <div className="font-medium text-slate-300 mb-1">{t('dependencyGraph.legend', 'Legend')}</div>
          {ALL_EDGE_TYPES.map((type) => {
            const style = edgeStyles[type]
            return (
              <div key={type} className="flex items-center gap-2">
                <svg width="24" height="8" className="flex-shrink-0">
                  <line
                    x1="0" y1="4" x2="20" y2="4"
                    stroke={style.stroke}
                    strokeWidth="2"
                    strokeDasharray={style.strokeDasharray || ''}
                  />
                  <polygon points="20,1 24,4 20,7" fill={style.stroke} />
                </svg>
                <span style={{ color: style.stroke }}>{t(`dependencyGraph.${type}`, style.label)}</span>
              </div>
            )
          })}
          <div className="border-t border-slate-700 pt-1.5 mt-1.5 space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded border-2 border-green-500" />
              <span className="text-slate-400">Running / Active / Bound</span>
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
