import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from '../DetailCommon'

interface Props {
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

function renderConditionBadge(label: string, value: unknown) {
  const isOn = value === true
  const isUnknown = value == null
  const cls = isUnknown
    ? 'border-slate-700 bg-slate-800/70 text-slate-300'
    : isOn
      ? 'border-emerald-700/60 bg-emerald-900/20 text-emerald-300'
      : 'border-amber-700/60 bg-amber-900/20 text-amber-300'
  const text = isUnknown ? 'Unknown' : isOn ? 'True' : 'False'
  return <span className={`inline-flex items-center rounded px-2 py-0.5 border ${cls}`}>{label}: {text}</span>
}

export default function EndpointSliceDetail({ name, namespace, rawJson }: Props) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = ((rawJson?.labels as Record<string, string>) ?? (meta.labels as Record<string, string>) ?? {}) as Record<string, string>
  const annotations = ((rawJson?.annotations as Record<string, string>) ?? (meta.annotations as Record<string, string>) ?? {}) as Record<string, string>
  const endpoints = (rawJson?.endpoints ?? []) as any[]
  const ports = (rawJson?.ports ?? []) as any[]
  const addressType = String(rawJson?.address_type ?? rawJson?.addressType ?? '-')
  const serviceName = String(rawJson?.service_name ?? labels?.['kubernetes.io/service-name'] ?? '-')
  const managedBy = String(rawJson?.managed_by ?? labels?.['endpointslice.kubernetes.io/managed-by'] ?? '-')
  const total = Number(rawJson?.endpoints_total ?? endpoints.length ?? 0)
  const ready = Number(rawJson?.endpoints_ready ?? endpoints.filter((ep: any) => ep?.conditions?.ready !== false).length ?? 0)
  const notReady = Number(rawJson?.endpoints_not_ready ?? Math.max(total - ready, 0))

  const { open: openDetail } = useResourceDetail()
  const { data: nsSlices } = useQuery({
    queryKey: ['endpointslice-peers', namespace, serviceName],
    queryFn: () => api.getEndpointSlices(namespace as string),
    enabled: !!namespace && serviceName !== '-',
    staleTime: 5_000,
  })
  const peerSlices = (Array.isArray(nsSlices) ? nsSlices : []).filter((s: any) => {
    const svc = s?.service_name ?? s?.labels?.['kubernetes.io/service-name']
    return svc === serviceName && s?.name !== name
  })

  return (
    <>
      <InfoSection title="EndpointSlice Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Address Type" value={addressType} />
          <InfoRow label="Service" value={serviceName} />
          <InfoRow label="Managed By" value={managedBy} />
          <InfoRow label="Endpoints (Ready / Total)" value={`${ready} / ${total}`} />
          <InfoRow label="Not Ready Endpoints" value={String(notReady)} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {ports.length > 0 && (
        <InfoSection title="Ports">
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[460px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1">Name</th>
                  <th className="text-left py-1">Port</th>
                  <th className="text-left py-1">Protocol</th>
                  <th className="text-left py-1">App Protocol</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {ports.map((p: any, i: number) => (
                  <tr key={i} className="text-slate-200">
                    <td className="py-1 pr-2">{p?.name || '-'}</td>
                    <td className="py-1 pr-2">{p?.port ?? '-'}</td>
                    <td className="py-1 pr-2">{p?.protocol || 'TCP'}</td>
                    <td className="py-1 pr-2">{p?.app_protocol || p?.appProtocol || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {endpoints.length > 0 && (
        <InfoSection title="Endpoints">
          <div className="space-y-2">
            {endpoints.map((ep: any, i: number) => {
              const addresses = Array.isArray(ep?.addresses) ? ep.addresses : []
              const ref = ep?.target_ref || ep?.targetRef
              const refText = ref?.name ? `${ref?.kind || 'Target'}:${ref.name}` : '-'
              return (
                <div key={i} className="rounded border border-slate-800 p-3 space-y-2">
                  <div className="text-xs text-slate-200 break-all">
                    <span className="text-slate-400">Addresses:</span> {addresses.length > 0 ? addresses.join(', ') : '-'}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    <div className="text-slate-200 break-all"><span className="text-slate-400">Hostname:</span> {ep?.hostname || '-'}</div>
                    <div className="text-slate-200 break-all"><span className="text-slate-400">Node:</span> {ep?.node_name || ep?.nodeName || '-'}</div>
                    <div className="text-slate-200 break-all"><span className="text-slate-400">Zone:</span> {ep?.zone || '-'}</div>
                    <div className="text-slate-200 break-all"><span className="text-slate-400">TargetRef:</span> {refText}</div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {renderConditionBadge('Ready', ep?.conditions?.ready)}
                    {renderConditionBadge('Serving', ep?.conditions?.serving)}
                    {renderConditionBadge('Terminating', ep?.conditions?.terminating)}
                  </div>
                </div>
              )
            })}
          </div>
        </InfoSection>
      )}

      {serviceName !== '-' && (
        <InfoSection title={`Peer EndpointSlices for ${serviceName} (${peerSlices.length})`}>
          {peerSlices.length === 0 ? (
            <p className="text-xs text-slate-400">No other EndpointSlice for this Service in the namespace.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-400">
                  <tr>
                    <th className="text-left py-1">Name</th>
                    <th className="text-left py-1">Address Type</th>
                    <th className="text-left py-1">Ready / Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {peerSlices.slice(0, 50).map((s: any) => (
                    <tr
                      key={s.name}
                      className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                      onClick={() => openDetail({ kind: 'EndpointSlice', name: s.name, namespace: s.namespace })}
                    >
                      <td className="py-1 pr-2 font-mono">{s.name}</td>
                      <td className="py-1 pr-2">{s.address_type ?? '-'}</td>
                      <td className="py-1 pr-2 font-mono">{(s.endpoints_ready ?? 0)}/{(s.endpoints_total ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
      {Object.keys(annotations).length > 0 && <InfoSection title="Annotations"><KeyValueTags data={annotations} /></InfoSection>}
    </>
  )
}
