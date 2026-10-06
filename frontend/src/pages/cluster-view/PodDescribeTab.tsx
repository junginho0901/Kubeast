// Pod 상세 모달의 Describe 탭. ClusterView.tsx 에서 추출 (Phase 3.1.b).
//
// describeData (useQuery 결과) 의 모든 영역을 표시: 기본 정보 / 레이블 /
// 컨테이너 / Conditions / Events. 부모가 useQuery 로 fetch + 가시성 결정,
// 이 컴포넌트는 데이터가 있을 때 렌더링.

interface Props {
  data: any
  locale: string
  na: string
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export function PodDescribeTab({ data, locale, na, tr }: Props) {
  return (
    <div className="space-y-6">
      {/* 기본 정보 */}
      <div>
        <h3 className="text-lg font-semibold text-white mb-4">
          {tr('clusterView.describe.basicInfo', 'Basic information')}
        </h3>
        <div className="grid grid-cols-2 gap-4 bg-slate-800 rounded-lg p-4">
          <div>
            <p className="text-sm text-slate-400">{tr('clusterView.describe.name', 'Name')}</p>
            <p className="text-white font-medium">{data.name}</p>
          </div>
          <div>
            <p className="text-sm text-slate-400">{tr('clusterView.describe.namespace', 'Namespace')}</p>
            <p className="text-white font-medium">{data.namespace}</p>
          </div>
          <div>
            <p className="text-sm text-slate-400">{tr('clusterView.describe.node', 'Node')}</p>
            <p className="text-white font-medium">{data.node || na}</p>
          </div>
          <div>
            <p className="text-sm text-slate-400">{tr('clusterView.describe.phase', 'Phase')}</p>
            <p className="text-white font-medium">{data.phase}</p>
          </div>
          <div>
            <p className="text-sm text-slate-400">{tr('clusterView.describe.createdAt', 'Created at')}</p>
            <p className="text-white font-medium">
              {new Date(data.created_at).toLocaleString(locale)}
            </p>
          </div>
          {data.pod_ip && (
            <div>
              <p className="text-sm text-slate-400">{tr('clusterView.describe.podIp', 'Pod IP')}</p>
              <p className="text-white font-medium">{data.pod_ip}</p>
            </div>
          )}
        </div>
      </div>

      {/* 레이블 */}
      {data.labels && Object.keys(data.labels).length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-white mb-4">
            {tr('clusterView.describe.labels', 'Labels')}
          </h3>
          <div className="bg-slate-800 rounded-lg p-4">
            <div className="space-y-2">
              {Object.entries(data.labels).map(([key, value]) => (
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
      {data.containers && data.containers.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-white mb-4">
            {tr('clusterView.describe.containers', 'Containers')}
          </h3>
          <div className="space-y-4">
            {data.containers.map((container: any, idx: number) => (
              <div key={idx} className="bg-slate-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-white font-medium">{container.name}</h4>
                  <span className={`px-2 py-1 rounded-sm text-xs font-medium ${
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
      {data.conditions && data.conditions.length > 0 && (
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
                {data.conditions.map((condition: any, idx: number) => (
                  <tr key={idx}>
                    <td className="px-4 py-2 text-sm text-white">{condition.type}</td>
                    <td className="px-4 py-2 text-sm">
                      <span className={`px-2 py-1 rounded-sm text-xs font-medium ${
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
      {data.events && data.events.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-white mb-4">
            {tr('clusterView.describe.events', 'Events')}
          </h3>
          <div className="bg-slate-800 rounded-lg p-4 space-y-3 max-h-96 overflow-y-auto">
            {data.events.map((event: any, idx: number) => (
              <div key={idx} className="border-l-2 border-slate-600 pl-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-1 rounded-sm text-xs font-medium ${
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
  )
}
