import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from './DetailCommon'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

type ResourceClaimTemplateDescribe = {
  name?: string
  namespace?: string
  uid?: string | null
  resource_version?: string | null
  claim_spec?: Record<string, unknown>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
}

export default function ResourceClaimTemplateInfo({ name, namespace, rawJson }: Props) {
  const enabled = !!name && !!namespace
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['resourceclaimtemplate-describe', namespace, name],
    queryFn: () => api.describeResourceClaimTemplate(namespace, name) as Promise<ResourceClaimTemplateDescribe>,
    enabled,
    retry: false,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  const claimSpec = describe?.claim_spec ?? describe?.spec

  return (
    <>
      <InfoSection title="Template Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading ResourceClaimTemplate details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="space-y-2">
          <InfoRow label="Name" value={describe?.name || name} />
          <InfoRow label="Namespace" value={describe?.namespace || namespace} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      <InfoSection title="Claim Spec">
        {claimSpec ? (
          <pre className="text-xs text-gray-300 bg-gray-800 rounded p-2 overflow-auto max-h-64">
            {JSON.stringify(claimSpec, null, 2)}
          </pre>
        ) : (
          <p className="text-xs text-slate-400">No claim spec</p>
        )}
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
