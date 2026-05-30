import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { EventsTable, InfoSection, InfoRow, KeyValueTags, StatusBadge, fmtRel, fmtTs } from '../DetailCommon'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface StorageClassRelatedPV {
  name?: string | null
  status?: string | null
  capacity?: string | null
  claim_ref?: { namespace?: string | null; name?: string | null } | null
  created_at?: string | null
}

interface StorageClassRelatedPVC {
  name?: string | null
  namespace?: string | null
  status?: string | null
  requested?: string | null
  capacity?: string | null
  volume_name?: string | null
  created_at?: string | null
}

interface StorageClassDescribeResponse {
  uid?: string
  resource_version?: string
  provisioner?: string | null
  reclaim_policy?: string | null
  volume_binding_mode?: string | null
  allow_volume_expansion?: boolean | null
  is_default?: boolean
  parameters?: Record<string, string>
  mount_options?: string[]
  allowed_topologies?: string[]
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string | null
  usage?: {
    pv_count?: number
    pv_bound_count?: number
    pvc_count?: number
    pvc_bound_count?: number
  }
  related_pvs?: StorageClassRelatedPV[]
  related_pvcs?: StorageClassRelatedPVC[]
  events?: Array<Record<string, unknown>>
}

export default function StorageClassDetail({ name, rawJson }: { name: string; rawJson?: Record<string, unknown> }) {
  const { open: openDetail } = useResourceDetail()
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['storageclass-describe', name],
    queryFn: () => api.describeStorageClass(name) as Promise<StorageClassDescribeResponse>,
    enabled: !!name,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'StorageClass', name, describe })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const parameters = (describe?.parameters ?? (rawJson?.parameters as Record<string, string> | undefined) ?? {})
  const mountOptions = Array.isArray(describe?.mount_options)
    ? describe.mount_options
    : (Array.isArray(rawJson?.mountOptions) ? rawJson?.mountOptions : [])
  const allowedTopologies = Array.isArray(describe?.allowed_topologies) ? describe.allowed_topologies : []
  const finalizers = Array.isArray(describe?.finalizers) ? describe.finalizers : []
  const relatedPVs = Array.isArray(describe?.related_pvs) ? describe.related_pvs : []
  const relatedPVCs = Array.isArray(describe?.related_pvcs) ? describe.related_pvcs : []
  const events = Array.isArray(describe?.events) ? describe.events : []
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  const usage = describe?.usage ?? {}
  const pvCount = Number(usage.pv_count || 0)
  const pvBoundCount = Number(usage.pv_bound_count || 0)
  const pvcCount = Number(usage.pvc_count || 0)
  const pvcBoundCount = Number(usage.pvc_bound_count || 0)
  const pvRatio = pvCount > 0 ? `${pvBoundCount}/${pvCount}` : '-'
  const pvcRatio = pvcCount > 0 ? `${pvcBoundCount}/${pvcCount}` : '-'
  const successRate = pvCount > 0 ? Math.round((pvBoundCount / pvCount) * 100) : null
  const successCls = successRate == null
    ? ''
    : successRate >= 90
      ? 'badge-success'
      : successRate >= 70
        ? 'badge-warning'
        : 'badge-error'

  return (
    <>
      <InfoSection title="StorageClass Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Provisioner" value={String(describe?.provisioner ?? rawJson?.provisioner ?? '-')} />
          <InfoRow label="Default Class" value={describe?.is_default ? 'Yes' : 'No'} />
          <InfoRow label="Reclaim Policy" value={String(describe?.reclaim_policy ?? rawJson?.reclaimPolicy ?? '-')} />
          <InfoRow label="Volume Binding Mode" value={String(describe?.volume_binding_mode ?? rawJson?.volumeBindingMode ?? '-')} />
          <InfoRow label="Allow Expansion" value={(describe?.allow_volume_expansion ?? rawJson?.allowVolumeExpansion) ? 'Yes' : 'No'} />
          <InfoRow label="Bound PVs / Total PVs" value={pvRatio} />
          <InfoRow label="Bound PVCs / Total PVCs" value={pvcRatio} />
          {successRate !== null && (
            <InfoRow
              label="Provisioning Success Rate"
              value={<span className={`badge ${successCls}`}>{successRate}%</span>}
            />
          )}
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{String(describe.uid)}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px] break-all">{String(describe.resource_version)}</span>} />}
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>
      {isLoading && <p className="text-xs text-slate-400">Loading details...</p>}
      {isError && <p className="text-xs text-amber-300">Some detailed StorageClass fields are unavailable right now.</p>}

      {Object.keys(parameters).length > 0 && (
        <InfoSection title="Parameters">
          <KeyValueTags data={parameters} />
        </InfoSection>
      )}
      {mountOptions.length > 0 && (
        <InfoSection title="Mount Options">
          <div className="flex flex-wrap gap-2">
            {mountOptions.map((opt, idx) => (
              <span key={`${opt}-${idx}`} className="text-[11px] rounded-full border border-slate-700 bg-slate-800/80 px-2 py-1">{String(opt)}</span>
            ))}
          </div>
        </InfoSection>
      )}
      {allowedTopologies.length > 0 && (
        <InfoSection title="Allowed Topologies">
          <div className="space-y-1 text-xs text-slate-200">
            {allowedTopologies.map((topology, idx) => (
              <div key={`${topology}-${idx}`} className="break-words">{String(topology)}</div>
            ))}
          </div>
        </InfoSection>
      )}
      {relatedPVs.length > 0 && (
        <InfoSection title={`Related PersistentVolumes (${relatedPVs.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[620px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[34%]">Name</th>
                  <th className="text-left py-2 w-[14%]">Status</th>
                  <th className="text-left py-2 w-[14%]">Capacity</th>
                  <th className="text-left py-2 w-[22%]">Claim</th>
                  <th className="text-left py-2 w-[16%]">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {relatedPVs.slice(0, 50).map((pv, idx) => {
                  const claimText = pv.claim_ref?.name
                    ? `${pv.claim_ref?.namespace || '-'}/${pv.claim_ref?.name}`
                    : '-'
                  return (
                    <tr
                      key={`${pv.name || '-'}-${idx}`}
                      className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                      onClick={() => {
                        if (!pv.name) return
                        openDetail({ kind: 'PersistentVolume', name: String(pv.name) })
                      }}
                    >
                      <td className="py-2 pr-2">
                        <span className="block truncate font-mono" title={String(pv.name || '-')}>{String(pv.name || '-')}</span>
                      </td>
                      <td className="py-2 pr-2"><StatusBadge status={String(pv.status || '-')} /></td>
                      <td className="py-2 pr-2">{String(pv.capacity || '-')}</td>
                      <td className="py-2 pr-2"><span className="block truncate">{claimText}</span></td>
                      <td className="py-2 pr-2">{fmtRel(pv.created_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}
      {relatedPVCs.length > 0 && (
        <InfoSection title={`Related PersistentVolumeClaims (${relatedPVCs.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[760px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[26%]">PVC</th>
                  <th className="text-left py-2 w-[12%]">Status</th>
                  <th className="text-left py-2 w-[14%]">Requested</th>
                  <th className="text-left py-2 w-[14%]">Capacity</th>
                  <th className="text-left py-2 w-[20%]">Volume</th>
                  <th className="text-left py-2 w-[14%]">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {relatedPVCs.slice(0, 50).map((pvc, idx) => (
                  <tr
                    key={`${pvc.namespace || '-'}-${pvc.name || '-'}-${idx}`}
                    className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => {
                      if (!pvc.name || !pvc.namespace) return
                      openDetail({ kind: 'PersistentVolumeClaim', name: String(pvc.name), namespace: String(pvc.namespace) })
                    }}
                  >
                    <td className="py-2 pr-2">
                      <span className="block truncate font-mono" title={`${pvc.namespace || '-'}/${pvc.name || '-'}`}>
                        {`${pvc.namespace || '-'}/${pvc.name || '-'}`}
                      </span>
                    </td>
                    <td className="py-2 pr-2"><StatusBadge status={String(pvc.status || '-')} /></td>
                    <td className="py-2 pr-2">{String(pvc.requested || '-')}</td>
                    <td className="py-2 pr-2">{String(pvc.capacity || '-')}</td>
                    <td className="py-2 pr-2"><span className="block truncate">{String(pvc.volume_name || '-')}</span></td>
                    <td className="py-2 pr-2">{fmtRel(pvc.created_at)}</td>
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
