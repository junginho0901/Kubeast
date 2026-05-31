import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs, usePagination } from './DetailCommon'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

type ResourceSliceDescribe = {
  name?: string
  node_name?: string
  driver_name?: string
  uid?: string | null
  resource_version?: string | null
  pool?: Record<string, unknown>
  devices?: Array<Record<string, unknown>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
}

const text = (v: unknown) => (v != null && v !== '' ? String(v) : '-')

export default function ResourceSliceInfo({ name, rawJson }: Props) {
  const { open: openDetail } = useResourceDetail()
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['resourceslice-describe', name],
    queryFn: () => api.describeResourceSlice(name) as Promise<ResourceSliceDescribe>,
    enabled: !!name,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'ResourceSlice', name, describe })

  // cluster-wide ResourceClaim 중 status.allocation.devices 가 이 slice 의
  // device 를 가리키는 것 찾기. K8s DRA: claim.status.allocation.devices.results
  // [].driver + pool + device 가 slice 의 pool.name 과 일치.
  const { data: allClaims } = useQuery({
    queryKey: ['resourceslice-allocations', name],
    queryFn: () => api.getAllResourceClaims(),
    enabled: !!name,
    staleTime: 30_000,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  const nodeName = (describe?.node_name ?? (describe?.spec as Record<string, unknown> | undefined)?.nodeName) as string | undefined
  const driverName = (describe?.driver_name ?? (describe?.spec as Record<string, unknown> | undefined)?.driver) as string | undefined
  const pool = (describe?.pool ?? (describe?.spec as Record<string, unknown> | undefined)?.pool) as Record<string, unknown> | undefined
  const devices = describe?.devices ?? (describe?.spec as Record<string, unknown> | undefined)?.devices

  /* ── Parse pool ── */
  const poolName = pool?.name as string | undefined
  const poolGeneration = pool?.generation as number | undefined
  const poolSliceCount = (pool?.resourceSliceCount ?? pool?.resource_slice_count) as number | undefined

  /* ── Parse devices ── */
  const deviceList = Array.isArray(devices) ? devices : []

  // Build slice device names for cross-ref lookup.
  const sliceDeviceNames = new Set<string>(
    deviceList.map((d: any) => d?.name).filter(Boolean) as string[],
  )
  // RC 의 status.allocation.devices.results[] = [{driver, pool, device, request}]
  // pool === slice 의 poolName 이고 device 가 slice 의 device 목록에 있으면 매칭.
  const allocations = (Array.isArray(allClaims) ? allClaims : []).flatMap((c: any) => {
    const results = c?.status?.allocation?.devices?.results ?? []
    if (!Array.isArray(results)) return []
    return results
      .filter((r: any) => (poolName && r?.pool === poolName) || sliceDeviceNames.has(r?.device))
      .map((r: any) => ({
        claim_namespace: c.namespace,
        claim_name: c.name,
        device: r.device,
        driver: r.driver,
        request: r.request,
      }))
  })
  const { items: pagedAllocations, nav: allocationsNav } = usePagination(allocations, 10)

  return (
    <>
      <InfoSection title="Slice Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading ResourceSlice details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="space-y-2">
          <InfoRow label="Name" value={describe?.name || name} />
          {nodeName && <InfoRow label="Node Name" value={String(nodeName)} />}
          {driverName && <InfoRow label="Driver Name" value={String(driverName)} />}
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
                  <th className="text-left py-1 w-[25%]">Name</th>
                  <th className="text-left py-1 w-[75%]">Attributes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {deviceList.map((dev, idx) => {
                  const devName = text(dev.name)
                  const basic = (dev.basic ?? {}) as Record<string, unknown>
                  const attrs = (basic.attributes ?? dev.attributes ?? {}) as Record<string, unknown>
                  const attrEntries = Object.entries(attrs)
                  const attrMap: Record<string, string> = {}
                  for (const [k, v] of attrEntries) {
                    if (v && typeof v === 'object') {
                      const vObj = v as Record<string, unknown>
                      const valKeys = Object.keys(vObj)
                      if (valKeys.length === 1) {
                        attrMap[k] = String(vObj[valKeys[0]])
                      } else {
                        attrMap[k] = JSON.stringify(v)
                      }
                    } else {
                      attrMap[k] = String(v)
                    }
                  }
                  return (
                    <tr key={idx} className="text-slate-200 align-top">
                      <td className="py-1 pr-2 break-words">{devName}</td>
                      <td className="py-1 pr-2">
                        {Object.keys(attrMap).length > 0 ? (
                          <KeyValueTags data={attrMap} />
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
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
          <p className="text-xs text-slate-400">No devices</p>
        </InfoSection>
      )}

      <InfoSection title={`Device Allocations (${allocations.length})`}>
        {allocations.length === 0 ? (
          <p className="text-xs text-slate-400">No ResourceClaim currently allocates a device from this slice.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1">ResourceClaim</th>
                  <th className="text-left py-1">Device</th>
                  <th className="text-left py-1">Driver</th>
                  <th className="text-left py-1">Request</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {pagedAllocations.map((a: any, i: number) => (
                  <tr
                    key={i}
                    className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => openDetail({ kind: 'ResourceClaim', name: a.claim_name, namespace: a.claim_namespace })}
                  >
                    <td className="py-1 pr-2 font-mono">{a.claim_namespace}/{a.claim_name}</td>
                    <td className="py-1 pr-2 font-mono">{a.device ?? '-'}</td>
                    <td className="py-1 pr-2 font-mono text-slate-400">{a.driver ?? '-'}</td>
                    <td className="py-1 pr-2 font-mono text-slate-400">{a.request ?? '-'}</td>
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
    </>
  )
}
