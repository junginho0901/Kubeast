import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { EventsSection, InfoSection, InfoRow, KeyValueTags, Th, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { usePagination } from './usePagination'
import { draValueMap } from './draText'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import { DescribeFailure, DescribeStale } from './DescribeFailure'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

// the slice's row (internal/drarow: v1 spec.nodeName, spec.driver, spec.pool) and its spec
type ResourceSliceDescribe = {
  name?: string
  node_name?: string
  driver_name?: string
  pool_name?: string
  all_nodes?: boolean
  node_selector?: Record<string, unknown>
  pool?: Record<string, unknown>
  devices?: Array<Record<string, unknown>> | null
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
  // the claims holding this slice's devices (driver, pool and device the slice's), worked out on the server
  allocations?: Array<{ claim_namespace: string; claim_name: string; request: string; device: string; driver: string; pool: string }>
  allocations_error?: string
  events?: unknown[]
  events_error?: string
}

const text = (v: unknown) => (v != null && v !== '' ? String(v) : '-')

export default function ResourceSliceInfo({ name, rawJson }: Props) {
  const { open: openDetail } = useResourceDetail()
  const { data: describe, isLoading, error: describeError, dataUpdatedAt } = useQuery({
    queryKey: ['resourceslice-describe', name],
    queryFn: () => api.describeResourceSlice(name) as Promise<ResourceSliceDescribe>,
    enabled: !!name,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'ResourceSlice', name, describe })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  const pool = describe?.pool
  const devices = describe?.devices

  /* ── Parse pool ── */
  const poolName = pool?.name as string | undefined
  const poolGeneration = pool?.generation as number | undefined
  const poolSliceCount = (pool?.resourceSliceCount ?? pool?.resource_slice_count) as number | undefined

  /* ── Parse devices ── */
  const deviceList = Array.isArray(devices) ? devices : []

  const allocations = describe?.allocations ?? []
  const { items: pagedAllocations, nav: allocationsNav } = usePagination(allocations, 10)

  return (
    <>
      <InfoSection title="Slice Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2"><Tx>Loading ResourceSlice details...</Tx></p>}
        <DescribeFailure error={describe ? null : describeError} showingRow className="mb-2" />
        <DescribeStale error={describeError} readAt={dataUpdatedAt} />
        <div className="space-y-2">
          <InfoRow label="Name" value={describe?.name || name} />
          <InfoRow label="Node Name" value={describe?.node_name || '-'} />
          <InfoRow label="All Nodes" value={describe ? (describe.all_nodes ? 'Yes' : 'No') : '-'} />
          {describe?.node_selector && <InfoRow label="Node Selector" value={JSON.stringify(describe.node_selector)} />}
          <InfoRow label="Driver Name" value={describe?.driver_name || '-'} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      {pool && (
        <InfoSection title="Pool">
          <div className="space-y-2">
            <InfoRow label="Name" value={text(poolName)} />
            {poolGeneration != null && <InfoRow label="Generation" value={String(poolGeneration)} />}
            {poolSliceCount != null && <InfoRow label="Slice Count" value={String(poolSliceCount)} />}
          </div>
        </InfoSection>
      )}

      {deviceList.length > 0 ? (
        <InfoSection title="Devices">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[400px]">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1 w-[20%]">Name</Th>
                  <Th className="text-left py-1 w-[50%]">Attributes</Th>
                  <Th className="text-left py-1 w-[30%]">Capacity</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {deviceList.map((dev, idx) => {
                  // v1 keeps attributes and capacity on the device (v1beta1 under basic)
                  const basic = (dev.basic ?? {}) as Record<string, unknown>
                  const attrMap = draValueMap(basic.attributes ?? dev.attributes)
                  const capMap = draValueMap(basic.capacity ?? dev.capacity)
                  return (
                    <tr key={idx} className="text-slate-200 align-top">
                      <td className="py-1 pr-2 wrap-break-word">{text(dev.name)}</td>
                      <td className="py-1 pr-2">
                        {Object.keys(attrMap).length > 0 ? <KeyValueTags data={attrMap} /> : <span className="text-slate-400">-</span>}
                      </td>
                      <td className="py-1 pr-2">
                        {Object.keys(capMap).length > 0 ? <KeyValueTags data={capMap} /> : <span className="text-slate-400">-</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </InfoSection>
      ) : (
        <InfoSection title="Devices">
          {describeError && !describe ? <p className="text-xs text-slate-500">—</p> : <p className="text-xs text-slate-400"><Tx>No devices</Tx></p>}
        </InfoSection>
      )}

      <InfoSection title="Device Allocations ({{n}})" titleValues={{ n: describe?.allocations ? allocations.length : '-' }}>
        {describe?.allocations_error ? (
          <p className="text-xs text-red-400">{describe.allocations_error}</p>
        ) : describeError && !describe ? (
          <p className="text-xs text-slate-500">—</p>
        ) : allocations.length === 0 ? (
          <p className="text-xs text-slate-400"><Tx>No ResourceClaim currently allocates a device from this slice.</Tx></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1">ResourceClaim</Th>
                  <Th className="text-left py-1">Device</Th>
                  <Th className="text-left py-1">Driver</Th>
                  <Th className="text-left py-1">Request</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {pagedAllocations.map((a, i) => (
                  <tr
                    key={i}
                    className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => openDetail({ kind: 'ResourceClaim', name: a.claim_name, namespace: a.claim_namespace })}
                  >
                    <td className="py-1 pr-2 font-mono">{a.claim_namespace}/{a.claim_name}</td>
                    <td className="py-1 pr-2 font-mono">{a.device || '-'}</td>
                    <td className="py-1 pr-2 font-mono text-slate-400">{a.driver || '-'}</td>
                    <td className="py-1 pr-2 font-mono text-slate-400">{a.request || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {allocationsNav}
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
