import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { EventsSection, InfoSection, InfoRow, KeyValueTags, StatusBadge, Th, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { usePagination } from './usePagination'
import { DeviceRequestsTable } from './DeviceRequestsTable'
import { useDrawerFollowsEvents } from './useDrawerFollowsEvents'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import { DescribeFailure, DescribeStale } from './DescribeFailure'

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
  /** kubectl's STATE */
  state?: string
  // the namespace's pods that refer to the claim (by name, or as the claim made for them from a template)
  using_pods?: Array<{ name: string; namespace: string; status: string; node_name: string }>
  using_pods_error?: string
  events?: unknown[]
  events_error?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
  metadata?: Record<string, unknown>
  status?: Record<string, unknown>
}

const text = (v: unknown) => (v != null && v !== '' ? String(v) : '-')

export default function ResourceClaimInfo({ name, namespace, rawJson }: Props) {
  const enabled = !!name && !!namespace
  const { open: openDetail } = useResourceDetail()
  const { data: describe, isLoading, error: describeError, dataUpdatedAt } = useQuery({
    queryKey: ['resourceclaim-describe', namespace, name],
    queryFn: () => api.describeResourceClaim(namespace, name) as Promise<ResourceClaimDescribe>,
    enabled,
    retry: false,
  })
  useDrawerFollowsEvents({ describeKey: ['resourceclaim-describe', namespace, name], answer: describe, kind: 'ResourceClaim', namespace, name })

  useResourceDetailOverlay({ kind: 'ResourceClaim', name, namespace, describe })

  const usingPods = describe?.using_pods ?? []
  const { items: pagedUsingPods, nav: usingPodsNav } = usePagination(usingPods, 10)

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

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
        {isLoading && <p className="text-xs text-slate-400 mb-2"><Tx>Loading ResourceClaim details...</Tx></p>}
        <DescribeFailure error={describe ? null : describeError} showingRow className="mb-2" />
        <DescribeStale error={describeError} readAt={dataUpdatedAt} />
        <div className="space-y-2">
          <InfoRow label="Name" value={describe?.name || name} />
          <InfoRow label="Namespace" value={describe?.namespace || namespace} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          <InfoRow label="State" value={describe?.state || '-'} />
        </div>
      </InfoSection>

      {deviceRequests.length > 0 && (
        <InfoSection title="Devices">
          <DeviceRequestsTable requests={deviceRequests} />
        </InfoSection>
      )}

      {allocResults.length > 0 && (
        <InfoSection title="Allocation">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[400px]">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1 w-[25%]">Request</Th>
                  <Th className="text-left py-1 w-[25%]">Driver</Th>
                  <Th className="text-left py-1 w-[25%]">Pool</Th>
                  <Th className="text-left py-1 w-[25%]">Device</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {allocResults.map((res, idx) => (
                  <tr key={idx} className="text-slate-200">
                    <td className="py-1 pr-2 wrap-break-word">{text(res.request)}</td>
                    <td className="py-1 pr-2 wrap-break-word">{text(res.driver)}</td>
                    <td className="py-1 pr-2 wrap-break-word">{text(res.pool)}</td>
                    <td className="py-1 pr-2 wrap-break-word">{text(res.device)}</td>
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
                  <Th className="text-left py-1 w-[35%]">Name</Th>
                  <Th className="text-left py-1 w-[25%]">Resource</Th>
                  <Th className="text-left py-1 w-[40%]">API Group</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {reservedForList.map((rf, idx) => (
                  <tr key={idx} className="text-slate-200">
                    <td className="py-1 pr-2 wrap-break-word">{text(rf.name)}</td>
                    <td className="py-1 pr-2 wrap-break-word">{text(rf.resource)}</td>
                    <td className="py-1 pr-2 wrap-break-word">{text(rf.apiGroup ?? rf.api_group)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      <InfoSection title="Using Pods ({{n}})" titleValues={{ n: describe?.using_pods ? usingPods.length : '-' }}>
        {describe?.using_pods_error ? (
          <p className="text-xs text-red-400">{describe.using_pods_error}</p>
        ) : describeError && !describe ? (
          <p className="text-xs text-slate-500">—</p>
        ) : usingPods.length === 0 ? (
          <p className="text-xs text-slate-400"><Tx>No pod in this namespace references this ResourceClaim.</Tx></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1">Pod</Th>
                  <Th className="text-left py-1">Status</Th>
                  <Th className="text-left py-1">Node</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {pagedUsingPods.map((p) => (
                  <tr
                    key={`${p.namespace}/${p.name}`}
                    className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => openDetail({ kind: 'Pod', name: p.name, namespace: p.namespace })}
                  >
                    <td className="py-1 pr-2 font-mono">{p.name}</td>
                    <td className="py-1 pr-2"><StatusBadge status={p.status || '-'} /></td>
                    <td className="py-1 pr-2 font-mono">{p.node_name || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {usingPodsNav}
          </div>
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

      <EventsSection events={describe?.events} error={describe?.events_error} loading={isLoading} />
    </>
  )
}
