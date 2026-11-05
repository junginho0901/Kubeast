import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '../i18n/locales/en.json'
import { PageContextCtx, type PageContextValue } from '@/components/PageContext'
import { useCanI, type AccessTarget } from './useCanCreate'
import Endpoints from '@/pages/network/Endpoints'
import EndpointSlices from '@/pages/network/EndpointSlices'
import ResourceQuotas from '@/pages/cluster/ResourceQuotas'
import LimitRanges from '@/pages/cluster/LimitRanges'

// A create or delete button shows when the app permission holds and the cluster says yes for the signed-in user
// (SelfSubjectAccessReview): hidden without the permission, hidden while the cluster is asked and when it says no,
// and the app permission alone decides when the cluster cannot be asked.

const granted = new Set<string>()
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: (p: string) => granted.has(p) }) }))
const canI = vi.fn(async (_q: unknown) => true)
vi.mock('@/services/api', async (original) => {
  const real = await original<typeof import('@/services/api')>()
  return { ...real, api: { ...real.api, canI: (q: unknown) => canI(q) } }
})

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  granted.clear()
  canI.mockClear()
})

type Answer = boolean | 'failed' | 'asking'
// the client with the cluster's answer for one question (a refused or failed SelfSubjectAccessReview is an error)
function client(key: unknown[], answer: Answer): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  if (answer === 'failed') {
    const q = qc.getQueryCache().build(qc, { queryKey: key })
    q.setState({ ...q.state, status: 'error', error: Object.assign(new Error('HTTP 500'), { response: { status: 500 } }), errorUpdatedAt: Date.now(), errorUpdateCount: 1 })
  } else if (answer !== 'asking') qc.setQueryData(key, answer)
  return qc
}
const page = { registerLayer: () => {}, unregisterLayer: () => {}, getSnapshot: () => ({}), consumeContextChanged: () => false } as unknown as PageContextValue
const render = (qc: QueryClient, el: ReturnType<typeof createElement>, url = '/') =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] },
    createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc }, createElement(PageContextCtx.Provider, { value: page }, el)))))

function Probe({ verb, target }: { verb: string; target?: AccessTarget }) {
  return createElement('b', null, String(useCanI('resource.configmap.delete', verb, target)))
}
// null: a button with nothing to ask the cluster about
const shows = (answer: Answer, target: AccessTarget | null = { group: '', resource: 'configmaps', namespace: 'ns-a', name: 'cm' }, key: unknown[] = ['can-i', '', 'delete', '', 'configmaps', 'ns-a', 'cm']) =>
  render(client(key, answer), createElement(Probe, { verb: 'delete', target: target ?? undefined })).replace(/<\/?b>/g, '')

describe('useCanI: the app permission and the cluster\'s answer', () => {
  it('shown when both say yes', () => {
    granted.add('resource.configmap.delete')
    expect(shows(true)).toBe('true')
  })

  it('hidden when the cluster says no, though the app permission holds', () => {
    granted.add('resource.configmap.delete')
    expect(shows(false)).toBe('false')
  })

  it('hidden without the app permission, whatever the cluster says', () => {
    expect(shows(true)).toBe('false')
  })

  it('hidden while the cluster is asked (no answer yet)', () => {
    granted.add('resource.configmap.delete')
    expect(shows('asking')).toBe('false')
  })

  it('the app permission decides when the cluster cannot be asked', () => {
    granted.add('resource.configmap.delete')
    expect(shows('failed')).toBe('true')
  })

  it('the app permission decides for a button with nothing to ask about', () => {
    granted.add('resource.configmap.delete')
    expect(shows(false, null)).toBe('true')
  })

  it('asks about the object: verb, group, resource, its namespace and its name', async () => {
    granted.add('resource.configmap.delete')
    const qc = client([], 'asking')
    render(qc, createElement(Probe, { verb: 'delete', target: { group: '', resource: 'configmaps', namespace: 'ns-a', name: 'cm' } }))
    const query = qc.getQueryCache().find({ queryKey: ['can-i', '', 'delete', '', 'configmaps', 'ns-a', 'cm'] })
    expect(query, 'the question kept per verb, resource, namespace and name').toBeTruthy()
    await query!.fetch()
    expect(canI).toHaveBeenCalledWith({ verb: 'delete', group: '', resource: 'configmaps', namespace: 'ns-a', name: 'cm' })
  })

  it('a list\'s "all" asks about every namespace; an object in a namespace called "all" keeps it', async () => {
    granted.add('resource.configmap.delete')
    const qc = client([], 'asking')
    render(qc, createElement('div', null,
      createElement(Probe, { verb: 'create', target: { group: '', resource: 'configmaps', namespace: 'all' } }),
      createElement(Probe, { verb: 'delete', target: { group: '', resource: 'configmaps', namespace: 'all', name: 'cm' } })))
    const keys = qc.getQueryCache().getAll().map((q) => q.queryKey)
    expect(keys).toEqual([['can-i', '', 'create', '', 'configmaps', '', ''], ['can-i', '', 'delete', '', 'configmaps', 'all', 'cm']])
  })
})

// The list pages whose kind the Write role's edit cannot create: the create button follows the cluster's answer.
const PAGES: [string, ComponentType, string, string, string][] = [
  ['Endpoints', Endpoints, 'resource.endpoints.create', '', 'endpoints'],
  ['EndpointSlices', EndpointSlices, 'resource.endpointslice.create', 'discovery.k8s.io', 'endpointslices'],
  ['ResourceQuotas', ResourceQuotas, 'resource.resourcequota.create', '', 'resourcequotas'],
  ['LimitRanges', LimitRanges, 'resource.limitrange.create', '', 'limitranges'],
]
const LABELS: Record<string, string> = {
  Endpoints: en.endpointsPage.create, EndpointSlices: en.endpointSlicesPage.create, ResourceQuotas: en.resourceQuotas.create, LimitRanges: en.limitRanges.create,
}
const createButtons = (html: string, label: string) => html.split(`>${label}</button>`).length - 1

describe('the create buttons of Endpoints, EndpointSlices, ResourceQuotas and LimitRanges', () => {
  for (const [name, Page, perm, group, resource] of PAGES) {
    const key = ['can-i', '', 'create', group, resource, 'ns-a', '']
    const draw = (answer: Answer) => createButtons(render(client(key, answer), createElement(Page), '/?namespace=ns-a'), LABELS[name])

    it(`${name}: shown when the cluster lets the user create ${resource} in the namespace, hidden when it does not`, () => {
      granted.add(perm)
      expect(draw(true), 'cluster yes').toBe(1)
      expect(draw(false), 'cluster no').toBe(0)
      expect(draw('asking'), 'while asked').toBe(0)
      expect(draw('failed'), 'cannot ask: the app permission').toBe(1)
    })

    it(`${name}: hidden without ${perm}`, () => {
      expect(draw(true)).toBe(0)
    })
  }
})
