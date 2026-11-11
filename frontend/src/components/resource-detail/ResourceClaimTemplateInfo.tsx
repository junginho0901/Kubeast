import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { EventsSection, InfoSection, InfoRow, KeyValueTags, Th, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { usePagination } from './usePagination'
import { DeviceRequestsTable } from './DeviceRequestsTable'
import { configParameterMap } from './draText'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import { DescribeFailure } from './DescribeFailure'

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
  // the claims made from this template: what its pods' status.resourceClaimStatuses name, worked out on the server
  related_claims?: Array<{ name: string; namespace: string; pod: string }>
  related_claims_error?: string
  events?: unknown[]
  events_error?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
}

const text = (v: unknown) => (v != null && v !== '' ? String(v) : '-')

export default function ResourceClaimTemplateInfo({ name, namespace, rawJson }: Props) {
  const enabled = !!name && !!namespace
  const { open: openDetail } = useResourceDetail()
  const { data: describe, isLoading, error: describeError } = useQuery({
    queryKey: ['resourceclaimtemplate-describe', namespace, name],
    queryFn: () => api.describeResourceClaimTemplate(namespace, name) as Promise<ResourceClaimTemplateDescribe>,
    enabled,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'ResourceClaimTemplate', name, namespace, describe })

  const relatedClaims = describe?.related_claims ?? []
  const { items: pagedRelated, nav: relatedNav } = usePagination(relatedClaims, 10)

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  const claimSpec = describe?.claim_spec ?? describe?.spec

  /* ── Parse claim spec -> devices ── */
  const claimSpecObj = claimSpec as Record<string, unknown> | undefined
  const specNested = claimSpecObj?.spec as Record<string, unknown> | undefined
  const devicesObj = ((claimSpecObj?.devices ?? specNested?.devices) ?? {}) as Record<string, unknown>
  const requests = (devicesObj?.requests ?? []) as Array<Record<string, unknown>>
  const constraints = (devicesObj?.constraints ?? []) as Array<Record<string, unknown>>
  const configArr = (devicesObj?.config ?? []) as Array<Record<string, unknown>>

  return (
    <>
      <InfoSection title="Template Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2"><Tx>Loading ResourceClaimTemplate details...</Tx></p>}
        <DescribeFailure error={describeError} showingRow className="mb-2" />
        <div className="space-y-2">
          <InfoRow label="Name" value={describe?.name || name} />
          <InfoRow label="Namespace" value={describe?.namespace || namespace} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      <InfoSection title="Related ResourceClaims ({{n}})" titleValues={{ n: describe?.related_claims ? relatedClaims.length : '-' }}>
        {describe?.related_claims_error ? (
          <p className="text-xs text-red-400">{describe.related_claims_error}</p>
        ) : describeError && !describe ? (
          <p className="text-xs text-slate-500">—</p>
        ) : relatedClaims.length === 0 ? (
          <p className="text-xs text-slate-400"><Tx>No pod in this namespace has a ResourceClaim made from this template.</Tx></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1">ResourceClaim</Th>
                  <Th className="text-left py-1">Pod</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {pagedRelated.map((c) => (
                  <tr
                    key={`${c.name}/${c.pod}`}
                    className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => openDetail({ kind: 'ResourceClaim', name: c.name, namespace: c.namespace })}
                  >
                    <td className="py-1 pr-2 font-mono">{c.name}</td>
                    <td className="py-1 pr-2 font-mono">{c.pod}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {relatedNav}
          </div>
        )}
      </InfoSection>

      {requests.length > 0 && (
        <InfoSection title="Claim Spec - Requests">
          <DeviceRequestsTable requests={requests} />
        </InfoSection>
      )}

      {constraints.length > 0 && (
        <InfoSection title="Claim Spec - Constraints">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[300px]">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1 w-[30%]">Requests</Th>
                  <Th className="text-left py-1 w-[70%]">Match Attribute</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {constraints.map((c, idx) => {
                  const reqs = Array.isArray(c.requests) ? c.requests.join(', ') : text(c.requests)
                  const matchAttr = text(c.matchAttribute ?? c.match_attribute)
                  return (
                    <tr key={idx} className="text-slate-200">
                      <td className="py-1 pr-2 wrap-break-word">{reqs}</td>
                      <td className="py-1 pr-2 wrap-break-word font-mono">{matchAttr}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {configArr.length > 0 && (
        <InfoSection title="Claim Spec - Config">
          <div className="space-y-3">
            {configArr.map((cfg, idx) => {
              const opaque = cfg.opaque as Record<string, unknown> | undefined
              if (opaque) {
                const params = (opaque.parameters ?? {}) as Record<string, unknown>
                return (
                  <div key={idx}>
                    <InfoRow label="Driver" value={text(opaque.driver)} />
                    {Object.keys(params).length > 0 && (
                      <div className="mt-1">
                        <KeyValueTags data={configParameterMap(params)} />
                      </div>
                    )}
                  </div>
                )
              }
              return (
                <pre key={idx} className="text-xs text-gray-300 bg-gray-800 rounded-sm p-2 overflow-auto max-h-40">
                  {JSON.stringify(cfg, null, 2)}
                </pre>
              )
            })}
          </div>
        </InfoSection>
      )}

      {requests.length === 0 && constraints.length === 0 && configArr.length === 0 && (
        <InfoSection title="Claim Spec">
          {claimSpec ? (
            <pre className="text-xs text-gray-300 bg-gray-800 rounded-sm p-2 overflow-auto max-h-64">
              {JSON.stringify(claimSpec, null, 2)}
            </pre>
          ) : (
            describeError && !describe ? <p className="text-xs text-slate-500">—</p> : <p className="text-xs text-slate-400"><Tx>No claim spec</Tx></p>
          )}
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

      <EventsSection events={describe?.events} error={describe?.events_error} loading={isLoading} />
    </>
  )
}
