import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { PodPage } from '@/services/api'
import { api } from '@/services/api'
import '@/i18n'
import { PageContextProvider } from '@/components/PageContextProvider'
import { drawerPodsKey } from '../useServerPods'
import { useOwnedWatchedResources } from './useOwnedWatchedResources'
import { useWorkloadData } from './useWorkloadData'
import WorkloadOwnedResources from './WorkloadOwnedResources'

const seen = vi.hoisted(() => ({ queries: [] as any[], watches: [] as any[], owned: [] as any[], pods: [] as string[] }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: (options: any) => (seen.queries.push(options), actual.useQuery(options)) }
})
vi.mock('@/services/useKubeWatchList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/useKubeWatchList')>()
  return { ...actual, useKubeWatchList: (options: any) => void seen.watches.push(options) }
})
vi.mock('./useOwnedWatchedResources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useOwnedWatchedResources')>()
  return { ...actual, useOwnedWatchedResources: (params: any) => (seen.owned.push(params), actual.useOwnedWatchedResources(params)) }
})

type Expression = { key: string; operator: string; values?: string[] }
const KINDS = ['Deployment', 'DaemonSet', 'StatefulSet', 'ReplicaSet', 'Job']
const filterOf = (kind: string, selector: string) => (kind === 'Deployment' ? { namespace: 'ns', label_selector: selector } : { namespace: 'ns', label_selector: selector, owner: `${kind}/web` })
const podRow = (name: string) => ({ name, namespace: 'ns', status: 'Running', phase: 'Running', ready: '1/1', restart_count: 0 })

function OwnedPods({ kind, selector, expressions }: { kind: string; selector: Record<string, string>; expressions?: Expression[] }) {
  const owned = useOwnedWatchedResources({ kind, namespace: 'ns', name: 'web', selector, selectorExpressions: expressions })
  // what the window and the floating chat get as the workload's pods (a Deployment's window shows its ReplicaSets)
  seen.pods = owned.pods.map((p) => p.name)
  return createElement(WorkloadOwnedResources, {
    namespace: 'ns', owned, isCronJob: false, isDaemonSet: kind === 'DaemonSet', isDeployment: kind === 'Deployment', isJob: kind === 'Job',
    isReplicaSet: kind === 'ReplicaSet', isStatefulSet: kind === 'StatefulSet', describe: undefined, ownedJobs: undefined,
  })
}

// The API server answers each selector as it selects: `answers` maps the selector text to the pods it picks.
function open(kind: string, selector: Record<string, string>, expressions: Expression[] | undefined, answers: Record<string, string[]>) {
  seen.queries = []
  seen.watches = []
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  for (const [text, names] of Object.entries(answers)) {
    const rows = names.map(podRow)
    qc.setQueryData(drawerPodsKey(filterOf(kind, text), 1, 10), { items: rows, total: rows.length, not_running: 0, stats: { total: 3 }, revision: 'r1', source: 'index' } as unknown as PodPage)
    qc.setQueryData(['owned-watched-pods', kind, 'ns', 'web', text], rows.map((r) => ({ ...r, owner_references: [{ kind, name: 'web', controller: true }] })))
  }
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc },
    createElement(MemoryRouter, null, createElement(PageContextProvider, null, createElement(OwnedPods, { kind, selector, expressions })))))
  qc.clear()
  return html
}

const TIER_FRONT: Expression[] = [{ key: 'tier', operator: 'In', values: ['front'] }]

describe.each(KINDS)('the %s drawer\'s pod table', (kind) => {
  it('reads a page, reads whole and watches by the selector\'s labels and expressions', async () => {
    open(kind, { app: 'web' }, TIER_FRONT, { 'app=web,tier in (front)': ['web-front'] })
    const pages = seen.queries.filter((q) => q.queryKey?.[0] === 'drawer-pods').map((q) => JSON.parse(q.queryKey[1]))
    expect(pages.length).toBeGreaterThan(0)
    for (const filter of pages) expect(filter).toEqual(filterOf(kind, 'app=web,tier in (front)'))
    const whole = seen.queries.filter((q) => q.queryKey?.[0] === 'owned-watched-pods')
    expect(whole.map((q) => q.queryKey.at(-1))).toEqual(whole.map(() => 'app=web,tier in (front)'))
    const getPods = vi.spyOn(api, 'getPods').mockResolvedValue([])
    await whole.at(-1).queryFn()
    expect(getPods.mock.calls).toEqual([['ns', 'app=web,tier in (front)']])
    getPods.mockRestore()
    const watches = seen.watches.filter((w) => w.path === '/api/v1/namespaces/ns/pods')
    expect(watches.map((w) => w.enabled)).toContain(true)
    for (const w of watches) expect(w.query).toBe(`watch=1&labelSelector=${encodeURIComponent('app=web,tier in (front)')}`)
    if (kind === 'Deployment') {
      const replicaSets = seen.watches.filter((w) => w.path === '/apis/apps/v1/namespaces/ns/replicasets')
      expect(replicaSets.map((w) => w.query)).toEqual(replicaSets.map(() => `watch=1&labelSelector=${encodeURIComponent('app=web,tier in (front)')}`))
    }
  })

  it('reads its pods when the selector has expressions only', () => {
    open(kind, {}, [{ key: 'tier', operator: 'Exists' }], { tier: ['web-front'] })
    const pages = seen.queries.filter((q) => q.queryKey?.[0] === 'drawer-pods' && q.enabled !== false).map((q) => JSON.parse(q.queryKey[1]))
    expect(pages).toContainEqual(filterOf(kind, 'tier'))
    expect(seen.watches.filter((w) => w.path === '/api/v1/namespaces/ns/pods' && w.enabled).map((w) => w.query)).toContain('watch=1&labelSelector=tier')
  })
})

describe('a Deployment whose selector picks by labels and an expression', () => {
  it('holds the pods of its whole selector, not a pod that its labels alone would take', () => {
    open('Deployment', { app: 'web' }, TIER_FRONT, { 'app=web': ['web-front', 'web-back'], 'app=web,tier in (front)': ['web-front'] })
    expect(seen.pods).toEqual(['web-front'])
  })
})

describe('a workload drawer\'s data', () => {
  it('gives the pod table the describe answer\'s selector and its expressions', () => {
    seen.owned = []
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
    qc.setQueryData(['workload-describe', 'Deployment', 'ns', 'web'], { name: 'web', namespace: 'ns', selector: { app: 'web' }, selector_expressions: TIER_FRONT })
    function Data() {
      useWorkloadData({ name: 'web', namespace: 'ns', kind: 'Deployment' })
      return null
    }
    renderToStaticMarkup(createElement(QueryClientProvider, { client: qc },
      createElement(MemoryRouter, null, createElement(PageContextProvider, null, createElement(Data)))))
    qc.clear()
    const last = seen.owned.at(-1)
    expect({ selector: last?.selector, selectorExpressions: last?.selectorExpressions }).toEqual({ selector: { app: 'web' }, selectorExpressions: TIER_FRONT })
  })
})
