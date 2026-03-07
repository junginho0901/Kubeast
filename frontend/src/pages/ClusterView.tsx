import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import type { PodInfo } from '@/services/api'
import { getAuthHeaders, handleUnauthorized } from '@/services/auth'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { ModalOverlay } from '@/components/ModalOverlay'
import { 
  Server, 
  Box, 
  CheckCircle, 
  XCircle, 
  AlertCircle,
  RefreshCw,
  Loader2,
  Trash2,
  HelpCircle,
  X,
  FileCode,
  Terminal,
  ChevronDown,
  Search,
  Download,
  Shield
} from 'lucide-react'

interface PodDetail {
  name: string
  namespace: string
  node: string
  status: string
  phase: string
  restart_count: number
  created_at: string
  containers: Array<{
    name: string
    image: string
    ready: boolean
    state: {
      waiting?: { reason?: string | null; message?: string | null }
      terminated?: { reason?: string | null; message?: string | null; exit_code?: number | null }
      running?: { started_at?: string | null }
    } | null
    restart_count: number
  }>
}

export default function ClusterView() {
  const queryClient = useQueryClient()
  const { t, i18n } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) => t(key, { defaultValue: fallback, ...options })
  const locale = i18n.language === 'ko' ? 'ko-KR' : 'en-US'
  const na = tr('common.notAvailable', 'N/A')
  const unknown = tr('common.unknown', 'Unknown')
  const emptyValue = tr('common.empty', '-')
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
    staleTime: 30000,
  })
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [selectedPod, setSelectedPod] = useState<PodDetail | null>(null)
  const [selectedContainer, setSelectedContainer] = useState<string>('')
  const [showLogs, setShowLogs] = useState(false)
  const [showManifest, setShowManifest] = useState(false)
  const [showDescribe, setShowDescribe] = useState(false)
  const [showRbac, setShowRbac] = useState(false)
  const [includeAuthenticatedGroup, setIncludeAuthenticatedGroup] = useState(false)
  const [logs, setLogs] = useState<string>('')
  const [, setIsStreamingLogs] = useState(false)
  const [isNamespaceDropdownOpen, setIsNamespaceDropdownOpen] = useState(false)
  const [isContainerDropdownOpen, setIsContainerDropdownOpen] = useState(false)
  const [isTailLinesDropdownOpen, setIsTailLinesDropdownOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [containerSearchQuery, setContainerSearchQuery] = useState<string>('')
  const [downloadTailLines, setDownloadTailLines] = useState<number>(1000)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [podContextMenu, setPodContextMenu] = useState<{ x: number; y: number; pod: PodInfo } | null>(null)
  const [deleteTargetPod, setDeleteTargetPod] = useState<PodInfo | null>(null)
  const [deleteForce, setDeleteForce] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeletingPod, setIsDeletingPod] = useState(false)
  const [deletingPods, setDeletingPods] = useState<Set<string>>(new Set())
  const logsEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const namespaceDropdownRef = useRef<HTMLDivElement>(null)
  const containerDropdownRef = useRef<HTMLDivElement>(null)
  const tailLinesDropdownRef = useRef<HTMLDivElement>(null)

  const isAuthenticatedOnlyGrant = (binding: any): boolean => {
    const matchedBy = binding?.matched_by
    if (Array.isArray(matchedBy) && matchedBy.length > 0) {
      return matchedBy.every((m: any) => m?.reason === 'group:system:authenticated')
    }
    return Boolean(binding?.is_broad)
  }

  const formatMatchReason = (reason: string) => {
    switch (reason) {
      case 'serviceaccount':
        return tr('clusterView.rbac.serviceAccountDirect', 'ServiceAccount (direct)')
      case 'user:system:serviceaccount':
        return tr('clusterView.rbac.match.userServiceAccount', 'User(system:serviceaccount)')
      case 'group:serviceaccounts':
        return tr('clusterView.rbac.match.groupServiceAccounts', 'Group(system:serviceaccounts)')
      case 'group:system:authenticated':
        return tr('clusterView.rbac.match.groupAuthenticated', 'Group(system:authenticated)')
      default:
        return reason
    }
  }

  const getBindingMatchPathText = (binding: any) => {
    const matchedBy = binding?.matched_by
    if (!Array.isArray(matchedBy) || matchedBy.length === 0) return null
    const reasons = matchedBy
      .map((m: any) => m?.reason)
      .filter((r: any) => typeof r === 'string' && r.trim())
    if (!reasons.length) return null
    const unique = Array.from(new Set(reasons))
    return unique.map(formatMatchReason).join(' · ')
  }

  const buildRbacPermissionSummary = (rbac: any) => {
    const items: Array<{
      kind: 'resource' | 'nonResourceURL'
      apiGroup?: string
      resource?: string
      resourceNames?: string[]
      nonResourceURL?: string
      verbs: Set<string>
    }> = []

    const resourceIndex = new Map<string, number>()
    const nonResourceIndex = new Map<string, number>()

    const addResource = (apiGroup: string, resource: string, resourceNames: string[] | undefined, verbs: string[]) => {
      const namesKey = (resourceNames || []).slice().sort().join(',')
      const key = `${apiGroup}::${resource}::${namesKey}`
      const existingIndex = resourceIndex.get(key)
      if (existingIndex !== undefined) {
        for (const v of verbs) items[existingIndex].verbs.add(v)
        return
      }
      const idx = items.length
      resourceIndex.set(key, idx)
      items.push({
        kind: 'resource',
        apiGroup,
        resource,
        resourceNames: resourceNames && resourceNames.length ? resourceNames.slice().sort() : undefined,
        verbs: new Set(verbs || []),
      })
    }

    const addNonResource = (url: string, verbs: string[]) => {
      const key = url
      const existingIndex = nonResourceIndex.get(key)
      if (existingIndex !== undefined) {
        for (const v of verbs) items[existingIndex].verbs.add(v)
        return
      }
      const idx = items.length
      nonResourceIndex.set(key, idx)
      items.push({
        kind: 'nonResourceURL',
        nonResourceURL: url,
        verbs: new Set(verbs || []),
      })
    }

    const bindings = [
      ...((rbac?.role_bindings || []) as any[]),
      ...((rbac?.cluster_role_bindings || []) as any[]),
    ]

    for (const b of bindings) {
      const rules = b?.resolved_role?.rules
      if (!Array.isArray(rules)) continue
      for (const rule of rules) {
        const verbs: string[] = Array.isArray(rule?.verbs) ? rule.verbs : []

        const nonResourceURLs: string[] = Array.isArray(rule?.non_resource_urls) ? rule.non_resource_urls : []
        if (nonResourceURLs.length > 0) {
          for (const url of nonResourceURLs) {
            if (typeof url === 'string' && url.trim()) addNonResource(url, verbs)
          }
          continue
        }

        const apiGroups: string[] = Array.isArray(rule?.api_groups) && rule.api_groups.length ? rule.api_groups : ['']
        const resources: string[] = Array.isArray(rule?.resources) ? rule.resources : []
        const resourceNames: string[] | undefined = Array.isArray(rule?.resource_names) ? rule.resource_names : undefined

        for (const ag of apiGroups) {
          const apiGroup = ag === '' ? '(core)' : ag
          for (const res of resources) {
            if (typeof res === 'string' && res.trim()) addResource(apiGroup, res, resourceNames, verbs)
          }
        }
      }
    }

    const resourceItems = items
      .filter((i) => i.kind === 'resource')
      .map((i) => ({
        ...i,
        verbsList: Array.from(i.verbs).sort(),
      }))
      .sort((a, b) => {
        const ag = (a.apiGroup || '').localeCompare(b.apiGroup || '')
        if (ag !== 0) return ag
        const r = (a.resource || '').localeCompare(b.resource || '')
        if (r !== 0) return r
        const an = (a.resourceNames || []).join(',').localeCompare((b.resourceNames || []).join(','))
        return an
      })

    const nonResourceItems = items
      .filter((i) => i.kind === 'nonResourceURL')
      .map((i) => ({
        ...i,
        verbsList: Array.from(i.verbs).sort(),
      }))
      .sort((a, b) => (a.nonResourceURL || '').localeCompare(b.nonResourceURL || ''))

    return { resourceItems, nonResourceItems }
  }

  // ESC 키로 모달/메뉴 닫기
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (podContextMenu) setPodContextMenu(null)
      if (deleteTargetPod) closeDeleteModal()
      if (selectedPod) setSelectedPod(null)
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [selectedPod, podContextMenu, deleteTargetPod])

  useEffect(() => {
    if (!podContextMenu) return
    const handleClose = () => setPodContextMenu(null)
    window.addEventListener('resize', handleClose)
    window.addEventListener('scroll', handleClose, true)
    return () => {
      window.removeEventListener('resize', handleClose)
      window.removeEventListener('scroll', handleClose, true)
    }
  }, [podContextMenu])

  // 네임스페이스 목록
  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
  })

  // 전체 Pod 조회
  const { data: allPods, isLoading } = useQuery({
    queryKey: ['all-pods', selectedNamespace],
    queryFn: async () => {
      const forceRefresh = true // Pod 조회는 항상 강제 갱신
      if (selectedNamespace === 'all') {
        const pods = await Promise.all(
          (namespaces || []).map(ns => api.getPods(ns.name, undefined, forceRefresh))
        )
        return pods.flat()
      } else {
        return await api.getPods(selectedNamespace, undefined, forceRefresh)
      }
    },
    enabled: !!namespaces,
  })

  useKubeWatchList({
    enabled: !!namespaces,
    queryKey: ['all-pods', selectedNamespace],
    path:
      selectedNamespace === 'all'
        ? '/api/v1/pods'
        : `/api/v1/namespaces/${selectedNamespace}/pods`,
    query: 'watch=1',
  })

  // 노드 목록 (정렬용)
  const { data: nodes } = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.getNodes(false),
  })

  // 로그 스트리밍 (WebSocket)
  useEffect(() => {
    if (!showLogs || !selectedPod || !selectedContainer) {
      setLogs('')
      setIsStreamingLogs(false)
      if (abortControllerRef.current) {
        const ws = abortControllerRef.current as any
        if (ws && ws.close) {
          ws.close()
        }
        abortControllerRef.current = null
      }
      return
    }

    setIsStreamingLogs(true)
    setLogs('')
    
    const streamLogs = () => {
      try {
        // 기존 WebSocket 연결이 있으면 먼저 닫기
        if (abortControllerRef.current) {
          const oldWs = abortControllerRef.current as any
          if (oldWs && oldWs.close) {
            try {
              if (oldWs.readyState === WebSocket.OPEN || oldWs.readyState === WebSocket.CONNECTING) {
                oldWs.close()
              }
            } catch (e) {
              console.error('Error closing WebSocket:', e)
            }
          }
          abortControllerRef.current = null
        }
        
        // WebSocket 연결
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const rawWsBase = (import.meta.env.VITE_WS_URL || '').trim()
        let wsBase = rawWsBase
        if (wsBase && wsBase.startsWith('http')) {
          wsBase = wsBase.replace(/^http/, 'ws')
        }
        if (!wsBase) {
          wsBase = `${protocol}//${window.location.host}`
        }
        wsBase = wsBase.replace(/\/$/, '')
        const wsUrl = `${wsBase}/api/v1/cluster/namespaces/${selectedPod.namespace}/pods/${selectedPod.name}/logs/ws?container=${selectedContainer}&tail_lines=100`
        
        const ws = new WebSocket(wsUrl)
        abortControllerRef.current = ws as any
        
        ws.onopen = () => {
          console.log('WebSocket connected')
        }
        
        ws.onmessage = (event) => {
          if (typeof event.data === 'string') {
            setLogs((prev) => prev + event.data)
          } else {
            // Binary data (Blob)
            const reader = new FileReader()
            reader.onload = () => {
              const text = reader.result as string
              setLogs((prev) => prev + text)
            }
            reader.readAsText(event.data)
          }
        }
        
        ws.onerror = (error) => {
          console.error('WebSocket error:', error)
          setLogs((prev) => prev + `\n\n${tr('clusterView.logs.streamError', 'An error occurred while streaming logs.')}`)
        }
        
        ws.onclose = (event) => {
          if (event.code === 1008) {
            handleUnauthorized()
          }
          console.log('WebSocket closed')
          setIsStreamingLogs(false)
        }
        
      } catch (error: any) {
        console.error('Error creating WebSocket:', error)
        setLogs(`${tr('clusterView.logs.fetchError', 'Failed to load logs.')}\n\n${tr('clusterView.logs.errorLabel', 'Error')}: ${error.message}`)
        setIsStreamingLogs(false)
      }
    }

    streamLogs()

    // cleanup: WebSocket 연결 종료
    return () => {
      if (abortControllerRef.current) {
        const ws = abortControllerRef.current as any
        if (ws && ws.close) {
          ws.close()
        }
        abortControllerRef.current = null
      }
      setIsStreamingLogs(false)
    }
  }, [showLogs, selectedPod, selectedContainer])

  // 로그 자동 스크롤 (맨 아래로 - 애니메이션 없이)
  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'auto', block: 'end' })
    }
  }, [logs, showLogs])

  // 네임스페이스 드롭다운 외부 클릭 감지
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        namespaceDropdownRef.current &&
        !namespaceDropdownRef.current.contains(event.target as Node)
      ) {
        setIsNamespaceDropdownOpen(false)
      }
    }

    if (isNamespaceDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isNamespaceDropdownOpen])

  // 컨테이너 드롭다운 외부 클릭 감지
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        containerDropdownRef.current &&
        !containerDropdownRef.current.contains(event.target as Node)
      ) {
        setIsContainerDropdownOpen(false)
      }
    }

    if (isContainerDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isContainerDropdownOpen])

  // 줄 수 드롭다운 외부 클릭 감지
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        tailLinesDropdownRef.current &&
        !tailLinesDropdownRef.current.contains(event.target as Node)
      ) {
        setIsTailLinesDropdownOpen(false)
      }
    }

    if (isTailLinesDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isTailLinesDropdownOpen])

  // Pod YAML 조회
  const { data: manifest } = useQuery({
    queryKey: ['pod-yaml', selectedPod?.namespace, selectedPod?.name],
    queryFn: async () => {
      if (!selectedPod) return ''
      const response = await fetch(
        `/api/v1/cluster/namespaces/${selectedPod.namespace}/pods/${selectedPod.name}/yaml`,
        { headers: { ...getAuthHeaders() } }
      )
      if (response.status === 401) {
        handleUnauthorized()
        throw new Error('Unauthorized')
      }
      const data = await response.json()
      return data.yaml
    },
    enabled: showManifest && !!selectedPod,
  })

  // Describe 조회
  const { data: describeData } = useQuery({
    queryKey: ['pod-describe', selectedPod?.namespace, selectedPod?.name],
    queryFn: async () => {
      if (!selectedPod) return null
      return await api.describePod(selectedPod.namespace, selectedPod.name)
    },
    enabled: showDescribe && !!selectedPod,
  })

  // Pod RBAC 조회
  const { data: rbacData, isLoading: isRbacLoading, error: rbacError } = useQuery({
    queryKey: ['pod-rbac', selectedPod?.namespace, selectedPod?.name, includeAuthenticatedGroup],
    queryFn: async () => {
      if (!selectedPod) return null
      return await api.getPodRbac(selectedPod.namespace, selectedPod.name, {
        include_authenticated: includeAuthenticatedGroup,
      })
    },
    enabled: showRbac && !!selectedPod,
  })

  // 검색어로 Pod 필터링
  const filteredPods = allPods?.filter(pod => {
    if (!searchQuery.trim()) return true
    const query = searchQuery.toLowerCase()
    return pod.name.toLowerCase().includes(query) || 
           pod.namespace.toLowerCase().includes(query)
  }) || []

  // 노드별로 Pod 그룹화 (필터링된 Pod 기준)
  const podsByNode = filteredPods.reduce((acc, pod) => {
    const nodeName = pod.node_name || 'Unscheduled'
    if (!acc[nodeName]) acc[nodeName] = []
    acc[nodeName].push(pod)
    return acc
  }, {} as Record<string, any[]>)

  // 노드 정렬: control-plane 먼저, 그 다음 워커 노드, 각 그룹 내에서는 이름 순
  const sortedNodeEntries = Object.entries(podsByNode).sort(([nodeA], [nodeB]) => {
    // 노드 정보 찾기
    const nodeInfoA = nodes?.find((n: any) => n.name === nodeA)
    const nodeInfoB = nodes?.find((n: any) => n.name === nodeB)
    
    // Unscheduled는 맨 뒤로
    if (nodeA === 'Unscheduled') return 1
    if (nodeB === 'Unscheduled') return -1
    
    // control-plane 역할 확인
    const isControlPlaneA = nodeInfoA?.roles?.includes('control-plane') || false
    const isControlPlaneB = nodeInfoB?.roles?.includes('control-plane') || false
    
    // control-plane이 먼저
    if (isControlPlaneA && !isControlPlaneB) return -1
    if (!isControlPlaneA && isControlPlaneB) return 1
    
    // 같은 그룹 내에서는 이름 순으로 정렬
    return nodeA.localeCompare(nodeB)
  })

  const canDeletePod = ['admin', 'write'].includes(String(me?.role || '').toLowerCase())

  const pickReason = (reasons: string[], priority: string[]) => {
    for (const p of priority) {
      if (reasons.includes(p)) return p
    }
    return reasons[0] || ''
  }

  const isCompletedReason = (reason?: string | null) => {
    if (!reason) return false
    return reason === 'Completed' || reason === 'Succeeded'
  }

  const getPodHealth = (pod: any) => {
    const phase = pod?.phase || pod?.status || 'Unknown'
    const containers = Array.isArray(pod?.containers) ? pod.containers : []
    const initContainers = Array.isArray(pod?.init_containers) ? pod.init_containers : []
    const statusReason = isCompletedReason(pod?.status_reason) ? null : pod?.status_reason
    const waitingReasons = containers
      .map((c: any) => c?.state?.waiting?.reason)
      .filter((r: any) => typeof r === 'string' && r.trim()) as string[]
    const terminatedReasons = containers
      .map((c: any) => ({
        reason: c?.state?.terminated?.reason,
        exitCode: c?.state?.terminated?.exit_code,
      }))
      .filter((r: any) => typeof r?.reason === 'string' && r.reason.trim())
      .filter((r: any) => !isCompletedReason(r.reason))
      .map((r: any) => r.reason) as string[]
    const initWaitingReasons = initContainers
      .map((c: any) => c?.state?.waiting?.reason)
      .filter((r: any) => typeof r === 'string' && r.trim()) as string[]
    const initTerminatedReasons = initContainers
      .map((c: any) => ({
        reason: c?.state?.terminated?.reason,
        exitCode: c?.state?.terminated?.exit_code,
      }))
      .filter((r: any) => typeof r?.reason === 'string' && r.reason.trim())
      .filter((r: any) => !isCompletedReason(r.reason))
      .map((r: any) => r.reason) as string[]

    const errorPriority = [
      'CrashLoopBackOff',
      'ImagePullBackOff',
      'ErrImagePull',
      'CreateContainerConfigError',
      'CreateContainerError',
      'RunContainerError',
      'ContainerCannotRun',
      'InvalidImageName',
      'ImageInspectError',
      'RegistryUnavailable',
      'ErrImageNeverPull',
      'OOMKilled',
      'Error',
    ]

    const warnPriority = [
      'ContainerCreating',
      'PodInitializing',
      'Pending',
      'NotReady',
    ]

    const errorReason = pickReason(
      [
        ...(statusReason ? [statusReason] : []),
        ...initWaitingReasons,
        ...initTerminatedReasons,
        ...waitingReasons,
        ...terminatedReasons,
      ],
      errorPriority
    )
    if (errorReason || phase === 'Failed') {
      return { level: 'error' as const, reason: errorReason || 'Failed', phase }
    }

    const readyCount = containers.filter((c: any) => c?.ready).length
    const totalCount = containers.length
    const notReady = totalCount > 0 && readyCount < totalCount
    const initNotReady = initContainers.length > 0 && initContainers.some((c: any) => {
      const state = c?.state || {}
      if (state.waiting) return true
      if (state.running) return true
      if (state.terminated) {
        const code = state.terminated.exit_code
        return typeof code === 'number' ? code !== 0 : true
      }
      return false
    })

    if (phase === 'Pending' || phase === 'Unknown') {
      return { level: 'warn' as const, reason: phase, phase }
    }

    if (initNotReady) {
      const initReason = pickReason(initWaitingReasons, warnPriority) || 'PodInitializing'
      return { level: 'warn' as const, reason: initReason, phase }
    }

    if (notReady) {
      const warnReason = pickReason(waitingReasons, warnPriority) || 'NotReady'
      return { level: 'warn' as const, reason: warnReason, phase }
    }

    if (phase === 'Succeeded') {
      return { level: 'ok' as const, reason: 'Succeeded', phase }
    }

    const warnReason = pickReason(waitingReasons, warnPriority)
    if (warnReason) {
      return { level: 'warn' as const, reason: warnReason, phase }
    }

    return { level: 'ok' as const, reason: phase, phase }
  }

  const getHealthIcon = (level: 'ok' | 'warn' | 'error', reason?: string) => {
    if (reason === 'PodInitializing' || reason === 'ContainerCreating') {
      return (
        <span
          className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-sky-400 border-t-transparent"
          aria-label="loading"
        />
      )
    }
    if (level === 'ok') {
      return <CheckCircle className="w-5 h-5 text-green-400" />
    }
    if (level === 'error') {
      return <XCircle className="w-5 h-5 text-red-400" />
    }
    return <AlertCircle className="w-5 h-5 text-yellow-400" />
  }

  const handlePodClick = async (pod: any) => {
    // Pod 상세 정보 조회
    const response = await fetch(
      `/api/v1/cluster/namespaces/${pod.namespace}/pods/${pod.name}/describe`,
      { headers: { ...getAuthHeaders() } }
    )
    if (response.status === 401) {
      handleUnauthorized()
      return
    }
    const detail = await response.json()
    console.log('Pod detail response:', detail) // 디버깅용
    console.log('Phase:', detail.phase, 'Status:', detail.status)
    console.log('Created at:', detail.created_at)
    console.log('Node:', detail.node)
    
    // 탭 상태 초기화 (Summary 탭이 기본으로 열리도록)
    setShowLogs(false)
    setShowManifest(false)
    setShowDescribe(false)
    setShowRbac(false)
    setIncludeAuthenticatedGroup(false)
    
    setSelectedPod(detail)
    setContainerSearchQuery('') // 모달 열 때 검색어 초기화
    
    // 메인 컨테이너 찾기
    // 1. Pod 이름에서 해시값 제거 (예: app-7d8f9c-xyz -> app)
    const podBaseName = pod.name.replace(/-[a-z0-9]{5,10}-[a-z0-9]{5}$/i, '').replace(/-[0-9]+$/i, '')
    
    // 2. Pod 베이스 이름과 일치하는 컨테이너 찾기
    let mainContainer = detail.containers?.find((c: any) => c.name === podBaseName)
    
    // 3. 못 찾으면 사이드카 패턴 제외하고 찾기
    if (!mainContainer) {
      const sidecarPatterns = ['istio-proxy', 'istio-init', 'envoy', 'linkerd-proxy', 'vault-agent']
      mainContainer = detail.containers?.find(
        (c: any) => !sidecarPatterns.some(pattern => c.name.includes(pattern))
      )
    }
    
    const containerName = mainContainer?.name || detail.containers?.[0]?.name || ''
    setSelectedContainer(containerName)
    
    // 기본값을 Logs 탭으로 설정
    setShowLogs(true)
    setShowManifest(false)
  }

  const handlePodContextMenu = (event: React.MouseEvent, pod: PodInfo) => {
    if (!canDeletePod) return
    event.preventDefault()
    setPodContextMenu({ x: event.clientX, y: event.clientY, pod })
  }

  const handleClosePodContextMenu = () => {
    setPodContextMenu(null)
  }

  const openDeleteModal = (pod: PodInfo) => {
    setDeleteTargetPod(pod)
    setDeleteForce(false)
    setDeleteError(null)
  }

  const closeDeleteModal = () => {
    setDeleteTargetPod(null)
    setDeleteForce(false)
    setDeleteError(null)
    setIsDeletingPod(false)
  }

  const handleDeletePod = async () => {
    if (!deleteTargetPod || isDeletingPod) return
    setIsDeletingPod(true)
    setDeleteError(null)
    const target = deleteTargetPod
    const podKey = `${target.namespace}/${target.name}`
    setDeletingPods(prev => new Set(prev).add(podKey))
    try {
      await api.deletePod(target.namespace, target.name, deleteForce)
      if (selectedPod?.name === target.name && selectedPod?.namespace === target.namespace) {
        setSelectedPod(null)
      }
      closeDeleteModal()
    } catch (error: any) {
      setDeletingPods(prev => {
        const next = new Set(prev)
        next.delete(podKey)
        return next
      })
      setDeleteError(error?.response?.data?.detail || error?.message || '삭제에 실패했습니다.')
    } finally {
      setIsDeletingPod(false)
    }
  }

  useEffect(() => {
    if (!allPods) return
    setDeletingPods(prev => {
      const remaining = new Set<string>()
      const keys = new Set(allPods.map(pod => `${pod.namespace}/${pod.name}`))
      for (const key of prev) {
        if (keys.has(key)) remaining.add(key)
      }
      return remaining
    })
  }, [allPods])

  const handleDownloadLogs = async () => {
    if (!selectedPod || !selectedContainer) return
    
    setIsDownloading(true)
    try {
      const logs = await api.getPodLogs(
        selectedPod.namespace,
        selectedPod.name,
        selectedContainer,
        downloadTailLines
      )
      
      // 날짜 시간 형식: YYYYMMDD-HHMMSS
      const now = new Date()
      const year = now.getFullYear()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const hours = String(now.getHours()).padStart(2, '0')
      const minutes = String(now.getMinutes()).padStart(2, '0')
      const seconds = String(now.getSeconds()).padStart(2, '0')
      const dateTime = `${year}${month}${day}-${hours}${minutes}${seconds}`
      
      const blob = new Blob([logs], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${selectedPod.name}-${selectedContainer}-logs-${dateTime}.txt`
      a.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('Log download failed:', error)
      alert(tr('clusterView.logs.downloadError', 'Failed to download logs.'))
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{tr('clusterView.title', 'Cluster view')}</h1>
          <p className="mt-2 text-slate-400">
            {tr('clusterView.subtitle', 'Review pod placement across nodes')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* 파드 이름 검색 */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder={tr('clusterView.searchPlaceholder', 'Search pod name...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-10 pl-10 pr-4 bg-slate-700 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors w-64"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 hover:bg-slate-600 rounded transition-colors"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            )}
          </div>
          {/* 네임스페이스 선택 - 커스텀 드롭다운 */}
          <div className="relative" ref={namespaceDropdownRef}>
            <button
              onClick={() => setIsNamespaceDropdownOpen(!isNamespaceDropdownOpen)}
              className="h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 min-w-[200px] justify-between"
            >
              <span className="text-sm font-medium">
                {selectedNamespace === 'all'
                  ? tr('clusterView.allNamespaces', 'All namespaces')
                  : selectedNamespace}
              </span>
              <ChevronDown 
                className={`w-4 h-4 text-slate-400 transition-transform ${
                  isNamespaceDropdownOpen ? 'rotate-180' : ''
                }`}
              />
            </button>
            
            {isNamespaceDropdownOpen && (
              <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50 max-h-[400px] overflow-y-auto">
                <button
                  onClick={() => {
                    setSelectedNamespace('all')
                    setIsNamespaceDropdownOpen(false)
                  }}
                  className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
                >
                  {selectedNamespace === 'all' && (
                    <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                  )}
                  <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>
                    {tr('clusterView.allNamespaces', 'All namespaces')}
                  </span>
                </button>
                {Array.isArray(namespaces) && namespaces.map((ns) => (
                  <button
                    key={ns.name}
                    onClick={() => {
                      setSelectedNamespace(ns.name)
                      setIsNamespaceDropdownOpen(false)
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg"
                  >
                    {selectedNamespace === ns.name && (
                      <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                    )}
                    <span className={selectedNamespace === ns.name ? 'font-medium' : ''}>
                      {ns.name}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* 새로고침 버튼 숨김 (watch 기반 실시간 갱신) */}
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center h-full min-h-[300px]">
          <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
          <p className="text-slate-400">{tr('clusterView.loading', 'Loading data...')}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* 검색 결과 정보 */}
          {searchQuery && (
            <div className="text-sm text-slate-400">
              {tr('clusterView.searchResults', 'Results')}:{' '}
              <span className="text-white font-medium">{filteredPods.length}</span>{' '}
              {tr('clusterView.countSuffix', 'items')}
              {filteredPods.length !== (allPods?.length || 0) && (
                <span className="ml-2">
                  {tr('clusterView.searchResultsTotal', '(out of {{count}})', { count: allPods?.length || 0 })}
                </span>
              )}
            </div>
          )}
          
          {/* 검색 결과가 없을 때 */}
          {searchQuery && filteredPods.length === 0 && (
            <div className="card text-center py-12">
              <Search className="w-12 h-12 text-slate-600 mx-auto mb-4" />
              <p className="text-slate-400">
                {tr('clusterView.noSearchResults', 'No pods found for "{{query}}"', { query: searchQuery })}
              </p>
            </div>
          )}

          {/* 노드별 Pod 표시 */}
          {sortedNodeEntries.length > 0 ? (
            sortedNodeEntries.map(([nodeName, pods]) => (
            <div key={nodeName} className="card">
              <div className="flex items-center gap-3 mb-4">
                <Server className="w-6 h-6 text-cyan-400" />
                <h2 className="text-xl font-bold text-white">{nodeName}</h2>
                <span className="badge badge-secondary">
                  {tr('clusterView.nodePodsCount', '{{count}} Pods', { count: pods.length })}
                </span>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
                {pods.map((pod, idx) => {
                  const podKey = `${pod.namespace}/${pod.name}`
                  const isDeleting = deletingPods.has(podKey)
                  const health = getPodHealth(pod)
                  return (
                    <button
                      key={`${pod.namespace}-${pod.name}-${idx}`}
                      onClick={() => handlePodClick(pod)}
                      onContextMenu={(event) => {
                        if (!isDeleting) handlePodContextMenu(event, pod)
                      }}
                      disabled={isDeleting}
                      className={`p-3 bg-slate-700 rounded-lg transition-colors text-left ${
                        isDeleting ? 'opacity-60 cursor-not-allowed' : 'hover:bg-slate-600'
                      }`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <Box className="w-4 h-4 text-slate-400 flex-shrink-0" />
                        {isDeleting ? (
                          <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
                        ) : (
                          getHealthIcon(health.level, health.reason)
                        )}
                      </div>
                      <div className="text-sm font-medium text-white truncate" title={pod.name}>
                        {pod.name}
                      </div>
                      <div className="text-xs text-slate-400 mt-1">{pod.namespace}</div>
                      <div className={`text-xs mt-1 min-h-[16px] ${isDeleting ? 'text-amber-400' : 'text-slate-300'}`}>
                        {isDeleting ? tr('clusterView.podDeleting', 'Deleting...') : health.reason}
                      </div>
                      <div className="text-xs text-yellow-400 mt-1 min-h-[16px]">
                        {pod.restart_count > 0 &&
                          tr('clusterView.restarts', 'Restarts: {{count}}', { count: pod.restart_count })}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
            ))
          ) : (
            !searchQuery && !isLoading && allPods !== undefined && (
              <div className="card text-center py-12">
                <Box className="w-12 h-12 text-slate-600 mx-auto mb-4" />
                <p className="text-slate-400">{tr('clusterView.noPods', 'No pods found')}</p>
              </div>
            )
          )}
        </div>
      )}

      {/* Pod 우클릭 컨텍스트 메뉴 */}
      {podContextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={handleClosePodContextMenu}
            onContextMenu={(event) => {
              event.preventDefault()
              handleClosePodContextMenu()
            }}
          />
          <div
            className="fixed z-50 bg-slate-700 border border-slate-600 rounded-lg shadow-lg py-1 min-w-[140px]"
            style={{ left: `${podContextMenu.x}px`, top: `${podContextMenu.y}px` }}
            role="menu"
          >
            <button
              onClick={(event) => {
                event.stopPropagation()
                openDeleteModal(podContextMenu.pod)
                handleClosePodContextMenu()
              }}
              className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-slate-600 flex items-center gap-2"
              role="menuitem"
            >
              <Trash2 className="w-4 h-4" />
              삭제
            </button>
          </div>
        </>
      )}

      {/* Pod 상세 정보 모달 */}
      {selectedPod && (
        <ModalOverlay onClose={() => setSelectedPod(null)}>
          <div
            className="bg-slate-800 rounded-lg max-w-6xl w-full h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 모달 헤더 */}
            <div className="p-6 border-b border-slate-700 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Box className="w-6 h-6 text-primary-400" />
                <div>
                  <h2 className="text-xl font-bold text-white">{selectedPod.name}</h2>
                  <p className="text-sm text-slate-400">{selectedPod.namespace}</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedPod(null)}
                className="p-2 hover:bg-slate-700 rounded-lg transition-colors"
              >
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            {/* 탭 */}
            <div className="flex gap-2 px-6 pt-4 border-b border-slate-700">
              <button
                onClick={() => {
                  setShowLogs(false)
                  setShowManifest(false)
                  setShowDescribe(false)
                  setShowRbac(false)
                }}
                className={`px-4 py-2 font-medium transition-colors ${
                  !showLogs && !showManifest && !showDescribe && !showRbac
                    ? 'text-primary-400 border-b-2 border-primary-400'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {tr('clusterView.tabs.summary', 'Summary')}
              </button>
              <button
                onClick={() => {
                  // 메인 컨테이너 찾기
                  // 1. Pod 이름에서 해시값 제거
                  const podBaseName = selectedPod.name?.replace(/-[a-z0-9]{5,10}-[a-z0-9]{5}$/i, '').replace(/-[0-9]+$/i, '')
                  
                  // 2. Pod 베이스 이름과 일치하는 컨테이너 찾기
                  let mainContainer = selectedPod.containers?.find((c: any) => c.name === podBaseName)
                  
                  // 3. 못 찾으면 사이드카 패턴 제외하고 찾기
                  if (!mainContainer) {
                    const sidecarPatterns = ['istio-proxy', 'istio-init', 'envoy', 'linkerd-proxy', 'vault-agent']
                    mainContainer = selectedPod.containers?.find(
                      (c: any) => !sidecarPatterns.some(pattern => c.name.includes(pattern))
                    )
                  }
                  
                  // 메인 컨테이너로 전환
                  if (mainContainer) {
                    setSelectedContainer(mainContainer.name)
                  }
                  
                  setShowLogs(true)
                  setShowManifest(false)
                  setShowDescribe(false)
                  setShowRbac(false)
                }}
                className={`px-4 py-2 font-medium transition-colors flex items-center gap-2 ${
                  showLogs
                    ? 'text-primary-400 border-b-2 border-primary-400'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Terminal className="w-4 h-4" />
                {tr('clusterView.tabs.logs', 'Logs')}
              </button>
              <button
                onClick={() => {
                  setShowLogs(false)
                  setShowManifest(false)
                  setShowDescribe(true)
                  setShowRbac(false)
                }}
                className={`px-4 py-2 font-medium transition-colors flex items-center gap-2 ${
                  showDescribe
                    ? 'text-primary-400 border-b-2 border-primary-400'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <FileCode className="w-4 h-4" />
                {tr('clusterView.tabs.describe', 'Describe')}
              </button>
              <button
                onClick={() => {
                  setShowLogs(false)
                  setShowManifest(false)
                  setShowDescribe(false)
                  setShowRbac(true)
                }}
                className={`px-4 py-2 font-medium transition-colors flex items-center gap-2 ${
                  showRbac
                    ? 'text-primary-400 border-b-2 border-primary-400'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Shield className="w-4 h-4" />
                {tr('clusterView.tabs.rbac', 'RBAC')}
              </button>
              <button
                onClick={() => {
                  setShowLogs(false)
                  setShowManifest(true)
                  setShowDescribe(false)
                  setShowRbac(false)
                }}
                className={`px-4 py-2 font-medium transition-colors flex items-center gap-2 ${
                  showManifest
                    ? 'text-primary-400 border-b-2 border-primary-400'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <FileCode className="w-4 h-4" />
                {tr('clusterView.tabs.manifest', 'Manifest')}
              </button>
            </div>

            {/* 모달 내용 */}
            <div className="flex-1 overflow-y-auto p-6">
              {!showLogs && !showManifest && !showDescribe && !showRbac && (
                <div className="space-y-6">
                  {/* 기본 정보 */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-slate-400">{tr('clusterView.summary.kind', 'Kind')}</p>
                      <p className="text-white font-medium">{tr('clusterView.summary.kindPod', 'Pod')}</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-400">{tr('clusterView.summary.state', 'State')}</p>
                      <p className="text-white font-medium">{getPodHealth(selectedPod).reason}</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-400">{tr('clusterView.summary.node', 'Node')}</p>
                      <p className="text-white font-medium">{selectedPod.node || na}</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-400">{tr('clusterView.summary.createdAt', 'Created at')}</p>
                      <p className="text-white font-medium">
                        {selectedPod.created_at 
                          ? new Date(selectedPod.created_at).toLocaleString(locale, {
                              year: 'numeric',
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit'
                            })
                          : na}
                      </p>
                    </div>
                  </div>

                  {/* 컨테이너 상태 */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-lg font-bold text-white">
                        {tr('clusterView.containers.title', 'Container state')}
                      </h3>
                    </div>
                    {/* 컨테이너 검색창 */}
                    {selectedPod.containers && selectedPod.containers.length > 0 && (
                      <div className="relative mb-3">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <input
                          type="text"
                          placeholder={tr('clusterView.containers.searchPlaceholder', 'Search containers...')}
                          value={containerSearchQuery}
                          onChange={(e) => setContainerSearchQuery(e.target.value)}
                          className="w-full h-10 pl-10 pr-10 bg-slate-700 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors"
                        />
                        {containerSearchQuery && (
                          <button
                            onClick={() => setContainerSearchQuery('')}
                            className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 hover:bg-slate-600 rounded transition-colors"
                          >
                            <X className="w-4 h-4 text-slate-400" />
                          </button>
                        )}
                      </div>
                    )}
                    <div className="space-y-3">
                      {selectedPod.containers &&
                      selectedPod.containers.filter((container) => {
                        if (!containerSearchQuery.trim()) return true
                        const query = containerSearchQuery.toLowerCase()
                        return (
                          container.name.toLowerCase().includes(query) ||
                          (container.image && container.image.toLowerCase().includes(query))
                        )
                      }).length > 0 ? (
                        selectedPod.containers
                          .filter((container) => {
                            if (!containerSearchQuery.trim()) return true
                            const query = containerSearchQuery.toLowerCase()
                            return (
                              container.name.toLowerCase().includes(query) ||
                              (container.image && container.image.toLowerCase().includes(query))
                            )
                          })
                          .map((container) => {
                            // state 객체에서 상태 추출
                            let stateText = tr('clusterView.containers.state.unknown', 'Unknown')
                            let stateColor = 'text-slate-400'
                            
                            if (container.state && typeof container.state === 'object') {
                              const state = container.state as any
                              if (state.running) {
                                stateText = tr('clusterView.containers.state.running', 'Running')
                                stateColor = 'text-green-400'
                              } else if (state.waiting) {
                                stateText = tr('clusterView.containers.state.waiting', 'Waiting: {{reason}}', {
                                  reason: state.waiting.reason || tr('clusterView.containers.state.unknownReason', 'Unknown'),
                                })
                                stateColor = 'text-yellow-400'
                              } else if (state.terminated) {
                                stateText = tr('clusterView.containers.state.terminated', 'Terminated: {{reason}} (exit code: {{code}})', {
                                  reason: state.terminated.reason || tr('clusterView.containers.state.unknownReason', 'Unknown'),
                                  code: state.terminated.exit_code ?? emptyValue,
                                })
                                stateColor = 'text-red-400'
                              }
                            }
                            
                            return (
                              <div key={container.name} className="p-4 bg-slate-700 rounded-lg">
                                <div className="flex items-center justify-between mb-2">
                                  <div className="flex items-center gap-2">
                                    {container.ready ? (
                                      <CheckCircle className="w-5 h-5 text-green-400" />
                                    ) : (
                                      <XCircle className="w-5 h-5 text-red-400" />
                                    )}
                                    <span className="font-medium text-white">{container.name}</span>
                                  </div>
                                  <span className={`text-sm ${stateColor}`}>
                                    {stateText}
                                  </span>
                                </div>
                                <p className="text-sm text-slate-400 truncate" title={container.image}>
                                  {tr('clusterView.containers.imageLabel', 'Image')}: {container.image}
                                </p>
                                {container.restart_count > 0 && (
                                  <p className="text-sm text-yellow-400 mt-1">
                                    {tr('clusterView.containers.restartsLabel', 'Restarts')}: {container.restart_count}
                                  </p>
                                )}
                              </div>
                            )
                          })
                      ) : (
                        <div className="text-center py-8">
                          <p className="text-slate-400">
                            {containerSearchQuery
                              ? tr('clusterView.containers.noSearchResults', 'No results found')
                              : tr('clusterView.containers.none', 'No containers')}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Health */}
                  <div>
                    <h3 className="text-lg font-bold text-white mb-3">
                      {tr('clusterView.health.title', 'Health')}
                    </h3>
                    <div className="flex items-center gap-2">
                      {getHealthIcon(getPodHealth(selectedPod).level, getPodHealth(selectedPod).reason)}
                      <span className="text-white font-medium">
                        {getPodHealth(selectedPod).reason}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {showLogs && (
                <div className="flex flex-col h-full">
                  {/* 컨테이너 선택 및 다운로드 - 고정 */}
                  <div className="flex items-end gap-4 pb-4 flex-shrink-0 border-b border-slate-700">
                    {/* 컨테이너 선택 - 커스텀 드롭다운 */}
                    <div className="flex-1 relative" ref={containerDropdownRef}>
                      <label className="text-sm text-slate-400 mb-2 block">
                        {tr('clusterView.logs.containerLabel', 'Container')}
                      </label>
                      <button
                        onClick={() => setIsContainerDropdownOpen(!isContainerDropdownOpen)}
                        className="w-full h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 justify-between"
                      >
                        <span className="text-sm font-medium">
                          {selectedContainer || tr('clusterView.logs.selectContainer', 'Select container')}
                        </span>
                        <ChevronDown 
                          className={`w-4 h-4 text-slate-400 transition-transform ${
                            isContainerDropdownOpen ? 'rotate-180' : ''
                          }`}
                        />
                      </button>
                      
                      {isContainerDropdownOpen && (
                        <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50 max-h-[300px] overflow-y-auto">
                          {/* 컨테이너 드롭다운 검색창 */}
                          <div className="p-2 border-b border-slate-600 sticky top-0 bg-slate-700">
                            <div className="relative">
                              <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                              <input
                                type="text"
                                placeholder={tr('clusterView.logs.containerSearchPlaceholder', 'Search containers...')}
                                value={containerSearchQuery}
                                onChange={(e) => setContainerSearchQuery(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                className="w-full h-8 pl-8 pr-8 bg-slate-600 text-white rounded text-sm border border-slate-500 focus:outline-none focus:border-primary-500 transition-colors"
                              />
                              {containerSearchQuery && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setContainerSearchQuery('')
                                  }}
                                  className="absolute right-2 top-1/2 transform -translate-y-1/2 p-0.5 hover:bg-slate-500 rounded transition-colors"
                                >
                                  <X className="w-3 h-3 text-slate-400" />
                                </button>
                              )}
                            </div>
                          </div>
                          {selectedPod.containers &&
                          selectedPod.containers.filter((container) => {
                            if (!containerSearchQuery.trim()) return true
                            const query = containerSearchQuery.toLowerCase()
                            return container.name.toLowerCase().includes(query)
                          }).length > 0 ? (
                            selectedPod.containers
                              .filter((container) => {
                                if (!containerSearchQuery.trim()) return true
                                const query = containerSearchQuery.toLowerCase()
                                return container.name.toLowerCase().includes(query)
                              })
                              .map((container) => (
                                <button
                                  key={container.name}
                                  onClick={() => {
                                    setSelectedContainer(container.name)
                                    setIsContainerDropdownOpen(false)
                                  }}
                                  className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg last:rounded-b-lg"
                                >
                                  {selectedContainer === container.name && (
                                    <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                                  )}
                                  <span className={selectedContainer === container.name ? 'font-medium' : ''}>
                                    {container.name}
                                  </span>
                                </button>
                              ))
                          ) : (
                            <div className="p-4 text-center text-sm text-slate-400">
                              {containerSearchQuery
                                ? tr('clusterView.logs.noSearchResults', 'No results found')
                                : tr('clusterView.logs.noContainers', 'No containers')}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 다운로드 줄 수 선택 - 커스텀 드롭다운 */}
                    <div className="relative" ref={tailLinesDropdownRef}>
                      <label className="text-sm text-slate-400 mb-2 block">
                        {tr('clusterView.logs.downloadLines', 'Log download lines')}
                      </label>
                      <button
                        onClick={() => setIsTailLinesDropdownOpen(!isTailLinesDropdownOpen)}
                        className="h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 justify-between min-w-[150px]"
                      >
                        <span className="text-sm font-medium">
                          {tr('clusterView.logs.linesCount', '{{count}} lines', { count: downloadTailLines })}
                        </span>
                        <ChevronDown 
                          className={`w-4 h-4 text-slate-400 transition-transform ${
                            isTailLinesDropdownOpen ? 'rotate-180' : ''
                          }`}
                        />
                      </button>
                      
                      {isTailLinesDropdownOpen && (
                        <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50">
                          {[100, 500, 1000, 5000, 10000].map((lines) => (
                            <button
                              key={lines}
                              onClick={() => {
                                setDownloadTailLines(lines)
                                setIsTailLinesDropdownOpen(false)
                              }}
                              className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg last:rounded-b-lg"
                            >
                              {downloadTailLines === lines && (
                                <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                              )}
                              <span className={downloadTailLines === lines ? 'font-medium' : ''}>
                                {tr('clusterView.logs.linesCount', '{{count}} lines', { count: lines })}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 다운로드 버튼 */}
                    <div>
                      <label className="text-sm text-slate-400 mb-2 block invisible">
                        {tr('clusterView.logs.download', 'Download')}
                      </label>
                      <button
                        onClick={handleDownloadLogs}
                        disabled={isDownloading}
                        className="h-10 px-4 bg-primary-600 hover:bg-primary-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded-lg border border-primary-500 focus:outline-none focus:border-primary-400 transition-colors flex items-center gap-2"
                      >
                        <Download className="w-4 h-4" />
                        {isDownloading
                          ? tr('clusterView.logs.downloading', 'Downloading...')
                          : tr('clusterView.logs.download', 'Download')}
                      </button>
                    </div>
                  </div>

                  {/* 로그 - 스크롤 가능 */}
                  <div className="flex-1 bg-slate-900 rounded-lg p-4 mt-4 font-mono text-sm text-slate-300 overflow-x-auto overflow-y-auto">
                    <pre className="whitespace-pre-wrap break-words">
                      {logs || tr('clusterView.logs.loading', 'Loading logs...')}
                    </pre>
                    <div ref={logsEndRef} />
                  </div>
                </div>
              )}

              {showDescribe && describeData && (
                <div className="space-y-6">
                  {/* 기본 정보 */}
                  <div>
                    <h3 className="text-lg font-semibold text-white mb-4">
                      {tr('clusterView.describe.basicInfo', 'Basic information')}
                    </h3>
                    <div className="grid grid-cols-2 gap-4 bg-slate-800 rounded-lg p-4">
                      <div>
                        <p className="text-sm text-slate-400">{tr('clusterView.describe.name', 'Name')}</p>
                        <p className="text-white font-medium">{describeData.name}</p>
                      </div>
                      <div>
                        <p className="text-sm text-slate-400">{tr('clusterView.describe.namespace', 'Namespace')}</p>
                        <p className="text-white font-medium">{describeData.namespace}</p>
                      </div>
                      <div>
                        <p className="text-sm text-slate-400">{tr('clusterView.describe.node', 'Node')}</p>
                        <p className="text-white font-medium">{describeData.node || na}</p>
                      </div>
                      <div>
                        <p className="text-sm text-slate-400">{tr('clusterView.describe.phase', 'Phase')}</p>
                        <p className="text-white font-medium">{describeData.phase}</p>
                      </div>
                      <div>
                        <p className="text-sm text-slate-400">{tr('clusterView.describe.createdAt', 'Created at')}</p>
                        <p className="text-white font-medium">
                          {new Date(describeData.created_at).toLocaleString(locale)}
                        </p>
                      </div>
                      {describeData.pod_ip && (
                        <div>
                          <p className="text-sm text-slate-400">{tr('clusterView.describe.podIp', 'Pod IP')}</p>
                          <p className="text-white font-medium">{describeData.pod_ip}</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 레이블 */}
                  {describeData.labels && Object.keys(describeData.labels).length > 0 && (
                    <div>
                      <h3 className="text-lg font-semibold text-white mb-4">
                        {tr('clusterView.describe.labels', 'Labels')}
                      </h3>
                      <div className="bg-slate-800 rounded-lg p-4">
                        <div className="space-y-2">
                          {Object.entries(describeData.labels).map(([key, value]) => (
                            <div key={key} className="flex items-start gap-2">
                              <span className="text-slate-400 font-mono text-sm">{key}:</span>
                              <span className="text-white font-mono text-sm">{String(value)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* 컨테이너 */}
                  {describeData.containers && describeData.containers.length > 0 && (
                    <div>
                      <h3 className="text-lg font-semibold text-white mb-4">
                        {tr('clusterView.describe.containers', 'Containers')}
                      </h3>
                      <div className="space-y-4">
                        {describeData.containers.map((container: any, idx: number) => (
                          <div key={idx} className="bg-slate-800 rounded-lg p-4">
                            <div className="flex items-center justify-between mb-3">
                              <h4 className="text-white font-medium">{container.name}</h4>
                              <span className={`px-2 py-1 rounded text-xs font-medium ${
                                container.ready ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                              }`}>
                                {container.ready
                                  ? tr('clusterView.describe.containerReady', 'Ready')
                                  : tr('clusterView.describe.containerNotReady', 'Not Ready')}
                              </span>
                            </div>
                            <div className="space-y-2 text-sm">
                              <div>
                                <span className="text-slate-400">{tr('clusterView.describe.containerImage', 'Image')}: </span>
                                <span className="text-white font-mono">{container.image}</span>
                              </div>
                              <div>
                                <span className="text-slate-400">{tr('clusterView.describe.containerState', 'State')}: </span>
                                <span className="text-white">
                                  {container.state?.running
                                    ? tr('clusterView.containers.state.running', 'Running')
                                    : container.state?.waiting
                                      ? tr('clusterView.describe.containerWaiting', 'Waiting ({{reason}})', {
                                          reason: container.state.waiting.reason || tr('clusterView.containers.state.unknownReason', 'Unknown'),
                                        })
                                      : container.state?.terminated
                                        ? tr('clusterView.describe.containerTerminated', 'Terminated ({{reason}})', {
                                            reason: container.state.terminated.reason || tr('clusterView.containers.state.unknownReason', 'Unknown'),
                                          })
                                        : tr('clusterView.containers.state.unknown', 'Unknown')}
                                </span>
                              </div>
                              <div>
                                <span className="text-slate-400">{tr('clusterView.describe.containerRestarts', 'Restart Count')}: </span>
                                <span className="text-white">{container.restart_count}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Conditions */}
                  {describeData.conditions && describeData.conditions.length > 0 && (
                    <div>
                      <h3 className="text-lg font-semibold text-white mb-4">
                        {tr('clusterView.describe.conditions', 'Conditions')}
                      </h3>
                      <div className="bg-slate-800 rounded-lg overflow-hidden">
                        <table className="w-full">
                          <thead className="bg-slate-700">
                            <tr>
                              <th className="px-4 py-2 text-left text-sm font-medium text-slate-300">
                                {tr('clusterView.describe.conditionsType', 'Type')}
                              </th>
                              <th className="px-4 py-2 text-left text-sm font-medium text-slate-300">
                                {tr('clusterView.describe.conditionsStatus', 'Status')}
                              </th>
                              <th className="px-4 py-2 text-left text-sm font-medium text-slate-300">
                                {tr('clusterView.describe.conditionsLastTransition', 'Last Transition')}
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-700">
                            {describeData.conditions.map((condition: any, idx: number) => (
                              <tr key={idx}>
                                <td className="px-4 py-2 text-sm text-white">{condition.type}</td>
                                <td className="px-4 py-2 text-sm">
                                  <span className={`px-2 py-1 rounded text-xs font-medium ${
                                    condition.status === 'True' ? 'bg-green-500/20 text-green-400' : 'bg-slate-600 text-slate-300'
                                  }`}>
                                    {condition.status}
                                  </span>
                                </td>
                                <td className="px-4 py-2 text-sm text-slate-300">
                                  {new Date(condition.last_transition_time).toLocaleString(locale)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Events */}
                  {describeData.events && describeData.events.length > 0 && (
                    <div>
                      <h3 className="text-lg font-semibold text-white mb-4">
                        {tr('clusterView.describe.events', 'Events')}
                      </h3>
                      <div className="bg-slate-800 rounded-lg p-4 space-y-3 max-h-96 overflow-y-auto">
                        {describeData.events.map((event: any, idx: number) => (
                          <div key={idx} className="border-l-2 border-slate-600 pl-3">
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <div className="flex items-center gap-2">
                                  <span className={`px-2 py-1 rounded text-xs font-medium ${
                                    event.type === 'Normal' ? 'bg-blue-500/20 text-blue-400' : 'bg-yellow-500/20 text-yellow-400'
                                  }`}>
                                    {event.type}
                                  </span>
                                  <span className="text-white text-sm font-medium">{event.reason}</span>
                                </div>
                                <p className="text-slate-300 text-sm mt-1">{event.message}</p>
                              </div>
                              <span className="text-slate-400 text-xs whitespace-nowrap ml-4">
                                {new Date(event.last_timestamp).toLocaleString(locale)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {showRbac && (
                <div className="space-y-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <h3 className="text-lg font-semibold text-white">
                        {tr('clusterView.rbac.title', 'RBAC')}
                      </h3>
                      <span
                        className="px-2 py-1 rounded bg-slate-700 text-slate-200 text-xs border border-slate-600"
                        title={tr(
                          'clusterView.rbac.tooltip',
                          'This view summarizes RBAC (Role/RoleBinding/ClusterRole/ClusterRoleBinding) only. Actual allow/deny can differ due to Admission (OPA/Gatekeeper), NetworkPolicy/CNI, and controller behavior.',
                        )}
                      >
                        {tr('clusterView.rbac.tooltipLabel', 'Note: RBAC only')}
                      </span>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <label className="flex items-center gap-2 text-xs text-slate-300 select-none cursor-pointer">
                        <input
                          type="checkbox"
                          checked={includeAuthenticatedGroup}
                          onChange={(e) => setIncludeAuthenticatedGroup(e.target.checked)}
                        />
                        <span>
                          {tr('clusterView.rbac.includeAuthenticated', 'Include broad (system:authenticated)')}
                        </span>
                      </label>
                      <p className="text-slate-500 text-xs text-right max-w-[520px] leading-relaxed">
                        {tr(
                          'clusterView.rbac.includeAuthenticatedHint',
                          'When checked, bindings matched by system:authenticated will be included.',
                        )}
                      </p>
                    </div>
                  </div>

                  {isRbacLoading && (
                    <div className="text-slate-400">{tr('clusterView.rbac.loading', 'Loading RBAC data...')}</div>
                  )}

                  {rbacError && (
                    <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                      <p className="text-red-300 text-sm">
                        {tr('clusterView.rbac.loadError', 'Failed to load RBAC data. (This may be due to permissions or API errors.)')}
                      </p>
                    </div>
                  )}

                  {rbacData && (
                    <div className="space-y-6">
                      <div className="bg-slate-800 rounded-lg p-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <p className="text-sm text-slate-400">
                              {tr('clusterView.rbac.serviceAccountLabel', 'ServiceAccount')}
                            </p>
                            <p className="text-white font-medium">
                              {rbacData.service_account?.name || tr('clusterView.rbac.defaultName', 'default')}
                              {rbacData.service_account?.name === 'default' && (
                                <span className="ml-2 text-xs text-slate-400">
                                  {tr('clusterView.rbac.defaultLabel', '(default)')}
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-slate-500 mt-1 break-words">
                              system:serviceaccount:{rbacData.pod.namespace}:{rbacData.service_account?.name || tr('clusterView.rbac.defaultName', 'default')}
                            </p>
                          </div>
                          <div>
                            <p className="text-sm text-slate-400">
                              {tr('clusterView.rbac.bindingsLabel', 'Bindings')}
                            </p>
                            <p className="text-white font-medium">
                              {(() => {
                                const roleAll = (rbacData.role_bindings || []) as any[]
                                const roleAuthOnly = roleAll.filter(isAuthenticatedOnlyGrant).length
                                const clusterAll = (rbacData.cluster_role_bindings || []) as any[]
                                const clusterAuthOnly = clusterAll.filter(isAuthenticatedOnlyGrant).length

                                return (
                                  <>
                                    {tr('clusterView.rbac.roleBindingCount', 'RoleBinding {{count}}', { count: roleAll.length })}
                                    {includeAuthenticatedGroup && roleAuthOnly > 0 && (
                                      <span className="text-slate-400 text-sm">
                                        {' '}
                                        {tr('clusterView.rbac.broadCount', '(broad {{count}})', { count: roleAuthOnly })}
                                      </span>
                                    )}
                                    {' '}
                                    · {tr('clusterView.rbac.clusterRoleBindingCount', 'ClusterRoleBinding {{count}}', { count: clusterAll.length })}
                                    {includeAuthenticatedGroup && clusterAuthOnly > 0 && (
                                      <span className="text-slate-400 text-sm">
                                        {' '}
                                        {tr('clusterView.rbac.broadCount', '(broad {{count}})', { count: clusterAuthOnly })}
                                      </span>
                                    )}
                                  </>
                                )
                              })()}
                            </p>
                          </div>
                        </div>

                        {Array.isArray(rbacData.errors) && rbacData.errors.length > 0 && (
                          <div className="mt-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                            <p className="text-yellow-300 text-sm font-medium mb-2">
                              {tr('clusterView.rbac.warningTitle', 'Warning')}
                            </p>
                            <ul className="text-yellow-200/90 text-sm list-disc pl-5 space-y-1">
                              {rbacData.errors.map((e: string, idx: number) => (
                                <li key={idx} className="break-words">{e}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>

                      {(() => {
                        const { resourceItems, nonResourceItems } = buildRbacPermissionSummary(rbacData)
                        const total = resourceItems.length + nonResourceItems.length
                        return (
                          <div className="bg-slate-800 rounded-lg p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <h4 className="text-white font-semibold">
                                  {tr('clusterView.rbac.summary.title', 'Permission summary')}
                                </h4>
                                <p className="text-slate-400 text-xs mt-1">
                                  {tr('clusterView.rbac.summary.subtitle', 'Aggregated from displayed Role/ClusterRole rules.')}
                                  {includeAuthenticatedGroup
                                    ? ` ${tr('clusterView.rbac.summary.includeBroad', '(including broad)')}`
                                    : ` ${tr('clusterView.rbac.summary.excludeBroad', '(excluding broad)')}`}
                                </p>
                              </div>
                              <div className="text-slate-300 text-sm flex-shrink-0">
                                {tr('clusterView.rbac.summary.total', '{{count}} items', { count: total })}
                              </div>
                            </div>

                            {total === 0 ? (
                              <div className="text-slate-400 text-sm mt-3">
                                {tr('clusterView.rbac.summary.none', '(none)')}
                              </div>
                            ) : (
                              <div className="mt-3 space-y-4">
                                {resourceItems.length > 0 && (
                                  <div>
                                    <p className="text-slate-300 text-sm font-medium mb-2">
                                      {tr('clusterView.rbac.summary.resources', 'Resources')}
                                    </p>
                                    <div className="overflow-x-auto">
                                      <table className="w-full min-w-[720px] text-sm table-auto">
                                        <colgroup>
                                          <col className="w-1/3" />
                                          <col className="w-1/3" />
                                          <col className="w-1/3" />
                                        </colgroup>
                                        <thead className="text-slate-400">
                                          <tr>
                                            <th className="text-left py-2 pr-4">
                                              {tr('clusterView.rbac.summary.table.apiGroup', 'apiGroup')}
                                            </th>
                                            <th className="text-left py-2 pr-4">
                                              {tr('clusterView.rbac.summary.table.resource', 'resource')}
                                            </th>
                                            <th className="text-left py-2 pr-4">
                                              {tr('clusterView.rbac.summary.table.verbs', 'verbs')}
                                            </th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-700">
                                          {resourceItems.map((it: any, idx: number) => (
                                            <tr key={idx}>
                                              <td className="py-2 pr-4 text-slate-300 font-mono break-words">{it.apiGroup}</td>
                                              <td className="py-2 pr-4 text-white font-mono break-words">
                                                {it.resource}
                                                {it.resourceNames?.length ? (
                                                  <span className="text-slate-400 text-xs ml-2">
                                                    {tr('clusterView.rbac.summary.resourceNames', '(names: {{names}})', {
                                                      names: it.resourceNames.join(', '),
                                                    })}
                                                  </span>
                                                ) : null}
                                              </td>
                                              <td className="py-2 pr-4 text-slate-200 font-mono break-words">
                                                {it.verbsList.join(', ') || tr('clusterView.rbac.summary.none', '(none)')}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                )}

                                {nonResourceItems.length > 0 && (
                                  <div>
                                    <p className="text-slate-300 text-sm font-medium mb-2">
                                      {tr('clusterView.rbac.summary.nonResourceUrls', 'Non-resource URLs')}
                                    </p>
                                    <div className="overflow-x-auto">
                                      <table className="w-full min-w-[720px] text-sm table-auto">
                                        <colgroup>
                                          <col className="w-1/2" />
                                          <col className="w-1/2" />
                                        </colgroup>
                                        <thead className="text-slate-400">
                                          <tr>
                                            <th className="text-left py-2 pr-4">
                                              {tr('clusterView.rbac.summary.table.url', 'url')}
                                            </th>
                                            <th className="text-left py-2 pr-4">
                                              {tr('clusterView.rbac.summary.table.verbs', 'verbs')}
                                            </th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-700">
                                          {nonResourceItems.map((it: any, idx: number) => (
                                            <tr key={idx}>
                                              <td className="py-2 pr-4 text-white font-mono break-words">{it.nonResourceURL}</td>
                                              <td className="py-2 pr-4 text-slate-200 font-mono break-words">
                                                {it.verbsList.join(', ') || tr('clusterView.rbac.summary.none', '(none)')}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })()}

                      <div className="space-y-3">
                        <h4 className="text-white font-semibold">
                          {tr('clusterView.rbac.roleBindingsTitle', 'RoleBindings (Namespace)')}
                        </h4>
                        {(() => {
                          const all = (rbacData.role_bindings || []) as any[]
                          const authenticatedOnly = all.filter(isAuthenticatedOnlyGrant)
                          const normal = all.filter((b) => !isAuthenticatedOnlyGrant(b))

                          return (
                            <>
                              {normal.length ? (
                                <div className="space-y-2">
                                  {normal.map((b: any) => (
                                    <div key={`rb-${b.name}`} className="bg-slate-800 rounded-lg p-4">
                                      <div className="flex items-start justify-between gap-4">
                                        <div className="min-w-0">
                                          <p className="text-white font-medium break-words">{b.name}</p>
                                          <p className="text-sm text-slate-400 break-words">
                                            {b.role_ref?.kind}:{b.role_ref?.name}
                                          </p>
                                          {getBindingMatchPathText(b) && (
                                            <p className="text-xs text-slate-500 mt-1 break-words">
                                              {tr('clusterView.rbac.matchingLabel', 'Matching')}: {getBindingMatchPathText(b)}
                                            </p>
                                          )}
                                        </div>
                                        <div className="text-right flex-shrink-0">
                                          <p className="text-sm text-slate-300">
                                            {tr('clusterView.rbac.rulesCount', 'rules: {{count}}', { count: b.resolved_role?.rules?.length ?? 0 })}
                                          </p>
                                          {b.resolved_role?.error && (
                                            <p className="text-xs text-yellow-300">{tr('clusterView.rbac.resolveFailed', 'resolve failed')}</p>
                                          )}
                                        </div>
                                      </div>

                                      <div className="mt-4 space-y-3">
                                        <div>
                                          <p className="text-sm text-slate-400 mb-1">{tr('clusterView.rbac.subjects', 'Subjects')}</p>
                                          <div className="flex flex-wrap gap-2">
                                            {(b.subjects || []).map((s: any, idx: number) => (
                                              <span
                                                key={idx}
                                                className="px-2 py-1 rounded bg-slate-700 text-slate-200 text-xs break-words"
                                                title={`${s.kind || ''} ${s.namespace ? `${s.namespace}/` : ''}${s.name || ''}`}
                                              >
                                                {s.kind}:{s.namespace ? `${s.namespace}/` : ''}{s.name}
                                              </span>
                                            ))}
                                          </div>
                                        </div>

                                        {b.resolved_role?.error ? (
                                          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                                            <p className="text-yellow-200 text-sm break-words">{b.resolved_role.error}</p>
                                          </div>
                                        ) : (
                                          <div>
                                            <p className="text-sm text-slate-400 mb-2">{tr('clusterView.rbac.rulesLabel', 'Rules')}</p>
                                            <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                                              {(b.resolved_role?.rules || []).map((r: any, idx: number) => (
                                                <div key={idx} className="bg-slate-900 rounded-lg p-3 text-sm">
                                                  <div className="flex flex-col gap-1">
                                                    <div className="flex flex-wrap gap-2">
                                                      <span className="text-slate-400">{tr('clusterView.rbac.verbsLabel', 'verbs')}</span>
                                                      <span className="text-white font-mono break-words">{(r.verbs || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                                    </div>
                                                    <div className="flex flex-wrap gap-2">
                                                      <span className="text-slate-400">{tr('clusterView.rbac.resourcesLabel', 'resources')}</span>
                                                      <span className="text-white font-mono break-words">{(r.resources || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                                      <span className="text-slate-500">{tr('clusterView.rbac.apiGroupsLabel', 'apiGroups')}</span>
                                                      <span className="text-slate-200 font-mono break-words">{(r.api_groups || []).join(', ') || '(core)'}</span>
                                                    </div>
                                                    {(r.non_resource_urls || []).length > 0 && (
                                                      <div className="flex flex-wrap gap-2">
                                                        <span className="text-slate-400">{tr('clusterView.rbac.nonResourceUrlsLabel', 'nonResourceURLs')}</span>
                                                        <span className="text-white font-mono break-words">{(r.non_resource_urls || []).join(', ')}</span>
                                                      </div>
                                                    )}
                                                    {(r.resource_names || []).length > 0 && (
                                                      <div className="flex flex-wrap gap-2">
                                                        <span className="text-slate-400">{tr('clusterView.rbac.resourceNamesLabel', 'resourceNames')}</span>
                                                        <span className="text-white font-mono break-words">{(r.resource_names || []).join(', ')}</span>
                                                      </div>
                                                    )}
                                                  </div>
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="text-slate-400 text-sm">{tr('clusterView.rbac.none', '(none)')}</div>
                              )}

                              {includeAuthenticatedGroup && authenticatedOnly.length > 0 && (
                                <div className="bg-slate-800 rounded-lg p-4 border border-yellow-500/30">
                                  <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0">
                                      <p className="text-yellow-200 font-medium break-words">
                                        {tr('clusterView.rbac.broadRoleBindingTitle', 'Broad RoleBinding {{count}} (system:authenticated)', {
                                          count: authenticatedOnly.length,
                                        })}
                                      </p>
                                      <p className="text-xs text-slate-400 mt-1">
                                        {tr(
                                          'clusterView.rbac.broadRoleBindingHint',
                                          'This can include most authenticated subjects and may overstate the actual permissions for this pod.',
                                        )}
                                      </p>
                                    </div>
                                    <span className="text-xs text-yellow-300 flex-shrink-0">
                                      {tr('clusterView.rbac.broadLabel', 'Broad')}
                                    </span>
                                  </div>

                                  <div className="mt-3 space-y-2">
                                    {authenticatedOnly.map((b: any) => (
                                      <div key={`rb-broad-${b.name}`} className="bg-slate-900 rounded-lg p-4">
                                        <div className="flex items-start justify-between gap-4">
                                          <div className="min-w-0">
                                            <p className="text-white font-medium break-words">{b.name}</p>
                                            <p className="text-sm text-slate-400 break-words">
                                              {b.role_ref?.kind}:{b.role_ref?.name}
                                            </p>
                                            {getBindingMatchPathText(b) && (
                                              <p className="text-xs text-slate-500 mt-1 break-words">
                                                {tr('clusterView.rbac.matchingLabel', 'Matching')}: {getBindingMatchPathText(b)}
                                              </p>
                                            )}
                                          </div>
                                          <div className="text-right flex-shrink-0">
                                            <p className="text-sm text-slate-300">
                                              {tr('clusterView.rbac.rulesCount', 'rules: {{count}}', { count: b.resolved_role?.rules?.length ?? 0 })}
                                            </p>
                                            <p className="text-xs text-yellow-300">{tr('clusterView.rbac.broadLabel', 'Broad')}</p>
                                            {b.resolved_role?.error && (
                                              <p className="text-xs text-yellow-300">{tr('clusterView.rbac.resolveFailed', 'resolve failed')}</p>
                                            )}
                                          </div>
                                        </div>

                                        <div className="mt-4 space-y-3">
                                          <div>
                                            <p className="text-sm text-slate-400 mb-1">{tr('clusterView.rbac.subjects', 'Subjects')}</p>
                                            <div className="flex flex-wrap gap-2">
                                              {(b.subjects || []).map((s: any, idx: number) => (
                                                <span
                                                  key={idx}
                                                  className="px-2 py-1 rounded bg-slate-700 text-slate-200 text-xs break-words"
                                                  title={`${s.kind || ''} ${s.namespace ? `${s.namespace}/` : ''}${s.name || ''}`}
                                                >
                                                  {s.kind}:{s.namespace ? `${s.namespace}/` : ''}{s.name}
                                                </span>
                                              ))}
                                            </div>
                                          </div>

                                          {b.resolved_role?.error ? (
                                            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                                              <p className="text-yellow-200 text-sm break-words">{b.resolved_role.error}</p>
                                            </div>
                                          ) : (
                                            <div>
                                              <p className="text-sm text-slate-400 mb-2">{tr('clusterView.rbac.rulesLabel', 'Rules')}</p>
                                              <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                                                {(b.resolved_role?.rules || []).map((r: any, idx: number) => (
                                                  <div key={idx} className="bg-slate-800 rounded-lg p-3 text-sm">
                                                    <div className="flex flex-col gap-1">
                                                      <div className="flex flex-wrap gap-2">
                                                        <span className="text-slate-400">{tr('clusterView.rbac.verbsLabel', 'verbs')}</span>
                                                        <span className="text-white font-mono break-words">{(r.verbs || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                                      </div>
                                                      <div className="flex flex-wrap gap-2">
                                                        <span className="text-slate-400">{tr('clusterView.rbac.resourcesLabel', 'resources')}</span>
                                                        <span className="text-white font-mono break-words">{(r.resources || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                                        <span className="text-slate-500">{tr('clusterView.rbac.apiGroupsLabel', 'apiGroups')}</span>
                                                        <span className="text-slate-200 font-mono break-words">{(r.api_groups || []).join(', ') || '(core)'}</span>
                                                      </div>
                                                    </div>
                                                  </div>
                                                ))}
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </>
                          )
                        })()}
                      </div>

                      <div className="space-y-3">
                        <h4 className="text-white font-semibold">
                          {tr('clusterView.rbac.clusterRoleBindingsTitle', 'ClusterRoleBindings (Cluster)')}
                        </h4>
                        {(() => {
                          const all = (rbacData.cluster_role_bindings || []) as any[]
                          const authenticatedOnly = all.filter(isAuthenticatedOnlyGrant)
                          const normal = all.filter((b) => !isAuthenticatedOnlyGrant(b))

                          return (
                            <>
                              {normal.length ? (
                                <div className="space-y-2">
                                  {normal.map((b: any) => (
                                    <div key={`crb-${b.name}`} className="bg-slate-800 rounded-lg p-4">
                                      <div className="flex items-start justify-between gap-4">
                                        <div className="min-w-0">
                                          <p className="text-white font-medium break-words">{b.name}</p>
                                          <p className="text-sm text-slate-400 break-words">
                                            {b.role_ref?.kind}:{b.role_ref?.name}
                                          </p>
                                          {getBindingMatchPathText(b) && (
                                            <p className="text-xs text-slate-500 mt-1 break-words">
                                              {tr('clusterView.rbac.matchingLabel', 'Matching')}: {getBindingMatchPathText(b)}
                                            </p>
                                          )}
                                        </div>
                                        <div className="text-right flex-shrink-0">
                                          <p className="text-sm text-slate-300">
                                            {tr('clusterView.rbac.rulesCount', 'rules: {{count}}', { count: b.resolved_role?.rules?.length ?? 0 })}
                                          </p>
                                          {b.resolved_role?.error && (
                                            <p className="text-xs text-yellow-300">{tr('clusterView.rbac.resolveFailed', 'resolve failed')}</p>
                                          )}
                                        </div>
                                      </div>

                                      <div className="mt-4 space-y-3">
                                        <div>
                                          <p className="text-sm text-slate-400 mb-1">{tr('clusterView.rbac.subjects', 'Subjects')}</p>
                                          <div className="flex flex-wrap gap-2">
                                            {(b.subjects || []).map((s: any, idx: number) => (
                                              <span
                                                key={idx}
                                                className="px-2 py-1 rounded bg-slate-700 text-slate-200 text-xs break-words"
                                                title={`${s.kind || ''} ${s.namespace ? `${s.namespace}/` : ''}${s.name || ''}`}
                                              >
                                                {s.kind}:{s.namespace ? `${s.namespace}/` : ''}{s.name}
                                              </span>
                                            ))}
                                          </div>
                                        </div>

                                        {b.resolved_role?.error ? (
                                          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                                            <p className="text-yellow-200 text-sm break-words">{b.resolved_role.error}</p>
                                          </div>
                                        ) : (
                                          <div>
                                            <p className="text-sm text-slate-400 mb-2">{tr('clusterView.rbac.rulesLabel', 'Rules')}</p>
                                            <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                                              {(b.resolved_role?.rules || []).map((r: any, idx: number) => (
                                                <div key={idx} className="bg-slate-900 rounded-lg p-3 text-sm">
                                                  <div className="flex flex-col gap-1">
                                                    <div className="flex flex-wrap gap-2">
                                                      <span className="text-slate-400">{tr('clusterView.rbac.verbsLabel', 'verbs')}</span>
                                                      <span className="text-white font-mono break-words">{(r.verbs || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                                    </div>
                                                    <div className="flex flex-wrap gap-2">
                                                      <span className="text-slate-400">{tr('clusterView.rbac.resourcesLabel', 'resources')}</span>
                                                      <span className="text-white font-mono break-words">{(r.resources || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                                      <span className="text-slate-500">{tr('clusterView.rbac.apiGroupsLabel', 'apiGroups')}</span>
                                                      <span className="text-slate-200 font-mono break-words">{(r.api_groups || []).join(', ') || '(core)'}</span>
                                                    </div>
                                                    {(r.non_resource_urls || []).length > 0 && (
                                                      <div className="flex flex-wrap gap-2">
                                                        <span className="text-slate-400">{tr('clusterView.rbac.nonResourceUrlsLabel', 'nonResourceURLs')}</span>
                                                        <span className="text-white font-mono break-words">{(r.non_resource_urls || []).join(', ')}</span>
                                                      </div>
                                                    )}
                                                    {(r.resource_names || []).length > 0 && (
                                                      <div className="flex flex-wrap gap-2">
                                                        <span className="text-slate-400">{tr('clusterView.rbac.resourceNamesLabel', 'resourceNames')}</span>
                                                        <span className="text-white font-mono break-words">{(r.resource_names || []).join(', ')}</span>
                                                      </div>
                                                    )}
                                                  </div>
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="text-slate-400 text-sm">{tr('clusterView.rbac.none', '(none)')}</div>
                              )}

                              {includeAuthenticatedGroup && authenticatedOnly.length > 0 && (
                                <div className="bg-slate-800 rounded-lg p-4 border border-yellow-500/30">
                                  <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0">
                                      <p className="text-yellow-200 font-medium break-words">
                                        {tr('clusterView.rbac.broadClusterRoleBindingTitle', 'Broad ClusterRoleBinding {{count}} (system:authenticated)', {
                                          count: authenticatedOnly.length,
                                        })}
                                      </p>
                                      <p className="text-xs text-slate-400 mt-1">
                                        {tr(
                                          'clusterView.rbac.broadClusterRoleBindingHint',
                                          'This can include all authenticated subjects and may add noise. Use only for troubleshooting.',
                                        )}
                                      </p>
                                    </div>
                                    <span className="text-xs text-yellow-300 flex-shrink-0">
                                      {tr('clusterView.rbac.broadLabel', 'Broad')}
                                    </span>
                                  </div>

                                  <div className="mt-3 space-y-2">
                                    {authenticatedOnly.map((b: any) => (
                                      <div key={`crb-broad-${b.name}`} className="bg-slate-900 rounded-lg p-4">
                                        <div className="flex items-start justify-between gap-4">
                                          <div className="min-w-0">
                                            <p className="text-white font-medium break-words">{b.name}</p>
                                            <p className="text-sm text-slate-400 break-words">
                                              {b.role_ref?.kind}:{b.role_ref?.name}
                                            </p>
                                            {getBindingMatchPathText(b) && (
                                              <p className="text-xs text-slate-500 mt-1 break-words">
                                                {tr('clusterView.rbac.matchingLabel', 'Matching')}: {getBindingMatchPathText(b)}
                                              </p>
                                            )}
                                          </div>
                                          <div className="text-right flex-shrink-0">
                                            <p className="text-sm text-slate-300">
                                              {tr('clusterView.rbac.rulesCount', 'rules: {{count}}', { count: b.resolved_role?.rules?.length ?? 0 })}
                                            </p>
                                            <p className="text-xs text-yellow-300">{tr('clusterView.rbac.broadLabel', 'Broad')}</p>
                                            {b.resolved_role?.error && (
                                              <p className="text-xs text-yellow-300">{tr('clusterView.rbac.resolveFailed', 'resolve failed')}</p>
                                            )}
                                          </div>
                                        </div>

                                        <div className="mt-4 space-y-3">
                                          <div>
                                            <p className="text-sm text-slate-400 mb-1">{tr('clusterView.rbac.subjects', 'Subjects')}</p>
                                            <div className="flex flex-wrap gap-2">
                                              {(b.subjects || []).map((s: any, idx: number) => (
                                                <span
                                                  key={idx}
                                                  className="px-2 py-1 rounded bg-slate-700 text-slate-200 text-xs break-words"
                                                  title={`${s.kind || ''} ${s.namespace ? `${s.namespace}/` : ''}${s.name || ''}`}
                                                >
                                                  {s.kind}:{s.namespace ? `${s.namespace}/` : ''}{s.name}
                                                </span>
                                              ))}
                                            </div>
                                          </div>

                                          {b.resolved_role?.error ? (
                                            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                                              <p className="text-yellow-200 text-sm break-words">{b.resolved_role.error}</p>
                                            </div>
                                          ) : (
                                            <div>
                                              <p className="text-sm text-slate-400 mb-2">{tr('clusterView.rbac.rulesLabel', 'Rules')}</p>
                                              <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                                                {(b.resolved_role?.rules || []).map((r: any, idx: number) => (
                                                  <div key={idx} className="bg-slate-800 rounded-lg p-3 text-sm">
                                                    <div className="flex flex-col gap-1">
                                                      <div className="flex flex-wrap gap-2">
                                                        <span className="text-slate-400">{tr('clusterView.rbac.verbsLabel', 'verbs')}</span>
                                                        <span className="text-white font-mono break-words">{(r.verbs || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                                      </div>
                                                      <div className="flex flex-wrap gap-2">
                                                        <span className="text-slate-400">{tr('clusterView.rbac.resourcesLabel', 'resources')}</span>
                                                        <span className="text-white font-mono break-words">{(r.resources || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                                        <span className="text-slate-500">{tr('clusterView.rbac.apiGroupsLabel', 'apiGroups')}</span>
                                                        <span className="text-slate-200 font-mono break-words">{(r.api_groups || []).join(', ') || '(core)'}</span>
                                                      </div>
                                                    </div>
                                                  </div>
                                                ))}
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </>
                          )
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {showManifest && (
                <div className="h-full bg-slate-900 rounded-lg p-4 font-mono text-sm text-slate-300 overflow-x-auto overflow-y-auto">
                  <pre>{manifest || tr('clusterView.manifest.loading', 'Loading...')}</pre>
                </div>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}

      {deleteTargetPod && (
        <ModalOverlay onClose={closeDeleteModal}>
          <div
            className="bg-slate-800 rounded-lg w-full max-w-lg p-6"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Pod 삭제"
          >
            <h2 className="text-xl font-bold text-white mb-4">Pod 삭제</h2>
            <p className="text-slate-300 leading-relaxed">
              <strong>Pod</strong>{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-100">
                {deleteTargetPod.name}
              </kbd>
              를 삭제할까요?
            </p>
            <p className="text-slate-400 mt-3">
              리소스 삭제는 <strong>위험</strong>할 수 있습니다. 삭제 효과를 충분히 이해한 뒤 진행하세요.
              가능하면 변경 전 다른 사람의 리뷰를 받는 것을 권장합니다.
            </p>

            <div className="mt-4 flex items-center gap-2">
              <input
                id="force-delete-checkbox"
                type="checkbox"
                checked={deleteForce}
                onChange={(event) => setDeleteForce(event.target.checked)}
                className="w-4 h-4 rounded border-slate-500 bg-slate-700"
              />
              <label htmlFor="force-delete-checkbox" className="text-sm text-slate-300">
                강제 삭제
              </label>
              <HelpCircle
                className="w-4 h-4 text-slate-400"
                title="체크 시 grace period를 무시하고 즉시 삭제합니다"
              />
            </div>

            {deleteError && (
              <div className="mt-4 text-sm text-red-400">{deleteError}</div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeDeleteModal}
                disabled={isDeletingPod}
              >
                취소
              </button>
              <button
                type="button"
                className="btn bg-red-600 hover:bg-red-700 text-white disabled:opacity-60"
                onClick={handleDeletePod}
                disabled={isDeletingPod}
              >
                확인
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
