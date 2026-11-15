import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { PodPage } from '@/services/api'
import { useServerPodPage, type ServerPodFilter } from './useServerPods'

// A drawer keeps its component when it moves to another object of the same kind: its table of pods drew the rows of
// the object before as this one's until the answer came. Another object's pods now wait as on first open; another
// page of the same pods keeps the rows.

const read = vi.hoisted(() => ({ options: [] as any[] }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...real, useQuery: (options: any, client?: never) => (read.options.push(options), real.useQuery(options, client)) }
})

// The options the drawer's table reads one page with.
function optionsFor(filter: ServerPodFilter, page: number) {
  read.options.length = 0
  const Probe = () => (useServerPodPage(filter, page, 10), null)
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)))
  return read.options[0]
}

const pageOf = (names: string[]) => ({ items: names.map((name) => ({ name, namespace: 'ns' })), total: names.length, stats: { total: 9 }, revision: 'r1', source: 'index' }) as unknown as PodPage

function drawer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const held = new Map<string, (page: PodPage) => void>()
  let observer: QueryObserver<PodPage> | null = null
  let stop = () => {}
  return {
    show(filter: ServerPodFilter, page = 1) {
      const options = optionsFor(filter, page)
      const own = { ...options, queryFn: () => new Promise<PodPage>((resolve) => held.set(JSON.stringify(options.queryKey), resolve)), refetchInterval: false }
      if (!observer) {
        observer = new QueryObserver<PodPage>(client, own)
        stop = observer.subscribe(() => {})
      } else observer.setOptions(own)
      return observer.getCurrentResult()
    },
    async answer(filter: ServerPodFilter, page: number, answer: PodPage) {
      const key = JSON.stringify(optionsFor(filter, page).queryKey)
      await vi.waitFor(() => expect(held.has(key)).toBe(true))
      held.get(key)!(answer)
      await vi.waitFor(() => expect(observer!.getCurrentResult().data).toEqual(answer))
    },
    stop: () => stop(),
  }
}
const rows = (r: { data?: PodPage; isLoading: boolean }) => ({ rows: r.data?.items.map((p) => p.name), loading: r.isLoading })

describe('a drawer\'s table of pods', () => {
  it('shows no pod of the object before while another object\'s pods are on their way', async () => {
    const d = drawer()
    d.show({ priority_class: 'high' })
    await d.answer({ priority_class: 'high' }, 1, pageOf(['high-0', 'high-1']))

    expect(rows(d.show({ priority_class: 'low' })), 'while the answer is held').toEqual({ rows: undefined, loading: true })
    await d.answer({ priority_class: 'low' }, 1, pageOf(['low-0']))
    d.stop()
  })

  it('keeps the rows while another page of the same pods loads', async () => {
    const d = drawer()
    d.show({ priority_class: 'high' })
    await d.answer({ priority_class: 'high' }, 1, pageOf(['high-0', 'high-1']))

    expect(rows(d.show({ priority_class: 'high' }, 2)), 'while page 2 is held').toEqual({ rows: ['high-0', 'high-1'], loading: false })
    d.stop()
  })
})
