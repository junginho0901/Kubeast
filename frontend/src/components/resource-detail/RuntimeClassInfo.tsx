import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import {
  InfoSection,
  InfoRow,
  InfoGrid,
  SummaryBadge,
  StatusBadge,
  KeyValueTags,
  EventsTable,
  fmtRel,
  usePagination,
} from './DetailCommon'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

export default function RuntimeClassInfo({ name }: Props) {
  const { open: openDetail } = useResourceDetail()
  const { data: desc, isLoading } = useQuery({
    queryKey: ['runtimeclass-describe', name],
    queryFn: () => api.describeRuntimeClass(name),
    staleTime: 10_000,
    retry: 1,
  })

  const { data: allPods } = useQuery({
    queryKey: ['runtimeclass-using-pods', name],
    queryFn: () => api.getAllPods(),
    enabled: !!name,
    staleTime: 30_000,
  })
  const usingPods = (Array.isArray(allPods) ? allPods : [])
    .filter((p: any) => p?.runtime_class_name === name)
  const { items: pagedPods, nav: podsNav } = usePagination(usingPods, 10)

  useResourceDetailOverlay({ kind: 'RuntimeClass', name, describe: desc })

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center">Loading...</div>
  }

  if (!desc) {
    return <div className="text-xs text-slate-400 py-4 text-center">No data</div>
  }

  const handler = desc.handler || '-'
  const overhead = desc.overhead || {}
  const scheduling = desc.scheduling || {}
  const events: any[] = desc.events || []

  const hasOverhead = Object.keys(overhead).length > 0
  const hasScheduling = Object.keys(scheduling).length > 0

  return (
    <div className="space-y-4">
      {/* Summary Badges */}
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="Handler" value={handler} color="green" />
        <SummaryBadge label="Overhead" value={hasOverhead ? 'Configured' : 'None'} color={hasOverhead ? 'amber' : 'default'} />
        <SummaryBadge label="Scheduling" value={hasScheduling ? 'Configured' : 'None'} color={hasScheduling ? 'amber' : 'default'} />
      </div>

      {/* Basic Info */}
      <InfoSection title="Summary">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="UID" value={desc.uid || '-'} />
          <InfoRow label="Created" value={fmtRel(desc.created_at)} />
        </div>
      </InfoSection>

      {/* Runtime Settings */}
      <InfoSection title="Runtime Settings">
        <InfoGrid>
          <InfoRow label="Handler" value={handler} />
        </InfoGrid>
      </InfoSection>

      {/* Overhead */}
      {hasOverhead && (
        <InfoSection title="Overhead">
          <InfoGrid>
            {Object.entries(overhead).map(([k, v]) => (
              <InfoRow key={k} label={k} value={String(v)} />
            ))}
          </InfoGrid>
        </InfoSection>
      )}

      {/* Scheduling */}
      {hasScheduling && (
        <InfoSection title="Scheduling">
          {scheduling.node_selector && (
            <div className="mb-2">
              <p className="text-xs text-slate-400 mb-1">Node Selector</p>
              <KeyValueTags data={scheduling.node_selector as Record<string, string>} />
            </div>
          )}
          {Array.isArray(scheduling.tolerations) && scheduling.tolerations.length > 0 && (
            <div>
              <p className="text-xs text-slate-400 mb-1">Tolerations</p>
              <div className="space-y-1">
                {(scheduling.tolerations as any[]).map((tol: any, i: number) => (
                  <div key={i} className="text-xs text-slate-200 bg-slate-800/60 rounded px-2 py-1">
                    {tol.key}{tol.operator === 'Equal' ? `=${tol.value}` : ''} : {tol.effect || '*'}
                    {tol.toleration_seconds != null && ` (${tol.toleration_seconds}s)`}
                  </div>
                ))}
              </div>
            </div>
          )}
        </InfoSection>
      )}

      <InfoSection title={`Used By Pods (${usingPods.length})`}>
        {usingPods.length === 0 ? (
          <p className="text-xs text-slate-400">No pod in the cluster uses this RuntimeClass.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1">Namespace</th>
                  <th className="text-left py-1">Pod</th>
                  <th className="text-left py-1">Status</th>
                  <th className="text-left py-1">Node</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {pagedPods.map((p: any) => (
                  <tr
                    key={`${p.namespace}/${p.name}`}
                    className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                    onClick={() => openDetail({ kind: 'Pod', name: p.name, namespace: p.namespace })}
                  >
                    <td className="py-1 pr-2 font-mono">{p.namespace}</td>
                    <td className="py-1 pr-2 font-mono">{p.name}</td>
                    <td className="py-1 pr-2"><StatusBadge status={String(p.phase ?? p.status ?? '-')} /></td>
                    <td className="py-1 pr-2 truncate max-w-[160px]">{p.node_name || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {podsNav}
          </div>
        )}
      </InfoSection>

      {/* Events */}
      <InfoSection title="Events">
        <EventsTable events={events} />
      </InfoSection>

      {/* Labels & Annotations */}
      <InfoSection title="Labels">
        <KeyValueTags data={desc.labels} />
      </InfoSection>

      <InfoSection title="Annotations">
        <KeyValueTags data={desc.annotations} />
      </InfoSection>
    </div>
  )
}
