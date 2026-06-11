// Pod 상세 모달의 Logs 탭. SSE (EventSource) 로 logs streaming.
//
// 이전 WebSocket 구현엔 cancelled flag / currentWs / detachAndClose / FileReader
// binary path / 401 close-code 분기 등 retry-style race 코드가 ~80줄 있었음.
// SSE 는 browser EventSource 가 자동 reconnect 처리하므로:
//  - es.close() 한 줄로 cleanup 끝
//  - 401 / 일시적 끊김 / proxy idle 다 EventSource 가 자동 재시도
//  - backend 의 retry 도 정상 위치 defer 로 inotify watcher 누적 해결
//
// 이전 README 의 "여러 logs 왔다갔다 했더니 stuck" 회귀가 이 한 번의 전환으로
// 거의 모든 race 표면 제거.

import { useEffect, useRef, useState } from 'react'
import { Search, X, ChevronDown, CheckCircle, Download } from 'lucide-react'
import { api } from '@/services/api'
import { getCurrentClusterID } from '@/services/clusterRef'

interface PodLike {
  name: string
  namespace: string
  containers: Array<{ name: string }>
}

interface Props {
  pod: PodLike
  selectedContainer: string
  onSelectContainer: (name: string) => void
  containerSearchQuery: string
  onContainerSearchChange: (q: string) => void
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export function PodLogsTab({
  pod,
  selectedContainer,
  onSelectContainer,
  containerSearchQuery,
  onContainerSearchChange,
  tr,
}: Props) {
  const [logs, setLogs] = useState<string>('')
  const [isStreamingLogs, setIsStreamingLogs] = useState(false)
  const [isContainerDropdownOpen, setIsContainerDropdownOpen] = useState(false)
  const [isTailLinesDropdownOpen, setIsTailLinesDropdownOpen] = useState(false)
  const [downloadTailLines, setDownloadTailLines] = useState<number>(1000)
  const [isDownloading, setIsDownloading] = useState(false)

  const logsEndRef = useRef<HTMLDivElement>(null)
  const containerDropdownRef = useRef<HTMLDivElement>(null)
  const tailLinesDropdownRef = useRef<HTMLDivElement>(null)

  // 로그 스트리밍 (Server-Sent Events).
  //
  // 한 EventSource = 한 container 의 log stream. container/pod 가 바뀌면
  // close + 새 EventSource. EventSource 가 자동 reconnect 처리하므로
  // ws 시절의 cancelled flag / detachAndClose / FileReader 분기 다 제거.
  useEffect(() => {
    if (!selectedContainer) {
      setLogs('')
      setIsStreamingLogs(false)
      return
    }

    setIsStreamingLogs(true)
    setLogs('')

    // EventSource bypasses the axios cluster interceptor — inject ?cluster=
    // so logs stream from the selected cluster, not the server default.
    const clusterId = getCurrentClusterID()
    const url = `/api/v1/cluster/namespaces/${pod.namespace}/pods/${pod.name}` +
      `/logs/stream?container=${encodeURIComponent(selectedContainer)}&tail_lines=100` +
      (clusterId ? `&cluster=${encodeURIComponent(clusterId)}` : '')

    const es = new EventSource(url, { withCredentials: true })

    es.onmessage = (e) => {
      // SSE 한 메시지 = 로그 한 줄. backend bufio.Scanner 가 split.
      setLogs((prev) => prev + e.data + '\n')
    }

    es.addEventListener('error', () => {
      // CLOSED 상태는 영구 실패 (e.g. 401, backend error 이벤트 후 close).
      // CONNECTING 상태는 browser 가 자동 재시도 중 — 우리가 할 일 없음.
      if (es.readyState === EventSource.CLOSED) {
        setIsStreamingLogs(false)
      }
    })

    // backend 가 startup 실패 시 보내는 named 'error' 이벤트
    es.addEventListener('error' as any, (e: any) => {
      if (e?.data) {
        console.warn('pod logs sse error frame', e.data)
      }
    })

    return () => {
      es.close()
      setIsStreamingLogs(false)
    }
  }, [pod, selectedContainer])

  // 자동 스크롤
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'auto', block: 'end' })
    }
  }, [logs])

  // 컨테이너 드롭다운 외부 클릭
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
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isContainerDropdownOpen])

  // 줄 수 드롭다운 외부 클릭
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
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isTailLinesDropdownOpen])

  const handleDownloadLogs = async () => {
    if (!selectedContainer) return
    setIsDownloading(true)
    try {
      const downloadedLogs = await api.getPodLogs(
        pod.namespace,
        pod.name,
        selectedContainer,
        downloadTailLines,
      )
      const now = new Date()
      const year = now.getFullYear()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      const hours = String(now.getHours()).padStart(2, '0')
      const minutes = String(now.getMinutes()).padStart(2, '0')
      const seconds = String(now.getSeconds()).padStart(2, '0')
      const dateTime = `${year}${month}${day}-${hours}${minutes}${seconds}`

      const blob = new Blob([downloadedLogs], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${pod.name}-${selectedContainer}-logs-${dateTime}.txt`
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
                    onChange={(e) => onContainerSearchChange(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full h-8 pl-8 pr-8 bg-slate-600 text-white rounded text-sm border border-slate-500 focus:outline-none focus:border-primary-500 transition-colors"
                  />
                  {containerSearchQuery && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onContainerSearchChange('')
                      }}
                      className="absolute right-2 top-1/2 transform -translate-y-1/2 p-0.5 hover:bg-slate-500 rounded transition-colors"
                    >
                      <X className="w-3 h-3 text-slate-400" />
                    </button>
                  )}
                </div>
              </div>
              {pod.containers &&
              pod.containers.filter((container) => {
                if (!containerSearchQuery.trim()) return true
                const query = containerSearchQuery.toLowerCase()
                return container.name.toLowerCase().includes(query)
              }).length > 0 ? (
                pod.containers
                  .filter((container) => {
                    if (!containerSearchQuery.trim()) return true
                    const query = containerSearchQuery.toLowerCase()
                    return container.name.toLowerCase().includes(query)
                  })
                  .map((container) => (
                    <button
                      key={container.name}
                      onClick={() => {
                        onSelectContainer(container.name)
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
          {logs
            ? logs
            : isStreamingLogs
              ? tr('clusterView.logs.loading', 'Loading logs...')
              : tr('clusterView.logs.empty', 'No logs available.')}
        </pre>
        <div ref={logsEndRef} />
      </div>
    </div>
  )
}
