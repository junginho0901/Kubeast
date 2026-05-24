import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from '../DetailCommon'
import { ResourceLink } from '../ResourceLink'

interface Props {
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

export default function IngressDetail({ name, namespace, rawJson }: Props) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const rules = (spec.rules ?? []) as any[]
  const tls = (spec.tls ?? []) as any[]
  const defaultBackend = spec.defaultBackend as any
  const classSource = String(rawJson?.class_source ?? '-')
  const classController = String(rawJson?.class_controller ?? '-')
  const classDefaultRaw = rawJson?.class_is_default
  const classIsDefault = classDefaultRaw == null ? '-' : Boolean(classDefaultRaw) ? 'Yes' : 'No'
  const lbAddresses = (((status.loadBalancer as any)?.ingress ?? []) as any[])
    .map((a: any) => a?.ip || a?.hostname)
    .filter(Boolean)

  return (
    <>
      <InfoSection title="Ingress Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          {spec.ingressClassName && <InfoRow label="Ingress Class" value={<ResourceLink kind="IngressClass" name={String(spec.ingressClassName)} />} />}
          {defaultBackend && (
            <InfoRow label="Default Backend" value={
              defaultBackend.service ? `${defaultBackend.service.name}:${defaultBackend.service.port?.number || defaultBackend.service.port?.name || ''}` : '-'
            } />
          )}
          {lbAddresses.length > 0 && <InfoRow label="Addresses" value={lbAddresses.join(', ')} />}
          <InfoRow label="Class Source" value={classSource} />
          <InfoRow label="Class Controller" value={classController} />
          <InfoRow label="Class Default" value={classIsDefault} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {tls.length > 0 && (
        <InfoSection title="TLS">
          <div className="space-y-1 text-xs">
            {tls.map((t: any, i: number) => (
              <div key={i} className="text-slate-200">
                <span className="text-slate-400">Secret:</span> {t.secretName || '-'} <span className="text-slate-400">→</span> {(t.hosts || []).join(', ')}
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {rules.length > 0 && (
        <InfoSection title="Rules">
          <div className="space-y-3">
            {rules.map((rule: any, i: number) => (
              <div key={i} className="rounded border border-slate-800 p-3">
                <p className="text-xs text-white font-medium mb-2">{rule.host || '*'}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-slate-400"><tr><th className="text-left py-1">Path</th><th className="text-left py-1">Type</th><th className="text-left py-1">Backend</th></tr></thead>
                    <tbody className="divide-y divide-slate-800">
                      {(rule.http?.paths || []).map((path: any, pi: number) => (
                        <tr key={pi} className="text-slate-200">
                          <td className="py-1 pr-2 font-mono">{path.path || '/'}</td>
                          <td className="py-1 pr-2">{path.pathType || 'Prefix'}</td>
                          <td className="py-1 pr-2">
                            {path.backend?.service?.name ? (
                              <><ResourceLink kind="Service" name={path.backend.service.name} namespace={namespace} />:{path.backend.service.port?.number || path.backend.service.port?.name || ''}</>
                            ) : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}
