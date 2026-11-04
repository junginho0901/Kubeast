import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { formatPorts } from '@/pages/network/endpoints/endpointHelpers'
import { EventsSection, InfoSection, InfoRow, KeyValueTags, Th, Tx } from '../DetailCommon'
import { fmtRel, fmtTs } from '../detailFormat'
import { endpointsView } from '../netstoreDetail'

interface Props {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
}

export default function EndpointDetail({ name, namespace, kind, rawJson }: Props) {
  // The describe answer (the list's row with the metadata, the subsets and the events), the same whether the drawer
  // was opened from the list or by link
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['endpoints-describe', namespace, name],
    queryFn: () => api.describeEndpoint(namespace as string, name),
    enabled: !!name && !!namespace,
    retry: false,
  })
  const view = endpointsView(describe, rawJson)
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const readyCount = view?.ready_count ?? 0
  const notReadyCount = view?.not_ready_count ?? 0
  const createdAt = view?.created_at ?? (meta.creationTimestamp as string | undefined)
  const ports = view?.ports ?? []
  const subsets = view?.subsets ?? []
  const labels = view?.labels ?? {}
  const annotations = view?.annotations ?? {}

  const renderTargets = (targets: any[], fallbackIps: string[], tone: 'ready' | 'notReady') => {
    if (!Array.isArray(targets) || targets.length === 0) {
      if (!Array.isArray(fallbackIps) || fallbackIps.length === 0) return <p className="text-xs text-slate-400"><Tx>None</Tx></p>
      return <p className="text-xs text-slate-200 break-all">{fallbackIps.join(', ')}</p>
    }

    const borderTone = tone === 'ready' ? 'border-emerald-800/60 bg-emerald-900/10' : 'border-amber-800/60 bg-amber-900/10'
    return (
      <div className="space-y-1.5">
        {targets.map((t: any, i: number) => {
          const ref = t?.target_ref || t?.targetRef
          const refText = ref?.name ? `${ref.kind || 'Target'}:${ref.name}` : 'targetRef: -'
          const nodeText = t?.node_name ? `node=${t.node_name}` : null
          return (
            <div key={`${tone}-${i}`} className={`rounded-sm border px-2 py-1.5 text-xs ${borderTone}`}>
              <p className="text-slate-200 font-mono break-all">{t?.ip || '-'}</p>
              <p className="text-slate-300 break-all">{refText}</p>
              {nodeText && <p className="text-slate-400">{nodeText}</p>}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <>
      <InfoSection title="{{kind}} Info" titleValues={{ kind }}>
        <div className="space-y-2">
          <InfoRow label="Kind" value={kind} />
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          {view && <InfoRow label="Ready Addresses" value={String(readyCount)} />}
          {view && <InfoRow label="Not Ready Addresses" value={String(notReadyCount)} />}
          {(readyCount + notReadyCount) > 0 && (
            <InfoRow
              label="Ready Ratio"
              value={
                <span className={`badge ${notReadyCount === 0 ? 'badge-success' : (readyCount === 0 ? 'badge-error' : 'badge-warning')}`}>
                  {Math.round((readyCount / (readyCount + notReadyCount)) * 100)}% ({readyCount}/{readyCount + notReadyCount})
                </span>
              }
            />
          )}
          {view?.generation != null && <InfoRow label="Generation" value={String(view.generation)} />}
          {view?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px] break-all">{view.resource_version}</span>} />}
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
        {isLoading && <p className="text-xs text-slate-400 mt-2"><Tx>Loading details...</Tx></p>}
        {isError && view && <p className="text-xs text-red-400 mt-2"><Tx>Failed to load describe data. Showing summary from list.</Tx></p>}
      </InfoSection>

      {ports.length > 0 && (
        <InfoSection title="Ports">
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[360px]">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1">Name</Th>
                  <Th className="text-left py-1">Port</Th>
                  <Th className="text-left py-1">Protocol</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {ports.map((p: any, i: number) => (
                  <tr key={i} className="text-slate-200">
                    <td className="py-1 pr-2">{p?.name || '-'}</td>
                    <td className="py-1 pr-2">{p?.port ?? '-'}</td>
                    <td className="py-1 pr-2">{p?.protocol || 'TCP'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {view && (view.ready_targets.length > 0 || view.ready_addresses.length > 0) && (
        <InfoSection title="Ready Targets">
          {renderTargets(view.ready_targets, view.ready_addresses, 'ready')}
        </InfoSection>
      )}

      {view && (view.not_ready_targets.length > 0 || view.not_ready_addresses.length > 0) && (
        <InfoSection title="Not Ready Targets">
          {renderTargets(view.not_ready_targets, view.not_ready_addresses, 'notReady')}
        </InfoSection>
      )}

      {/* each subset as kubectl describe lists it: its ready and not-ready addresses and its ports */}
      {subsets.length > 0 && (
        <InfoSection title="Subsets">
          <div className="space-y-2 text-xs">
            {subsets.map((s, i) => (
              <div key={i} className="rounded-sm border border-slate-800 p-2 space-y-0.5 text-slate-200">
                <div><span className="text-slate-400"><Tx>Addresses</Tx>:</span> {s.addresses.join(', ') || <Tx>None</Tx>}</div>
                <div><span className="text-slate-400"><Tx>Not Ready Addresses</Tx>:</span> {s.not_ready_addresses.join(', ') || <Tx>None</Tx>}</div>
                <div><span className="text-slate-400"><Tx>Ports</Tx>:</span> {s.ports.length ? formatPorts(s.ports) : <Tx>None</Tx>}</div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
      {Object.keys(annotations).length > 0 && <InfoSection title="Annotations"><KeyValueTags data={annotations} /></InfoSection>}
      <EventsSection events={describe?.events} error={describe?.events_error} loading={isLoading} />
    </>
  )
}
