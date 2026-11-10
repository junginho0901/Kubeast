// Pod 상세 모달의 Describe 탭. ClusterView.tsx 에서 추출 (Phase 3.1.b).
//
// describeData (useQuery 결과) 의 모든 영역을 표시: 기본 정보 / 레이블 /
// 컨테이너 / Conditions / Events. 부모가 useQuery 로 fetch + 가시성 결정,
// 이 컴포넌트는 데이터가 있을 때 렌더링.

import { formatTime, utcTitle } from '@/utils/time'

interface Props {
  data: any
  na: string
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export function PodDescribeTab({ data, na, tr }: Props) {
  return (
    <div className="space-y-6">
      {/* 기본 정보 */}
      <div>
        <h3 className="text-lg font-semibold text-ink mb-3">
          {tr('clusterView.describe.basicInfo', 'Basic information')}
        </h3>
        <div className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm">
          <div>
            <p className="text-xs text-slate-400">{tr('clusterView.describe.name', 'Name')}</p>
            <p className="text-ink font-medium break-all">{data.name}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400">{tr('clusterView.describe.namespace', 'Namespace')}</p>
            <p className="text-ink font-medium break-all">{data.namespace}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400">{tr('clusterView.describe.node', 'Node')}</p>
            <p className="text-ink font-medium break-all">{data.node || na}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400">{tr('clusterView.describe.phase', 'Phase')}</p>
            <p className="text-ink font-medium">{data.phase}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400">{tr('clusterView.describe.createdAt', 'Created at')}</p>
            <p className="text-ink font-medium">
              <span title={utcTitle(data.created_at)}>{formatTime(data.created_at)}</span>
            </p>
          </div>
          {data.pod_ip && (
            <div>
              <p className="text-xs text-slate-400">{tr('clusterView.describe.podIp', 'Pod IP')}</p>
              <p className="text-ink font-medium">{data.pod_ip}</p>
            </div>
          )}
        </div>
      </div>

      {/* 레이블: every section always shown — "None" without any */}
      <div>
        <h3 className="text-lg font-semibold text-ink mb-3">
          {tr('clusterView.describe.labels', 'Labels')}
        </h3>
        {data.labels && Object.keys(data.labels).length > 0 ? (
          <div className="py-1">
            <div className="space-y-2">
              {Object.entries(data.labels).map(([key, value]) => (
                <div key={key} className="flex items-start gap-2">
                  <span className="text-slate-400 font-mono text-sm break-all">{key}:</span>
                  <span className="text-ink font-mono text-sm break-all">{String(value)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-slate-400 text-sm">{tr('common.none', 'None')}</p>
        )}
      </div>

      {/* 컨테이너 */}
      <div>
        <h3 className="text-lg font-semibold text-ink mb-3">
          {tr('clusterView.describe.containers', 'Containers')}
        </h3>
        {data.containers && data.containers.length > 0 ? (
          <div className="divide-y divide-slate-700/70">
            {data.containers.map((container: any, idx: number) => (
              <div key={idx} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <h4 className="text-sm text-ink font-medium break-all">{container.name}</h4>
                  <span className={`badge ${
                    container.ready ? 'badge-success' : 'badge-error'
                  }`}>
                    {container.ready
                      ? tr('clusterView.describe.containerReady', 'Ready')
                      : tr('clusterView.describe.containerNotReady', 'Not Ready')}
                  </span>
                </div>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-slate-400">{tr('clusterView.describe.containerImage', 'Image')}: </span>
                    <span className="text-ink font-mono break-all">{container.image}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">{tr('clusterView.describe.containerState', 'State')}: </span>
                    <span className="text-ink">
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
                    <span className="text-ink">{container.restart_count}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-slate-400 text-sm">{tr('common.none', 'None')}</p>
        )}
      </div>

      {/* Conditions */}
      <div>
        <h3 className="text-lg font-semibold text-ink mb-3">
          {tr('clusterView.describe.conditions', 'Conditions')}
        </h3>
        {data.conditions && data.conditions.length > 0 ? (
          <div className="overflow-x-auto">
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
                {data.conditions.map((condition: any, idx: number) => (
                  <tr key={idx}>
                    <td className="px-4 py-2 text-sm text-ink">{condition.type}</td>
                    <td className="px-4 py-2 text-sm">
                      <span className={`badge ${
                        condition.status === 'True' ? 'badge-success' : 'badge-neutral'
                      }`}>
                        {condition.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-sm text-slate-300 whitespace-nowrap" title={utcTitle(condition.last_transition_time)}>
                      {formatTime(condition.last_transition_time)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-slate-400 text-sm">{tr('common.none', 'None')}</p>
        )}
      </div>

      {/* Events: always shown — "None" without events, and why when they could not be read */}
      <div>
        <h3 className="text-lg font-semibold text-ink mb-3">
          {tr('clusterView.describe.events', 'Events')}
        </h3>
        {!Array.isArray(data.events) ? (
          <p className="text-red-400 text-sm">
            {data.events_error
              ? tr('clusterView.describe.eventsError', 'Could not load the events: {{error}}', { error: data.events_error })
              : tr('clusterView.describe.eventsUnread', 'Could not load the events.')}
          </p>
        ) : data.events.length === 0 ? (
          <p className="text-slate-400 text-sm">{tr('common.none', 'None')}</p>
        ) : (
          <div className="space-y-3 max-h-96 overflow-y-auto pr-2">
            {data.events.map((event: any, idx: number) => (
              <div key={idx} className="border-l-2 border-slate-600 pl-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`badge ${
                        event.type === 'Normal' ? 'badge-neutral' : 'badge-warning'
                      }`}>
                        {event.type}
                      </span>
                      <span className="text-ink text-sm font-medium">{event.reason}</span>
                    </div>
                    <p className="text-slate-300 text-sm mt-1 break-words">{event.message}</p>
                  </div>
                  <span className="text-slate-400 text-xs whitespace-nowrap ml-4" title={utcTitle(event.last_timestamp)}>
                    {formatTime(event.last_timestamp)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
