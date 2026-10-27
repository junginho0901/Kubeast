import { useState, useCallback, useMemo, type SetStateAction } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ReactFlow,
  type Edge,
  type Node,
  Controls,
  Background,
  MiniMap,
  BackgroundVariant,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Info, ShieldAlert } from 'lucide-react'
import { api, ResourceGraphNode, type TrafficEnd, type TrafficLine, type TrafficResult } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import NetworkPolicyCheckModal from '@/components/resource-detail/NetworkPolicyCheckModal'
import { useCluster } from '@/contexts/ClusterContext'
import { useAIContext } from '@/hooks/useAIContext'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { usePermission } from '@/hooks/usePermission'
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
import { TrafficControls } from './resource-graph/TrafficControls'
import { TrafficPanel } from './resource-graph/TrafficPanel'
import { RoutedEdge } from './resource-graph/RoutedEdge'
import { isPeer, lineColor, openableEnd, trafficParams, trafficSources, type GraphView, type LineCheck, type TrafficSource } from './resource-graph/traffic'

const edgeTypes = { routed: RoutedEdge }

// focusLines: with a traffic line or a node hovered (or a line selected), its lines stay lit and the rest fade,
// so a line can be followed to its end.
function focusLines(nodes: Node[], edges: Edge[], focus: { edge?: string; node?: string } | null): { nodes: Node[]; edges: Edge[] } {
  if (!focus) return { nodes, edges }
  const lit = new Set<string>()
  const litNodes = new Set<string>()
  // a line split by port (Traffic view) lights all its parts
  const lineOf = (e: Edge) => (e.data?.lineId as string | undefined) ?? e.id
  const focusLine = focus.edge ? lineOf(edges.find((e) => e.id === focus.edge) ?? ({ id: focus.edge } as Edge)) : undefined
  for (const e of edges) {
    if (focusLine ? lineOf(e) === focusLine : e.source === focus.node || e.target === focus.node) {
      lit.add(e.id)
      litNodes.add(e.source)
      litNodes.add(e.target)
    }
  }
  if (focus.node) litNodes.add(focus.node)
  if (lit.size === 0) return { nodes, edges }
  const faded = 0.12
  return {
    edges: edges.map((e) => (lit.has(e.id)
      ? { ...e, animated: !!e.data?.line && e.data?.state !== 'dropped', zIndex: 2 }
      : { ...e, style: { ...e.style, opacity: faded }, labelStyle: { ...e.labelStyle, opacity: faded }, labelBgStyle: { ...e.labelBgStyle, fillOpacity: faded } })),
    nodes: nodes.map((n) => (litNodes.has(n.id) || n.id.startsWith('group-') ? n : { ...n, style: { ...n.style, opacity: 0.35 } })),
  }
}

