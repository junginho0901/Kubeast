import { describe, expect, it } from 'vitest'

import { formatDuration, getJobStatusColor, jobCompletionsCell, jobDurationSeconds, jobSummary } from './jobHelpers'

// STATUS as kubectl's printJob words it (Kubernetes v1.37.2): each word in the colour of what it means.
describe('getJobStatusColor', () => {
  const colours: Record<string, string> = {
    Complete: 'badge-success',
    SuccessCriteriaMet: 'badge-success',
    Running: 'badge-warning',
    Suspended: 'badge-warning',
    Terminating: 'badge-warning',
    Failed: 'badge-error',
    FailureTarget: 'badge-error',
  }
  for (const [status, colour] of Object.entries(colours)) {
    it(`draws ${status} as ${colour}`, () => {
      expect(getJobStatusColor(status)).toBe(colour)
    })
  }
})

describe('jobCompletionsCell', () => {
  it('shows the cell the server wrote', () => {
    expect(jobCompletionsCell({ completions_text: '0/1 of 3' })).toBe('0/1 of 3')
  })

  it('shows nothing for a row without it', () => {
    expect(jobCompletionsCell({})).toBe('-')
  })
})

// Completed and Failed are the Jobs that reached that condition, as e2e number-check-lists counts them; every other Job
// has not ended, and sits in Running, so the cards add up to the total.
describe('jobSummary', () => {
  const statuses = (...list: string[]) => list.map((status) => ({ status }))

  it('counts a Job on its way to Failed as not ended yet', () => {
    expect(jobSummary(statuses('FailureTarget'))).toEqual({ total: 1, completed: 0, running: 1, failed: 0 })
  })

  it('counts a Job on its way to Complete as not ended yet', () => {
    expect(jobSummary(statuses('SuccessCriteriaMet'))).toEqual({ total: 1, completed: 0, running: 1, failed: 0 })
  })

  it('counts a Job being deleted as not ended yet', () => {
    expect(jobSummary(statuses('Terminating'))).toEqual({ total: 1, completed: 0, running: 1, failed: 0 })
  })

  it('counts a suspended Job as not ended yet', () => {
    expect(jobSummary(statuses('Suspended'))).toEqual({ total: 1, completed: 0, running: 1, failed: 0 })
  })

  it('adds up to the total for every status kubectl prints', () => {
    const list = statuses('Complete', 'Failed', 'Running', 'Suspended', 'Terminating', 'FailureTarget', 'SuccessCriteriaMet')
    const got = jobSummary(list)
    expect(got).toEqual({ total: 7, completed: 1, running: 5, failed: 1 })
    expect(got.completed + got.running + got.failed).toBe(got.total)
  })
})

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
