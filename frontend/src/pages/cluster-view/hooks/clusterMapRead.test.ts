import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { PodNodeSummary } from '@/services/api'
import { useClusterPodsQuery } from './useClusterPodsQuery'

// Cluster View's node map drew the namespace it left as the new one's until the answer came. Another namespace now
// waits as on first open; a search keeps the map (the boxes and their watches stay) while the server counts it.

const read = vi.hoisted(() => ({ options: [] as any[] }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...real, useQuery: (options: any, client?: never) => (read.options.push(options), real.useQuery(options, client)) }
})

interface View { selectedNamespace: string; search: string }

// The options the map is read with, for one namespace and search.
function optionsFor(view: View) {
  read.options.length = 0
  const Probe = () => (useClusterPodsQuery(view), null)
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)))
  return read.options.find((o) => o.queryKey[0] === 'cluster-view')
}

const mapOf = (node: string): PodNodeSummary => ({ nodes: [{ node, total: 1, ok: 1 }], total: 1, all: 5, revision: 'r1' }) as unknown as PodNodeSummary

function clusterView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const held = new Map<string, (map: PodNodeSummary) => void>()
  let observer: QueryObserver<PodNodeSummary> | null = null
  let stop = () => {}
  return {
    show(view: View) {
      const options = optionsFor(view)
      const own = { ...options, queryFn: () => new Promise<PodNodeSummary>((resolve) => held.set(JSON.stringify(options.queryKey), resolve)), refetchInterval: false }
      if (!observer) {
        observer = new QueryObserver<PodNodeSummary>(client, own)
        stop = observer.subscribe(() => {})
      } else observer.setOptions(own)
      return observer.getCurrentResult()
    },
    async answer(view: View, map: PodNodeSummary) {
      const key = JSON.stringify(optionsFor(view).queryKey)
      await vi.waitFor(() => expect(held.has(key)).toBe(true))
      held.get(key)!(map)
      await vi.waitFor(() => expect(observer!.getCurrentResult().data).toEqual(map))
    },
    stop: () => stop(),
  }
}
const shown = (r: { data?: PodNodeSummary; isLoading: boolean }) => ({ node: r.data?.nodes[0]?.node, loading: r.isLoading })

describe('the Cluster View node map', () => {
  it('shows no map of the namespace it left while another namespace is on its way', async () => {
    const v = clusterView()
    v.show({ selectedNamespace: 'shop', search: '' })
    await v.answer({ selectedNamespace: 'shop', search: '' }, mapOf('shop-node'))

    expect(shown(v.show({ selectedNamespace: 'web', search: '' })), 'while the answer is held').toEqual({ node: undefined, loading: true })
    await v.answer({ selectedNamespace: 'web', search: '' }, mapOf('web-node'))
    v.stop()
  })

  it('keeps the map while a search of the same namespace is counted', async () => {
    const v = clusterView()
    v.show({ selectedNamespace: 'shop', search: '' })
    await v.answer({ selectedNamespace: 'shop', search: '' }, mapOf('shop-node'))

    expect(shown(v.show({ selectedNamespace: 'shop', search: 'web' })), 'while the search is held').toEqual({ node: 'shop-node', loading: false })
    v.stop()
  })
})
