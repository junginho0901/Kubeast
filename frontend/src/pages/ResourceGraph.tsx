import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
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
import {
  ChevronDown,
  CheckCircle,
  Search,
  Filter,
  Info,
  X,
} from 'lucide-react'
import { api, ResourceGraphNode } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useAIContext } from '@/hooks/useAIContext'
import { buildResourceLink } from '@/utils/resourceLink'
import {
  ALL_EDGE_TYPES,
  ALL_KINDS,
  DEFAULT_KINDS,
  edgeStyles,
  kindIcon,
  SOURCE_GROUPS,
  statusColor,
  type GroupBy,
} from './resource-graph/constants'
import { Glance } from './resource-graph/Glance'
import { useResourceGraphLayout } from './resource-graph/useResourceGraphLayout'

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
