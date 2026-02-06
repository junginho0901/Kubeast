import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, TopResources } from '@/services/api'
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
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useState, useEffect, useRef } from 'react'
import { ModalOverlay } from '@/components/ModalOverlay'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type ResourceType = 'namespaces' | 'pods' | 'services' | 'deployments' | 'pvcs' | 'nodes'

export default function Dashboard() {
  const queryClient = useQueryClient()
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
  const [selectedNode, setSelectedNode] = useState<any | null>(null)

  const { data: overview, isLoading } = useQuery({
    queryKey: ['cluster-overview'],
    queryFn: () => api.getClusterOverview(false), // 자동 갱신은 캐시 사용
    staleTime: 30000,
    refetchInterval: 60000,
  })

  // 네임스페이스 목록
  const { data: namespaces, isLoading: isLoadingNamespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(false), // 자동 갱신은 캐시 사용
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
    queryFn: () => api.getNamespaces(false), // 자동 갱신은 캐시 사용
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
    isError: isTopResourcesError
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
    staleTime: 5000, // 5초간 fresh 상태 유지
    refetchInterval: 5000, // 5초마다 백그라운드 갱신
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
    retry: 1, // 실패 시 1번만 재시도
    retryDelay: 1000, // 1초 대기 후 재시도
    // 에러 발생 시에도 이전 데이터를 유지
    gcTime: 60000, // 캐시 유지 시간 (기본값보다 길게)
  })

  // 노드 목록 (모달용)
  const { data: modalNodes, isLoading: isLoadingNodes } = useQuery({
    queryKey: ['modal-nodes'],
    queryFn: () => api.getNodes(false), // 자동 갱신은 캐시 사용
    enabled: selectedResourceType === 'nodes',
  })

  // 선택된 노드의 상세 정보
  const { data: nodeDetail, isLoading: isLoadingNodeDetail } = useQuery({
    queryKey: ['node-detail', selectedNode?.name],
    queryFn: () => api.describeNode(selectedNode.name),
    enabled: !!selectedNode,
  })

  // 컴포넌트 상태
  const { data: componentStatuses, isLoading: isLoadingComponents } = useQuery({
    queryKey: ['component-statuses'],
    queryFn: api.getComponentStatuses,
    enabled: !!selectedNode,
  })

  const handleRefresh = async () => {
    console.log('🔄 새로고침 시작...')
    setIsRefreshing(true)
    // 새로고침은 항상 강제 갱신 (force_refresh=true)
    try {
      // 메인 데이터를 직접 호출하고 캐시에 수동으로 업데이트
      console.log('📡 API 호출 중 (force_refresh=true)...')

      // 먼저 네임스페이스 목록을 가져옴 (다른 API 호출에 필요)
      const namespacesData = await api.getNamespaces(true)

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
    // 다른 모달이 열려있으면 겹치지 않도록 정리
    handleCloseModal()
    setSelectedNode(null)
    setIsStorageModalOpen(false)
    setIsOptimizationModalOpen(false)
    setIsIssuesModalOpen(true)
  }

  const handleOpenStorageModal = () => {
    // 다른 모달이 열려있으면 겹치지 않도록 정리
    handleCloseModal()
    setSelectedNode(null)
    setIsIssuesModalOpen(false)
    setIsOptimizationModalOpen(false)
    setStorageActiveTab('pvcs')
    setStorageSearchQuery('')
    setStorageNamespaceFilter('all')
    setIsStorageNamespaceDropdownOpen(false)
    setIsStorageModalOpen(true)
  }

  const handleOpenOptimizationModal = () => {
    // 다른 모달이 열려있으면 겹치지 않도록 정리
    handleCloseModal()
    setSelectedNode(null)
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

  const flushOptimizationStreamPending = () => {
    const pending = optimizationStreamPendingRef.current
    optimizationStreamRafRef.current = null

    if (pending) {
      optimizationStreamPendingRef.current = ''
      setOptimizationAnswerContent((prev) => prev + pending)
    }

    if (!optimizationStreamPendingRef.current && optimizationStreamDoneRef.current) {
      setOptimizationAnswerContent((prev) => unwrapOuterMarkdownFence(prev))
      setIsOptimizationStreaming(false)
      optimizationStreamDoneRef.current = false
    }
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
    if (optimizationStreamRafRef.current) {
      window.cancelAnimationFrame(optimizationStreamRafRef.current)
      optimizationStreamRafRef.current = null
    }

    void api
      .suggestOptimizationStream(optimizationNamespace, {
        signal: controller.signal,
        onObserved: (content) => {
          // Observed data 표는 한 번에 표시 (타자 효과 적용 X)
          setOptimizationObservedContent((prev) => prev + content)
        },
        onContent: (chunk) => {
          optimizationStreamPendingRef.current += chunk
          if (!optimizationStreamRafRef.current) {
            optimizationStreamRafRef.current = window.requestAnimationFrame(flushOptimizationStreamPending)
          }
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
            setOptimizationStreamError((prev) => prev || '서버가 meta(종료 사유)를 보내지 않았습니다. ai-service가 재빌드/재시작되지 않았을 수 있어요.')
          }
          optimizationStreamDoneRef.current = true
          if (!optimizationStreamRafRef.current) {
            optimizationStreamRafRef.current = window.requestAnimationFrame(flushOptimizationStreamPending)
          }
          optimizationAbortRef.current = null
        },
      })
      .catch((error) => {
        if ((error as any)?.name === 'AbortError') return
        setOptimizationStreamError(error instanceof Error ? error.message : String(error))
        if (optimizationStreamRafRef.current) {
          window.cancelAnimationFrame(optimizationStreamRafRef.current)
          optimizationStreamRafRef.current = null
        }
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
    if (optimizationStreamRafRef.current) {
      window.cancelAnimationFrame(optimizationStreamRafRef.current)
      optimizationStreamRafRef.current = null
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
    setSelectedNode(node)
  }

  const handleCloseNodeDetail = () => {
    setSelectedNode(null)
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
        if (selectedNode) {
          setSelectedNode(null)
        }
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [selectedResourceType, selectedNode, isIssuesModalOpen, isStorageModalOpen])

  // 선택된 리소스 타입에 해당하는 stat 정보 가져오기
  const getSelectedStat = () => {
    const resourceTypeMap: Record<string, ResourceType> = {
      '네임스페이스': 'namespaces',
      'Pods': 'pods',
      'Services': 'services',
      'Deployments': 'deployments',
      'PVCs': 'pvcs',
      'Nodes': 'nodes',
    }
    return stats.find(s => resourceTypeMap[s.name] === selectedResourceType)
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

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[300px]">
        <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
        <p className="text-slate-400">데이터를 불러오는 중...</p>
      </div>
    )
  }

  // Pod/Node 상태는 Kubernetes 스펙상 가능한 값이 제한적이므로
  // 차트에서 항상 전체 상태를 보여주기 위해 고정 목록 사용
  const POD_PHASES = ['Running', 'Succeeded', 'Failed', 'Pending', 'Unknown']
  const NODE_STATUSES = ['Ready', 'NotReady']

  const stats = [
    {
      name: '네임스페이스',
      value: overview?.total_namespaces || 0,
      icon: Server,
      color: 'text-blue-400',
      bgColor: 'bg-blue-500/10',
    },
    {
      name: 'Pods',
      value: overview?.total_pods || 0,
      icon: Box,
      color: 'text-green-400',
      bgColor: 'bg-green-500/10',
    },
    {
      name: 'Services',
      value: overview?.total_services || 0,
      icon: Database,
      color: 'text-purple-400',
      bgColor: 'bg-purple-500/10',
    },
    {
      name: 'Deployments',
      value: overview?.total_deployments || 0,
      icon: TrendingUp,
      color: 'text-yellow-400',
      bgColor: 'bg-yellow-500/10',
    },
    {
      name: 'PVCs',
      value: overview?.total_pvcs || 0,
      icon: HardDrive,
      color: 'text-pink-400',
      bgColor: 'bg-pink-500/10',
    },
    {
      name: 'Nodes',
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
        title: 'Pod 메트릭 수집 실패',
        subtitle: 'metrics-server 상태를 확인해주세요',
      })
    }
    if (topResources?.node_error) {
      items.push({
        id: 'metrics:node_error',
        kind: 'Metrics',
        severity: 'info',
        title: 'Node 메트릭 수집 실패',
        subtitle: 'metrics-server 상태를 확인해주세요',
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

  const optimizationMarkdown = `${optimizationObservedContent}${unwrapOuterMarkdownFence(optimizationAnswerContent)}`.trim()
  const optimizationMarkdownForStreaming = makeStreamingMarkdownRenderFriendly(optimizationMarkdown)
  const optimizationLineCount = optimizationMarkdown
    ? optimizationMarkdown.split('\n').filter((line) => line.trim().length > 0).length
    : 0

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">클러스터 대시보드</h1>
          <p className="mt-2 text-slate-400">
            Kubernetes 클러스터 전체 현황을 한눈에 확인하세요
          </p>
          {overview?.cluster_version && (
            <p className="mt-1 text-sm text-slate-500">
              클러스터 버전: {overview.cluster_version}
            </p>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          title="새로고침 (강제 갱신)"
          className="btn btn-secondary flex items-center gap-2"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          새로고침
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map((stat) => {
          const resourceTypeMap: Record<string, ResourceType> = {
            '네임스페이스': 'namespaces',
            'Pods': 'pods',
            'Services': 'services',
            'Deployments': 'deployments',
            'PVCs': 'pvcs',
            'Nodes': 'nodes',
          }
          const resourceType = resourceTypeMap[stat.name]

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
          <div className="card">
            <h2 className="text-xl font-bold text-white mb-4">Pod 상태</h2>
            <p className="text-sm text-slate-400 mb-4">클릭하여 해당 상태의 Pod 목록 보기</p>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={podStatusData}
                onClick={(data) => {
                  if (data && data.activeLabel) {
                    handlePodStatusClick(data.activeLabel)
                  }
                }}
              >
                <defs>
                  <linearGradient id="podStatusBarFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity={1} />
                    <stop offset="100%" stopColor="#0284c7" stopOpacity={1} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="name"
                  stroke="#94a3b8"
                  style={{ cursor: 'pointer' }}
                />
                <YAxis stroke="#94a3b8" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '8px'
                  }}
                  cursor={{ fill: 'rgba(14, 165, 233, 0.1)' }}
                />
                <Bar
                  dataKey="value"
                  fill="url(#podStatusBarFill)"
                  stroke="#7dd3fc"
                  strokeOpacity={0.25}
                  radius={[8, 8, 2, 2]}
                  isAnimationActive
                  animationDuration={800}
                  animationEasing="ease-out"
                  cursor="pointer"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Node Status Chart */}
        {nodeStatusChartData.length > 0 && (
          <div className="card">
            <h2 className="text-xl font-bold text-white mb-4">Node 상태</h2>
            <p className="text-sm text-slate-400 mb-4">클릭하여 해당 상태의 Node 목록 보기</p>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={nodeStatusChartData}
                onClick={(data) => {
                  if (data && data.activeLabel) {
                    handleNodeStatusClick(data.activeLabel)
                  }
                }}
              >
                <defs>
                  <linearGradient id="nodeStatusBarFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#67e8f9" stopOpacity={1} />
                    <stop offset="100%" stopColor="#0891b2" stopOpacity={1} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="name"
                  stroke="#94a3b8"
                  style={{ cursor: 'pointer' }}
                />
                <YAxis stroke="#94a3b8" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '8px'
                  }}
                  cursor={{ fill: 'rgba(6, 182, 212, 0.1)' }}
                />
                <Bar
                  dataKey="value"
                  fill="url(#nodeStatusBarFill)"
                  stroke="#a5f3fc"
                  strokeOpacity={0.2}
                  radius={[8, 8, 2, 2]}
                  isAnimationActive
                  animationDuration={800}
                  animationEasing="ease-out"
                  cursor="pointer"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Top 리소스 사용 Pod/Node */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Top 파드 */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">리소스 사용 Top 5 Pod</h2>
            <p className="text-xs text-slate-400">5초마다 자동 갱신</p>
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
          ) : isTopResourcesError && !topResources?.top_pods ? (
            // 에러 상태: 이전 데이터가 없을 때만 에러 표시
            <div className="text-center py-12">
              <div className="flex flex-col items-center gap-2">
                <AlertCircle className="w-8 h-8 text-red-400" />
                <p className="text-slate-400">데이터를 가져오는데 실패했습니다</p>
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
                      <span className="text-slate-400">CPU:</span>
                      <span className="text-green-400 font-mono font-medium">{pod.cpu}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">Memory:</span>
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
                <p className="text-slate-400">Pod 메트릭을 가져오는 데 실패했습니다</p>
                <p className="text-xs text-slate-500">metrics-server 상태를 확인해주세요</p>
              </div>
            </div>
          ) : (
            // 데이터가 없을 때
            <div className="text-center py-12">
              <p className="text-slate-400">리소스 사용 데이터가 없습니다</p>
            </div>
          )}
        </div>

        {/* Top Node */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">리소스 사용 Top 3 Node</h2>
            <p className="text-xs text-slate-400">5초마다 자동 갱신</p>
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
          ) : isTopResourcesError && !topResources?.top_nodes ? (
            // 에러 상태: 이전 데이터가 없을 때만 에러 표시
            <div className="text-center py-12">
              <div className="flex flex-col items-center gap-2">
                <AlertCircle className="w-8 h-8 text-red-400" />
                <p className="text-slate-400">데이터를 가져오는데 실패했습니다</p>
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
                          <span>CPU: {node.cpu}</span>
                          <span>Memory: {node.memory}</span>
                        </div>
                      </div>
                    </div>

                    {/* CPU 사용량 막대 */}
                    <div className="space-y-1 pl-11">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-400">CPU</span>
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
                        <span className="text-slate-400">Memory</span>
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
                <p className="text-slate-400">Node 메트릭을 가져오는 데 실패했습니다</p>
                <p className="text-xs text-slate-500">metrics-server 상태를 확인해주세요</p>
              </div>
            </div>
          ) : (
            // 데이터가 없을 때
            <div className="text-center py-12">
              <p className="text-slate-400">리소스 사용 데이터가 없습니다</p>
            </div>
          )}
        </div>
      </div>

      {/* Node 상세 정보 - 별도 카드 */}
      {nodes && Array.isArray(nodes) && nodes.length > 0 && (
        <div className="card">
          <h2 className="text-xl font-bold text-white mb-4">Node 목록</h2>
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
                    <span className="font-medium">Version:</span> {node.version || 'N/A'}
                  </p>
                  {node.roles && node.roles.length > 0 && (
                    <p className="text-xs text-slate-400">
                      <span className="font-medium">Roles:</span> {node.roles.join(', ')}
                    </p>
                  )}
                  {node.internal_ip && (
                    <p className="text-xs text-slate-400">
                      <span className="font-medium">IP:</span> {node.internal_ip}
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
        <h2 className="text-xl font-bold text-white mb-4">빠른 작업</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <button className="btn btn-secondary text-left" onClick={handleOpenIssuesModal}>
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-yellow-400" />
              <div>
                <div className="font-medium">이슈 확인</div>
                <div className="text-xs text-slate-400">문제가 있는 리소스 찾기</div>
              </div>
            </div>
          </button>
          <button className="btn btn-secondary text-left" onClick={handleOpenOptimizationModal}>
            <div className="flex items-center gap-3">
              <TrendingUp className="w-5 h-5 text-green-400" />
              <div>
                <div className="font-medium">최적화 제안</div>
                <div className="text-xs text-slate-400">AI 기반 리소스 최적화</div>
              </div>
            </div>
          </button>
          <button className="btn btn-secondary text-left" onClick={handleOpenStorageModal}>
            <div className="flex items-center gap-3">
              <Database className="w-5 h-5 text-blue-400" />
              <div>
                <div className="font-medium">스토리지 분석</div>
                <div className="text-xs text-slate-400">PV/PVC 사용 현황</div>
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* 최적화 제안 모달 */}
      {isOptimizationModalOpen && (
        <ModalOverlay onClose={handleCloseOptimizationModal}>
          <div
            className="bg-slate-800 rounded-lg max-w-[95vw] w-full h-[80vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-slate-700">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-xl font-bold text-white">최적화 제안</h2>
                  <p className="text-sm text-slate-400">
                    선택한 네임스페이스의 Deployment/Pod 정보를 바탕으로 AI가 최적화 방안을 제안합니다
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
                      title="네임스페이스 선택"
                      disabled={isLoadingAllNamespaces}
                    >
                      <span className="text-sm font-medium truncate">
                        {optimizationNamespace || (isLoadingAllNamespaces ? 'Loading...' : 'Select namespace')}
                      </span>
                      <ChevronDown
                        className={`w-4 h-4 text-slate-400 transition-transform ${isOptimizationNamespaceDropdownOpen ? 'rotate-180' : ''}`}
                      />
                    </button>

                    {isOptimizationNamespaceDropdownOpen && (
                      <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50 max-h-[340px] overflow-y-auto">
                        {optimizationNamespaces.length === 0 ? (
                          <div className="px-4 py-3 text-sm text-slate-200">표시할 네임스페이스가 없습니다</div>
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

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleRunOptimizationSuggestions}
                      disabled={!optimizationNamespace || isOptimizationStreaming}
                      className="h-10 px-4 rounded-lg text-sm font-medium transition-colors bg-primary-600 hover:bg-primary-500 text-white disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed flex items-center gap-2"
                      title="AI 제안 생성"
                    >
                      {isOptimizationStreaming && (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      )}
                      {isOptimizationStreaming ? '생성 중...' : '제안 생성'}
                    </button>

                  {isOptimizationStreaming && (
                    <button
                      onClick={handleStopOptimizationSuggestions}
                      className="h-10 px-4 rounded-lg text-sm font-medium transition-colors bg-slate-700 hover:bg-slate-600 text-slate-200 flex items-center gap-2"
                      title="중단"
                    >
                      <StopCircle className="w-4 h-4" />
                      중단
                    </button>
                  )}

                  <button
                    onClick={handleCopyOptimizationSuggestions}
                    disabled={!optimizationMarkdown}
                    className="h-10 px-4 rounded-lg text-sm font-medium transition-colors bg-slate-700 hover:bg-slate-600 text-slate-200 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                    title="결과 복사"
                  >
                    <Copy className="w-4 h-4" />
                    {optimizationCopied ? '복사됨' : '복사'}
                  </button>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="badge badge-info">Namespace {optimizationNamespace || 'N/A'}</span>
                <span className="badge badge-info">Lines {optimizationLineCount}</span>
                {!!optimizationMeta && (
                  <span className="badge badge-info">
                    Finish {optimizationMeta.finish_reason ?? 'unknown'}
                    {optimizationMeta.max_tokens ? ` (max ${optimizationMeta.max_tokens})` : ''}
                  </span>
                )}
                {!!optimizationUsage && (
                  <span className="badge badge-info">
                    Tokens {optimizationUsage.completion_tokens}
                    {optimizationMeta?.max_tokens ? `/${optimizationMeta.max_tokens}` : ''}
                  </span>
                )}
                {!!optimizationMeta?.finish_reason && optimizationMeta.finish_reason !== 'stop' && (
                  <span className={`text-xs ${optimizationMeta.finish_reason === 'length' ? 'text-yellow-300' : 'text-yellow-200'}`}>
                    응답이 정상 종료(stop)가 아니어서 일부가 잘렸을 수 있어요 ({optimizationMeta.finish_reason})
                  </span>
                )}
                {!!optimizationStreamError && (
                  <span className="text-xs text-red-300 break-words">
                    스트림 오류: {optimizationStreamError}
                  </span>
                )}
                <span className="text-xs text-slate-500">모델 호출에 최대 1분 정도 걸릴 수 있어요</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {isOptimizationStreaming && !optimizationMarkdown ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[240px]">
                  <RefreshCw className="w-7 h-7 text-primary-400 animate-spin mb-3" />
                  <p className="text-slate-400">최적화 제안을 생성하는 중...</p>
                  <p className="text-xs text-slate-500 mt-1">OpenAI 응답을 기다리고 있습니다</p>
                </div>
              ) : optimizationStreamError && !optimizationMarkdown ? (
                <div className="rounded-lg border border-slate-700 bg-slate-900/20 p-4">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-100">제안 생성에 실패했습니다</p>
                      <p className="text-xs text-slate-400 mt-1 break-words">{optimizationStreamError}</p>
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          onClick={handleRunOptimizationSuggestions}
                          className="px-3 py-2 rounded-lg text-sm font-medium transition-colors bg-slate-700 hover:bg-slate-600 text-slate-200"
                        >
                          다시 시도
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : !optimizationMarkdown ? (
                <div className="text-center py-12">
                  <p className="text-slate-400">네임스페이스를 선택한 뒤 “제안 생성”을 눌러주세요</p>
                  <p className="text-xs text-slate-500 mt-1">
                    (현재 API는 Deployment/Pod 목록을 요약해 AI에게 최적화 아이디어를 요청합니다)
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-slate-700 bg-slate-900/20 p-4 overflow-x-auto">
                  {isOptimizationStreaming ? (
                    <div className="prose prose-invert max-w-none overflow-x-auto [&_table]:min-w-full [&_table]:w-max">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{optimizationMarkdownForStreaming}</ReactMarkdown>
                      {!optimizationAnswerContent && (
                        <p className="text-xs text-slate-500">AI가 제안을 작성 중입니다…</p>
                      )}
                    </div>
                  ) : (
                    <div className="prose prose-invert max-w-none overflow-x-auto [&_table]:min-w-full [&_table]:w-max">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{optimizationMarkdown}</ReactMarkdown>
                    </div>
                  )}
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
                  <h2 className="text-xl font-bold text-white">이슈 확인</h2>
                  <p className="text-sm text-slate-400">
                    Pod/Node/Deployment/PVC 상태를 기반으로 문제 리소스를 모아 보여줍니다
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
                <span className="text-xs text-slate-400">총</span>
                <span className="badge badge-info">{issuesSummary.total}개</span>
                <span className="badge badge-error">Critical {issuesSummary.critical}</span>
                <span className="badge badge-warning">Warning {issuesSummary.warning}</span>
                <span className="badge badge-info">Info {issuesSummary.info}</span>
              </div>

              <label className="flex items-center justify-between gap-3 mb-4 p-3 rounded-lg border border-slate-700 bg-slate-900/20">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-200">재시작 이력 포함</p>
                  <p className="text-xs text-slate-400 truncate">
                    현재는 정상(Running/Ready)인 Pod의 과거 재시작도 Info로 표시
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
                  placeholder="이슈 검색 (이름/네임스페이스/메시지)..."
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
                  <p className="text-slate-400">이슈를 수집하는 중...</p>
                </div>
              ) : sortedIssues.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[240px]">
                  <CheckCircle className="w-9 h-9 text-green-400 mb-3" />
                  <p className="text-slate-300 font-medium">문제가 감지되지 않았습니다</p>
                  <p className="text-sm text-slate-400 mt-1">필터 조건(검색)을 확인해보세요</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {(['Node', 'Deployment', 'PVC', 'Pod', 'Metrics'] as IssueKind[]).map((kind) => {
                    const items = issuesByKind[kind] ?? []
                    if (items.length === 0) return null
                    return (
                      <div key={kind} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <h3 className="text-sm font-semibold text-slate-200">{kind}</h3>
                          <span className="text-xs text-slate-400">{items.length}개</span>
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
                                      {issue.severity.toUpperCase()}
                                    </span>
                                    <p className="text-sm font-medium text-white truncate">
                                      {issue.title}
                                    </p>
                                  </div>
                                  <div className="mt-1 space-y-0.5">
                                    {issue.namespace && (
                                      <p className="text-xs text-slate-400">
                                        <span className="font-medium">ns:</span> {issue.namespace}
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
                  <h2 className="text-xl font-bold text-white">스토리지 분석</h2>
                  <p className="text-sm text-slate-400">PV/PVC 상태 및 바인딩 현황을 확인합니다</p>
                </div>
                <button
                  onClick={handleCloseStorageModal}
                  className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 mb-4">
                <span className="badge badge-info">PVC {sortedPVCsForStorage.length}개</span>
                <span className="badge badge-info">PV {sortedPVsForStorage.length}개</span>
                {Object.entries(pvcStatusCounts).slice(0, 4).map(([status, count]) => (
                  <span
                    key={`pvc-${status}`}
                    className={`badge ${status === 'Bound' ? 'badge-success' : status === 'Pending' ? 'badge-warning' : status === 'Lost' ? 'badge-error' : 'badge-info'}`}
                    title="PVC Status"
                  >
                    PVC {status} {count}
                  </span>
                ))}
                {Object.entries(pvStatusCounts).slice(0, 4).map(([status, count]) => (
                  <span
                    key={`pv-${status}`}
                    className={`badge ${status === 'Bound' ? 'badge-success' : status === 'Available' ? 'badge-info' : status === 'Released' ? 'badge-warning' : status === 'Failed' ? 'badge-error' : 'badge-info'}`}
                    title="PV Status"
                  >
                    PV {status} {count}
                  </span>
                ))}
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setStorageActiveTab('pvcs')}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${storageActiveTab === 'pvcs' ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
                  >
                    PVC
                  </button>
                  <button
                    onClick={() => setStorageActiveTab('pvs')}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${storageActiveTab === 'pvs' ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
                  >
                    PV
                  </button>
                  <button
                    onClick={() => setStorageActiveTab('topology')}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${storageActiveTab === 'topology' ? 'bg-primary-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200'}`}
                  >
                    Topology
                  </button>
                </div>

                <div className="relative" ref={storageNamespaceDropdownRef}>
                  <button
                    onClick={() => setIsStorageNamespaceDropdownOpen(!isStorageNamespaceDropdownOpen)}
                    className="h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 min-w-[200px] justify-between"
                    title="네임스페이스 필터"
                  >
                    <span className="text-sm font-medium">
                      {storageNamespaceFilter === 'all' ? 'All namespaces' : storageNamespaceFilter}
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
                        <span className={storageNamespaceFilter === 'all' ? 'font-medium' : ''}>All namespaces</span>
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
                  placeholder="검색 (이름/상태/StorageClass/Claim 등)..."
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
                  <p className="text-slate-400">스토리지 데이터를 불러오는 중...</p>
                </div>
              ) : storageActiveTab === 'pvcs' ? (
                sortedPVCsForStorage.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-slate-400">표시할 PVC가 없습니다</p>
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
                                  <span className="font-medium">ns:</span> {pvc.namespace}
                                </p>
                                <p className="text-xs text-slate-400">
                                  {pvc.capacity || 'N/A'} · {pvc.storage_class || 'N/A'} · PV: {pvc.volume_name || 'N/A'}
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
                    <p className="text-slate-400">표시할 PV가 없습니다</p>
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
                                  {pv.capacity || 'N/A'} · {pv.storage_class || 'N/A'} · Reclaim: {pv.reclaim_policy || 'N/A'}
                                </p>
                                <p className="text-xs text-slate-400">
                                  <span className="font-medium">Claim:</span> {claim}
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
                        <p className="text-sm text-slate-200 font-medium">Storage Topology</p>
                        <p className="text-xs text-slate-400 mt-1">
                          Nodes: {storageTopology.nodes?.length ?? 0} · Edges: {storageTopology.edges?.length ?? 0}
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
                          <p className="text-slate-400">표시할 토폴로지 연결이 없습니다</p>
                        </div>
                      )}
                      {Array.isArray(storageTopology.edges) && storageTopology.edges.length > 50 && (
                        <p className="text-xs text-slate-500">표시는 최대 50개 edge까지만 합니다</p>
                      )}
                    </div>
                  ) : isLoadingStorageTopology ? (
                    <div className="flex flex-col items-center justify-center h-full min-h-[240px]">
                      <RefreshCw className="w-7 h-7 text-primary-400 animate-spin mb-3" />
                      <p className="text-slate-400">토폴로지 로딩 중...</p>
                    </div>
                  ) : isStorageTopologyError ? (
                    <div className="text-center py-12">
                      <p className="text-slate-400">토폴로지 조회 실패</p>
                      <p className="text-xs text-slate-500 mt-2">
                        {(storageTopologyError as any)?.message || '알 수 없는 오류'}
                      </p>
                    </div>
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400">토폴로지 데이터를 가져오지 못했습니다</p>
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
                          {isLoadingResource() ? '로딩 중...' : `총 ${getResourceCount()}개`}
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
                      placeholder="검색..."
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
                  <p className="text-slate-400">데이터를 불러오는 중...</p>
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
                                  Pods: {ns.resource_count?.pods || 0} |
                                  Services: {ns.resource_count?.services || 0} |
                                  Deployments: {ns.resource_count?.deployments || 0}
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
                            {modalSearchQuery ? '검색 결과가 없습니다' : '네임스페이스가 없습니다'}
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
                            {modalSearchQuery ? '검색 결과가 없습니다' : 'Pod가 없습니다'}
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
                                  {svc.namespace} | Type: {svc.type} | Cluster IP: {svc.cluster_ip || 'None'}
                                </p>
                              </div>
                              <span className="badge badge-info">{svc.type}</span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center py-12">
                          <p className="text-slate-400">
                            {modalSearchQuery ? '검색 결과가 없습니다' : 'Service가 없습니다'}
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
                                  {deploy.namespace} | Replicas: {deploy.ready_replicas}/{deploy.replicas}
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
                            {modalSearchQuery ? '검색 결과가 없습니다' : 'Deployment가 없습니다'}
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
                                  {pvc.namespace} | {pvc.capacity || 'N/A'} | {pvc.storage_class || 'N/A'}
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
                            {modalSearchQuery ? '검색 결과가 없습니다' : 'PVC가 없습니다'}
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
                                  Version: {node.version || 'N/A'} |
                                  Internal IP: {node.internal_ip || 'N/A'}
                                  {node.roles && node.roles.length > 0 && ` | Roles: ${node.roles.join(', ')}`}
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
                            {modalSearchQuery ? '검색 결과가 없습니다' : 'Node가 없습니다'}
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

      {/* Node 상세 모달 */}
      {selectedNode && (
        <ModalOverlay onClose={handleCloseNodeDetail}>
          <div
            className="bg-slate-800 rounded-lg max-w-6xl w-full h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 모달 헤더 */}
            <div className="p-6 border-b border-slate-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-cyan-500/10">
                    <Server className="w-5 h-5 text-cyan-400" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-white">{selectedNode.name}</h2>
                    <p className="text-sm text-slate-400">Node 상세 정보</p>
                  </div>
                </div>
                <button
                  onClick={handleCloseNodeDetail}
                  className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
            </div>

            {/* 모달 내용 */}
            <div className="flex-1 overflow-y-auto p-6">
              {isLoadingNodeDetail || isLoadingComponents ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[300px]">
                  <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
                  <p className="text-slate-400">데이터를 불러오는 중...</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* 컴포넌트 상태 */}
                  {componentStatuses && componentStatuses.length > 0 && (
                    <div className="card">
                      <h3 className="text-lg font-bold text-white mb-4">Component Status</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-slate-700">
                              <th className="text-left py-2 px-3 text-slate-400 font-medium">NAME</th>
                              <th className="text-left py-2 px-3 text-slate-400 font-medium">STATUS</th>
                              <th className="text-left py-2 px-3 text-slate-400 font-medium">MESSAGE</th>
                              <th className="text-left py-2 px-3 text-slate-400 font-medium">ERROR</th>
                            </tr>
                          </thead>
                          <tbody>
                            {componentStatuses.map((comp: any) => (
                              <tr key={comp.name} className="border-b border-slate-700/50">
                                <td className="py-3 px-3 text-white font-mono text-sm">{comp.name}</td>
                                <td className="py-3 px-3">
                                  <span className={`badge ${comp.status === 'Healthy' ? 'badge-success' :
                                    comp.status === 'Unavailable' ? 'badge-warning' : 'badge-error'
                                    }`}>
                                    {comp.status}
                                  </span>
                                </td>
                                <td className="py-3 px-3 text-slate-300 text-sm">{comp.message || '-'}</td>
                                <td className="py-3 px-3 text-slate-300 text-sm">{comp.error || '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Node Describe 정보 */}
                  {nodeDetail && (
                    <>
                      {/* 기본 정보 */}
                      <div className="card">
                        <h3 className="text-lg font-bold text-white mb-4">기본 정보</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <p className="text-sm text-slate-400 mb-1">이름</p>
                            <p className="text-white font-mono">{nodeDetail.name}</p>
                          </div>
                          {nodeDetail.system_info && (
                            <>
                              <div>
                                <p className="text-sm text-slate-400 mb-1">OS Image</p>
                                <p className="text-white">{nodeDetail.system_info.os_image}</p>
                              </div>
                              <div>
                                <p className="text-sm text-slate-400 mb-1">Kernel Version</p>
                                <p className="text-white font-mono">{nodeDetail.system_info.kernel_version}</p>
                              </div>
                              <div>
                                <p className="text-sm text-slate-400 mb-1">Container Runtime</p>
                                <p className="text-white font-mono">{nodeDetail.system_info.container_runtime}</p>
                              </div>
                              <div>
                                <p className="text-sm text-slate-400 mb-1">Kubelet Version</p>
                                <p className="text-white font-mono">{nodeDetail.system_info.kubelet_version}</p>
                              </div>
                              <div>
                                <p className="text-sm text-slate-400 mb-1">Kube-Proxy Version</p>
                                <p className="text-white font-mono">{nodeDetail.system_info.kube_proxy_version}</p>
                              </div>
                            </>
                          )}
                        </div>
                      </div>

                      {/* 주소 */}
                      {nodeDetail.addresses && nodeDetail.addresses.length > 0 && (
                        <div className="card">
                          <h3 className="text-lg font-bold text-white mb-4">Addresses</h3>
                          <div className="space-y-2">
                            {nodeDetail.addresses.map((addr: any, idx: number) => (
                              <div key={idx} className="flex items-center gap-3 p-2 bg-slate-700 rounded">
                                <span className="text-slate-400 text-sm font-medium w-32">{addr.type}</span>
                                <span className="text-white font-mono">{addr.address}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Conditions */}
                      {nodeDetail.conditions && nodeDetail.conditions.length > 0 && (
                        <div className="card">
                          <h3 className="text-lg font-bold text-white mb-4">Conditions</h3>
                          <div className="overflow-x-auto">
                            <table className="w-full">
                              <thead>
                                <tr className="border-b border-slate-700">
                                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Type</th>
                                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Status</th>
                                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Reason</th>
                                  <th className="text-left py-2 px-3 text-slate-400 font-medium">Message</th>
                                </tr>
                              </thead>
                              <tbody>
                                {nodeDetail.conditions.map((condition: any, idx: number) => (
                                  <tr key={idx} className="border-b border-slate-700/50">
                                    <td className="py-3 px-3 text-white font-medium">{condition.type}</td>
                                    <td className="py-3 px-3">
                                      <span className={`badge ${condition.status === 'True' ? 'badge-success' :
                                        condition.status === 'False' ? 'badge-error' : 'badge-warning'
                                        }`}>
                                        {condition.status}
                                      </span>
                                    </td>
                                    <td className="py-3 px-3 text-slate-300 text-sm">{condition.reason || '-'}</td>
                                    <td className="py-3 px-3 text-slate-300 text-sm">{condition.message || '-'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}

                      {/* Labels */}
                      {nodeDetail.labels && Object.keys(nodeDetail.labels).length > 0 && (
                        <div className="card">
                          <h3 className="text-lg font-bold text-white mb-4">Labels</h3>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                            {Object.entries(nodeDetail.labels).map(([key, value]) => (
                              <div key={key} className="p-2 bg-slate-700 rounded text-xs">
                                <span className="text-slate-400">{key}:</span>{' '}
                                <span className="text-white font-mono">{value as string}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Annotations */}
                      {nodeDetail.annotations && Object.keys(nodeDetail.annotations).length > 0 && (
                        <div className="card">
                          <h3 className="text-lg font-bold text-white mb-4">Annotations</h3>
                          <div className="grid grid-cols-1 gap-2 max-h-64 overflow-y-auto">
                            {Object.entries(nodeDetail.annotations).map(([key, value]) => (
                              <div key={key} className="p-2 bg-slate-700 rounded text-xs">
                                <span className="text-slate-400 break-all">{key}:</span>{' '}
                                <span className="text-white font-mono break-all">{value as string}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
