import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, KeyValueTags, SummaryBadge, fmtRel, fmtTs } from './DetailCommon'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

type ResourceClaimDescribe = {
  name?: string
  namespace?: string
  uid?: string | null
  resource_version?: string | null
  devices?: Record<string, unknown>
  allocation?: Record<string, unknown>
  reserved_for?: Array<Record<string, unknown>>
  allocation_status?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
  metadata?: Record<string, unknown>
  status?: Record<string, unknown>
}

const text = (v: unknown) => (v != null && v !== '' ? String(v) : '-')

export default function ResourceClaimInfo({ name, namespace, rawJson }: Props) {
  const enabled = !!name && !!namespace
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['resourceclaim-describe', namespace, name],
    queryFn: () => api.describeResourceClaim(namespace, name) as Promise<ResourceClaimDescribe>,
    enabled,
    retry: false,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  const allocationStatus = describe?.allocation_status
  const allocation = describe?.allocation ?? (describe?.status as Record<string, unknown> | undefined)?.allocation as Record<string, unknown> | undefined
  const reservedFor = describe?.reserved_for ?? (describe?.status as Record<string, unknown> | undefined)?.reservedFor as Array<Record<string, unknown>> | undefined

  /* ── Parse devices (spec.devices.requests) ── */
  const devicesSpec = describe?.devices as Record<string, unknown> | undefined
  const deviceRequests = (devicesSpec?.requests ?? []) as Array<Record<string, unknown>>

  /* ── Parse allocation results (status.allocation.devices.results) ── */
  const allocDevices = (allocation?.devices ?? {}) as Record<string, unknown>
  const allocResults = (allocDevices?.results ?? []) as Array<Record<string, unknown>>

  /* ── Parse reserved for ── */
  const reservedForList = (reservedFor && Array.isArray(reservedFor)) ? reservedFor : []

  return (
    <>
      <InfoSection title="Claim Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading ResourceClaim details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="space-y-2">
          <InfoRow label="Name" value={describe?.name || name} />
          <InfoRow label="Namespace" value={describe?.namespace || namespace} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {allocationStatus && (
            <InfoRow label="Allocation Status" value={<SummaryBadge label="Status" value={allocationStatus} color={allocationStatus.toLowerCase() === 'allocated' ? 'green' : 'default'} />} />
          )}
        </div>
      </InfoSection>

      {deviceRequests.length > 0 && (
        <InfoSection title="Devices">
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
                {deviceRequests.map((req, idx) => {
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

      {allocResults.length > 0 && (
        <InfoSection title="Allocation">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[400px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1 w-[25%]">Request</th>
                  <th className="text-left py-1 w-[25%]">Driver</th>
                  <th className="text-left py-1 w-[25%]">Pool</th>
                  <th className="text-left py-1 w-[25%]">Device</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {allocResults.map((res, idx) => (
                  <tr key={idx} className="text-slate-200">
                    <td className="py-1 pr-2 break-words">{text(res.request)}</td>
                    <td className="py-1 pr-2 break-words">{text(res.driver)}</td>
                    <td className="py-1 pr-2 break-words">{text(res.pool)}</td>
                    <td className="py-1 pr-2 break-words">{text(res.device)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {reservedForList.length > 0 && (
        <InfoSection title="Reserved For">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[400px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1 w-[35%]">Name</th>
                  <th className="text-left py-1 w-[25%]">Resource</th>
                  <th className="text-left py-1 w-[40%]">API Group</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {reservedForList.map((rf, idx) => (
                  <tr key={idx} className="text-slate-200">
                    <td className="py-1 pr-2 break-words">{text(rf.name)}</td>
                    <td className="py-1 pr-2 break-words">{text(rf.resource)}</td>
                    <td className="py-1 pr-2 break-words">{text(rf.apiGroup ?? rf.api_group)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
