import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { EventsTable, InfoSection, InfoRow, KeyValueTags, StatusBadge, fmtRel, fmtTs, usePagination } from '../DetailCommon'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface VolumeAttachmentDescribeResponse {
  uid?: string
  resource_version?: string
  attacher?: string | null
  node_name?: string | null
  persistent_volume_name?: string | null
  source_inline_volume_spec?: Record<string, unknown> | string | null
  attached?: boolean | null
  attachment_metadata?: Record<string, string> | null
  attach_error?: { time?: string | null; message?: string | null } | null
  detach_error?: { time?: string | null; message?: string | null } | null
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string | null
  pv_summary?: {
    name?: string | null
    status?: string | null
    capacity?: string | null
    access_modes?: string[] | null
    storage_class?: string | null
    reclaim_policy?: string | null
    volume_mode?: string | null
    source?: string | null
    driver?: string | null
    volume_handle?: string | null
  } | null
  events?: Array<Record<string, unknown>>
}

export default function VolumeAttachmentDetail({ name, rawJson }: { name: string; rawJson?: Record<string, unknown> }) {
  const { open: openDetail } = useResourceDetail()
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['volumeattachment-describe', name],
    queryFn: () => api.describeVolumeAttachment(name) as Promise<VolumeAttachmentDescribeResponse>,
    enabled: !!name,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'VolumeAttachment', name, describe })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const source = (spec.source ?? {}) as Record<string, unknown>

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const finalizers = Array.isArray(describe?.finalizers) ? describe.finalizers : []
  const events = Array.isArray(describe?.events) ? describe.events : []
  const pvSummary = describe?.pv_summary ?? null
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)
  const attached = describe?.attached ?? (status.attached as boolean | null | undefined) ?? null
  const attachedStatus = attached === true ? 'Attached' : attached === false ? 'Detached' : 'Unknown'
  const nodeName = String(describe?.node_name ?? spec.nodeName ?? '-')
  const attacher = String(describe?.attacher ?? spec.attacher ?? '-')
  const pvName = String(describe?.persistent_volume_name ?? source.persistentVolumeName ?? '-')

  const rawAttachError = (status.attachError ?? status.attach_error) as Record<string, unknown> | undefined
  const rawDetachError = (status.detachError ?? status.detach_error) as Record<string, unknown> | undefined
  const attachErrorMessage = String(describe?.attach_error?.message ?? rawAttachError?.message ?? '')
  const attachErrorTime = describe?.attach_error?.time ?? (rawAttachError?.time as string | undefined) ?? null
  const detachErrorMessage = String(describe?.detach_error?.message ?? rawDetachError?.message ?? '')
  const detachErrorTime = describe?.detach_error?.time ?? (rawDetachError?.time as string | undefined) ?? null
  const attachmentMetadata = (describe?.attachment_metadata ?? {}) as Record<string, string>
  const inlineVolumeSpec = describe?.source_inline_volume_spec

  // PV → PVC → Pods chain. Resolves bound PV (1 describe), then bound PVC
  // (1 describe), then the PVC's used_by_pods list (already in PVC describe).
  // Each fetch is independent and react-query dedupes if same PV viewed twice.
  const { data: pvDescribe } = useQuery({
    queryKey: ['va-chain-pv', pvName],
    queryFn: () => api.describePV(pvName),
    enabled: pvName !== '-' && !!pvName,
    staleTime: 30_000,
  })
  const boundClaim = (pvDescribe?.bound_claim ?? pvDescribe?.claim_ref) as
    | { name?: string; namespace?: string }
    | undefined
  const { data: pvcDescribe } = useQuery({
    queryKey: ['va-chain-pvc', boundClaim?.namespace, boundClaim?.name],
    queryFn: () => api.describePVC(boundClaim!.namespace!, boundClaim!.name!),
    enabled: !!boundClaim?.name && !!boundClaim?.namespace,
    staleTime: 30_000,
  })
  const chainPods = Array.isArray(pvcDescribe?.used_by_pods) ? pvcDescribe.used_by_pods : []
  const { items: pagedChainPods, nav: chainPodsNav } = usePagination(chainPods, 10)

  return (
    <>
      <InfoSection title="VolumeAttachment Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Status" value={<StatusBadge status={attachedStatus} />} />
          <InfoRow label="Attacher" value={attacher} />
          <InfoRow
            label="Node"
            value={nodeName !== '-' ? (
              <button
                type="button"
                className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 break-all text-left"
                onClick={() => openDetail({ kind: 'Node', name: nodeName })}
              >
                {nodeName}
              </button>
            ) : '-'}
          />
          <InfoRow
            label="PersistentVolume"
            value={pvName !== '-' ? (
              <button
                type="button"
                className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 break-all text-left"
                onClick={() => openDetail({ kind: 'PersistentVolume', name: pvName })}
              >
                {pvName}
              </button>
            ) : '-'}
          />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{String(describe.uid)}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px] break-all">{String(describe.resource_version)}</span>} />}
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>
      {isLoading && <p className="text-xs text-slate-400">Loading details...</p>}
      {isError && <p className="text-xs text-amber-300">Some detailed VolumeAttachment fields are unavailable right now.</p>}

      {(attachErrorMessage || detachErrorMessage) && (
        <InfoSection title="Attach/Detach Errors">
          <div className="space-y-2">
            {attachErrorMessage && (
              <div className="rounded border border-red-800/60 bg-red-950/20 p-3 text-xs">
                <p className="text-red-300 font-medium">Attach Error</p>
                <p className="mt-1 text-slate-200 whitespace-pre-wrap break-words">{attachErrorMessage}</p>
                {attachErrorTime && <p className="mt-1 text-slate-400">{fmtTs(attachErrorTime)} ({fmtRel(attachErrorTime)})</p>}
              </div>
            )}
            {detachErrorMessage && (
              <div className="rounded border border-red-800/60 bg-red-950/20 p-3 text-xs">
                <p className="text-red-300 font-medium">Detach Error</p>
                <p className="mt-1 text-slate-200 whitespace-pre-wrap break-words">{detachErrorMessage}</p>
                {detachErrorTime && <p className="mt-1 text-slate-400">{fmtTs(detachErrorTime)} ({fmtRel(detachErrorTime)})</p>}
              </div>
            )}
          </div>
        </InfoSection>
      )}

      {Object.keys(attachmentMetadata).length > 0 && (
        <InfoSection title="Attachment Metadata">
          <KeyValueTags data={attachmentMetadata} />
        </InfoSection>
      )}

      {pvSummary?.name && (
        <InfoSection title="Bound PersistentVolume Summary">
          <div className="space-y-2">
            <InfoRow
              label="Name"
              value={(
                <button
                  type="button"
                  className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 break-all text-left"
                  onClick={() => openDetail({ kind: 'PersistentVolume', name: String(pvSummary.name) })}
                >
                  {String(pvSummary.name)}
                </button>
              )}
            />
            <InfoRow label="Status" value={<StatusBadge status={String(pvSummary.status ?? '-')} />} />
            <InfoRow label="Capacity" value={String(pvSummary.capacity ?? '-')} />
            <InfoRow label="Access Modes" value={Array.isArray(pvSummary.access_modes) ? pvSummary.access_modes.join(', ') || '-' : '-'} />
            <InfoRow label="Storage Class" value={String(pvSummary.storage_class ?? '-')} />
            <InfoRow label="Reclaim Policy" value={String(pvSummary.reclaim_policy ?? '-')} />
            <InfoRow label="Volume Mode" value={String(pvSummary.volume_mode ?? '-')} />
            <InfoRow label="Source" value={String(pvSummary.source ?? '-')} />
            <InfoRow label="Driver" value={String(pvSummary.driver ?? '-')} />
            <InfoRow label="Volume Handle" value={pvSummary.volume_handle ? <span className="font-mono break-all text-[11px]">{String(pvSummary.volume_handle)}</span> : '-'} />
          </div>
        </InfoSection>
      )}

      {boundClaim?.name && (
        <InfoSection title={`Bound Chain — PV → PVC → Pods (${chainPods.length})`}>
          <div className="space-y-2 text-xs">
            <InfoRow
              label="PVC"
              value={(
                <button
                  type="button"
                  className="text-cyan-300 hover:text-cyan-200 underline underline-offset-2 break-all text-left"
                  onClick={() => openDetail({ kind: 'PersistentVolumeClaim', name: boundClaim.name!, namespace: boundClaim.namespace! })}
                >
                  {boundClaim.namespace}/{boundClaim.name}
                </button>
              )}
            />
            {chainPods.length === 0 ? (
              <p className="text-xs text-slate-400">No pod currently mounts this PVC.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-slate-400">
                    <tr><th className="text-left py-1">Pod</th><th className="text-left py-1">Status</th><th className="text-left py-1">Node</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {pagedChainPods.map((p: any) => (
                      <tr
                        key={`${p.namespace}/${p.name}`}
                        className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                        onClick={() => openDetail({ kind: 'Pod', name: p.name, namespace: p.namespace })}
                      >
                        <td className="py-1 pr-2 font-mono">{p.name}</td>
                        <td className="py-1 pr-2"><StatusBadge status={String(p.status ?? p.phase ?? '-')} /></td>
                        <td className="py-1 pr-2 font-mono">{p.node_name ?? '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {chainPodsNav}
              </div>
            )}
          </div>
        </InfoSection>
      )}

      {inlineVolumeSpec && (
        <InfoSection title="Inline Volume Spec">
          <pre className="text-[11px] text-slate-300 bg-slate-950 rounded p-3 max-h-[220px] overflow-auto whitespace-pre-wrap break-words">
            {typeof inlineVolumeSpec === 'string' ? inlineVolumeSpec : JSON.stringify(inlineVolumeSpec, null, 2)}
          </pre>
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
