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
  namespace: string
  rawJson?: Record<string, unknown>
}

export default function LeaseInfo({ name, namespace }: Props) {
  const { data: desc, isLoading } = useQuery({
    queryKey: ['lease-describe', namespace, name],
    queryFn: () => api.describeLease(namespace, name),
    staleTime: 10_000,
    retry: 1,
  })

  useResourceDetailOverlay({ kind: 'Lease', name, namespace, describe: desc })

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center">Loading...</div>
  }

  if (!desc) {
    return <div className="text-xs text-slate-400 py-4 text-center">No data</div>
  }

  const holderIdentity = desc.holder_identity || '-'
  const leaseDuration = desc.lease_duration_seconds
  const leaseTransitions = desc.lease_transitions
  const renewTime = desc.renew_time
  const acquireTime = desc.acquire_time
  const events: any[] = desc.events || []

  // Derived from acquire/renew times. Computed at render — not "real time", but
  // close enough for a detail drawer (refreshes on next describe poll).
  const nowMs = Date.now()
  const ageSeconds = acquireTime ? Math.max(0, Math.floor((nowMs - new Date(acquireTime).getTime()) / 1000)) : null
  const expiresInSeconds = (renewTime && leaseDuration != null)
    ? Math.floor((new Date(renewTime).getTime() + (leaseDuration as number) * 1000 - nowMs) / 1000)
    : null
  const fmtDur = (s: number): string => {
    if (s < 0) return `${-s}s ago (expired)`
    if (s < 60) return `${s}s`
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
  }

  return (
    <div className="space-y-4">
      {/* Summary Badges */}
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="Holder" value={holderIdentity !== '-' ? 'Active' : 'None'} color={holderIdentity !== '-' ? 'green' : 'default'} />
        {leaseDuration != null && (
          <SummaryBadge label="Duration" value={`${leaseDuration}s`} color="default" />
        )}
        {leaseTransitions != null && (
          <SummaryBadge label="Transitions" value={String(leaseTransitions)} color={leaseTransitions > 0 ? 'amber' : 'default'} />
        )}
      </div>

      {/* Basic Info */}
      <InfoSection title="Summary">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Namespace" value={namespace} />
          <InfoRow label="UID" value={desc.uid || '-'} />
          <InfoRow label="Created" value={fmtRel(desc.created_at)} />
        </div>
      </InfoSection>

      {/* Lease Spec */}
      <InfoSection title="Lease Spec">
        <InfoGrid>
          <InfoRow label="Holder Identity" value={holderIdentity} />
          <InfoRow label="Lease Duration" value={leaseDuration != null ? `${leaseDuration}s` : '-'} />
          <InfoRow label="Lease Transitions" value={leaseTransitions != null ? String(leaseTransitions) : '-'} />
          <InfoRow label="Renew Time" value={renewTime ? fmtRel(renewTime) : '-'} />
          <InfoRow label="Acquire Time" value={acquireTime ? fmtRel(acquireTime) : '-'} />
          {ageSeconds != null && <InfoRow label="Lease Age" value={fmtDur(ageSeconds)} />}
          {expiresInSeconds != null && (
            <InfoRow
              label="Expires In"
              value={
                <span className={`badge ${expiresInSeconds < 0 ? 'badge-error' : (expiresInSeconds < 10 ? 'badge-warning' : 'badge-success')}`}>
                  {fmtDur(expiresInSeconds)}
                </span>
              }
            />
          )}
        </InfoGrid>
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
