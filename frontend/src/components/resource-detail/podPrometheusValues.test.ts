import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '../../i18n/locales/en.json'
import { PageContextProvider } from '@/components/PageContextProvider'
import PodInfo from './PodInfo'

// The Pod drawer's Real-time Resource Usage, with what the cluster's Prometheus answered for each container.
const prom = vi.hoisted(() => ({ data: {} as Record<string, unknown> }))
vi.mock('@/hooks/usePrometheusQuery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/usePrometheusQuery')>()),
  usePrometheusQueries: () => ({ data: prom.data, isLoading: false, available: true, failure: null }),
}))

const MiB = 1024 * 1024

describe('the Pod drawer\'s container usage', () => {
  const i18n = i18next.createInstance()
  beforeAll(async () => {
    await i18n.use(initReactI18next).init({ lng: 'en', ns: ['translation', 'detail'], defaultNS: 'translation', resources: { en: { translation: en, detail: {} } }, interpolation: { escapeValue: false } })
  })
  // each container's bars as "<label> | <value>"
  const bars = (cpu: unknown[], memory: unknown[]) => {
    prom.data = { cpu: { available: true, results: cpu }, memory: { available: true, results: memory } }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(['pod-describe', 'ns', 'p'], { phase: 'Running', status: 'Running', ready: '3/3', containers: [{ name: 'app' }, { name: 'side' }, { name: 'quiet' }] })
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc },
      createElement(MemoryRouter, null, createElement(PageContextProvider, null, createElement(PodInfo, { name: 'p', namespace: 'ns' }))))))
    const usage = html.slice(html.indexOf('Real-time Resource Usage'))
    return [...usage.matchAll(/<span class="text-slate-400">([^<]*)<\/span><span class="font-mono text-slate-300">([^<]*)<\/span>/g)].map((m) => `${m[1]} | ${m[2]}`)
  }

  // A value Prometheus answered as NaN or ±Inf comes as null: its bar reads "-", never 0, and a container with no
  // series has no bar
  it('reads a value that is not a number as "-" and draws no bar for a container without a series', () => {
    expect(bars(
      [{ metric: { container: 'app' }, value: 250 }, { metric: { container: 'side' }, value: null }],
      [{ metric: { container: 'app' }, value: null }, { metric: { container: 'side' }, value: 64 * MiB }],
    )).toEqual([
      'CPU 250m | 25%',
      'Memory - | -',
      'CPU - | -',
      'Memory 64 MiB | 13%',
    ])
  })
})
