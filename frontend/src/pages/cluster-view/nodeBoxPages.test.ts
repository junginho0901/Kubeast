import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import type { PodNodeSummary } from '@/services/api'
import { ClusterViewContext, type ClusterViewContextValue } from './ClusterViewContext'
import { NodeBox, PodNodeGrid } from './PodNodeGrid'
import { useClusterDerived, type NodeEntry } from './hooks/useClusterDerived'
import {
  NODE_BOXES_PER_PAGE, POD_CARDS_PER_PAGE, boxPageLayer, cutBoxPages, pageOfPod, shownPage, stateForView, type BoxPage,
} from './nodeBoxPages'

// Cluster View on 1 000 nodes: the map draws a cell for every node and the boxes under it are paged by their pod cards
// (at most POD_CARDS_PER_PAGE cards and NODE_BOXES_PER_PAGE boxes a page) in the map's order, which does not move between
// refreshes; a node with more pods than a page holds goes on to the next page, so every pod is on a page; a cell's click
// narrows the boxes to that node and All nodes lands on that node's page. The virtualizer is stood in by one that draws
// every box it is handed, as if the whole page were near the screen, so the page alone bounds the boxes, their reads
// and their watches.

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
const chat = vi.hoisted(() => ({ current: null as { summary?: string; data?: Record<string, unknown> } | null }))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: { summary?: string; data?: Record<string, unknown> } | null) => { chat.current = input } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { watches.queries = [] })

const pad = (n: number) => String(n).padStart(3, '0')
// one control plane and 999 workers
const NAMES = ['cp-0', ...Array.from({ length: 999 }, (_, i) => `node-${pad(i + 1)}`)]
const summaryOf = (names: string[], podsOf: (node: string) => number = () => 3): PodNodeSummary => {
  const nodes = names.map((node) => ({ node, total: podsOf(node), ok: podsOf(node), warn: 0, error: 0 }))
  const total = nodes.reduce((t, n) => t + n.total, 0)
  return { nodes, total, all: total, revision: 'r1', source: 'index' }
}
const NODES = [{ name: 'cp-0', roles: ['control-plane'] }]
const podsFor = (node: string, n: number) => Array.from({ length: n }, (_, i) => ({
  name: `${node}-p${String(i).padStart(3, '0')}`, namespace: i % 2 ? 'b' : 'a', node_name: node, phase: 'Running', status: 'Running', ready: '1/1',
  restart_count: 0, containers: [{ name: 'c', ready: true, state: { running: {} } }], init_containers: [], created_at: '2026-11-15T00:00:00Z',
}))

type Options = { searchQuery?: string; lng?: string; nodeFilter?: string | null; pods?: Record<string, number>; setNodeFilter?: (n: string | null) => void }
let client = new QueryClient()
function contextFor({ searchQuery = '', lng = 'en', nodeFilter = null, setNodeFilter = () => {} }: Options) {
  const lang = i18n.cloneInstance({ lng })
  return {
    lang,
    ctx: {
      tr: (key: string, fallback: string, options?: Record<string, any>) => lang.t(key, { defaultValue: fallback, ...options }),
      searchQuery, selectedNamespace: 'all', deletingPods: new Set<string>(), nodeFilter, setNodeFilter,
      setDeletingPods: () => {}, setSelectedPod: () => {}, setSelectedContainer: () => {}, selectTab: () => {}, setContainerSearchQuery: () => {}, setPodContextMenu: () => {},
    } as unknown as ClusterViewContextValue,
  }
}
function renderWith(Context: typeof ClusterViewContext, element: ReturnType<typeof createElement>, options: Options) {
  const { lang, ctx } = contextFor(options)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  for (const [node, n] of Object.entries(options.pods ?? {})) client.setQueryData(['cluster-view', 'node-pods', node, 'all'], podsFor(node, n))
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: lang },
    createElement(QueryClientProvider, { client }, createElement(Context.Provider, { value: ctx }, element))))
}
function screenOf(Grid: typeof PodNodeGrid) {
  return function Screen({ summary }: { summary: PodNodeSummary }) {
    const entries = useClusterDerived({ summary, nodes: NODES })
    return createElement(Grid, { entries, matched: summary.total, all: summary.all, isLoading: false, canDeletePod: false })
  }
}
const Screen = screenOf(PodNodeGrid)
const render = (summary: PodNodeSummary, options: Options = {}) => renderWith(ClusterViewContext, createElement(Screen, { summary }), options)

