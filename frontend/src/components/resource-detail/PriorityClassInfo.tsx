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

export default function PriorityClassInfo({ name }: Props) {
  const { open: openDetail } = useResourceDetail()
  const { data: desc, isLoading } = useQuery({
    queryKey: ['priorityclass-describe', name],
    queryFn: () => api.describePriorityClass(name),
    staleTime: 10_000,
    retry: 1,
  })

  // Cluster-wide Pod scan for spec.priorityClassName matches. max 50 cap since
  // a system PriorityClass can be referenced by hundreds of pods.
  const { data: allPods } = useQuery({
    queryKey: ['priorityclass-using-pods', name],
    queryFn: () => api.getAllPods(),
    enabled: !!name,
    staleTime: 30_000,
  })
  const usingPods = (Array.isArray(allPods) ? allPods : [])
    .filter((p: any) => p?.priority_class_name === name)
  const { items: pagedPods, nav: podsNav } = usePagination(usingPods, 10)

  useResourceDetailOverlay({ kind: 'PriorityClass', name, describe: desc })

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center">Loading...</div>
  }

  if (!desc) {
    return <div className="text-xs text-slate-400 py-4 text-center">No data</div>
  }

  const value = desc.value ?? 0
  const globalDefault = desc.global_default ?? false
  const preemptionPolicy = desc.preemption_policy || 'PreemptLowerPriority'
  const description = desc.description || '-'
  const events: any[] = desc.events || []

  return (
    <div className="space-y-4">
      {/* Summary Badges */}
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="Value" value={value} color={value > 0 ? 'green' : 'default'} />
        <SummaryBadge label="Global Default" value={globalDefault ? 'Yes' : 'No'} color={globalDefault ? 'amber' : 'default'} />
        <SummaryBadge label="Preemption" value={preemptionPolicy === 'PreemptLowerPriority' ? 'Enabled' : 'Never'} color={preemptionPolicy === 'PreemptLowerPriority' ? 'green' : 'default'} />
      </div>

      {/* Basic Info */}
      <InfoSection title="Summary">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="UID" value={desc.uid || '-'} />
          <InfoRow label="Created" value={fmtRel(desc.created_at)} />
        </div>
      </InfoSection>

      {/* Priority Settings */}
      <InfoSection title="Priority Settings">
        <InfoGrid>
          <InfoRow label="Value" value={String(value)} />
          <InfoRow label="Global Default" value={globalDefault ? 'True' : 'False'} />
          <InfoRow label="Preemption Policy" value={preemptionPolicy} />
        </InfoGrid>
      </InfoSection>

      <InfoSection title={`Used By Pods (${usingPods.length})`}>
        {usingPods.length === 0 ? (
          <p className="text-xs text-slate-400">No pod in the cluster uses this PriorityClass.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-1">Namespace</th>
                  <th className="text-left py-1">Pod</th>
                  <th className="text-left py-1">Status</th>
                  <th className="text-left py-1">Node</th>
                  <th className="text-left py-1">Age</th>
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
                    <td className="py-1 pr-2 text-slate-400">{fmtRel(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {podsNav}
          </div>
        )}
      </InfoSection>

      {/* Description */}
      <InfoSection title="Description">
        <div className="text-xs text-slate-200 whitespace-pre-wrap break-words">
          {description}
        </div>
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
