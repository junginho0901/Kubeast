import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '../../i18n/locales/en.json'
import { PrometheusClusterMetrics } from './PrometheusClusterMetrics'
import { podsShown } from './podsShown'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

describe("the dashboard's Pods slot", () => {
  it('is the pods counted of the pods the nodes can take, as a bar', () => {
    expect(podsShown(35, 330)).toEqual({ text: '35 / 330', percent: (35 / 330) * 100 })
    expect(podsShown(34.6, 110.2)?.text).toBe('35 / 110')
  })

  it('is the count alone when the capacity is not answered, and nothing without a count', () => {
    expect(podsShown(35, null)).toEqual({ text: '35', percent: null })
    expect(podsShown(35, 0)).toEqual({ text: '35', percent: null })
    expect(podsShown(null, 330)).toBeNull()
  })

  it('keeps four slots: one the store does not answer is "-" with why', () => {
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n },
      createElement(PrometheusClusterMetrics, { title: 'Cluster Resource Utilization', cpu: 12, memory: 40, disk: null, podCount: 35, podCapacity: 330 })))
    for (const id of ['cpu', 'memory', 'disk', 'pods']) expect(html).toContain(`data-testid="cluster-metric-${id}"`)
    expect(html).toContain('No Disk data from Prometheus')
    expect(html).toContain('35 / 330')
    expect(html).toContain('>12%<')
  })
})
