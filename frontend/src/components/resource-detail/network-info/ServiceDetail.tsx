import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from '../DetailCommon'

interface Props {
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

export default function ServiceDetail({ name, namespace, rawJson }: Props) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const selector = (spec.selector ?? {}) as Record<string, string>
  const ports = (spec.ports ?? []) as any[]
  const externalIPs = (spec.externalIPs ?? []) as string[]
  const lbIngress = ((status.loadBalancer as any)?.ingress ?? []) as any[]

  return (
    <>
      <InfoSection title="Service Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Type" value={String(spec.type ?? 'ClusterIP')} />
          <InfoRow label="Cluster IP" value={String(spec.clusterIP ?? '-')} />
          {externalIPs.length > 0 && <InfoRow label="External IPs" value={externalIPs.join(', ')} />}
          {lbIngress.length > 0 && <InfoRow label="Load Balancer" value={lbIngress.map((i: any) => i.ip || i.hostname).join(', ')} />}
          <InfoRow label="Session Affinity" value={String(spec.sessionAffinity ?? 'None')} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {Object.keys(selector).length > 0 && (
        <InfoSection title="Selector">
          <KeyValueTags data={selector} />
        </InfoSection>
      )}

      {ports.length > 0 && (
        <InfoSection title="Ports">
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[400px]">
              <thead className="text-slate-400"><tr><th className="text-left py-1">Name</th><th className="text-left py-1">Port</th><th className="text-left py-1">Target</th><th className="text-left py-1">Protocol</th>{spec.type === 'NodePort' && <th className="text-left py-1">NodePort</th>}</tr></thead>
              <tbody className="divide-y divide-slate-800">
                {ports.map((p: any, i: number) => (
                  <tr key={i} className="text-slate-200">
                    <td className="py-1 pr-2">{p.name || '-'}</td>
                    <td className="py-1 pr-2">{p.port}</td>
                    <td className="py-1 pr-2">{p.targetPort ?? '-'}</td>
                    <td className="py-1 pr-2">{p.protocol || 'TCP'}</td>
                    {spec.type === 'NodePort' && <td className="py-1 pr-2">{p.nodePort ?? '-'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}
