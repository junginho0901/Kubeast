import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import type { PodInfo, PodNodeSummary } from '@/services/api'
import { pageOfItems } from '@/hooks/usePagedItems'
import { getPodHealth } from './podHealth'
import { ClusterViewContext, type ClusterViewContextValue } from './ClusterViewContext'
import { PodNodeGrid } from './PodNodeGrid'
import { useClusterDerived } from './hooks/useClusterDerived'
import {
  BOX_PREVIEW_CARDS, NODE_BOXES_PER_PAGE, NODE_PODS_PER_PAGE, boxPageLayer, boxPageOf, cellsOfPage, nameOrder, nodePageOf, nodePodsPage,
  followedPage, nodeMissingLayer, nodeViewLayer, nodeViewPage, overviewPage, podKey, previewOrder, searchStart,
} from './nodeBoxPages'

// Cluster View on 1 000 nodes: the map draws a cell for every node; the overview under it is a page of ten node boxes in
// the map's order, each drawing at most twelve pod cards (problems first, then by name) with "show all" for the rest;
// a cell or "show all" opens the node's own view, its pods by name sixty a page, so every pod is on a page of Cluster
// View. Pages are by node, so a pod coming or going moves no node; the page follows the box it was turned to and the
// pod a search opened. The virtualizer is stood in by one that draws every box it is handed, as if the whole page
// were near the screen, so the page alone bounds the boxes, their reads and their watches.

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
// what the boxes and the node's own view tell the floating chat (the map's own layer is useClusterAIContext)
const chat = vi.hoisted(() => ({ layers: new Map<string, { summary?: string; data?: Record<string, unknown> }>() }))
vi.mock('@/hooks/useAIContext', () => ({
  useAIContext: (input: { source?: string; summary?: string; data?: Record<string, unknown> } | null) => {
    if (input) chat.layers.set(input.source ?? 'base', input)
  },
}))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  watches.queries = []
  chat.layers.clear()
})

const pad = (n: number, w = 3) => String(n).padStart(w, '0')
// one control plane and 999 workers of 3 pods
const NAMES = ['cp-0', ...Array.from({ length: 999 }, (_, i) => `node-${pad(i + 1)}`)]
const summaryOf = (names: string[], podsOf: (node: string) => number = () => 3): PodNodeSummary => {
  const nodes = names.map((node) => ({ node, total: podsOf(node), ok: podsOf(node), warn: 0, error: 0 }))
  const total = nodes.reduce((t, n) => t + n.total, 0)
  return { nodes, total, all: total, revision: 'r1', source: 'index' }
}
const NODES = [{ name: 'cp-0', roles: ['control-plane'] }]
type Level = 'ok' | 'warn' | 'error'
const pod = (node: string, name: string, level: Level = 'ok', namespace = 'a'): PodInfo => ({
  name, namespace, node_name: node, phase: level === 'error' ? 'Failed' : level === 'warn' ? 'Pending' : 'Running', status: 'Running', ready: '1/1',
  restart_count: 0, containers: [{ name: 'c', ready: level === 'ok', state: { running: {} } }], init_containers: [], created_at: '2026-11-15T00:00:00Z',
} as unknown as PodInfo)
// n pods p000… on a node, every 25th from p005 an error and every 25th from p010 a warning
const podsFor = (node: string, n: number) => Array.from({ length: n }, (_, i) => pod(node, `${node}-p${pad(i)}`, i % 25 === 5 ? 'error' : i % 25 === 10 ? 'warn' : 'ok'))

type View = { node: string; page: number | null; pod: string | null } | null
type Options = {
  searchQuery?: string; lng?: string; nodeView?: View; pods?: Record<string, PodInfo[]>; openNodeView?: (node: string, at?: { page?: number; pod?: string }) => void
  namespace?: string; namespacePods?: Record<string, PodInfo[]>
}
let client = new QueryClient()
function renderWith(Context: typeof ClusterViewContext, element: ReturnType<typeof createElement>, o: Options) {
  const lang = i18n.cloneInstance({ lng: o.lng ?? 'en' })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  for (const [node, list] of Object.entries(o.pods ?? {})) client.setQueryData(['cluster-view', 'node-pods', node, 'all'], list)
  for (const [node, list] of Object.entries(o.namespacePods ?? {})) client.setQueryData(['cluster-view', 'node-pods', node, o.namespace], list)
  const ctx = {
    tr: (key: string, fallback: string, options?: Record<string, any>) => lang.t(key, { defaultValue: fallback, ...options }),
    searchQuery: o.searchQuery ?? '', selectedNamespace: o.namespace ?? 'all', deletingPods: new Set<string>(),
    nodeView: o.nodeView ?? null, openNodeView: o.openNodeView ?? (() => {}), setNodeViewPage: () => {}, moveNodeView: () => {}, closeNodeView: () => {},
    setDeletingPods: () => {}, setSelectedPod: () => {}, setSelectedContainer: () => {}, selectTab: () => {}, setContainerSearchQuery: () => {}, setPodContextMenu: () => {},
  } as unknown as ClusterViewContextValue
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: lang },
    createElement(QueryClientProvider, { client }, createElement(Context.Provider, { value: ctx }, element))))
}
const screenOf = (Grid: typeof PodNodeGrid, derive: typeof useClusterDerived) => ({ summary, search }: { summary: PodNodeSummary; search?: string }) => {
  const entries = derive({ summary, nodes: NODES, search })
  return createElement(Grid, { entries, matched: summary.total, all: summary.all, isLoading: false, canDeletePod: false })
}
const Screen = screenOf(PodNodeGrid, useClusterDerived)
const render = (summary: PodNodeSummary, o: Options = {}) => renderWith(ClusterViewContext, createElement(Screen, { summary, search: o.searchQuery }), o)

