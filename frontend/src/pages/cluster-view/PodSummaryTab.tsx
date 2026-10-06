// Pod 상세 모달의 Summary (default) 탭. ClusterView.tsx 에서 추출 (Phase 3.1.b).
//
// 다른 탭이 모두 inactive (showLogs/Manifest/Describe/Rbac/Exec 다 false) 일 때
// 기본 표시되는 정보 (Kind / State / Node / Created at + container 목록 + Health).
// 컨테이너 검색 입력은 사용자 모달 안에서만 의미가 있어 부모가 state 관리.

import { CheckCircle, XCircle, Search, X } from 'lucide-react'
import { getPodHealth, getHealthIcon } from './podHealth'

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
    state: any
    restart_count: number
  }>
}

interface Props {
  pod: PodDetail
  containerSearchQuery: string
  onContainerSearchChange: (q: string) => void
  locale: string
  na: string
  emptyValue: string
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export function PodSummaryTab({
  pod,
  containerSearchQuery,
  onContainerSearchChange,
  locale,
  na,
  emptyValue,
  tr,
}: Props) {
  const health = getPodHealth(pod)
  const filteredContainers = (pod.containers || []).filter((container) => {
    if (!containerSearchQuery.trim()) return true
    const query = containerSearchQuery.toLowerCase()
    return (
      container.name.toLowerCase().includes(query) ||
      (container.image && container.image.toLowerCase().includes(query))
    )
  })

  return (
    <div className="space-y-6">
      {/* 기본 정보 */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-sm text-slate-400">{tr('clusterView.summary.kind', 'Kind')}</p>
          <p className="text-white font-medium">{tr('clusterView.summary.kindPod', 'Pod')}</p>
        </div>
        <div>
          <p className="text-sm text-slate-400">{tr('clusterView.summary.state', 'State')}</p>
          <p className="text-white font-medium">{health.reason}</p>
        </div>
        <div>
          <p className="text-sm text-slate-400">{tr('clusterView.summary.node', 'Node')}</p>
          <p className="text-white font-medium">{pod.node || na}</p>
        </div>
        <div>
          <p className="text-sm text-slate-400">{tr('clusterView.summary.createdAt', 'Created at')}</p>
          <p className="text-white font-medium">
            {pod.created_at
              ? new Date(pod.created_at).toLocaleString(locale, {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
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
        {pod.containers && pod.containers.length > 0 && (
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder={tr('clusterView.containers.searchPlaceholder', 'Search containers...')}
              value={containerSearchQuery}
              onChange={(e) => onContainerSearchChange(e.target.value)}
              className="w-full h-10 pl-10 pr-10 bg-slate-700 text-white rounded-lg border border-slate-600 focus:outline-hidden focus:border-primary-500 transition-colors"
            />
            {containerSearchQuery && (
              <button
                onClick={() => onContainerSearchChange('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 hover:bg-slate-600 rounded-sm transition-colors"
              >
                <X className="w-4 h-4 text-slate-400" />
              </button>
            )}
          </div>
        )}
        <div className="space-y-3">
          {filteredContainers.length > 0 ? (
            filteredContainers.map((container) => {
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
                    <span className={`text-sm ${stateColor}`}>{stateText}</span>
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
          {getHealthIcon(health.level, health.reason)}
          <span className="text-white font-medium">{health.reason}</span>
        </div>
      </div>
    </div>
  )
}
