import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { PodPage } from '@/services/api'
import { api } from '@/services/api'
import '@/i18n'
import { PageContextProvider } from '@/components/PageContextProvider'
import PDBInfo from './PDBInfo'
import { drawerPodsKey } from './useServerPods'
import cases from './pdbSelector.cases.json'

const seen = vi.hoisted(() => ({ queries: [] as any[], watches: [] as any[] }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: (options: any) => (seen.queries.push(options), actual.useQuery(options)) }
})
vi.mock('@/services/useKubeWatchList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/useKubeWatchList')>()
  return { ...actual, useKubeWatchList: (options: any) => void seen.watches.push(options) }
})

type SelectorCase = (typeof cases)[number] & { match_expressions?: unknown[] }

const NO_SELECTOR = 'This PodDisruptionBudget has no selector, so it protects no pod.'

const podRow = (name: string) => ({ name, namespace: 'ns', status: 'Running', phase: 'Running', ready: '1/1', restart_count: 0 })
// The server's page filter for a selector: an empty selector asks for every pod of the namespace.
const pageFilter = (selector: string) => (selector ? { namespace: 'ns', label_selector: selector } : { namespace: 'ns' })

function prime(qc: QueryClient, selector: string, names: string[], namespacePods: number) {
  const rows = names.map(podRow)
  qc.setQueryData(drawerPodsKey(pageFilter(selector), 1, 10), { items: rows, total: rows.length, not_running: 0, stats: { total: namespacePods }, revision: 'r1', source: 'index' } as unknown as PodPage)
  qc.setQueryData(['pdb-protected-pods', 'ns', 'budget', selector], rows)
}

// Opens the drawer on the budget's answer. The reads are answered as the API server answers them: the whole selector
// with the pods the budget protects, its matchLabels alone with every pod that has those labels.
function open(c: SelectorCase) {
  seen.queries = []
  seen.watches = []
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  qc.setQueryData(['pdb-describe', 'ns', 'budget'], { selector: c.selector, match_expressions: c.match_expressions, has_selector: c.has_selector, expected_pods: c.protected.length })
  const labels = Object.entries(c.selector as Record<string, string>)
  const labelsOnly = labels.map(([k, v]) => `${k}=${v}`).join(',')
  if (labelsOnly && labelsOnly !== c.label_selector) {
    const haveLabels = c.pods.filter((p) => labels.every(([k, v]) => (p.labels as Record<string, string | undefined>)[k] === v)).map((p) => p.name)
    prime(qc, labelsOnly, haveLabels, c.pods.length)
  }
  if (c.has_selector) prime(qc, c.label_selector, c.protected, c.pods.length)
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc },
    createElement(MemoryRouter, null, createElement(PageContextProvider, null, createElement(PDBInfo, { name: 'budget', namespace: 'ns' })))))
  qc.clear()
  return html
}

describe.each((cases as SelectorCase[]).filter((c) => c.has_selector))('a budget whose selector is "$name"', (c) => {
  it('reads a page, reads whole and watches the pods by its whole selector, as the API server reads the budget', async () => {
    open(c)
    const pageFilters = seen.queries.filter((q) => q.queryKey?.[0] === 'drawer-pods').map((q) => JSON.parse(q.queryKey[1]))
    expect(pageFilters.length).toBeGreaterThan(0)
    for (const filter of pageFilters) expect(filter).toEqual(pageFilter(c.label_selector))

    const whole = seen.queries.filter((q) => q.queryKey?.[0] === 'pdb-protected-pods')
    expect(whole.map((q) => q.queryKey.at(-1))).toEqual(whole.map(() => c.label_selector))
    const getPods = vi.spyOn(api, 'getPods').mockResolvedValue([])
    await whole.at(-1).queryFn()
    expect(getPods.mock.calls).toEqual([['ns', c.label_selector]])
    getPods.mockRestore()

    const watches = seen.watches.filter((w) => w.path === '/api/v1/namespaces/ns/pods')
    expect(watches.map((w) => w.enabled)).toContain(true)
    for (const w of watches) expect(w.query).toBe(`watch=1&labelSelector=${encodeURIComponent(c.label_selector)}`)
  })
})

describe.each((cases as SelectorCase[]).filter((c) => !c.has_selector))('a budget with "$name"', (c) => {
  it('reads and watches no pod, and says it protects none because it has no selector', () => {
    const html = open(c)
    const reads = seen.queries.filter((q) => q.queryKey?.[0] === 'drawer-pods' || q.queryKey?.[0] === 'pdb-protected-pods')
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.filter((q) => q.enabled !== false).map((q) => q.queryKey)).toEqual([])
    expect(seen.watches.filter((w) => w.path === '/api/v1/namespaces/ns/pods' && w.enabled).map((w) => w.query)).toEqual([])
    expect(html).toContain('Protected Pods (0)')
    expect(html).toContain(NO_SELECTOR)
  })
})

describe.each(cases as SelectorCase[])('the drawer of a budget whose selector is "$name"', (c) => {
  it('lists the pods the budget protects and no others', () => {
    const html = open(c)
    expect(html).toContain(`Protected Pods (${c.protected.length})`)
    for (const p of c.pods) {
      if (c.protected.includes(p.name)) expect(html).toContain(`>${p.name}<`)
      else expect(html).not.toContain(`>${p.name}<`)
    }
  })
})
