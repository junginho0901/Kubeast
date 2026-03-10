import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { Search } from 'lucide-react'
import { InfoSection, InfoRow, InfoGrid, KeyValueTags, ConditionsTable, EventsTable, SummaryBadge, fmtRel, fmtTs } from './DetailCommon'

interface Props { name: string }

export default function NamespaceInfo({ name }: Props) {
  const { t } = useTranslation()
  const tr = (k: string, fb: string, o?: Record<string, any>) => t(k, { defaultValue: fb, ...o })

  const [podFilter, setPodFilter] = useState('')
  const [podPage, setPodPage] = useState(1)

  const { data: nsDescribe, isLoading, isError } = useQuery({
    queryKey: ['namespace-describe', name],
    queryFn: () => api.describeNamespace(name),
    enabled: !!name,
  })

  const { data: resourceQuotas } = useQuery({
    queryKey: ['namespace-rq', name],
    queryFn: () => api.getNamespaceResourceQuotas(name),
    enabled: !!name,
  })

  const { data: limitRanges } = useQuery({
    queryKey: ['namespace-lr', name],
    queryFn: () => api.getNamespaceLimitRanges(name),
    enabled: !!name,
  })

  const { data: nsPods } = useQuery({
    queryKey: ['namespace-pods', name],
    queryFn: () => api.getNamespacePods(name),
    enabled: !!name,
  })

  const applyNsEvent = (prev: any[] | undefined, event: { type?: string; object?: any }) => {
    const items = Array.isArray(prev) ? [...prev] : []
    const obj = event?.object
    if (!obj) return items
    const key = `${obj?.reason || ''}:${obj?.message || ''}`
    const idx = items.findIndex(i => `${i?.reason || ''}:${i?.message || ''}` === key)
    if (event.type === 'DELETED') { if (idx >= 0) items.splice(idx, 1); return items }
    if (idx >= 0) items[idx] = obj; else items.push(obj)
    return items
  }

  useKubeWatchList({
    enabled: !!name,
    queryKey: ['namespace-events', name],
    path: '/api/v1/events',
    query: `watch=1&fieldSelector=${encodeURIComponent(`involvedObject.kind=Namespace,involvedObject.name=${name}`)}`,
    applyEvent: applyNsEvent,
  })

  const sortedEvents = useMemo(() => {
    if (!nsDescribe?.events || !Array.isArray(nsDescribe.events)) return []
    return [...nsDescribe.events].sort((a: any, b: any) => {
      const ta = new Date(a.last_timestamp || a.first_timestamp || 0).getTime()
      const tb = new Date(b.last_timestamp || b.first_timestamp || 0).getTime()
      return tb - ta
    })
  }, [nsDescribe?.events])

  const filteredPods = useMemo(() => {
    if (!Array.isArray(nsPods)) return []
    if (!podFilter.trim()) return nsPods
    const q = podFilter.toLowerCase()
    return nsPods.filter((p: any) => p.name.toLowerCase().includes(q) || (p.status || '').toLowerCase().includes(q) || (p.node || '').toLowerCase().includes(q))
  }, [nsPods, podFilter])

  const podPageSize = 10
  const podTotalPages = Math.max(1, Math.ceil(filteredPods.length / podPageSize))
  const pagedPods = filteredPods.slice((podPage - 1) * podPageSize, podPage * podPageSize)

  useEffect(() => {
    if (podPage > podTotalPages) {
      setPodPage(podTotalPages)
    }
  }, [podPage, podTotalPages])

  useEffect(() => {
    setPodPage(1)
  }, [podFilter, name])

  const podStatusColor = (s: string) => {
    const l = (s || '').toLowerCase()
    if (l === 'running') return 'badge-success'
    if (['succeeded', 'completed'].includes(l)) return 'badge-info'
    if (l === 'pending') return 'badge-warning'
    if (['failed', 'error', 'crashloopbackoff'].includes(l)) return 'badge-error'
    return 'badge-info'
  }

  if (isLoading) return <p className="text-slate-400">{tr('namespaces.detail.loading', 'Loading...')}</p>
  if (isError) return <p className="text-red-400">{tr('namespaces.detail.error', 'Failed to load.')}</p>
  if (!nsDescribe) return <p className="text-slate-400">{tr('namespaces.detail.notFound', 'Not found.')}</p>

  return (
    <>
      {/* Summary Badges */}
      <div className="flex flex-wrap items-center gap-2">
        <SummaryBadge label="Status" value={nsDescribe.status || '-'} color={nsDescribe.status === 'Active' ? 'green' : 'amber'} />
        <SummaryBadge label="Labels" value={Object.keys(nsDescribe.labels || {}).length} />
        <SummaryBadge label="Annotations" value={Object.keys(nsDescribe.annotations || {}).length} />
      </div>

      {/* Basic Info */}
      <InfoSection title={tr('namespaces.detail.basicInfo', 'Basic Information')}>
        <InfoGrid>
          <InfoRow label="Name" value={nsDescribe.name} />
          <InfoRow label="Status" value={nsDescribe.status || '-'} />
          <div className="md:col-span-2">
            <InfoRow label="Created" value={fmtTs(nsDescribe.created_at)} />
          </div>
        </InfoGrid>
      </InfoSection>

      {/* Conditions */}
      <InfoSection title={tr('namespaces.detail.conditions', 'Conditions')}>
        <ConditionsTable conditions={nsDescribe.conditions || []} />
      </InfoSection>

      {/* Labels & Annotations */}
      <InfoSection title={tr('namespaces.detail.labels', 'Labels')}>
        <KeyValueTags data={nsDescribe.labels} />
      </InfoSection>
      <InfoSection title={tr('namespaces.detail.annotations', 'Annotations')}>
        <KeyValueTags data={nsDescribe.annotations} />
      </InfoSection>

      {/* Resource Quotas */}
      <InfoSection title={tr('namespaces.detail.resourceQuotas', 'Resource Quotas')}>
        {Array.isArray(resourceQuotas) && resourceQuotas.length > 0 ? (
          <div className="space-y-3">
            {resourceQuotas.map((rq: any) => (
              <div key={rq.name} className="rounded border border-slate-800 p-3">
                <p className="text-xs text-white font-medium mb-2">{rq.name}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs table-fixed min-w-[360px]">
                    <thead className="text-slate-400"><tr><th className="text-left py-1 w-[40%]">Resource</th><th className="text-left py-1 w-[30%]">Used</th><th className="text-left py-1 w-[30%]">Hard</th></tr></thead>
                    <tbody className="divide-y divide-slate-800">
                      {Object.keys({ ...rq.status_hard, ...rq.spec_hard }).map(res => (
                        <tr key={res} className="text-slate-200">
                          <td className="py-1 pr-2 font-mono">{res}</td>
                          <td className="py-1 pr-2">{rq.status_used?.[res] || '-'}</td>
                          <td className="py-1 pr-2">{rq.status_hard?.[res] || rq.spec_hard?.[res] || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        ) : <span className="text-slate-400 text-xs">(none)</span>}
      </InfoSection>

      {/* Limit Ranges */}
      <InfoSection title={tr('namespaces.detail.limitRanges', 'Limit Ranges')}>
        {Array.isArray(limitRanges) && limitRanges.length > 0 ? (
          <div className="space-y-3">
            {limitRanges.map((lr: any) => (
              <div key={lr.name} className="rounded border border-slate-800 p-3">
                <p className="text-xs text-white font-medium mb-2">{lr.name}</p>
                {lr.limits?.map((lim: any, li: number) => (
                  <div key={li} className="overflow-x-auto mb-2">
                    <p className="text-[11px] text-slate-400 mb-1">Type: {lim.type || '-'}</p>
                    <table className="w-full text-xs table-fixed min-w-[480px]">
                      <thead className="text-slate-400"><tr><th className="text-left py-1 w-[20%]">Resource</th><th className="text-left py-1 w-[20%]">Min</th><th className="text-left py-1 w-[20%]">Max</th><th className="text-left py-1 w-[20%]">Default</th><th className="text-left py-1 w-[20%]">Default Req</th></tr></thead>
                      <tbody className="divide-y divide-slate-800">
                        {Object.keys({ ...lim.min, ...lim.max, ...lim.default, ...lim.default_request }).map(res => (
                          <tr key={res} className="text-slate-200">
                            <td className="py-1 pr-2 font-mono">{res}</td>
                            <td className="py-1 pr-2">{lim.min?.[res] || '-'}</td>
                            <td className="py-1 pr-2">{lim.max?.[res] || '-'}</td>
                            <td className="py-1 pr-2">{lim.default?.[res] || '-'}</td>
                            <td className="py-1 pr-2">{lim.default_request?.[res] || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : <span className="text-slate-400 text-xs">(none)</span>}
      </InfoSection>

      {/* Pods */}
      <InfoSection
        title={`Pods${Array.isArray(nsPods) ? ` (${nsPods.length})` : ''}`}
        actions={
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
            <input
              type="text"
              value={podFilter}
              onChange={e => setPodFilter(e.target.value)}
              placeholder="Filter..."
              className="pl-6 pr-2 py-1 text-[11px] bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 focus:outline-none w-36"
            />
          </div>
        }
      >
        {Array.isArray(nsPods) && nsPods.length > 0 ? (
          <div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs table-fixed min-w-[620px]">
                <thead className="text-slate-400"><tr><th className="text-left py-2 w-[30%]">Name</th><th className="text-left py-2 w-[12%]">Status</th><th className="text-left py-2 w-[10%]">Ready</th><th className="text-left py-2 w-[10%]">Restarts</th><th className="text-left py-2 w-[23%]">Node</th><th className="text-left py-2 w-[15%]">Age</th></tr></thead>
                <tbody className="divide-y divide-slate-800">
                  {pagedPods.map((pod: any) => (
                    <tr key={pod.name} className="text-slate-200">
                      <td className="py-2 pr-2"><span className="block truncate font-mono" title={pod.name}>{pod.name}</span></td>
                      <td className="py-2 pr-2"><span className={`badge ${podStatusColor(pod.status)}`}>{pod.status}</span></td>
                      <td className="py-2 pr-2">{pod.ready}</td>
                      <td className="py-2 pr-2">{pod.restarts}</td>
                      <td className="py-2 pr-2"><span className="block truncate">{pod.node || '-'}</span></td>
                      <td className="py-2 pr-2">{fmtRel(pod.created_at)}</td>
                    </tr>
                  ))}
                  {pagedPods.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-3 text-slate-400">(none)</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400 pt-1 border-t border-slate-800 mt-2">
              <span>
                {filteredPods.length === 0
                  ? '(none)'
                  : `${(podPage - 1) * podPageSize + 1}-${Math.min(podPage * podPageSize, filteredPods.length)} / ${filteredPods.length}`}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPodPage((p) => Math.max(1, p - 1))}
                  disabled={podPage <= 1}
                  className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40"
                >
                  Prev
                </button>
                <button
                  onClick={() => setPodPage((p) => Math.min(podTotalPages, p + 1))}
                  disabled={podPage >= podTotalPages}
                  className="px-2 py-1 rounded border border-slate-700 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        ) : <span className="text-slate-400 text-xs">(none)</span>}
      </InfoSection>

      {/* Events */}
      <InfoSection title={tr('namespaces.detail.eventsTitle', 'Events')}>
        <EventsTable events={sortedEvents} />
      </InfoSection>
    </>
  )
}