const attr = (html: string, name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1]?.replace(/&quot;/g, '"')
const cells = (html: string): string[] => (JSON.parse(attr(html, 'data-cells') ?? '[]') as [string, number, number, number][]).map(([n]) => n)
const boxes = (html: string) => [...html.matchAll(/data-testid="cluster-view-node" data-node="([^"]*)"/g)].map((m) => m[1])
const cards = (html: string) => [...html.matchAll(/data-testid="cluster-view-pod"[^>]*>[\s\S]*?title="([^"]+)"/g)].map((m) => m[1])
const footer = (html: string, id = 'cluster-view-nodes-pager') => html.match(new RegExp(`data-testid="${id}"[\\s\\S]*?(Showing [^<]+|\\d+개 중 [^<]+)`))?.[1] ?? null
const text = (html: string, testId: string) => html.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`))?.[1]?.replace(/&quot;/g, '"').replace(/&#x27;/g, "'") ?? null
// the server's order: names reversed, then shuffled by a fixed step so a run is the same every time
const reversed = [...NAMES].reverse()
const stepped = NAMES.map((_, i) => NAMES[(i * 389) % NAMES.length])
const levelOf = (p: PodInfo) => getPodHealth(p).level

describe('the overview: ten node boxes a page, each of at most twelve cards', () => {
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
    expect(watches.queries).toEqual(boxes(html).map((n) => `watch=1&fieldSelector=${encodeURIComponent(`spec.nodeName=${n}`)}`))
  })

  it('keeps the cells and the page when the server lists the nodes in another order', () => {
    const first = render(summaryOf(reversed))
    const again = render(summaryOf(stepped))
    expect(new Set(stepped).size).toBe(1000)
    expect({ cells: cells(again), boxes: boxes(again) }).toEqual({ cells: cells(first), boxes: boxes(first) })
  })

  it('lands a cell on the page holding that node\'s box, at its place', () => {
    const order = cells(render(summaryOf(reversed)))
    expect(boxPageOf(537)).toEqual({ page: 54, at: 7 })
    for (const i of [0, 9, 10, 537, 990, 999]) {
      const { page, at } = boxPageOf(i)
      expect(pageOfItems(order, page, NODE_BOXES_PER_PAGE).items[at], `cell ${i}`).toBe(order[i])
      const { start, end } = cellsOfPage(page, order.length)
      expect(i >= start && i < end && end - start <= NODE_BOXES_PER_PAGE).toBe(true)
    }
  })

  it('keeps the box it was turned to on screen when a node comes or goes before it; that node gone, the same page', () => {
    const keys = [...NAMES]
    const turned = { page: 54, anchor: keys[530] }
    expect(overviewPage(keys, turned)).toBe(54)
    // a node added before it: node-530 is now the 532nd box, still on page 54
    const added = ['cp-1', ...keys.slice(0, 200), 'node-199a', ...keys.slice(200)]
    expect(added.indexOf('node-530')).toBe(532)
    expect(overviewPage(added, turned)).toBe(54)
    // ten added before it: its page is 55, and that is the page shown
    const many = [...Array.from({ length: 10 }, (_, i) => `cp-x${i}`), ...keys]
    expect(overviewPage(many, turned)).toBe(55)
    // it left: the page number stays, never past the last
    expect(overviewPage(keys.filter((k) => k !== 'node-530'), turned)).toBe(54)
    expect(overviewPage(keys.slice(0, 15), turned)).toBe(2)
    expect(overviewPage(keys, { page: 1, anchor: null })).toBe(1)
  })

  it('keeps nine of the ten boxes when one node before them goes or comes, and all ten when ten do', () => {
    const keys = Array.from({ length: 1000 }, (_, i) => `node-${pad(i, 4)}`)
    const turned = { page: 54, anchor: keys[530] }
    const shown = (list: string[]) => { const p = overviewPage(list, turned); return list.slice((p - 1) * 10, p * 10) }
    const before = keys.slice(530, 540)
    const kept = (list: string[]) => shown(list).filter((k) => before.includes(k)).length
    // one node before them removed (an autoscaler scaling in): the same page, nine of the ten boxes
    const removed = keys.filter((k) => k !== 'node-0100')
    expect({ page: overviewPage(removed, turned), kept: kept(removed) }).toEqual({ page: 54, kept: 9 })
    // one added before them: the same page, nine of the ten
    const added = ['node-0000a', ...keys]
    expect({ page: overviewPage(added, turned), kept: kept(added) }).toEqual({ page: 54, kept: 9 })
    // ten removed or added before them: the page moves with them, all ten kept
    const tenGone = keys.filter((k) => !/^node-00[0-0]\d$/.test(k))
    expect({ page: overviewPage(tenGone, turned), kept: kept(tenGone) }).toEqual({ page: 53, kept: 10 })
    const tenMore = [...Array.from({ length: 10 }, (_, i) => `node-0000${String.fromCharCode(97 + i)}`), ...keys]
    expect({ page: overviewPage(tenMore, turned), kept: kept(tenMore) }).toEqual({ page: 55, kept: 10 })
  })

  it('pages over the nodes a search matched, the other cells faded on the map', () => {
    const matched = NAMES.filter((n) => n.endsWith('7'))
    const nodeList = [...NODES, ...NAMES.slice(1).map((name) => ({ name, roles: [] }))]
    const SearchScreen: ComponentType = () => {
      const entries = useClusterDerived({ summary: summaryOf(matched), nodes: nodeList, search: '7' })
      return createElement(PodNodeGrid, { entries, matched: matched.length * 3, all: 3000, isLoading: false, canDeletePod: false })
    }
    const html = renderWith(ClusterViewContext, createElement(SearchScreen), { searchQuery: '7' })
    expect({ cells: cells(html).length, dim: attr(html, 'data-dim-cells'), boxes: boxes(html), footer: footer(html) }).toEqual({
      cells: 1000, dim: String(1000 - matched.length), boxes: matched.slice(0, 10), footer: `Showing 1-10 of ${matched.length}`,
    })
  })

  it('draws twelve cards of a busy node, errors first, then warnings, then by name, and offers the rest', () => {
    const html = render(summaryOf(NAMES, (n) => (n === 'cp-0' ? 110 : 3)), { pods: { 'cp-0': podsFor('cp-0', 110) } })
    expect({ shown: text(html, 'cluster-view-node-shown'), more: text(html, 'cluster-view-node-more'), drawn: cards(html) }).toEqual({
      shown: 'Showing 12 of 110 Pods',
      more: '+98 show all on this Node',
      // five errors, four warnings, then the rest by name
      drawn: ['p005', 'p030', 'p055', 'p080', 'p105', 'p010', 'p035', 'p060', 'p085', 'p000', 'p001', 'p002'].map((p) => `cp-0-${p}`),
    })
    expect(render(summaryOf(NAMES), { lng: 'ko', pods: { 'cp-0': podsFor('cp-0', 110) } })).toContain('+98 이 Node 전부 보기')
    // twelve or fewer: every card, no button; the pods no node took follow the same rule
    const few = render(summaryOf(['cp-0', '']), { pods: { 'cp-0': podsFor('cp-0', 12), '': podsFor('', 30) } })
    expect({ boxes: boxes(few), cards: cards(few).length, more: [...few.matchAll(/data-testid="cluster-view-node-more"[^>]*>([^<]*)</g)].map((m) => m[1]) }).toEqual({
      boxes: ['cp-0', ''], cards: 24, more: ['+18 show all on this Node'],
    })
  })

  it('changes only the card that changed when a pod goes, comes back under a new name or turns red', () => {
    const before = podsFor('n', 40)
    const shown = (list: PodInfo[]) => previewOrder(list, levelOf).slice(0, BOX_PREVIEW_CARDS).map((p) => p.name)
    const base = shown(before)
    expect(base).toEqual(['p005', 'p030', 'p010', 'p035', 'p000', 'p001', 'p002', 'p003', 'p004', 'p006', 'p007', 'p008'].map((p) => `n-${p}`))
    // n-p000 deleted: it leaves, the others keep their order and the next by name comes in last
    const gone = before.filter((p) => p.name !== 'n-p000')
    expect(shown(gone)).toEqual([...base.filter((n) => n !== 'n-p000'), 'n-p009'])
    // recreated by its ReplicaSet under a new name: it lands at its name, not first or last
    const back = [...gone, pod('n', 'n-p001a')]
    expect(shown(back)).toEqual(['n-p005', 'n-p030', 'n-p010', 'n-p035', 'n-p001', 'n-p001a', 'n-p002', 'n-p003', 'n-p004', 'n-p006', 'n-p007', 'n-p008'])
    // a pod turning red comes to the front, by its name among the errors
    const red = back.map((p) => (p.name === 'n-p039' ? pod('n', 'n-p039', 'error') : p))
    expect(shown(red).slice(0, 3)).toEqual(['n-p005', 'n-p030', 'n-p039'])
    // the box draws the same, its header counting what it holds now
    const html = render(summaryOf(['n']), { pods: { n: back } })
    expect({ cards: cards(html), shown: text(html, 'cluster-view-node-shown') }).toEqual({ cards: shown(back), shown: 'Showing 12 of 40 Pods' })
  })

  it('tells the floating chat the page shown and how many of each box\'s pods it draws', () => {
    const html = render(summaryOf(reversed, (n) => (n === 'node-002' ? 110 : 3)))
    const layer = chat.layers.get('ClusterViewNodeBoxes')
    expect(layer?.summary).toBe(`클러스터 뷰 Node 박스 1/100쪽 — Node 1000개 중 1-10번째: ${boxes(html).map((n) => (n === 'node-002' ? 'node-002 Pod 110개 중 12개' : `${n} Pod 3개`)).join(', ')}`)
    expect(layer?.data).toEqual({
      node_boxes: {
        pagination: { current_page: 1, total_pages: 100, page_size: NODE_BOXES_PER_PAGE, total_count: 1000, showing_count: 10 },
        nodes: boxes(html),
        boxes: boxes(html).map((node) => ({ node, pods_shown: node === 'node-002' ? 12 : 3, pods_total: node === 'node-002' ? 110 : 3 })),
      },
    })
    expect(boxPageLayer(2, 3, 25, [{ node: 'x', shown: 5, total: 5 }], 'web')?.summary).toBe("클러스터 뷰 Node 박스 2/3쪽 — Node 25개 중 11-20번째 · 검색 'web': x Pod 5개")
    // a node not Ready says so, in the summary and the box's data
    const marked = boxPageLayer(1, 1, 2, [{ node: 'x', shown: 3, total: 3, status: 'NotReady,SchedulingDisabled' }, { node: 'y', shown: 3, total: 3, status: 'Ready' }], '')
    expect({ summary: marked?.summary, boxes: (marked?.data?.node_boxes as { boxes: unknown[] }).boxes }).toEqual({
      summary: '클러스터 뷰 Node 박스 1/1쪽 — Node 2개 중 1-2번째: x (NotReady,SchedulingDisabled) Pod 3개, y Pod 3개',
      boxes: [{ node: 'x', status: 'NotReady,SchedulingDisabled', pods_shown: 3, pods_total: 3 }, { node: 'y', pods_shown: 3, pods_total: 3 }],
    })
  })

  it('draws a small cluster as one page, nothing outlined, its layer kept while the overview shows', () => {
    const html = render(summaryOf(['cp-0', 'node-001', 'node-002', 'node-003']))
    // the layer stays while the overview is on screen, so it never comes back as the newest (top) window
    expect(chat.layers.get('ClusterViewNodeBoxes')?.summary).toBe('클러스터 뷰 Node 박스 1/1쪽 — Node 4개 중 1-4번째: cp-0 Pod 3개, node-001 Pod 3개, node-002 Pod 3개, node-003 Pod 3개')
    expect({ boxes: boxes(html), footer: footer(html), outlined: attr(html, 'data-page-cells') ?? null }).toEqual({
      boxes: ['cp-0', 'node-001', 'node-002', 'node-003'], footer: 'Showing 1-4 of 4', outlined: null,
    })
    expect(html).toContain('A cell is a Node, a dot a Pod. Click a cell, or press Enter on it, to see all its Pods.')
    expect(boxPageLayer(1, 1, 0, [], '')).toBeNull()
  })

  it('says the footer and the map\'s note in the screen\'s language', () => {
    const html = render(summaryOf(reversed), { lng: 'ko' })
    expect(footer(html)).toBe('1000개 중 1-10 표시')
    expect(html).toContain(ko.clusterView.map.hintPaged)
  })

  it('marks the boxes as a list the list guard reads, a box\'s cards and the map as bounded', () => {
    const html = render(summaryOf(reversed))
    expect(html).toMatch(/data-testid="cluster-view-nodes" data-list="node boxes"/)
    expect(html).toMatch(/data-list-bounded="at most 12 pod cards; the node&#x27;s own view pages the rest"/)
    expect(html).toMatch(/data-testid="cluster-view-map" data-list-bounded="[^"]+"/)
  })
})

describe('the node\'s own view: its pods by name, sixty a page', () => {
  it('pages 110 pods in two and 250 in five, by name, with the way back and its cell outlined', () => {
    expect([nodePodsPage(110, 1), nodePodsPage(110, 2), nodePodsPage(250, 5), nodePodsPage(250, 9)]).toEqual([
      { page: 1, totalPages: 2, start: 0, end: 60 }, { page: 2, totalPages: 2, start: 60, end: 110 },
      { page: 5, totalPages: 5, start: 240, end: 250 }, { page: 5, totalPages: 5, start: 240, end: 250 },
    ])
    const list = podsFor('node-002', 110).reverse()
    const first = render(summaryOf(NAMES), { nodeView: { node: 'node-002', page: null, pod: null }, pods: { 'node-002': list } })
    expect({
      boxes: boxes(first), cards: cards(first), footer: footer(first, 'cluster-view-node-pods-pager'), overview: footer(first),
      outlined: attr(first, 'data-page-cells'), back: text(first, 'cluster-view-all-nodes'), name: text(first, 'cluster-view-node-view-name'),
    }).toEqual({
      boxes: ['node-002'], cards: nameOrder(list).slice(0, 60).map((p) => p.name), footer: 'Showing 1-60 of 110', overview: null,
      outlined: '2,3', back: 'All Nodes', name: 'node-002',
    })
    const second = render(summaryOf(NAMES), { nodeView: { node: 'node-002', page: 2, pod: null }, pods: { 'node-002': list } })
    expect({ cards: cards(second).length, footer: footer(second, 'cluster-view-node-pods-pager') }).toEqual({ cards: 50, footer: 'Showing 61-110 of 110' })
    const big = render(summaryOf(NAMES), { nodeView: { node: 'node-002', page: 5, pod: null }, pods: { 'node-002': podsFor('node-002', 250) } })
    expect({ cards: cards(big), footer: footer(big, 'cluster-view-node-pods-pager') }).toEqual({
      cards: Array.from({ length: 10 }, (_, i) => `node-002-p${240 + i}`), footer: 'Showing 241-250 of 250',
    })
    expect(render(summaryOf(NAMES), { lng: 'ko', nodeView: { node: 'node-002', page: null, pod: null }, pods: { 'node-002': list } })).toContain('전체 Node')
  })

  it('opens a search on the page of the pod it finds, outlined, and on the pod a box\'s button opened', () => {
    expect([nodePageOf(0), nodePageOf(59), nodePageOf(60), nodePageOf(130), nodePageOf(249)]).toEqual([1, 1, 2, 3, 5])
    const html = render(summaryOf(NAMES), { searchQuery: 'p130', nodeView: { node: 'node-002', page: null, pod: null }, pods: { 'node-002': podsFor('node-002', 250) } })
    expect({ footer: footer(html, 'cluster-view-node-pods-pager'), match: html.match(/data-match="true"[^>]*>[\s\S]*?title="([^"]+)"/)?.[1], note: text(html, 'cluster-view-node-matches') }).toEqual({
      footer: 'Showing 121-180 of 250', match: 'node-002-p130', note: 'Pods matching "p130" are outlined: 1 on this Node.',
    })
    const focused = render(summaryOf(NAMES), { searchQuery: 'p13', nodeView: { node: 'node-002', page: 3, pod: 'a/node-002-p135' }, pods: { 'node-002': podsFor('node-002', 250) } })
    expect(focused.match(/data-focus="true"[^>]*>[\s\S]*?title="([^"]+)"/)?.[1]).toBe('node-002-p135')
    // the overview during a search: a box shows its matching pods and a button to its own view
    const overview = render(summaryOf(['node-002'], () => 10), { searchQuery: 'p13', pods: { 'node-002': podsFor('node-002', 250) } })
    expect({ cards: cards(overview), more: text(overview, 'cluster-view-node-more') }).toEqual({
      cards: ['p130', 'p131', 'p132', 'p133', 'p134', 'p135', 'p136', 'p137', 'p138', 'p139'].map((p) => `node-002-${p}`).sort((a, b) => {
        const rank = (n: string) => (/p(130|135)$/.test(n) ? 0 : 1)
        return rank(a) - rank(b) || (a < b ? -1 : 1)
      }),
      more: 'Show all Pods on this Node',
    })
  })

  it('follows the pod a search opened when a pod before it comes or goes, and says when it is gone', () => {
    const list = nameOrder(podsFor('n', 120)).map(podKey)
    const view = { page: 2, pod: 'a/n-p060' }
    expect(nodeViewPage(list, view, -1)).toEqual({ page: 2, totalPages: 2, start: 60, end: 120, gone: false })
    // n-p010 deleted: n-p060 is now 60th of 119, on page 1, and the page follows it
    expect(nodeViewPage(list.filter((k) => k !== 'a/n-p010'), view, -1)).toMatchObject({ page: 1, gone: false })
    // two pods before it added: back to page 2
    expect(nodeViewPage(['a/n-p000a', 'a/n-p000b', ...list.filter((k) => k !== 'a/n-p010')], view, -1)).toMatchObject({ page: 2, gone: false })
    // it was deleted: the page it was shown on, and gone
    expect(nodeViewPage(list.filter((k) => k !== 'a/n-p060'), view, -1)).toEqual({ page: 2, totalPages: 2, start: 60, end: 119, gone: true })
    // following it to page 1, the address keeps page 1, so it going then keeps page 1, the page shown last
    const moved = list.filter((k) => k !== 'a/n-p010')
    expect(followedPage(view, nodeViewPage(moved, view, -1))).toEqual({ page: 1, pod: 'a/n-p060' })
    const kept = { page: 1, pod: 'a/n-p060' }
    expect(followedPage(kept, nodeViewPage(moved, kept, -1))).toBeNull()
    expect(nodeViewPage(moved.filter((k) => k !== 'a/n-p060'), kept, -1)).toMatchObject({ page: 1, gone: true })
    expect(followedPage({ page: 2, pod: null }, { page: 1, gone: false })).toBeNull()
    // no pod: the page asked, else the search's first match, else 1
    expect([nodeViewPage(list, { page: 2, pod: null }, 5).page, nodeViewPage(list, { page: null, pod: null }, 70).page, nodeViewPage(list, { page: null, pod: null }, -1).page]).toEqual([2, 2, 1])
    const html = render(summaryOf(['n']), { nodeView: { node: 'n', page: 2, pod: 'a/n-p060' }, pods: { n: podsFor('n', 120).filter((p) => p.name !== 'n-p060') } })
    expect({ note: text(html, 'cluster-view-node-pod-gone'), footer: footer(html, 'cluster-view-node-pods-pager') }).toEqual({
      note: 'Pod a/n-p060 is no longer on this Node; a search finds it if it runs on another.', footer: 'Showing 61-119 of 119',
    })
    expect(render(summaryOf(['n']), { lng: 'ko', nodeView: { node: 'n', page: 2, pod: 'a/n-p060' }, pods: { n: [] } })).toContain('Pod a/n-p060: 이 Node에 더 없습니다.')
  })

  it('says the namespace filter leaves the opened pod out, not that it left the node', () => {
    const filtered = renderWith(ClusterViewContext, createElement(Screen, { summary: summaryOf(['n']) }), {
      nodeView: { node: 'n', page: 1, pod: 'a/n-p005' }, pods: {}, namespace: 'b', namespacePods: { n: podsFor('n', 20).map((p) => ({ ...p, namespace: 'b' })) },
    })
    expect({ reason: attr(filtered, 'data-reason'), note: text(filtered, 'cluster-view-node-pod-gone') }).toEqual({
      reason: 'filtered', note: 'Pod a/n-p005 is outside the namespace filter (b).',
    })
  })

  it('goes to the page of the first pod a search typed in the view matches, that pod followed', () => {
    const ordered = nameOrder(podsFor('n', 250))
    expect(searchStart(ordered, (p) => p.name.includes('p200'))).toEqual({ page: 4, pod: 'a/n-p200' })
    expect(searchStart(ordered, (p) => p.name.includes('p13'))).toEqual({ page: 3, pod: 'a/n-p130' })
    expect(searchStart(ordered, (p) => p.name.includes('nothing'))).toBeNull()
  })

  it('says a node the cluster does not list is not in this cluster, and reads nothing for it', () => {
    const nodeList = [{ name: 'cp-0', roles: ['control-plane'], status: 'Ready' }]
    const Missing: ComponentType = () => {
      const entries = useClusterDerived({ summary: summaryOf(['cp-0']), nodes: nodeList })
      return createElement(PodNodeGrid, { entries, matched: 3, all: 3, isLoading: false, canDeletePod: false, nodeList })
    }
    const html = renderWith(ClusterViewContext, createElement(Missing), { nodeView: { node: 'ip-10-0-1-5', page: null, pod: null } })
    expect({ note: text(html, 'cluster-view-node-missing'), boxes: boxes(html), reads: client.getQueryCache().findAll({ queryKey: ['cluster-view', 'node-pods'] }).length }).toEqual({
      note: 'Node ip-10-0-1-5 is not in this cluster.', boxes: [], reads: 0,
    })
    expect(chat.layers.get('ClusterViewNodePods')).toEqual(nodeMissingLayer('ip-10-0-1-5'))
    expect(renderWith(ClusterViewContext, createElement(Missing), { lng: 'ko', nodeView: { node: 'ip-10-0-1-5', page: null, pod: null } })).toContain('Node ip-10-0-1-5: 이 클러스터에 없습니다.')
  })

  it('tells the floating chat the node, the page, the range, problems only, the search and the pod it opened on', () => {
    render(summaryOf(NAMES), { searchQuery: 'p13', nodeView: { node: 'node-002', page: 3, pod: 'a/node-002-p135' }, pods: { 'node-002': podsFor('node-002', 250) } })
    const layer = chat.layers.get('ClusterViewNodePods')
    expect(layer?.summary).toBe("클러스터 뷰 Node node-002만 보기 3/5쪽 — Pod 250개 중 121-180번째 · 검색 'p13' 맞는 Pod 10개 · 검색으로 연 Pod a/node-002-p135")
    expect(layer?.data?.node_view).toMatchObject({
      node: 'node-002', problems_only: false, search: 'p13', matching_pods: 10, opened_on_pod: 'a/node-002-p135', opened_pod_gone: false,
      pagination: { current_page: 3, total_pages: 5, page_size: NODE_PODS_PER_PAGE, total_count: 250, showing_count: 60 },
    })
    expect(chat.layers.has('ClusterViewNodeBoxes')).toBe(false)
    expect(nodeViewLayer({ node: 'n', page: 1, totalPages: 1, start: 0, end: 4, total: 4, problemsOnly: true, search: '', matches: 0, pods: [], focus: 'a/x', gone: 'gone' }).summary)
      .toBe('클러스터 뷰 Node n만 보기 1/1쪽 · 문제 Pod만 — Pod 4개 중 1-4번째 · 검색으로 연 Pod a/x: 이 Node에 더 없음')
    const notReady = nodeViewLayer({ node: 'n', page: 1, totalPages: 1, start: 0, end: 4, total: 4, problemsOnly: false, search: '', matches: 0, pods: [], focus: 'b/x', gone: 'filtered', status: 'NotReady' })
    expect({ summary: notReady.summary, data: notReady.data?.node_view }).toMatchObject({
      summary: '클러스터 뷰 Node n (NotReady)만 보기 1/1쪽 — Pod 4개 중 1-4번째 · 검색으로 연 Pod b/x: Namespace 필터 밖',
      data: { node: 'n', status: 'NotReady', opened_on_pod: 'b/x', opened_pod_gone: false, opened_pod_filtered_out: true },
    })
  })

  it('opens the node\'s own view from a map cell, the Unscheduled cell too', async () => {
    // the map stood in to hand its click to the test
    const map: { onSelect?: (i: number) => void } = {}
    vi.resetModules()
    vi.doMock('./ClusterNodeMap', () => ({ ClusterNodeMap: (props: { onSelect: (i: number) => void }) => { map.onSelect = props.onSelect; return null } }))
    const fresh = await import('./PodNodeGrid')
    const context = await import('./ClusterViewContext')
    const derived = await import('./hooks/useClusterDerived')
    const FreshScreen = screenOf(fresh.PodNodeGrid, derived.useClusterDerived)
    const opened: string[] = []
    renderWith(context.ClusterViewContext, createElement(FreshScreen, { summary: summaryOf([...NAMES, '']) }), { openNodeView: (n) => opened.push(n) })
    map.onSelect?.(537)
    map.onSelect?.(1000)
    expect(opened).toEqual(['node-537', 'Unscheduled'])
    vi.doUnmock('./ClusterNodeMap')
  })
})

describe('the live node list on the screen', () => {
  const nodesWith = (statuses: Record<string, string>) => [
    { name: 'cp-0', roles: ['control-plane'], status: statuses['cp-0'] ?? 'Ready' },
    ...NAMES.slice(1).map((name) => ({ name, roles: [], status: statuses[name] ?? 'Ready' })),
  ]
  const show = (nodes: ReturnType<typeof nodesWith>, summary: PodNodeSummary, o: Options = {}) => {
    const Live: ComponentType = () => {
      const entries = useClusterDerived({ summary, nodes })
      return createElement(PodNodeGrid, { entries, matched: summary.total, all: summary.all, isLoading: false, canDeletePod: false })
    }
    return renderWith(ClusterViewContext, createElement(Live), o).replace(/<!-- -->/g, '')
  }
  const badges = (html: string, node: string) => {
    const at = html.indexOf(`data-testid="cluster-view-node" data-node="${node}"`)
    const boxHtml = html.slice(at, html.indexOf('data-testid="cluster-view-node" data-node=', at + 10) >>> 0 || undefined)
    return [...boxHtml.matchAll(/data-testid="cluster-view-node-status">([^<]*)</g)].map((m) => m[1])
  }

  it('marks a node that turned NotReady or was cordoned on its cell, in the legend and on its box', () => {
    const before = show(nodesWith({}), summaryOf(NAMES))
    expect({ marks: attr(before, 'data-node-marks') ?? null, badges: badges(before, 'node-001') }).toEqual({ marks: null, badges: [] })
    const html = show(nodesWith({ 'node-001': 'NotReady', 'node-002': 'Ready,SchedulingDisabled', 'node-003': 'NotReady,SchedulingDisabled' }), summaryOf(NAMES))
    expect({
      marks: JSON.parse(attr(html, 'data-node-marks') ?? '{}'),
      notReady: html.match(/data-testid="cluster-view-map-not-ready"[^>]*>[\s\S]*?<\/span>([^<]*)</)?.[1],
      cordoned: html.match(/data-testid="cluster-view-map-cordoned"[^>]*>[\s\S]*?<\/span>([^<]*)</)?.[1],
      b1: badges(html, 'node-001'), b2: badges(html, 'node-002'), b3: badges(html, 'node-003'), b4: badges(html, 'node-004'),
    }).toEqual({
      marks: { 'node-001': 'NotReady', 'node-002': 'Ready,SchedulingDisabled', 'node-003': 'NotReady,SchedulingDisabled' },
      notReady: 'Node not Ready 2', cordoned: 'SchedulingDisabled 2',
      b1: ['NotReady'], b2: ['SchedulingDisabled'], b3: ['NotReady', 'SchedulingDisabled'], b4: [],
    })
    expect(attr(html, 'aria-label')).toBe('Node map: 1000 nodes, 3000 pods (0 errors, 0 warnings) 2 nodes not Ready, 2 SchedulingDisabled.')
    const korean = show(nodesWith({ 'node-001': 'NotReady' }), summaryOf(NAMES), { lng: 'ko' })
    expect(korean.match(/data-testid="cluster-view-map-not-ready"[^>]*>[\s\S]*?<\/span>([^<]*)</)?.[1]).toBe('Ready가 아닌 Node 1')
    // the node's own view says it too
    const view = show(nodesWith({ 'node-001': 'NotReady' }), summaryOf(NAMES), { nodeView: { node: 'node-001', page: null, pod: null } })
    expect(badges(view, 'node-001')).toEqual(['NotReady'])
  })

  it('counts the legend from the node list, a node with no pods too, each count opening the first such node', () => {
    const nodeList = [
      { name: 'cp-0', roles: ['control-plane'], status: 'Ready' },
      { name: 'node-001', roles: [], status: 'Ready' },
      { name: 'spare-2', roles: [], status: 'NotReady' }, // no pod: no cell
      { name: 'spare-1', roles: [], status: 'Unknown,SchedulingDisabled' },
    ]
    const Listed: ComponentType = () => {
      const entries = useClusterDerived({ summary: summaryOf(['cp-0', 'node-001']), nodes: nodeList })
      return createElement(PodNodeGrid, { entries, matched: 6, all: 6, isLoading: false, canDeletePod: false, nodeList })
    }
    const html = renderWith(ClusterViewContext, createElement(Listed), {}).replace(/<!-- -->/g, '')
    expect({
      cells: cells(html), marks: attr(html, 'data-node-marks') ?? null,
      notReady: html.match(/data-testid="cluster-view-map-not-ready"[^>]*>[\s\S]*?<\/span>([^<]*)</)?.[1],
      notReadyOpens: html.match(/data-testid="cluster-view-map-not-ready" title="([^"]*)"/)?.[1],
      cordoned: html.match(/data-testid="cluster-view-map-cordoned"[^>]*>[\s\S]*?<\/span>([^<]*)</)?.[1],
    }).toEqual({
      cells: ['cp-0', 'node-001'], marks: null,
      notReady: 'Node not Ready 2', notReadyOpens: 'Open spare-1, the first of them', cordoned: 'SchedulingDisabled 1',
    })
    // the map can be reached from the keyboard
    expect(html).toMatch(/<canvas[^>]*tabindex="0"/)
  })

  it('drops the box of a node removed, the others keeping their places', () => {
    const html = show(nodesWith({}).filter((n) => n.name !== 'node-005'), summaryOf(NAMES.filter((n) => n !== 'node-005')))
    expect({ boxes: boxes(html), footer: footer(html) }).toEqual({
      boxes: ['cp-0', 'node-001', 'node-002', 'node-003', 'node-004', 'node-006', 'node-007', 'node-008', 'node-009', 'node-010'],
      footer: 'Showing 1-10 of 999',
    })
  })
})

