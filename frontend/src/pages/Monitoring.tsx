import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { 
  Server, 
  Box,
  RefreshCw,
  Activity,
  HardDrive,
  Cpu,
  Clock,
  ChevronDown,
  CheckCircle
} from 'lucide-react'
import { useState, useEffect, useRef } from 'react'

export default function Monitoring() {
  const [selectedNamespace, setSelectedNamespace] = useState<string>('')
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())
  const [isNamespaceDropdownOpen, setIsNamespaceDropdownOpen] = useState(false)
  const namespaceDropdownRef = useRef<HTMLDivElement>(null)

  // 노드 리소스 사용량 (5초마다 자동 갱신)
  const { data: nodeMetrics, isLoading: isLoadingNodes } = useQuery({
    queryKey: ['node-metrics'],
    queryFn: api.getNodeMetrics,
    staleTime: 5000,
    refetchInterval: 5000,
    retry: 2, // 2번 재시도
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000), // 지수 백오프
    placeholderData: (previousData) => previousData, // 이전 데이터 유지 (깜빡임 방지)
  })

  // 네임스페이스 목록
  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(false),
    staleTime: 30000,
  })

  // Pod 리소스 사용량 (네임스페이스 선택 시에만 활성화, 5초마다 자동 갱신)
  const { data: podMetrics, isLoading: isLoadingPods, error: podMetricsError } = useQuery({
    queryKey: ['pod-metrics', selectedNamespace],
    queryFn: () => api.getPodMetrics(selectedNamespace === 'all' ? undefined : selectedNamespace),
    staleTime: 5000,
    refetchInterval: 5000,
    enabled: !!selectedNamespace, // 네임스페이스가 선택되었을 때만 활성화
    retry: 2, // 2번 재시도 (너무 많은 재시도는 오히려 지연 증가)
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000), // 지수 백오프 (최대 5초)
    placeholderData: (previousData) => previousData, // 이전 데이터 유지 (깜빡임 방지)
  })

  // Pod 상세 정보 (Limit/Request 포함) - 네임스페이스 선택 시에만 활성화
  const { data: allPods } = useQuery({
    queryKey: ['all-pods-detail'],
    queryFn: () => api.getAllPods(false),
    staleTime: 10000,
    refetchInterval: 10000,
    enabled: !!selectedNamespace, // 네임스페이스가 선택되었을 때만 활성화
  })

  // 마지막 업데이트 시간 갱신
  useEffect(() => {
    if (nodeMetrics || podMetrics) {
      setLastUpdate(new Date())
    }
  }, [nodeMetrics, podMetrics])

  // 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (namespaceDropdownRef.current && !namespaceDropdownRef.current.contains(event.target as Node)) {
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

  // Pod 메트릭 통계
  const podStats = podMetrics ? {
    totalPods: podMetrics.length,
    totalCpu: podMetrics.reduce((acc, pod) => {
      const cpu = parseInt(pod.cpu.replace('m', ''))
      return acc + (isNaN(cpu) ? 0 : cpu)
    }, 0),
    totalMemory: podMetrics.reduce((acc, pod) => {
      const memory = parseInt(pod.memory.replace('Mi', ''))
      return acc + (isNaN(memory) ? 0 : memory)
    }, 0)
  } : null

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">리소스 모니터링</h1>
          <p className="mt-2 text-slate-400">
            노드 및 Pod의 실시간 리소스 사용량을 모니터링하세요
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Clock className="w-4 h-4" />
            <span>마지막 업데이트: {lastUpdate.toLocaleTimeString()}</span>
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse ml-2"></div>
            <span className="text-green-400">5초마다 자동 갱신</span>
          </div>
          <p className="text-xs text-slate-500">
            * 데이터를 가져오는 데 5초 이상 걸릴 수 있습니다
          </p>
        </div>
      </div>

      {/* 노드 리소스 사용량 */}
      <div className="card">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/10">
              <Server className="w-6 h-6 text-cyan-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">노드 리소스 사용량</h2>
              <p className="text-sm text-slate-400">5초마다 자동 갱신</p>
            </div>
          </div>
          {nodeMetrics && (
            <div className="text-sm text-slate-400">
              총 {nodeMetrics.length}개 노드
            </div>
          )}
        </div>

        {isLoadingNodes ? (
          <div className="flex flex-col items-center justify-center py-12">
            <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
            <p className="text-slate-400">데이터를 불러오는 중...</p>
          </div>
        ) : nodeMetrics && nodeMetrics.length > 0 ? (
          <div className="space-y-6">
            {nodeMetrics.map((node) => {
              const cpuPercent = parseFloat(node.cpu_percent)
              const memoryPercent = parseFloat(node.memory_percent)
              
              return (
                <div key={node.name} className="p-4 bg-slate-700 rounded-lg">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-medium text-white flex items-center gap-2">
                      <Server className="w-5 h-5 text-cyan-400" />
                      {node.name}
                    </h3>
                    <div className="flex items-center gap-4 text-sm text-slate-300">
                      <div className="flex items-center gap-2">
                        <Cpu className="w-4 h-4 text-green-400" />
                        <span>{node.cpu}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <HardDrive className="w-4 h-4 text-blue-400" />
                        <span>{node.memory}</span>
                      </div>
                    </div>
                  </div>
                  
                  {/* CPU 사용량 */}
                  <div className="space-y-2 mb-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-400 flex items-center gap-2">
                        <Cpu className="w-4 h-4" />
                        CPU
                      </span>
                      <span className={`font-medium ${
                        cpuPercent >= 80 ? 'text-red-400' : 
                        cpuPercent >= 60 ? 'text-yellow-400' : 
                        'text-green-400'
                      }`}>
                        {node.cpu_percent}
                      </span>
                    </div>
                    <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          cpuPercent >= 80 ? 'bg-red-500' : 
                          cpuPercent >= 60 ? 'bg-yellow-500' : 
                          'bg-green-500'
                        }`}
                        style={{ width: `${Math.min(cpuPercent, 100)}%` }}
                      />
                    </div>
                  </div>
                  
                  {/* Memory 사용량 */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-400 flex items-center gap-2">
                        <HardDrive className="w-4 h-4" />
                        Memory
                      </span>
                      <span className={`font-medium ${
                        memoryPercent >= 80 ? 'text-red-400' : 
                        memoryPercent >= 60 ? 'text-yellow-400' : 
                        'text-blue-400'
                      }`}>
                        {node.memory_percent}
                      </span>
                    </div>
                    <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                      <div 
                        className={`h-full transition-all duration-500 ${
                          memoryPercent >= 80 ? 'bg-red-500' : 
                          memoryPercent >= 60 ? 'bg-yellow-500' : 
                          'bg-blue-500'
                        }`}
                        style={{ width: `${Math.min(memoryPercent, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="text-center py-12">
            <p className="text-slate-400">노드 메트릭을 사용할 수 없습니다</p>
            <p className="text-sm text-slate-500 mt-2">
              metrics-server가 설치되어 있는지 확인하세요
            </p>
          </div>
        )}
      </div>

      {/* Pod 리소스 사용량 */}
      <div className="card overflow-visible">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-500/10">
              <Box className="w-6 h-6 text-green-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Pod 리소스 사용량</h2>
              <p className="text-sm text-slate-400">네임스페이스별 필터링 지원</p>
            </div>
          </div>
        </div>

        {/* 네임스페이스 선택 */}
        <div className="mb-6 overflow-visible">
          <label className="block text-sm font-medium text-slate-400 mb-2">
            네임스페이스 선택
          </label>
          <div className="relative w-full md:w-64" ref={namespaceDropdownRef}>
            <button
              onClick={() => setIsNamespaceDropdownOpen(!isNamespaceDropdownOpen)}
              className="w-full px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none focus:border-primary-500 transition-colors flex items-center gap-2 justify-between"
            >
              <span className="text-sm font-medium">
                {selectedNamespace === '' 
                  ? '네임스페이스를 선택하세요' 
                  : selectedNamespace === 'all' 
                    ? '전체 네임스페이스' 
                    : selectedNamespace}
              </span>
              <ChevronDown 
                className={`w-4 h-4 text-slate-400 transition-transform ${
                  isNamespaceDropdownOpen ? 'rotate-180' : ''
                }`}
              />
            </button>
            
            {isNamespaceDropdownOpen && (
              <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[100] max-h-[200px] overflow-y-auto">
                <button
                  onClick={() => {
                    setSelectedNamespace('')
                    setIsNamespaceDropdownOpen(false)
                  }}
                  className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
                >
                  {selectedNamespace === '' && (
                    <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                  )}
                  <span className={selectedNamespace === '' ? 'font-medium' : ''}>
                    네임스페이스를 선택하세요
                  </span>
                </button>
                <button
                  onClick={() => {
                    setSelectedNamespace('all')
                    setIsNamespaceDropdownOpen(false)
                  }}
                  className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2"
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
        </div>

        {/* 네임스페이스 미선택 시 안내 메시지 */}
        {!selectedNamespace && (
          <div className="text-center py-12 bg-slate-700/50 rounded-lg border-2 border-dashed border-slate-600">
            <Box className="w-12 h-12 text-slate-500 mx-auto mb-4" />
            <p className="text-slate-400 text-lg font-medium">네임스페이스를 선택하세요</p>
            <p className="text-sm text-slate-500 mt-2">
              Pod 리소스 사용량을 확인하려면 위에서 네임스페이스를 선택하세요
            </p>
          </div>
        )}

        {/* Pod 통계 카드 */}
        {selectedNamespace && podStats && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="p-4 bg-slate-700 rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-400">총 Pod 수</p>
                  <p className="text-2xl font-bold text-white mt-1">{podStats.totalPods}</p>
                </div>
                <Box className="w-8 h-8 text-green-400" />
              </div>
            </div>
            <div className="p-4 bg-slate-700 rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-400">총 CPU 사용량</p>
                  <p className="text-2xl font-bold text-white mt-1">{podStats.totalCpu}m</p>
                </div>
                <Cpu className="w-8 h-8 text-green-400" />
              </div>
            </div>
            <div className="p-4 bg-slate-700 rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-400">총 Memory 사용량</p>
                  <p className="text-2xl font-bold text-white mt-1">{podStats.totalMemory}Mi</p>
                </div>
                <HardDrive className="w-8 h-8 text-blue-400" />
              </div>
            </div>
          </div>
        )}

        {selectedNamespace && isLoadingPods ? (
          <div className="flex flex-col items-center justify-center py-12">
            <RefreshCw className="w-8 h-8 text-primary-400 animate-spin mb-4" />
            <p className="text-slate-400">데이터를 불러오는 중...</p>
          </div>
        ) : selectedNamespace && podMetrics && podMetrics.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="text-left py-3 px-4 text-slate-400 font-medium">Pod</th>
                  <th className="text-left py-3 px-4 text-slate-400 font-medium">Namespace</th>
                  <th className="text-left py-3 px-4 text-slate-400 font-medium">
                    <div className="flex items-center gap-2">
                      <Cpu className="w-4 h-4" />
                      CPU (사용량)
                    </div>
                  </th>
                  <th className="text-left py-3 px-4 text-slate-400 font-medium">
                    <div className="flex items-center gap-2">
                      <Cpu className="w-4 h-4" />
                      CPU Limit
                    </div>
                  </th>
                  <th className="text-left py-3 px-4 text-slate-400 font-medium">
                    <div className="flex items-center gap-2">
                      <HardDrive className="w-4 h-4" />
                      Memory (사용량)
                    </div>
                  </th>
                  <th className="text-left py-3 px-4 text-slate-400 font-medium">
                    <div className="flex items-center gap-2">
                      <HardDrive className="w-4 h-4" />
                      Memory Limit
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {podMetrics.map((podMetric) => {
                  const cpu = parseInt(podMetric.cpu.replace('m', ''))
                  const memory = parseInt(podMetric.memory.replace('Mi', ''))
                  
                  // Pod 상세 정보에서 Limit/Request 찾기
                  const podDetail = allPods?.find(
                    p => p.name === podMetric.name && p.namespace === podMetric.namespace
                  )
                  
                  // 모든 컨테이너의 Limit 합산
                  let cpuLimit = 'None'
                  let memoryLimit = 'None'
                  
                  if (podDetail?.containers) {
                    let totalCpuLimit = 0
                    let totalMemoryLimit = 0
                    let hasCpuLimit = false
                    let hasMemoryLimit = false
                    
                    podDetail.containers.forEach((container: any) => {
                      // CPU Limit
                      if (container.limits?.cpu) {
                        hasCpuLimit = true
                        const cpuStr = container.limits.cpu
                        if (cpuStr.endsWith('m')) {
                          totalCpuLimit += parseInt(cpuStr.replace('m', ''))
                        } else {
                          totalCpuLimit += parseInt(cpuStr) * 1000
                        }
                      }
                      
                      // Memory Limit
                      if (container.limits?.memory) {
                        hasMemoryLimit = true
                        const memStr = container.limits.memory
                        if (memStr.endsWith('Mi')) {
                          totalMemoryLimit += parseInt(memStr.replace('Mi', ''))
                        } else if (memStr.endsWith('Gi')) {
                          totalMemoryLimit += parseInt(memStr.replace('Gi', '')) * 1024
                        } else if (memStr.endsWith('Ki')) {
                          totalMemoryLimit += parseInt(memStr.replace('Ki', '')) / 1024
                        }
                      }
                    })
                    
                    if (hasCpuLimit) cpuLimit = `${totalCpuLimit}m`
                    if (hasMemoryLimit) memoryLimit = `${Math.round(totalMemoryLimit)}Mi`
                  }
                  
                  return (
                    <tr key={`${podMetric.namespace}-${podMetric.name}`} className="border-b border-slate-700/50 hover:bg-slate-700/30">
                      <td className="py-3 px-4 text-white font-mono text-sm">{podMetric.name}</td>
                      <td className="py-3 px-4">
                        <span className="badge badge-info text-xs">{podMetric.namespace}</span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <Activity className={`w-4 h-4 ${
                            cpu >= 1000 ? 'text-red-400' :
                            cpu >= 500 ? 'text-yellow-400' :
                            'text-green-400'
                          }`} />
                          <span className="text-white font-mono">{podMetric.cpu}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`font-mono text-sm ${
                          cpuLimit === 'None' ? 'text-slate-500' : 'text-slate-300'
                        }`}>
                          {cpuLimit}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <Activity className={`w-4 h-4 ${
                            memory >= 1024 ? 'text-red-400' :
                            memory >= 512 ? 'text-yellow-400' :
                            'text-blue-400'
                          }`} />
                          <span className="text-white font-mono">{podMetric.memory}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className={`font-mono text-sm ${
                          memoryLimit === 'None' ? 'text-slate-500' : 'text-slate-300'
                        }`}>
                          {memoryLimit}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : selectedNamespace && podMetricsError ? (
          <div className="text-center py-12">
            <div className="flex flex-col items-center gap-4">
              <Activity className="w-12 h-12 text-red-400 animate-pulse" />
              <div>
                <p className="text-red-400 font-medium">Pod 메트릭을 불러오는 중 오류가 발생했습니다</p>
                <p className="text-sm text-slate-500 mt-2">
                  자동으로 재시도 중입니다... (5초마다 갱신)
                </p>
              </div>
            </div>
          </div>
        ) : selectedNamespace ? (
          <div className="text-center py-12">
            <p className="text-slate-400">
              {selectedNamespace === 'all' 
                ? 'Pod 메트릭을 사용할 수 없습니다' 
                : `${selectedNamespace} 네임스페이스에 Pod가 없습니다`}
            </p>
            {selectedNamespace === 'all' && (
              <p className="text-sm text-slate-500 mt-2">
                metrics-server가 설치되어 있는지 확인하세요
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
