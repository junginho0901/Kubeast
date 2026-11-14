import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import type { PodNodeSummary } from '@/services/api'
import { pageOfItems } from '@/hooks/usePagedItems'
import { ClusterViewContext, type ClusterViewContextValue } from './ClusterViewContext'
import { PodNodeGrid } from './PodNodeGrid'
import { useClusterDerived } from './hooks/useClusterDerived'
import { NODE_BOXES_PER_PAGE, boxPageLayer, boxPageOf, cellsOfPage } from './nodeBoxPages'

// Cluster View on 1 000 nodes: the map draws a cell for every node and the boxes under it are one page of a fixed
// size with the footer every list has, in the map's order, which does not move between refreshes; a cell's click lands
// on the page holding that node. The virtualizer is stood in by one that draws every box it is handed, as if the whole
// page were near the screen, so the page alone bounds the boxes, their reads and their watches.

vi.mock('@tanstack/react-virtual', () => ({
  useWindowVirtualizer: (o: { count: number; getItemKey: (i: number) => string }) => ({
    options: { scrollMargin: 0 },
    getTotalSize: () => o.count * 100,
    getVirtualItems: () => Array.from({ length: o.count }, (_, i) => ({ index: i, key: o.getItemKey(i), start: i * 100 })),
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}))
const watches = vi.hoisted(() => ({ queries: [] as string[] }))
vi.mock('@/services/useKubeWatchList', () => ({
  LIST_GATHER_MS: 100,
  useKubeWatchList: (o: { query: string }) => { watches.queries.push(o.query) },
}))
vi.mock('@/hooks/useCanCreate', () => ({ useWritesRefusedIn: () => () => false }))
// what the boxes tell the floating chat (the map's own layer is useClusterAIContext)
const chat: { current: { summary?: string; data?: Record<string, unknown> } | null } = { current: null }
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: { summary?: string; data?: Record<string, unknown> } | null) => { chat.current = input } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { watches.queries = [] })

const pad = (n: number) => String(n).padStart(3, '0')
// one control plane and 999 workers of 3 pods
const NAMES = ['cp-0', ...Array.from({ length: 999 }, (_, i) => `node-${pad(i + 1)}`)]
const count = (node: string) => ({ node, total: 3, ok: 3, warn: 0, error: 0 })
const summaryOf = (names: string[]): PodNodeSummary => ({ nodes: names.map(count), total: names.length * 3, all: names.length * 3, revision: 'r1', source: 'index' })
const NODES = [{ name: 'cp-0', roles: ['control-plane'] }]

function Screen({ summary }: { summary: PodNodeSummary }) {
  const entries = useClusterDerived({ summary, nodes: NODES })
  return createElement(PodNodeGrid, { entries, matched: summary.total, all: summary.all, isLoading: false, canDeletePod: false })
}
let client = new QueryClient()
const render = (summary: PodNodeSummary, { searchQuery = '', lng = 'en' } = {}) => {
  const lang = i18n.cloneInstance({ lng })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ctx = {
    tr: (key: string, fallback: string, options?: Record<string, any>) => lang.t(key, { defaultValue: fallback, ...options }),
    searchQuery, selectedNamespace: 'all', deletingPods: new Set<string>(),
    setDeletingPods: () => {}, setSelectedPod: () => {}, setSelectedContainer: () => {}, selectTab: () => {}, setContainerSearchQuery: () => {}, setPodContextMenu: () => {},
  } as unknown as ClusterViewContextValue
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: lang },
    createElement(QueryClientProvider, { client },
      createElement(ClusterViewContext.Provider, { value: ctx }, createElement(Screen, { summary })))))
}
const attr = (html: string, name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1]?.replace(/&quot;/g, '"')
const cells = (html: string): string[] => (JSON.parse(attr(html, 'data-cells') ?? '[]') as [string, number, number, number][]).map(([n]) => n)
const boxes = (html: string) => [...html.matchAll(/data-testid="cluster-view-node" data-node="([^"]*)"/g)].map((m) => m[1])
const footer = (html: string) => html.match(/data-testid="cluster-view-nodes-pager"[\s\S]*?(Showing [^<]+|\d+개 중 [^<]+)/)?.[1] ?? null
// the server's order: names reversed, then shuffled by a fixed step so a run is the same every time
const reversed = [...NAMES].reverse()
const stepped = NAMES.map((_, i) => NAMES[(i * 389) % NAMES.length])

