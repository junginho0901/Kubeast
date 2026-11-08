import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ServiceInfo from './ServiceInfo'
import ServiceDetail from './network-info/ServiceDetail'

// A load balancer's status can name an IP and a hostname at once: the row shows what the object has.

vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
vi.mock('@/hooks/usePrometheusQuery', () => ({
  usePrometheusQueries: () => ({ available: false, data: {} }),
  useClusterFeatures: () => ({ data: undefined }),
}))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', ns: ['translation', 'detail'], defaultNS: 'translation',
    resources: { en: { translation: en, detail: {} } }, interpolation: { escapeValue: false },
  })
})

type Ingress = Array<{ ip?: string | null; hostname?: string | null }>

const render = (describeIngress: Ingress | null, rawIngress: Ingress = []) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  if (describeIngress) qc.setQueryData(['service-describe', 'ns', 'lb'], { load_balancer_ingress: describeIngress })
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc },
    createElement(ServiceInfo, { name: 'lb', namespace: 'ns', rawJson: { status: { loadBalancer: { ingress: rawIngress } } } }))))
  // the value after the row's label
  return /LoadBalancer<\/[^>]+>\s*<[^>]+>([^<]*)</.exec(html)?.[1] ?? 'no row'
}

describe('the Load Balancer row of the network drawer', () => {
  const row = (ingress: Ingress) => {
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n },
      createElement(ServiceDetail, { name: 'lb', namespace: 'ns', rawJson: { status: { loadBalancer: { ingress } } } })))
    return /Load Balancer<\/[^>]+>\s*<[^>]+>([^<]*)</.exec(html)?.[1] ?? 'no row'
  }

  it('shows what the status has, as the Service drawer does', () => {
    expect(row([{ ip: '203.0.113.5', hostname: 'a.example.com' }, { hostname: 'b.example.com' }, { ip: '203.0.113.6' }]))
      .toBe('203.0.113.5 (a.example.com), b.example.com, 203.0.113.6')
  })
})

describe('the LoadBalancer row of a Service', () => {
  it('shows the IP and the hostname when the status has both', () => {
    expect(render([{ ip: '203.0.113.5', hostname: 'lb.example.com' }])).toBe('203.0.113.5 (lb.example.com)')
  })

  it('shows what each entry has, in the order of the status', () => {
    expect(render([{ ip: '203.0.113.5', hostname: 'a.example.com' }, { hostname: 'b.example.com' }, { ip: '203.0.113.6' }]))
      .toBe('203.0.113.5 (a.example.com), b.example.com, 203.0.113.6')
  })

  it('reads the list row as well until the details answer', () => {
    expect(render(null, [{ ip: '203.0.113.5', hostname: 'lb.example.com' }])).toBe('203.0.113.5 (lb.example.com)')
  })

  it('shows - with no address', () => {
    expect(render([])).toBe('-')
    expect(render([{ ip: null, hostname: null }])).toBe('-')
  })
})
