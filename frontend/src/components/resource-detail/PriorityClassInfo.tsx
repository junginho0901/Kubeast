import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import {
  InfoSection,
  InfoRow,
  InfoGrid,
  SummaryBadge,
  KeyValueTags,
  EventsTable,
  fmtRel,
} from './DetailCommon'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

export default function PriorityClassInfo({ name }: Props) {
  const { data: desc, isLoading } = useQuery({
    queryKey: ['priorityclass-describe', name],
    queryFn: () => api.describePriorityClass(name),
    staleTime: 10_000,
    retry: 1,
  })

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
