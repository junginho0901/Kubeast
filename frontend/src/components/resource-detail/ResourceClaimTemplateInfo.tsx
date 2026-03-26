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

const text = (v: unknown) => (v != null && v !== '' ? String(v) : '-')

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
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading ResourceClaimTemplate details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="space-y-2">
          <InfoRow label="Name" value={describe?.name || name} />
          <InfoRow label="Namespace" value={describe?.namespace || namespace} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      {requests.length > 0 && (
        <InfoSection title="Claim Spec - Requests">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[500px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1 w-[20%]">Name</th>
                  <th className="text-left py-1 w-[20%]">Device Class</th>
                  <th className="text-left py-1 w-[30%]">Selectors</th>
                  <th className="text-left py-1 w-[10%]">Count</th>
                  <th className="text-left py-1 w-[20%]">Allocation Mode</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {requests.map((req, idx) => {
                  const selectors = (req.selectors ?? []) as Array<Record<string, unknown>>
                  const selectorStrs = selectors.map(s => {
                    const cel = s.cel as Record<string, unknown> | undefined
                    return cel?.expression ? String(cel.expression) : JSON.stringify(s)
                  })
                  return (
                    <tr key={idx} className="text-slate-200">
                      <td className="py-1 pr-2 break-words">{text(req.name)}</td>
                      <td className="py-1 pr-2 break-words">{text(req.deviceClassName ?? req.device_class_name)}</td>
                      <td className="py-1 pr-2 break-words font-mono text-[11px]">{selectorStrs.length > 0 ? selectorStrs.join('; ') : '-'}</td>
                      <td className="py-1 pr-2">{text(req.count)}</td>
                      <td className="py-1 pr-2 break-words">{text(req.allocationMode ?? req.allocation_mode)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {constraints.length > 0 && (
        <InfoSection title="Claim Spec - Constraints">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[300px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1 w-[30%]">Requests</th>
                  <th className="text-left py-1 w-[70%]">Match Attribute</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {constraints.map((c, idx) => {
                  const reqs = Array.isArray(c.requests) ? c.requests.join(', ') : text(c.requests)
                  const matchAttr = text(c.matchAttribute ?? c.match_attribute)
                  return (
                    <tr key={idx} className="text-slate-200">
                      <td className="py-1 pr-2 break-words">{reqs}</td>
                      <td className="py-1 pr-2 break-words font-mono">{matchAttr}</td>
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
                        <KeyValueTags data={Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))} />
                      </div>
                    )}
                  </div>
                )
              }
              return (
                <pre key={idx} className="text-xs text-gray-300 bg-gray-800 rounded p-2 overflow-auto max-h-40">
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
            <pre className="text-xs text-gray-300 bg-gray-800 rounded p-2 overflow-auto max-h-64">
              {JSON.stringify(claimSpec, null, 2)}
            </pre>
          ) : (
            <p className="text-xs text-slate-400">No claim spec</p>
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
    </>
  )
}