export default function ResourceGraph() {
  const { t } = useTranslation()
  const { open: openDetail, target: drawerTarget } = useResourceDetail()

  // State
  const [searchParams] = useSearchParams()
  // null until the user picks: then the namespaces in ?namespace= (the old topology links), else `default`.
  const [pickedNamespaces, setPickedNamespaces] = useState<Set<string> | null>(() => {
    const fromUrl = (searchParams.get('namespace') || '').split(',').filter(Boolean)
    return fromUrl.length > 0 ? new Set(fromUrl) : null
  })
  // closed on a narrow screen, where it would cover the graph
  const [legendOpen, setLegendOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 768)
  const [isNsDropdownOpen, setIsNsDropdownOpen] = useState(false)
  const [kindFilters, setKindFilters] = useState<Set<string>>(new Set(DEFAULT_KINDS))
  const [edgeTypeFilters, setEdgeTypeFilters] = useState<Set<string>>(new Set(ALL_EDGE_TYPES))
  const [showFilters, setShowFilters] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('none')
  const [statusFilter, setStatusFilter] = useState<'all' | 'issues'>('all')
  const [glanceNode, setGlanceNode] = useState<ResourceGraphNode | null>(null)
  const [glancePos, setGlancePos] = useState({ x: 0, y: 0 })
  // Traffic lines (off until switched on): the sources this cluster has and the user may read
  const { currentCluster } = useCluster()
  const features = useClusterFeatures().data
  const { has } = usePermission()
  const prometheus = useQuery({
    queryKey: ['prometheus-status', currentCluster],
    queryFn: () => api.getPrometheusStatus(),
    enabled: features?.prometheus?.enabled === true,
    staleTime: 60_000,
    retry: false,
  })
  const prometheusAvailable = prometheus.data?.available === true
  const sources = useMemo(
    () => (has('resource.networkflow.read') ? trafficSources(features, currentCluster, prometheusAvailable) : []),
    [has, features, currentCluster, prometheusAvailable],
  )
  const [pickedView, setView] = useState<GraphView>('structure')
  const [pickedSource, setSource] = useState<TrafficSource | null>(null)
  const view: GraphView = sources.length > 0 ? pickedView : 'structure'
  const source = pickedSource && sources.includes(pickedSource) ? pickedSource : sources[0]
  const [selected, setSelected] = useState<{ id: string; line: TrafficLine } | null>(null)
  const selectedLine = selected?.line ?? null
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)
  const [hoverNode, setHoverNode] = useState<string | null>(null)
  const [why, setWhy] = useState<LineCheck | null>(null)

  // Data fetching
  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
  })

  const selectedNamespaces = useMemo(
    () => pickedNamespaces ?? new Set(namespaces?.some((ns) => ns.name === 'default') ? ['default'] : []),
    [pickedNamespaces, namespaces],
  )
  const setSelectedNamespaces = useCallback(
    (next: SetStateAction<Set<string>>) => {
      setPickedNamespaces((prev) => (typeof next === 'function' ? next(prev ?? selectedNamespaces) : next))
    },
    [selectedNamespaces],
  )

  const nsArray = useMemo(() => {
    if (selectedNamespaces.size === 0) return undefined
    return [...selectedNamespaces]
  }, [selectedNamespaces])

  const hasSelection = selectedNamespaces.size > 0

  const { data: graphData, isLoading, error: graphError, refetch: refetchGraph } = useQuery({
    queryKey: ['resource-graph', nsArray],
    queryFn: () => api.getResourceGraph(nsArray),
    enabled: hasSelection,
  })
  const graphErrorCode = (graphError as { response?: { status?: number } } | null)?.response?.status
  const forbiddenKinds = graphData?.forbidden_kinds ?? []

  // Read once when switched on, and on refresh: a Relay read is recorded in the audit log.
  const trafficQuery = useQuery({
    queryKey: ['network-traffic', currentCluster, nsArray, source],
    queryFn: () => api.getNetworkTraffic(nsArray ?? [], trafficParams(source!)),
    enabled: view !== 'structure' && !!source && hasSelection,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  const traffic = view !== 'structure' && trafficQuery.data?.available ? trafficQuery.data : undefined
  const trafficError = trafficQuery.error as { response?: { status?: number; data?: { detail?: string; error?: string } }; message?: string } | null
  const trafficErrorText = trafficError ? trafficError.response?.data?.detail ?? trafficError.response?.data?.error ?? trafficError.message : undefined

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
        // the traffic lines on screen, counted only: the AI reads flows itself (network_flows)
        traffic: traffic ? { view, source, lines: traffic.lines.length, dropped_lines: traffic.lines.filter((l) => l.dropped > 0).length, truncated: traffic.truncated || undefined } : undefined,
      },
    }
  }, [graphData, nsArray, kindFilters, edgeTypeFilters, searchQuery, groupBy, statusFilter, traffic, view, source])

  useAIContext(aiSnapshot, [aiSnapshot])

  const { nodes: laidNodes, edges: laidEdges, onNodesChange, onEdgesChange, layoutReady, selfLoops, routed } = useResourceGraphLayout({
    graphData,
    kindFilters,
    edgeTypeFilters,
    searchQuery,
    statusFilter,
    groupBy,
    view,
    traffic: traffic?.lines,
  })
  // the box whose drawer is open keeps its lines lit (a stand-in by the end it stands for)
  const drawerNode = useMemo(() => {
    if (!routed || !drawerTarget) return undefined
    const t = drawerTarget
    return laidNodes.find((n) => {
      const raw = n.data?.raw as ResourceGraphNode | undefined
      if (!raw) return false
      if (isPeer(raw)) return raw.end.kind === t.kind && raw.end.name === t.name && raw.end.namespace === t.namespace
      return raw.kind === t.kind && raw.name === t.name && (raw.namespace || undefined) === (t.namespace || undefined)
    })?.id
  }, [routed, drawerTarget, laidNodes])
  const focus = !routed ? null
    : hoverEdge ? { edge: hoverEdge }
      : hoverNode ? { node: hoverNode }
        : selected ? { edge: selected.id }
          : drawerNode ? { node: drawerNode } : null
  const { nodes, edges } = useMemo(() => focusLines(laidNodes, laidEdges, focus), [laidNodes, laidEdges, focus?.edge, focus?.node]) // eslint-disable-line react-hooks/exhaustive-deps

  // Interactions
  const openEnd = useCallback((e: TrafficEnd) => {
    if (openableEnd(e)) openDetail({ kind: e.kind, name: e.name, namespace: e.namespace })
  }, [openDetail])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const raw = node.data?.raw as ResourceGraphNode | undefined
    if (raw && isPeer(raw)) openEnd(raw.end)
    else if (raw) {
      openDetail({ kind: raw.kind, name: raw.name, namespace: raw.namespace })
    }
  }, [openDetail, openEnd])

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    const line = edge.data?.line as TrafficLine | undefined
    if (line) setSelected({ id: edge.id, line })
  }, [])

  const onEdgeMouseEnter = useCallback((_: React.MouseEvent, edge: Edge) => {
    if (edge.data?.line) setHoverEdge(edge.id)
  }, [])
  const onEdgeMouseLeave = useCallback(() => setHoverEdge(null), [])

  const onNodeMouseEnter = useCallback((_: React.MouseEvent, node: Node) => {
    setHoverNode(node.id)
    const raw = node.data?.raw as ResourceGraphNode | undefined
    if (raw && !isPeer(raw)) {
      setGlanceNode(raw)
      // Position relative to viewport
      const rect = (_.target as HTMLElement).getBoundingClientRect()
      setGlancePos({ x: rect.right, y: rect.top })
    }
  }, [])

  const onNodeMouseLeave = useCallback(() => {
    setGlanceNode(null)
    setHoverNode(null)
  }, [])

  const nodeCount = graphData?.nodes?.length || 0
  const edgeCount = graphData?.edges?.length || 0

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 64px)' }}>
      <ResourceGraphHeader
        nodeCount={nodeCount}
        edgeCount={edgeCount}
        trafficLineCount={traffic?.lines.length}
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
        extra={sources.length > 0 && source ? (
          <TrafficControls
            view={view}
            setView={(v) => { setView(v); setSelected(null) }}
            sources={sources}
            source={source}
            setSource={(s) => { setSource(s); setSelected(null) }}
            onRefresh={() => { setSelected(null); void trafficQuery.refetch() }}
            fetching={trafficQuery.isFetching}
          />
        ) : undefined}
      />

      {/* Graph */}
      <div className="flex-1 relative" style={{ minHeight: 0 }}>
        {!hasSelection ? (
          <div className="w-full h-full flex flex-col items-center justify-center text-slate-400">
            <div className="max-w-lg text-center">
              <div className="text-6xl mb-6 opacity-30">🔗</div>
              <h2 className="text-xl font-bold text-white mb-3">{t('resourceGraph.title', 'Resource Graph')}</h2>
              <p className="text-sm text-slate-400 mb-6 leading-relaxed">
                {t('resourceGraph.emptyDesc1')}<br />
                {t('resourceGraph.emptyDesc2')}<br />
                {t('resourceGraph.emptyDesc3')}
              </p>
              <div className="grid grid-cols-3 gap-3 mb-8 text-[11px]">
                <div className="bg-slate-800 rounded-lg p-3 border border-slate-700">
                  <div className="text-lg mb-1">📊</div>
                  <div className="text-slate-300 font-medium">{t('resourceGraph.featureGroupingTitle')}</div>
                  <div className="text-slate-500 mt-1 whitespace-pre-line">{t('resourceGraph.featureGroupingDesc')}</div>
                </div>
                <div className="bg-slate-800 rounded-lg p-3 border border-slate-700">
                  <div className="text-lg mb-1">🔍</div>
                  <div className="text-slate-300 font-medium">{t('resourceGraph.featureFilteringTitle')}</div>
                  <div className="text-slate-500 mt-1 whitespace-pre-line">{t('resourceGraph.featureFilteringDesc')}</div>
                </div>
                <div className="bg-slate-800 rounded-lg p-3 border border-slate-700">
                  <div className="text-lg mb-1">👆</div>
                  <div className="text-slate-300 font-medium">{t('resourceGraph.featureInteractionTitle')}</div>
                  <div className="text-slate-500 mt-1 whitespace-pre-line">{t('resourceGraph.featureInteractionDesc')}</div>
                </div>
              </div>
              <p className="text-sm text-slate-500">
                {t('resourceGraph.selectNamespaceHint')}
              </p>
            </div>
          </div>
        ) : graphError && !graphData ? (
          <div className="w-full h-full flex flex-col items-center justify-center text-slate-400" data-testid="resource-graph-error">
            <Info className="w-12 h-12 mb-3" />
            <p className="text-sm">
              {graphErrorCode
                ? t('common.loadErrorEmpty', { resource: 'Resource Graph', code: graphErrorCode, defaultValue: 'Could not load {{resource}} (server error {{code}}).' })
                : t('common.loadErrorEmptyNetwork', { resource: 'Resource Graph', defaultValue: 'Could not load {{resource}} (no response from the server).' })}
            </p>
            <button
              type="button"
              onClick={() => void refetchGraph()}
              className="mt-3 rounded-sm border border-slate-600 px-2 py-0.5 text-xs text-slate-200 hover:border-slate-400"
            >
              {t('common.retry', { defaultValue: 'Retry' })}
            </button>
          </div>
        ) : isLoading || !layoutReady || (view !== 'structure' && trafficQuery.isLoading) ? (
          <div className="w-full h-full flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
          </div>
        ) : view === 'traffic' && nodes.length === 0 ? (
          <div className="w-full h-full flex flex-col items-center justify-center text-slate-400" data-testid="traffic-empty">
            <Info className="w-12 h-12 mb-3" />
            <p className="text-sm max-w-md text-center">
              {trafficErrorText
                ? trafficErrorText
                : trafficQuery.data && !trafficQuery.data.available
                  ? t(`resourceGraph.traffic.unavailable.${trafficQuery.data.reason}`, unavailableText[trafficQuery.data.reason ?? 'no_metrics'])
                  : t('resourceGraph.traffic.none', 'No traffic between these namespaces’ workloads in what was read.')}
            </p>
          </div>
        ) : nodeCount === 0 ? (
          <div className="w-full h-full flex flex-col items-center justify-center text-slate-400">
            <Info className="w-12 h-12 mb-3" />
            <p className="text-sm">{t('resourceGraph.noData', 'No resources found')}</p>
          </div>
        ) : (
          <div style={{ width: '100%', height: '100%' }} className="[&_.react-flow\_\_attribution]:hidden!">
            <ReactFlow
              // routed lines do not use the side handles: hidden, so no dot suggests a line ends there
              className={routed ? '[&_[data-handlepos]]:opacity-0!' : undefined}
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onEdgeMouseEnter={onEdgeMouseEnter}
              onEdgeMouseLeave={onEdgeMouseLeave}
              edgeTypes={edgeTypes}
              nodesDraggable={!routed}
              onNodeMouseEnter={onNodeMouseEnter}
              onNodeMouseLeave={onNodeMouseLeave}
              fitView
              // with lines on screen, room for the status box above and the open legend on the left, so they cover no box
              fitViewOptions={{ padding: routed ? { top: '64px', right: 0.1, bottom: 0.1, left: legendOpen ? '180px' : 0.1 } : 0.2 }}
              minZoom={0.05}
              maxZoom={2}
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#334155" />
              <Controls className="bg-slate-800! border-slate-700! rounded-lg! [&>button]:bg-slate-700! [&>button]:border-slate-600! [&>button]:text-white! [&>button:hover]:bg-slate-600!" />
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

        {hasSelection && forbiddenKinds.length > 0 && (
          <div
            className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-lg border border-amber-700/50 bg-amber-900/80 px-3 py-1.5 text-xs text-amber-100"
            data-testid="resource-graph-forbidden"
          >
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-300" />
            {t('common.forbiddenEmpty', { resource: forbiddenKinds.join(', '), defaultValue: 'You do not have permission to view {{resource}} in this cluster.' })}
          </div>
        )}

        {/* Traffic: what was read and what the lines leave out */}
        {hasSelection && view !== 'structure' && !trafficQuery.isLoading && (view === 'both' || nodes.length > 0) && (
          <TrafficStatus
            error={trafficErrorText}
            result={trafficQuery.data}
            selfLoops={selfLoops}
          />
        )}

        {selectedLine && traffic && (
          <TrafficPanel line={selectedLine} result={traffic} onClose={() => setSelected(null)} onWhy={setWhy} onOpen={openEnd} />
        )}
        {why && <NetworkPolicyCheckModal self={why.self} selfName={why.selfName} namespace={why.namespace} initial={why.initial} onClose={() => setWhy(null)} />}

        {/* Glance */}
        <Glance node={glanceNode} position={glancePos} />

        {/* Legend (bottom left) — only with a graph on screen (the empty state
            has nothing to decode and the panel overlapped its cards at 1024px),
            and collapsible to a single line */}
        {(graphData?.nodes?.length ?? 0) > 0 && (
        <div className="absolute bottom-4 left-4 bg-slate-800/90 border border-slate-700 rounded-lg p-3 text-xs space-y-1.5 z-10 backdrop-blur-xs">
          <button
            type="button"
            onClick={() => setLegendOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-3 font-medium text-slate-300"
            aria-expanded={legendOpen}
          >
            <span>{t('resourceGraph.legend', 'Legend')}</span>
            <span className="text-slate-500">{legendOpen ? '−' : '+'}</span>
          </button>
          {legendOpen && view !== 'traffic' && ALL_EDGE_TYPES.filter(type => edgeTypeFilters.has(type)).slice(0, 7).map(type => {
            const style = edgeStyles[type]
            return (
              <div key={type} className="flex items-center gap-2">
                <svg width="24" height="8" className="shrink-0">
                  <line x1="0" y1="4" x2="20" y2="4" stroke={style.stroke} strokeWidth="2" strokeDasharray={style.strokeDasharray || ''} />
                  <polygon points="20,1 24,4 20,7" fill={style.stroke} />
                </svg>
                <span style={{ color: style.stroke }}>{style.label}</span>
              </div>
            )
          })}
          {legendOpen && traffic && (
          <div className="border-t border-slate-700 pt-1.5 mt-1.5 space-y-1" data-testid="traffic-legend">
            {(['allowed', 'mixed', 'dropped'] as const).map((st) => (
              <div key={st} className="flex items-center gap-2">
                <svg width="24" height="8" className="shrink-0">
                  <line x1="0" y1="4" x2="20" y2="4" stroke={lineColor[st]} strokeWidth="2.5" strokeDasharray={st === 'dropped' ? '6 4' : ''} />
                  <polygon points="20,1 24,4 20,7" fill={lineColor[st]} />
                </svg>
                <span style={{ color: lineColor[st] }}>{t(`resourceGraph.traffic.legend.${st}`, legendText[st])}</span>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-sm border-2 border-dashed border-slate-500" />
              <span className="text-slate-400">{t('resourceGraph.traffic.legend.peer', 'not in this graph')}</span>
            </div>
            <div className="text-slate-500 max-w-[160px]">
              {traffic.source === 'relay'
                ? t('resourceGraph.traffic.legend.unitRelay', 'port · number of flows')
                : t('resourceGraph.traffic.legend.unitMetrics', 'number = TCP connections · ✕ dropped packets')}
            </div>
          </div>
          )}
          {legendOpen && (
          <div className="border-t border-slate-700 pt-1.5 mt-1.5 space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-sm border-2 border-green-500" />
              <span className="text-slate-400">{t('resourceGraph.legendRunning', 'Running / Active')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-sm border-2 border-yellow-500" />
              <span className="text-slate-400">{t('resourceGraph.legendPending', 'Pending')}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-sm border-2 border-red-500" />
              <span className="text-slate-400">{t('resourceGraph.legendFailed', 'Failed / Error')}</span>
            </div>
          </div>
          )}
        </div>
        )}
      </div>
    </div>
  )
}

const unavailableText: Record<string, string> = {
  no_prometheus: 'This cluster has no Prometheus Kubeast can read.',
  no_metrics: "The cluster's Prometheus has no Hubble TCP or drop metric. See the cluster requirements (Hubble metrics).",
  no_context_labels: "The cluster's Hubble metrics have no pod or workload labels. See the cluster requirements (Hubble metrics).",
}

const legendText = { allowed: 'allowed', mixed: 'partly dropped', dropped: 'dropped' }

// TrafficStatus says what the lines come from and what they leave out.
function TrafficStatus({ error, result, selfLoops }: { error?: string; result?: TrafficResult; selfLoops: number }) {
  const { t } = useTranslation()
  const lines: { key: string; text: string; warn?: boolean }[] = []
  if (error) lines.push({ key: 'error', text: error, warn: true })
  else if (result && !result.available) lines.push({ key: 'unavailable', text: t(`resourceGraph.traffic.unavailable.${result.reason}`, unavailableText[result.reason ?? 'no_metrics']), warn: true })
  else if (result) {
    lines.push({
      key: 'source',
      text: result.source === 'metrics'
        ? t('resourceGraph.traffic.statusMetrics', { defaultValue: '{{lines}} lines from the Hubble metrics (last {{w}})', lines: result.lines.length, count: result.lines.length, w: result.range })
        : result.provider === 'calico'
          ? t('resourceGraph.traffic.statusCalico', { defaultValue: "{{lines}} lines from {{flows}} recent flow records of Calico's Whisker, counted in packets (last {{w}})", lines: result.lines.length, count: result.lines.length, flows: result.flows ?? 0, w: result.since })
          : t('resourceGraph.traffic.statusRelay', { defaultValue: '{{lines}} lines from {{flows}} recent flows of the Hubble Relay (last {{w}})', lines: result.lines.length, count: result.lines.length, flows: result.flows ?? 0, w: result.since }),
    })
    if (result.truncated) lines.push({ key: 'truncated', text: t('resourceGraph.traffic.truncated', 'Only the latest flows the Relay returned: older traffic is not drawn.'), warn: true })
    if (result.lines_truncated) lines.push({ key: 'lines', text: t('resourceGraph.traffic.linesTruncated', 'Only the busiest 300 lines are drawn.'), warn: true })
    for (const n of result.notes ?? []) lines.push({ key: n, text: t(`resourceGraph.traffic.note.${n}`, noteText[n] ?? n), warn: n !== 'counted_at_both_ends' })
    if ((result.lost_events ?? 0) > 0) lines.push({ key: 'lost', text: t('netflows.lost', { defaultValue: 'Hubble reported {{n}} lost events: some flows may be missing.', n: result.lost_events, count: result.lost_events }), warn: true })
    if (result.redacted) lines.push({ key: 'redacted', text: t('resourceGraph.traffic.redacted', 'Peers outside your namespaces show their namespace only.') })
    if (selfLoops > 0) lines.push({ key: 'self', text: t('resourceGraph.traffic.selfLoops', { defaultValue: '{{n}} lines inside one workload are not drawn.', n: selfLoops, count: selfLoops }) })
  }
  if (lines.length === 0) return null
  return (
    <div className="absolute top-3 left-3 z-10 max-w-md rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-2 text-xs space-y-0.5 backdrop-blur-xs" data-testid="traffic-status">
      {lines.map((l) => <p key={l.key} className={l.warn ? 'text-amber-300' : 'text-slate-300'} data-testid={`traffic-status-${l.key}`}>{l.text}</p>)}
    </div>
  )
}

const noteText: Record<string, string> = {
  no_tcp_metric: "The cluster's Hubble TCP metric is missing or has no workload labels: only drops are drawn.",
  no_drop_metric: "The cluster's Hubble drop metric is missing or has no workload labels: drops are not drawn.",
  counted_at_both_ends: 'The metric has no traffic_direction label: a connection seen at both ends counts twice.',
  pods_only_no_outside: "The metric names pods only and cannot tell a Service's address from one outside the pods: connections leaving towards an unnamed address are not drawn.",
}
