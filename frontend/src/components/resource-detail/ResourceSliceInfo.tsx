import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from './DetailCommon'

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
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['resourceslice-describe', name],
    queryFn: () => api.describeResourceSlice(name) as Promise<ResourceSliceDescribe>,
    enabled: !!name,
    retry: false,
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
