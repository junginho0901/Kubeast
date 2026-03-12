import { type ReactNode, useEffect, useMemo, useState } from 'react'
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

function formatContainerCommand(command: unknown, args: unknown): string {
  const cmd = Array.isArray(command) ? command : []
  const argv = Array.isArray(args) ? args : []
  const merged = [...cmd, ...argv].filter(Boolean)
  return merged.length > 0 ? merged.join(' ') : '-'
}

function toEntryPairs(value: unknown): Array<[string, string]> {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)])
}

function toPorts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((p: any) => `${p?.containerPort ?? p?.container_port ?? '-'} / ${p?.protocol || 'TCP'}`)
    .filter((v: string) => v.trim() !== '- / TCP')
}

function toMounts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((m: any) => `${m?.name || '-'} -> ${m?.mountPath ?? m?.mount_path ?? '-'}`)
    .filter((v: string) => v.trim() !== '- -> -')
}

function ContainerKvRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 items-start py-1.5">
      <span className="text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
      <div className="text-xs text-slate-100">{children}</div>
    </div>
  )
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
    retry: false,
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
  const containers = useMemo(() => (
    (podDescribe?.containers ?? (spec.containers as any[]) ?? []) as any[]
  ), [podDescribe?.containers, spec.containers])
  const initContainers = useMemo(() => (
    (podDescribe?.init_containers ?? (spec.initContainers as any[]) ?? []) as any[]
  ), [podDescribe?.init_containers, spec.initContainers])
  const conditions = (podDescribe?.conditions ?? (status.conditions as any[]) ?? []) as any[]
  const events = (podDescribe?.events ?? []) as any[]

  const phase = podDescribe?.phase || podDescribe?.status || (status.phase as string) || '-'
  const node = podDescribe?.node || (spec.nodeName as string) || '-'
  const podIP = podDescribe?.pod_ip || (status.podIP as string) || '-'
  const podIPs = (podDescribe?.pod_ips as string[] | undefined)
    ?? ((status.podIPs as Array<{ ip?: string }> | undefined)?.map((item) => item?.ip || '').filter(Boolean))
    ?? []
  const hostIP = (podDescribe?.host_ip as string | undefined) || (status.hostIP as string) || '-'
  const hostIPs = (podDescribe?.host_ips as string[] | undefined)
    ?? ((status.hostIPs as Array<{ ip?: string }> | undefined)?.map((item) => item?.ip || '').filter(Boolean))
    ?? []
  const serviceAccount = podDescribe?.service_account || (spec.serviceAccountName as string) || '-'
  const createdAt = podDescribe?.created_at || (meta.creationTimestamp as string)
  const startTime = (podDescribe?.start_time as string | undefined) || (status.startTime as string | undefined)
  const restartCount = podDescribe?.restart_count ?? containers.reduce((sum: number, c: any) => sum + (c.restart_count || c.restartCount || 0), 0)
  const qosClass = (podDescribe?.qos_class as string | undefined) || (status.qosClass as string | undefined)
  const priority = podDescribe?.priority ?? spec.priority
  const priorityClass = (podDescribe?.priority_class as string | undefined) || (spec.priorityClassName as string | undefined)
  const nominatedNode = (podDescribe?.nominated_node_name as string | undefined) || (status.nominatedNodeName as string | undefined)
  const restartPolicy = (podDescribe?.restart_policy as string | undefined) || (spec.restartPolicy as string | undefined)
  const preemptionPolicy = (podDescribe?.preemption_policy as string | undefined) || (spec.preemptionPolicy as string | undefined)
  const runtimeClassName = (podDescribe?.runtime_class_name as string | undefined) || (spec.runtimeClassName as string | undefined)
  const hostNetwork = podDescribe?.host_network ?? spec.hostNetwork
  const hostPID = podDescribe?.host_pid ?? spec.hostPID
  const hostIPC = podDescribe?.host_ipc ?? spec.hostIPC
  const nodeSelector = (podDescribe?.node_selector as Record<string, string> | undefined) || (spec.nodeSelector as Record<string, string> | undefined)
  const ownerRefs = (podDescribe?.owner_references as any[] | undefined) || (meta.ownerReferences as any[] | undefined) || []
  const finalizers = (podDescribe?.finalizers as string[] | undefined) || (meta.finalizers as string[] | undefined) || []
  const readyPair = String(podDescribe?.ready || '').match(/^(\d+)\/(\d+)$/)
  const readyContainers = readyPair ? Number(readyPair[1]) || 0 : containers.filter((c: any) => c.ready).length
  const totalContainers = readyPair ? Number(readyPair[2]) || 0 : containers.length
  const waitingCount = containers.filter((c: any) => Boolean(c?.state?.waiting)).length
  const terminatedCount = containers.filter((c: any) => Boolean(c?.state?.terminated)).length
  const crashLoopCount = containers.filter((c: any) => c?.state?.waiting?.reason === 'CrashLoopBackOff').length
  const statusReason = useMemo(() => {
    if (typeof podDescribe?.status_reason === 'string' && podDescribe.status_reason) return podDescribe.status_reason
    const reasons = containers
      .map((c: any) => c?.state?.waiting?.reason || c?.state?.terminated?.reason || c?.last_state?.terminated?.reason)
      .filter(Boolean)
    if (reasons.length > 0) return String(reasons[0])
    if (phase === 'Running' && totalContainers > 0 && readyContainers < totalContainers) return 'NotReady'
    return phase
  }, [podDescribe?.status_reason, containers, phase, totalContainers, readyContainers])

  const containerNames = useMemo(() => {
    if (containers.length > 0) return containers.map((c: any) => c.name)
    const cs = (status.containerStatuses as any[]) ?? []
    return cs.map((c: any) => c.name)
  }, [containers, status.containerStatuses])

  useEffect(() => {
    if (!logContainer && containerNames.length > 0) {
      setLogContainer(containerNames[0])
    }
  }, [logContainer, containerNames])

  if (isLoading) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>

  return (
    <>
      {/* Summary Badges */}
      <div className="flex flex-wrap items-center gap-2">
        <SummaryBadge label="Phase" value={phase} color={phase === 'Running' ? 'green' : phase === 'Pending' ? 'amber' : phase === 'Failed' ? 'red' : 'default'} />
        <SummaryBadge label="Restarts" value={restartCount} color={restartCount > 5 ? 'amber' : 'default'} />
        <SummaryBadge label="Containers" value={containerNames.length} />
      </div>

      {/* Top Summary */}
      <InfoSection title="Top">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="rounded border border-slate-800 bg-slate-900/70 px-3 py-2">
            <div className="text-[11px] text-slate-400">Status</div>
            <div className="mt-1 text-xs text-white font-medium truncate" title={statusReason}>{statusReason || '-'}</div>
          </div>
          <div className="rounded border border-slate-800 bg-slate-900/70 px-3 py-2">
            <div className="text-[11px] text-slate-400">Ready</div>
            <div className="mt-1 text-xs text-white font-medium">{`${readyContainers}/${Math.max(totalContainers, 0)}`}</div>
          </div>
          <div className="rounded border border-slate-800 bg-slate-900/70 px-3 py-2">
            <div className="text-[11px] text-slate-400">Waiting</div>
            <div className="mt-1 text-xs text-white font-medium">{waitingCount}</div>
          </div>
          <div className="rounded border border-slate-800 bg-slate-900/70 px-3 py-2">
            <div className="text-[11px] text-slate-400">CrashLoop</div>
            <div className={`mt-1 text-xs font-medium ${crashLoopCount > 0 ? 'text-red-300' : 'text-white'}`}>{crashLoopCount}</div>
          </div>
          <div className="rounded border border-slate-800 bg-slate-900/70 px-3 py-2">
            <div className="text-[11px] text-slate-400">Terminated</div>
            <div className="mt-1 text-xs text-white font-medium">{terminatedCount}</div>
          </div>
        </div>
      </InfoSection>

      {/* Basic Info */}
      <InfoSection title="Basic Info">
        <div className="space-y-2">
          <InfoRow label="Phase" value={<StatusBadge status={phase} />} />
          <InfoRow label="Node" value={node} />
          <InfoRow label="Pod IP" value={podIP} />
          {podIPs.length > 0 && <InfoRow label="Pod IPs" value={podIPs.join(', ')} />}
          <InfoRow label="Host IP" value={hostIP} />
          {hostIPs.length > 0 && <InfoRow label="Host IPs" value={hostIPs.join(', ')} />}
          <InfoRow label="Service Account" value={serviceAccount} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {startTime && <InfoRow label="Start Time" value={`${fmtTs(startTime)} (${fmtRel(startTime)})`} />}
          <InfoRow label="Restarts" value={String(restartCount)} />
          {qosClass && <InfoRow label="QoS Class" value={qosClass} />}
          {priority != null && <InfoRow label="Priority" value={String(priority)} />}
          {priorityClass && <InfoRow label="Priority Class" value={priorityClass} />}
          {nominatedNode && <InfoRow label="Nominated Node" value={nominatedNode} />}
          {podDescribe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{podDescribe.uid}</span>} />}
        </div>
      </InfoSection>

      {/* Spec Details */}
      <InfoSection title="Spec">
        <div className="space-y-2">
          <InfoRow label="Restart Policy" value={restartPolicy || '-'} />
          {runtimeClassName && <InfoRow label="Runtime Class" value={runtimeClassName} />}
          {preemptionPolicy && <InfoRow label="Preemption Policy" value={preemptionPolicy} />}
          <InfoRow label="Host Network" value={hostNetwork ? 'Enabled' : 'Disabled'} />
          <InfoRow label="Host PID" value={hostPID ? 'Enabled' : 'Disabled'} />
          <InfoRow label="Host IPC" value={hostIPC ? 'Enabled' : 'Disabled'} />
        </div>
      </InfoSection>

      {nodeSelector && Object.keys(nodeSelector).length > 0 && (
        <InfoSection title="Node Selector">
          <KeyValueTags data={nodeSelector} />
        </InfoSection>
      )}

      {/* Container States */}
      <InfoSection title="Containers">
        {containers.length > 0 ? (
          <div className="space-y-2">
            {containers.map((c: any, i: number) => {
              const state = c.state || {}
              const stateKey = Object.keys(state).find(k => state[k]) || 'unknown'
              const stateDetail = state[stateKey] || {}
              const ready = c.ready !== undefined ? c.ready : undefined
              const requests = c.requests ?? c?.resources?.requests
              const limits = c.limits ?? c?.resources?.limits
              const mounts = c.volume_mounts ?? c.volumeMounts
              const envCount = typeof c.env_count === 'number'
                ? c.env_count
                : (Array.isArray(c.env) ? c.env.length : undefined)

              return (
                <div key={i} className="rounded border border-slate-800 bg-slate-900/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white break-words">{c.name || `container-${i + 1}`}</span>
                    <div className="flex items-center gap-2">
                      {ready !== undefined && (
                        <span className={`w-2 h-2 rounded-full ${ready ? 'bg-emerald-400' : 'bg-red-400'}`} />
                      )}
                      <span className="text-[11px] text-slate-400">{stateKey}</span>
                    </div>
                  </div>
                  <div className="divide-y divide-slate-800/70">
                    <ContainerKvRow label="Image">
                      <span className="font-mono break-all">{c.image || '-'}</span>
                    </ContainerKvRow>
                    <ContainerKvRow label="Command">
                      <span className="font-mono break-words whitespace-pre-wrap">{formatContainerCommand(c.command, c.args)}</span>
                    </ContainerKvRow>
                    <ContainerKvRow label="Restarts">
                      <span className="font-mono">{String(c.restart_count ?? c.restartCount ?? 0)}</span>
                    </ContainerKvRow>
                    {stateDetail.reason && (
                      <ContainerKvRow label="Reason">
                        <span className="text-amber-300 break-words">{stateDetail.reason}</span>
                      </ContainerKvRow>
                    )}
                    {stateDetail.message && (
                      <ContainerKvRow label="Message">
                        <span className="text-red-300 break-words whitespace-pre-wrap">{stateDetail.message}</span>
                      </ContainerKvRow>
                    )}
                    {stateDetail.started_at && (
                      <ContainerKvRow label="Started">
                        <span className="text-slate-200">{fmtTs(stateDetail.started_at)}</span>
                      </ContainerKvRow>
                    )}
                    {toPorts(c.ports).length > 0 && (
                      <ContainerKvRow label="Ports">
                        <div className="flex flex-wrap gap-1">
                          {toPorts(c.ports).map((port, idx) => (
                            <span key={`${port}-${idx}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                              {port}
                            </span>
                          ))}
                        </div>
                      </ContainerKvRow>
                    )}
                    {toEntryPairs(requests).length > 0 && (
                      <ContainerKvRow label="Requests">
                        <div className="flex flex-wrap gap-1">
                          {toEntryPairs(requests).map(([k, v]) => (
                            <span key={`req-${k}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                              {k}={v}
                            </span>
                          ))}
                        </div>
                      </ContainerKvRow>
                    )}
                    {toEntryPairs(limits).length > 0 && (
                      <ContainerKvRow label="Limits">
                        <div className="flex flex-wrap gap-1">
                          {toEntryPairs(limits).map(([k, v]) => (
                            <span key={`lim-${k}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                              {k}={v}
                            </span>
                          ))}
                        </div>
                      </ContainerKvRow>
                    )}
                    {typeof envCount === 'number' && (
                      <ContainerKvRow label="Env">
                        <span className="text-slate-200 font-mono">{envCount}</span>
                      </ContainerKvRow>
                    )}
                    {toMounts(mounts).length > 0 && (
                      <ContainerKvRow label="Mounts">
                        <div className="flex flex-wrap gap-1">
                          {toMounts(mounts).map((mount, idx) => (
                            <span key={`${mount}-${idx}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                              {mount}
                            </span>
                          ))}
                        </div>
                      </ContainerKvRow>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : <span className="text-slate-400 text-xs">(none)</span>}
      </InfoSection>

      {/* Tolerations */}
      {Array.isArray((podDescribe?.tolerations as any[]) ?? (spec.tolerations as any[])) &&
        ((podDescribe?.tolerations as any[]) ?? (spec.tolerations as any[])).length > 0 && (
        <InfoSection title="Tolerations">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[500px]">
              <thead className="text-slate-400"><tr><th className="text-left py-1 w-[25%]">Key</th><th className="text-left py-1 w-[20%]">Operator</th><th className="text-left py-1 w-[20%]">Value</th><th className="text-left py-1 w-[20%]">Effect</th><th className="text-left py-1 w-[15%]">Seconds</th></tr></thead>
              <tbody className="divide-y divide-slate-800">
                {(((podDescribe?.tolerations as any[]) ?? (spec.tolerations as any[])) as any[]).map((tol: any, i: number) => (
                  <tr key={i} className="text-slate-200">
                    <td className="py-1 pr-2">{tol.key || '*'}</td>
                    <td className="py-1 pr-2">{tol.operator || 'Equal'}</td>
                    <td className="py-1 pr-2">{tol.value || '-'}</td>
                    <td className="py-1 pr-2">{tol.effect || '-'}</td>
                    <td className="py-1 pr-2">{tol.tolerationSeconds ?? tol.toleration_seconds ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {/* Init Containers */}
      {initContainers.length > 0 && (
        <InfoSection title="Init Containers">
          <div className="space-y-2">
            {initContainers.map((c: any, i: number) => {
              const state = c.state || {}
              const stateKey = Object.keys(state).find(k => state[k]) || 'unknown'
              const stateDetail = state[stateKey] || {}
              const requests = c.requests ?? c?.resources?.requests
              const limits = c.limits ?? c?.resources?.limits
              const mounts = c.volume_mounts ?? c.volumeMounts
              const envCount = typeof c.env_count === 'number'
                ? c.env_count
                : (Array.isArray(c.env) ? c.env.length : undefined)
              return (
                <div key={`${c.name || 'init'}-${i}`} className="rounded border border-slate-800 bg-slate-900/40 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-white break-words">{c.name || `init-${i + 1}`}</span>
                    <span className="text-[11px] text-slate-400">{stateKey}</span>
                  </div>
                  <div className="divide-y divide-slate-800/70">
                    <ContainerKvRow label="Image">
                      <span className="font-mono break-all">{c.image || '-'}</span>
                    </ContainerKvRow>
                    <ContainerKvRow label="Command">
                      <span className="font-mono break-words whitespace-pre-wrap">{formatContainerCommand(c.command, c.args)}</span>
                    </ContainerKvRow>
                    <ContainerKvRow label="Restarts">
                      <span className="font-mono">{String(c.restart_count ?? c.restartCount ?? 0)}</span>
                    </ContainerKvRow>
                    {stateDetail.reason && (
                      <ContainerKvRow label="Reason">
                        <span className="text-amber-300 break-words">{stateDetail.reason}</span>
                      </ContainerKvRow>
                    )}
                    {stateDetail.message && (
                      <ContainerKvRow label="Message">
                        <span className="text-red-300 break-words whitespace-pre-wrap">{stateDetail.message}</span>
                      </ContainerKvRow>
                    )}
                    {toPorts(c.ports).length > 0 && (
                      <ContainerKvRow label="Ports">
                        <div className="flex flex-wrap gap-1">
                          {toPorts(c.ports).map((port, idx) => (
                            <span key={`${port}-${idx}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                              {port}
                            </span>
                          ))}
                        </div>
                      </ContainerKvRow>
                    )}
                    {toEntryPairs(requests).length > 0 && (
                      <ContainerKvRow label="Requests">
                        <div className="flex flex-wrap gap-1">
                          {toEntryPairs(requests).map(([k, v]) => (
                            <span key={`req-init-${k}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                              {k}={v}
                            </span>
                          ))}
                        </div>
                      </ContainerKvRow>
                    )}
                    {toEntryPairs(limits).length > 0 && (
                      <ContainerKvRow label="Limits">
                        <div className="flex flex-wrap gap-1">
                          {toEntryPairs(limits).map(([k, v]) => (
                            <span key={`lim-init-${k}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                              {k}={v}
                            </span>
                          ))}
                        </div>
                      </ContainerKvRow>
                    )}
                    {typeof envCount === 'number' && (
                      <ContainerKvRow label="Env">
                        <span className="text-slate-200 font-mono">{envCount}</span>
                      </ContainerKvRow>
                    )}
                    {toMounts(mounts).length > 0 && (
                      <ContainerKvRow label="Mounts">
                        <div className="flex flex-wrap gap-1">
                          {toMounts(mounts).map((mount, idx) => (
                            <span key={`${mount}-${idx}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                              {mount}
                            </span>
                          ))}
                        </div>
                      </ContainerKvRow>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </InfoSection>
      )}

      {/* Conditions */}
      <InfoSection title="Conditions">
        <ConditionsTable conditions={conditions} />
      </InfoSection>

      {/* Volumes */}
      {Array.isArray((podDescribe?.volumes as any[]) ?? (spec.volumes as any[])) &&
        (((podDescribe?.volumes as any[]) ?? (spec.volumes as any[])) as any[]).length > 0 && (
        <InfoSection title="Volumes">
          <div className="space-y-1 text-xs">
            {(((podDescribe?.volumes as any[]) ?? (spec.volumes as any[])) as any[]).map((v: any, i: number) => {
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
      {(ownerRefs.length > 0 || finalizers.length > 0) && (
        <InfoSection title="Lifecycle">
          <div className="space-y-2">
            {ownerRefs.length > 0 && (
              <InfoRow
                label="Owner References"
                value={
                  <div className="text-xs text-slate-200 space-y-1">
                    {ownerRefs.map((ref: any, idx: number) => (
                      <div key={`${ref.kind || 'Owner'}-${ref.name || idx}`}>
                        <span className="font-medium">{ref.kind || '-'}</span>/{ref.name || '-'}
                        {ref.controller ? ' (controller)' : ''}
                      </div>
                    ))}
                  </div>
                }
              />
            )}
            {finalizers.length > 0 && (
              <InfoRow label="Finalizers" value={<span className="font-mono text-[11px] break-all">{finalizers.join(', ')}</span>} />
            )}
          </div>
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
