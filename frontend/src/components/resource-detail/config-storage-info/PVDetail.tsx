import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { ConditionsTable, EventsTable, InfoSection, InfoRow, KeyValueTags, StatusBadge, fmtRel, fmtTs } from '../DetailCommon'
import { ResourceLink } from '../ResourceLink'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface PVClaimRef {
  namespace?: string | null
  name?: string | null
  uid?: string | null
}

interface PVBoundClaimSummary {
  namespace?: string | null
  name?: string | null
  status?: string | null
  requested?: string | null
  capacity?: string | null
  storage_class?: string | null
  volume_mode?: string | null
  access_modes?: string[] | null
}

interface PVUsedByPod {
  name?: string | null
  namespace?: string | null
  phase?: string | null
  node_name?: string | null
  ready?: string | null
  restart_count?: number | null
  volume_names?: string[] | null
  created_at?: string | null
}

interface PVDescribeResponse {
  uid?: string
  resource_version?: string
  status?: string
  capacity?: string
  access_modes?: string[]
  storage_class?: string
  reclaim_policy?: string
  volume_mode?: string
  claim_ref?: PVClaimRef | null
  source?: string | null
  driver?: string | null
  volume_handle?: string | null
  node_affinity?: string | null
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string
  last_phase_transition_time?: string | null
  bound_claim?: PVBoundClaimSummary | null
  used_by_pods?: PVUsedByPod[]
  conditions?: Array<Record<string, unknown>>
  events?: Array<Record<string, unknown>>
  reason?: string | null
  message?: string | null
}

