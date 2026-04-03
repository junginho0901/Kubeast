import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { CheckCircle, ChevronDown, Download, RefreshCw, Terminal } from 'lucide-react'
import { InfoSection, InfoRow, KeyValueTags, ConditionsTable, EventsTable, SummaryBadge, StatusBadge, fmtRel, fmtTs } from './DetailCommon'
import { usePrometheusQueries } from '@/hooks/usePrometheusQuery'
import { PrometheusSection, MetricBar } from './PrometheusMetrics'
import { ModalOverlay } from '@/components/ModalOverlay'
import PodExecTerminal from '@/components/PodExecTerminal'

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

function formatProbe(probe: any): string | null {
  if (!probe) return null
  const parts: string[] = []
  if (probe.httpGet) {
    parts.push(`httpGet ${probe.httpGet.path || '/'}:${probe.httpGet.port ?? '-'}`)
  } else if (probe.tcpSocket) {
    parts.push(`tcpSocket :${probe.tcpSocket.port ?? '-'}`)
  } else if (probe.exec) {
    parts.push(`exec [${Array.isArray(probe.exec.command) ? probe.exec.command.join(' ') : '-'}]`)
  } else if (probe.grpc) {
    parts.push(`grpc :${probe.grpc.port ?? '-'}`)
  }
  const timing: string[] = []
  if (probe.initialDelaySeconds != null) timing.push(`delay=${probe.initialDelaySeconds}s`)
  if (probe.periodSeconds != null) timing.push(`period=${probe.periodSeconds}s`)
  if (probe.timeoutSeconds != null) timing.push(`timeout=${probe.timeoutSeconds}s`)
  if (probe.successThreshold != null) timing.push(`success=${probe.successThreshold}`)
  if (probe.failureThreshold != null) timing.push(`failure=${probe.failureThreshold}`)
  if (timing.length > 0) parts.push(timing.join(' '))
  return parts.join(' | ')
}

function getVolumeDetail(v: any): { type: string; detail: string } {
  if (v.configMap) return { type: 'ConfigMap', detail: v.configMap.name || '-' }
  if (v.secret) return { type: 'Secret', detail: v.secret.secretName || '-' }
  if (v.persistentVolumeClaim) {
    const pvc = v.persistentVolumeClaim
    return { type: 'PVC', detail: `${pvc.claimName || '-'}${pvc.readOnly ? ' (ro)' : ''}` }
  }
  if (v.emptyDir) {
    const parts: string[] = []
    if (v.emptyDir.medium) parts.push(`medium=${v.emptyDir.medium}`)
    if (v.emptyDir.sizeLimit) parts.push(`limit=${v.emptyDir.sizeLimit}`)
    return { type: 'EmptyDir', detail: parts.length > 0 ? parts.join(', ') : '(default)' }
  }
  if (v.hostPath) {
    return { type: 'HostPath', detail: `${v.hostPath.path || '-'}${v.hostPath.type ? ` (${v.hostPath.type})` : ''}` }
  }
  if (v.projected) {
    const srcs = Array.isArray(v.projected.sources)
      ? v.projected.sources.map((s: any) => Object.keys(s).join(',')).join('; ')
      : '-'
    return { type: 'Projected', detail: srcs }
  }
  if (v.downwardAPI) return { type: 'DownwardAPI', detail: 'Downward API' }
  const type = Object.keys(v).find(k => k !== 'name') || 'unknown'
  return { type, detail: '-' }
}

