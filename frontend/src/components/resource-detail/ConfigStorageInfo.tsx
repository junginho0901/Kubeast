import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { ConditionsTable, EventsTable, InfoSection, InfoRow, KeyValueTags, StatusBadge, fmtRel, fmtTs } from './DetailCommon'

interface Props {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
}

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

export default function ConfigStorageInfo({ name, namespace, kind, rawJson }: Props) {
  if (kind === 'ConfigMap') return <ConfigMapDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'Secret') return <SecretDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'PersistentVolume') return <PVDetail name={name} rawJson={rawJson} />
  if (kind === 'PersistentVolumeClaim') return <PVCDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'StorageClass') return <StorageClassDetail name={name} rawJson={rawJson} />
  if (kind === 'HorizontalPodAutoscaler') return <HPADetail name={name} namespace={namespace} rawJson={rawJson} />
  return null
}

function ConfigMapDetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const data = (rawJson?.data ?? {}) as Record<string, string>
  const labels = (meta.labels ?? {}) as Record<string, string>

  return (
    <>
      <InfoSection title="ConfigMap Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Data Keys" value={String(Object.keys(data).length)} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {Object.keys(data).length > 0 && (
        <InfoSection title="Data">
          <div className="space-y-3">
            {Object.entries(data).map(([key, value]) => (
              <div key={key} className="rounded border border-slate-800 p-3">
                <p className="text-xs font-medium text-white mb-1">{key}</p>
                <pre className="text-[11px] text-slate-300 bg-slate-950 rounded p-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-all">
                  {String(value).slice(0, 2000)}
                  {String(value).length > 2000 && '\n... (truncated)'}
                </pre>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}

function SecretDetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const data = (rawJson?.data ?? {}) as Record<string, string>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const secretType = rawJson?.type as string || 'Opaque'

  return (
    <>
      <InfoSection title="Secret Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Type" value={secretType} />
          <InfoRow label="Data Keys" value={String(Object.keys(data).length)} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {Object.keys(data).length > 0 && (
        <InfoSection title="Data">
          <div className="space-y-2">
            {Object.entries(data).map(([key, value]) => (
              <div key={key} className="flex items-center gap-2 text-xs">
                <span className="font-medium text-white min-w-[140px]">{key}</span>
                <span className="text-slate-400 font-mono">{value ? `${value.length} bytes (base64)` : '(empty)'}</span>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}

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
}

function PVDetail({ name, rawJson }: { name: string; rawJson?: Record<string, unknown> }) {
  const { open: openDetail } = useResourceDetail()
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['pv-describe', name],
    queryFn: () => api.describePV(name) as Promise<PVDescribeResponse>,
    enabled: !!name,
    retry: false,
  })

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
          <InfoRow label="Storage Class" value={storageClass} />
          <InfoRow label="Volume Mode" value={volumeMode} />
          <InfoRow
            label="Claim"
            value={claimRef?.name && claimRef?.namespace ? (
              <button
                type="button"
                className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 break-all text-left"
                onClick={() => openDetail({
                  kind: 'PersistentVolumeClaim',
                  name: String(claimRef.name),
                  namespace: String(claimRef.namespace),
                })}
              >
                {claimText}
              </button>
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

function formatDataSourceRef(ref?: PVCDataSourceRef | null): string {
  if (!ref) return '-'
  const kind = ref.kind || 'UnknownKind'
  const name = ref.name || '-'
  const apiGroup = ref.api_group ? ` (${ref.api_group})` : ''
  const namespace = ref.namespace ? ` [ns:${ref.namespace}]` : ''
  return `${kind}/${name}${apiGroup}${namespace}`
}

function PVCDetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const { open: openDetail } = useResourceDetail()
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['pvc-describe', namespace, name],
    queryFn: () => api.describePVC(namespace as string, name) as Promise<PVCDescribeResponse>,
    enabled: !!namespace && !!name,
    retry: false,
  })

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
  const dataSource = formatDataSourceRef(describe?.data_source)
  const dataSourceRef = formatDataSourceRef(describe?.data_source_ref)
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
          <InfoRow label="Storage Class" value={storageClass} />
          <InfoRow label="Volume Mode" value={volumeMode} />
          <InfoRow label="Volume Name" value={volumeName} />
          <InfoRow label="Selected Node" value={selectedNode} />
          <InfoRow label="Data Source" value={dataSource} />
          <InfoRow label="Data Source Ref" value={dataSourceRef} />
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

function StorageClassDetail({ name, rawJson }: { name: string; rawJson?: Record<string, unknown> }) {
  const { open: openDetail } = useResourceDetail()
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['storageclass-describe', name],
    queryFn: () => api.describeStorageClass(name) as Promise<StorageClassDescribeResponse>,
    enabled: !!name,
    retry: false,
  })

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

  return (
    <>
      <InfoSection title="StorageClass Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Provisioner" value={String(rawJson?.provisioner ?? '-')} />
          <InfoRow label="Reclaim Policy" value={String(rawJson?.reclaimPolicy ?? '-')} />
          <InfoRow label="Volume Binding Mode" value={String(rawJson?.volumeBindingMode ?? '-')} />
          <InfoRow label="Allow Expansion" value={rawJson?.allowVolumeExpansion ? 'Yes' : 'No'} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {Object.keys(parameters).length > 0 && (
        <InfoSection title="Parameters">
          <KeyValueTags data={parameters} />
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}

function HPADetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const scaleRef = spec.scaleTargetRef as Record<string, string> | undefined
  const metrics = (spec.metrics ?? []) as any[]
  const currentMetrics = (status.currentMetrics ?? []) as any[]
  const conditions = (status.conditions ?? []) as any[]

  return (
    <>
      <InfoSection title="HPA Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          {scaleRef && <InfoRow label="Target" value={`${scaleRef.kind}/${scaleRef.name}`} />}
          <InfoRow label="Min Replicas" value={String(spec.minReplicas ?? 1)} />
          <InfoRow label="Max Replicas" value={String(spec.maxReplicas ?? '-')} />
          <InfoRow label="Current Replicas" value={String(status.currentReplicas ?? '-')} />
          <InfoRow label="Desired Replicas" value={String(status.desiredReplicas ?? '-')} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {metrics.length > 0 && (
        <InfoSection title="Metrics">
          <div className="space-y-2 text-xs">
            {metrics.map((m: any, i: number) => {
              const current = currentMetrics[i]
              return (
                <div key={i} className="rounded border border-slate-800 p-2 text-slate-200">
                  <div>Type: {m.type}</div>
                  {m.resource && <div>Resource: {m.resource.name} target={m.resource.target?.averageUtilization ?? m.resource.target?.averageValue ?? '-'}
                    {current?.resource && <> current={current.resource.current?.averageUtilization ?? current.resource.current?.averageValue ?? '-'}</>}</div>}
                  {m.pods && <div>Pods: {m.pods.metric?.name} target={m.pods.target?.averageValue ?? '-'}</div>}
                  {m.object && <div>Object: {m.object.metric?.name} target={m.object.target?.value ?? '-'}</div>}
                </div>
              )
            })}
          </div>
        </InfoSection>
      )}

      {conditions.length > 0 && (
        <InfoSection title="Conditions">
          <div className="space-y-1 text-xs">
            {conditions.map((c: any, i: number) => (
              <div key={i} className="flex items-center gap-2 text-slate-200">
                <StatusBadge status={c.status} />
                <span className="text-white">{c.type}</span>
                {c.reason && <span className="text-slate-400">({c.reason})</span>}
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}