export default function PVDetail({ name, rawJson }: { name: string; rawJson?: Record<string, unknown> }) {
  const { open: openDetail } = useResourceDetail()
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['pv-describe', name],
    queryFn: () => api.describePV(name) as Promise<PVDescribeResponse>,
    enabled: !!name,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'PersistentVolume', name, describe })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const rawClaimRef = (spec.claimRef as Record<string, unknown> | undefined) ?? undefined
  const claimRef = (describe?.claim_ref ?? {
    namespace: rawClaimRef?.namespace as string | undefined,
    name: rawClaimRef?.name as string | undefined,
  }) as PVClaimRef | null

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const statusPhase = String(describe?.status ?? status.phase ?? '-')
  const capacity = String(describe?.capacity ?? (spec.capacity as Record<string, string> | undefined)?.storage ?? '-')
  const accessModes = (describe?.access_modes ?? (spec.accessModes as string[] | undefined) ?? [])
  const storageClass = String(describe?.storage_class ?? spec.storageClassName ?? '-')
  const reclaimPolicy = String(describe?.reclaim_policy ?? spec.persistentVolumeReclaimPolicy ?? '-')
  const volumeMode = String(describe?.volume_mode ?? spec.volumeMode ?? 'Filesystem')
  const source = describe?.source ?? String(rawJson?.source ?? '-')
  const driver = describe?.driver ?? String(rawJson?.driver ?? '-')
  const volumeHandle = describe?.volume_handle ?? String(rawJson?.volume_handle ?? '-')
  const nodeAffinity = describe?.node_affinity ?? String(rawJson?.node_affinity ?? '-')
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)
  const lastPhaseTransitionTime = describe?.last_phase_transition_time ?? null
  const finalizers = Array.isArray(describe?.finalizers) ? describe.finalizers : []
  const conditions = Array.isArray(describe?.conditions)
    ? describe.conditions
    : (Array.isArray(status.conditions) ? status.conditions : [])
  const events = Array.isArray(describe?.events) ? describe.events : []
  const boundClaim = describe?.bound_claim ?? null
  const usedByPods = Array.isArray(describe?.used_by_pods) ? describe.used_by_pods : []
  const displayedUsedByPods = usedByPods.slice(0, 50)
  const claimText = claimRef?.name
    ? (claimRef.namespace ? `${claimRef.namespace}/${claimRef.name}` : String(claimRef.name))
    : '-'

  const sourceText = source && source !== '-'
    ? `${source}${driver && driver !== '-' ? ` (${driver})` : ''}`
    : (driver && driver !== '-' ? driver : '-')

  return (
    <>
      <InfoSection title="PersistentVolume Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Status" value={<StatusBadge status={statusPhase} />} />
          <InfoRow label="Capacity" value={capacity} />
          <InfoRow label="Access Modes" value={accessModes.join(', ') || '-'} />
          <InfoRow label="Reclaim Policy" value={reclaimPolicy} />
          <InfoRow label="Storage Class" value={storageClass && storageClass !== '-' ? <ResourceLink kind="StorageClass" name={storageClass} /> : '-'} />
          <InfoRow label="Volume Mode" value={volumeMode} />
          <InfoRow
            label="Claim"
            value={claimRef?.name ? (
              <ResourceLink kind="PersistentVolumeClaim" name={String(claimRef.name)} namespace={claimRef.namespace ? String(claimRef.namespace) : undefined} />
            ) : claimText}
          />
          <InfoRow label="Source" value={sourceText} />
          <InfoRow label="Volume Handle" value={volumeHandle !== '-' ? <span className="font-mono break-all text-[11px]">{volumeHandle}</span> : '-'} />
          <InfoRow label="Node Affinity" value={nodeAffinity} />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{String(describe.uid)}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px] break-all">{String(describe.resource_version)}</span>} />}
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {lastPhaseTransitionTime && (
            <InfoRow
              label="Last Phase Transition"
              value={`${fmtTs(lastPhaseTransitionTime)} (${fmtRel(lastPhaseTransitionTime)})`}
            />
          )}
          {describe?.reason && <InfoRow label="Failure Reason" value={String(describe.reason)} />}
          {describe?.message && <InfoRow label="Failure Message" value={<span className="text-red-300 break-words">{String(describe.message)}</span>} />}
        </div>
      </InfoSection>
      {isLoading && <p className="text-xs text-slate-400">Loading details...</p>}
      {isError && <p className="text-xs text-amber-300">Some detailed PV fields are unavailable right now.</p>}
      {boundClaim?.name && (
        <InfoSection title="Bound PersistentVolumeClaim">
          <div className="space-y-2">
            <InfoRow
              label="Name"
              value={boundClaim.namespace ? (
                <button
                  type="button"
                  className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 break-all text-left"
                  onClick={() => openDetail({
                    kind: 'PersistentVolumeClaim',
                    name: String(boundClaim.name),
                    namespace: String(boundClaim.namespace),
                  })}
                >
                  {`${boundClaim.namespace}/${boundClaim.name}`}
                </button>
              ) : String(boundClaim.name)}
            />
            <InfoRow label="Status" value={<StatusBadge status={String(boundClaim.status ?? '-')} />} />
            <InfoRow label="Requested" value={String(boundClaim.requested ?? '-')} />
            <InfoRow label="Capacity" value={String(boundClaim.capacity ?? '-')} />
            <InfoRow label="Storage Class" value={String(boundClaim.storage_class ?? '-')} />
            <InfoRow label="Volume Mode" value={String(boundClaim.volume_mode ?? '-')} />
            <InfoRow label="Access Modes" value={Array.isArray(boundClaim.access_modes) ? boundClaim.access_modes.join(', ') || '-' : '-'} />
          </div>
        </InfoSection>
      )}
      {usedByPods.length > 0 && (
        <InfoSection title={`Used By Pods (${usedByPods.length})`}>
          {usedByPods.length > displayedUsedByPods.length && (
            <p className="text-[11px] text-slate-400 mb-2">
              Showing first {displayedUsedByPods.length} pods.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[760px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[24%]">Pod</th>
                  <th className="text-left py-2 w-[12%]">Status</th>
                  <th className="text-left py-2 w-[8%]">Ready</th>
                  <th className="text-left py-2 w-[10%]">Restarts</th>
                  <th className="text-left py-2 w-[18%]">Node</th>
                  <th className="text-left py-2 w-[18%]">Mounted As</th>
                  <th className="text-left py-2 w-[10%]">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {displayedUsedByPods.map((pod, idx) => (
                  <tr
                    key={`${pod.namespace ?? claimRef?.namespace ?? '-'}-${pod.name ?? '-'}-${idx}`}
                    className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => {
                      const podNamespace = pod.namespace || claimRef?.namespace
                      if (!pod.name || !podNamespace) return
                      openDetail({ kind: 'Pod', name: String(pod.name), namespace: String(podNamespace) })
                    }}
                  >
                    <td className="py-2 pr-2">
                      <span className="block truncate font-mono" title={String(pod.name ?? '-')}>{String(pod.name ?? '-')}</span>
                    </td>
                    <td className="py-2 pr-2">
                      <StatusBadge status={String(pod.phase ?? '-')} />
                    </td>
                    <td className="py-2 pr-2">{pod.ready || '-'}</td>
                    <td className="py-2 pr-2">{String(pod.restart_count ?? 0)}</td>
                    <td className="py-2 pr-2"><span className="block truncate">{pod.node_name || '-'}</span></td>
                    <td className="py-2 pr-2">
                      <span className="block truncate">{Array.isArray(pod.volume_names) ? pod.volume_names.join(', ') || '-' : '-'}</span>
                    </td>
                    <td className="py-2 pr-2">{fmtRel(pod.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}
      {finalizers.length > 0 && (
        <InfoSection title="Finalizers">
          <div className="space-y-1 text-xs text-slate-200">
            {finalizers.map((finalizer: string, idx: number) => (
              <div key={`${finalizer}-${idx}`} className="font-mono break-all">{finalizer}</div>
            ))}
          </div>
        </InfoSection>
      )}
      {conditions.length > 0 && (
        <InfoSection title="Conditions">
          <ConditionsTable conditions={conditions} />
        </InfoSection>
      )}
      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
      {Object.keys(annotations).length > 0 && <InfoSection title="Annotations"><KeyValueTags data={annotations} /></InfoSection>}
      {events.length > 0 && (
        <InfoSection title="Events">
          <EventsTable events={events} />
        </InfoSection>
      )}
    </>
  )
}
