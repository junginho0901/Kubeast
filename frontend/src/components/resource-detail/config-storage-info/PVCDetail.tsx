import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { ConditionsTable, EventsTable, InfoSection, InfoRow, KeyValueTags, StatusBadge, fmtRel, fmtTs } from '../DetailCommon'
import { ResourceLink } from '../ResourceLink'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface PVCDataSourceRef {
  kind?: string | null
  name?: string | null
  api_group?: string | null
  namespace?: string | null
}

interface PVCBoundPVSummary {
  name?: string | null
  status?: string | null
  capacity?: string | null
  access_modes?: string[] | null
  storage_class?: string | null
  reclaim_policy?: string | null
  volume_mode?: string | null
}

interface PVCUsedByPod {
  name?: string | null
  namespace?: string | null
  phase?: string | null
  node_name?: string | null
  ready?: string | null
  restart_count?: number | null
  volume_names?: string[] | null
  created_at?: string | null
}

interface PVCDescribeResponse {
  uid?: string
  resource_version?: string
  status?: string
  capacity?: string
  requested?: string
  storage_class?: string
  volume_mode?: string
  volume_name?: string
  access_modes?: string[]
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string
  selected_node?: string | null
  data_source?: PVCDataSourceRef | null
  data_source_ref?: PVCDataSourceRef | null
  bound_pv?: PVCBoundPVSummary | null
  used_by_pods?: PVCUsedByPod[]
  conditions?: Array<Record<string, unknown>>
  resize_conditions?: Array<Record<string, unknown>>
  filesystem_resize_pending?: boolean
  events?: Array<Record<string, unknown>>
}

function formatDataSourceRef(ref?: PVCDataSourceRef | null): string {
  if (!ref) return '-'
  const kind = ref.kind || 'UnknownKind'
  const name = ref.name || '-'
  const apiGroup = ref.api_group ? ` (${ref.api_group})` : ''
  const namespace = ref.namespace ? ` [ns:${ref.namespace}]` : ''
  return `${kind}/${name}${apiGroup}${namespace}`
}