const attr = (html: string, name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1]?.replace(/&quot;/g, '"')
const cells = (html: string): string[] => (JSON.parse(attr(html, 'data-cells') ?? '[]') as [string, number, number, number][]).map(([n]) => n)
const boxes = (html: string) => [...html.matchAll(/data-testid="cluster-view-node" data-node="([^"]*)"/g)].map((m) => m[1])
const cards = (html: string) => (html.match(/<button[^>]*class="p-3 bg-slate-700/g) ?? []).length
const footer = (html: string) => html.match(/data-testid="cluster-view-nodes-pager"[\s\S]*?(Showing [^<]+|\d+개 중 [^<]+)/)?.[1] ?? null
const text = (html: string, testId: string) => html.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`))?.[1] ?? null
const piecesOf = (pages: BoxPage[]) => pages.map((p) => p.pieces.map((x) => `${x.index}:${x.from}-${x.to}/${x.total}`).join(' '))
// the server's order: names reversed, then shuffled by a fixed step so a run is the same every time
const reversed = [...NAMES].reverse()
const stepped = NAMES.map((_, i) => NAMES[(i * 389) % NAMES.length])

describe('cutting the node boxes into pages by their pod cards', () => {
  it('takes whole nodes while they fit in 200 cards, and at most 10 boxes of small nodes', () => {
    expect({ cards: POD_CARDS_PER_PAGE, boxes: NODE_BOXES_PER_PAGE }).toEqual({ cards: 200, boxes: 10 })
    // the kubelet's default max-pods: one whole node a page, never cut
    const busy = cutBoxPages(Array(1000).fill(110))
    expect(busy).toHaveLength(1000)
    expect(busy.every((p, i) => p.pieces.length === 1 && p.pieces[0].index === i && p.pieces[0].from === 0 && p.pieces[0].to === 110)).toBe(true)
    // 50 pods: four nodes, 200 cards a page
    const fifty = cutBoxPages(Array(1000).fill(50))
    expect({ pages: fifty.length, first: piecesOf(fifty)[0], cards: fifty[0].podEnd - fifty[0].podStart }).toEqual({ pages: 250, first: '0:0-50/50 1:0-50/50 2:0-50/50 3:0-50/50', cards: 200 })
    // 3 pods: ten boxes a page, not 66
    const small = cutBoxPages(Array(1000).fill(3))
    expect({ pages: small.length, boxes: small[0].pieces.length, cards: small[0].podEnd }).toEqual({ pages: 100, boxes: 10, cards: 30 })
    expect(cutBoxPages([])).toEqual([{ pieces: [], podStart: 0, podEnd: 0 }])
  })

  it('cuts a node of more pods than a page a page at a time, the rest going on on the next page', () => {
    const pages = cutBoxPages([30, 30, 30, 250, 110, 110])
    expect(piecesOf(pages)).toEqual([
      '0:0-30/30 1:0-30/30 2:0-30/30',
      '3:0-200/250',
      '3:200-250/250 4:0-110/110',
      '5:0-110/110',
    ])
    expect(pages.map((p) => [p.podStart, p.podEnd])).toEqual([[0, 90], [90, 290], [290, 450], [450, 560]])
  })

  it('puts every pod on one page, in order, whatever the counts', () => {
    let seed = 7
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31)
    const counts = [0, 1, 199, 200, 201, 250, 400, 1000, ...Array.from({ length: 400 }, () => next() % 260)]
    const pages = cutBoxPages(counts)
    const seen = counts.map(() => 0)
    let offset = 0
    for (const page of pages) {
      expect(page.podStart).toBe(offset)
      expect(page.podEnd - page.podStart).toBeLessThanOrEqual(POD_CARDS_PER_PAGE)
      expect(page.pieces.length).toBeLessThanOrEqual(NODE_BOXES_PER_PAGE)
      for (const piece of page.pieces) {
        expect(piece.from, `node ${piece.index} goes on where it stopped`).toBe(seen[piece.index])
        seen[piece.index] = piece.to
      }
      offset = page.podEnd
    }
    expect(seen).toEqual(counts)
    expect(offset).toBe(counts.reduce((a, b) => a + b, 0))
    // a node no bigger than a page is one box
    const piecesPerNode = counts.map((_, i) => pages.flatMap((p) => p.pieces).filter((p) => p.index === i).length)
    expect(counts.every((c, i) => (c <= POD_CARDS_PER_PAGE ? piecesPerNode[i] === 1 : piecesPerNode[i] === Math.ceil(c / POD_CARDS_PER_PAGE)))).toBe(true)
  })

  it('finds the page of a pod, and keeps the box turned to on screen when a refresh moves the cuts', () => {
    const pages = cutBoxPages([30, 30, 30, 250, 110, 110])
    expect([pageOfPod(pages, 3), pageOfPod(pages, 3, 220), pageOfPod(pages, 4), pageOfPod(pages, 9)]).toEqual([
      { page: 2, at: 0 }, { page: 3, at: 0 }, { page: 3, at: 1 }, { page: 1, at: 0 },
    ])
    const names = ['a', 'b', 'c', 'd', 'e', 'f']
    const indexOf = (n: string) => { const i = names.indexOf(n); return i < 0 ? undefined : i }
    const turned = { key: 'all', page: 4, anchor: { node: 'f', pod: 0 } }
    expect(shownPage(pages, indexOf, turned)).toBe(4)
    // a's pods grew past a page: f is now on page 5, and that is the page shown
    const moved = cutBoxPages([230, 30, 30, 250, 110, 110])
    expect(piecesOf(moved)[4]).toBe('5:0-110/110')
    expect(shownPage(moved, indexOf, turned)).toBe(5)
    // a node gone: the page number, never past the last
    expect(shownPage(pages, indexOf, { key: 'all', page: 9, anchor: { node: 'gone', pod: 0 } })).toBe(4)
    // a new view starts at its first page; the state made for it (All nodes landing on a node) is kept
    expect(stateForView(turned, 'other')).toEqual({ key: 'other', page: 1, anchor: null })
    expect(stateForView(turned, 'all')).toBe(turned)
  })
})

describe('Cluster View on 1 000 nodes', () => {
  it('draws a map cell for every node and one page of boxes in the map\'s order, the footer counting the pods', () => {
    const html = render(summaryOf(reversed))
    expect(cells(html)).toHaveLength(1000)
    expect(cells(html).slice(0, 3)).toEqual(['cp-0', 'node-001', 'node-002'])
    expect({ boxes: boxes(html), footer: footer(html), outlined: attr(html, 'data-page-cells'), line: text(html, 'cluster-view-page-nodes') }).toEqual({
      boxes: cells(html).slice(0, 10),
      footer: 'Showing 1-30 of 3000',
      outlined: '0,10',
      line: 'Page 1 of 100: Nodes 1–10 of 1000.',
    })
  })

  it('takes as many nodes as fit in 200 pod cards', () => {
    const html = render(summaryOf(reversed, () => 50))
    expect({ boxes: boxes(html), footer: footer(html), outlined: attr(html, 'data-page-cells') }).toEqual({
      boxes: ['cp-0', 'node-001', 'node-002', 'node-003'],
      footer: 'Showing 1-200 of 50000',
      outlined: '0,4',
    })
  })

  it('holds a read and a watch for the boxes of the page only, each of its own node', () => {
    const html = render(summaryOf(reversed))
    const reads = client.getQueryCache().findAll({ queryKey: ['cluster-view', 'node-pods'] }).map((q) => q.queryKey[2])
    expect(reads).toEqual(boxes(html))
    expect(watches.queries).toEqual(boxes(html).map((n) => `watch=1&fieldSelector=${encodeURIComponent(`spec.nodeName=${n}`)}`))
  })

  it('keeps the cells and the page when the server lists the nodes in another order', () => {
    const first = render(summaryOf(reversed))
    const again = render(summaryOf(stepped))
    expect(new Set(stepped).size).toBe(1000)
    expect({ cells: cells(again), boxes: boxes(again) }).toEqual({ cells: cells(first), boxes: boxes(first) })
  })

  it('pages over the nodes a search matched, the footer counting their pods', () => {
    const matched = NAMES.filter((n) => n.endsWith('7'))
    const html = render(summaryOf(matched), { searchQuery: '7' })
    expect({ cells: cells(html).length, boxes: boxes(html), footer: footer(html) }).toEqual({
      cells: matched.length,
      boxes: matched.slice(0, 10),
      footer: `Showing 1-30 of ${matched.length * 3}`,
    })
  })

  it('draws the first 200 pods of a node of 250 and says the rest go on on the next page', () => {
    const big = (n: string) => (n === 'cp-0' ? 250 : 3)
    const html = render(summaryOf(NAMES, big), { pods: { 'cp-0': 250 } })
    expect({ boxes: boxes(html), cards: cards(html), part: text(html, 'cluster-view-node-part'), range: attr(html, 'data-pods'), footer: footer(html) }).toEqual({
      boxes: ['cp-0'],
      cards: 200,
      part: 'Pods 1–200 of 250 · continues on the next page',
      range: '1-200/250',
      footer: 'Showing 1-200 of 3247',
    })
    expect(html).toContain('250 Pods')
  })

  it('draws the rest of that node on the next page under its header again, by namespace and name', () => {
    const entry: NodeEntry = { node: 'cp-0', label: 'cp-0', counts: { node: 'cp-0', total: 250, ok: 250, warn: 0, error: 0 } }
    const box = (piece: { from: number; to: number }, lng = 'en') => renderWith(ClusterViewContext,
      createElement(NodeBox, { entry, piece: { index: 0, total: 250, ...piece }, canDeletePod: false }), { lng, pods: { 'cp-0': 250 } })
    const rest = box({ from: 200, to: 250 })
    const names = [...rest.matchAll(/title="(cp-0-p\d+)"/g)].map((m) => m[1])
    const order = podsFor('cp-0', 250).sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : a.name < b.name ? -1 : 1)).map((p) => p.name)
    expect({ header: rest.includes('>cp-0</h2>'), cards: cards(rest), part: text(rest, 'cluster-view-node-part'), names }).toEqual({
      header: true, cards: 50, part: 'Continued: Pods 201–250 of 250', names: order.slice(200),
    })
    // a middle piece says both
    expect(text(box({ from: 100, to: 200 }), 'cluster-view-node-part')).toBe('Continued: Pods 101–200 of 250 · continues on the next page')
    expect(text(box({ from: 200, to: 250 }, 'ko'), 'cluster-view-node-part')).toBe('이어지는 부분입니다. Pod 250개 중 201–250번째입니다.')
    expect(text(box({ from: 0, to: 200 }, 'ko'), 'cluster-view-node-part')).toBe('Pod 250개 중 1–200번째입니다. 다음 페이지에 이어집니다.')
  })

  it('tells the floating chat the page shown, the pods of each box on it and no node filter', () => {
    const html = render(summaryOf(reversed))
    expect(chat.current?.summary).toBe(`클러스터 뷰 노드 박스 1/100쪽 — Pod 3000개 중 1-30번째: ${boxes(html).map((n) => `${n} Pod 3개`).join(', ')}`)
    expect(chat.current?.data).toEqual({
      node_boxes: {
        pagination: { current_page: 1, total_pages: 100, page_size: POD_CARDS_PER_PAGE, total_count: 3000, showing_count: 30 },
        node_filter: null,
        nodes: boxes(html),
        pieces: boxes(html).map((node) => ({ node, pods_from: 1, pods_to: 3, pods_of: 3 })),
      },
    })
    const pages = cutBoxPages([30, 30, 30, 250, 110, 110])
    expect(boxPageLayer(pages, 3, ['a', 'b', 'c', 'd', 'e', 'f'], null)?.summary).toBe('클러스터 뷰 노드 박스 3/4쪽 — Pod 560개 중 291-450번째: d Pod 201-250/250, e Pod 110개')
  })

  it('draws a small cluster as one page, nothing outlined, with the footer', () => {
    chat.current = { summary: 'before' }
    const html = render(summaryOf(['cp-0', 'node-001', 'node-002', 'node-003']))
    // one page shows every node, which the map's layer names: no layer of its own
    expect(chat.current).toBeNull()
    expect({ boxes: boxes(html), footer: footer(html), outlined: attr(html, 'data-page-cells') ?? null, line: text(html, 'cluster-view-page-nodes') }).toEqual({
      boxes: ['cp-0', 'node-001', 'node-002', 'node-003'],
      footer: 'Showing 1-12 of 12',
      outlined: null,
      line: null,
    })
    expect(html).toContain('A cell is a node, a dot a pod. Click a cell to show only that node.')
  })

  it('says the footer, the page\'s line and the map\'s note in the screen\'s language', () => {
    const html = render(summaryOf(reversed), { lng: 'ko' })
    expect(footer(html)).toBe('3000개 중 1-30 표시')
    expect(text(html, 'cluster-view-page-nodes')).toBe('100쪽 중 1쪽: Node 1000개 중 1–10번째입니다.')
    expect(html).toContain(ko.clusterView.map.hintPaged)
  })

  it('marks the boxes as a list the list guard reads and the map as bounded', () => {
    const html = render(summaryOf(reversed))
    expect(html).toMatch(/data-testid="cluster-view-nodes" data-list="node boxes"/)
    expect(html).not.toMatch(/data-testid="cluster-view-nodes"[^>]*data-list-bounded/)
    expect(html).toMatch(/data-testid="cluster-view-map" data-list-bounded="[^"]+"/)
  })
})

describe('a map cell narrows the boxes to its node', () => {
  it('shows that node\'s box only, its cell outlined, the way back and the filter in the floating chat', () => {
    const html = render(summaryOf(reversed), { nodeFilter: 'node-537' })
    expect({
      boxes: boxes(html), outlined: attr(html, 'data-page-cells'), back: text(html, 'cluster-view-node-filter-all'),
      footer: footer(html), line: text(html, 'cluster-view-page-nodes'), cells: cells(html).length,
    }).toEqual({
      boxes: ['node-537'], outlined: '537,538', back: 'All nodes', footer: 'Showing 1-3 of 3', line: null, cells: 1000,
    })
    expect(html).toContain('Showing Node node-537 only.')
    expect(chat.current?.summary).toBe('클러스터 뷰 노드 박스 1/1쪽 · Node node-537만 보기 — Pod 3개 중 1-3번째: node-537 Pod 3개')
    expect((chat.current?.data?.node_boxes as { node_filter: string }).node_filter).toBe('node-537')
    expect(render(summaryOf(reversed), { nodeFilter: 'node-537', lng: 'ko' })).toContain('Node node-537만 보여 줍니다.')
  })

  it('pages a node of many pods the same way', () => {
    const html = render(summaryOf(NAMES, (n) => (n === 'node-002' ? 250 : 3)), { nodeFilter: 'node-002', pods: { 'node-002': 250 } })
    expect({ boxes: boxes(html), cards: cards(html), footer: footer(html), line: text(html, 'cluster-view-page-nodes'), part: text(html, 'cluster-view-node-part') }).toEqual({
      boxes: ['node-002'], cards: 200, footer: 'Showing 1-200 of 250', line: 'Page 1 of 2: Nodes 1–1 of 1.', part: 'Pods 1–200 of 250 · continues on the next page',
    })
    expect(chat.current?.summary).toBe('클러스터 뷰 노드 박스 1/2쪽 · Node node-002만 보기 — Pod 250개 중 1-200번째: node-002 Pod 1-200/250')
  })

  it('says when the node has no pods in this view, with the way back', () => {
    const html = render(summaryOf(reversed), { nodeFilter: 'node-gone' })
    expect({ boxes: boxes(html), footer: footer(html), outlined: attr(html, 'data-page-cells') ?? null }).toEqual({ boxes: [], footer: 'Showing 0 of 0', outlined: null })
    expect(html).toContain('Node node-gone has no Pods in this view.')
    expect(chat.current).toEqual({
      source: 'ClusterViewNodeBoxes',
      summary: '클러스터 뷰 노드 박스 · Node node-gone만 보기 — 이 보기에 그 Node의 Pod가 없음',
      data: { node_boxes: { node_filter: 'node-gone', pieces: [] } },
    })
  })

  it('narrows to the node clicked (Unscheduled too), and All nodes lands on that node\'s page', async () => {
    // the map stood in to hand its click to the test
    const map: { onSelect?: (i: number) => void } = {}
    vi.resetModules()
    vi.doMock('./ClusterNodeMap', () => ({ ClusterNodeMap: (props: { onSelect: (i: number) => void }) => { map.onSelect = props.onSelect; return null } }))
    const fresh = await import('./PodNodeGrid')
    const context = await import('./ClusterViewContext')
    const derived = await import('./hooks/useClusterDerived')
    const FreshScreen: ComponentType<{ summary: PodNodeSummary }> = ({ summary }) => {
      const entries = derived.useClusterDerived({ summary, nodes: NODES })
      return createElement(fresh.PodNodeGrid, { entries, matched: summary.total, all: summary.all, isLoading: false, canDeletePod: false })
    }
    const asked: (string | null)[] = []
    const summary = summaryOf([...NAMES, ''])
    renderWith(context.ClusterViewContext, createElement(FreshScreen, { summary }), { setNodeFilter: (n) => asked.push(n) })
    map.onSelect?.(537)
    map.onSelect?.(1000)
    expect(asked).toEqual(['node-537', 'Unscheduled'])
    vi.doUnmock('./ClusterNodeMap')

    // All nodes sets the state of the view without the filter on that node: its page among every node's
    const pages = cutBoxPages(summary.nodes.map((n) => n.total))
    const order = [...NAMES, 'Unscheduled']
    const landed = stateForView({ key: 'all', page: 1, anchor: { node: 'node-537', pod: 0 } }, 'all')
    expect(shownPage(pages, (n) => { const i = order.indexOf(n); return i < 0 ? undefined : i }, landed)).toBe(54)
    expect(pages[53].pieces.map((p) => order[p.index])).toContain('node-537')
  })
})
