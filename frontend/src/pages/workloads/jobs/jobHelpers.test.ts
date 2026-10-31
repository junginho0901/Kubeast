import { describe, expect, it } from 'vitest'

import { formatDuration, jobDurationSeconds } from './jobHelpers'

// DURATION as kubectl's printJob computes it (pkg/printers/internalversion/printers.go v1.37.0): start to
// completion, or start to now while there is no completion time — a failed Job never gets one, so it read "-"
// (number check 10-31).
describe('jobDurationSeconds', () => {
  const now = Date.parse('2026-10-31T06:00:00Z')

  it('is start to completion for a finished Job', () => {
    expect(jobDurationSeconds({ start_time: '2026-10-31T05:58:30Z', completion_time: '2026-10-31T05:59:00Z' }, now)).toBe(30)
  })

  it('is start to now while there is no completion time (running or failed)', () => {
    expect(jobDurationSeconds({ start_time: '2026-10-31T05:58:30Z', completion_time: null }, now)).toBe(90)
  })

  it('is nothing before the Job starts', () => {
    expect(jobDurationSeconds({ start_time: null }, now)).toBeNull()
    expect(formatDuration(jobDurationSeconds({}, now))).toBe('-')
  })

  it('prints as kubectl does, not as a Go duration', () => {
    // 90 s is "90s" in kubectl (HumanDuration); the watch path used to send "1m30s"
    expect(formatDuration(jobDurationSeconds({ start_time: '2026-10-31T05:58:30Z', completion_time: '2026-10-31T06:00:00Z' }, now))).toBe('90s')
  })
})
