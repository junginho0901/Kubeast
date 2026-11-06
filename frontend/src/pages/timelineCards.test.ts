import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RolloutRevision } from '@/services/api/types'
import { rolloutsCount } from './timelineCards'

const summary = { total_events: 0, normal_count: 0, warning_count: 0, time_range: { start: '', end: '' } }

// Rollouts that could not be read are no number: the card says "-" and the chat null, not a zero nobody counted.
describe('the Timeline Rollouts card', () => {
  it('has no number when the rollouts could not be read', () => {
    expect(rolloutsCount({ summary: { ...summary, rollouts_error: 'replicasets is forbidden' }, rollout_history: [] })).toBeNull()
  })

  it('counts the rollouts it read, none as 0', () => {
    expect(rolloutsCount({ summary, rollout_history: [] })).toBe(0)
    expect(rolloutsCount({ summary, rollout_history: [{}, {}] as RolloutRevision[] })).toBe(2)
  })

  it('the card and the floating chat read that number', () => {
    const src = readFileSync(fileURLToPath(new URL('./Timeline.tsx', import.meta.url)), 'utf8')
    expect(src).toContain("value={rolloutsCount(timeline) ?? '-'}")
    expect(src).toContain('const totalRollouts = rolloutsCount(timeline)')
  })
})
