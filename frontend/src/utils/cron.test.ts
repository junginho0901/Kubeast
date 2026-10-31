import { describe, expect, it } from 'vitest'
import { nextCronRun } from './cron'
import oracle from './cron.cases.json'

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

  it('follows Kubernetes where the clock changes: a skipped time does not run that day, a repeated one runs twice', () => {
    // New York 2026-03-08: 02:00 EST jumps to 03:00 EDT — 02:30 does not come that day
    expect(nextCronRun('30 2 * * *', 'America/New_York', new Date('2026-03-08T06:30:00Z'))?.toISOString()).toBe('2026-03-09T06:30:00.000Z')
    // New York 2026-11-01: 01:00–01:59 comes twice — after the first 01:30 (EDT) comes the second (EST)
    expect(nextCronRun('30 1 * * *', 'America/New_York', new Date('2026-11-01T05:30:30Z'))?.toISOString()).toBe('2026-11-01T06:30:00.000Z')
  })

  it('counts @every from the last schedule, as the controller does', () => {
    expect(nextCronRun('@every 1h30m', 'UTC', FROM, '2026-10-10T09:15:00Z')?.toISOString()).toBe('2026-10-10T12:15:00.000Z')
    expect(nextCronRun('@every 1h30m', 'UTC', FROM)?.toISOString()).toBe('2026-10-10T13:30:30.000Z')
  })

  // every case written by robfig/cron v3.0.1 through kube-controller-manager's formatSchedule (scripts/cron-cases)
  it(`gives the next run robfig/cron gives for each of the ${oracle.cases.length} cases`, () => {
    const differ = (oracle.cases as [string, string, string, string | null][])
      .map(([zone, schedule, from, next]) => ({ zone, schedule, from, next, got: nextCronRun(schedule, zone, new Date(from))?.toISOString().replace('.000Z', 'Z') ?? null }))
      .filter((c) => c.got !== c.next)
    expect(differ.slice(0, 20)).toEqual([])
  })
})
