import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from './DetailCommon'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

type DeviceClassDescribe = {
  name?: string
  uid?: string | null
  resource_version?: string | null
  selectors?: Array<Record<string, unknown>>
  suitable_nodes?: Record<string, unknown>
  config?: Array<Record<string, unknown>> | Record<string, unknown>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  created_at?: string | null
  metadata?: Record<string, unknown>
}

const text = (v: unknown) => (v != null && v !== '' ? String(v) : '-')

export default function DeviceClassInfo({ name, rawJson }: Props) {
  const { open: openDetail } = useResourceDetail()
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['deviceclass-describe', name],
    queryFn: () => api.describeDeviceClass(name) as Promise<DeviceClassDescribe>,
    enabled: !!name,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'DeviceClass', name, describe })

  // Cluster-wide ResourceClaim scan + filter by deviceClassName. K8s 1.30+
  // DRA: claim.spec.devices.requests[].deviceClassName references the class.
  const { data: allClaims } = useQuery({
    queryKey: ['deviceclass-using-claims', name],
    queryFn: () => api.getAllResourceClaims(),
    enabled: !!name,
    staleTime: 30_000,
  })
  const usingClaims = (Array.isArray(allClaims) ? allClaims : []).filter((c: any) => {
    const requests = c?.spec?.devices?.requests ?? c?.devices?.requests ?? []
    return Array.isArray(requests) && requests.some((r: any) => (r?.deviceClassName ?? r?.device_class_name) === name)
  }).slice(0, 50)

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

  /* ── Parse suitable nodes ── */
  const suitableNodes = describe?.suitable_nodes as Record<string, unknown> | undefined
  const nodeSelectorTerms = (suitableNodes?.nodeSelectorTerms ?? suitableNodes?.node_selector_terms) as Array<Record<string, unknown>> | undefined
  const matchExpressions: Array<{ key: string; operator: string; values: string }> = []
  if (nodeSelectorTerms) {
    for (const term of nodeSelectorTerms) {
      const exprs = (term.matchExpressions ?? term.match_expressions) as Array<Record<string, unknown>> | undefined
      if (exprs) {
        for (const expr of exprs) {
          matchExpressions.push({
            key: String(expr.key ?? ''),
            operator: String(expr.operator ?? ''),
            values: Array.isArray(expr.values) ? expr.values.join(', ') : text(expr.values),
          })
        }
      }
    }
  }

  /* ── Parse config ── */
  const rawConfig = describe?.config
  const configItems: Array<{ driver: string; parameters: Record<string, unknown> }> = []
  const configArr = Array.isArray(rawConfig) ? rawConfig : rawConfig ? [rawConfig] : []
  for (const item of configArr) {
    const opaque = item.opaque as Record<string, unknown> | undefined
    if (opaque) {
      configItems.push({
        driver: String(opaque.driver ?? '-'),
        parameters: (opaque.parameters ?? {}) as Record<string, unknown>,
      })
    }
  }

  return (
    <>
      <InfoSection title="DeviceClass Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading DeviceClass details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="space-y-2">
          <InfoRow label="Name" value={describe?.name || name} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      {selectorExpressions.length > 0 && (
        <InfoSection title="Selectors">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[300px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1 w-full">Expression</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {selectorExpressions.map((expr, idx) => (
                  <tr key={idx} className="text-slate-200">
                    <td className="py-1 pr-2 break-words font-mono">{expr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {matchExpressions.length > 0 && (
        <InfoSection title="Suitable Nodes">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[400px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1 w-[35%]">Key</th>
                  <th className="text-left py-1 w-[20%]">Operator</th>
                  <th className="text-left py-1 w-[45%]">Values</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {matchExpressions.map((me, idx) => (
                  <tr key={idx} className="text-slate-200">
                    <td className="py-1 pr-2 break-words font-mono">{me.key}</td>
                    <td className="py-1 pr-2 break-words">{me.operator}</td>
                    <td className="py-1 pr-2 break-words">{me.values}</td>
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
                    <KeyValueTags data={Object.fromEntries(Object.entries(cfg.parameters).map(([k, v]) => [k, String(v)]))} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      <InfoSection title={`Used By ResourceClaims (${usingClaims.length})`}>
        {usingClaims.length === 0 ? (
          <p className="text-xs text-slate-400">No ResourceClaim in the cluster references this DeviceClass.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1">Namespace</th>
                  <th className="text-left py-1">ResourceClaim</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {usingClaims.map((c: any) => (
                  <tr
                    key={`${c.namespace}/${c.name}`}
                    className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => openDetail({ kind: 'ResourceClaim', name: c.name, namespace: c.namespace })}
                  >
                    <td className="py-1 pr-2 font-mono">{c.namespace ?? '-'}</td>
                    <td className="py-1 pr-2 font-mono">{c.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {usingClaims.length >= 50 && (
              <p className="text-[11px] text-amber-300 mt-1">Showing first 50 (truncated for performance).</p>
            )}
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
