import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { PodPage } from '@/services/api'
import '@/i18n'
import { PageContextProvider } from '@/components/PageContextProvider'
import ServiceInfo from './ServiceInfo'
import PDBInfo from './PDBInfo'
import { useOwnedWatchedResources } from './workload-info/useOwnedWatchedResources'
import WorkloadOwnedResources from './workload-info/WorkloadOwnedResources'
import { drawerPodsKey } from './useServerPods'

const seen = vi.hoisted(() => ({ queries: [] as any[], watches: [] as any[] }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: (options: any) => (seen.queries.push(options), actual.useQuery(options)) }
})
vi.mock('@/services/useKubeWatchList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/useKubeWatchList')>()
  return { ...actual, useKubeWatchList: (options: any) => void seen.watches.push(options) }
})

// The server's first page of a drawer's table: `matched` pods of a namespace of 5 000, ten on the page.
const pageOf = (matched: number): PodPage => ({
  items: Array.from({ length: 10 }, (_, i) => ({ name: `page-${i}`, namespace: 'ns', status: 'Running', phase: 'Running', ready: '1/1', restart_count: 0 })),
  total: matched, not_running: 0, stats: { total: 5000 }, revision: 'r1', source: 'index',
} as unknown as PodPage)

function OwnedPods({ kind }: { kind: string }) {
  const owned = useOwnedWatchedResources({ kind, namespace: 'ns', name: 'web', selector: { app: 'web' } })
  return createElement(WorkloadOwnedResources, {
    namespace: 'ns', owned, isCronJob: false, isDaemonSet: kind === 'DaemonSet', isDeployment: kind === 'Deployment', isJob: kind === 'Job',
    isReplicaSet: kind === 'ReplicaSet', isStatefulSet: kind === 'StatefulSet', describe: undefined, ownedJobs: undefined,
  })
}

type Drawer = { kind: string; component: ComponentType<any>; props: Record<string, unknown>; filter: Record<string, string>; prime?: (qc: QueryClient) => void }
const owner = (kind: string): Drawer => ({ kind, component: OwnedPods, props: { kind }, filter: kind === 'Deployment' ? { label_selector: 'app=web' } : { label_selector: 'app=web', owner: `${kind}/web` } })
const drawers: Drawer[] = [
  { kind: 'Service', component: ServiceInfo, props: { name: 'web', namespace: 'ns' }, filter: { label_selector: 'app=web' }, prime: (qc) => qc.setQueryData(['service-describe', 'ns', 'web'], { selector: { app: 'web' } }) },
  { kind: 'PodDisruptionBudget', component: PDBInfo, props: { name: 'web', namespace: 'ns' }, filter: { label_selector: 'app=web' }, prime: (qc) => qc.setQueryData(['pdb-describe', 'ns', 'web'], { selector: { app: 'web' } }) },
  owner('Deployment'), owner('DaemonSet'), owner('StatefulSet'), owner('ReplicaSet'), owner('Job'),
]

function open(d: Drawer, matched: number) {
  seen.queries = []
  seen.watches = []
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  d.prime?.(qc)
  qc.setQueryData(drawerPodsKey({ namespace: 'ns', ...d.filter }, 1, 10), pageOf(matched))
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc },
    createElement(MemoryRouter, null, createElement(PageContextProvider, null, createElement(d.component, d.props)))))
  const pageReads = seen.queries.filter((q) => q.queryKey?.[0] === 'drawer-pods')
  const every = pageReads.at(-1)?.refetchInterval
  return {
    html,
    watchOpen: seen.watches.some((w) => w.path === '/api/v1/namespaces/ns/pods' && w.enabled),
    pageEvery: typeof every === 'function' ? every({ state: { data: pageOf(matched), error: null } }) : (every ?? false),
  }
}

describe.each(drawers)('the $kind drawer\'s table of its pods', (d) => {
  it('follows 300 pods live and reads 301 a page at a time every 3 seconds, saying so', () => {
    const few = open(d, 300)
    expect(few.watchOpen).toBe(true)
    expect(few.pageEvery).toBe(false)
    expect(few.html).not.toContain('drawer-pods-read-every')
    const many = open(d, 301)
    expect(many.watchOpen).toBe(false)
    expect(many.pageEvery).toBe(3_000)
    // the Deployment window shows its ReplicaSets; its pods go to the floating chat
    if (d.kind !== 'Deployment') expect(many.html).toContain('data-testid="drawer-pods-read-every"')
  })
})
