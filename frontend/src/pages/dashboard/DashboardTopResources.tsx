// Dashboard "Top resources" cards — Top 5 pods + Top 3 nodes by CPU /
// memory usage. Driven by a single TopResources query that the parent
// passes down. The component handles its own loading / error /
// unavailable / empty states. Click → opens the resource detail
// drawer via ResourceDetailContext (used directly here so the parent
// doesn't have to thread `openDetail` through props).

import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'

import { TopResources } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'

interface Props {
  topResources: TopResources | undefined
  isLoading: boolean
  isError: boolean
  metricsUnavailable: boolean
}

export function DashboardTopResources({ topResources, isLoading, isError, metricsUnavailable }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const { open: openDetail } = useResourceDetail()

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* Top 파드 */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-white">
            {tr('dashboard.topPods.title', 'Top 5 pods by resource usage')}
          </h2>
          <p className="text-xs text-slate-400">{tr('dashboard.autoRefresh', 'Auto refresh every 5 seconds')}</p>
        </div>
        {isLoading && !topResources ? (
          // 초기 로딩: 스켈레톤 표시
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="p-4 bg-slate-700 rounded-lg animate-pulse">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 rounded-full bg-slate-600" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-slate-600 rounded-sm w-3/4" />
                    <div className="h-3 bg-slate-600 rounded-sm w-1/2" />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-6 mt-2">
                  <div className="h-3 bg-slate-600 rounded-sm w-16" />
                  <div className="h-3 bg-slate-600 rounded-sm w-20" />
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
        ) : isError && !topResources?.top_pods ? (
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
              <button
                type="button"
                key={`${pod.namespace}-${pod.name}`}
                onClick={() => openDetail({ kind: 'Pod', name: pod.name, namespace: pod.namespace })}
                className="w-full text-left p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition-colors cursor-pointer"
              >
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
              </button>
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
        {isLoading && !topResources ? (
          // 초기 로딩: 스켈레톤 표시
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="space-y-3 p-3 bg-slate-700 rounded-lg animate-pulse">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-slate-600" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-slate-600 rounded-sm w-1/2" />
                    <div className="h-3 bg-slate-600 rounded-sm w-1/3" />
                  </div>
                </div>
                <div className="space-y-2 pl-11">
                  <div className="flex items-center justify-between text-xs">
                    <div className="h-3 bg-slate-600 rounded-sm w-10" />
                    <div className="h-3 bg-slate-600 rounded-sm w-12" />
                  </div>
                  <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-slate-600 w-1/2" />
                  </div>
                </div>
                <div className="space-y-2 pl-11">
                  <div className="flex items-center justify-between text-xs">
                    <div className="h-3 bg-slate-600 rounded-sm w-12" />
                    <div className="h-3 bg-slate-600 rounded-sm w-10" />
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
        ) : isError && !topResources?.top_nodes ? (
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
                <button
                  type="button"
                  key={node.name}
                  onClick={() => openDetail({ kind: 'Node', name: node.name })}
                  className="w-full text-left space-y-3 p-2 -m-2 rounded-lg hover:bg-slate-700/50 transition-colors cursor-pointer"
                >
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
                </button>
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
  )
}