describe('Cluster View on 1 000 nodes', () => {
  it('draws a map cell for every node and one page of ten boxes in the map\'s order, the footer counting every node', () => {
    const html = render(summaryOf(reversed))
    expect(cells(html)).toHaveLength(1000)
    expect(cells(html).slice(0, 3)).toEqual(['cp-0', 'node-001', 'node-002'])
    expect(boxes(html).length).toBeLessThanOrEqual(NODE_BOXES_PER_PAGE)
    expect({ boxes: boxes(html), footer: footer(html), outlined: attr(html, 'data-page-cells') }).toEqual({
      boxes: cells(html).slice(0, 10),
      footer: 'Showing 1-10 of 1000',
      outlined: '0,10',
    })
  })

  it('holds a read and a watch for the boxes of the page only, each of its own node', () => {
    const html = render(summaryOf(reversed))
    const reads = client.getQueryCache().findAll({ queryKey: ['cluster-view', 'node-pods'] }).map((q) => q.queryKey[2])
    expect(reads).toEqual(boxes(html))
    expect(watches.queries).toHaveLength(boxes(html).length)
    expect(watches.queries).toEqual(boxes(html).map((n) => `watch=1&fieldSelector=${encodeURIComponent(`spec.nodeName=${n}`)}`))
  })

  it('keeps the cells and the page when the server lists the nodes in another order', () => {
    const first = render(summaryOf(reversed))
    const again = render(summaryOf(stepped))
    expect(new Set(stepped).size).toBe(1000)
    expect({ cells: cells(again), boxes: boxes(again) }).toEqual({ cells: cells(first), boxes: boxes(first) })
  })

  it('lands a cell\'s click on the page holding that node, at its place, and outlines that page\'s cells', () => {
    const order = cells(render(summaryOf(reversed)))
    expect(boxPageOf(537)).toEqual({ page: 54, at: 7 })
    for (const i of [0, 9, 10, 537, 990, 999]) {
      const { page, at } = boxPageOf(i)
      expect(pageOfItems(order, page, NODE_BOXES_PER_PAGE).items[at], `cell ${i}`).toBe(order[i])
      const { start, end } = cellsOfPage(page, order.length)
      expect(i >= start && i < end && end - start <= NODE_BOXES_PER_PAGE, `cell ${i} outlined on page ${page}`).toBe(true)
    }
    expect(boxPageOf(999)).toEqual({ page: 100, at: 9 })
    expect(cellsOfPage(100, 1000)).toEqual({ start: 990, end: 1000 })
  })

  it('pages over the nodes a search matched, the footer counting them', () => {
    const matched = NAMES.filter((n) => n.endsWith('7'))
    const html = render(summaryOf(matched), { searchQuery: '7' })
    expect({ cells: cells(html).length, boxes: boxes(html), footer: footer(html) }).toEqual({
      cells: matched.length,
      boxes: matched.slice(0, 10),
      footer: `Showing 1-10 of ${matched.length}`,
    })
  })

  it('tells the floating chat the page of boxes shown and its nodes, as a paged list does', () => {
    const html = render(summaryOf(reversed))
    expect(chat.current?.summary).toBe('클러스터 뷰 노드 박스 1/100쪽 — 노드 1000개 중 1-10번째')
    expect(chat.current?.data).toEqual({
      node_boxes: {
        pagination: { current_page: 1, total_pages: 100, page_size: NODE_BOXES_PER_PAGE, total_count: 1000, showing_count: 10 },
        nodes: boxes(html),
      },
    })
    expect(boxPageLayer(54, 100, 1000, ['node-530'])?.summary).toBe('클러스터 뷰 노드 박스 54/100쪽 — 노드 1000개 중 531-540번째')
  })

  it('draws a small cluster as one page, nothing outlined, with the footer', () => {
    chat.current = { summary: 'before' }
    const html = render(summaryOf(['cp-0', 'node-001', 'node-002', 'node-003']))
    // one page shows every node, which the map's layer names: no layer of its own
    expect(chat.current).toBeNull()
    expect({ boxes: boxes(html), footer: footer(html), outlined: attr(html, 'data-page-cells') ?? null }).toEqual({
      boxes: ['cp-0', 'node-001', 'node-002', 'node-003'],
      footer: 'Showing 1-4 of 4',
      outlined: null,
    })
    expect(html).toContain('A cell is a node, a dot a pod. Click a cell to go to the node.')
  })

  it('says the footer and the map\'s note in the screen\'s language', () => {
    const html = render(summaryOf(reversed), { lng: 'ko' })
    expect(footer(html)).toBe('1000개 중 1-10 표시')
    expect(html).toContain(ko.clusterView.map.hintPaged)
  })

  it('marks the boxes as a list the list guard reads and the map as bounded', () => {
    const html = render(summaryOf(reversed))
    expect(html).toMatch(/data-testid="cluster-view-nodes" data-list="node boxes"/)
    expect(html).not.toMatch(/data-testid="cluster-view-nodes"[^>]*data-list-bounded/)
    expect(html).toMatch(/data-testid="cluster-view-map" data-list-bounded="[^"]+"/)
  })
})
