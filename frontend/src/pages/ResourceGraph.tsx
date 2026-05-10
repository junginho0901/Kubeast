import { useState, useCallback, useMemo } from 'react'
import ReactFlow, {
  Node,
  Controls,
  Background,
  MiniMap,
  BackgroundVariant,
} from 'react-flow-renderer'
import 'react-flow-renderer/dist/style.css'
import 'react-flow-renderer/dist/theme-default.css'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { api, ResourceGraphNode } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAIContext } from '@/hooks/useAIContext'
import { buildResourceLink } from '@/utils/resourceLink'
import {
  ALL_EDGE_TYPES,
  DEFAULT_KINDS,
  edgeStyles,
  statusColor,
  type GroupBy,
} from './resource-graph/constants'
import { Glance } from './resource-graph/Glance'
import { ResourceGraphHeader } from './resource-graph/ResourceGraphHeader'
import { useResourceGraphLayout } from './resource-graph/useResourceGraphLayout'

export default function ResourceGraph() {
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()

  // State
  const [selectedNamespaces, setSelectedNamespaces] = useState<Set<string>>(new Set())
  const [isNsDropdownOpen, setIsNsDropdownOpen] = useState(false)
  const [kindFilters, setKindFilters] = useState<Set<string>>(new Set(DEFAULT_KINDS))
  const [edgeTypeFilters, setEdgeTypeFilters] = useState<Set<string>>(new Set(ALL_EDGE_TYPES))
  const [showFilters, setShowFilters] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [statusFilter, setStatusFilter] = useState<'all' | 'issues'>('all')
  const [glanceNode, setGlanceNode] = useState<ResourceGraphNode | null>(null)
  const [glancePos, setGlancePos] = useState({ x: 0, y: 0 })

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

    // 사용자가 화면에서 적용 중인 필터를 그대로 LLM 컨텍스트에도 반영
    const allNodes = graphData.nodes ?? []
    const q = (searchQuery || '').trim().toLowerCase()
    const filteredNodes = allNodes.filter((n) => {
      if (kindFilters.size > 0 && !kindFilters.has(n.kind)) return false
      if (q && !(n.name?.toLowerCase().includes(q) || n.namespace?.toLowerCase().includes(q))) return false
      if (statusFilter === 'issues') {
        const s = (n.status || '').toLowerCase()
        if (s === '' || s === 'running' || s === 'ready' || s === 'active' || s === 'bound' || s === 'succeeded') return false
      }
      return true
    })

    // 문제 있는 노드를 앞쪽으로 정렬 → 상위 30개
    const isProblem = (n: { status?: string }) => {
      const s = (n.status || '').toLowerCase()
      return s !== '' && s !== 'running' && s !== 'ready' && s !== 'active' && s !== 'bound' && s !== 'succeeded'
    }
    const sorted = [...filteredNodes].sort((a, b) => {
      const ap = isProblem(a) ? 0 : 1
      const bp = isProblem(b) ? 0 : 1
      return ap - bp
    })
    const TOP_N = 30
    const visibleItems = sorted.slice(0, TOP_N).map((n) => ({
      kind: n.kind,
      name: n.name,
      namespace: n.namespace || undefined,
      status: n.status,
      ready: n.ready,
      _link: buildResourceLink(n.kind, n.namespace, n.name),
    }))
    const problematicCount = filteredNodes.filter(isProblem).length

    return {
      source: 'base' as const,
      summary: `리소스 그래프 · ${nsArray?.join(', ') ?? '선택 없음'} · 노드 ${totalNodes}개, 엣지 ${totalEdges}개${problematicCount > 0 ? `, 문제 ${problematicCount}` : ''}`,
      data: {
        filters: {
          namespaces: nsArray,
          kind_filters: Array.from(kindFilters),
          edge_type_filters: Array.from(edgeTypeFilters),
          search: searchQuery || undefined,
          group_by: groupBy,
          status_filter: statusFilter,
        },
        stats: { total_nodes: totalNodes, total_edges: totalEdges, by_kind: byKind, filtered_total: filteredNodes.length, problematic: problematicCount },
        visible_items: visibleItems,
      },
    }
  }, [graphData, nsArray, kindFilters, edgeTypeFilters, searchQuery, groupBy, statusFilter])

  useAIContext(aiSnapshot, [aiSnapshot])

  const { nodes, edges, onNodesChange, onEdgesChange, layoutReady } = useResourceGraphLayout({
    graphData,
    kindFilters,
    edgeTypeFilters,
    searchQuery,
    statusFilter,
    groupBy,
  })

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

  const nodeCount = graphData?.nodes?.length || 0
  const edgeCount = graphData?.edges?.length || 0

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 64px)' }}>
      <ResourceGraphHeader
        nodeCount={nodeCount}
        edgeCount={edgeCount}
        namespaces={namespaces}
        selectedNamespaces={selectedNamespaces}
        setSelectedNamespaces={setSelectedNamespaces}
        isNsDropdownOpen={isNsDropdownOpen}
        setIsNsDropdownOpen={setIsNsDropdownOpen}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        groupBy={groupBy}
        setGroupBy={setGroupBy}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        showFilters={showFilters}
        setShowFilters={setShowFilters}
        kindFilters={kindFilters}
        setKindFilters={setKindFilters}
        edgeTypeFilters={edgeTypeFilters}
        setEdgeTypeFilters={setEdgeTypeFilters}
      />

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
