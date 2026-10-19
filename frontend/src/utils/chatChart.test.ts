import { describe, expect, it } from 'vitest'
import { chartsOf, extent, formatTimeTick, formatValue, nearest, niceTicks, type ChatChartData } from './chatChart'

const chart = (label = 'pod=web'): ChatChartData => ({ title: `t ${label}`, unit: '', promql: 'x', series: [{ label, points: [[0, 1], [60, 2]] }] })

describe('chartsOf', () => {
  it('keeps tool calls that carry a chart with points, in order', () => {
    const calls = [{ function: 'issues' }, { function: 'prometheus_query', chart: chart('a') }, null, { chart: { series: [] } }, { chart: chart('b') }]
    expect(chartsOf(calls).map((c) => c.series[0].label)).toEqual(['a', 'b'])
    expect(chartsOf(undefined)).toEqual([])
  })

  it('keeps only the last of charts the AI redid under one title', () => {
    const first = { ...chart('first try'), title: 'Memory' }
    const redo = { ...chart('redo'), title: 'Memory' }
    const cpu = { ...chart('cpu'), title: 'CPU' }
    expect(chartsOf([{ chart: first }, { chart: cpu }, { chart: redo }]).map((c) => c.series[0].label)).toEqual(['cpu', 'redo'])
  })
})

describe('scales', () => {
  it('starts the value axis at zero and gives a flat line room', () => {
    expect(extent([{ label: 'a', points: [[10, 5], [20, 7]] }])).toEqual({ t0: 10, t1: 20, v0: 0, v1: 7 })
    expect(extent([{ label: 'a', points: [[10, 0], [10, 0]] }])).toEqual({ t0: 10, t1: 11, v0: 0, v1: 1 })
    expect(extent([{ label: 'a', points: [[0, -3], [1, 2]] }]).v0).toBe(-3)
    expect(extent([])).toEqual({ t0: 0, t1: 1, v0: 0, v1: 1 })
  })

  it('picks round ticks', () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 25, 50, 75, 100])
    expect(niceTicks(0, 7, 4)).toEqual([0, 2, 4, 6])
    expect(niceTicks(0, 0.03, 3)).toEqual([0, 0.01, 0.02, 0.03])
    expect(niceTicks(5, 5)).toEqual([5])
  })

  it('finds the nearest point', () => {
    const pts: [number, number][] = [[0, 1], [60, 2], [120, 3]]
    expect(nearest(pts, 29)).toEqual([0, 1])
    expect(nearest(pts, 31)).toEqual([60, 2])
    expect(nearest(pts, 500)).toEqual([120, 3])
    expect(nearest([], 1)).toBeNull()
  })
})

describe('formatValue', () => {
  it('writes each unit the way people read it', () => {
    expect(formatValue(925_000_000, 'bytes')).toBe('882 MiB')
    expect(formatValue(512, 'bytes')).toBe('512 B')
    expect(formatValue(12.345, 'percent')).toBe('12.3%')
    expect(formatValue(0.25, 'cores')).toBe('250m')
    expect(formatValue(2, 'cores')).toBe('2')
    expect(formatValue(0.042, 'seconds')).toBe('42 ms')
    expect(formatValue(3.5, 'rate')).toBe('3.5/s')
    expect(formatValue(15_300, '')).toBe('15.3k')
    expect(formatValue(Number.NaN, 'bytes')).toBe('-')
  })

  it('writes time ticks with the date only across days', () => {
    const t = new Date(2026, 9, 19, 9, 5).getTime() / 1000
    expect(formatTimeTick(t, 3600)).toBe('09:05')
    expect(formatTimeTick(t, 3 * 86400)).toBe('10-19 09:05')
  })
})
