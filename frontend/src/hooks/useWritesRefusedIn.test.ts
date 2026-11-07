import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '../i18n/locales/en.json'
import { PageContextCtx, type PageContextValue } from '@/components/PageContext'
import { useWritesRefusedIn } from './useCanCreate'
import Leases from '@/pages/cluster/Leases'
import ConfigMaps from '@/pages/configuration/ConfigMaps'
import Secrets from '@/pages/configuration/Secrets'
import ResourceClaimTemplates from '@/pages/gpu/ResourceClaimTemplates'
import ResourceClaims from '@/pages/gpu/ResourceClaims'
import Ingresses from '@/pages/network/Ingresses'
import NetworkPolicies from '@/pages/network/NetworkPolicies'
import Services from '@/pages/network/Services'
import ServiceAccounts from '@/pages/security/ServiceAccounts'
import PersistentVolumeClaims from '@/pages/storage/PersistentVolumeClaims'
import CronJobs from '@/pages/workloads/CronJobs'
import DaemonSets from '@/pages/workloads/DaemonSets'
import Deployments from '@/pages/workloads/Deployments'
import HPAs from '@/pages/workloads/HPAs'
import Jobs from '@/pages/workloads/Jobs'
import PDBs from '@/pages/workloads/PDBs'
import Pods from '@/pages/workloads/Pods'
import ReplicaSets from '@/pages/workloads/ReplicaSets'
import StatefulSets from '@/pages/workloads/StatefulSets'

// A list's create button is hidden where the server would refuse the write. The answer is the features one every
// screen already holds: the page asks nothing of its own.

vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => true, clusterNamespaces: null, namespacesOn: () => null }) }))
vi.mock('@/services/listStatusStore', async (original) => {
  const real = await original<typeof import('@/services/listStatusStore')>()
  return { ...real, useKindServed: () => true }
})

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false },
  })
})

const page = { registerLayer: () => {}, unregisterLayer: () => {}, getSnapshot: () => ({}), consumeContextChanged: () => false } as unknown as PageContextValue

function client(guarded?: string[]): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  qc.setQueryData(['cluster-features', ''], { prometheus: { enabled: true }, ...(guarded ? { writeGuardedNamespaces: guarded } : {}) })
  return qc
}
const render = (qc: QueryClient, el: ReturnType<typeof createElement>, url: string) =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] },
    createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc }, createElement(PageContextCtx.Provider, { value: page }, el)))))

function Probe({ namespace }: { namespace?: string }) {
  return createElement('b', null, String(useWritesRefusedIn()(namespace)))
}
const refused = (guarded: string[] | undefined, namespace?: string) =>
  render(client(guarded), createElement(Probe, { namespace }), '/').replace(/<\/?b>/g, '')

describe('useWritesRefusedIn', () => {
  it('is true in a namespace the server names', () => {
    expect(refused(['kubeast', 'kubeast-node-shell'], 'kubeast')).toBe('true')
    expect(refused(['kubeast', 'kubeast-node-shell'], 'kubeast-node-shell')).toBe('true')
  })

  it('is false elsewhere, on the list of every namespace, and without an answer', () => {
    expect(refused(['kubeast'], 'shop')).toBe('false')
    expect(refused(['kubeast'], 'all')).toBe('false')
    expect(refused(['kubeast'], undefined)).toBe('false')
    expect(refused(undefined, 'kubeast')).toBe('false')
    expect(refused([], 'kubeast')).toBe('false')
  })
})

const PAGES: [string, ComponentType][] = [
  ['Leases', Leases], ['ConfigMaps', ConfigMaps], ['Secrets', Secrets], ['ResourceClaimTemplates', ResourceClaimTemplates], ['ResourceClaims', ResourceClaims],
  ['Ingresses', Ingresses], ['NetworkPolicies', NetworkPolicies], ['Services', Services], ['ServiceAccounts', ServiceAccounts], ['PersistentVolumeClaims', PersistentVolumeClaims],
  ['CronJobs', CronJobs], ['DaemonSets', DaemonSets], ['Deployments', Deployments], ['HPAs', HPAs], ['Jobs', Jobs], ['PDBs', PDBs], ['Pods', Pods], ['ReplicaSets', ReplicaSets], ['StatefulSets', StatefulSets],
]
const primaryButtons = (html: string) => html.split('btn-primary').length - 1

describe('the create button of a list whose kind the Write role can create', () => {
  for (const [name, Page] of PAGES) {
    const draw = (guarded: string[] | undefined, url: string) => primaryButtons(render(client(guarded), createElement(Page), url))

    it(`${name}: gone in a namespace that refuses the write, there anywhere else`, () => {
      const elsewhere = draw(['kubeast'], '/?namespace=shop')
      expect(draw(['kubeast'], '/?namespace=kubeast')).toBe(elsewhere - 1)
      expect(draw(['kubeast'], '/')).toBe(elsewhere)
      expect(draw(undefined, '/?namespace=kubeast')).toBe(elsewhere)
    })
  }

  it('asks the cluster nothing for it', () => {
    for (const [name, Page] of PAGES) {
      const qc = client(['kubeast'])
      render(qc, createElement(Page), '/?namespace=shop')
      expect(qc.getQueryCache().getAll().filter((q) => q.queryKey[0] === 'can-i').map((q) => q.queryKey), name).toEqual([])
    }
  })
})
