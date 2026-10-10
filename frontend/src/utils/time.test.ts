import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { absoluteTitle, ageSeconds, formatAge, formatDate, formatTime, humanDuration, parseTypedTime, utcTitle } from './time'

const SEC = 1
const MS = 0.001
const MIN = 60
const HOUR = 3600
const DAY = 24 * HOUR

describe('humanDuration = apimachinery HumanDuration', () => {
  // the cases of TestHumanDuration and TestHumanDurationBoundaries (pkg/util/duration/duration_test.go)
  const cases: [number, string][] = [
    [SEC, '1s'], [70 * SEC, '70s'], [190 * SEC, '3m10s'], [70 * MIN, '70m'], [47 * HOUR, '47h'], [49 * HOUR, '2d1h'],
    [(8 * 24 + 2) * HOUR, '8d'], [367 * DAY, '367d'], [(365 * 2 * 24 + 25) * HOUR, '2y1d'], [(365 * 8 * 24 + 2) * HOUR, '8y'],
    [-2 * SEC, '<invalid>'], [-2 * SEC + 1e-9, '0s'], [0, '0s'], [SEC - MS, '0s'], [2 * MIN - MS, '119s'], [2 * MIN, '2m'],
    [2 * MIN + SEC, '2m1s'], [10 * MIN - MS, '9m59s'], [10 * MIN, '10m'], [10 * MIN + SEC, '10m'], [3 * HOUR - MS, '179m'],
    [3 * HOUR, '3h'], [3 * HOUR + MIN, '3h1m'], [8 * HOUR - MS, '7h59m'], [8 * HOUR, '8h'], [8 * HOUR + 59 * MIN, '8h'],
    [2 * DAY - MS, '47h'], [2 * DAY, '2d'], [2 * DAY + HOUR, '2d1h'], [8 * DAY - MS, '7d23h'], [8 * DAY, '8d'],
    [8 * DAY + 23 * HOUR, '8d'], [2 * 365 * DAY - MS, '729d'], [2 * 365 * DAY, '2y'], [2 * 365 * DAY + 23 * HOUR, '2y'],
    [2 * 365 * DAY + 23 * HOUR + 59 * MIN, '2y'], [2 * 365 * DAY + DAY - MS, '2y'], [2 * 365 * DAY + DAY, '2y1d'],
    [3 * 365 * DAY, '3y'], [7 * 365 * DAY, '7y'], [8 * 365 * DAY - MS, '7y364d'], [8 * 365 * DAY, '8y'],
    [8 * 365 * DAY + 364 * DAY, '8y'], [9 * 365 * DAY, '9y'],
  ]
  for (const [seconds, want] of cases) {
    it(`${seconds}s → ${want}`, () => expect(humanDuration(seconds)).toBe(want))
  }
})

describe('time on screen', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('ages from a timestamp, a dash without one', () => {
    expect(formatAge('2026-10-07T08:00:00Z')).toBe('3d4h')
    expect(formatAge('2026-10-10T11:58:30Z')).toBe('90s')
    expect(formatAge(undefined)).toBe('-')
    expect(formatAge('not a time')).toBe('-')
    expect(formatAge('0001-01-01T00:00:00Z')).toBe('-')
    expect(ageSeconds('2026-10-10T11:00:00Z')).toBe(3600)
    expect(ageSeconds(null)).toBe(0)
  })

  it('writes an absolute time as YYYY-MM-DD HH:mm:ss in the local zone, UTC in the tooltip', () => {
    const local = new Date(2026, 9, 8, 22, 15, 57)
    expect(formatTime(local)).toBe('2026-10-08 22:15:57')
    expect(formatDate(local)).toBe('2026-10-08')
    expect(formatTime('')).toBe('-')
    expect(utcTitle('2026-10-05T04:34:48Z')).toBe('2026-10-05T04:34:48Z')
    expect(utcTitle('2026-10-10T13:04:16.363Z')).toBe('2026-10-10T13:04:16Z')
    expect(utcTitle(undefined)).toBeUndefined()
    expect(absoluteTitle(local)).toBe(`2026-10-08 22:15:57 · ${utcTitle(local)}`)
    expect(absoluteTitle(null)).toBeUndefined()
  })

  it('reads a typed date and date-time, rejecting what is not a real one', () => {
    expect(parseTypedTime('2026-10-08')?.getTime()).toBe(new Date(2026, 9, 8).getTime())
    expect(parseTypedTime('2026-10-08 09:30', true)?.getTime()).toBe(new Date(2026, 9, 8, 9, 30).getTime())
    expect(parseTypedTime('2026-02-31')).toBeNull()
    expect(parseTypedTime('10/08/2026')).toBeNull()
    expect(parseTypedTime('2026-10-08 25:00', true)).toBeNull()
    expect(parseTypedTime('2026-10-08', true)).toBeNull()
  })
})
