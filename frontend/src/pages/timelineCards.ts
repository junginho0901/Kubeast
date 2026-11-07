import type { TimelineResult } from '@/services/api/types'

// The Rollouts card's number, null when the rollouts could not be read: the server then lists none, which is not zero.
export function rolloutsCount(timeline: Pick<TimelineResult, 'summary' | 'rollout_history'>): number | null {
  return timeline.summary.rollouts_error ? null : timeline.rollout_history.length
}
