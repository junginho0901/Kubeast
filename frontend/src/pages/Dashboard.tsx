import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, TopResources, disableMetrics, isMetricsDisabled, isMetricsUnavailableError } from '@/services/api'
import {
  Server,
  Box,
  Database,
  HardDrive,
  TrendingUp,
  AlertCircle,
  RefreshCw,
  X,
  CheckCircle,
  XCircle,
  Search,
  Info,
  ChevronDown,
  Copy,
  StopCircle
} from 'lucide-react'
// recharts unused for status charts – kept for potential future use
// import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, Customized } from 'recharts'
import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalOverlay } from '@/components/ModalOverlay'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type ResourceType = 'namespaces' | 'pods' | 'services' | 'deployments' | 'pvcs' | 'nodes'

interface Iso3DChartColors {
  front: [string, string]
  side: string
  top: string
  accent: string
}

function Iso3DChart({
  data,
  chartHeight = 340,
  colors,
  uid,
  onBarClick,
}: {
  data: { name: string; value: number }[]
  chartHeight?: number
  colors: Iso3DChartColors
  uid: string
  onBarClick?: (name: string) => void
}) {
  const [hovered, setHovered] = useState<number | null>(null)

  const VW = 540, VH = 340
  const M = { t: 30, r: 55, b: 40, l: 48 }
  const CW = VW - M.l - M.r
  const CH = VH - M.t - M.b

  const DX = 22, DY = -11
  const BDX = 16, BDY = -8

  const maxVal = Math.max(...data.map(d => d.value), 1)
  const niceMax = Math.ceil(maxVal / 10) * 10 || 10

  const n = data.length
  const groupW = CW / n
  const barW = Math.min(groupW * 0.48, 52)

  const baseY = M.t + CH
  const yTicks = 5
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) =>
    Math.round(niceMax * i / yTicks)
  )

  const gF = `iso-f-${uid}`
  const gW = `iso-w-${uid}`

  return (
    <div style={{ width: '100%' }}>
      <style>{`
        @keyframes iso-grow-${uid} {
          from { transform: scaleY(0); }
          to   { transform: scaleY(1); }
        }
      `}</style>
      <svg
        width="100%"
        height={chartHeight}
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <linearGradient id={gF} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colors.front[0]} />
            <stop offset="100%" stopColor={colors.front[1]} />
          </linearGradient>
          <linearGradient id={`${gF}-floor`} x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0%" stopColor={colors.accent} stopOpacity={0.07} />
            <stop offset="100%" stopColor={colors.accent} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id={gW} x1="1" y1="0" x2="0" y2="0">
            <stop offset="0%" stopColor={colors.accent} stopOpacity={0.05} />
            <stop offset="100%" stopColor={colors.accent} stopOpacity={0.01} />
          </linearGradient>
        </defs>

        {/* ═══ LEFT WALL ═══ */}
        <polygon
          points={`${M.l},${baseY} ${M.l + DX},${baseY + DY} ${M.l + DX},${M.t + DY} ${M.l},${M.t}`}
          fill={`url(#${gW})`}
        />
        {ticks.map(tick => {
          if (tick === 0) return null
          const y = baseY - (tick / niceMax) * CH
          return (
            <line key={`lw-${tick}`}
              x1={M.l} y1={y} x2={M.l + DX} y2={y + DY}
              stroke={colors.accent} strokeWidth={0.5} opacity={0.1}
            />
          )
        })}
        <line x1={M.l} y1={M.t} x2={M.l} y2={baseY}
          stroke={colors.accent} strokeWidth={0.6} opacity={0.12} />

        {/* ═══ BACK WALL (no dashed lines, just subtle fill) ═══ */}
        <polygon
          points={`${M.l + DX},${baseY + DY} ${M.l + CW + DX},${baseY + DY} ${M.l + CW + DX},${M.t + DY} ${M.l + DX},${M.t + DY}`}
          fill={`url(#${gW})`}
        />

        {/* ═══ FLOOR PLANE ═══ */}
        <polygon
          points={`${M.l},${baseY} ${M.l + CW},${baseY} ${M.l + CW + DX},${baseY + DY} ${M.l + DX},${baseY + DY}`}
          fill={`url(#${gF}-floor)`}
        />
        {data.map((_, i) => {
          const x = M.l + i * groupW + groupW / 2
          return (
            <line key={`fd-${i}`}
              x1={x} y1={baseY} x2={x + DX} y2={baseY + DY}
              stroke={colors.accent} strokeWidth={0.4} opacity={0.08}
            />
          )
        })}
        {[0.5, 1].map(t => (
          <line key={`fc-${t}`}
            x1={M.l + DX * t} y1={baseY + DY * t}
            x2={M.l + CW + DX * t} y2={baseY + DY * t}
            stroke={colors.accent} strokeWidth={0.3} opacity={0.06}
          />
        ))}

        {/* Floor edges */}
        <line x1={M.l} y1={baseY} x2={M.l + CW} y2={baseY}
          stroke={colors.accent} strokeWidth={1.2} opacity={0.2} />
        <line x1={M.l + CW} y1={baseY} x2={M.l + CW + DX} y2={baseY + DY}
          stroke={colors.accent} strokeWidth={0.6} opacity={0.12} />
        <line x1={M.l} y1={baseY} x2={M.l + DX} y2={baseY + DY}
          stroke={colors.accent} strokeWidth={0.5} opacity={0.08} />

        {/* ═══ Y AXIS LABELS + subtle front lines ═══ */}
        {ticks.map(tick => {
          const y = baseY - (tick / niceMax) * CH
          return (
            <g key={`yt-${tick}`}>
              {tick > 0 && (
                <line x1={M.l} y1={y} x2={M.l + CW} y2={y}
                  stroke={colors.accent} strokeWidth={0.25} opacity={0.05} />
              )}
              <text x={M.l - 10} y={y + 3.5}
                textAnchor="end" fill="#64748b" fontSize={10}
              >
                {tick}
              </text>
            </g>
          )
        })}

        {/* ═══ 3D BARS (animated) ═══ */}
        {data.map((d, i) => {
          const rawH = (d.value / niceMax) * CH
          const barH = Math.max(rawH, d.value > 0 ? 5 : 0)
          if (barH <= 0) return null

          const bx = M.l + i * groupW + (groupW - barW) / 2
          const by = baseY - barH
          const isHov = hovered === i
          const delay = i * 0.08

          return (
            <g key={d.name}
              style={{
                cursor: 'pointer',
                transition: 'opacity 0.2s',
                transformOrigin: `${bx + barW / 2}px ${baseY}px`,
                animation: `iso-grow-${uid} 0.7s cubic-bezier(0.34,1.56,0.64,1) ${delay}s both`,
              }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => onBarClick?.(d.name)}
              opacity={hovered !== null && !isHov ? 0.5 : 1}
            >
              {/* Floor shadow */}
              <polygon
                points={`${bx + 2},${baseY} ${bx + barW + 2},${baseY} ${bx + barW + BDX + 2},${baseY + BDY} ${bx + BDX + 2},${baseY + BDY}`}
                fill="#000" opacity={0.08}
              />

              {/* FRONT FACE */}
              <rect x={bx} y={by} width={barW} height={barH}
                fill={`url(#${gF})`}
                stroke={isHov ? colors.front[0] : 'transparent'}
                strokeWidth={isHov ? 1.2 : 0}
              />

              {/* RIGHT SIDE FACE */}
              <polygon
                points={`${bx + barW},${by} ${bx + barW + BDX},${by + BDY} ${bx + barW + BDX},${baseY + BDY} ${bx + barW},${baseY}`}
                fill={colors.side}
              />

              {/* TOP FACE */}
              <polygon
                points={`${bx},${by} ${bx + BDX},${by + BDY} ${bx + barW + BDX},${by + BDY} ${bx + barW},${by}`}
                fill={colors.top}
              />

              {/* Top face front edge */}
              <line x1={bx} y1={by} x2={bx + barW} y2={by}
                stroke="#fff" strokeWidth={0.5} opacity={0.1} />

              {/* Hover tooltip */}
              {isHov && d.value > 0 && (
                <g>
                  <rect
                    x={bx + barW / 2 + BDX / 2 - 22}
                    y={by + BDY - 28}
                    width={44} height={22} rx={6}
                    fill="rgba(15,23,42,0.92)"
                    stroke={colors.accent} strokeWidth={1} strokeOpacity={0.4}
                  />
                  <text
                    x={bx + barW / 2 + BDX / 2}
                    y={by + BDY - 13}
                    textAnchor="middle" fill="#f1f5f9"
                    fontSize={11} fontWeight={600}
                  >
                    {d.value}
                  </text>
                </g>
              )}
            </g>
          )
        })}

        {/* ═══ X AXIS LABELS ═══ */}
        {data.map((d, i) => {
          const x = M.l + i * groupW + groupW / 2
          return (
            <text key={`xl-${i}`}
              x={x} y={baseY + 20}
              textAnchor="middle" fill="#94a3b8"
              fontSize={10.5} fontWeight={500}
              style={{ cursor: 'pointer' }}
              onClick={() => onBarClick?.(d.name)}
            >
              {d.name}
            </text>
          )
        })}
      </svg>
    </div>
  )
}

