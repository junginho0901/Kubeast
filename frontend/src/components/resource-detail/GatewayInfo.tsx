import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { ConditionsTable, EventsSection, InfoSection, InfoRow, KeyValueTags, SummaryBadge, Th, NoneText, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { conditionStatus, conditionSummary } from './gatewayDetail'
import { ResourceLink } from './ResourceLink'
import { useDrawerFollowsEvents } from './useDrawerFollowsEvents'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import type { GatewayInfo as GatewayRow } from '@/services/api'
import { DescribeFailure, DescribeStale } from './DescribeFailure'

interface Props {
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

// the list's row (gatewayrow.Gateway) with the object's metadata and events
type GatewayDescribe = GatewayRow & {
  uid?: string | null
  resource_version?: string | null
  generation?: number
  events?: Array<Record<string, unknown>>
  events_error?: string
}

function text(value: unknown): string {
  if (value == null) return '-'
  const s = String(value)
  return s.length > 0 ? s : '-'
}

export default function GatewayInfo({ name, namespace, rawJson }: Props) {
  const enabled = !!name && !!namespace
  const { data: describe, isLoading, error: describeError, dataUpdatedAt } = useQuery({
    queryKey: ['gateway-describe', namespace, name],
    queryFn: () => api.describeGateway(namespace as string, name) as Promise<GatewayDescribe>,
    enabled,
    retry: false,
  })
  useDrawerFollowsEvents({ describeKey: ['gateway-describe', namespace, name], answer: describe, kind: 'Gateway', namespace, name })

  useResourceDetailOverlay({ kind: 'Gateway', name, namespace, describe })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>

  const listeners = useMemo(() => {
    if (Array.isArray(describe?.listeners)) return describe?.listeners || []
    return Array.isArray(spec?.listeners) ? (spec.listeners as Array<Record<string, any>>) : []
  }, [describe?.listeners, spec?.listeners])

  const statusListeners = useMemo(() => {
    if (Array.isArray(describe?.status_listeners)) return describe?.status_listeners || []
    return Array.isArray(status?.listeners) ? (status.listeners as Array<Record<string, any>>) : []
  }, [describe?.status_listeners, status?.listeners])

  const addresses = useMemo(() => {
    if (Array.isArray(describe?.addresses)) return describe?.addresses || []
    return Array.isArray(status?.addresses) ? (status.addresses as Array<Record<string, any>>) : []
  }, [describe?.addresses, status?.addresses])

  const conditions = useMemo(() => {
    if (Array.isArray(describe?.conditions)) return describe?.conditions || []
    return Array.isArray(status?.conditions) ? (status.conditions as Array<Record<string, unknown>>) : []
  }, [describe?.conditions, status?.conditions])

  const labels = (describe?.labels ?? (meta?.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta?.annotations as Record<string, string> | undefined) ?? {})
  const finalizers = Array.isArray(describe?.finalizers)
    ? describe.finalizers
    : (Array.isArray(meta?.finalizers) ? (meta.finalizers as string[]) : [])

  const className = describe?.gateway_class_name ?? (spec?.gatewayClassName as string | undefined) ?? '-'
  const createdAt = describe?.created_at ?? (meta?.creationTimestamp as string | undefined)
  const statusText = describe?.status || conditionSummary(conditions, 'Programmed', 'Accepted')
  const listenersCount = Number(describe?.listeners_count ?? listeners.length ?? 0)
  const attachedRoutes = Number(
    describe?.attached_routes
      ?? statusListeners.reduce((sum, item) => sum + Number(item?.attachedRoutes || item?.attached_routes || 0), 0),
  )
  const addressesCount = Number(describe?.addresses_count ?? addresses.length ?? 0)
  const programmed = conditionStatus(conditions, 'Programmed')
  const accepted = conditionStatus(conditions, 'Accepted')

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
        {isLoading && <p className="text-xs text-slate-400 mb-2"><Tx>Loading gateway details...</Tx></p>}
        <DescribeFailure error={describe ? null : describeError} showingRow className="mb-2" />
        <DescribeStale error={describeError} readAt={dataUpdatedAt} />
        <div className="flex flex-wrap gap-2 mb-3">
          <SummaryBadge label="Status" value={statusText} color="default" />
          <SummaryBadge label="Programmed" value={programmed} color={programmed === 'True' ? 'green' : 'amber'} />
          <SummaryBadge label="Accepted" value={accepted} color={accepted === 'True' ? 'green' : 'amber'} />
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
          <p className="text-xs text-slate-400"><NoneText className="" /></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[560px]">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-2 w-[25%]">Type</Th>
                  <Th className="text-left py-2 w-[75%]">Value</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {addresses.map((address, idx) => (
                  <tr key={`addr-${idx}`} className="text-slate-200">
                    <td className="py-2 pr-2 wrap-break-word">{text(address?.type)}</td>
                    <td className="py-2 pr-2 wrap-break-word">{text(address?.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </InfoSection>

      <InfoSection title="Listeners">
        {listeners.length === 0 ? (
          <p className="text-xs text-slate-400"><NoneText className="" /></p>
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
                <div key={`listener-${listenerName}-${idx}`} className="rounded-sm border border-slate-800 p-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    <div className="text-slate-200 wrap-break-word"><span className="text-slate-400"><Tx>Name:</Tx></span> {listenerName}</div>
                    <div className="text-slate-200 wrap-break-word"><span className="text-slate-400"><Tx>Hostname:</Tx></span> {text(listener?.hostname)}</div>
                    <div className="text-slate-200 wrap-break-word"><span className="text-slate-400"><Tx>Protocol:</Tx></span> {text(listener?.protocol)}</div>
                    <div className="text-slate-200 wrap-break-word"><span className="text-slate-400"><Tx>Port:</Tx></span> {text(listener?.port)}</div>
                    <div className="text-slate-200 wrap-break-word"><span className="text-slate-400"><Tx>Attached Routes:</Tx></span> {text(s?.attachedRoutes)}</div>
                    <div className="text-slate-200 wrap-break-word"><span className="text-slate-400"><Tx>Supported Kinds:</Tx></span> {supportedKindsText || '-'}</div>
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
          <p className="text-xs text-slate-400"><Tx>No listener status data available to determine attached routes.</Tx></p>
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
                <div key={`route-summary-${idx}`} className="rounded-sm border border-slate-800 p-2">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                    <div className="text-slate-200"><span className="text-slate-400"><Tx>Listener:</Tx></span> {listenerName}</div>
                    <div className="text-slate-200"><span className="text-slate-400"><Tx>Attached Routes:</Tx></span> {routeCount}</div>
                    <div className="text-slate-200"><span className="text-slate-400"><Tx>Accepted Kinds:</Tx></span> {kindsText || '-'}</div>
                  </div>
                </div>
              )
            })}
            <p className="text-[11px] text-slate-500 mt-1">
              <Tx
                text="Total: {{routes}} route(s) attached across {{listeners}} listener(s). Route details are available in HTTPRoute / GRPCRoute resources that reference this gateway."
                values={{ routes: attachedRoutes, listeners: statusListeners.length }}
              />
            </p>
          </div>
        )}
      </InfoSection>

      <InfoSection title="Conditions">
        <ConditionsTable conditions={conditions as any[]} />
      </InfoSection>

      <EventsSection events={describe?.events} error={describe?.events_error} loading={isLoading} />

      <InfoSection title="Lifecycle">
        <div className="space-y-2">
          <InfoRow label="UID" value={text(describe?.uid)} />
          <InfoRow label="Resource Version" value={text(describe?.resource_version)} />
          <InfoRow label="API Version" value={describe?.api_version || text(rawJson?.apiVersion)} />
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
