import { describe, expect, it } from 'vitest'

import type { JobInfo } from '@/services/api'
import {
  formatDuration,
  getJobStatusColor,
  jobChatNotes,
  jobChatStats,
  jobCompletionsCell,
  jobDrawerCompletions,
  jobDurationSeconds,
  jobNeedsALook,
  jobSummary,
  jobToWorkloadRawJson,
} from './jobHelpers'

// The floating chat is told the cards' numbers: they read a Job's Status, not how many of its pods failed or run.
describe('what the floating chat is told of the Jobs', () => {
  const job = (status: string, counts: { active?: number; succeeded?: number; failed?: number } = {}) => ({ status, active: 0, succeeded: 0, failed: 0, ...counts })

  it('counts a Job retrying after a failed pod as Running', () => {
    expect(jobChatStats([job('Running', { active: 1, failed: 1 })])).toEqual({ total: 1, completed: 0, running: 1, failed: 0 })
  })

  it('counts a suspended Job, which has no pods running', () => {
    expect(jobChatStats([job('Suspended')])).toEqual({ total: 1, completed: 0, running: 1, failed: 0 })
  })

  it('counts a Job past its deadline as Failed, whose pods were deleted and did not fail', () => {
    expect(jobChatStats([job('Failed')])).toEqual({ total: 1, completed: 0, running: 0, failed: 1 })
  })

  it('counts a Job that succeeded on a later try as Completed', () => {
    expect(jobChatStats([job('Complete', { succeeded: 1, failed: 2 })])).toEqual({ total: 1, completed: 1, running: 0, failed: 0 })
  })

  it('is the same numbers as the cards for every status kubectl prints', () => {
    const list = ['Complete', 'Failed', 'Running', 'Suspended', 'Terminating', 'FailureTarget', 'SuccessCriteriaMet'].map((status) => job(status, { failed: 1, active: 1 }))
    expect(jobChatStats(list)).toEqual(jobSummary(list))
  })

  it('does not call a retrying Job failed, and says that it retries', () => {
    expect(jobChatNotes([job('Running', { active: 1, failed: 1 })])).toEqual(['1개 Job 이 실패한 파드를 재시도 중'])
  })

  it('calls a Job failed when its Status says so, whatever its pods', () => {
    expect(jobChatNotes([job('Failed')])).toEqual(['⚠️ 1개 Job 이 실패 상태'])
  })

  it('says a Job\'s failure is decided while its pods leave', () => {
    expect(jobChatNotes([job('FailureTarget', { active: 1, failed: 1 })])).toEqual(['⚠️ 1개 Job 이 실패 확정, 파드 정리 중'])
  })

  it('has nothing to say of a Job that succeeded on a later try', () => {
    expect(jobChatNotes([job('Complete', { succeeded: 1, failed: 2 })])).toEqual([])
  })

  it('lists as problems the Jobs that failed or are retrying, not one that succeeded on a later try', () => {
    expect(jobNeedsALook(job('Failed'))).toBe(true)
    expect(jobNeedsALook(job('FailureTarget', { active: 1 }))).toBe(true)
    expect(jobNeedsALook(job('Running', { active: 1, failed: 1 }))).toBe(true)
    expect(jobNeedsALook(job('Running', { active: 1 }))).toBe(false)
    expect(jobNeedsALook(job('Complete', { succeeded: 1, failed: 2 }))).toBe(false)
  })
})

// kubectl describe prints <unset> for a Job without spec.completions; the row's 1 only fills the list's column.
describe('the Job drawer\'s Completions', () => {
  it('says <unset> when the describe answer has none', () => {
    expect(jobDrawerCompletions({ completions: null }, { completions: 1 })).toBe('<unset>')
  })

  it('shows the count a Job set', () => {
    expect(jobDrawerCompletions({ completions: 5 }, { completions: 5 })).toBe('5')
    expect(jobDrawerCompletions({ completions: 1 }, {})).toBe('1')
  })

  it('reads the row until the answer comes, and says nothing without one', () => {
    expect(jobDrawerCompletions(undefined, { completions: 3 })).toBe('3')
    expect(jobDrawerCompletions(undefined, {})).toBe('-')
  })

  it('does not take the row\'s filled-in 1 for a work queue', () => {
    const queue = { name: 'x', namespace: 'ns', completions: 1, parallelism: 3, completions_text: '0/1 of 3' } as unknown as JobInfo
    const spec = jobToWorkloadRawJson(queue).spec as { completions?: number; parallelism?: number }
    expect(spec.parallelism).toBe(3)
    expect(jobDrawerCompletions(undefined, spec)).toBe('-')
    const set = { ...queue, completions: 4, parallelism: 2, completions_text: '0/4' } as JobInfo
    expect((jobToWorkloadRawJson(set).spec as { completions?: number }).completions).toBe(4)
  })
})

// STATUS as kubectl's printJob words it (Kubernetes v1.37.2): each word in the colour of what it means.
describe('getJobStatusColor', () => {
  const colours: Record<string, string> = {
    Complete: 'badge-success',
    SuccessCriteriaMet: 'badge-success',
    Running: 'badge-success',
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
