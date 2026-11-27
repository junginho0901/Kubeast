import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ServiceInfo from './ServiceInfo'

// A load balancer's status can name an IP and a hostname at once: the row shows what the object has.

vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
vi.mock('@/hooks/usePrometheusQuery', () => ({
  usePrometheusQueries: () => ({ available: false, data: {} }),
  useServiceBackendUsage: () => ({ data: undefined, available: false, failure: null }),
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

// Endpoints the describe answer could not read are the reason, not 0 Ready and no addresses.
describe('the endpoints of a Service', () => {
  const html = (describe: Record<string, unknown>) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
    qc.setQueryData(['service-describe', 'ns', 'web'], describe)
    return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc },
      createElement(ServiceInfo, { name: 'web', namespace: 'ns', rawJson: {} }))))
  }
  const why = 'endpointslices.discovery.k8s.io is forbidden: User &quot;u&quot; cannot list resource'

  it('say why they could not be read', () => {
    const out = html({ endpoints_error: 'endpointslices.discovery.k8s.io is forbidden: User "u" cannot list resource' })
    expect(out).toContain('data-testid="service-endpoints-failed"')
    expect(out).toContain(why)
    expect(out).not.toContain('service-ready-addresses')
    expect(out).not.toContain('service-not-ready-addresses')
  })

  it('are counted when they were read', () => {
    const out = html({ endpoint_summary: { ready_count: 2, not_ready_count: 1, ready_addresses: ['10.0.0.1', '10.0.0.2'], not_ready_addresses: ['10.0.0.3'] }, endpoint_slices: [] })
    expect(out).toContain('data-testid="service-ready-addresses"')
    expect(out).toContain('10.0.0.3')
    expect(out).not.toContain('service-endpoints-failed')
  })
})

const drawn = (describe: Record<string, unknown>) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  qc.setQueryData(['service-describe', 'ns', 'web'], describe)
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc },
    createElement(ServiceInfo, { name: 'web', namespace: 'ns', rawJson: {} }))))
}

describe("a Service's Publish Not Ready", () => {
  const row = (describe: Record<string, unknown>) => /Publish Not Ready<\/[^>]+>\s*<[^>]+>([^<]*)</.exec(drawn(describe))?.[1] ?? 'no row'

  it('reads Yes or No, false as No and not as a missing value', () => {
    expect(row({ publish_not_ready_addresses: true })).toBe('Yes')
    expect(row({ publish_not_ready_addresses: false })).toBe('No')
  })

  it('reads - when the answer has no value', () => {
    expect(row({})).toBe('-')
    expect(row({ publish_not_ready_addresses: null })).toBe('-')
  })
})

describe("a Service's ports and conditions", () => {
  it('are drawn whole, each table marked as bounded by the one Service', () => {
    const ports = Array.from({ length: 12 }, (_, i) => ({ name: `p${i}`, protocol: 'TCP', port: 8000 + i, target_port: `${9000 + i}` }))
    const out = drawn({ ports, conditions: [{ type: 'Ready', status: 'True' }] })
    expect(out.match(/<td class="py-2 pr-2 font-mono">80\d\d<\/td>/g)).toHaveLength(12)
    expect(out).toContain('data-list-bounded="ports of one Service"')
    expect(out).toContain('data-list-bounded="conditions of one object, one per type"')
  })
})
