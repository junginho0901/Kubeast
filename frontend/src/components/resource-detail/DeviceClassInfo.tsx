import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { EventsSection, InfoSection, InfoRow, KeyValueTags, Th, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { usePagination } from './usePagination'
import { configParameterMap } from './draText'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import { DescribeFailure } from './DescribeFailure'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

type DeviceClassDescribe = {
  name?: string
  uid?: string | null
  resource_version?: string | null
  selectors?: Array<Record<string, unknown>>
  config?: Array<Record<string, unknown>>
  extended_resource_name?: string
  // the claims whose requests ask for this class, worked out on the server
  used_by?: Array<{ namespace: string; name: string; state: string; requests: string[] }>
  used_by_error?: string
  events?: unknown[]
  events_error?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
  metadata?: Record<string, unknown>
}

export default function DeviceClassInfo({ name, rawJson }: Props) {
  const { open: openDetail } = useResourceDetail()
  const { data: describe, isLoading, error: describeError } = useQuery({
    queryKey: ['deviceclass-describe', name],
    queryFn: () => api.describeDeviceClass(name) as Promise<DeviceClassDescribe>,
    enabled: !!name,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'DeviceClass', name, describe })

  const usingClaims = describe?.used_by ?? []
  const { items: pagedUsingClaims, nav: usingClaimsNav } = usePagination(usingClaims, 10)

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  /* ── Parse selectors ── */
  const selectors = describe?.selectors ?? []
  const selectorExpressions: string[] = []
  for (const sel of selectors) {
    const cel = sel.cel as Record<string, unknown> | undefined
    if (cel?.expression) selectorExpressions.push(String(cel.expression))
  }

  /* ── Parse config (v1: spec.config[].opaque) ── */
  const configItems: Array<{ driver: string; parameters: Record<string, string> }> = []
  for (const item of describe?.config ?? []) {
    const opaque = item.opaque as Record<string, unknown> | undefined
    if (opaque) {
      configItems.push({ driver: String(opaque.driver ?? '-'), parameters: configParameterMap(opaque.parameters) })
    }
  }

  return (
    <>
      <InfoSection title="DeviceClass Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2"><Tx>Loading DeviceClass details...</Tx></p>}
        <DescribeFailure error={describeError} showingRow className="mb-2" />
        <div className="space-y-2">
          <InfoRow label="Name" value={describe?.name || name} />
          <InfoRow label="Extended Resource Name" value={describe?.extended_resource_name || '-'} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      {selectorExpressions.length > 0 && (
        <InfoSection title="Selectors">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[300px]">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1 w-full">Expression</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {selectorExpressions.map((expr, idx) => (
                  <tr key={idx} className="text-slate-200">
                    <td className="py-1 pr-2 wrap-break-word font-mono">{expr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {configItems.length > 0 && (
        <InfoSection title="Config">
          <div className="space-y-3">
            {configItems.map((cfg, idx) => (
              <div key={idx}>
                <InfoRow label="Driver" value={cfg.driver} />
                {Object.keys(cfg.parameters).length > 0 && (
                  <div className="mt-1">
                    <KeyValueTags data={cfg.parameters} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      <InfoSection title="Used By ResourceClaims ({{n}})" titleValues={{ n: describe?.used_by ? usingClaims.length : '-' }}>
        {describe?.used_by_error ? (
          <p className="text-xs text-red-400">{describe.used_by_error}</p>
        ) : describeError && !describe ? (
          <p className="text-xs text-slate-500">—</p>
        ) : usingClaims.length === 0 ? (
          <p className="text-xs text-slate-400"><Tx>No ResourceClaim in the cluster references this DeviceClass.</Tx></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1">Namespace</Th>
                  <Th className="text-left py-1">ResourceClaim</Th>
                  <Th className="text-left py-1">Requests</Th>
                  <Th className="text-left py-1">State</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {pagedUsingClaims.map((c) => (
                  <tr
                    key={`${c.namespace}/${c.name}`}
                    className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => openDetail({ kind: 'ResourceClaim', name: c.name, namespace: c.namespace })}
                  >
                    <td className="py-1 pr-2 font-mono">{c.namespace || '-'}</td>
                    <td className="py-1 pr-2 font-mono">{c.name}</td>
                    <td className="py-1 pr-2 font-mono">{c.requests.join(', ') || '-'}</td>
                    <td className="py-1 pr-2 font-mono">{c.state || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {usingClaimsNav}
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