export default function Dashboard() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()
  const tr = (key: string, fallback: string, options?: Record<string, any>) => t(key, { defaultValue: fallback, ...options })
  const na = tr('common.notAvailable', 'N/A')
  const none = tr('common.none', 'None')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedResourceType, setSelectedResourceType] = useState<ResourceType | null>(null)
  const [modalSearchQuery, setModalSearchQuery] = useState<string>('')
  const [isIssuesModalOpen, setIsIssuesModalOpen] = useState(false)
  const [issuesSearchQuery, setIssuesSearchQuery] = useState<string>('')
  const [includeRestartHistory, setIncludeRestartHistory] = useState(false)
  const [isStorageModalOpen, setIsStorageModalOpen] = useState(false)
  const [storageActiveTab, setStorageActiveTab] = useState<'pvcs' | 'pvs' | 'topology'>('pvcs')
  const [storageSearchQuery, setStorageSearchQuery] = useState<string>('')
  const [storageNamespaceFilter, setStorageNamespaceFilter] = useState<string>('all')
  const [isStorageNamespaceDropdownOpen, setIsStorageNamespaceDropdownOpen] = useState(false)
  const storageNamespaceDropdownRef = useRef<HTMLDivElement>(null)
  const [isOptimizationModalOpen, setIsOptimizationModalOpen] = useState(false)
  const [optimizationNamespace, setOptimizationNamespace] = useState<string>('default')
  const [isOptimizationNamespaceDropdownOpen, setIsOptimizationNamespaceDropdownOpen] = useState(false)
  const optimizationNamespaceDropdownRef = useRef<HTMLDivElement>(null)
  const [optimizationCopied, setOptimizationCopied] = useState(false)
  const optimizationAbortRef = useRef<AbortController | null>(null)
  const [isOptimizationStreaming, setIsOptimizationStreaming] = useState(false)
  const [optimizationObservedContent, setOptimizationObservedContent] = useState('')
  const [optimizationAnswerContent, setOptimizationAnswerContent] = useState('')
  const [optimizationStreamError, setOptimizationStreamError] = useState('')
  const optimizationStreamPendingRef = useRef('')
  const optimizationStreamRafRef = useRef<number | null>(null)
  const optimizationStreamDoneRef = useRef(false)
  // 타자기 큐
  const optimizationCharQueueRef = useRef<string[]>([])
  const optimizationTypewriterRef = useRef<number | null>(null)
  const optimizationMetaReceivedRef = useRef(false)
  const optimizationUsageReceivedRef = useRef(false)
  const [optimizationUsage, setOptimizationUsage] = useState<{
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  } | null>(null)
  const [optimizationMeta, setOptimizationMeta] = useState<{
    finish_reason?: string | null
    max_tokens?: number | null
  } | null>(null)
  const [selectedPodStatus, setSelectedPodStatus] = useState<string | null>(null)
  const [selectedNodeStatus, setSelectedNodeStatus] = useState<string | null>(null)
  const [metricsUnavailable, setMetricsUnavailable] = useState(() => isMetricsDisabled())

  const { data: overview, isLoading } = useQuery({
    queryKey: ['cluster-overview'],
    queryFn: () => api.getClusterOverview(false), // 자동 갱신은 캐시 사용
    staleTime: 30000,
    refetchInterval: 60000,
  })

  // 네임스페이스 목록
  const { data: namespaces, isLoading: isLoadingNamespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
    enabled: selectedResourceType === 'namespaces',
  })

  // 전체 Pod 목록
  const { data: allPods, isLoading: isLoadingPods } = useQuery({
    queryKey: ['all-pods'],
    queryFn: () => api.getAllPods(false), // 자동 갱신은 캐시 사용
    enabled: selectedResourceType === 'pods' || selectedPodStatus !== null || isIssuesModalOpen,
  })

  // 전체 Services 목록 (모든 네임스페이스)
  const { data: allNamespaces, isLoading: isLoadingAllNamespaces } = useQuery({
    queryKey: ['all-namespaces'],
    queryFn: () => api.getNamespaces(),
    enabled:
      selectedResourceType === 'services' ||
      selectedResourceType === 'deployments' ||
      isIssuesModalOpen ||
      isStorageModalOpen ||
      isOptimizationModalOpen,
  })

  const { data: allServices, isLoading: isLoadingServices } = useQuery({
    queryKey: ['all-services'],
    queryFn: async () => {
      if (!allNamespaces || !Array.isArray(allNamespaces)) return []
      const services = await Promise.all(
        allNamespaces.map((ns: any) => api.getServices(ns.name))
      )
      return services.flat()
    },
    enabled: selectedResourceType === 'services' && !!allNamespaces,
  })

  // 전체 Deployments 목록
  const { data: allDeployments, isLoading: isLoadingDeployments } = useQuery({
    queryKey: ['all-deployments'],
    queryFn: async () => {
      if (!allNamespaces || !Array.isArray(allNamespaces)) return []
      const deployments = await Promise.all(
        allNamespaces.map((ns: any) => api.getDeployments(ns.name))
      )
      return deployments.flat()
    },
    enabled: (selectedResourceType === 'deployments' || isIssuesModalOpen || isStorageModalOpen) && !!allNamespaces,
  })

  // 전체 PVC 목록
  const { data: allPVCs, isLoading: isLoadingPVCs } = useQuery({
    queryKey: ['all-pvcs'],
    queryFn: () => api.getPVCs(),
    enabled: selectedResourceType === 'pvcs' || isIssuesModalOpen || isStorageModalOpen,
  })

  // 전체 PV 목록 (스토리지 분석용)
  const { data: allPVs, isLoading: isLoadingPVs } = useQuery({
    queryKey: ['all-pvs'],
    queryFn: () => api.getPVs(),
    enabled: isStorageModalOpen,
  })

  // 스토리지 토폴로지 (선택 탭에서만 로드)
  const {
    data: storageTopology,
    isLoading: isLoadingStorageTopology,
    isError: isStorageTopologyError,
    error: storageTopologyError,
  } = useQuery({
    queryKey: ['storage-topology'],
    queryFn: () => api.getStorageTopology(),
    enabled: isStorageModalOpen && storageActiveTab === 'topology',
    retry: false,
    staleTime: 30000,
    refetchOnWindowFocus: false,
  })

  // 노드 목록 (차트 표시용 - 항상 가져오기)
  const { data: nodes } = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.getNodes(false), // 자동 갱신은 캐시 사용
    staleTime: 30000,
    refetchInterval: 60000,
  })

  // Top 리소스 사용 파드/노드 (5초마다 갱신)
  const {
    data: topResources,
    isLoading: isLoadingTopResources,
    isError: isTopResourcesError,
    error: topResourcesError
  } = useQuery<TopResources>({
    queryKey: ['top-resources'],
    queryFn: async () => {
      const result = await api.getTopResources(5, 3)
      // 백엔드에서 빈 배열을 반환한 경우(일시적 실패) 이전 데이터 유지를 위해
      // 유효한 데이터가 있는지 확인
      const hasValidData = (result.top_pods && result.top_pods.length > 0) ||
                          (result.top_nodes && result.top_nodes.length > 0)
      
      if (!hasValidData) {
        // 빈 데이터면 에러를 throw하여 React Query가 이전 데이터를 유지하도록
        // placeholderData가 이전 데이터를 반환하도록 함
        throw new Error('No valid metrics data available')
      }
      
      return result
    },
    enabled: !metricsUnavailable && !isMetricsDisabled(),
    staleTime: 5000, // 5초간 fresh 상태 유지
    refetchInterval: () => {
      if (metricsUnavailable || isMetricsDisabled()) return false
      return 5000
    },
    placeholderData: (previousData) => {
      // 이전 데이터가 있고 유효한 경우에만 유지
      // 에러 발생 시에도 이전 데이터를 유지하여 깜빡임 방지
      if (previousData && (
        (previousData.top_pods && previousData.top_pods.length > 0) ||
        (previousData.top_nodes && previousData.top_nodes.length > 0)
      )) {
        return previousData
      }
      return undefined
    },
    retry: (failureCount, error) => {
      if (isMetricsUnavailableError(error)) return false
      return failureCount < 1
    },
    retryDelay: 1000,
    gcTime: 60000,
  })

  useEffect(() => {
    if (isMetricsUnavailableError(topResourcesError)) {
      disableMetrics()
      setMetricsUnavailable(true)
    }
  }, [topResourcesError])

  useEffect(() => {
    if (metricsUnavailable) {
      queryClient.cancelQueries({ queryKey: ['top-resources'] })
    }
  }, [metricsUnavailable, queryClient])

  // 노드 목록 (모달용)
  const { data: modalNodes, isLoading: isLoadingNodes } = useQuery({
    queryKey: ['modal-nodes'],
    queryFn: () => api.getNodes(false), // 자동 갱신은 캐시 사용
    enabled: selectedResourceType === 'nodes',
  })


  const handleRefresh = async () => {
    console.log('🔄 새로고침 시작...')
    setIsRefreshing(true)
    // 새로고침은 항상 강제 갱신 (force_refresh=true)
    try {
      // 메인 데이터를 직접 호출하고 캐시에 수동으로 업데이트
      console.log('📡 API 호출 중 (force_refresh=true)...')

      // 먼저 네임스페이스 목록을 가져옴 (다른 API 호출에 필요)
      const namespacesData = await api.getNamespaces()

      // 나머지를 병렬로 호출 (네임스페이스별 리소스 조회 포함)
      const [overviewData, nodesData, allPodsData, allServicesData, allDeploymentsData, allPVCsData] = await Promise.all([
        api.getClusterOverview(true),
        api.getNodes(true),
        api.getAllPods(true),
        // 모든 네임스페이스의 Services 조회
        Promise.all(namespacesData.map((ns: any) => api.getServices(ns.name, true))).then(results => results.flat()),
        // 모든 네임스페이스의 Deployments 조회
        Promise.all(namespacesData.map((ns: any) => api.getDeployments(ns.name, true))).then(results => results.flat()),
        // 모든 네임스페이스의 PVCs 조회
        api.getPVCs(undefined, true),
      ])

      console.log('✅ API 응답 받음:', {
        overview: overviewData,
        overviewPods: overviewData?.total_pods,
        namespaces: namespacesData?.length,
        nodes: nodesData?.length,
        pods: allPodsData?.length,
        services: allServicesData?.length,
        deployments: allDeploymentsData?.length,
        pvcs: allPVCsData?.length
      })
      console.log('📊 현재 화면에 표시중인 overview:', overview)

      // 실제 데이터로 overview 보정 (타이밍 이슈 방지)
      const correctedOverview = {
        ...overviewData,
        total_pods: allPodsData.length,
        total_namespaces: namespacesData.length,
        total_services: allServicesData.length,
        total_deployments: allDeploymentsData.length,
        total_pvcs: allPVCsData.length,
      }

      console.log('✏️  보정된 overview:', correctedOverview)

      // 캐시를 완전히 제거하고 새 데이터로 설정 (강제 리렌더링)
      queryClient.removeQueries({ queryKey: ['cluster-overview'] })
      queryClient.removeQueries({ queryKey: ['namespaces'] })
      queryClient.removeQueries({ queryKey: ['all-namespaces'] })
      queryClient.removeQueries({ queryKey: ['nodes'] })
      queryClient.removeQueries({ queryKey: ['modal-nodes'] })
      queryClient.removeQueries({ queryKey: ['all-pods'] })
      queryClient.removeQueries({ queryKey: ['all-services'] })
      queryClient.removeQueries({ queryKey: ['all-deployments'] })
      queryClient.removeQueries({ queryKey: ['all-pvcs'] })

      // 새 데이터로 캐시 설정 (보정된 overview 사용)
      queryClient.setQueryData(['cluster-overview'], correctedOverview)
      queryClient.setQueryData(['namespaces'], namespacesData)
      queryClient.setQueryData(['all-namespaces'], namespacesData)
      queryClient.setQueryData(['nodes'], nodesData)
      queryClient.setQueryData(['modal-nodes'], nodesData)
      queryClient.setQueryData(['all-pods'], allPodsData)
      queryClient.setQueryData(['all-services'], allServicesData)
      queryClient.setQueryData(['all-deployments'], allDeploymentsData)
      queryClient.setQueryData(['all-pvcs'], allPVCsData)

      console.log('💾 React Query 캐시 업데이트 완료')
    } catch (error) {
      console.error('❌ 새로고침 실패:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const handleStatClick = (type: ResourceType) => {
    setSelectedResourceType(type)
  }

  const handleCloseModal = () => {
    setSelectedResourceType(null)
    setSelectedPodStatus(null)
    setSelectedNodeStatus(null)
    setModalSearchQuery('')
  }

  const handleOpenIssuesModal = () => {
    handleCloseModal()
    setIsStorageModalOpen(false)
    setIsOptimizationModalOpen(false)
    setIsIssuesModalOpen(true)
  }

  const handleOpenStorageModal = () => {
    handleCloseModal()
    setIsIssuesModalOpen(false)
    setIsOptimizationModalOpen(false)
    setStorageActiveTab('pvcs')
    setStorageSearchQuery('')
    setStorageNamespaceFilter('all')
    setIsStorageNamespaceDropdownOpen(false)
    setIsStorageModalOpen(true)
  }

  const handleOpenOptimizationModal = () => {
    handleCloseModal()
    setIsIssuesModalOpen(false)
    setIsStorageModalOpen(false)
    setIsStorageNamespaceDropdownOpen(false)
    setIsOptimizationNamespaceDropdownOpen(false)
    setOptimizationCopied(false)
    optimizationAbortRef.current?.abort()
    optimizationAbortRef.current = null
    if (optimizationStreamRafRef.current) {
      window.cancelAnimationFrame(optimizationStreamRafRef.current)
      optimizationStreamRafRef.current = null
    }
    optimizationStreamPendingRef.current = ''
    optimizationStreamDoneRef.current = false
    setIsOptimizationStreaming(false)
    setOptimizationObservedContent('')
    setOptimizationAnswerContent('')
    setOptimizationStreamError('')

    const namespaceNames = Array.isArray(allNamespaces)
      ? allNamespaces.map((ns: any) => String(ns?.name ?? '')).filter(Boolean)
      : []
    const preferred = namespaceNames.includes('default') ? 'default' : (namespaceNames[0] ?? 'default')
    setOptimizationNamespace(preferred)

    setIsOptimizationModalOpen(true)
  }

  useEffect(() => {
    if (!isIssuesModalOpen) return
    // 모달을 열 때마다 최신 상태(특히 CrashLoopBackOff reason 등)를 다시 가져오도록 강제한다.
    void queryClient.invalidateQueries({ queryKey: ['all-pods'], refetchType: 'active' })
    void queryClient.invalidateQueries({ queryKey: ['all-pvcs'], refetchType: 'active' })
    void queryClient.invalidateQueries({ queryKey: ['all-namespaces'], refetchType: 'active' })
    void queryClient.invalidateQueries({ queryKey: ['all-deployments'], refetchType: 'active' })
    void queryClient.invalidateQueries({ queryKey: ['nodes'], refetchType: 'active' })
  }, [isIssuesModalOpen, queryClient])

  const handleCloseIssuesModal = () => {
    setIsIssuesModalOpen(false)
    setIssuesSearchQuery('')
    setIncludeRestartHistory(false)
  }

  const handleCloseStorageModal = () => {
    setIsStorageModalOpen(false)
    setStorageSearchQuery('')
    setStorageNamespaceFilter('all')
    setIsStorageNamespaceDropdownOpen(false)
  }

  const handleCloseOptimizationModal = () => {
    setIsOptimizationModalOpen(false)
    setIsOptimizationNamespaceDropdownOpen(false)
    setOptimizationCopied(false)
    optimizationAbortRef.current?.abort()
    optimizationAbortRef.current = null
    if (optimizationStreamRafRef.current) {
      window.cancelAnimationFrame(optimizationStreamRafRef.current)
      optimizationStreamRafRef.current = null
    }
    optimizationStreamPendingRef.current = ''
    optimizationStreamDoneRef.current = false
    setIsOptimizationStreaming(false)
    setOptimizationObservedContent('')
    setOptimizationAnswerContent('')
    setOptimizationStreamError('')
  }

  const unwrapOuterMarkdownFence = (text: string) => {
    const trimmed = text.trim()
    const match = trimmed.match(/^```(?:markdown|md)?\n([\s\S]*)\n```$/i)
    return match ? match[1] : text
  }

  const makeStreamingMarkdownRenderFriendly = (markdown: string) => {
    if (!markdown) return markdown

    const lines = markdown.split('\n')
    let inFence = false
    let doubleAsteriskCount = 0
    let backtickCount = 0

    for (const line of lines) {
      const trimmedStart = line.trimStart()
      if (trimmedStart.startsWith('```')) {
        inFence = !inFence
        continue
      }

      if (inFence) continue

      let idx = 0
      for (;;) {
        const next = line.indexOf('**', idx)
        if (next === -1) break
        doubleAsteriskCount += 1
        idx = next + 2
      }

      for (let i = 0; i < line.length; i++) {
        if (line[i] === '`') backtickCount += 1
      }
    }

    let out = markdown
    if (inFence) out += '\n```'
    if (doubleAsteriskCount % 2 === 1) out += '**'
    if (backtickCount % 2 === 1) out += '`'
    if (out.endsWith('*') && !out.endsWith('**')) out += '*'
    return out
  }

  const stopOptimizationTypewriter = () => {
    if (optimizationTypewriterRef.current !== null) {
      clearInterval(optimizationTypewriterRef.current)
      optimizationTypewriterRef.current = null
    }
  }

  const drainOptimizationQueue = () => {
    const queue = optimizationCharQueueRef.current
    if (queue.length === 0) {
      stopOptimizationTypewriter()
      // 큐 소진 + 스트림 종료 → completed
      if (optimizationStreamDoneRef.current) {
        optimizationStreamDoneRef.current = false
        setOptimizationAnswerContent((prev) => unwrapOuterMarkdownFence(prev))
        setIsOptimizationStreaming(false)
      }
      return
    }
    // 적응형 배치: 큐 짧으면 1글자, 길면 많이 (따라잡기)
    const batch = Math.max(1, Math.ceil(queue.length / 8))
    const chars = queue.splice(0, batch).join('')
    setOptimizationAnswerContent((prev) => prev + chars)
  }

  const startOptimizationTypewriter = () => {
    if (optimizationTypewriterRef.current !== null) return
    optimizationTypewriterRef.current = window.setInterval(drainOptimizationQueue, 30)
  }

  const handleRunOptimizationSuggestions = () => {
    if (!optimizationNamespace) return
    setOptimizationCopied(false)
    setIsOptimizationNamespaceDropdownOpen(false)
    optimizationAbortRef.current?.abort()
    const controller = new AbortController()
    optimizationAbortRef.current = controller

    setIsOptimizationStreaming(true)
    setOptimizationObservedContent('')
    setOptimizationAnswerContent('')
    setOptimizationStreamError('')
    setOptimizationUsage(null)
    setOptimizationMeta(null)
    optimizationMetaReceivedRef.current = false
    optimizationUsageReceivedRef.current = false
    optimizationStreamPendingRef.current = ''
    optimizationStreamDoneRef.current = false
    stopOptimizationTypewriter()
    optimizationCharQueueRef.current.length = 0

    void api
      .suggestOptimizationStream(optimizationNamespace, {
        signal: controller.signal,
        onObserved: (content) => {
          // Observed data 표는 한 번에 표시 (타자 효과 적용 X)
          setOptimizationObservedContent((prev) => prev + content)
        },
        onContent: (chunk) => {
          // 타자기 큐에 글자 추가
          for (const ch of chunk) {
            optimizationCharQueueRef.current.push(ch)
          }
          startOptimizationTypewriter()
        },
        onUsage: (usage) => {
          optimizationUsageReceivedRef.current = true
          setOptimizationUsage(usage)
        },
        onMeta: (meta) => {
          optimizationMetaReceivedRef.current = true
          setOptimizationMeta(meta)
        },
        onError: (message) => {
          setOptimizationStreamError(message)
        },
        onDone: () => {
          if (!optimizationMetaReceivedRef.current) {
            setOptimizationStreamError((prev) => prev || tr(
              'dashboard.optimization.missingMeta',
              'Server did not send meta (finish reason). ai-service may not be rebuilt/restarted.',
            ))
          }
          optimizationStreamDoneRef.current = true
          // 큐가 비어있으면 즉시 완료, 아니면 타자기가 소진 후 자동 완료
          if (optimizationCharQueueRef.current.length === 0) {
            drainOptimizationQueue()
          }
          optimizationAbortRef.current = null
        },
      })
      .catch((error) => {
        if ((error as any)?.name === 'AbortError') return
        setOptimizationStreamError(error instanceof Error ? error.message : String(error))
        stopOptimizationTypewriter()
        optimizationCharQueueRef.current.length = 0
        optimizationStreamPendingRef.current = ''
        optimizationStreamDoneRef.current = false
        setIsOptimizationStreaming(false)
        optimizationAbortRef.current = null
      })
  }

  const handleCopyOptimizationSuggestions = async () => {
    const text = `${optimizationObservedContent}${unwrapOuterMarkdownFence(optimizationAnswerContent)}`.trim()
    if (!text) return

    try {
      await navigator.clipboard.writeText(text)
      setOptimizationCopied(true)
      setTimeout(() => setOptimizationCopied(false), 1500)
    } catch (error) {
      console.error('❌ 클립보드 복사 실패:', error)
      setOptimizationCopied(false)
    }
  }

  const handleStopOptimizationSuggestions = () => {
    optimizationAbortRef.current?.abort()
    optimizationAbortRef.current = null
    stopOptimizationTypewriter()
    // 큐에 남은 글자 즉시 반영
    if (optimizationCharQueueRef.current.length > 0) {
      const remaining = optimizationCharQueueRef.current.join('')
      optimizationCharQueueRef.current.length = 0
      setOptimizationAnswerContent((prev) => prev + remaining)
    }
    optimizationStreamPendingRef.current = ''
    optimizationStreamDoneRef.current = false
    setIsOptimizationStreaming(false)
  }

  // 스토리지 네임스페이스 드롭다운 외부 클릭 감지
  useEffect(() => {
    if (!isStorageNamespaceDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (
        storageNamespaceDropdownRef.current &&
        !storageNamespaceDropdownRef.current.contains(event.target as Node)
      ) {
        setIsStorageNamespaceDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isStorageNamespaceDropdownOpen])

  // 최적화 제안 네임스페이스 드롭다운 외부 클릭 감지
  useEffect(() => {
    if (!isOptimizationNamespaceDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (
        optimizationNamespaceDropdownRef.current &&
        !optimizationNamespaceDropdownRef.current.contains(event.target as Node)
      ) {
        setIsOptimizationNamespaceDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOptimizationNamespaceDropdownOpen])

  useEffect(() => {
    if (!isStorageModalOpen) return
    void queryClient.invalidateQueries({ queryKey: ['all-pvcs'], refetchType: 'active' })
    void queryClient.invalidateQueries({ queryKey: ['all-pvs'], refetchType: 'active' })
    void queryClient.invalidateQueries({ queryKey: ['storage-topology'], refetchType: 'active' })
  }, [isStorageModalOpen, queryClient])

  useEffect(() => {
    if (!isOptimizationModalOpen) return
    void queryClient.invalidateQueries({ queryKey: ['all-namespaces'], refetchType: 'active' })
  }, [isOptimizationModalOpen, queryClient])

  useEffect(() => {
    if (!isOptimizationModalOpen) return
    if (!Array.isArray(allNamespaces) || allNamespaces.length === 0) return
    const namespaceNames = allNamespaces.map((ns: any) => String(ns?.name ?? '')).filter(Boolean)
    if (!namespaceNames.includes(optimizationNamespace)) {
      setOptimizationNamespace(namespaceNames.includes('default') ? 'default' : namespaceNames[0])
    }
  }, [isOptimizationModalOpen, allNamespaces, optimizationNamespace])

  const handleNodeClick = (node: any) => {
    openDetail({ kind: 'Node', name: node.name })
  }

  const handlePodStatusClick = (status: string) => {
    setSelectedPodStatus(status)
    setSelectedResourceType('pods')
  }

  const handleNodeStatusClick = (status: string) => {
    setSelectedNodeStatus(status)
    setSelectedResourceType('nodes')
  }

  // ESC 키로 모달 닫기
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isIssuesModalOpen) {
          handleCloseIssuesModal()
        }
        if (isStorageModalOpen) {
          handleCloseStorageModal()
        }
        if (selectedResourceType) {
          setSelectedResourceType(null)
          setSelectedPodStatus(null)
          setSelectedNodeStatus(null)
          setModalSearchQuery('')
        }
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [selectedResourceType, isIssuesModalOpen, isStorageModalOpen])

  // 선택된 리소스 타입에 해당하는 stat 정보 가져오기
  const getSelectedStat = () => {
    return stats.find((s) => s.resourceType === selectedResourceType)
  }

  // 리소스 개수 가져오기
  const getResourceCount = () => {
    if (selectedResourceType === 'namespaces') return Array.isArray(namespaces) ? namespaces.length : 0
    if (selectedResourceType === 'pods') return Array.isArray(allPods) ? allPods.length : 0
    if (selectedResourceType === 'services') return Array.isArray(allServices) ? allServices.length : 0
    if (selectedResourceType === 'deployments') return Array.isArray(allDeployments) ? allDeployments.length : 0
    if (selectedResourceType === 'pvcs') return Array.isArray(allPVCs) ? allPVCs.length : 0
    if (selectedResourceType === 'nodes') return Array.isArray(modalNodes) ? modalNodes.length : 0
    return 0
  }

  // 로딩 상태 확인
  const isLoadingResource = () => {
    if (selectedResourceType === 'namespaces') return isLoadingNamespaces
    if (selectedResourceType === 'pods') return isLoadingPods
    if (selectedResourceType === 'services') return isLoadingAllNamespaces || isLoadingServices
    if (selectedResourceType === 'deployments') return isLoadingAllNamespaces || isLoadingDeployments
    if (selectedResourceType === 'pvcs') return isLoadingPVCs
    if (selectedResourceType === 'nodes') return isLoadingNodes
    return false
  }

  // 검색어로 리소스 필터링
  const getFilteredResources = () => {
    let resources: any[] = []

    // 리소스 타입별 기본 데이터 - 항상 배열 보장
    if (selectedResourceType === 'namespaces') resources = Array.isArray(namespaces) ? namespaces : []
    else if (selectedResourceType === 'pods') resources = Array.isArray(allPods) ? allPods : []
    else if (selectedResourceType === 'services') resources = Array.isArray(allServices) ? allServices : []
    else if (selectedResourceType === 'deployments') resources = Array.isArray(allDeployments) ? allDeployments : []
    else if (selectedResourceType === 'pvcs') resources = Array.isArray(allPVCs) ? allPVCs : []
    else if (selectedResourceType === 'nodes') resources = Array.isArray(modalNodes) ? modalNodes : []

    // Pod 상태 필터링
    if (selectedPodStatus && selectedResourceType === 'pods') {
      resources = resources.filter((pod: any) => pod.phase === selectedPodStatus)
    }

    // Node 상태 필터링
    if (selectedNodeStatus && selectedResourceType === 'nodes') {
      resources = resources.filter((node: any) => node.status === selectedNodeStatus)
    }

    // 검색어 필터링
    if (!modalSearchQuery.trim()) return resources

    const query = modalSearchQuery.toLowerCase()

    if (selectedResourceType === 'namespaces') {
      return resources.filter((ns: any) =>
        ns.name.toLowerCase().includes(query)
      )
    }

    if (selectedResourceType === 'pods') {
      return resources.filter((pod: any) =>
        pod.name.toLowerCase().includes(query) ||
        pod.namespace.toLowerCase().includes(query) ||
        (pod.node_name && pod.node_name.toLowerCase().includes(query))
      )
    }

    if (selectedResourceType === 'services') {
      return resources.filter((svc: any) =>
        svc.name.toLowerCase().includes(query) ||
        svc.namespace.toLowerCase().includes(query) ||
        (svc.type && svc.type.toLowerCase().includes(query)) ||
        (svc.cluster_ip && svc.cluster_ip.toLowerCase().includes(query))
      )
    }

    if (selectedResourceType === 'deployments') {
      return resources.filter((deploy: any) =>
        deploy.name.toLowerCase().includes(query) ||
        deploy.namespace.toLowerCase().includes(query)
      )
    }

    if (selectedResourceType === 'pvcs') {
      return resources.filter(pvc =>
        pvc.name.toLowerCase().includes(query) ||
        pvc.namespace.toLowerCase().includes(query) ||
        (pvc.storage_class && pvc.storage_class.toLowerCase().includes(query))
      )
    }

    if (selectedResourceType === 'nodes') {
      return resources.filter(node =>
        node.name.toLowerCase().includes(query) ||
        (node.version && node.version.toLowerCase().includes(query)) ||
        (node.internal_ip && node.internal_ip.toLowerCase().includes(query)) ||
        (node.roles && node.roles.some((role: string) => role.toLowerCase().includes(query)))
      )
    }

    return []
  }

  const filteredResources = getFilteredResources()

  /* ── skeleton stat definitions (static text + icon, only value pulses) ── */
  const skeletonStats = [
    { label: tr('dashboard.stats.namespaces', 'Namespaces'), icon: Server, color: 'text-blue-400', bg: 'bg-blue-500/10' },
    { label: tr('dashboard.stats.pods', 'Pods'), icon: Box, color: 'text-green-400', bg: 'bg-green-500/10' },
    { label: tr('dashboard.stats.services', 'Services'), icon: Database, color: 'text-purple-400', bg: 'bg-purple-500/10' },
    { label: tr('dashboard.stats.deployments', 'Deployments'), icon: TrendingUp, color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
    { label: tr('dashboard.stats.pvcs', 'PVCs'), icon: HardDrive, color: 'text-pink-400', bg: 'bg-pink-500/10' },
    { label: tr('dashboard.stats.nodes', 'Nodes'), icon: Server, color: 'text-cyan-400', bg: 'bg-cyan-500/10' },
  ]

  if (isLoading) {
    return (
      <div className="space-y-8">
        {/* Header — identical to real, version line is a pulse placeholder */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-white">{tr('dashboard.title', 'Cluster Dashboard')}</h1>
            <p className="mt-2 text-slate-400">
              {tr('dashboard.subtitle', 'Get a quick overview of your Kubernetes cluster.')}
            </p>
            <p className="mt-1 text-sm text-slate-500">
              {tr('dashboard.clusterVersion', 'Cluster version: {{version}}', { version: '' })}
              <span className="inline-block h-3.5 w-20 align-middle ml-0.5 rounded bg-slate-700/60 animate-pulse" />
            </p>
          </div>
          <button disabled className="btn btn-secondary flex items-center gap-2 opacity-50 cursor-not-allowed">
            <RefreshCw className="w-4 h-4" />
            {tr('dashboard.refresh', 'Refresh')}
          </button>
        </div>

        {/* Stats grid — exact same card markup, value replaced with pulse */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {skeletonStats.map((s) => (
            <div key={s.label} className="card">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-400">{s.label}</p>
                  {/* same as: <p className="mt-2 text-3xl font-bold text-white">12</p> */}
                  <p className="mt-2 text-3xl font-bold leading-none">
                    <span className="inline-block h-[1em] w-[1.6em] rounded bg-slate-700 animate-pulse align-baseline" />
                  </p>
                </div>
                <div className={`p-3 rounded-lg ${s.bg}`}>
                  <s.icon className={`w-6 h-6 ${s.color}`} />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Charts — 3D skeleton */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {[
            { title: tr('dashboard.podStatus.title', 'Pod status'), sub: tr('dashboard.podStatus.subtitle', 'Click to view pods in each status'), accent: '#38bdf8' },
            { title: tr('dashboard.nodeStatus.title', 'Node status'), sub: tr('dashboard.nodeStatus.subtitle', 'Click to view nodes in each status'), accent: '#22d3ee' },
          ].map((chart, ci) => {
            const skelBars = ci === 0 ? [50, 85, 12, 40, 6] : [75, 20]
            const dx = 16, dy = -8
            return (
              <div key={chart.title} className="card relative overflow-hidden">
                <h2 className="text-xl font-bold text-white mb-4">{chart.title}</h2>
                <p className="text-sm text-slate-400 mb-4">{chart.sub}</p>
                <svg width="100%" height={300} viewBox="0 0 540 300" preserveAspectRatio="xMidYMid meet">
                  <defs>
                    <linearGradient id={`skel-g-${ci}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={chart.accent} stopOpacity={0.12} />
                      <stop offset="100%" stopColor={chart.accent} stopOpacity={0.04} />
                    </linearGradient>
                  </defs>
                  {/* floor */}
                  <polygon points={`48,260 490,260 ${490 + dx},${260 + dy} ${48 + dx},${260 + dy}`}
                    fill={chart.accent} opacity={0.04} />
                  <line x1={48} y1={260} x2={490} y2={260}
                    stroke={chart.accent} strokeWidth={1} opacity={0.12} />
                  {/* left wall */}
                  <polygon points={`48,260 ${48 + dx},${260 + dy} ${48 + dx},${30 + dy} 48,30`}
                    fill={chart.accent} opacity={0.03} />
                  <line x1={48} y1={30} x2={48} y2={260}
                    stroke={chart.accent} strokeWidth={0.5} opacity={0.08} />
                  {/* bars */}
                  {skelBars.map((pct, j) => {
                    const groupW = 442 / skelBars.length
                    const bw = groupW * 0.48
                    const bx = 48 + j * groupW + (groupW - bw) / 2
                    const barH = (pct / 100) * 230
                    const by = 260 - barH
                    return (
                      <g key={j} className="animate-pulse" style={{ animationDelay: `${j * 0.15}s` }}>
                        <rect x={bx} y={by} width={bw} height={barH}
                          fill={`url(#skel-g-${ci})`} />
                        <polygon
                          points={`${bx + bw},${by} ${bx + bw + dx},${by + dy} ${bx + bw + dx},${260 + dy} ${bx + bw},${260}`}
                          fill={chart.accent} opacity={0.05} />
                        <polygon
                          points={`${bx},${by} ${bx + dx},${by + dy} ${bx + bw + dx},${by + dy} ${bx + bw},${by}`}
                          fill={chart.accent} opacity={0.08} />
                      </g>
                    )
                  })}
                </svg>
              </div>
            )
          })}
        </div>

        {/* Top resources — exact same card headers */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-white">
                {tr('dashboard.topPods.title', 'Top 5 pods by resource usage')}
              </h2>
              <p className="text-xs text-slate-400">{tr('dashboard.autoRefresh', 'Auto refresh every 5 seconds')}</p>
            </div>
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="p-4 bg-slate-700 rounded-lg">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary-500/20">
                      <span className="text-primary-400 font-bold text-sm">#{i + 1}</span>
                    </div>
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="h-4 bg-slate-600/50 rounded w-3/4 animate-pulse" />
                      <div className="h-3.5 bg-slate-600/30 rounded w-1/2 animate-pulse" />
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-6 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">{tr('dashboard.cpu', 'CPU')}:</span>
                      <span className="inline-block h-3.5 w-12 rounded bg-slate-600/40 animate-pulse" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">{tr('dashboard.memory', 'Memory')}:</span>
                      <span className="inline-block h-3.5 w-14 rounded bg-slate-600/40 animate-pulse" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-white">
                {tr('dashboard.topNodes.title', 'Top 3 nodes by resource usage')}
              </h2>
              <p className="text-xs text-slate-400">{tr('dashboard.autoRefresh', 'Auto refresh every 5 seconds')}</p>
            </div>
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cyan-500/20">
                      <span className="text-cyan-400 font-bold text-sm">#{i + 1}</span>
                    </div>
                    <div className="flex-1">
                      <div className="h-4 bg-slate-600/50 rounded w-1/2 animate-pulse mb-1.5" />
                      <div className="flex items-center gap-4 text-sm text-slate-400">
                        <span>{tr('dashboard.cpu', 'CPU')}: <span className="inline-block h-3 w-12 align-middle rounded bg-slate-600/40 animate-pulse" /></span>
                        <span>{tr('dashboard.memory', 'Memory')}: <span className="inline-block h-3 w-14 align-middle rounded bg-slate-600/40 animate-pulse" /></span>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1 pl-11">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">{tr('dashboard.cpu', 'CPU')}</span>
                      <span className="inline-block h-3 w-10 rounded bg-slate-600/30 animate-pulse" />
                    </div>
                    <div className="w-full h-2.5 bg-slate-700 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-slate-600/30 animate-pulse w-1/2" />
                    </div>
                  </div>
                  <div className="space-y-1 pl-11">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">{tr('dashboard.memory', 'Memory')}</span>
                      <span className="inline-block h-3 w-10 rounded bg-slate-600/30 animate-pulse" />
                    </div>
                    <div className="w-full h-2.5 bg-slate-700 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-slate-600/30 animate-pulse w-1/3" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Nodes — real title, card shape matches real layout */}
        <div className="card">
          <h2 className="text-xl font-bold text-white mb-4">{tr('dashboard.nodes.title', 'Nodes')}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[400px] overflow-y-auto">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="p-3 bg-slate-700 rounded-lg">
                <div className="flex items-start gap-2 mb-2">
                  <div className="w-4 h-4 rounded-full bg-slate-600/50 mt-0.5 animate-pulse" />
                  <div className="flex-1 min-w-0">
                    <div className="h-4 bg-slate-600/50 rounded w-2/3 animate-pulse" />
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-slate-400">
                    <span className="font-medium">{tr('dashboard.nodeCard.versionLabel', 'Version')}:</span>{' '}
                    <span className="inline-block h-3 w-16 align-middle rounded bg-slate-600/30 animate-pulse" />
                  </p>
                  <p className="text-xs text-slate-400">
                    <span className="font-medium">{tr('dashboard.nodeCard.rolesLabel', 'Roles')}:</span>{' '}
                    <span className="inline-block h-3 w-20 align-middle rounded bg-slate-600/30 animate-pulse" />
                  </p>
                  <p className="text-xs text-slate-400">
                    <span className="font-medium">{tr('dashboard.nodeCard.ipLabel', 'IP')}:</span>{' '}
                    <span className="inline-block h-3 w-24 align-middle rounded bg-slate-600/30 animate-pulse" />
                  </p>
                </div>
                <div className="mt-2">
                  <span className="inline-block h-5 w-14 rounded bg-slate-600/30 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Quick actions — real text & icons, just disabled */}
        <div className="card">
          <h2 className="text-xl font-bold text-white mb-4">{tr('dashboard.quickActions.title', 'Quick actions')}</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="btn btn-secondary text-left opacity-50 pointer-events-none">
              <div className="flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-yellow-400" />
                <div>
                  <div className="font-medium">{tr('dashboard.quickActions.issues.title', 'Check issues')}</div>
                  <div className="text-xs text-slate-400">{tr('dashboard.quickActions.issues.subtitle', 'Find resources with problems')}</div>
                </div>
              </div>
            </div>
            <div className="btn btn-secondary text-left opacity-50 pointer-events-none">
              <div className="flex items-center gap-3">
                <TrendingUp className="w-5 h-5 text-green-400" />
                <div>
                  <div className="font-medium">{tr('dashboard.quickActions.optimization.title', 'Optimization suggestions')}</div>
                  <div className="text-xs text-slate-400">{tr('dashboard.quickActions.optimization.subtitle', 'AI-powered resource optimization')}</div>
                </div>
              </div>
            </div>
            <div className="btn btn-secondary text-left opacity-50 pointer-events-none">
              <div className="flex items-center gap-3">
                <Database className="w-5 h-5 text-blue-400" />
                <div>
                  <div className="font-medium">{tr('dashboard.quickActions.storage.title', 'Storage analysis')}</div>
                  <div className="text-xs text-slate-400">{tr('dashboard.quickActions.storage.subtitle', 'PV/PVC usage status')}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Pod/Node 상태는 Kubernetes 스펙상 가능한 값이 제한적이므로
  // 차트에서 항상 전체 상태를 보여주기 위해 고정 목록 사용
  const POD_PHASES = ['Running', 'Succeeded', 'Failed', 'Pending', 'Unknown']
  const NODE_STATUSES = ['Ready', 'NotReady']

  const stats = [
    {
      name: tr('dashboard.stats.namespaces', 'Namespaces'),
      resourceType: 'namespaces' as ResourceType,
      value: overview?.total_namespaces || 0,
      icon: Server,
      color: 'text-blue-400',
      bgColor: 'bg-blue-500/10',
    },
    {
      name: tr('dashboard.stats.pods', 'Pods'),
      resourceType: 'pods' as ResourceType,
      value: overview?.total_pods || 0,
      icon: Box,
      color: 'text-green-400',
      bgColor: 'bg-green-500/10',
    },
    {
      name: tr('dashboard.stats.services', 'Services'),
      resourceType: 'services' as ResourceType,
      value: overview?.total_services || 0,
      icon: Database,
      color: 'text-purple-400',
      bgColor: 'bg-purple-500/10',
    },
    {
      name: tr('dashboard.stats.deployments', 'Deployments'),
      resourceType: 'deployments' as ResourceType,
      value: overview?.total_deployments || 0,
      icon: TrendingUp,
      color: 'text-yellow-400',
      bgColor: 'bg-yellow-500/10',
    },
    {
      name: tr('dashboard.stats.pvcs', 'PVCs'),
      resourceType: 'pvcs' as ResourceType,
      value: overview?.total_pvcs || 0,
      icon: HardDrive,
      color: 'text-pink-400',
      bgColor: 'bg-pink-500/10',
    },
    {
      name: tr('dashboard.stats.nodes', 'Nodes'),
      resourceType: 'nodes' as ResourceType,
      value: overview?.node_count || 0,
      icon: Server,
      color: 'text-cyan-400',
      bgColor: 'bg-cyan-500/10',
    },
  ]

  // Pod 상태 차트 데이터
  const podStatusData = overview
    ? POD_PHASES.map((phase) => ({
      name: phase,
      value: overview?.pod_status?.[phase] ?? 0,
    }))
    : []

  // 노드 상태 차트 데이터
  const nodeStatusData = nodes && Array.isArray(nodes)
    ? nodes.reduce((acc: Record<string, number>, node) => {
      const status = node.status || 'Unknown'
      acc[status] = (acc[status] || 0) + 1
      return acc
    }, {} as Record<string, number>)
    : {}

  const nodeStatusChartData = nodes && Array.isArray(nodes)
    ? NODE_STATUSES.map((status) => ({
      name: status,
      value: nodeStatusData[status] ?? 0,
    }))
    : []

  type IssueSeverity = 'critical' | 'warning' | 'info'
  type IssueKind = 'Pod' | 'Node' | 'Deployment' | 'PVC' | 'Metrics'
  type IssueItem = {
    id: string
    kind: IssueKind
    severity: IssueSeverity
    title: string
    subtitle?: string
    namespace?: string
    name?: string
  }

  const parseReady = (ready: unknown): { ready: number; total: number } | null => {
    if (typeof ready !== 'string') return null
    const match = ready.match(/^(\d+)\/(\d+)$/)
    if (!match) return null
    const readyCount = Number(match[1])
    const totalCount = Number(match[2])
    if (!Number.isFinite(readyCount) || !Number.isFinite(totalCount)) return null
    return { ready: readyCount, total: totalCount }
  }

  const formatAge = (ms: number) => {
    const seconds = Math.max(0, Math.floor(ms / 1000))
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)
    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    return `${seconds}s ago`
  }

  const allPodsArray = Array.isArray(allPods) ? allPods : []
  const allNodesArray = Array.isArray(nodes) ? nodes : []
  const allPVCsArray = Array.isArray(allPVCs) ? allPVCs : []
  const allDeploymentsArray = Array.isArray(allDeployments) ? allDeployments : []

  const issuesFromPods: IssueItem[] = allPodsArray.flatMap((pod: any) => {
    const phase = String(pod?.phase ?? pod?.status ?? '')
    const ready = parseReady(pod?.ready)
    const isRunningNotReady = phase === 'Running' && ready != null && ready.ready < ready.total
    const restartCount = Number(pod?.restart_count ?? 0)

    const reasons: string[] = []
    let severity: IssueSeverity | null = null

    const containers = Array.isArray(pod?.containers) ? pod.containers : []
    const criticalWaitingReasons = new Set([
      'CrashLoopBackOff',
      'ImagePullBackOff',
      'ErrImagePull',
      'CreateContainerConfigError',
      'CreateContainerError',
      'RunContainerError',
    ])

    const waitingReasons: string[] = []
    const terminatedReasons: string[] = []
    let hasCriticalWaitingReason = false
    let hasCriticalTerminatedState = false

    let latestTerminationMs: number | null = null
    let latestTerminationReason: string | null = null

    for (const container of containers) {
      const waitingReason = container?.state?.waiting?.reason
      if (waitingReason) {
        const wr = String(waitingReason)
        waitingReasons.push(wr)
        if (criticalWaitingReasons.has(wr)) hasCriticalWaitingReason = true
      }

      const terminatedReason = container?.state?.terminated?.reason
      if (terminatedReason) {
        terminatedReasons.push(String(terminatedReason))
        hasCriticalTerminatedState = true
      }

      const lastTerminated = container?.last_state?.terminated
      const finishedAt = lastTerminated?.finished_at
      const ms = typeof finishedAt === 'string' ? Date.parse(finishedAt) : NaN
      if (Number.isFinite(ms)) {
        if (latestTerminationMs == null || ms > latestTerminationMs) {
          latestTerminationMs = ms
          latestTerminationReason = lastTerminated?.reason ? String(lastTerminated.reason) : null
        }
      }
    }

    const uniqueReasons = (items: string[]) => Array.from(new Set(items)).slice(0, 3)
    const waitingReasonsUnique = uniqueReasons(waitingReasons)
    const terminatedReasonsUnique = uniqueReasons(terminatedReasons)

    // 1) 현재 진행 중인 상태(reason/state)는 "지금 문제"이므로 우선순위를 높게 둔다.
    if (waitingReasonsUnique.length > 0) {
      reasons.push(`Reason: ${waitingReasonsUnique.join(', ')}${waitingReasons.length > 3 ? '…' : ''}`)
      severity = hasCriticalWaitingReason ? 'critical' : 'warning'
    }
    if (terminatedReasonsUnique.length > 0) {
      reasons.push(`Reason: ${terminatedReasonsUnique.join(', ')}${terminatedReasons.length > 3 ? '…' : ''}`)
      severity = 'critical'
    }

    // 2) Pod phase 기반 판정
    if (['Pending', 'Failed', 'Unknown'].includes(phase)) {
      severity = 'critical'
      reasons.push(`Phase: ${phase}`)
    } else if (isRunningNotReady) {
      if (severity == null) severity = 'warning'
      reasons.push(`Ready: ${pod.ready}`)
    }

    // 3) "과거" 재시작은 기본적으로 숨기되, 옵션/최근 재시작은 표시한다.
    const nowMs = Date.now()
    const restartAgeMs = latestTerminationMs == null ? null : nowMs - latestTerminationMs
    const hasAnyCurrentIssue = hasCriticalWaitingReason || hasCriticalTerminatedState || ['Pending', 'Failed', 'Unknown'].includes(phase) || isRunningNotReady

    const hasRestartEvidence = Number.isFinite(restartCount) && restartCount > 0
    const hasRestartTimestamp =
      restartAgeMs != null &&
      Number.isFinite(restartAgeMs) &&
      restartAgeMs >= 0

    const isRecentRestart =
      hasRestartTimestamp && (restartAgeMs as number) <= 24 * 60 * 60 * 1000

    const shouldSurfaceRestartHistory =
      hasRestartEvidence &&
      phase === 'Running' &&
      !hasAnyCurrentIssue &&
      (includeRestartHistory || isRecentRestart)

    if (shouldSurfaceRestartHistory) {
      if (isRecentRestart) {
        // 최근 재시작은 warning/info로 표시
        if (restartAgeMs != null && restartAgeMs <= 60 * 60 * 1000) severity = 'warning'
        else severity = 'info'
      } else {
        severity = 'info'
      }
      if (latestTerminationReason) reasons.push(`Reason: ${latestTerminationReason}`)
      if (hasRestartTimestamp && restartAgeMs != null) reasons.push(`Last restart: ${formatAge(restartAgeMs)}`)
      reasons.push(`Restarts: ${restartCount}`)
    } else if (hasRestartEvidence && (hasAnyCurrentIssue || hasCriticalWaitingReason || hasCriticalTerminatedState)) {
      // 현재 문제가 있는 경우엔 재시작 횟수는 항상 함께 보여준다.
      reasons.push(`Restarts: ${restartCount}`)
    }

    // 4) 최종 필터: 아무 이유가 없으면 제외
    if (severity == null || reasons.length === 0) return []

    const namespace = String(pod?.namespace ?? '')
    const name = String(pod?.name ?? '')
    return [
      {
        id: `pod:${namespace}:${name}`,
        kind: 'Pod',
        severity,
        title: name,
        subtitle: reasons.join(' · '),
        namespace,
        name,
      },
    ]
  })

  const issuesFromNodes: IssueItem[] = allNodesArray.flatMap((node: any) => {
    const status = String(node?.status ?? '')
    if (!status || status === 'Ready') return []

    const name = String(node?.name ?? '')
    return [
      {
        id: `node:${name}`,
        kind: 'Node',
        severity: 'critical',
        title: name,
        subtitle: `Status: ${status}`,
        name,
      },
    ]
  })

  const issuesFromPVCs: IssueItem[] = allPVCsArray.flatMap((pvc: any) => {
    const status = String(pvc?.status ?? '')
    if (!status || status === 'Bound') return []

    const namespace = String(pvc?.namespace ?? '')
    const name = String(pvc?.name ?? '')
    const severity: IssueSeverity = ['Lost', 'Pending'].includes(status) ? 'critical' : 'warning'

    return [
      {
        id: `pvc:${namespace}:${name}`,
        kind: 'PVC',
        severity,
        title: name,
        subtitle: `Status: ${status}`,
        namespace,
        name,
      },
    ]
  })

  const issuesFromDeployments: IssueItem[] = allDeploymentsArray.flatMap((deploy: any) => {
    const replicas = Number(deploy?.replicas ?? 0)
    const readyReplicas = Number(deploy?.ready_replicas ?? 0)
    const availableReplicas = Number(deploy?.available_replicas ?? 0)

    if (!Number.isFinite(replicas) || replicas <= 0) return []
    if (readyReplicas >= replicas && availableReplicas >= replicas) return []

    const namespace = String(deploy?.namespace ?? '')
    const name = String(deploy?.name ?? '')

    const severity: IssueSeverity = readyReplicas === 0 ? 'critical' : 'warning'
    const subtitle = `Ready: ${readyReplicas}/${replicas} · Available: ${availableReplicas}/${replicas}`

    return [
      {
        id: `deploy:${namespace}:${name}`,
        kind: 'Deployment',
        severity,
        title: name,
        subtitle,
        namespace,
        name,
      },
    ]
  })

  const issuesFromMetrics: IssueItem[] = (() => {
    const items: IssueItem[] = []
    if (topResources?.pod_error) {
      items.push({
        id: 'metrics:pod_error',
        kind: 'Metrics',
        severity: 'info',
        title: tr('dashboard.issues.metricsPodTitle', 'Pod metrics collection failed'),
        subtitle: tr('dashboard.metricsServerHint', 'Check metrics-server status'),
      })
    }
    if (topResources?.node_error) {
      items.push({
        id: 'metrics:node_error',
        kind: 'Metrics',
        severity: 'info',
        title: tr('dashboard.issues.metricsNodeTitle', 'Node metrics collection failed'),
        subtitle: tr('dashboard.metricsServerHint', 'Check metrics-server status'),
      })
    }
    return items
  })()

  const allIssues: IssueItem[] = [
    ...issuesFromNodes,
    ...issuesFromDeployments,
    ...issuesFromPVCs,
    ...issuesFromPods,
    ...issuesFromMetrics,
  ]

  const severityRank: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 }
  const kindRank: Record<IssueKind, number> = { Node: 0, Deployment: 1, PVC: 2, Pod: 3, Metrics: 4 }

  const normalizedIssuesQuery = issuesSearchQuery.trim().toLowerCase()
  const filteredIssues = normalizedIssuesQuery
    ? allIssues.filter((issue) => {
      const haystack = [
        issue.kind,
        issue.severity,
        issue.namespace,
        issue.name,
        issue.title,
        issue.subtitle,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(normalizedIssuesQuery)
    })
    : allIssues

  const sortedIssues = [...filteredIssues].sort((a, b) => {
    const bySeverity = severityRank[a.severity] - severityRank[b.severity]
    if (bySeverity !== 0) return bySeverity
    const byKind = kindRank[a.kind] - kindRank[b.kind]
    if (byKind !== 0) return byKind
    return a.id.localeCompare(b.id)
  })

  const issuesByKind = sortedIssues.reduce<Record<IssueKind, IssueItem[]>>((acc, issue) => {
    acc[issue.kind] = acc[issue.kind] ?? []
    acc[issue.kind].push(issue)
    return acc
  }, {} as Record<IssueKind, IssueItem[]>)

  const issuesSummary = sortedIssues.reduce(
    (acc, issue) => {
      acc.total += 1
      acc[issue.severity] += 1
      return acc
    },
    { total: 0, critical: 0, warning: 0, info: 0 } as { total: number; critical: number; warning: number; info: number }
  )

  const issueKindLabels: Record<IssueKind, string> = {
    Node: tr('dashboard.issues.kind.node', 'Node'),
    Deployment: tr('dashboard.issues.kind.deployment', 'Deployment'),
    PVC: tr('dashboard.issues.kind.pvc', 'PVC'),
    Pod: tr('dashboard.issues.kind.pod', 'Pod'),
    Metrics: tr('dashboard.issues.kind.metrics', 'Metrics'),
  }

  const issueSeverityLabels: Record<IssueSeverity, string> = {
    critical: tr('dashboard.issues.severity.critical', 'CRITICAL'),
    warning: tr('dashboard.issues.severity.warning', 'WARNING'),
    info: tr('dashboard.issues.severity.info', 'INFO'),
  }

  const isIssuesLoading =
    isIssuesModalOpen &&
    (isLoadingPods || isLoadingPVCs || isLoadingAllNamespaces || isLoadingDeployments)

  const allPVsArray = Array.isArray(allPVs) ? allPVs : []

  const normalizedStorageQuery = storageSearchQuery.trim().toLowerCase()
  const storageNamespaces = (() => {
    const fromApi = Array.isArray(allNamespaces) ? allNamespaces.map((ns: any) => String(ns?.name ?? '')).filter(Boolean) : []
    const fromPVCs = allPVCsArray.map((pvc: any) => String(pvc?.namespace ?? '')).filter(Boolean)
    return Array.from(new Set([...fromApi, ...fromPVCs])).sort()
  })()

  const filteredPVCsForStorage = allPVCsArray
    .filter((pvc: any) => (storageNamespaceFilter === 'all' ? true : String(pvc?.namespace ?? '') === storageNamespaceFilter))
    .filter((pvc: any) => {
      if (!normalizedStorageQuery) return true
      const haystack = [
        pvc?.name,
        pvc?.namespace,
        pvc?.status,
        pvc?.storage_class,
        pvc?.volume_name,
        pvc?.capacity,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(normalizedStorageQuery)
    })

  const filteredPVsForStorage = allPVsArray
    .filter((pv: any) => {
      if (storageNamespaceFilter === 'all') return true
      const claimNs = pv?.claim_ref?.namespace
      return claimNs && String(claimNs) === storageNamespaceFilter
    })
    .filter((pv: any) => {
      if (!normalizedStorageQuery) return true
      const haystack = [
        pv?.name,
        pv?.status,
        pv?.capacity,
        pv?.storage_class,
        pv?.reclaim_policy,
        pv?.claim_ref?.namespace,
        pv?.claim_ref?.name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(normalizedStorageQuery)
    })

  const pvcStatusCounts = filteredPVCsForStorage.reduce<Record<string, number>>((acc, pvc: any) => {
    const status = String(pvc?.status ?? 'Unknown')
    acc[status] = (acc[status] || 0) + 1
    return acc
  }, {})

  const pvStatusCounts = filteredPVsForStorage.reduce<Record<string, number>>((acc, pv: any) => {
    const status = String(pv?.status ?? 'Unknown')
    acc[status] = (acc[status] || 0) + 1
    return acc
  }, {})

  const pvcStatusRank: Record<string, number> = { Pending: 0, Lost: 1, Bound: 2 }
  const pvStatusRank: Record<string, number> = { Failed: 0, Released: 1, Available: 2, Bound: 3 }

  const sortedPVCsForStorage = [...filteredPVCsForStorage].sort((a: any, b: any) => {
    const ar = pvcStatusRank[String(a?.status ?? '')] ?? 99
    const br = pvcStatusRank[String(b?.status ?? '')] ?? 99
    if (ar !== br) return ar - br
    const an = `${a?.namespace ?? ''}/${a?.name ?? ''}`
    const bn = `${b?.namespace ?? ''}/${b?.name ?? ''}`
    return an.localeCompare(bn)
  })

  const sortedPVsForStorage = [...filteredPVsForStorage].sort((a: any, b: any) => {
    const ar = pvStatusRank[String(a?.status ?? '')] ?? 99
    const br = pvStatusRank[String(b?.status ?? '')] ?? 99
    if (ar !== br) return ar - br
    const an = String(a?.name ?? '')
    const bn = String(b?.name ?? '')
    return an.localeCompare(bn)
  })

  const isStorageLoading =
    isStorageModalOpen &&
    (isLoadingPVCs || isLoadingPVs || (storageActiveTab === 'topology' && isLoadingStorageTopology))

  const optimizationNamespaces = Array.isArray(allNamespaces)
    ? allNamespaces.map((ns: any) => String(ns?.name ?? '')).filter(Boolean).sort()
    : []

  const optimizationObservedMarkdown = optimizationObservedContent
    .replace(/\n\n---\n\n## 최적화 제안 \(AI\)\n\n\s*$/m, '')
    .trim()
  const optimizationAnswerMarkdown = unwrapOuterMarkdownFence(optimizationAnswerContent).trim()
  const optimizationAnswerMarkdownForStreaming = makeStreamingMarkdownRenderFriendly(optimizationAnswerMarkdown)
  const optimizationMarkdown = `${optimizationObservedContent}${unwrapOuterMarkdownFence(optimizationAnswerContent)}`.trim()
  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('dashboard.title', 'Cluster Dashboard')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('dashboard.subtitle', 'Get a quick overview of your Kubernetes cluster.')}
          </p>
          {overview?.cluster_version && (
            <p className="mt-1 text-sm text-slate-500">
              {tr('dashboard.clusterVersion', 'Cluster version: {{version}}', { version: overview.cluster_version })}
            </p>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          title={tr('dashboard.refreshTitle', 'Force refresh')}
          className="btn btn-secondary flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          {tr('dashboard.refresh', 'Refresh')}
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map((stat) => {
          const resourceType = stat.resourceType

          return (
            <button
              key={stat.name}
              onClick={() => handleStatClick(resourceType)}
              className="card hover:border-primary-500 transition-colors text-left cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-400">{stat.name}</p>
                  <p className="mt-2 text-3xl font-bold text-white">{stat.value}</p>
                </div>
                <div className={`p-3 rounded-lg ${stat.bgColor}`}>
                  <stat.icon className={`w-6 h-6 ${stat.color}`} />
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Pod Status Chart */}
        {podStatusData.length > 0 && (
          <div className="card relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-sky-500/5 via-transparent to-blue-500/5 pointer-events-none" />
            <h2 className="text-xl font-bold text-white mb-4 relative">{tr('dashboard.podStatus.title', 'Pod status')}</h2>
            <p className="text-sm text-slate-400 mb-4 relative">
              {tr('dashboard.podStatus.subtitle', 'Click to view pods in each status')}
            </p>
            <Iso3DChart
              data={podStatusData}
              uid="pod"
              colors={{
                front: ['#38bdf8', '#0369a1'],
                side: '#0c4a6e',
                top: '#7dd3fc',
                accent: '#38bdf8',
              }}
              onBarClick={handlePodStatusClick}
            />
          </div>
        )}

        {/* Node Status Chart */}
        {nodeStatusChartData.length > 0 && (
          <div className="card relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/5 via-transparent to-teal-500/5 pointer-events-none" />
            <h2 className="text-xl font-bold text-white mb-4 relative">{tr('dashboard.nodeStatus.title', 'Node status')}</h2>
            <p className="text-sm text-slate-400 mb-4 relative">
              {tr('dashboard.nodeStatus.subtitle', 'Click to view nodes in each status')}
            </p>
            <Iso3DChart
              data={nodeStatusChartData}
              uid="node"
              colors={{
                front: ['#22d3ee', '#0e7490'],
                side: '#164e63',
                top: '#a5f3fc',
                accent: '#22d3ee',
              }}
              onBarClick={handleNodeStatusClick}
            />
          </div>
        )}
      </div>

      {/* Top 리소스 사용 Pod/Node */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Top 파드 */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">
              {tr('dashboard.topPods.title', 'Top 5 pods by resource usage')}
            </h2>
            <p className="text-xs text-slate-400">{tr('dashboard.autoRefresh', 'Auto refresh every 5 seconds')}</p>
          </div>
          {isLoadingTopResources && !topResources ? (
            // 초기 로딩: 스켈레톤 표시
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="p-4 bg-slate-700 rounded-lg animate-pulse">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-full bg-slate-600" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-slate-600 rounded w-3/4" />
                      <div className="h-3 bg-slate-600 rounded w-1/2" />
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-6 mt-2">
                    <div className="h-3 bg-slate-600 rounded w-16" />
                    <div className="h-3 bg-slate-600 rounded w-20" />
                  </div>
                </div>
              ))}
            </div>
          ) : metricsUnavailable ? (
            <div className="text-center py-12">
              <div className="flex flex-col items-center gap-2">
                <AlertCircle className="w-8 h-8 text-slate-400" />
                <p className="text-slate-400">{tr('dashboard.metrics.unavailable', 'Metrics server not available for this cluster')}</p>
              </div>
            </div>
          ) : isTopResourcesError && !topResources?.top_pods ? (
            // 에러 상태: 이전 데이터가 없을 때만 에러 표시
            <div className="text-center py-12">
              <div className="flex flex-col items-center gap-2">
                <AlertCircle className="w-8 h-8 text-red-400" />
                <p className="text-slate-400">{tr('dashboard.topResources.error', 'Failed to fetch data')}</p>
              </div>
            </div>
          ) : topResources?.top_pods && topResources.top_pods.length > 0 ? (
            // 데이터가 있을 때: 데이터 표시 (백그라운드 갱신 중에도 이전 데이터 유지)
            <div className="space-y-3">
              {topResources.top_pods.map((pod, index) => (
                <div key={`${pod.namespace}-${pod.name}`} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary-500/20">
                      <span className="text-primary-400 font-bold text-sm">#{index + 1}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-medium text-white truncate" title={pod.name}>
                        {pod.name}
                      </h3>
                      <p className="text-sm text-slate-400">{pod.namespace}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-6 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">{tr('dashboard.cpu', 'CPU')}:</span>
                      <span className="text-green-400 font-mono font-medium">{pod.cpu}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">{tr('dashboard.memory', 'Memory')}:</span>
                      <span className="text-blue-400 font-mono font-medium">{pod.memory}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : topResources?.pod_error ? (
            // 메트릭 수집 실패 (Node 메트릭은 있을 수 있음)
            <div className="text-center py-12">
              <div className="flex flex-col items-center gap-2">
                <AlertCircle className="w-8 h-8 text-yellow-400" />
                <p className="text-slate-400">{tr('dashboard.topPods.metricsError', 'Failed to fetch pod metrics')}</p>
                <p className="text-xs text-slate-500">{tr('dashboard.metricsServerHint', 'Check metrics-server status')}</p>
              </div>
            </div>
          ) : (
            // 데이터가 없을 때
            <div className="text-center py-12">
              <p className="text-slate-400">{tr('dashboard.topResources.empty', 'No resource usage data')}</p>
            </div>
          )}
        </div>

        {/* Top Node */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">
              {tr('dashboard.topNodes.title', 'Top 3 nodes by resource usage')}
            </h2>
            <p className="text-xs text-slate-400">{tr('dashboard.autoRefresh', 'Auto refresh every 5 seconds')}</p>
          </div>
          {isLoadingTopResources && !topResources ? (
            // 초기 로딩: 스켈레톤 표시
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="space-y-3 p-3 bg-slate-700 rounded-lg animate-pulse">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-slate-600" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-slate-600 rounded w-1/2" />
                      <div className="h-3 bg-slate-600 rounded w-1/3" />
                    </div>
                  </div>
                  <div className="space-y-2 pl-11">
                    <div className="flex items-center justify-between text-xs">
                      <div className="h-3 bg-slate-600 rounded w-10" />
                      <div className="h-3 bg-slate-600 rounded w-12" />
                    </div>
                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-slate-600 w-1/2" />
                    </div>
                  </div>
                  <div className="space-y-2 pl-11">
                    <div className="flex items-center justify-between text-xs">
                      <div className="h-3 bg-slate-600 rounded w-12" />
                      <div className="h-3 bg-slate-600 rounded w-10" />
                    </div>
                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-slate-600 w-1/3" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : metricsUnavailable ? (
            <div className="text-center py-12">
              <div className="flex flex-col items-center gap-2">
                <AlertCircle className="w-8 h-8 text-slate-400" />
                <p className="text-slate-400">{tr('dashboard.metrics.unavailable', 'Metrics server not available for this cluster')}</p>
              </div>
            </div>
          ) : isTopResourcesError && !topResources?.top_nodes ? (
            // 에러 상태: 이전 데이터가 없을 때만 에러 표시
            <div className="text-center py-12">
              <div className="flex flex-col items-center gap-2">
                <AlertCircle className="w-8 h-8 text-red-400" />
                <p className="text-slate-400">{tr('dashboard.topResources.error', 'Failed to fetch data')}</p>
              </div>
            </div>
          ) : topResources?.top_nodes && topResources.top_nodes.length > 0 ? (
            // 데이터가 있을 때: 데이터 표시 (백그라운드 갱신 중에도 이전 데이터 유지)
            <div className="space-y-4">
              {topResources.top_nodes.map((node, index) => {
                const cpuPercent = parseFloat(node.cpu_percent)
                const memoryPercent = parseFloat(node.memory_percent)

                return (
                  <div key={node.name} className="space-y-3">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-cyan-500/20">
                        <span className="text-cyan-400 font-bold text-sm">#{index + 1}</span>
                      </div>
                      <div className="flex-1">
                        <h3 className="font-medium text-white">{node.name}</h3>
                        <div className="flex items-center gap-4 text-sm text-slate-400 mt-1">
                          <span>{tr('dashboard.cpu', 'CPU')}: {node.cpu}</span>
                          <span>{tr('dashboard.memory', 'Memory')}: {node.memory}</span>
                        </div>
                      </div>
                    </div>

                    {/* CPU 사용량 막대 */}
                    <div className="space-y-1 pl-11">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-400">{tr('dashboard.cpu', 'CPU')}</span>
                        <span className={`font-medium ${cpuPercent >= 80 ? 'text-red-400' :
                            cpuPercent >= 60 ? 'text-yellow-400' :
                              'text-green-400'
                          }`}>
                          {node.cpu_percent}
                        </span>
                      </div>
                      <div className="w-full h-2.5 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-[width] duration-700 ease-out ${cpuPercent >= 80
                              ? 'bg-red-500'
                              : cpuPercent >= 60
                                ? 'bg-amber-500'
                                : 'bg-emerald-500'
                            }`}
                          style={{ width: `${Math.min(cpuPercent, 100)}%` }}
                        />
                      </div>
                    </div>

                    {/* Memory 사용량 막대 */}
                    <div className="space-y-1 pl-11">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-400">{tr('dashboard.memory', 'Memory')}</span>
                        <span className={`font-medium ${memoryPercent >= 80 ? 'text-red-400' :
                            memoryPercent >= 60 ? 'text-yellow-400' :
                              'text-blue-400'
                          }`}>
                          {node.memory_percent}
                        </span>
                      </div>
                      <div className="w-full h-2.5 bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-[width] duration-700 ease-out ${memoryPercent >= 80
                              ? 'bg-red-500'
                              : memoryPercent >= 60
                                ? 'bg-amber-500'
                                : 'bg-blue-500'
                            }`}
                          style={{ width: `${Math.min(memoryPercent, 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : topResources?.node_error ? (
            // 메트릭 수집 실패 (파드 메트릭은 있을 수 있음)
            <div className="text-center py-12">
              <div className="flex flex-col items-center gap-2">
                <AlertCircle className="w-8 h-8 text-yellow-400" />
                <p className="text-slate-400">{tr('dashboard.topNodes.metricsError', 'Failed to fetch node metrics')}</p>
                <p className="text-xs text-slate-500">{tr('dashboard.metricsServerHint', 'Check metrics-server status')}</p>
              </div>
            </div>
          ) : (
            // 데이터가 없을 때
            <div className="text-center py-12">
              <p className="text-slate-400">{tr('dashboard.topResources.empty', 'No resource usage data')}</p>
            </div>
          )}
        </div>
      </div>

      {/* Node 상세 정보 - 별도 카드 */}
      {nodes && Array.isArray(nodes) && nodes.length > 0 && (
        <div className="card">
          <h2 className="text-xl font-bold text-white mb-4">{tr('dashboard.nodes.title', 'Nodes')}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-h-[400px] overflow-y-auto">
            {nodes.map((node) => (
              <button
                key={node.name}
                onClick={() => handleNodeClick(node)}
                className="p-3 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors text-left cursor-pointer"
              >
                <div className="flex items-start gap-2 mb-2">
                  {node.status === 'Ready' ? (
                    <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate" title={node.name}>
                      {node.name}
                    </p>
                  </div>
                  <Info className="w-4 h-4 text-slate-400 flex-shrink-0" />
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-slate-400">
                    <span className="font-medium">{tr('dashboard.nodeCard.versionLabel', 'Version')}:</span> {node.version || na}
                  </p>
                  {node.roles && node.roles.length > 0 && (
                    <p className="text-xs text-slate-400">
                      <span className="font-medium">{tr('dashboard.nodeCard.rolesLabel', 'Roles')}:</span> {node.roles.join(', ')}
                    </p>
                  )}
                  {node.internal_ip && (
                    <p className="text-xs text-slate-400">
                      <span className="font-medium">{tr('dashboard.nodeCard.ipLabel', 'IP')}:</span> {node.internal_ip}
                    </p>
                  )}
                </div>
                <div className="mt-2">
                  <span className={`badge text-xs ${node.status === 'Ready' ? 'badge-success' : 'badge-error'
                    }`}>
                    {node.status}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="card">
        <h2 className="text-xl font-bold text-white mb-4">{tr('dashboard.quickActions.title', 'Quick actions')}</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <button className="btn btn-secondary text-left" onClick={handleOpenIssuesModal}>
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-yellow-400" />
              <div>
                <div className="font-medium">{tr('dashboard.quickActions.issues.title', 'Check issues')}</div>
                <div className="text-xs text-slate-400">
                  {tr('dashboard.quickActions.issues.subtitle', 'Find resources with problems')}
                </div>
              </div>
            </div>
          </button>
          <button className="btn btn-secondary text-left" onClick={handleOpenOptimizationModal}>
            <div className="flex items-center gap-3">
              <TrendingUp className="w-5 h-5 text-green-400" />
              <div>
                <div className="font-medium">{tr('dashboard.quickActions.optimization.title', 'Optimization suggestions')}</div>
                <div className="text-xs text-slate-400">
                  {tr('dashboard.quickActions.optimization.subtitle', 'AI-powered resource optimization')}
                </div>
              </div>
            </div>
          </button>
          <button className="btn btn-secondary text-left" onClick={handleOpenStorageModal}>
            <div className="flex items-center gap-3">
              <Database className="w-5 h-5 text-blue-400" />
              <div>
                <div className="font-medium">{tr('dashboard.quickActions.storage.title', 'Storage analysis')}</div>
                <div className="text-xs text-slate-400">
                  {tr('dashboard.quickActions.storage.subtitle', 'PV/PVC usage status')}
                </div>
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* 최적화 제안 모달 */}
      {isOptimizationModalOpen && (
        <ModalOverlay onClose={handleCloseOptimizationModal}>
            <div
              className="bg-slate-800 rounded-lg max-w-[98vw] w-full h-[85vh] overflow-hidden flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-4 border-b border-slate-700">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-lg font-bold text-white">
                      {tr('dashboard.optimization.title', 'Optimization suggestions')}
                    </h2>
                    <p className="text-xs text-slate-400">
                      {tr(
                        'dashboard.optimization.subtitle',
                        'AI suggests optimizations based on Deployment/Pod data in the selected namespace.',
                      )}
                    </p>
                  </div>
                <button
                  onClick={handleCloseOptimizationModal}
                  className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="relative" ref={optimizationNamespaceDropdownRef}>
                    <button
                      onClick={() => setIsOptimizationNamespaceDropdownOpen(!isOptimizationNamespaceDropdownOpen)}
                      className="h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 min-w-[240px] justify-between disabled:opacity-60 disabled:cursor-not-allowed"
                      title={tr('dashboard.optimization.selectNamespaceTitle', 'Select namespace')}
                      disabled={isLoadingAllNamespaces}
                    >
                      <span className="text-xs font-medium truncate">
                        {optimizationNamespace || (isLoadingAllNamespaces
                          ? tr('dashboard.loading', 'Loading...')
                          : tr('dashboard.optimization.selectNamespace', 'Select namespace'))}
                      </span>
                      <ChevronDown
                        className={`w-4 h-4 text-slate-400 transition-transform ${isOptimizationNamespaceDropdownOpen ? 'rotate-180' : ''}`}
                      />
                    </button>

                    {isOptimizationNamespaceDropdownOpen && (
                      <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50 max-h-[340px] overflow-y-auto">
                        {optimizationNamespaces.length === 0 ? (
                          <div className="px-4 py-3 text-sm text-slate-200">
                            {tr('dashboard.optimization.noNamespaces', 'No namespaces to display')}
                          </div>
                        ) : (
                          optimizationNamespaces.map((ns) => (
                            <button
                              key={ns}
                              onClick={() => {
                                setOptimizationNamespace(ns)
                                setIsOptimizationNamespaceDropdownOpen(false)
                              }}
                              className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg last:rounded-b-lg"
                            >
                              {optimizationNamespace === ns && (
                                <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                              )}
                              <span className={optimizationNamespace === ns ? 'font-medium' : ''}>{ns}</span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                    <div className="flex items-center gap-2 text-xs">
                      <button
                        onClick={handleRunOptimizationSuggestions}
                        disabled={!optimizationNamespace || isOptimizationStreaming}
                        className="h-9 px-3 rounded-lg text-xs font-medium transition-colors bg-primary-600 hover:bg-primary-500 text-white disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed flex items-center gap-2"
                        title={tr('dashboard.optimization.runTitle', 'Generate AI suggestion')}
                      >
                      {isOptimizationStreaming && (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      )}
                      {isOptimizationStreaming
                        ? tr('dashboard.optimization.running', 'Generating...')
                        : tr('dashboard.optimization.run', 'Generate')}
                    </button>

                  {isOptimizationStreaming && (
                    <button
                      onClick={handleStopOptimizationSuggestions}
                      className="h-10 px-4 rounded-lg text-sm font-medium transition-colors bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center gap-2"
                      title={tr('dashboard.optimization.stopTitle', 'Stop')}
                    >
                      <StopCircle className="w-4 h-4" />
                      {tr('dashboard.optimization.stop', 'Stop')}
                    </button>
                  )}

                    <button
                      onClick={handleCopyOptimizationSuggestions}
                      disabled={!optimizationMarkdown}
                      className="h-9 px-3 rounded-lg text-xs font-medium transition-colors bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                      title={tr('dashboard.optimization.copyTitle', 'Copy result')}
                    >
                    <Copy className="w-4 h-4" />
                    {optimizationCopied
                      ? tr('dashboard.optimization.copied', 'Copied')
                      : tr('dashboard.optimization.copy', 'Copy')}
                  </button>
                </div>
              </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="badge badge-info">
                    {tr('dashboard.optimization.namespaceBadge', 'Namespace {{namespace}}', {
                      namespace: optimizationNamespace || na,
                    })}
                  </span>
                {!!optimizationUsage && (
                  <span className="badge badge-info">
                    {tr('dashboard.optimization.tokensBadge', 'Tokens {{used}}{{max}}', {
                      used: optimizationUsage.completion_tokens,
                      max: optimizationMeta?.max_tokens ? `/${optimizationMeta.max_tokens}` : '',
                    })}
                  </span>
                )}
                {!!optimizationMeta?.finish_reason && optimizationMeta.finish_reason !== 'stop' && (
                  <span className={`text-xs ${optimizationMeta.finish_reason === 'length' ? 'text-yellow-300' : 'text-yellow-200'}`}>
                    {tr(
                      'dashboard.optimization.finishReason',
                      'The response did not end with stop and may be truncated ({{reason}})',
                      { reason: optimizationMeta.finish_reason },
                    )}
                  </span>
                )}
                {!!optimizationStreamError && (
                  <span className="text-xs text-red-300 break-words">
                    {tr('dashboard.optimization.streamError', 'Stream error')}: {optimizationStreamError}
                  </span>
                )}
                  <span className="text-[11px] text-slate-500">
                    {tr('dashboard.optimization.modelLatency', 'Model calls can take up to ~1 minute')}
                  </span>
                </div>
              </div>
  
              <div className="flex-1 overflow-y-auto p-4">
              {isOptimizationStreaming && !optimizationMarkdown ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[240px]">
                  <RefreshCw className="w-7 h-7 text-primary-400 animate-spin mb-3" />
                  <p className="text-slate-400">
                    {tr('dashboard.optimization.generating', 'Generating optimization suggestions...')}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    {tr('dashboard.optimization.waiting', 'Waiting for OpenAI response')}
                  </p>
                </div>
              ) : optimizationStreamError && !optimizationMarkdown ? (
                <div className="rounded-lg border border-slate-700 bg-slate-900/20 p-4">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-100">
                        {tr('dashboard.optimization.failed', 'Failed to generate suggestions')}
                      </p>
                      <p className="text-xs text-slate-400 mt-1 break-words">{optimizationStreamError}</p>
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          onClick={handleRunOptimizationSuggestions}
                          className="px-3 py-2 rounded-lg text-sm font-medium transition-colors bg-slate-700 hover:bg-slate-600 text-slate-200"
                        >
                          {tr('dashboard.optimization.retry', 'Retry')}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : !optimizationMarkdown ? (
                <div className="text-center py-12">
                  <p className="text-slate-400">
                    {tr('dashboard.optimization.selectPrompt', 'Select a namespace then click “Generate”.')}
                  </p>
                  <p className="text-xs text-slate-500 mt-1">
                    {tr(
                      'dashboard.optimization.promptNote',
                      '(The API summarizes Deployment/Pod lists and asks AI for optimization ideas.)',
                    )}
                  </p>
                </div>
                ) : (
                    <div className="space-y-3 text-xs">
                      {!!optimizationObservedMarkdown && (
                        <details className="rounded-lg border border-slate-700 bg-slate-900/20 p-3">
                          <summary className="cursor-pointer select-none text-xs font-medium text-slate-200">
                            {tr('dashboard.optimization.observedData', 'Observed data (table)')}
                          </summary>
                          <div className="mt-2 prose prose-invert prose-sm max-w-none leading-snug overflow-x-auto [&_table]:min-w-full [&_table]:w-max [&_table]:text-xs [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_pre]:text-xs">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{optimizationObservedMarkdown}</ReactMarkdown>
                          </div>
                        </details>
                      )}
  
                      <div className="rounded-lg border border-slate-700 bg-slate-900/20 p-3">
                        {isOptimizationStreaming ? (
                          <div className="prose prose-invert prose-sm max-w-none leading-snug overflow-x-auto [&_table]:min-w-full [&_table]:w-max [&_table]:text-xs [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_pre]:text-xs">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{optimizationAnswerMarkdownForStreaming}</ReactMarkdown>
                            {!optimizationAnswerContent && (
                              <p className="text-[11px] text-slate-500">
                                {tr('dashboard.optimization.writing', 'AI is drafting suggestions…')}
                              </p>
                            )}
                          </div>
                        ) : (
                          <div className="prose prose-invert prose-sm max-w-none leading-snug overflow-x-auto [&_table]:min-w-full [&_table]:w-max [&_table]:text-xs [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_pre]:text-xs">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{optimizationAnswerMarkdown}</ReactMarkdown>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* 이슈 확인 모달 */}
      {isIssuesModalOpen && (
        <ModalOverlay onClose={handleCloseIssuesModal}>
          <div
            className="bg-slate-800 rounded-lg max-w-4xl w-full h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-slate-700">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-xl font-bold text-white">{tr('dashboard.issues.title', 'Issues')}</h2>
                  <p className="text-sm text-slate-400">
                    {tr(
                      'dashboard.issues.subtitle',
                      'Aggregates problematic resources based on Pod/Node/Deployment/PVC status.',
                    )}
                  </p>
                </div>
                <button
                  onClick={handleCloseIssuesModal}
                  className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 mb-4">
                <span className="text-xs text-slate-400">{tr('dashboard.issues.totalLabel', 'Total')}</span>
                <span className="badge badge-info">{tr('dashboard.issues.totalCount', '{{count}}', { count: issuesSummary.total })}</span>
                <span className="badge badge-error">{tr('dashboard.issues.criticalLabel', 'Critical')} {issuesSummary.critical}</span>
                <span className="badge badge-warning">{tr('dashboard.issues.warningLabel', 'Warning')} {issuesSummary.warning}</span>
                <span className="badge badge-info">{tr('dashboard.issues.infoLabel', 'Info')} {issuesSummary.info}</span>
              </div>

              <label className="flex items-center justify-between gap-3 mb-4 p-3 rounded-lg border border-slate-700 bg-slate-900/20">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-200">
                    {tr('dashboard.issues.includeRestarts', 'Include restart history')}
                  </p>
                  <p className="text-xs text-slate-400 truncate">
                    {tr(
                      'dashboard.issues.includeRestartsHint',
                      'Include past restarts for currently healthy (Running/Ready) pods as Info.',
                    )}
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={includeRestartHistory}
                  onChange={(e) => setIncludeRestartHistory(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-700 text-primary-500 focus:ring-primary-500"
                />
              </label>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  placeholder={tr('dashboard.issues.searchPlaceholder', 'Search issues (name/namespace/message)...')}
                  value={issuesSearchQuery}
                  onChange={(e) => setIssuesSearchQuery(e.target.value)}
                  className="w-full h-10 pl-10 pr-10 bg-slate-700 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors"
                />
                {issuesSearchQuery && (
                  <button
                    onClick={() => setIssuesSearchQuery('')}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 hover:bg-slate-600 rounded transition-colors"
                  >
                    <X className="w-4 h-4 text-slate-400" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {isIssuesLoading ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[240px]">
                  <RefreshCw className="w-7 h-7 text-primary-400 animate-spin mb-3" />
                  <p className="text-slate-400">{tr('dashboard.issues.loading', 'Collecting issues...')}</p>
                </div>
              ) : sortedIssues.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[240px]">
                  <CheckCircle className="w-9 h-9 text-green-400 mb-3" />
                  <p className="text-slate-300 font-medium">{tr('dashboard.issues.none', 'No issues detected')}</p>
                  <p className="text-sm text-slate-400 mt-1">
                    {tr('dashboard.issues.noneHint', 'Check your filters/search terms')}
                  </p>
                </div>
              ) : (
                <div className="space-y-6">
                  {(['Node', 'Deployment', 'PVC', 'Pod', 'Metrics'] as IssueKind[]).map((kind) => {
                    const items = issuesByKind[kind] ?? []
                    if (items.length === 0) return null
                    return (
                      <div key={kind} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <h3 className="text-sm font-semibold text-slate-200">{issueKindLabels[kind] || kind}</h3>
                          <span className="text-xs text-slate-400">
                            {tr('dashboard.issues.count', '{{count}}', { count: items.length })}
                          </span>
                        </div>
                        <div className="divide-y divide-slate-700 rounded-lg border border-slate-700 overflow-hidden">
                          {items.map((issue) => (
                            <div key={issue.id} className="p-3 bg-slate-900/20">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span
                                      className={`badge ${issue.severity === 'critical'
                                          ? 'badge-error'
                                          : issue.severity === 'warning'
                                            ? 'badge-warning'
                                            : 'badge-info'
                                        }`}
                                    >
                                      {issueSeverityLabels[issue.severity] || issue.severity.toUpperCase()}
                                    </span>
                                    <p className="text-sm font-medium text-white truncate">
                                      {issue.title}
                                    </p>
                                  </div>
                                  <div className="mt-1 space-y-0.5">
                                    {issue.namespace && (
                                      <p className="text-xs text-slate-400">
                                        <span className="font-medium">{tr('dashboard.labels.namespaceShort', 'ns:')}</span> {issue.namespace}
                                      </p>
                                    )}
                                    {issue.subtitle && (
                                      <p className="text-xs text-slate-400">{issue.subtitle}</p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* 스토리지 분석 모달 */}
      {isStorageModalOpen && (
        <ModalOverlay onClose={handleCloseStorageModal}>
          <div
            className="bg-slate-800 rounded-lg max-w-5xl w-full h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-slate-700">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-xl font-bold text-white">
                    {tr('dashboard.storage.title', 'Storage analysis')}
                  </h2>
                  <p className="text-sm text-slate-400">
                    {tr('dashboard.storage.subtitle', 'Review PV/PVC status and binding state')}
                  </p>
                </div>
                <button
                  onClick={handleCloseStorageModal}
                  className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 mb-4">
                <span className="badge badge-info">
                  {tr('dashboard.storage.pvcCount', 'PVC {{count}}', { count: sortedPVCsForStorage.length })}
                </span>
                <span className="badge badge-info">
                  {tr('dashboard.storage.pvCount', 'PV {{count}}', { count: sortedPVsForStorage.length })}
                </span>
                {Object.entries(pvcStatusCounts).slice(0, 4).map(([status, count]) => (
                  <span
                    key={`pvc-${status}`}
                    className={`badge ${status === 'Bound' ? 'badge-success' : status === 'Pending' ? 'badge-warning' : status === 'Lost' ? 'badge-error' : 'badge-info'}`}
                    title={tr('dashboard.storage.pvcStatusTitle', 'PVC Status')}
                  >
                    {tr('dashboard.storage.pvcStatusCount', 'PVC {{status}} {{count}}', { status, count })}
                  </span>
                ))}
                {Object.entries(pvStatusCounts).slice(0, 4).map(([status, count]) => (
                  <span
                    key={`pv-${status}`}
                    className={`badge ${status === 'Bound' ? 'badge-success' : status === 'Available' ? 'badge-info' : status === 'Released' ? 'badge-warning' : status === 'Failed' ? 'badge-error' : 'badge-info'}`}
                    title={tr('dashboard.storage.pvStatusTitle', 'PV Status')}
                  >
                    {tr('dashboard.storage.pvStatusCount', 'PV {{status}} {{count}}', { status, count })}
                  </span>
                ))}
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setStorageActiveTab('pvcs')}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${storageActiveTab === 'pvcs' ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
                  >
                    {tr('dashboard.storage.tabs.pvcs', 'PVC')}
                  </button>
                  <button
                    onClick={() => setStorageActiveTab('pvs')}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${storageActiveTab === 'pvs' ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
                  >
                    {tr('dashboard.storage.tabs.pvs', 'PV')}
                  </button>
                  <button
                    onClick={() => setStorageActiveTab('topology')}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${storageActiveTab === 'topology' ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
                  >
                    {tr('dashboard.storage.tabs.topology', 'Topology')}
                  </button>
                </div>

                <div className="relative" ref={storageNamespaceDropdownRef}>
                  <button
                    onClick={() => setIsStorageNamespaceDropdownOpen(!isStorageNamespaceDropdownOpen)}
                    className="h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 min-w-[200px] justify-between"
                    title={tr('dashboard.storage.namespaceFilter', 'Namespace filter')}
                  >
                    <span className="text-sm font-medium">
                      {storageNamespaceFilter === 'all'
                        ? tr('dashboard.storage.allNamespaces', 'All namespaces')
                        : storageNamespaceFilter}
                    </span>
                    <ChevronDown
                      className={`w-4 h-4 text-slate-400 transition-transform ${isStorageNamespaceDropdownOpen ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {isStorageNamespaceDropdownOpen && (
                    <div className="absolute top-full right-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50 max-h-[340px] overflow-y-auto">
                      <button
                        onClick={() => {
                          setStorageNamespaceFilter('all')
                          setIsStorageNamespaceDropdownOpen(false)
                        }}
                        className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
                      >
                        {storageNamespaceFilter === 'all' && (
                          <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                        )}
                        <span className={storageNamespaceFilter === 'all' ? 'font-medium' : ''}>
                          {tr('dashboard.storage.allNamespaces', 'All namespaces')}
                        </span>
                      </button>
                      {storageNamespaces.map((ns) => (
                        <button
                          key={ns}
                          onClick={() => {
                            setStorageNamespaceFilter(ns)
                            setIsStorageNamespaceDropdownOpen(false)
                          }}
                          className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg"
                        >
                          {storageNamespaceFilter === ns && (
                            <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                          )}
                          <span className={storageNamespaceFilter === ns ? 'font-medium' : ''}>{ns}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="relative mt-3">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  placeholder={tr('dashboard.storage.searchPlaceholder', 'Search (name/status/StorageClass/Claim)...')}
                  value={storageSearchQuery}
                  onChange={(e) => setStorageSearchQuery(e.target.value)}
                  className="w-full h-10 pl-10 pr-10 bg-slate-700 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors"
                />
                {storageSearchQuery && (
                  <button
                    onClick={() => setStorageSearchQuery('')}
                    className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 hover:bg-slate-600 rounded transition-colors"
                  >
                    <X className="w-4 h-4 text-slate-400" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {isStorageLoading ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[240px]">
                  <RefreshCw className="w-7 h-7 text-primary-400 animate-spin mb-3" />
                  <p className="text-slate-400">
                    {tr('dashboard.storage.loading', 'Loading storage data...')}
                  </p>
                </div>
              ) : storageActiveTab === 'pvcs' ? (
                sortedPVCsForStorage.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-slate-400">{tr('dashboard.storage.noPVC', 'No PVCs to display')}</p>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-700 rounded-lg border border-slate-700 overflow-hidden">
                    {sortedPVCsForStorage.map((pvc: any) => {
                      const status = String(pvc?.status ?? 'Unknown')
                      const badge =
                        status === 'Bound'
                          ? 'badge-success'
                          : status === 'Pending'
                            ? 'badge-warning'
                            : status === 'Lost'
                              ? 'badge-error'
                              : 'badge-info'

                      return (
                        <div key={`${pvc.namespace}/${pvc.name}`} className="p-3 bg-slate-900/20">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`badge ${badge}`}>{status}</span>
                                <p className="text-sm font-medium text-white truncate">{pvc.name}</p>
                              </div>
                              <div className="mt-1 space-y-0.5">
                                <p className="text-xs text-slate-400">
                                  <span className="font-medium">{tr('dashboard.labels.namespaceShort', 'ns:')}</span> {pvc.namespace}
                                </p>
                                <p className="text-xs text-slate-400">
                                  {pvc.capacity || na} · {pvc.storage_class || na} · {tr('dashboard.storage.pvLabel', 'PV')}: {pvc.volume_name || na}
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              ) : storageActiveTab === 'pvs' ? (
                sortedPVsForStorage.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-slate-400">{tr('dashboard.storage.noPV', 'No PVs to display')}</p>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-700 rounded-lg border border-slate-700 overflow-hidden">
                    {sortedPVsForStorage.map((pv: any) => {
                      const status = String(pv?.status ?? 'Unknown')
                      const badge =
                        status === 'Bound'
                          ? 'badge-success'
                          : status === 'Available'
                            ? 'badge-info'
                            : status === 'Released'
                              ? 'badge-warning'
                              : status === 'Failed'
                                ? 'badge-error'
                                : 'badge-info'

                      const claimNs = pv?.claim_ref?.namespace ? String(pv.claim_ref.namespace) : ''
                      const claimName = pv?.claim_ref?.name ? String(pv.claim_ref.name) : ''
                      const claim = claimNs && claimName ? `${claimNs}/${claimName}` : '—'

                      return (
                        <div key={pv.name} className="p-3 bg-slate-900/20">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`badge ${badge}`}>{status}</span>
                                <p className="text-sm font-medium text-white truncate">{pv.name}</p>
                              </div>
                              <div className="mt-1 space-y-0.5">
                                <p className="text-xs text-slate-400">
                                  {pv.capacity || na} · {pv.storage_class || na} · {tr('dashboard.storage.reclaimLabel', 'Reclaim')}: {pv.reclaim_policy || na}
                                </p>
                                <p className="text-xs text-slate-400">
                                  <span className="font-medium">{tr('dashboard.storage.claimLabel', 'Claim')}:</span> {claim}
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              ) : (
                <div className="space-y-4">
                  {storageTopology ? (
                    <div className="space-y-3">
                      <div className="p-4 rounded-lg border border-slate-700 bg-slate-900/20">
                        <p className="text-sm text-slate-200 font-medium">
                          {tr('dashboard.storage.topologyTitle', 'Storage Topology')}
                        </p>
                        <p className="text-xs text-slate-400 mt-1">
                          {tr('dashboard.storage.topologySummary', 'Nodes: {{nodes}} · Edges: {{edges}}', {
                            nodes: storageTopology.nodes?.length ?? 0,
                            edges: storageTopology.edges?.length ?? 0,
                          })}
                        </p>
                      </div>
                      {Array.isArray(storageTopology.edges) && storageTopology.edges.length > 0 ? (
                        <div className="divide-y divide-slate-700 rounded-lg border border-slate-700 overflow-hidden">
                          {storageTopology.edges.slice(0, 50).map((edge: any) => (
                            <div key={edge.id} className="p-3 bg-slate-900/20">
                              <p className="text-xs text-slate-300">
                                {edge.source} → {edge.target}
                                {edge.label ? ` · ${edge.label}` : ''}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {tr('dashboard.storage.noTopologyEdges', 'No topology edges to display')}
                          </p>
                        </div>
                      )}
                      {Array.isArray(storageTopology.edges) && storageTopology.edges.length > 50 && (
                        <p className="text-xs text-slate-500">
                          {tr('dashboard.storage.topologyLimit', 'Showing up to 50 edges')}
                        </p>
                      )}
                    </div>
                  ) : isLoadingStorageTopology ? (
                    <div className="flex flex-col items-center justify-center h-full min-h-[240px]">
                      <RefreshCw className="w-7 h-7 text-primary-400 animate-spin mb-3" />
                      <p className="text-slate-400">{tr('dashboard.storage.topologyLoading', 'Loading topology...')}</p>
                    </div>
                  ) : isStorageTopologyError ? (
                    <div className="text-center py-12">
                      <p className="text-slate-400">{tr('dashboard.storage.topologyError', 'Failed to load topology')}</p>
                      <p className="text-xs text-slate-500 mt-2">
                        {(storageTopologyError as any)?.message || tr('dashboard.unknownError', 'Unknown error')}
                      </p>
                    </div>
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400">
                        {tr('dashboard.storage.topologyUnavailable', 'Topology data is unavailable')}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* 리소스 상세 모달 */}
      {selectedResourceType && (
        <ModalOverlay onClose={handleCloseModal}>
          <div
            className="bg-slate-800 rounded-lg max-w-4xl w-full h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 모달 헤더 */}
            {(() => {
              const selectedStat = getSelectedStat()
              const Icon = selectedStat?.icon || Box
              return (
                <div className="p-6 border-b border-slate-700">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                      {selectedStat && (
                        <div className={`p-2 rounded-lg ${selectedStat.bgColor || 'bg-slate-700'}`}>
                          <Icon className={`w-5 h-5 ${selectedStat.color || 'text-white'}`} />
                        </div>
                      )}
                      <div>
                        <h2 className="text-xl font-bold text-white">
                          {selectedStat?.name || selectedResourceType}
                        </h2>
                        <p className="text-sm text-slate-400">
                          {isLoadingResource()
                            ? tr('dashboard.resourceModal.loading', 'Loading...')
                            : tr('dashboard.resourceModal.total', 'Total {{count}}', { count: getResourceCount() })}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={handleCloseModal}
                      className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                    >
                      <X className="w-5 h-5 text-slate-400" />
                    </button>
                  </div>
                  {/* 검색창 - 헤더 내부 */}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      placeholder={tr('dashboard.resourceModal.searchPlaceholder', 'Search...')}
                      value={modalSearchQuery}
                      onChange={(e) => setModalSearchQuery(e.target.value)}
                      className="w-full h-10 pl-10 pr-10 bg-slate-700 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors"
                    />
                    {modalSearchQuery && (
                      <button
                        onClick={() => setModalSearchQuery('')}
                        className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 hover:bg-slate-600 rounded transition-colors"
                      >
                        <X className="w-4 h-4 text-slate-400" />
                      </button>
                    )}
                  </div>
                </div>
              )
            })()}

            {/* 모달 내용 */}
            <div className="flex-1 overflow-y-auto p-6">
              {isLoadingResource() ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[300px]">
                  <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
                  <p className="text-slate-400">{tr('dashboard.loading', 'Loading data...')}</p>
                </div>
              ) : (
                <>
                  {selectedResourceType === 'namespaces' && (
                    <div className="space-y-2">
                      {filteredResources.length > 0 ? (
                        filteredResources.map((ns) => (
                          <div key={ns.name} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                            <div className="flex items-center justify-between">
                              <div>
                                <h3 className="font-medium text-white">{ns.name}</h3>
                                <p className="text-sm text-slate-400 mt-1">
                                  {tr('dashboard.resourceModal.namespaceSummary', 'Pods: {{pods}} | Services: {{services}} | Deployments: {{deployments}}', {
                                    pods: ns.resource_count?.pods || 0,
                                    services: ns.resource_count?.services || 0,
                                    deployments: ns.resource_count?.deployments || 0,
                                  })}
                                </p>
                              </div>
                              <span className={`badge ${ns.status === 'Active' ? 'badge-success' : 'badge-warning'
                                }`}>
                                {ns.status}
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {modalSearchQuery
                              ? tr('dashboard.resourceModal.noSearchResults', 'No results found')
                              : tr('dashboard.resourceModal.noNamespaces', 'No namespaces')}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {selectedResourceType === 'pods' && (
                    <div className="space-y-2">
                      {filteredResources.length > 0 ? (
                        filteredResources.map((pod) => (
                          <div key={`${pod.namespace}-${pod.name}`} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                {pod.phase === 'Running' ? (
                                  <CheckCircle className="w-5 h-5 text-green-400" />
                                ) : (
                                  <XCircle className="w-5 h-5 text-red-400" />
                                )}
                                <div>
                                  <h3 className="font-medium text-white">{pod.name}</h3>
                                  <p className="text-sm text-slate-400">{pod.namespace}</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`badge ${pod.phase === 'Running' ? 'badge-success' : 'badge-warning'
                                  }`}>
                                  {pod.phase}
                                </span>
                                {pod.node_name && (
                                  <span className="text-xs text-slate-400">{pod.node_name}</span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {modalSearchQuery
                              ? tr('dashboard.resourceModal.noSearchResults', 'No results found')
                              : tr('dashboard.resourceModal.noPods', 'No pods')}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {selectedResourceType === 'services' && (
                    <div className="space-y-2">
                      {filteredResources.length > 0 ? (
                        filteredResources.map((svc) => (
                          <div key={`${svc.namespace}-${svc.name}`} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                            <div className="flex items-center justify-between">
                              <div>
                                <h3 className="font-medium text-white">{svc.name}</h3>
                                <p className="text-sm text-slate-400 mt-1">
                                  {svc.namespace} | {tr('dashboard.resourceModal.typeLabel', 'Type')}: {svc.type} | {tr('dashboard.resourceModal.clusterIpLabel', 'Cluster IP')}: {svc.cluster_ip || none}
                                </p>
                              </div>
                              <span className="badge badge-info">{svc.type}</span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {modalSearchQuery
                              ? tr('dashboard.resourceModal.noSearchResults', 'No results found')
                              : tr('dashboard.resourceModal.noServices', 'No services')}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {selectedResourceType === 'deployments' && (
                    <div className="space-y-2">
                      {filteredResources.length > 0 ? (
                        filteredResources.map((deploy) => (
                          <div key={`${deploy.namespace}-${deploy.name}`} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                            <div className="flex items-center justify-between">
                              <div>
                                <h3 className="font-medium text-white">{deploy.name}</h3>
                                <p className="text-sm text-slate-400 mt-1">
                                  {deploy.namespace} | {tr('dashboard.resourceModal.replicasLabel', 'Replicas')}: {deploy.ready_replicas}/{deploy.replicas}
                                </p>
                              </div>
                              <span className={`badge ${deploy.ready_replicas === deploy.replicas ? 'badge-success' : 'badge-warning'
                                }`}>
                                {deploy.status}
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {modalSearchQuery
                              ? tr('dashboard.resourceModal.noSearchResults', 'No results found')
                              : tr('dashboard.resourceModal.noDeployments', 'No deployments')}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {selectedResourceType === 'pvcs' && (
                    <div className="space-y-2">
                      {filteredResources.length > 0 ? (
                        filteredResources.map((pvc) => (
                          <div key={`${pvc.namespace}-${pvc.name}`} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                            <div className="flex items-center justify-between">
                              <div>
                                <h3 className="font-medium text-white">{pvc.name}</h3>
                                <p className="text-sm text-slate-400 mt-1">
                                  {pvc.namespace} | {pvc.capacity || na} | {pvc.storage_class || na}
                                </p>
                              </div>
                              <span className={`badge ${pvc.status === 'Bound' ? 'badge-success' : 'badge-warning'
                                }`}>
                                {pvc.status}
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {modalSearchQuery
                              ? tr('dashboard.resourceModal.noSearchResults', 'No results found')
                              : tr('dashboard.resourceModal.noPVCs', 'No PVCs')}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {selectedResourceType === 'nodes' && (
                    <div className="space-y-2">
                      {filteredResources.length > 0 ? (
                        filteredResources.map((node) => (
                          <div key={node.name} className="p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors">
                            <div className="flex items-center justify-between">
                              <div>
                                <h3 className="font-medium text-white">{node.name}</h3>
                                <p className="text-sm text-slate-400 mt-1">
                                  {tr('dashboard.resourceModal.versionLabel', 'Version')}: {node.version || na} |
                                  {tr('dashboard.resourceModal.internalIpLabel', 'Internal IP')}: {node.internal_ip || na}
                                  {node.roles && node.roles.length > 0 && ` | ${tr('dashboard.resourceModal.rolesLabel', 'Roles')}: ${node.roles.join(', ')}`}
                                </p>
                              </div>
                              <span className={`badge ${node.status === 'Ready' ? 'badge-success' : 'badge-error'
                                }`}>
                                {node.status}
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {modalSearchQuery
                              ? tr('dashboard.resourceModal.noSearchResults', 'No results found')
                              : tr('dashboard.resourceModal.noNodes', 'No nodes')}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}

    </div>
  )
}
