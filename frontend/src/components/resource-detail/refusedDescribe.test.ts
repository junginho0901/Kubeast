import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider, QueryObserver, type QueryFunction } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { PageContextProvider } from '@/components/PageContextProvider'
import { queryDefaults } from '@/services/queryDefaults'
import AdmissionPolicyInfo from './AdmissionPolicyInfo'
import HPAInfo from './HPAInfo'
import LimitRangeInfo from './LimitRangeInfo'
import PDBInfo from './PDBInfo'
import PriorityClassInfo from './PriorityClassInfo'
import ResourceQuotaInfo from './ResourceQuotaInfo'
import RuntimeClassInfo from './RuntimeClassInfo'
import VPAInfo from './VPAInfo'
import WebhookConfigInfo from './WebhookConfigInfo'

// These drawers try their describe read once more after a failure. A read the cluster refused was tried again a second
// later too, so opening one on an object the person may not read sent the refused read twice.

const seen = vi.hoisted(() => ({ queries: [] as any[] }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: (options: any) => (seen.queries.push(options), actual.useQuery(options)) }
})
vi.mock('@/services/useKubeWatchList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/useKubeWatchList')>()
  return { ...actual, useKubeWatchList: () => undefined }
})

const DRAWERS: [string, ComponentType<any>, Record<string, unknown>][] = [
  ['ValidatingAdmissionPolicy', AdmissionPolicyInfo, { name: 'policy', kind: 'ValidatingAdmissionPolicy' }],
  ['HorizontalPodAutoscaler', HPAInfo, { name: 'web', namespace: 'ns' }],
  ['LimitRange', LimitRangeInfo, { name: 'limits', namespace: 'ns' }],
  ['PodDisruptionBudget', PDBInfo, { name: 'budget', namespace: 'ns' }],
  ['PriorityClass', PriorityClassInfo, { name: 'high' }],
  ['ResourceQuota', ResourceQuotaInfo, { name: 'quota', namespace: 'ns' }],
  ['RuntimeClass', RuntimeClassInfo, { name: 'gvisor' }],
  ['VerticalPodAutoscaler', VPAInfo, { name: 'web', namespace: 'ns' }],
  ['MutatingWebhookConfiguration', WebhookConfigInfo, { name: 'hooks', kind: 'MutatingWebhookConfiguration' }],
]

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } })

// the options the drawer reads its object's describe answer with
function describeOptions(Drawer: ComponentType<any>, props: Record<string, unknown>) {
  seen.queries = []
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  renderToStaticMarkup(createElement(QueryClientProvider, { client: qc },
    createElement(MemoryRouter, null, createElement(PageContextProvider, null, createElement(Drawer, props)))))
  qc.clear()
  const options = seen.queries.find((o) => String(o.queryKey?.[0] ?? '').endsWith('-describe'))
  expect(options, 'the drawer\'s describe read').toBeDefined()
  return options
}

describe.each(DRAWERS)('the %s drawer\'s describe read', (_kind, Drawer, props) => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // with the app's defaults, as main.tsx gives every query
  const opened = (queryFn: QueryFunction<unknown>) =>
    new QueryObserver(new QueryClient({ defaultOptions: { queries: queryDefaults } }), { ...describeOptions(Drawer, props), queryFn }).subscribe(() => {})

  it('refused, goes once; one that failed otherwise is tried once more', async () => {
    const refused = vi.fn(async () => { throw httpError(403) })
    const failed = vi.fn(async () => { throw httpError(503) })
    const stops = [opened(refused), opened(failed)]
    await vi.advanceTimersByTimeAsync(10_000)
    expect({ refused: refused.mock.calls.length, failed: failed.mock.calls.length }).toEqual({ refused: 1, failed: 2 })
    stops.forEach((stop) => stop())
  })
})
