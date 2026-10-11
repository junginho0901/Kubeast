import { describe, expect, it } from 'vitest'
import { nextCronRun } from './cron'

const FROM = new Date('2026-10-10T12:00:30Z')

describe('next run of a CronJob schedule', () => {
  it('reads the schedule in spec.timeZone', () => {
    // 03:00 in Seoul (UTC+9) after 21:00:30 Seoul time = the next day 03:00 = 18:00 UTC today
    expect(nextCronRun('0 3 * * *', 'Asia/Seoul', FROM)?.toISOString()).toBe('2026-10-10T18:00:00.000Z')
    expect(nextCronRun('0 3 * * *', 'UTC', FROM)?.toISOString()).toBe('2026-10-11T03:00:00.000Z')
  })

  it('takes the macros and the day-of-month OR day-of-week rule', () => {
    expect(nextCronRun('@hourly', 'UTC', FROM)?.toISOString()).toBe('2026-10-10T13:00:00.000Z')
    // the 1st of the month OR a Monday: Monday 2026-10-12 comes first
    expect(nextCronRun('0 0 1 * 1', 'UTC', FROM)?.toISOString()).toBe('2026-10-12T00:00:00.000Z')
  })

  it('gives nothing for an empty or unreadable schedule or zone', () => {
    expect(nextCronRun('', 'UTC', FROM)).toBeNull()
    expect(nextCronRun('not a schedule', 'UTC', FROM)).toBeNull()
    expect(nextCronRun('0 3 * * *', 'Mars/Olympus', FROM)).toBeNull()
  })
})
