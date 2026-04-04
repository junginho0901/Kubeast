import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { ConditionsTable, InfoSection, InfoRow, KeyValueTags, SummaryBadge, fmtRel, fmtTs } from './DetailCommon'
import { ResourceLink } from './ResourceLink'

interface Props {
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

type GatewayDescribe = {
  uid?: string | null
  resource_version?: string | null
  gateway_class_name?: string | null
  status?: string | null
  programmed?: boolean
  accepted?: boolean
  listeners_count?: number
  attached_routes?: number
  addresses_count?: number
  listeners?: Array<Record<string, any>>
  status_listeners?: Array<Record<string, any>>
  addresses?: Array<Record<string, any>>
  conditions?: Array<Record<string, unknown>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string | null
  apiVersion?: string
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
  status_detail?: Record<string, unknown>
}

function text(value: unknown): string {
  if (value == null) return '-'
  const s = String(value)
  return s.length > 0 ? s : '-'
}

export default function GatewayInfo({ name, namespace, rawJson }: Props) {
  const enabled = !!name && !!namespace
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['gateway-describe', namespace, name],
    queryFn: () => api.describeGateway(namespace as string, name) as Promise<GatewayDescribe>,
    enabled,
    retry: false,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>

  const listeners = useMemo(() => {
    if (Array.isArray(describe?.listeners)) return describe?.listeners || []
    return Array.isArray(spec?.listeners) ? (spec.listeners as Array<Record<string, any>>) : []
  }, [describe?.listeners, spec?.listeners])

  const statusListeners = useMemo(() => {
    if (Array.isArray(describe?.status_listeners)) return describe?.status_listeners || []
    const detailListeners = (describe?.status_detail as any)?.listeners
    if (Array.isArray(detailListeners)) return detailListeners
    return Array.isArray(status?.listeners) ? (status.listeners as Array<Record<string, any>>) : []
  }, [describe?.status_detail, describe?.status_listeners, status?.listeners])

  const addresses = useMemo(() => {
    if (Array.isArray(describe?.addresses)) return describe?.addresses || []
    const detailAddresses = (describe?.status_detail as any)?.addresses
    if (Array.isArray(detailAddresses)) return detailAddresses
    return Array.isArray(status?.addresses) ? (status.addresses as Array<Record<string, any>>) : []
  }, [describe?.addresses, describe?.status_detail, status?.addresses])

  const conditions = useMemo(() => {
    if (Array.isArray(describe?.conditions)) return describe?.conditions || []
    const detailConditions = (describe?.status_detail as any)?.conditions
    if (Array.isArray(detailConditions)) return detailConditions
    return Array.isArray(status?.conditions) ? (status.conditions as Array<Record<string, unknown>>) : []
  }, [describe?.conditions, describe?.status_detail, status?.conditions])

  const labels = (describe?.labels ?? (meta?.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta?.annotations as Record<string, string> | undefined) ?? {})
  const finalizers = Array.isArray(describe?.finalizers)
    ? describe.finalizers
    : (Array.isArray(meta?.finalizers) ? (meta.finalizers as string[]) : [])

  const className = describe?.gateway_class_name ?? (spec?.gatewayClassName as string | undefined) ?? '-'
  const createdAt = describe?.created_at ?? (meta?.creationTimestamp as string | undefined)
  const statusText = describe?.status || 'Unknown'
  const listenersCount = Number(describe?.listeners_count ?? listeners.length ?? 0)
  const attachedRoutes = Number(
    describe?.attached_routes
      ?? statusListeners.reduce((sum, item) => sum + Number(item?.attachedRoutes || item?.attached_routes || 0), 0),
  )
  const addressesCount = Number(describe?.addresses_count ?? addresses.length ?? 0)
  const isProgrammed = Boolean(describe?.programmed || conditions.some((c: any) => c?.type === 'Programmed' && String(c?.status).toLowerCase() === 'true'))
  const isAccepted = Boolean(describe?.accepted || conditions.some((c: any) => c?.type === 'Accepted' && String(c?.status).toLowerCase() === 'true'))

  const statusByListenerName = useMemo(() => {
    const map = new Map<string, Record<string, any>>()
    for (const item of statusListeners) {
      const key = text(item?.name)
      if (key !== '-') map.set(key, item)
    }
    return map
  }, [statusListeners])

  return (
    <>
      <InfoSection title="Gateway Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading gateway details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="flex flex-wrap gap-2 mb-3">
          <SummaryBadge label="Status" value={statusText} color="default" />
          <SummaryBadge label="Programmed" value={isProgrammed ? 'Yes' : 'No'} color={isProgrammed ? 'green' : 'amber'} />
          <SummaryBadge label="Accepted" value={isAccepted ? 'Yes' : 'No'} color={isAccepted ? 'green' : 'amber'} />
        </div>
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Gateway Class" value={className && className !== '-' ? <ResourceLink kind="GatewayClass" name={className} /> : '-'} />
          <InfoRow label="Listeners" value={listenersCount} />
          <InfoRow label="Attached Routes" value={attachedRoutes} />
          <InfoRow label="Addresses" value={addressesCount} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      <InfoSection title="Addresses">
        {addresses.length === 0 ? (
          <p className="text-xs text-slate-400">(none)</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[560px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[25%]">Type</th>
                  <th className="text-left py-2 w-[75%]">Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {addresses.map((address, idx) => (
                  <tr key={`addr-${idx}`} className="text-slate-200">
                    <td className="py-2 pr-2 break-words">{text(address?.type)}</td>
                    <td className="py-2 pr-2 break-words">{text(address?.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </InfoSection>

      <InfoSection title="Listeners">
        {listeners.length === 0 ? (
          <p className="text-xs text-slate-400">(none)</p>
        ) : (
          <div className="space-y-3">
            {listeners.map((listener, idx) => {
              const listenerName = text(listener?.name)
              const s = statusByListenerName.get(listenerName)
              const listenerConditions = Array.isArray(s?.conditions) ? s?.conditions : []
              const supportedKinds = Array.isArray(s?.supportedKinds) ? s.supportedKinds : []
              const supportedKindsText = supportedKinds
                .map((k: any) => {
                  const group = text(k?.group)
                  const kind = text(k?.kind)
                  return group !== '-' ? `${kind}.${group}` : kind
                })
                .join(', ')

              return (
                <div key={`listener-${listenerName}-${idx}`} className="rounded border border-slate-800 p-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    <div className="text-slate-200 break-words"><span className="text-slate-400">Name:</span> {listenerName}</div>
                    <div className="text-slate-200 break-words"><span className="text-slate-400">Hostname:</span> {text(listener?.hostname)}</div>
                    <div className="text-slate-200 break-words"><span className="text-slate-400">Protocol:</span> {text(listener?.protocol)}</div>
                    <div className="text-slate-200 break-words"><span className="text-slate-400">Port:</span> {text(listener?.port)}</div>
                    <div className="text-slate-200 break-words"><span className="text-slate-400">Attached Routes:</span> {text(s?.attachedRoutes)}</div>
                    <div className="text-slate-200 break-words"><span className="text-slate-400">Supported Kinds:</span> {supportedKindsText || '-'}</div>
                  </div>
                  {listenerConditions.length > 0 && (
                    <div className="mt-3">
                      <ConditionsTable conditions={listenerConditions} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </InfoSection>

      <InfoSection title="Attached Routes Summary">
        {statusListeners.length === 0 ? (
          <p className="text-xs text-slate-400">No listener status data available to determine attached routes.</p>
        ) : (
          <div className="space-y-2">
            {statusListeners.map((sl, idx) => {
              const listenerName = text(sl?.name)
              const routeCount = Number(sl?.attachedRoutes ?? sl?.attached_routes ?? 0)
              const supportedKinds = Array.isArray(sl?.supportedKinds) ? sl.supportedKinds : []
              const kindsText = supportedKinds
                .map((k: any) => {
                  const group = text(k?.group)
                  const kind = text(k?.kind)
                  return group !== '-' ? `${kind}.${group}` : kind
                })
                .join(', ')
              return (
                <div key={`route-summary-${idx}`} className="rounded border border-slate-800 p-2">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                    <div className="text-slate-200"><span className="text-slate-400">Listener:</span> {listenerName}</div>
                    <div className="text-slate-200"><span className="text-slate-400">Attached Routes:</span> {routeCount}</div>
                    <div className="text-slate-200"><span className="text-slate-400">Accepted Kinds:</span> {kindsText || '-'}</div>
                  </div>
                </div>
              )
            })}
            <p className="text-[11px] text-slate-500 mt-1">
              Total: {attachedRoutes} route(s) attached across {statusListeners.length} listener(s). Route details are available in HTTPRoute / GRPCRoute resources that reference this gateway.
            </p>
          </div>
        )}
      </InfoSection>

      <InfoSection title="Conditions">
        <ConditionsTable conditions={conditions as any[]} />
      </InfoSection>

      <InfoSection title="Lifecycle">
        <div className="space-y-2">
          <InfoRow label="UID" value={describe?.uid || text((describe?.metadata as any)?.uid)} />
          <InfoRow label="Resource Version" value={describe?.resource_version || text((describe?.metadata as any)?.resourceVersion)} />
          <InfoRow label="API Version" value={describe?.apiVersion || text(rawJson?.apiVersion)} />
          <InfoRow label="Finalizers" value={finalizers.join(', ') || '-'} />
        </div>
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
