import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import { MetricBar, MetricCard } from './PrometheusMetrics'
import serviceSource from './ServiceInfo.tsx?raw'
import namespaceSource from './NamespaceInfo.tsx?raw'

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

  it('colours a value past its thresholds, and a count that is no state not at all', () => {
    const colour = (props: Parameters<typeof MetricCard>[0]) =>
      /^<div class="[^"]*\b(text-red-400|text-amber-400|text-ink)"/.exec(renderToStaticMarkup(createElement(MetricCard, props)))?.[1]
    expect(colour({ label: 'Total CPU', value: 1200, unit: 'm', thresholds: { warn: 500, danger: 1000 } })).toBe('text-red-400')
    expect(colour({ label: 'Total CPU', value: 600, unit: 'm', thresholds: { warn: 500, danger: 1000 } })).toBe('text-amber-400')
    expect(colour({ label: 'CPU Usage', value: 85 })).toBe('text-red-400')
    expect(colour({ label: 'Backing Pods', value: 250, unit: '', whole: true, thresholds: null })).toBe('text-ink')
  })

  it("is how a Service's backing pods and a Namespace's pods read", () => {
    expect(serviceSource).toContain('<MetricCard label="Backing Pods" value={getSvcMetric(\'pod_count\')!} unit="" whole thresholds={null} />')
    expect(namespaceSource).toContain('<MetricCard label="Pods" value={getNsMetricValue(\'pod_count\')!} unit="" whole thresholds={null} />')
  })
})

// A bar's number and how full it is; null is a value Prometheus answered as NaN or ±Inf.
const bar = (props: Parameters<typeof MetricBar>[0]) => {
  const html = renderToStaticMarkup(createElement(MetricBar, props))
  return { text: html.match(/font-mono text-slate-300">([^<]*)</)?.[1], width: html.match(/width:([^;"]*)/)?.[1] }
}

describe('MetricBar', () => {
  it('reads a percent rounded and fills to it', () => {
    expect(bar({ label: 'CPU 250m', value: 41.6 })).toEqual({ text: '42%', width: '41.6%' })
  })

  it('reads a value that is not a number as "-" over an empty bar', () => {
    expect(bar({ label: 'Memory -', value: null })).toEqual({ text: '-', width: '0%' })
    expect(bar({ label: 'Total', value: null, unit: ' MiB', max: 512 })).toEqual({ text: '-', width: '0%' })
  })
})
