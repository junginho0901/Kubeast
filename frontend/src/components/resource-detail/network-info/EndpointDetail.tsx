import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { formatPorts } from '@/pages/network/endpoints/endpointHelpers'
import { EventsSection, InfoSection, InfoRow, KeyValueTags, Th, Tx } from '../DetailCommon'
import { fmtRel, fmtTs } from '../detailFormat'
import { endpointsView } from '../netstoreDetail'
import { usePagination } from '../usePagination'
import { DescribeFailure } from '../DescribeFailure'

interface Props {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
}

// The ready or not-ready targets ten to a page: each address with its target and node, else the addresses alone of an
// answer that carries no targets.
function Targets({ targets, fallbackIps, tone }: { targets: any[]; fallbackIps: string[]; tone: 'ready' | 'notReady' }) {
  const withTargets = Array.isArray(targets) && targets.length > 0
  const { items: paged, page, nav } = usePagination<any>(withTargets ? targets : (Array.isArray(fallbackIps) ? fallbackIps : []), 10)
  const testId = tone === 'ready' ? 'endpoints-ready-targets' : 'endpoints-not-ready-targets'
  if (!withTargets) {
    if (paged.length === 0) return <p className="text-xs text-slate-400"><Tx>None</Tx></p>
    return (
      <div data-testid={testId}>
        <p className="text-xs text-slate-200 break-all">{paged.join(', ')}</p>
        {nav}
      </div>
    )
  }

  const borderTone = tone === 'ready' ? 'border-emerald-800/60 bg-emerald-900/10' : 'border-amber-800/60 bg-amber-900/10'
  return (
    <div data-testid={testId}>
      <div className="space-y-1.5">
        {paged.map((t: any, i: number) => {
          const ref = t?.target_ref || t?.targetRef
          const refText = ref?.name ? `${ref.kind || 'Target'}:${ref.name}` : 'targetRef: -'
          const nodeText = t?.node_name ? `node=${t.node_name}` : null
          return (
            <div key={`${tone}-${(page - 1) * 10 + i}`} className={`rounded-sm border px-2 py-1.5 text-xs ${borderTone}`} data-testid="endpoints-target">
              <p className="text-slate-200 font-mono break-all">{t?.ip || '-'}</p>
              <p className="text-slate-300 break-all">{refText}</p>
              {nodeText && <p className="text-slate-400">{nodeText}</p>}
            </div>
          )
        })}
      </div>
      {nav}
    </div>
  )
}

// A subset's ready or not-ready addresses as kubectl describe lists them, ten to a page.
function SubsetAddresses({ label, addresses, testId }: { label: string; addresses: string[]; testId: string }) {
  const { items: paged, nav } = usePagination(addresses, 10)
  return (
    <div data-testid={testId}>
      <div><span className="text-slate-400"><Tx>{label}</Tx>:</span> {paged.join(', ') || <Tx>None</Tx>}</div>
      {nav}
    </div>
  )
}

export default function EndpointDetail({ name, namespace, kind, rawJson }: Props) {
  // The describe answer (the list's row with the metadata, the subsets and the events), the same whether the drawer
  // was opened from the list or by link
  const { data: describe, isLoading, error: describeError } = useQuery({
    queryKey: ['endpoints-describe', namespace, name],
    queryFn: () => api.describeEndpoint(namespace as string, name),
    enabled: !!name && !!namespace,
    retry: false,
  })
  const view = endpointsView(describe, rawJson)
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const readyCount = view?.ready_count ?? 0
  const notReadyCount = view?.not_ready_count ?? 0
  const createdAt = view?.created_at ?? (meta.creationTimestamp as string | undefined)
  const ports = view?.ports ?? []
  const subsets = view?.subsets ?? []
  const labels = view?.labels ?? {}
  const annotations = view?.annotations ?? {}

  return (
    <>
      <InfoSection title="{{kind}} Info" titleValues={{ kind }}>
        <div className="space-y-2">
          <InfoRow label="Kind" value={kind} />
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          {view && <InfoRow label="Ready Addresses" value={String(readyCount)} />}
          {view && <InfoRow label="Not Ready Addresses" value={String(notReadyCount)} />}
          {(readyCount + notReadyCount) > 0 && (
            <InfoRow
              label="Ready Ratio"
              value={
                <span className={`badge ${notReadyCount === 0 ? 'badge-success' : (readyCount === 0 ? 'badge-error' : 'badge-warning')}`}>
                  {Math.round((readyCount / (readyCount + notReadyCount)) * 100)}% ({readyCount}/{readyCount + notReadyCount})
                </span>
              }
            />
          )}
          {view?.generation != null && <InfoRow label="Generation" value={String(view.generation)} />}
          {view?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px] break-all">{view.resource_version}</span>} />}
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
        {isLoading && <p className="text-xs text-slate-400 mt-2"><Tx>Loading details...</Tx></p>}
        <DescribeFailure error={describeError} showingRow={!!view} className="mt-2" />
      </InfoSection>

      {ports.length > 0 && (
        <InfoSection title="Ports">
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[360px]">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1">Name</Th>
                  <Th className="text-left py-1">Port</Th>
                  <Th className="text-left py-1">Protocol</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {ports.map((p: any, i: number) => (
                  <tr key={i} className="text-slate-200">
                    <td className="py-1 pr-2">{p?.name || '-'}</td>
                    <td className="py-1 pr-2">{p?.port ?? '-'}</td>
                    <td className="py-1 pr-2">{p?.protocol || 'TCP'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {view && (view.ready_targets.length > 0 || view.ready_addresses.length > 0) && (
        <InfoSection title="Ready Targets">
          <Targets targets={view.ready_targets} fallbackIps={view.ready_addresses} tone="ready" />
        </InfoSection>
      )}

      {view && (view.not_ready_targets.length > 0 || view.not_ready_addresses.length > 0) && (
        <InfoSection title="Not Ready Targets">
          <Targets targets={view.not_ready_targets} fallbackIps={view.not_ready_addresses} tone="notReady" />
        </InfoSection>
      )}

      {/* each subset as kubectl describe lists it: its ready and not-ready addresses and its ports */}
      {subsets.length > 0 && (
        <InfoSection title="Subsets">
          <div className="space-y-2 text-xs">
            {subsets.map((s, i) => (
              <div key={i} className="rounded-sm border border-slate-800 p-2 space-y-0.5 text-slate-200" data-testid="endpoints-subset">
                <SubsetAddresses label="Addresses" addresses={s.addresses} testId="endpoints-subset-addresses" />
                <SubsetAddresses label="Not Ready Addresses" addresses={s.not_ready_addresses} testId="endpoints-subset-not-ready-addresses" />
                <div><span className="text-slate-400"><Tx>Ports</Tx>:</span> {s.ports.length ? formatPorts(s.ports) : <Tx>None</Tx>}</div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
      {Object.keys(annotations).length > 0 && <InfoSection title="Annotations"><KeyValueTags data={annotations} /></InfoSection>}
      <EventsSection events={describe?.events} error={describe?.events_error} loading={isLoading} />
    </>
  )
}
