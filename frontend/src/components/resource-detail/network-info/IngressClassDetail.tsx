import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from '../DetailCommon'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

export default function IngressClassDetail({ name, rawJson }: Props) {
  const { open: openDetail } = useResourceDetail()
  const { data: usedByIngresses } = useQuery({
    queryKey: ['ingressclass-used-by', name],
    queryFn: () => api.listIngressesByClass(name),
    enabled: !!name,
    staleTime: 10_000,
  })
  const usedList = Array.isArray(usedByIngresses) ? usedByIngresses : []

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const annotations = (meta.annotations ?? {}) as Record<string, string>
  const finalizers = (meta.finalizers ?? rawJson?.finalizers ?? []) as string[]
  const isDefault = rawJson?.is_default != null
    ? Boolean(rawJson?.is_default)
    : annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true'
  const params = (spec.parameters ?? rawJson?.parameters ?? null) as Record<string, unknown> | null
  const paramsText = params
    ? [
        params.kind ? String(params.kind) : null,
        (params.apiGroup ?? params.api_group) ? `.${String(params.apiGroup ?? params.api_group)}` : null,
        params.name ? `/${String(params.name)}` : null,
        params.scope ? ` (${String(params.scope)})` : null,
        params.namespace ? ` ns=${String(params.namespace)}` : null,
      ].filter(Boolean).join('')
    : '-'

  return (
    <>
      <InfoSection title="IngressClass Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Controller" value={String(spec.controller ?? rawJson?.controller ?? '-')} />
          <InfoRow label="Default" value={isDefault ? 'Yes' : 'No'} />
          <InfoRow label="Parameters" value={paramsText || '-'} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      <InfoSection title={`Used By Ingresses (${usedList.length})`}>
        {usedList.length === 0 ? (
          <p className="text-xs text-slate-400">No Ingress in the cluster uses this IngressClass.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1">Namespace</th>
                  <th className="text-left py-1">Ingress</th>
                  <th className="text-left py-1">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {usedList.slice(0, 50).map((ing) => (
                  <tr
                    key={`${ing.namespace}/${ing.name}`}
                    className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => openDetail({ kind: 'Ingress', name: ing.name, namespace: ing.namespace })}
                  >
                    <td className="py-1 pr-2 font-mono">{ing.namespace}</td>
                    <td className="py-1 pr-2 font-mono">{ing.name}</td>
                    <td className="py-1 pr-2 text-slate-400">{ing.created_at ? fmtRel(ing.created_at) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {usedList.length >= 50 && (
              <p className="text-[11px] text-amber-300 mt-1">Showing first 50 (truncated for performance).</p>
            )}
          </div>
        )}
      </InfoSection>

      {finalizers.length > 0 && (
        <InfoSection title="Finalizers">
          <div className="flex flex-wrap gap-1.5">
            {finalizers.map((f, i) => (
              <span key={`${f}-${i}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-200">{f}</span>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
      {Object.keys(annotations).length > 0 && <InfoSection title="Annotations"><KeyValueTags data={annotations} /></InfoSection>}
    </>
  )
}
