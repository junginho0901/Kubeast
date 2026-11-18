import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import type { GatewayPoliciesResponse } from '@/services/api'
import Policies from './Policies'

// A policy kind the cluster refused or could not list reads "no permission" or its error on the Scanned kinds chips; the
// server sends its count as 0 beside that `error`, and the floating chat is told the same as the chips, not 0.

vi.mock('@/hooks/useAdaptiveTable', () => ({ useAdaptiveTable: () => ({ containerRef: { current: null }, bodyRef: { current: null }, theadRef: { current: null }, firstRowRef: { current: null }, rowsPerPage: 10 }) }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
type Layer = { source?: string; summary?: string; data?: Record<string, any> }
const layers: Layer[] = []
// the page's own layer; the shared notices under it register theirs beside it
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null) => { if (input && (input.source ?? 'base') === 'base') layers.push(input) } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})
beforeEach(() => { layers.length = 0 })

const kind = (k: string, group: string, more: { count: number; error?: string }) => ({ group, version: 'v1alpha1', plural: `${k.toLowerCase()}s`, kind: k, scope: 'Namespaced', source: 'builtin', ...more })
const tls = { name: 'web-tls', namespace: 'web', kind: 'BackendTLSPolicy', group: 'gateway.networking.k8s.io', version: 'v1', plural: 'backendtlspolicies', scope: 'Namespaced', source: 'label', targets: [{ kind: 'Service', name: 'web' }], accepted: true }
const TIMEOUT = 'Get "https://10.0.0.1:443/apis/gateway.envoyproxy.io/v1alpha1/clienttrafficpolicies": context deadline exceeded'

function open(answer: GatewayPoliciesResponse): { html: string; layer: Layer } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } })
  qc.setQueryData(['gateway', 'policies'], answer)
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc }, createElement(Policies)))))
  return { html, layer: layers[layers.length - 1] }
}

describe('Gateway Policies, told to the floating chat', () => {
  const answer = {
    namespace: '',
    kinds: [
      kind('BackendTLSPolicy', 'gateway.networking.k8s.io', { count: 1 }),
      kind('BackendTrafficPolicy', 'gateway.envoyproxy.io', { count: 0, error: 'forbidden' }),
      kind('ClientTrafficPolicy', 'gateway.envoyproxy.io', { count: 0, error: TIMEOUT }),
    ],
    items: [tls],
  } as unknown as GatewayPoliciesResponse

  it('names a refused kind as refused, as its chip says "no permission", not as 0', () => {
    const { html, layer } = open(answer)
    expect(html).toContain('no permission')
    expect(html).toMatch(/data-testid="policy-kind-refused"[^>]*>[^]*?BackendTrafficPolicy/)
    expect(layer.data?.forbidden_kinds).toEqual(['BackendTrafficPolicy'])
    expect(layer.data?.stats?.kinds).toContain('BackendTrafficPolicy (builtin, no permission)')
    expect(layer.data?.stats?.kinds).not.toContain('BackendTrafficPolicy (builtin, 0)')
    expect(layer.summary).toContain('볼 권한 없는 종류: BackendTrafficPolicy')
  })

  it('names a kind whose list failed with the reason its chip shows', () => {
    const { html, layer } = open(answer)
    expect(html).toContain('context deadline exceeded')
    expect(html).toMatch(/data-testid="policy-kind-failed"[^>]*>[^]*?ClientTrafficPolicy/)
    expect(layer.data?.failed_kinds).toEqual([{ kind: 'ClientTrafficPolicy', reason: TIMEOUT }])
    expect(layer.data?.stats?.kinds).toContain('ClientTrafficPolicy (builtin, not read)')
    expect(layer.summary).toContain('불러오지 못한 종류: ClientTrafficPolicy')
  })

  it('counts the kinds it read, and says nothing of refusals when there is none', () => {
    const { layer } = open({ namespace: '', kinds: [answer.kinds[0], kind('ClientTrafficPolicy', 'gateway.envoyproxy.io', { count: 0 })], items: [tls] } as unknown as GatewayPoliciesResponse)
    expect(layer.data?.stats).toEqual({ total: 1, kinds: ['BackendTLSPolicy (builtin, 1)', 'ClientTrafficPolicy (builtin, 0)'] })
    expect(layer.data?.forbidden_kinds).toBeUndefined()
    expect(layer.data?.failed_kinds).toBeUndefined()
  })
})
