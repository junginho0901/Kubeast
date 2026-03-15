import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { ConditionsTable, EventsTable, InfoSection, InfoRow, KeyValueTags, SummaryBadge, fmtRel, fmtTs } from './DetailCommon'

interface Props {
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

type DescribePort = {
  name?: string | null
  protocol?: string | null
  port?: number | null
  target_port?: string | null
  node_port?: number | null
  app_protocol?: string | null
}

type EndpointSummary = {
  ready_count?: number
  not_ready_count?: number
  ready_addresses?: string[]
  not_ready_addresses?: string[]
}

type EndpointSliceSummary = {
  name?: string | null
  address_type?: string | null
  endpoints_total?: number
  endpoints_ready?: number
  ports?: Array<{ name?: string | null; port?: number | null; protocol?: string | null }>
}

type ServiceDescribe = {
  uid?: string | null
  resource_version?: string | null
  type?: string | null
  cluster_ip?: string | null
  cluster_ips?: string[]
  ip_families?: string[]
  ip_family_policy?: string | null
  session_affinity?: string | null
  session_affinity_timeout_seconds?: number | null
  internal_traffic_policy?: string | null
  external_traffic_policy?: string | null
  allocate_load_balancer_node_ports?: boolean | null
  publish_not_ready_addresses?: boolean | null
  health_check_node_port?: number | null
  external_name?: string | null
  external_ips?: string[]
  load_balancer_ingress?: Array<{ ip?: string | null; hostname?: string | null }>
  ports?: DescribePort[]
  selector?: Record<string, string>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  owner_references?: Array<{
    kind?: string | null
    name?: string | null
    uid?: string | null
    controller?: boolean | null
  }>
  created_at?: string | null
  conditions?: Array<Record<string, unknown>>
  endpoint_summary?: EndpointSummary | null
  endpoint_slices?: EndpointSliceSummary[]
  events?: Array<Record<string, unknown>>
}

function toPortDisplay(ports: DescribePort[]): string {
  if (!ports.length) return '-'
  return ports
    .map((p) => {
      const protocol = p.protocol || 'TCP'
      const from = p.port ?? '-'
      const to = p.target_port ?? '-'
      const node = p.node_port != null ? ` node:${p.node_port}` : ''
      return `${protocol} ${from}->${to}${node}`
    })
    .join(', ')
}

function formatIngress(ingress: Array<{ ip?: string | null; hostname?: string | null }>): string {
  const values = ingress
    .map((it) => it.ip || it.hostname)
    .filter(Boolean) as string[]
  return values.length > 0 ? values.join(', ') : '-'
}

export default function ServiceInfo({ name, namespace, rawJson }: Props) {
  const enabled = !!name && !!namespace
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['service-describe', namespace, name],
    queryFn: () => api.describeService(namespace as string, name) as Promise<ServiceDescribe>,
    enabled,
    retry: false,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>

  const ports = useMemo(() => {
    if (Array.isArray(describe?.ports)) return describe.ports
    const rawPorts = Array.isArray(spec?.ports) ? spec.ports : []
    return rawPorts.map((p: any) => ({
      name: p?.name,
      protocol: p?.protocol,
      port: p?.port,
      target_port: p?.targetPort,
      node_port: p?.nodePort,
      app_protocol: p?.appProtocol,
    }))
  }, [describe?.ports, spec?.ports])

  const selector = (describe?.selector ?? (spec?.selector as Record<string, string> | undefined) ?? {})
  const labels = (describe?.labels ?? (meta?.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta?.annotations as Record<string, string> | undefined) ?? {})

  const externalIps = describe?.external_ips ?? (Array.isArray(spec?.externalIPs) ? (spec.externalIPs as string[]) : [])
  const lbIngress = describe?.load_balancer_ingress ?? ((status?.loadBalancer as any)?.ingress ?? [])

  const createdAt = describe?.created_at || (meta?.creationTimestamp as string | undefined)

  const endpointSummary = describe?.endpoint_summary
  const endpointSlices = Array.isArray(describe?.endpoint_slices) ? describe.endpoint_slices : []

  const conditions = Array.isArray(describe?.conditions) ? describe.conditions : []
  const events = Array.isArray(describe?.events) ? describe.events : []

  return (
    <>
      <InfoSection title="Service Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading service details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Type" value={describe?.type ?? String(spec?.type ?? 'ClusterIP')} />
          <InfoRow label="Cluster IP" value={describe?.cluster_ip ?? String(spec?.clusterIP ?? '-')} />
          <InfoRow label="Cluster IPs" value={(describe?.cluster_ips || []).join(', ') || '-'} />
          <InfoRow label="External IPs" value={externalIps.join(', ') || '-'} />
          <InfoRow label="LoadBalancer" value={formatIngress(lbIngress)} />
          <InfoRow label="Session Affinity" value={describe?.session_affinity || String(spec?.sessionAffinity ?? 'None')} />
          <InfoRow label="Session Timeout" value={describe?.session_affinity_timeout_seconds ?? '-'} />
          <InfoRow label="Internal Traffic Policy" value={describe?.internal_traffic_policy || '-'} />
          <InfoRow label="External Traffic Policy" value={describe?.external_traffic_policy || '-'} />
          <InfoRow label="IP Families" value={(describe?.ip_families || []).join(', ') || '-'} />
          <InfoRow label="IP Family Policy" value={describe?.ip_family_policy || '-'} />
          <InfoRow label="External Name" value={describe?.external_name || '-'} />
          <InfoRow label="Publish Not Ready" value={String(describe?.publish_not_ready_addresses ?? '-')} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      <InfoSection title="Ports">
        <div className="space-y-2">
          <InfoRow label="Summary" value={toPortDisplay(ports)} />
          {ports.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs table-fixed min-w-[720px]">
                <thead className="text-slate-400">
                  <tr>
                    <th className="text-left py-2 w-[18%]">Name</th>
                    <th className="text-left py-2 w-[14%]">Protocol</th>
                    <th className="text-left py-2 w-[14%]">Port</th>
                    <th className="text-left py-2 w-[20%]">TargetPort</th>
                    <th className="text-left py-2 w-[14%]">NodePort</th>
                    <th className="text-left py-2 w-[20%]">AppProtocol</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {ports.map((port, idx) => (
                    <tr key={`${port.name || 'port'}-${idx}`} className="text-slate-200">
                      <td className="py-2 pr-2 break-words">{port.name || '-'}</td>
                      <td className="py-2 pr-2">{port.protocol || 'TCP'}</td>
                      <td className="py-2 pr-2 font-mono">{port.port ?? '-'}</td>
                      <td className="py-2 pr-2 font-mono">{port.target_port ?? '-'}</td>
                      <td className="py-2 pr-2 font-mono">{port.node_port ?? '-'}</td>
                      <td className="py-2 pr-2 break-words">{port.app_protocol || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </InfoSection>

      <InfoSection title="Endpoint Status">
        <div className="flex flex-wrap gap-2 mb-3">
          <SummaryBadge label="Ready" value={endpointSummary?.ready_count ?? 0} color="green" />
          <SummaryBadge label="Not Ready" value={endpointSummary?.not_ready_count ?? 0} color="amber" />
          <SummaryBadge label="Slices" value={endpointSlices.length} color="default" />
        </div>
        <div className="space-y-2">
          <InfoRow label="Ready Addresses" value={(endpointSummary?.ready_addresses || []).join(', ') || '-'} />
          <InfoRow label="Not Ready Addresses" value={(endpointSummary?.not_ready_addresses || []).join(', ') || '-'} />
        </div>
      </InfoSection>

      {endpointSlices.length > 0 && (
        <InfoSection title="Endpoint Slices">
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[680px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[28%]">Name</th>
                  <th className="text-left py-2 w-[18%]">Address Type</th>
                  <th className="text-left py-2 w-[14%]">Ready</th>
                  <th className="text-left py-2 w-[14%]">Total</th>
                  <th className="text-left py-2 w-[26%]">Ports</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {endpointSlices.map((slice, idx) => {
                  const portsText = (slice.ports || [])
                    .map((p) => `${p.name || '-'}:${p.port ?? '-'}${p.protocol ? `/${p.protocol}` : ''}`)
                    .join(', ')
                  return (
                    <tr key={`${slice.name || 'slice'}-${idx}`} className="text-slate-200">
                      <td className="py-2 pr-2 break-words">{slice.name || '-'}</td>
                      <td className="py-2 pr-2">{slice.address_type || '-'}</td>
                      <td className="py-2 pr-2 font-mono">{slice.endpoints_ready ?? 0}</td>
                      <td className="py-2 pr-2 font-mono">{slice.endpoints_total ?? 0}</td>
                      <td className="py-2 pr-2 break-words">{portsText || '-'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {Object.keys(selector).length > 0 && (
        <InfoSection title="Selector">
          <KeyValueTags data={selector} />
        </InfoSection>
      )}

      <InfoSection title="Lifecycle">
        <div className="space-y-2">
          <InfoRow label="UID" value={describe?.uid || '-'} />
          <InfoRow label="Resource Version" value={describe?.resource_version || '-'} />
          <InfoRow label="Finalizers" value={(describe?.finalizers || []).join(', ') || '-'} />
          <InfoRow
            label="Owner References"
            value={
              (describe?.owner_references || [])
                .map((ref) => `${ref.kind || '-'}:${ref.name || '-'}${ref.controller ? ' (controller)' : ''}`)
                .join(', ') || '-'
            }
          />
        </div>
      </InfoSection>

      {conditions.length > 0 && (
        <InfoSection title="Conditions">
          <ConditionsTable conditions={conditions as any[]} />
        </InfoSection>
      )}

      {events.length > 0 && (
        <InfoSection title="Events">
          <EventsTable events={events as any[]} />
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
