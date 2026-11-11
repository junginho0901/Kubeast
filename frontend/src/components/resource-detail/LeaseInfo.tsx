import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, InfoGrid, SummaryBadge, KeyValueTags, EventsSection, Tx } from './DetailCommon'
import { fmtRel } from './detailFormat'
import { leaseHolderState } from './clusterDetail'
import { useDetailLabel } from './useDetailLabel'
import { humanDuration } from '@/utils/time'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import { DescribeFailure } from './DescribeFailure'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

export default function LeaseInfo({ name, namespace }: Props) {
  const dl = useDetailLabel()
  // a holder renews its lease every few seconds: the lease is read again every 5 s and the holder state, the
  // durations and the ages follow the clock, so an open drawer does not keep the moment it was opened
  const { data: desc, isLoading, error: describeError } = useQuery({
    queryKey: ['lease-describe', namespace, name],
    queryFn: () => api.describeLease(namespace, name),
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: 1,
  })
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [])

  useResourceDetailOverlay({ kind: 'Lease', name, namespace, describe: desc })

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center"><Tx>Loading...</Tx></div>
  }

  if (!desc) {
    // a read that failed is not an object with no data
    if (describeError) return <DescribeFailure error={describeError} className="py-4" />
    return <div className="text-xs text-slate-400 py-4 text-center"><Tx>No data</Tx></div>
  }

  const holderIdentity = desc.holder_identity || '-'
  const leaseDuration = desc.lease_duration_seconds
  const leaseTransitions = desc.lease_transitions
  const renewTime = desc.renew_time
  const acquireTime = desc.acquire_time

  const holder = leaseHolderState(desc, nowMs)
  const ageSeconds = acquireTime ? Math.max(0, Math.floor((nowMs - new Date(acquireTime).getTime()) / 1000)) : null
  const expiresInSeconds = (renewTime && leaseDuration != null)
    ? Math.floor((new Date(renewTime).getTime() + (leaseDuration as number) * 1000 - nowMs) / 1000)
    : null
  // durations as kubectl prints them; a lease past its renew time says how long ago it expired
  const fmtDur = (s: number) => (s < 0 ? <Tx text="expired {{age}} ago" values={{ age: humanDuration(-s) }} /> : humanDuration(s))

  return (
    <div className="space-y-4">
      {/* Summary Badges */}
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label="Holder" value={dl(holder)} color={holder === 'Active' ? 'green' : holder === 'Expired' ? 'amber' : 'default'} />
        {leaseDuration != null && (
          <SummaryBadge label="Lease Time" value={`${leaseDuration}s`} color="default" />
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
      <EventsSection events={desc.events} error={desc.events_error} />

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
