import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from '../DetailCommon'

interface Props {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
}

export default function EndpointDetail({ name, namespace, kind, rawJson }: Props) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const annotations = (meta.annotations ?? {}) as Record<string, string>
  const subsets = (rawJson?.subsets ?? []) as any[]
  const endpoints = (rawJson?.endpoints ?? []) as any[]
  const readyCount = Number(rawJson?.ready_count ?? 0)
  const notReadyCount = Number(rawJson?.not_ready_count ?? 0)
  const readyAddresses = (rawJson?.ready_addresses ?? []) as string[]
  const notReadyAddresses = (rawJson?.not_ready_addresses ?? []) as string[]
  const readyTargets = (rawJson?.ready_targets ?? []) as any[]
  const notReadyTargets = (rawJson?.not_ready_targets ?? []) as any[]
  const ports = (rawJson?.ports ?? []) as any[]

  const renderTargets = (targets: any[], fallbackIps: string[], tone: 'ready' | 'notReady') => {
    if (!Array.isArray(targets) || targets.length === 0) {
      if (!Array.isArray(fallbackIps) || fallbackIps.length === 0) return <p className="text-xs text-slate-400">(none)</p>
      return <p className="text-xs text-slate-200 break-all">{fallbackIps.join(', ')}</p>
    }

    const borderTone = tone === 'ready' ? 'border-emerald-800/60 bg-emerald-900/10' : 'border-amber-800/60 bg-amber-900/10'
    return (
      <div className="space-y-1.5">
        {targets.map((t: any, i: number) => {
          const ref = t?.target_ref || t?.targetRef
          const refText = ref?.name ? `${ref.kind || 'Target'}:${ref.name}` : '(targetRef none)'
          const nodeText = t?.node_name ? `node=${t.node_name}` : null
          return (
            <div key={`${tone}-${i}`} className={`rounded border px-2 py-1.5 text-xs ${borderTone}`}>
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
      <InfoSection title={`${kind} Info`}>
        <div className="space-y-2">
          <InfoRow label="Kind" value={kind} />
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Ready Addresses" value={String(readyCount)} />
          <InfoRow label="Not Ready Addresses" value={String(notReadyCount)} />
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
          {((rawJson?.generation ?? (meta as any).generation) != null) && <InfoRow label="Generation" value={String(rawJson?.generation ?? (meta as any).generation)} />}
          {((rawJson?.resource_version ?? (meta as any).resourceVersion) != null) && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px] break-all">{String(rawJson?.resource_version ?? (meta as any).resourceVersion)}</span>} />}
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {ports.length > 0 && (
        <InfoSection title="Ports">
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[360px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1">Name</th>
                  <th className="text-left py-1">Port</th>
                  <th className="text-left py-1">Protocol</th>
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

      {(readyTargets.length > 0 || readyAddresses.length > 0) && (
        <InfoSection title="Ready Targets">
          {renderTargets(readyTargets, readyAddresses, 'ready')}
        </InfoSection>
      )}

      {(notReadyTargets.length > 0 || notReadyAddresses.length > 0) && (
        <InfoSection title="Not Ready Targets">
          {renderTargets(notReadyTargets, notReadyAddresses, 'notReady')}
        </InfoSection>
      )}

      {subsets.length > 0 && (
        <InfoSection title="Subsets">
          <div className="space-y-2 text-xs">
            {subsets.map((s: any, i: number) => (
              <div key={i} className="rounded border border-slate-800 p-2">
                <div className="text-slate-200">Addresses: {(s.addresses || []).map((a: any) => a.ip).join(', ') || '(none)'}</div>
                <div className="text-slate-400">Ports: {(s.ports || []).map((p: any) => `${p.name || ''}:${p.port}/${p.protocol || 'TCP'}`).join(', ') || '(none)'}</div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {endpoints.length > 0 && (
        <InfoSection title="Endpoints">
          <div className="space-y-2 text-xs">
            {endpoints.map((ep: any, i: number) => (
              <div key={i} className="rounded border border-slate-800 p-2">
                <div className="text-slate-200">Addresses: {(ep.addresses || []).join(', ')}</div>
                <div className="text-slate-400">Conditions: ready={String(ep.conditions?.ready ?? '-')}</div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
      {Object.keys(annotations).length > 0 && <InfoSection title="Annotations"><KeyValueTags data={annotations} /></InfoSection>}
    </>
  )
}
