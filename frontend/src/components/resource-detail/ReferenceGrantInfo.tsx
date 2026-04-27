import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from './DetailCommon'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface Props {
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

type ReferenceGrantDescribe = {
  uid?: string | null
  resource_version?: string | null
  from?: Array<Record<string, any>>
  to?: Array<Record<string, any>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string | null
  apiVersion?: string
  metadata?: Record<string, unknown>
}

function text(value: unknown): string {
  if (value == null) return '-'
  const s = String(value)
  return s.length > 0 ? s : '-'
}

export default function ReferenceGrantInfo({ name, namespace, rawJson }: Props) {
  const enabled = !!name && !!namespace
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['referencegrant-describe', namespace, name],
    queryFn: () => api.describeReferenceGrant(namespace as string, name) as Promise<ReferenceGrantDescribe>,
    enabled,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'ReferenceGrant', name, namespace, describe })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>

  const from = Array.isArray(describe?.from)
    ? describe.from
    : (Array.isArray(spec?.from) ? (spec.from as Array<Record<string, any>>) : [])

  const to = Array.isArray(describe?.to)
    ? describe.to
    : (Array.isArray(spec?.to) ? (spec.to as Array<Record<string, any>>) : [])

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const finalizers = Array.isArray(describe?.finalizers)
    ? describe.finalizers
    : (Array.isArray(meta?.finalizers) ? (meta.finalizers as string[]) : [])

  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  return (
    <>
      <InfoSection title="ReferenceGrant Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading ReferenceGrant details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="From Rules" value={from.length} />
          <InfoRow label="To Rules" value={to.length} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      <InfoSection title="From">
        {from.length === 0 ? (
          <p className="text-xs text-slate-400">No data</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[400px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1 w-[30%]">Group</th>
                  <th className="text-left py-1 w-[30%]">Kind</th>
                  <th className="text-left py-1 w-[40%]">Namespace</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {from.map((f, idx) => (
                  <tr key={`from-${idx}`} className="text-slate-200">
                    <td className="py-1 pr-2 break-words">{text(f.group)}</td>
                    <td className="py-1 pr-2 break-words">{text(f.kind)}</td>
                    <td className="py-1 pr-2 break-words">{text(f.namespace)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </InfoSection>

      <InfoSection title="To">
        {to.length === 0 ? (
          <p className="text-xs text-slate-400">No data</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[400px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1 w-[30%]">Group</th>
                  <th className="text-left py-1 w-[30%]">Kind</th>
                  <th className="text-left py-1 w-[40%]">Name</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {to.map((t, idx) => (
                  <tr key={`to-${idx}`} className="text-slate-200">
                    <td className="py-1 pr-2 break-words">{text(t.group)}</td>
                    <td className="py-1 pr-2 break-words">{text(t.kind)}</td>
                    <td className="py-1 pr-2 break-words">{text(t.name)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </InfoSection>

      <InfoSection title="Lifecycle">
        <div className="space-y-2">
          <InfoRow label="UID" value={describe?.uid || text((describe?.metadata as any)?.uid)} />
          <InfoRow label="Resource Version" value={describe?.resource_version || text((describe?.metadata as any)?.resourceVersion)} />
          <InfoRow label="API Version" value={describe?.apiVersion || text(rawJson?.apiVersion)} />
          <InfoRow label="Finalizers" value={finalizers.join(', ') || '-'} />
        </div>
      </InfoSection>

      {Object.keys(labels).length > 0 && (
        <InfoSection title="Labels">
          <KeyValueTags data={labels} />
        </InfoSection>
      )}

      {Object.keys(annotations).length > 0 && (
        <InfoSection title="Annotations">
          <KeyValueTags data={annotations} />
        </InfoSection>
      )}
    </>
  )
}