function formatContainerSecurityContext(sc: any): Array<[string, string]> {
  if (!sc) return []
  const rows: Array<[string, string]> = []
  if (sc.privileged != null) rows.push(['Privileged', String(sc.privileged)])
  if (sc.runAsUser != null) rows.push(['Run As User', String(sc.runAsUser)])
  if (sc.runAsNonRoot != null) rows.push(['Run As Non-Root', String(sc.runAsNonRoot)])
  if (sc.readOnlyRootFilesystem != null) rows.push(['Read-Only Root FS', String(sc.readOnlyRootFilesystem)])
  if (sc.allowPrivilegeEscalation != null) rows.push(['Allow Privilege Escalation', String(sc.allowPrivilegeEscalation)])
  if (sc.capabilities) {
    if (Array.isArray(sc.capabilities.add) && sc.capabilities.add.length > 0)
      rows.push(['Capabilities (add)', sc.capabilities.add.join(', ')])
    if (Array.isArray(sc.capabilities.drop) && sc.capabilities.drop.length > 0)
      rows.push(['Capabilities (drop)', sc.capabilities.drop.join(', ')])
  }
  return rows
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
  const [execTarget, setExecTarget] = useState<string | null>(null)
  const [execSelectContainer, setExecSelectContainer] = useState<string>('')
  const [execCommand, setExecCommand] = useState<string>('/bin/sh')
  const [isExecContainerOpen, setIsExecContainerOpen] = useState(false)
  const [isExecShellOpen, setIsExecShellOpen] = useState(false)
  const execContainerRef = useRef<HTMLDivElement>(null)
  const execShellRef = useRef<HTMLDivElement>(null)

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
    staleTime: 30000,
  })
  const isAdmin = me?.role === 'admin'

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

  // Prometheus real-time container metrics
  const promPodMetrics = usePrometheusQueries(
    ['pod-detail', namespace, name],
    [
      { name: 'cpu', promql: `sum by(container)(rate(container_cpu_usage_seconds_total{namespace="${namespace}",pod="${name}",container!="",container!="POD"}[5m])) * 1000` },
      { name: 'memory', promql: `sum by(container)(container_memory_working_set_bytes{namespace="${namespace}",pod="${name}",container!="",container!="POD"})` },
    ],
    { enabled: !!name && !!namespace },
  )

  const getContainerCpuMillis = (containerName: string): number | null => {
    const resp = promPodMetrics.data['cpu']
    if (!resp?.available || !resp.results?.length) return null
    const match = resp.results.find((r) => r.metric?.container === containerName)
    return match ? match.value : null
  }

  const getContainerMemoryMB = (containerName: string): number | null => {
    const resp = promPodMetrics.data['memory']
    if (!resp?.available || !resp.results?.length) return null
    const match = resp.results.find((r) => r.metric?.container === containerName)
    return match ? match.value / (1024 * 1024) : null
  }
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

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (execContainerRef.current && !execContainerRef.current.contains(event.target as Node)) setIsExecContainerOpen(false)
      if (execShellRef.current && !execShellRef.current.contains(event.target as Node)) setIsExecShellOpen(false)
    }
    if (isExecContainerOpen || isExecShellOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isExecContainerOpen, isExecShellOpen])

  if (isLoading) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>

  return (
    <>
      {/* Summary Badges */}
      <div className="flex flex-wrap items-center gap-2">
        <SummaryBadge label="Phase" value={phase} color={phase === 'Running' ? 'green' : phase === 'Pending' ? 'amber' : phase === 'Failed' ? 'red' : 'default'} />
        <SummaryBadge label="Restarts" value={restartCount} color={restartCount > 5 ? 'amber' : 'default'} />
        <SummaryBadge label="Containers" value={containerNames.length} />
        {isAdmin && phase === 'Running' && containerNames.length > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            {/* Container 커스텀 드롭다운 */}
            <div className="relative" ref={execContainerRef}>
              <button
                onClick={() => { setIsExecContainerOpen(!isExecContainerOpen); setIsExecShellOpen(false) }}
                className="h-7 px-2.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none transition-colors flex items-center gap-1.5 min-w-[120px] justify-between"
              >
                <span className="text-[11px] font-medium truncate">{execSelectContainer || containerNames[0]}</span>
                <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform ${isExecContainerOpen ? 'rotate-180' : ''}`} />
              </button>
              {isExecContainerOpen && (
                <div className="absolute top-full left-0 mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50 max-h-[200px] overflow-y-auto">
                  {containerNames.map((n: string) => (
                    <button
                      key={n}
                      onClick={() => { setExecSelectContainer(n); setIsExecContainerOpen(false) }}
                      className="w-full px-2.5 py-1.5 text-left text-[11px] text-white hover:bg-slate-600 transition-colors flex items-center gap-1.5 first:rounded-t-lg last:rounded-b-lg"
                    >
                      {(execSelectContainer || containerNames[0]) === n && <CheckCircle className="w-3 h-3 text-green-400 flex-shrink-0" />}
                      <span className={(execSelectContainer || containerNames[0]) === n ? 'font-medium' : ''}>{n}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Shell 커스텀 드롭다운 */}
            <div className="relative" ref={execShellRef}>
              <button
                onClick={() => { setIsExecShellOpen(!isExecShellOpen); setIsExecContainerOpen(false) }}
                className="h-7 px-2.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg border border-slate-600 focus:outline-none transition-colors flex items-center gap-1.5 min-w-[90px] justify-between"
              >
                <span className="text-[11px] font-medium">{execCommand}</span>
                <ChevronDown className={`w-3 h-3 text-slate-400 transition-transform ${isExecShellOpen ? 'rotate-180' : ''}`} />
              </button>
              {isExecShellOpen && (
                <div className="absolute top-full left-0 mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-50">
                  {['/bin/sh', '/bin/bash', '/bin/ash', 'sh'].map((sh) => (
                    <button
                      key={sh}
                      onClick={() => { setExecCommand(sh); setIsExecShellOpen(false) }}
                      className="w-full px-2.5 py-1.5 text-left text-[11px] text-white hover:bg-slate-600 transition-colors flex items-center gap-1.5 first:rounded-t-lg last:rounded-b-lg"
                    >
                      {execCommand === sh && <CheckCircle className="w-3 h-3 text-green-400 flex-shrink-0" />}
                      <span className={execCommand === sh ? 'font-medium' : ''}>{sh}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => setExecTarget(execSelectContainer || containerNames[0])}
              className="flex items-center gap-1 h-7 px-2.5 rounded-lg border border-emerald-700 bg-emerald-900/40 text-emerald-300 text-[11px] hover:bg-emerald-800/60 transition-colors"
            >
              <Terminal className="w-3.5 h-3.5" />
              Exec
            </button>
          </div>
        )}
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

      {/* Pod Security Context */}
      {(() => {
        const sc = spec.securityContext as any
        if (!sc) return null
        const rows: Array<[string, string]> = []
        if (sc.runAsUser != null) rows.push([tr('pod.secCtx.runAsUser', 'Run As User'), String(sc.runAsUser)])
        if (sc.runAsGroup != null) rows.push([tr('pod.secCtx.runAsGroup', 'Run As Group'), String(sc.runAsGroup)])
        if (sc.fsGroup != null) rows.push([tr('pod.secCtx.fsGroup', 'FS Group'), String(sc.fsGroup)])
        if (sc.runAsNonRoot != null) rows.push([tr('pod.secCtx.runAsNonRoot', 'Run As Non-Root'), String(sc.runAsNonRoot)])
        if (sc.fsGroupChangePolicy) rows.push([tr('pod.secCtx.fsGroupChangePolicy', 'FS Group Change Policy'), sc.fsGroupChangePolicy])
        if (sc.seccompProfile?.type) rows.push([tr('pod.secCtx.seccompProfile', 'Seccomp Profile'), sc.seccompProfile.type])
        if (Array.isArray(sc.supplementalGroups) && sc.supplementalGroups.length > 0)
          rows.push([tr('pod.secCtx.supplementalGroups', 'Supplemental Groups'), sc.supplementalGroups.join(', ')])
        if (rows.length === 0) return null
        return (
          <InfoSection title={tr('pod.securityContext', 'Security Context')}>
            <div className="space-y-2">
              {rows.map(([label, val]) => (
                <InfoRow key={label} label={label} value={val} />
              ))}
            </div>
          </InfoSection>
        )
      })()}

      {nodeSelector && Object.keys(nodeSelector).length > 0 && (
        <InfoSection title="Node Selector">
          <KeyValueTags data={nodeSelector} />
        </InfoSection>
      )}

      {/* Prometheus Real-time Container Metrics */}
      <PrometheusSection available={promPodMetrics.available} title="Real-time Resource Usage">
        <div className="space-y-3">
          {containers.map((c: any) => {
            const cpuMillis = getContainerCpuMillis(c.name)
            const memMB = getContainerMemoryMB(c.name)
            if (cpuMillis === null && memMB === null) return null
            const cpuLimitStr = c.limits?.cpu || c.resources?.limits?.cpu
            const memLimitStr = c.limits?.memory || c.resources?.limits?.memory
            const cpuLimitMillis = cpuLimitStr ? (cpuLimitStr.endsWith('m') ? parseFloat(cpuLimitStr) : parseFloat(cpuLimitStr) * 1000) : null
            const memLimitMB = memLimitStr ? (memLimitStr.endsWith('Gi') ? parseFloat(memLimitStr) * 1024 : memLimitStr.endsWith('Mi') ? parseFloat(memLimitStr) : parseFloat(memLimitStr) / (1024 * 1024)) : null
            return (
              <div key={c.name} className="rounded-lg border border-slate-700/50 bg-slate-900/40 p-3">
                <div className="text-xs font-medium text-slate-300 mb-2">{c.name}</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {cpuMillis !== null && (
                    <MetricBar
                      label={`CPU ${cpuMillis.toFixed(0)}m${cpuLimitMillis ? ` / ${cpuLimitMillis}m` : ''}`}
                      value={cpuLimitMillis ? (cpuMillis / cpuLimitMillis) * 100 : Math.min(cpuMillis / 10, 100)}
                      max={100}
                      unit="%"
                    />
                  )}
                  {memMB !== null && (
                    <MetricBar
                      label={`Memory ${memMB.toFixed(0)} MiB${memLimitMB ? ` / ${memLimitMB.toFixed(0)} MiB` : ''}`}
                      value={memLimitMB ? (memMB / memLimitMB) * 100 : Math.min((memMB / 512) * 100, 100)}
                      max={100}
                      unit="%"
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </PrometheusSection>

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
                      {isAdmin && stateKey === 'running' && (
                        <button
                          onClick={() => setExecTarget(c.name)}
                          className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-emerald-400 transition-colors"
                          title={t('pods.exec.openExec', { defaultValue: 'Open terminal' })}
                        >
                          <Terminal className="w-3.5 h-3.5" />
                        </button>
                      )}
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
                    {formatProbe(c.livenessProbe) && (
                      <ContainerKvRow label="Liveness Probe">
                        <span className="font-mono break-words">{formatProbe(c.livenessProbe)}</span>
                      </ContainerKvRow>
                    )}
                    {formatProbe(c.readinessProbe) && (
                      <ContainerKvRow label="Readiness Probe">
                        <span className="font-mono break-words">{formatProbe(c.readinessProbe)}</span>
                      </ContainerKvRow>
                    )}
                    {formatProbe(c.startupProbe) && (
                      <ContainerKvRow label="Startup Probe">
                        <span className="font-mono break-words">{formatProbe(c.startupProbe)}</span>
                      </ContainerKvRow>
                    )}
                    {formatContainerSecurityContext(c.securityContext).length > 0 && (
                      <>
                        {formatContainerSecurityContext(c.securityContext).map(([label, val]) => (
                          <ContainerKvRow key={`sec-${label}`} label={label}>
                            <span className="font-mono">{val}</span>
                          </ContainerKvRow>
                        ))}
                      </>
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

      {/* Affinity */}
      {(() => {
        const affinity = spec.affinity as any
        if (!affinity) return null
        const renderNodeSelectorTerms = (terms: any[]) => {
          if (!Array.isArray(terms) || terms.length === 0) return null
          return terms.map((term: any, ti: number) => (
            <div key={ti} className="space-y-1">
              {Array.isArray(term.matchExpressions) && term.matchExpressions.map((expr: any, ei: number) => (
                <span key={ei} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono mr-1 mb-1">
                  {expr.key} {expr.operator} {Array.isArray(expr.values) ? expr.values.join(', ') : ''}
                </span>
              ))}
              {Array.isArray(term.matchFields) && term.matchFields.map((field: any, fi: number) => (
                <span key={`f-${fi}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono mr-1 mb-1">
                  {field.key} {field.operator} {Array.isArray(field.values) ? field.values.join(', ') : ''}
                </span>
              ))}
            </div>
          ))
        }
        const renderPodAffinityTerms = (terms: any[], prefix: string) => {
          if (!Array.isArray(terms) || terms.length === 0) return null
          return terms.map((term: any, ti: number) => {
            const t = term.podAffinityTerm || term
            const selectors = t.labelSelector?.matchExpressions || []
            const labels = t.labelSelector?.matchLabels ? Object.entries(t.labelSelector.matchLabels) : []
            return (
              <div key={`${prefix}-${ti}`} className="rounded border border-slate-800 bg-slate-900/40 p-2 space-y-1 text-xs">
                {t.topologyKey && <div className="text-slate-400">topologyKey: <span className="text-slate-200 font-mono">{t.topologyKey}</span></div>}
                {Array.isArray(t.namespaces) && t.namespaces.length > 0 && (
                  <div className="text-slate-400">namespaces: <span className="text-slate-200 font-mono">{t.namespaces.join(', ')}</span></div>
                )}
                {labels.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {labels.map(([k, v]) => (
                      <span key={`${k}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                        {k}={String(v)}
                      </span>
                    ))}
                  </div>
                )}
                {selectors.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {selectors.map((expr: any, ei: number) => (
                      <span key={ei} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                        {expr.key} {expr.operator} {Array.isArray(expr.values) ? expr.values.join(', ') : ''}
                      </span>
                    ))}
                  </div>
                )}
                {term.weight != null && <div className="text-slate-400">weight: <span className="text-slate-200 font-mono">{term.weight}</span></div>}
              </div>
            )
          })
        }
        const sections: Array<{ title: string; content: React.ReactNode }> = []
        if (affinity.nodeAffinity) {
          const na = affinity.nodeAffinity
          const reqTerms = na.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms
          const prefTerms = na.preferredDuringSchedulingIgnoredDuringExecution
          if (reqTerms || prefTerms) {
            sections.push({
              title: tr('pod.affinity.nodeAffinity', 'Node Affinity'),
              content: (
                <div className="space-y-2">
                  {reqTerms && (
                    <div>
                      <div className="text-[11px] text-slate-500 uppercase mb-1">{tr('pod.affinity.required', 'Required')}</div>
                      {renderNodeSelectorTerms(reqTerms)}
                    </div>
                  )}
                  {Array.isArray(prefTerms) && prefTerms.length > 0 && (
                    <div>
                      <div className="text-[11px] text-slate-500 uppercase mb-1">{tr('pod.affinity.preferred', 'Preferred')}</div>
                      {prefTerms.map((pref: any, pi: number) => (
                        <div key={pi} className="space-y-1">
                          <span className="text-slate-400 text-xs">weight={pref.weight}</span>
                          {renderNodeSelectorTerms(pref.preference ? [pref.preference] : [])}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ),
            })
          }
        }
        const renderPodAffinitySection = (aff: any, label: string) => {
          if (!aff) return
          const reqTerms = aff.requiredDuringSchedulingIgnoredDuringExecution
          const prefTerms = aff.preferredDuringSchedulingIgnoredDuringExecution
          if ((!reqTerms || reqTerms.length === 0) && (!prefTerms || prefTerms.length === 0)) return
          sections.push({
            title: label,
            content: (
              <div className="space-y-2">
                {Array.isArray(reqTerms) && reqTerms.length > 0 && (
                  <div>
                    <div className="text-[11px] text-slate-500 uppercase mb-1">{tr('pod.affinity.required', 'Required')}</div>
                    {renderPodAffinityTerms(reqTerms, 'req')}
                  </div>
                )}
                {Array.isArray(prefTerms) && prefTerms.length > 0 && (
                  <div>
                    <div className="text-[11px] text-slate-500 uppercase mb-1">{tr('pod.affinity.preferred', 'Preferred')}</div>
                    {renderPodAffinityTerms(prefTerms, 'pref')}
                  </div>
                )}
              </div>
            ),
          })
        }
        renderPodAffinitySection(affinity.podAffinity, tr('pod.affinity.podAffinity', 'Pod Affinity'))
        renderPodAffinitySection(affinity.podAntiAffinity, tr('pod.affinity.podAntiAffinity', 'Pod Anti-Affinity'))
        if (sections.length === 0) return null
        return (
          <InfoSection title={tr('pod.affinity', 'Affinity')}>
            <div className="space-y-3">
              {sections.map((s, i) => (
                <div key={i}>
                  <div className="text-xs text-slate-300 font-semibold mb-1">{s.title}</div>
                  {s.content}
                </div>
              ))}
            </div>
          </InfoSection>
        )
      })()}

      {/* Topology Spread Constraints */}
      {(() => {
        const constraints = spec.topologySpreadConstraints as any[]
        if (!Array.isArray(constraints) || constraints.length === 0) return null
        return (
          <InfoSection title={tr('pod.topologySpreadConstraints', 'Topology Spread Constraints')}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs table-fixed min-w-[600px]">
                <thead className="text-slate-400">
                  <tr>
                    <th className="text-left py-1 w-[15%]">{tr('pod.tsc.maxSkew', 'Max Skew')}</th>
                    <th className="text-left py-1 w-[25%]">{tr('pod.tsc.topologyKey', 'Topology Key')}</th>
                    <th className="text-left py-1 w-[25%]">{tr('pod.tsc.whenUnsatisfiable', 'When Unsatisfiable')}</th>
                    <th className="text-left py-1 w-[35%]">{tr('pod.tsc.labelSelector', 'Label Selector')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {constraints.map((c: any, i: number) => {
                    const labels = c.labelSelector?.matchLabels
                      ? Object.entries(c.labelSelector.matchLabels).map(([k, v]) => `${k}=${v}`).join(', ')
                      : '-'
                    return (
                      <tr key={i} className="text-slate-200">
                        <td className="py-1 pr-2 font-mono">{c.maxSkew ?? '-'}</td>
                        <td className="py-1 pr-2 font-mono break-all">{c.topologyKey || '-'}</td>
                        <td className="py-1 pr-2">{c.whenUnsatisfiable || '-'}</td>
                        <td className="py-1 pr-2 font-mono break-all">{labels}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </InfoSection>
        )
      })()}

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
                    {formatProbe(c.livenessProbe) && (
                      <ContainerKvRow label="Liveness Probe">
                        <span className="font-mono break-words">{formatProbe(c.livenessProbe)}</span>
                      </ContainerKvRow>
                    )}
                    {formatProbe(c.readinessProbe) && (
                      <ContainerKvRow label="Readiness Probe">
                        <span className="font-mono break-words">{formatProbe(c.readinessProbe)}</span>
                      </ContainerKvRow>
                    )}
                    {formatProbe(c.startupProbe) && (
                      <ContainerKvRow label="Startup Probe">
                        <span className="font-mono break-words">{formatProbe(c.startupProbe)}</span>
                      </ContainerKvRow>
                    )}
                    {formatContainerSecurityContext(c.securityContext).length > 0 && (
                      <>
                        {formatContainerSecurityContext(c.securityContext).map(([label, val]) => (
                          <ContainerKvRow key={`sec-init-${label}`} label={label}>
                            <span className="font-mono">{val}</span>
                          </ContainerKvRow>
                        ))}
                      </>
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
        <InfoSection title={tr('pod.volumes', 'Volumes')}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[500px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1 w-[30%]">{tr('pod.volumes.name', 'Name')}</th>
                  <th className="text-left py-1 w-[20%]">{tr('pod.volumes.type', 'Type')}</th>
                  <th className="text-left py-1 w-[50%]">{tr('pod.volumes.details', 'Details')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {(((podDescribe?.volumes as any[]) ?? (spec.volumes as any[])) as any[]).map((v: any, i: number) => {
                  const { type, detail } = getVolumeDetail(v)
                  return (
                    <tr key={i} className="text-slate-200">
                      <td className="py-1 pr-2 font-medium text-white break-all">{v.name}</td>
                      <td className="py-1 pr-2 text-slate-400">{type}</td>
                      <td className="py-1 pr-2 font-mono break-all">{detail}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
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

      {execTarget && (
        <ModalOverlay onClose={() => setExecTarget(null)}>
          <div
            className="bg-slate-800 rounded-lg w-full max-w-4xl h-[70vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <PodExecTerminal
              podName={name}
              namespace={namespace}
              container={execTarget}
              command={execCommand}
              onClose={() => setExecTarget(null)}
            />
          </div>
        </ModalOverlay>
      )}
    </>
  )
}
