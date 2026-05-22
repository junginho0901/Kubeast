import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Clock, Loader2 } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import NodeShellTerminal from '@/components/NodeShellTerminal'
import { InfoSection, InfoRow, KeyValueTags, UsageCard, EventsTable, fmtRel, fmtTs, fmtPodAge, SummaryBadge } from './DetailCommon'
import { ResourceLink } from './ResourceLink'
import { usePermission } from '@/hooks/usePermission'
import { useNodeData } from './node-info/useNodeData'
import NodeGpuInfo from './node-info/NodeGpuInfo'
import NodePrometheusMetrics from './node-info/NodePrometheusMetrics'
import NodePodsList from './node-info/NodePodsList'

interface Props { name: string }

export default function NodeInfo({ name }: Props) {
  const { t } = useTranslation()
  const tr = (k: string, fb: string, o?: Record<string, any>) => t(k, { defaultValue: fb, ...o })
  const { has } = usePermission()

  const {
    nodeDescribe,
    isLoading,
    isError,
    metricForNode,
    cpuP,
    memP,
    nodeRoles,
    capacityRows,
    sortedEvents,
    filteredPods,
    pagedPods,
    pageSize,
    totalPages,
    podFilter,
    setPodFilter,
    podPage,
    setPodPage,
    drainDialogOpen,
    setDrainDialogOpen,
    drainStatus,
    setDrainStatus,
    drainError,
    setDrainError,
    drainId,
    cordonMut,
    uncordonMut,
    drainMut,
    isSchedulingMut,
    isDrainMut,
    showNodeShell,
    setShowNodeShell,
    nodeShellSettings,
    isLinuxNode,
  } = useNodeData(name)

  if (isLoading) return <p className="text-slate-400">{tr('nodes.detail.loading', 'Loading node details...')}</p>
  if (isError) return <p className="text-red-400">{tr('nodes.detail.error', 'Failed to load node details.')}</p>
  if (!nodeDescribe) return <p className="text-slate-400">{tr('nodes.detail.notFound', 'Node details not found.')}</p>

  const showDrainStatus = drainStatus !== 'idle' || !!drainId || !!drainError
  const drainMeta = drainStatus === 'success'
    ? { icon: CheckCircle2, label: 'Completed', tone: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' }
    : drainStatus === 'error'
    ? { icon: AlertTriangle, label: 'Failed', tone: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' }
    : drainStatus === 'draining'
    ? { icon: Loader2, label: 'Draining', tone: 'text-sky-300', bg: 'bg-sky-500/10', border: 'border-sky-500/20' }
    : { icon: Clock, label: 'Queued', tone: 'text-amber-300', bg: 'bg-amber-500/10', border: 'border-amber-500/20' }

  return (
    <>
      {/* Action Buttons */}
      {(has('resource.node.cordon') || has('resource.node.drain') || has('resource.node.shell')) && (
        <div className="flex flex-wrap gap-2">
          {has('resource.node.cordon') && (
            <button
              onClick={() => nodeDescribe.unschedulable ? uncordonMut.mutate(name) : cordonMut.mutate(name)}
              disabled={isSchedulingMut || isDrainMut}
              className="text-xs px-3 py-1 rounded-md border border-slate-700 bg-slate-800 text-white hover:border-slate-500 disabled:opacity-60"
            >
              {isSchedulingMut ? (nodeDescribe.unschedulable ? tr('nodes.actions.uncordoning', 'Uncordoning...') : tr('nodes.actions.cordoning', 'Cordoning...'))
                : (nodeDescribe.unschedulable ? tr('nodes.actions.uncordon', 'Uncordon') : tr('nodes.actions.cordon', 'Cordon'))}
            </button>
          )}
          {has('resource.node.drain') && (
            <button
              onClick={() => { setDrainDialogOpen(true); setDrainError(null) }}
              disabled={isDrainMut || isSchedulingMut}
              className="text-xs px-3 py-1 rounded-md border border-slate-700 bg-slate-800 text-white hover:border-slate-500 disabled:opacity-60"
            >
              {isDrainMut ? tr('nodes.actions.draining', 'Draining...') : tr('nodes.actions.drain', 'Drain')}
            </button>
          )}
          {has('resource.node.shell') && nodeShellSettings.isEnabled && (
            <button
              onClick={() => setShowNodeShell(true)}
              disabled={!isLinuxNode}
              title={isLinuxNode ? undefined : 'Linux only'}
              className="text-xs px-3 py-1 rounded-md border border-slate-700 bg-slate-800 text-white hover:border-slate-500 disabled:opacity-60"
            >
              {tr('nodes.actions.debug', 'Debug')}
            </button>
          )}
        </div>
      )}

      {/* Drain Status Banner */}
      {showDrainStatus && (
        <div className={`flex items-start gap-3 rounded-lg border px-3 py-2 ${drainMeta.bg} ${drainMeta.border}`}>
          <drainMeta.icon className={`w-4 h-4 mt-0.5 ${drainMeta.tone} ${drainStatus === 'draining' ? 'animate-spin' : ''}`} />
          <div className="flex-1">
            <span className={`text-xs font-semibold ${drainMeta.tone}`}>Drain: {drainMeta.label}</span>
            {drainError && <div className="mt-1 text-xs text-red-300">{drainError}</div>}
          </div>
        </div>
      )}

      {/* Summary Badges */}
      <div className="flex flex-wrap items-center gap-2">
        {(() => {
          const ready = nodeDescribe.conditions?.find((c: any) => c.type === 'Ready')
          const isReady = ready?.status === 'True'
          return (
            <>
              <SummaryBadge label="Ready" value={isReady ? 'Yes' : 'No'} color={isReady ? 'green' : 'red'} />
              <SummaryBadge label="Taints" value={nodeDescribe.taints?.length || 0} color={nodeDescribe.taints?.length > 0 ? 'amber' : 'default'} />
              <SummaryBadge label="Conditions" value={nodeDescribe.conditions?.length || 0} />
              <SummaryBadge label="Roles" value={nodeRoles.length > 0 ? nodeRoles.join(', ') : 'worker'} />
            </>
          )
        })()}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3">
          <p className="text-xs text-slate-400">Uptime</p>
          <p className="text-base text-white mt-1">{fmtRel(nodeDescribe.conditions?.find((c: any) => c.type === 'Ready')?.last_transition_time)}</p>
        </div>
        <UsageCard
          label="CPU Usage"
          value={`${metricForNode?.cpu || '-'} (${metricForNode?.cpu_percent || '-'})`}
          percent={Number.isFinite(cpuP) ? cpuP : 0}
          color={cpuP >= 80 ? '#ef4444' : cpuP >= 60 ? '#f59e0b' : '#10b981'}
        />
        <UsageCard
          label="Memory Usage"
          value={`${metricForNode?.memory || '-'} (${metricForNode?.memory_percent || '-'})`}
          percent={Number.isFinite(memP) ? memP : 0}
          color={memP >= 80 ? '#ef4444' : memP >= 60 ? '#f59e0b' : '#3b82f6'}
        />
      </div>

      {/* System Info */}
      <InfoSection title={tr('nodes.detail.system', 'System Info')}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-slate-200">
          {([
            ['OS', nodeDescribe.system_info?.operating_system],
            ['Arch', nodeDescribe.system_info?.architecture],
            ['OS Image', nodeDescribe.system_info?.os_image],
            ['Kernel', nodeDescribe.system_info?.kernel_version],
            ['Runtime', nodeDescribe.system_info?.container_runtime],
            ['Kubelet', nodeDescribe.system_info?.kubelet_version],
            ['Kube Proxy', nodeDescribe.system_info?.kube_proxy_version],
            ['Boot ID', nodeDescribe.system_info?.boot_id],
            ['Machine ID', nodeDescribe.system_info?.machine_id],
            ['System UUID', nodeDescribe.system_info?.system_uuid],
            ['Roles', nodeRoles.length > 0 ? nodeRoles.join(', ') : 'worker'],
          ] as [string, string | null | undefined][]).map(([label, val]) => (
            <div key={label}>{label}: {val || '-'}</div>
          ))}
        </div>
      </InfoSection>

      {/* Capacity */}
      <InfoSection title="Capacity / Allocatable">
        {capacityRows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[540px] table-fixed">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[38%]">Resource</th>
                  <th className="text-left py-2 w-[31%]">Allocatable</th>
                  <th className="text-left py-2 w-[31%]">Capacity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {capacityRows.map((row) => (
                  <tr key={row.key} className="text-slate-200">
                    <td className="py-2 pr-2 font-mono">{row.key}</td>
                    <td className="py-2 pr-2">{row.allocatable}</td>
                    <td className="py-2 pr-2">{row.capacity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <span className="text-slate-400 text-xs">(none)</span>}
      </InfoSection>

      <NodeGpuInfo nodeDescribe={nodeDescribe} tr={tr} />

      <NodePrometheusMetrics name={name} tr={tr} />

      {/* Conditions */}
      <InfoSection title={tr('nodes.detail.conditions', 'Conditions')}>
        {nodeDescribe.conditions?.length > 0 ? (
          <div className="space-y-2 text-xs text-slate-200">
            {nodeDescribe.conditions.map((c: any, i: number) => (
              <div key={`${c.type}-${i}`} className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-medium text-white">{c.type}</div>
                  <div className="text-slate-400">{c.reason || '-'}</div>
                </div>
                <div className="text-right text-slate-400">
                  <div>{c.status}</div>
                  <div>{fmtRel(c.last_transition_time)}</div>
                </div>
              </div>
            ))}
          </div>
        ) : <span className="text-slate-400 text-xs">(none)</span>}
      </InfoSection>

      {/* Addresses & Taints */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <InfoSection title={tr('nodes.detail.addresses', 'Addresses')}>
          <div className="text-xs text-slate-200 whitespace-pre-wrap break-all">
            {nodeDescribe.addresses?.length > 0 ? nodeDescribe.addresses.map((a: any) => `${a.type}: ${a.address}`).join('\n') : '(none)'}
          </div>
        </InfoSection>
        <InfoSection title={tr('nodes.detail.taints', 'Taints')}>
          <div className="text-xs text-slate-200 whitespace-pre-wrap break-all">
            {nodeDescribe.taints?.length > 0 ? nodeDescribe.taints.map((t: any) => `${t.key || ''}=${t.value || ''}:${t.effect || ''}`).join('\n') : '(none)'}
          </div>
        </InfoSection>
      </div>

      {/* Misc */}
      <InfoSection title={tr('nodes.detail.version', 'Versions')}>
        <div className="space-y-2">
          <InfoRow label="Created" value={fmtTs(nodeDescribe.created_at)} />
          <InfoRow label="Pod CIDR" value={nodeDescribe.pod_cidr || '-'} />
          {Array.isArray(nodeDescribe.pod_cidrs) && nodeDescribe.pod_cidrs.length > 0 && (
            <InfoRow label="Pod CIDRs" value={nodeDescribe.pod_cidrs.join(', ')} />
          )}
          <InfoRow label="Scheduling" value={nodeDescribe.unschedulable ? 'Disabled' : 'Enabled'} />
        </div>
      </InfoSection>

      {/* Labels & Annotations */}
      <InfoSection title={tr('nodes.detail.labels', 'Labels')}>
        <KeyValueTags data={nodeDescribe.labels} />
      </InfoSection>
      <InfoSection title={tr('nodes.detail.annotations', 'Annotations')}>
        <KeyValueTags data={nodeDescribe.annotations} />
      </InfoSection>

      <NodePodsList
        podFilter={podFilter}
        setPodFilter={setPodFilter}
        filteredPods={filteredPods}
        pagedPods={pagedPods}
        podPage={podPage}
        setPodPage={setPodPage}
        pageSize={pageSize}
        totalPages={totalPages}
        tr={tr}
      />

      {/* Events */}
      <InfoSection title={tr('nodes.detail.eventsTitle', 'Events')}>
        <EventsTable events={sortedEvents} />
      </InfoSection>

      {/* Drain Confirm Dialog */}
      {drainDialogOpen && (
        <ModalOverlay onClose={() => setDrainDialogOpen(false)}>
          <div className="bg-slate-800 rounded-lg w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-xl font-bold text-white mb-4">{tr('nodes.drain.title', 'Drain node')}</h2>
            <p className="text-slate-300">{tr('nodes.drain.confirm', 'Are you sure you want to drain node {{name}}?', { name })}</p>
            <p className="text-slate-400 mt-3">{tr('nodes.drain.warning', 'Draining will evict pods from this node.')}</p>
            {drainError && <div className="mt-4 text-sm text-red-400">{drainError}</div>}
            <div className="mt-6 flex justify-end gap-3">
              <button className="btn btn-secondary" onClick={() => setDrainDialogOpen(false)}>Cancel</button>
              <button
                className="btn bg-red-600 hover:bg-red-700 text-white disabled:opacity-60"
                onClick={() => { setDrainStatus('pending'); setDrainDialogOpen(false); drainMut.mutate(name) }}
                disabled={isDrainMut}
              >Drain</button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* Node Shell */}
      {showNodeShell && (
        <ModalOverlay onClose={() => setShowNodeShell(false)}>
          <div className="w-full max-w-5xl h-[80vh] bg-slate-900 border border-slate-700 rounded-lg shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <NodeShellTerminal
              nodeName={name}
              namespace={nodeShellSettings.namespace}
              image={nodeShellSettings.linuxImage}
              onClose={() => setShowNodeShell(false)}
            />
          </div>
        </ModalOverlay>
      )}
    </>
  )
}
