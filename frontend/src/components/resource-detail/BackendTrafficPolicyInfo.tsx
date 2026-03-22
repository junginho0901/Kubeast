import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from './DetailCommon'

interface Props {
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

function text(value: unknown): string {
  if (value == null) return '-'
  const s = String(value)
  return s.length > 0 ? s : '-'
}

function renderJsonSection(title: string, data: Record<string, any> | null | undefined) {
  if (!data || Object.keys(data).length === 0) return null
  return (
    <InfoSection title={title}>
      <div className="space-y-2">
        {Object.entries(data).map(([key, val]) => (
          <InfoRow key={key} label={key} value={typeof val === 'object' ? JSON.stringify(val) : text(val)} />
        ))}
      </div>
    </InfoSection>
  )
}

export default function BackendTrafficPolicyInfo({ name, namespace, rawJson }: Props) {
  const enabled = !!name && !!namespace
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['backendtrafficpolicy-describe', namespace, name],
    queryFn: () => api.describeBackendTrafficPolicy(namespace as string, name),
    enabled,
    retry: false,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>

  const targetRefs = Array.isArray(describe?.target_refs)
    ? describe.target_refs
    : (Array.isArray(spec?.targetRefs) ? (spec.targetRefs as Array<Record<string, any>>) : [])

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  const sessionPersistence = describe?.session_persistence ?? null
  const retry = describe?.retry ?? null
  const rateLimit = describe?.rate_limit ?? null
  const ancestorStatuses = Array.isArray(describe?.ancestor_statuses) ? describe.ancestor_statuses : []

  return (
    <>
      <InfoSection title="BackendTrafficPolicy Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Target Refs" value={targetRefs.length} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      <InfoSection title="Target Refs">
        {targetRefs.length === 0 ? (
          <p className="text-xs text-slate-400">No data</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[400px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1 w-[25%]">Group</th>
                  <th className="text-left py-1 w-[25%]">Kind</th>
                  <th className="text-left py-1 w-[30%]">Name</th>
                  <th className="text-left py-1 w-[20%]">Section</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {targetRefs.map((ref: Record<string, any>, idx: number) => (
                  <tr key={`ref-${idx}`} className="text-slate-200">
                    <td className="py-1 pr-2 break-words">{text(ref.group)}</td>
                    <td className="py-1 pr-2 break-words">{text(ref.kind)}</td>
                    <td className="py-1 pr-2 break-words">{text(ref.name)}</td>
                    <td className="py-1 pr-2 break-words">{text(ref.section_name || ref.sectionName)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </InfoSection>

      {renderJsonSection('Session Persistence', sessionPersistence)}
      {renderJsonSection('Retry', retry)}
      {renderJsonSection('Rate Limit', rateLimit)}

      {ancestorStatuses.length > 0 && (
        <InfoSection title="Status">
          {ancestorStatuses.map((as: Record<string, any>, idx: number) => (
            <div key={`ancestor-${idx}`} className="mb-3">
              {as.ancestor_ref && (
                <p className="text-xs text-slate-400 mb-1">
                  Ancestor: {text(as.ancestor_ref.kind)}/{text(as.ancestor_ref.name)}
                </p>
              )}
              {Array.isArray(as.conditions) && as.conditions.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs table-fixed min-w-[400px]">
                    <thead className="text-slate-400">
                      <tr>
                        <th className="text-left py-1 w-[25%]">Type</th>
                        <th className="text-left py-1 w-[15%]">Status</th>
                        <th className="text-left py-1 w-[25%]">Reason</th>
                        <th className="text-left py-1 w-[35%]">Message</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {as.conditions.map((c: Record<string, any>, ci: number) => (
                        <tr key={`cond-${ci}`} className="text-slate-200">
                          <td className="py-1 pr-2 break-words">{text(c.type)}</td>
                          <td className="py-1 pr-2">{text(c.status)}</td>
                          <td className="py-1 pr-2 break-words">{text(c.reason)}</td>
                          <td className="py-1 pr-2 break-words whitespace-pre-wrap">{text(c.message)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </InfoSection>
      )}

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
