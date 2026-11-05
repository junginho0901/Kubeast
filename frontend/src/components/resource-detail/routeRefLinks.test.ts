import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '../../i18n/locales/en.json'
import type { CRDInfo } from '@/services/api/types'
import { PageContextCtx, type PageContextValue } from '@/components/PageContext'
import { apiParam, toParam } from '../detailParam'
import { compareKubeAwareVersions, customResourceTarget, detailTarget, referenceApiVersion, referenceNeedsVersion } from './crDetail'
import { backendRefGroup, parentRefGroup } from './gatewayDetail'
import { GroupRefLink } from './GroupRefLink'
import HTTPRouteInfo from './HTTPRouteInfo'
import GRPCRouteInfo from './GRPCRouteInfo'

// HTTPRoute and GRPCRoute references name a group and a Kind but no version (Gateway API v1 ParentReference and
// BackendObjectReference): a link to a Kind two groups serve (the number check's Widget of refs-a and refs-b, both named
// rw) opens each group's object at the version its CRD prefers; Gateway and Service links stay as they were.

// the links drawn in the drawers, as attributes the markup keeps
vi.mock('./ResourceLink', async () => {
  const { createElement: h } = await import('react')
  return {
    ResourceLink: (p: { kind: string; name: string; namespace?: string; apiVersion?: string }) =>
      h('button', { 'data-link': `${p.kind}|${p.name}|${p.namespace ?? ''}|${p.apiVersion ?? ''}` }, p.name),
  }
})

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', ns: ['translation', 'detail'], defaultNS: 'translation',
    resources: { en: { translation: en, detail: {} } }, interpolation: { escapeValue: false },
  })
})

const crd = (name: string, kind: string, served: string[], storage = served[0]): CRDInfo => ({
  name, kind, version: storage, served_versions: served, group: name.slice(name.indexOf('.') + 1), scope: 'Namespaced',
})
const CRDS: CRDInfo[] = [
  crd('widgets.refs-a.kubeast.io', 'Widget', ['v1']),
  crd('widgets.refs-b.kubeast.io', 'Widget', ['v1', 'v1alpha1', 'v1beta1', 'v2alpha1'], 'v1beta1'),
  crd('xlistenersets.gateway.networking.x-k8s.io', 'XListenerSet', ['v1alpha1']),
  crd('gateways.gateway.networking.k8s.io', 'Gateway', ['v1', 'v1beta1']),
  crd('olds.refs-c.kubeast.io', 'Old', []),
]
const NS = 'e2e-route-refs'

describe('the version a reference by group opens', () => {
  it('discovery\'s order: GA, beta, alpha, higher first; other names after them', () => {
    expect(['v1alpha1', 'v2', 'foo', 'v1beta2', 'v1', 'v10', 'v1beta1', 'bar'].sort((a, b) => compareKubeAwareVersions(b, a)))
      .toEqual(['v10', 'v2', 'v1', 'v1beta2', 'v1beta1', 'v1alpha1', 'bar', 'foo'])
  })

  it('a Kind of a group a CRD serves: that group at the CRD\'s first version by that order', () => {
    expect(referenceApiVersion('refs-a.kubeast.io', 'Widget', CRDS)).toBe('refs-a.kubeast.io/v1')
    expect(referenceApiVersion('refs-b.kubeast.io', 'Widget', CRDS)).toBe('refs-b.kubeast.io/v1')
    expect(referenceApiVersion('gateway.networking.x-k8s.io', 'XListenerSet', CRDS)).toBe('gateway.networking.x-k8s.io/v1alpha1')
  })

  it('the CRD list is read for a group other than the core group and the Kind\'s own drawer\'s', () => {
    expect(referenceNeedsVersion('refs-a.kubeast.io', 'Widget')).toBe(true)
    expect(referenceNeedsVersion('gateway.networking.x-k8s.io', 'XListenerSet')).toBe(true)
    expect(referenceNeedsVersion('', 'Service')).toBe(false)
    expect(referenceNeedsVersion('gateway.networking.k8s.io', 'Gateway')).toBe(false)
  })

  it('none — the link opens by Kind as before — for the core group, a Kind\'s own drawer, no such CRD, no version served or the list not read yet', () => {
    expect(referenceApiVersion('', 'Service', CRDS)).toBeUndefined()
    expect(referenceApiVersion('gateway.networking.k8s.io', 'Gateway', CRDS)).toBeUndefined()
    expect(referenceApiVersion('refs-z.kubeast.io', 'Widget', CRDS)).toBeUndefined()
    expect(referenceApiVersion('refs-c.kubeast.io', 'Old', CRDS)).toBeUndefined()
    expect(referenceApiVersion('refs-a.kubeast.io', 'Widget', undefined)).toBeUndefined()
  })

  it('a reference without a group: a parentRef\'s is Gateway API\'s, a backendRef\'s the core group; "" is the core group', () => {
    expect([parentRefGroup({}), parentRefGroup({ group: '' }), parentRefGroup({ group: 'refs-a.kubeast.io' })]).toEqual(['gateway.networking.k8s.io', '', 'refs-a.kubeast.io'])
    expect([backendRefGroup({}), backendRefGroup({ group: '' }), backendRefGroup({ group: 'refs-b.kubeast.io' })]).toEqual(['', '', 'refs-b.kubeast.io'])
  })
})

