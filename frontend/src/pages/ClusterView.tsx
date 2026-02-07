import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/services/api'
import { getAuthHeaders } from '@/services/auth'
import { ModalOverlay } from '@/components/ModalOverlay'
import { 
  Server, 
  Box, 
  CheckCircle, 
  XCircle, 
  AlertCircle,
  RefreshCw,
  X,
  FileCode,
  Terminal,
  ChevronDown,
  Search,
  Download
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
    state: string
    restart_count: number
  }>
}

export default function ClusterView() {
  const queryClient = useQueryClient()
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [selectedPod, setSelectedPod] = useState<PodDetail | null>(null)
  const [selectedContainer, setSelectedContainer] = useState<string>('')
  const [showLogs, setShowLogs] = useState(false)
  const [showManifest, setShowManifest] = useState(false)
  const [showDescribe, setShowDescribe] = useState(false)
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
  const logsEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const namespaceDropdownRef = useRef<HTMLDivElement>(null)
  const containerDropdownRef = useRef<HTMLDivElement>(null)
  const tailLinesDropdownRef = useRef<HTMLDivElement>(null)

  // ESC 키로 모달 닫기
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedPod) {
        setSelectedPod(null)
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [selectedPod])

  // 네임스페이스 목록
  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(false), // 자동 갱신은 캐시 사용
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
        const wsUrl = `${protocol}//${window.location.hostname}:8000/api/v1/cluster/namespaces/${selectedPod.namespace}/pods/${selectedPod.name}/logs/ws?container=${selectedContainer}&tail_lines=100`
        
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
          setLogs((prev) => prev + '\n\n로그 스트리밍 중 오류가 발생했습니다.')
        }
        
        ws.onclose = () => {
          console.log('WebSocket closed')
          setIsStreamingLogs(false)
        }
        
      } catch (error: any) {
        console.error('Error creating WebSocket:', error)
        setLogs(`로그를 불러오는데 실패했습니다.\n\n에러: ${error.message}`)
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

  const getHealthIcon = (status: string, phase: string) => {
    if (phase === 'Running' && status === 'Running') {
      return <CheckCircle className="w-5 h-5 text-green-400" />
    } else if (phase === 'Failed' || status === 'CrashLoopBackOff') {
      return <XCircle className="w-5 h-5 text-red-400" />
    } else {
      return <AlertCircle className="w-5 h-5 text-yellow-400" />
    }
  }

  const handlePodClick = async (pod: any) => {
    // Pod 상세 정보 조회
    const response = await fetch(
      `/api/v1/cluster/namespaces/${pod.namespace}/pods/${pod.name}/describe`,
      { headers: { ...getAuthHeaders() } }
    )
    const detail = await response.json()
    console.log('Pod detail response:', detail) // 디버깅용
    console.log('Phase:', detail.phase, 'Status:', detail.status)
    console.log('Created at:', detail.created_at)
    console.log('Node:', detail.node)
    
    // 탭 상태 초기화 (Summary 탭이 기본으로 열리도록)
    setShowLogs(false)
    setShowManifest(false)
    setShowDescribe(false)
    
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
      console.error('로그 다운로드 실패:', error)
      alert('로그 다운로드에 실패했습니다.')
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">클러스터 뷰</h1>
          <p className="mt-2 text-slate-400">
            Node별 Pod 배치 현황을 확인하세요
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* 파드 이름 검색 */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="파드 이름 검색..."
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
                {selectedNamespace === 'all' ? '전체 네임스페이스' : selectedNamespace}
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
                    전체 네임스페이스
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
          <button
            onClick={async () => {
              setIsRefreshing(true)
              try {
                // force_refresh=true로 API 직접 호출
                const [namespacesData, allPodsData] = await Promise.all([
                  api.getNamespaces(true),
                  selectedNamespace === 'all'
                    ? Promise.all((namespaces || []).map(ns => api.getPods(ns.name, undefined, true))).then(pods => pods.flat())
                    : api.getPods(selectedNamespace, undefined, true)
                ])
                
                // 캐시 제거 후 새 데이터로 업데이트
                queryClient.removeQueries({ queryKey: ['namespaces'] })
                queryClient.removeQueries({ queryKey: ['all-pods', selectedNamespace] })
                
                queryClient.setQueryData(['namespaces'], namespacesData)
                queryClient.setQueryData(['all-pods', selectedNamespace], allPodsData)
              } catch (error) {
                console.error('새로고침 실패:', error)
              } finally {
                setTimeout(() => setIsRefreshing(false), 500)
              }
            }}
            disabled={isRefreshing}
            title="새로고침 (강제 갱신)"
            className="h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            새로고침
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center h-full min-h-[300px]">
          <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
          <p className="text-slate-400">데이터를 불러오는 중...</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* 검색 결과 정보 */}
          {searchQuery && (
            <div className="text-sm text-slate-400">
              검색 결과: <span className="text-white font-medium">{filteredPods.length}</span>개
              {filteredPods.length !== (allPods?.length || 0) && (
                <span className="ml-2">
                  (전체 {allPods?.length || 0}개 중)
                </span>
              )}
            </div>
          )}
          
          {/* 검색 결과가 없을 때 */}
          {searchQuery && filteredPods.length === 0 && (
            <div className="card text-center py-12">
              <Search className="w-12 h-12 text-slate-600 mx-auto mb-4" />
              <p className="text-slate-400">
                "{searchQuery}"에 해당하는 Pod를 찾을 수 없습니다
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
                <span className="badge badge-secondary">{pods.length} Pods</span>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
                {pods.map((pod, idx) => (
                  <button
                    key={`${pod.namespace}-${pod.name}-${idx}`}
                    onClick={() => handlePodClick(pod)}
                    className="p-3 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors text-left"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <Box className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      {getHealthIcon(pod.status, pod.phase)}
                    </div>
                    <div className="text-sm font-medium text-white truncate" title={pod.name}>
                      {pod.name}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">{pod.namespace}</div>
                    <div className="text-xs text-yellow-400 mt-1 min-h-[16px]">
                      {pod.restart_count > 0 && `재시작: ${pod.restart_count}`}
                    </div>
                  </button>
                ))}
              </div>
            </div>
            ))
          ) : (
            !searchQuery && !isLoading && allPods !== undefined && (
              <div className="card text-center py-12">
                <Box className="w-12 h-12 text-slate-600 mx-auto mb-4" />
                <p className="text-slate-400">Pod가 없습니다</p>
              </div>
            )
          )}
        </div>
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
                }}
                className={`px-4 py-2 font-medium transition-colors ${
                  !showLogs && !showManifest && !showDescribe
                    ? 'text-primary-400 border-b-2 border-primary-400'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Summary
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
                }}
                className={`px-4 py-2 font-medium transition-colors flex items-center gap-2 ${
                  showLogs
                    ? 'text-primary-400 border-b-2 border-primary-400'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Terminal className="w-4 h-4" />
                Logs
              </button>
              <button
                onClick={() => {
                  setShowLogs(false)
                  setShowManifest(false)
                  setShowDescribe(true)
                }}
                className={`px-4 py-2 font-medium transition-colors flex items-center gap-2 ${
                  showDescribe
                    ? 'text-primary-400 border-b-2 border-primary-400'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <FileCode className="w-4 h-4" />
                Describe
              </button>
              <button
                onClick={() => {
                  setShowLogs(false)
                  setShowManifest(true)
                  setShowDescribe(false)
                }}
                className={`px-4 py-2 font-medium transition-colors flex items-center gap-2 ${
                  showManifest
                    ? 'text-primary-400 border-b-2 border-primary-400'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <FileCode className="w-4 h-4" />
                Manifest
              </button>
            </div>

            {/* 모달 내용 */}
            <div className="flex-1 overflow-y-auto p-6">
              {!showLogs && !showManifest && !showDescribe && (
                <div className="space-y-6">
                  {/* 기본 정보 */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-slate-400">KIND</p>
                      <p className="text-white font-medium">Pod</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-400">STATE</p>
                      <p className="text-white font-medium">{selectedPod.phase || selectedPod.status || 'Unknown'}</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-400">NODE</p>
                      <p className="text-white font-medium">{selectedPod.node || 'N/A'}</p>
                    </div>
                    <div>
                      <p className="text-sm text-slate-400">CREATED AT</p>
                      <p className="text-white font-medium">
                        {selectedPod.created_at 
                          ? new Date(selectedPod.created_at).toLocaleString('ko-KR', {
                              year: 'numeric',
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit'
                            })
                          : 'N/A'}
                      </p>
                    </div>
                  </div>

                  {/* 컨테이너 상태 */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-lg font-bold text-white">Container State</h3>
                    </div>
                    {/* 컨테이너 검색창 */}
                    {selectedPod.containers && selectedPod.containers.length > 0 && (
                      <div className="relative mb-3">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                        <input
                          type="text"
                          placeholder="컨테이너 검색..."
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
                            let stateText = 'Unknown'
                            let stateColor = 'text-slate-400'
                            
                            if (container.state && typeof container.state === 'object') {
                              const state = container.state as any
                              if (state.running) {
                                stateText = 'Running'
                                stateColor = 'text-green-400'
                              } else if (state.waiting) {
                                stateText = `Waiting: ${state.waiting.reason || 'Unknown'}`
                                stateColor = 'text-yellow-400'
                              } else if (state.terminated) {
                                stateText = `Terminated: ${state.terminated.reason || 'Unknown'} (exit code: ${state.terminated.exit_code})`
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
                                  Image: {container.image}
                                </p>
                                {container.restart_count > 0 && (
                                  <p className="text-sm text-yellow-400 mt-1">
                                    Restarts: {container.restart_count}
                                  </p>
                                )}
                              </div>
                            )
                          })
                      ) : (
                        <div className="text-center py-8">
                          <p className="text-slate-400">
                            {containerSearchQuery ? '검색 결과가 없습니다' : '컨테이너가 없습니다'}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Health */}
                  <div>
                    <h3 className="text-lg font-bold text-white mb-3">Health</h3>
                    <div className="flex items-center gap-2">
                      {getHealthIcon(selectedPod.status, selectedPod.phase)}
                      <span className="text-white font-medium">
                        {selectedPod.phase === 'Running' ? 'Healthy' : selectedPod.phase}
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
                      <label className="text-sm text-slate-400 mb-2 block">Container</label>
                      <button
                        onClick={() => setIsContainerDropdownOpen(!isContainerDropdownOpen)}
                        className="w-full h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 justify-between"
                      >
                        <span className="text-sm font-medium">
                          {selectedContainer || '컨테이너 선택'}
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
                                placeholder="컨테이너 검색..."
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
                              {containerSearchQuery ? '검색 결과가 없습니다' : '컨테이너가 없습니다'}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 다운로드 줄 수 선택 - 커스텀 드롭다운 */}
                    <div className="relative" ref={tailLinesDropdownRef}>
                      <label className="text-sm text-slate-400 mb-2 block">로그 다운로드 줄 수</label>
                      <button
                        onClick={() => setIsTailLinesDropdownOpen(!isTailLinesDropdownOpen)}
                        className="h-10 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 justify-between min-w-[150px]"
                      >
                        <span className="text-sm font-medium">
                          {downloadTailLines}줄
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
                                {lines}줄
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 다운로드 버튼 */}
                    <div>
                      <label className="text-sm text-slate-400 mb-2 block invisible">다운로드</label>
                      <button
                        onClick={handleDownloadLogs}
                        disabled={isDownloading}
                        className="h-10 px-4 bg-primary-600 hover:bg-primary-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded-lg border border-primary-500 focus:outline-none focus:border-primary-400 transition-colors flex items-center gap-2"
                      >
                        <Download className="w-4 h-4" />
                        {isDownloading ? '다운로드 중...' : '다운로드'}
                      </button>
                    </div>
                  </div>

                  {/* 로그 - 스크롤 가능 */}
                  <div className="flex-1 bg-slate-900 rounded-lg p-4 mt-4 font-mono text-sm text-slate-300 overflow-x-auto overflow-y-auto">
                    <pre className="whitespace-pre-wrap break-words">{logs || '로그를 불러오는 중...'}</pre>
                    <div ref={logsEndRef} />
                  </div>
                </div>
              )}

              {showDescribe && describeData && (
                <div className="space-y-6">
                  {/* 기본 정보 */}
                  <div>
                    <h3 className="text-lg font-semibold text-white mb-4">기본 정보</h3>
                    <div className="grid grid-cols-2 gap-4 bg-slate-800 rounded-lg p-4">
                      <div>
                        <p className="text-sm text-slate-400">Name</p>
                        <p className="text-white font-medium">{describeData.name}</p>
                      </div>
                      <div>
                        <p className="text-sm text-slate-400">Namespace</p>
                        <p className="text-white font-medium">{describeData.namespace}</p>
                      </div>
                      <div>
                        <p className="text-sm text-slate-400">Node</p>
                        <p className="text-white font-medium">{describeData.node || 'N/A'}</p>
                      </div>
                      <div>
                        <p className="text-sm text-slate-400">Phase</p>
                        <p className="text-white font-medium">{describeData.phase}</p>
                      </div>
                      <div>
                        <p className="text-sm text-slate-400">Created At</p>
                        <p className="text-white font-medium">
                          {new Date(describeData.created_at).toLocaleString('ko-KR')}
                        </p>
                      </div>
                      {describeData.pod_ip && (
                        <div>
                          <p className="text-sm text-slate-400">Pod IP</p>
                          <p className="text-white font-medium">{describeData.pod_ip}</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 레이블 */}
                  {describeData.labels && Object.keys(describeData.labels).length > 0 && (
                    <div>
                      <h3 className="text-lg font-semibold text-white mb-4">Labels</h3>
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
                      <h3 className="text-lg font-semibold text-white mb-4">Containers</h3>
                      <div className="space-y-4">
                        {describeData.containers.map((container: any, idx: number) => (
                          <div key={idx} className="bg-slate-800 rounded-lg p-4">
                            <div className="flex items-center justify-between mb-3">
                              <h4 className="text-white font-medium">{container.name}</h4>
                              <span className={`px-2 py-1 rounded text-xs font-medium ${
                                container.ready ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                              }`}>
                                {container.ready ? 'Ready' : 'Not Ready'}
                              </span>
                            </div>
                            <div className="space-y-2 text-sm">
                              <div>
                                <span className="text-slate-400">Image: </span>
                                <span className="text-white font-mono">{container.image}</span>
                              </div>
                              <div>
                                <span className="text-slate-400">State: </span>
                                <span className="text-white">
                                  {container.state?.running ? 'Running' : 
                                   container.state?.waiting ? `Waiting (${container.state.waiting.reason || 'Unknown'})` :
                                   container.state?.terminated ? `Terminated (${container.state.terminated.reason || 'Unknown'})` :
                                   'Unknown'}
                                </span>
                              </div>
                              <div>
                                <span className="text-slate-400">Restart Count: </span>
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
                      <h3 className="text-lg font-semibold text-white mb-4">Conditions</h3>
                      <div className="bg-slate-800 rounded-lg overflow-hidden">
                        <table className="w-full">
                          <thead className="bg-slate-700">
                            <tr>
                              <th className="px-4 py-2 text-left text-sm font-medium text-slate-300">Type</th>
                              <th className="px-4 py-2 text-left text-sm font-medium text-slate-300">Status</th>
                              <th className="px-4 py-2 text-left text-sm font-medium text-slate-300">Last Transition</th>
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
                                  {new Date(condition.last_transition_time).toLocaleString('ko-KR')}
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
                      <h3 className="text-lg font-semibold text-white mb-4">Events</h3>
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
                                {new Date(event.last_timestamp).toLocaleString('ko-KR')}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {showManifest && (
                <div className="h-full bg-slate-900 rounded-lg p-4 font-mono text-sm text-slate-300 overflow-x-auto overflow-y-auto">
                  <pre>{manifest || '로딩 중...'}</pre>
                </div>
              )}
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
