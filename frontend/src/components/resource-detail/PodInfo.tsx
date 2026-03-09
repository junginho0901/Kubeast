import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { Download, RefreshCw } from 'lucide-react'
import { InfoSection, InfoRow, KeyValueTags, ConditionsTable, EventsTable, SummaryBadge, StatusBadge, fmtRel, fmtTs } from './DetailCommon'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
  extraTabs?: { id: string; label: string; render: () => React.ReactNode }[]
}

export default function PodInfo({ name, namespace, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (k: string, fb: string, o?: Record<string, any>) => t(k, { defaultValue: fb, ...o })

  const [logContainer, setLogContainer] = useState<string>('')
  const [logLines, setLogLines] = useState(100)
  const [showLogs, setShowLogs] = useState(false)

  const { data: podDescribe, isLoading } = useQuery({
    queryKey: ['pod-describe', namespace, name],
    queryFn: () => api.describePod(namespace, name),
    enabled: !!name && !!namespace,
  })

  const { data: logData, isFetching: logsFetching, refetch: refetchLogs } = useQuery({
    queryKey: ['pod-logs', namespace, name, logContainer, logLines],
    queryFn: () => api.getPodLogs(namespace, name, logContainer || undefined, logLines),
    enabled: showLogs && !!logContainer,
    staleTime: 5000,
  })

  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? podDescribe?.labels ?? {}) as Record<string, string>
  const annotations = (meta.annotations ?? podDescribe?.annotations ?? {}) as Record<string, string>
  const containers = (podDescribe?.containers ?? (spec.containers as any[]) ?? []) as any[]
  const conditions = (podDescribe?.conditions ?? (status.conditions as any[]) ?? []) as any[]
  const events = (podDescribe?.events ?? []) as any[]

  const phase = podDescribe?.phase || podDescribe?.status || (status.phase as string) || '-'
  const node = podDescribe?.node || (spec.nodeName as string) || '-'
  const podIP = podDescribe?.pod_ip || (status.podIP as string) || '-'
  const hostIP = (status.hostIP as string) || '-'
  const serviceAccount = podDescribe?.service_account || (spec.serviceAccountName as string) || '-'
  const createdAt = podDescribe?.created_at || (meta.creationTimestamp as string)
  const restartCount = podDescribe?.restart_count ?? containers.reduce((sum: number, c: any) => sum + (c.restart_count || c.restartCount || 0), 0)

  const containerNames = useMemo(() => {
    if (containers.length > 0) return containers.map((c: any) => c.name)
    const cs = (status.containerStatuses as any[]) ?? []
    return cs.map((c: any) => c.name)
  }, [containers, status.containerStatuses])

  if (!logContainer && containerNames.length > 0) {
    setLogContainer(containerNames[0])
  }

  if (isLoading) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>

  return (
    <>
      {/* Summary Badges */}
      <div className="flex flex-wrap items-center gap-2">
        <SummaryBadge label="Phase" value={phase} color={phase === 'Running' ? 'green' : phase === 'Pending' ? 'amber' : phase === 'Failed' ? 'red' : 'default'} />
        <SummaryBadge label="Restarts" value={restartCount} color={restartCount > 5 ? 'amber' : 'default'} />
        <SummaryBadge label="Containers" value={containerNames.length} />
      </div>

      {/* Basic Info */}
      <InfoSection title="Basic Info">
        <div className="space-y-2">
          <InfoRow label="Phase" value={<StatusBadge status={phase} />} />
          <InfoRow label="Node" value={node} />
          <InfoRow label="Pod IP" value={podIP} />
          <InfoRow label="Host IP" value={hostIP} />
          <InfoRow label="Service Account" value={serviceAccount} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          <InfoRow label="Restarts" value={String(restartCount)} />
          {typeof spec.priorityClassName === 'string' && <InfoRow label="Priority Class" value={spec.priorityClassName} />}
        </div>
      </InfoSection>

      {/* Container States */}
      <InfoSection title="Containers">
        {containers.length > 0 ? (
          <div className="space-y-3">
            {containers.map((c: any, i: number) => {
              const state = c.state || {}
              const stateKey = Object.keys(state).find(k => state[k]) || 'unknown'
              const stateDetail = state[stateKey] || {}
              const ready = c.ready !== undefined ? c.ready : undefined

              return (
                <div key={i} className="rounded border border-slate-800 p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-white">{c.name}</span>
                    <div className="flex items-center gap-2">
                      {ready !== undefined && (
                        <span className={`w-2 h-2 rounded-full ${ready ? 'bg-emerald-400' : 'bg-red-400'}`} />
                      )}
                      <span className="text-[11px] text-slate-400">{stateKey}</span>
                    </div>
                  </div>
                  <div className="text-xs text-slate-400">
                    <div>Image: <span className="text-slate-300 font-mono">{c.image}</span></div>
                    {c.restart_count !== undefined && <div>Restarts: {c.restart_count}</div>}
                    {stateDetail.reason && <div>Reason: <span className="text-amber-300">{stateDetail.reason}</span></div>}
                    {stateDetail.message && <div className="text-red-300 break-all">{stateDetail.message}</div>}
                    {stateDetail.started_at && <div>Started: {fmtTs(stateDetail.started_at)}</div>}
                    {c.ports && Array.isArray(c.ports) && c.ports.length > 0 && (
                      <div>Ports: {c.ports.map((p: any) => `${p.containerPort}/${p.protocol || 'TCP'}`).join(', ')}</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : <span className="text-slate-400 text-xs">(none)</span>}
      </InfoSection>

      {/* Tolerations */}
      {Array.isArray(spec.tolerations) && (spec.tolerations as any[]).length > 0 && (
        <InfoSection title="Tolerations">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[500px]">
              <thead className="text-slate-400"><tr><th className="text-left py-1 w-[25%]">Key</th><th className="text-left py-1 w-[20%]">Operator</th><th className="text-left py-1 w-[20%]">Value</th><th className="text-left py-1 w-[20%]">Effect</th><th className="text-left py-1 w-[15%]">Seconds</th></tr></thead>
              <tbody className="divide-y divide-slate-800">
                {(spec.tolerations as any[]).map((tol: any, i: number) => (
                  <tr key={i} className="text-slate-200">
                    <td className="py-1 pr-2">{tol.key || '*'}</td>
                    <td className="py-1 pr-2">{tol.operator || 'Equal'}</td>
                    <td className="py-1 pr-2">{tol.value || '-'}</td>
                    <td className="py-1 pr-2">{tol.effect || '-'}</td>
                    <td className="py-1 pr-2">{tol.tolerationSeconds ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {/* Conditions */}
      <InfoSection title="Conditions">
        <ConditionsTable conditions={conditions} />
      </InfoSection>

      {/* Volumes */}
      {Array.isArray(spec.volumes) && (spec.volumes as any[]).length > 0 && (
        <InfoSection title="Volumes">
          <div className="space-y-1 text-xs">
            {(spec.volumes as any[]).map((v: any, i: number) => {
              const type = Object.keys(v).find(k => k !== 'name') || 'unknown'
              return (
                <div key={i} className="flex gap-2 text-slate-200">
                  <span className="font-medium text-white min-w-[120px]">{v.name}</span>
                  <span className="text-slate-400">{type}</span>
                </div>
              )
            })}
          </div>
        </InfoSection>
      )}

      {/* Labels & Annotations */}
      <InfoSection title="Labels">
        <KeyValueTags data={labels} />
      </InfoSection>
      {Object.keys(annotations).length > 0 && (
        <InfoSection title="Annotations">
          <KeyValueTags data={annotations} />
        </InfoSection>
      )}

      {/* Events */}
      {events.length > 0 && (
        <InfoSection title="Events">
          <EventsTable events={events} />
        </InfoSection>
      )}

      {/* Logs Viewer */}
      <InfoSection title="Logs">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={logContainer}
              onChange={e => setLogContainer(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white"
            >
              {containerNames.map((n: string) => <option key={n} value={n}>{n}</option>)}
            </select>
            <select
              value={logLines}
              onChange={e => setLogLines(Number(e.target.value))}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white"
            >
              {[50, 100, 500, 1000].map(n => <option key={n} value={n}>{n} lines</option>)}
            </select>
            <button
              onClick={() => { setShowLogs(true); refetchLogs() }}
              className="text-xs px-3 py-1 rounded border border-slate-700 bg-slate-800 text-white hover:border-slate-500 flex items-center gap-1"
            >
              {logsFetching ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              {showLogs ? 'Refresh' : 'Load Logs'}
            </button>
          </div>
          {showLogs && (
            <div className="bg-slate-950 rounded-lg p-3 font-mono text-[11px] text-slate-300 max-h-[400px] overflow-auto whitespace-pre-wrap break-all">
              {logsFetching ? 'Loading...' : logData || '(no logs)'}
            </div>
          )}
        </div>
      </InfoSection>
    </>
  )
}