// a client holding what the drawer reads: the CRD list (when given) and a describe answer
function client(crds?: CRDInfo[], describe?: [string[], unknown]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['clusters-accessible'], [])
  if (crds) qc.setQueryData(['custom-resources', 'crds'], crds)
  if (describe) qc.setQueryData(describe[0], describe[1])
  return qc
}

describe('GroupRefLink', () => {
  // the ResourceLink it draws, rendered with the client
  const linkOf = (props: { group: string; kind: string; name: string; namespace?: string }, crds?: CRDInfo[]) => {
    let el: ReactElement<{ kind: string; name: string; namespace?: string; apiVersion?: string }> | null = null
    const Grab = () => {
      el = GroupRefLink(props) as typeof el
      return null
    }
    renderToStaticMarkup(createElement(QueryClientProvider, { client: client(crds) }, createElement(Grab)))
    return el!.props
  }
  // what the drawer opens from the link once it has read the CRD list
  const opened = (p: { kind: string; name: string; namespace?: string; apiVersion?: string }) => {
    const t = customResourceTarget(detailTarget(p.kind, p.name, p.namespace, p.apiVersion), CRDS)
    return { detail: toParam(t), detailApi: apiParam(t) || undefined, crd: t.rawJson?.crd_name }
  }

  it('each group\'s Widget with its own CRD, the same link before and after', () => {
    for (const g of ['refs-a.kubeast.io', 'refs-b.kubeast.io']) {
      const p = linkOf({ group: g, kind: 'Widget', name: 'rw', namespace: NS }, CRDS)
      expect(opened(p), g).toEqual({ detail: `Widget/${NS}/rw`, detailApi: `${g}/v1/widgets`, crd: `widgets.${g}` })
      expect({ kind: p.kind, name: p.name, namespace: p.namespace }).toEqual({ kind: 'Widget', name: 'rw', namespace: NS })
    }
  })

  it('by Kind as before while the CRD list has not come, and for Service and Gateway', () => {
    expect(linkOf({ group: 'refs-a.kubeast.io', kind: 'Widget', name: 'rw', namespace: NS }).apiVersion).toBeUndefined()
    expect(opened(linkOf({ group: '', kind: 'Service', name: 'svc', namespace: NS }, CRDS))).toEqual({ detail: `Service/${NS}/svc`, detailApi: undefined, crd: undefined })
    expect(opened(linkOf({ group: 'gateway.networking.k8s.io', kind: 'Gateway', name: 'gw', namespace: NS }, CRDS))).toEqual({ detail: `Gateway/${NS}/gw`, detailApi: undefined, crd: undefined })
  })
})

describe('HTTPRoute and GRPCRoute drawers', () => {
  const parentRefs = [
    { group: 'gateway.networking.k8s.io', kind: 'Gateway', name: 'gw' },
    { group: 'refs-a.kubeast.io', kind: 'Widget', name: 'rw', sectionName: 'a' },
    { group: 'refs-b.kubeast.io', kind: 'Widget', name: 'rw', namespace: 'other', sectionName: 'b' },
    { name: 'plain' },
  ]
  const backendRefs = [
    { group: '', kind: 'Service', name: 'svc', port: 80 },
    { group: 'refs-a.kubeast.io', kind: 'Widget', name: 'rw' },
    { group: 'refs-b.kubeast.io', kind: 'Widget', name: 'rw' },
    { name: 'bare', port: 8080 },
  ]
  const describe_ = { name: 'r', namespace: NS, parent_refs: parentRefs, rules: [{ backendRefs }] }
  const links = (html: string) => [...html.matchAll(/data-link="([^"]*)"/g)].map((m) => m[1])
  const want = [
    `Gateway|gw|${NS}|`, `Widget|rw|${NS}|refs-a.kubeast.io/v1`, 'Widget|rw|other|refs-b.kubeast.io/v1', `Gateway|plain|${NS}|`,
    `Service|svc|${NS}|`, `Widget|rw|${NS}|refs-a.kubeast.io/v1`, `Widget|rw|${NS}|refs-b.kubeast.io/v1`, `Service|bare|${NS}|`,
  ]
  const page = { registerLayer: () => {}, unregisterLayer: () => {}, getSnapshot: () => ({}), consumeContextChanged: () => false } as unknown as PageContextValue
  const render = (component: typeof HTTPRouteInfo, key: string, crds?: CRDInfo[]) =>
    renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: client(crds, [[key, NS, 'r'], describe_]) },
      createElement(PageContextCtx.Provider, { value: page }, createElement(component, { name: 'r', namespace: NS })))))

  it('each link passes its reference\'s group at the version its CRD prefers; Gateway and Service links as before', () => {
    expect(links(render(HTTPRouteInfo, 'httproute-describe', CRDS))).toEqual(want)
    expect(links(render(GRPCRouteInfo, 'grpcroute-describe', CRDS))).toEqual(want)
  })

  it('the same links, by Kind, until the CRD list has come', () => {
    const byKind = want.map((l) => l.replace(/\|[^|]*$/, '|'))
    expect(links(render(HTTPRouteInfo, 'httproute-describe'))).toEqual(byKind)
    expect(links(render(GRPCRouteInfo, 'grpcroute-describe'))).toEqual(byKind)
  })
})