export default function PVCDetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const { open: openDetail } = useResourceDetail()
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['pvc-describe', namespace, name],
    queryFn: () => api.describePVC(namespace as string, name) as Promise<PVCDescribeResponse>,
    enabled: !!namespace && !!name,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'PersistentVolumeClaim', name, namespace, describe })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const accessModes = (describe?.access_modes ?? (spec.accessModes as string[] | undefined) ?? [])
  const capacity = (status.capacity as Record<string, string>) ?? {}
  const requested =
    (((spec.resources as Record<string, unknown> | undefined)?.requests as Record<string, string> | undefined) ?? {})
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)
  const statusPhase = String(describe?.status ?? status.phase ?? '-')
  const capacityStorage = String(describe?.capacity ?? capacity.storage ?? '-')
  const requestedStorage = String(describe?.requested ?? requested.storage ?? '-')
  const storageClass = String(describe?.storage_class ?? spec.storageClassName ?? '-')
  const volumeMode = String(describe?.volume_mode ?? spec.volumeMode ?? 'Filesystem')
  const volumeName = String(describe?.volume_name ?? spec.volumeName ?? '-')
  const finalizers = Array.isArray(describe?.finalizers) ? describe.finalizers : []
  const conditions = Array.isArray(describe?.conditions) ? describe.conditions : (Array.isArray(status.conditions) ? status.conditions : [])
  const resizeConditions = Array.isArray(describe?.resize_conditions) ? describe.resize_conditions : []
  const events = Array.isArray(describe?.events) ? describe.events : []
  const selectedNode = describe?.selected_node || annotations['volume.kubernetes.io/selected-node'] || '-'
  // describe 가 비어있을 수 있으므로 rawJson spec 도 fallback 으로 사용
  const rawDataSource = (spec.dataSource as Record<string, unknown> | undefined)
  const rawDataSourceRef = (spec.dataSourceRef as Record<string, unknown> | undefined)
  const effectiveDataSource: PVCDataSourceRef | null = describe?.data_source ?? (rawDataSource
    ? { kind: rawDataSource.kind as string | null, name: rawDataSource.name as string | null, api_group: rawDataSource.apiGroup as string | null }
    : null)
  const effectiveDataSourceRef: PVCDataSourceRef | null = describe?.data_source_ref ?? (rawDataSourceRef
    ? {
        kind: rawDataSourceRef.kind as string | null,
        name: rawDataSourceRef.name as string | null,
        api_group: rawDataSourceRef.apiGroup as string | null,
        namespace: rawDataSourceRef.namespace as string | null,
      }
    : null)
  const boundPv = describe?.bound_pv ?? null
  const usedByPods = Array.isArray(describe?.used_by_pods) ? describe.used_by_pods : []
  const displayedUsedByPods = usedByPods.slice(0, 50)
  const hasResizePending = !!describe?.filesystem_resize_pending
  const resizeState = hasResizePending
    ? 'Pending (FileSystemResizePending)'
    : resizeConditions.length > 0
      ? resizeConditions
        .map((c) => `${String(c['type'] ?? '-')}:${String(c['status'] ?? '-')}`)
        .join(', ')
      : '-'

  return (
    <>
      <InfoSection title="PersistentVolumeClaim Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Status" value={<StatusBadge status={statusPhase} />} />
          <InfoRow label="Capacity" value={capacityStorage} />
          <InfoRow label="Requested" value={requestedStorage} />
          <InfoRow label="Access Modes" value={accessModes.join(', ') || '-'} />
          <InfoRow label="Storage Class" value={storageClass && storageClass !== '-' ? <ResourceLink kind="StorageClass" name={storageClass} /> : '-'} />
          <InfoRow label="Volume Mode" value={volumeMode} />
          <InfoRow label="Volume Name" value={volumeName && volumeName !== '-' ? <ResourceLink kind="PersistentVolume" name={volumeName} /> : '-'} />
          <InfoRow label="Selected Node" value={selectedNode} />
          {effectiveDataSource && <InfoRow label="Data Source" value={formatDataSourceRef(effectiveDataSource)} />}
          {effectiveDataSourceRef && <InfoRow label="Data Source Ref" value={formatDataSourceRef(effectiveDataSourceRef)} />}
          <InfoRow label="Resize State" value={resizeState} />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{String(describe.uid)}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px]">{String(describe.resource_version)}</span>} />}
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>
      {isLoading && <p className="text-xs text-slate-400">Loading details...</p>}
      {isError && <p className="text-xs text-amber-300">Some detailed PVC fields are unavailable right now.</p>}
      {boundPv?.name && (
        <InfoSection title="Bound PersistentVolume">
          <div className="space-y-2">
            <InfoRow
              label="Name"
              value={(
                <button
                  type="button"
                  className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 break-all text-left"
                  onClick={() => openDetail({ kind: 'PersistentVolume', name: String(boundPv.name) })}
                >
                  {String(boundPv.name)}
                </button>
              )}
            />
            <InfoRow label="Status" value={<StatusBadge status={String(boundPv.status ?? '-')} />} />
            <InfoRow label="Capacity" value={String(boundPv.capacity ?? '-')} />
            <InfoRow label="Access Modes" value={Array.isArray(boundPv.access_modes) ? boundPv.access_modes.join(', ') || '-' : '-'} />
            <InfoRow label="Storage Class" value={String(boundPv.storage_class ?? '-')} />
            <InfoRow label="Reclaim Policy" value={String(boundPv.reclaim_policy ?? '-')} />
            <InfoRow label="Volume Mode" value={String(boundPv.volume_mode ?? '-')} />
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
                    key={`${pod.namespace ?? namespace}-${pod.name ?? '-'}-${idx}`}
                    className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => {
                      const podNamespace = pod.namespace || namespace
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
