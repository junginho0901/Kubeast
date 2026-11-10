import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { MetricCard } from './PrometheusMetrics'

// A card's number: a count (pods, restarts) as a whole number, a percent rounded, anything else to one decimal.
const shown = (props: Parameters<typeof MetricCard>[0]) =>
  renderToStaticMarkup(createElement(MetricCard, props)).match(/text-lg font-semibold">([^<]*)</)?.[1]

describe('MetricCard', () => {
  it('reads a count as a whole number', () => {
    expect(shown({ label: 'Total Restarts', value: 0, unit: '', whole: true })).toBe('0')
    expect(shown({ label: 'Pods', value: 3, unit: '', whole: true })).toBe('3')
  })

  it('keeps a decimal for a value that has one', () => {
    expect(shown({ label: 'Load (1m)', value: 0.52, unit: '' })).toBe('0.5')
    expect(shown({ label: 'Total CPU', value: 12, unit: 'm' })).toBe('12.0m')
  })

  it('rounds a percent', () => {
    expect(shown({ label: 'CPU Usage', value: 41.6 })).toBe('42%')
  })
})
