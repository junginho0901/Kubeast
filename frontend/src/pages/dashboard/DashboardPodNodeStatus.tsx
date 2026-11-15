// Dashboard pod / node status charts (one flat bar per status).
// Click a bar → drill into the matching list (handled by parent via
// onPodStatusClick / onNodeStatusClick). Each chart is hidden when
// its data array is empty. While the summary read is failed the Pod
// status chart shows "—" and the failure, as the summary cards do.

import { useTranslation } from 'react-i18next'

import { failureText } from '@/utils/failureText'
import { StatusBarChart } from './StatusBarChart'

// colour by meaning: the normal state in the brand blue, failures red, waiting amber, the rest grey
const STATE_COLOR: Record<string, string> = {
  Running: 'var(--color-primary-bright)',
  Ready: 'var(--color-primary-bright)',
  Succeeded: 'var(--color-slate-400)',
  Pending: 'var(--color-amber-400)',
  Failed: 'var(--color-red-400)',
  NotReady: 'var(--color-red-400)',
}
const stateColor = (name: string) => STATE_COLOR[name] ?? 'var(--color-slate-500)'
// a node without a Ready condition is red, as on the Nodes list
const nodeColor = (name: string) => (name === 'Unknown' ? STATE_COLOR.NotReady : stateColor(name))

interface BarDatum {
  name: string
  value: number
}

interface Props {
  podStatusData: BarDatum[]
  nodeStatusChartData: BarDatum[]
  /** the summary read's error while it is failed: shown in place of the bars, which would be the last answer's */
  podStatusFailure?: unknown
  onPodStatusClick: (status: string) => void
  onNodeStatusClick: (status: string) => void
}

export function DashboardPodNodeStatus({
  podStatusData,
  nodeStatusChartData,
  podStatusFailure,
  onPodStatusClick,
  onNodeStatusClick,
}: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })
  const podTitle = tr('dashboard.podStatus.title', 'Pod status')
  const failure = podStatusFailure ? readFailureText(podStatusFailure, podTitle, tr) : null

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {(failure || podStatusData.length > 0) && (
        <div className="card">
          <h2 className="text-lg font-semibold text-ink">{podTitle}</h2>
          {failure ? (
            <div data-testid="pod-status-read-failed">
              <p className="mt-2 text-2xl font-semibold text-ink tabular-nums">—</p>
              <p className="mt-2 text-sm text-slate-400 break-words">{failure.text}</p>
              {failure.reason && <p className="mt-1 text-xs text-slate-500 break-words">{failure.reason}</p>}
            </div>
          ) : (
            <>
              <p className="text-sm text-slate-400 mt-1 mb-4">
                {tr('dashboard.podStatus.subtitle', 'Click to view pods in each status')}
              </p>
              <StatusBarChart data={podStatusData} colorFor={stateColor} onBarClick={onPodStatusClick} />
            </>
          )}
        </div>
      )}

      {nodeStatusChartData.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold text-ink">{tr('dashboard.nodeStatus.title', 'Node status')}</h2>
          <p className="text-sm text-slate-400 mt-1 mb-4">
            {tr('dashboard.nodeStatus.subtitle', 'Click to view nodes in each status')}
          </p>
          <StatusBarChart data={nodeStatusChartData} colorFor={nodeColor} onBarClick={onNodeStatusClick} />
        </div>
      )}
    </div>
  )
}

// A read that did not answer, in the lists' shared words: a refusal (403) as no permission with the server's reason
// under it, else the status, or no answer, with the reason.
function readFailureText(
  err: unknown,
  resource: string,
  tr: (key: string, fallback: string, options?: Record<string, any>) => string,
): { text: string; reason?: string } {
  const status = (err as { response?: { status?: unknown } } | null | undefined)?.response?.status
  const reason = failureText(err)
  if (status === 403) {
    return { text: tr('common.forbiddenEmpty', 'You do not have permission to view {{resource}} in this cluster.', { resource }), reason }
  }
  return typeof status === 'number'
    ? { text: tr('common.loadErrorEmptyReason', 'Could not load {{resource}} (server error {{code}}): {{reason}}', { resource, code: status, reason }) }
    : { text: tr('common.loadErrorEmptyNetworkReason', 'Could not load {{resource}} (no response from the server): {{reason}}', { resource, reason }) }
}
