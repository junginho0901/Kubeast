import type { AIContextInput } from '@/hooks/useAIContext'

// The node boxes under the map are paged by node, NODE_BOXES_PER_PAGE a page in the map's order, so a pod coming or
// going never moves a node to another page. A box shows at most BOX_PREVIEW_CARDS pod cards (errors, then warnings,
// then the rest, each by name, as the map's dots), and "show all" opens the node's own view: that node's pods by name,
// NODE_PODS_PER_PAGE a page, so every pod is on a page of Cluster View. Both footers have no rows-per-page choice: a
// page scrolls on purpose (as GPU's Node allocation).
export const NODE_BOXES_PER_PAGE = 10
export const BOX_PREVIEW_CARDS = 12 // two rows of six cards at 1440 px
export const NODE_PODS_PER_PAGE = 60 // ten rows of six cards

// Where the box of the node at `index` in the map's order is drawn: its page (1-based) and its place on that page.
export function boxPageOf(index: number, perPage: number = NODE_BOXES_PER_PAGE): { page: number; at: number } {
  const per = Math.max(1, Math.floor(perPage))
  const i = Math.max(0, Math.floor(index))
  return { page: Math.floor(i / per) + 1, at: i % per }
}

// The map cells of the boxes on `page` (1-based, as usePagedItems gives it): [start, end) in the map's order.
export function cellsOfPage(page: number, count: number, perPage: number = NODE_BOXES_PER_PAGE): { start: number; end: number } {
  const per = Math.max(1, Math.floor(perPage))
  const start = Math.min(Math.max(0, (Math.floor(page) - 1) * per), count)
  return { start, end: Math.min(start + per, count) }
}

// The overview's page state: the page turned to and the first box on it (`anchor`, a node's ?node= value).
export interface OverviewPageState {
  page: number
  anchor: string | null
}

// The overview page shown: the page holding the box it was turned to, so a node added or removed before that box does
// not move the view (a pod coming or going moves no node: pages are by node); that node gone, the same page number,
// never past the last. `keys` are the boxes' ?node= values in the map's order.
export function overviewPage(keys: readonly string[], state: OverviewPageState): number {
  const total = Math.max(1, Math.ceil(keys.length / NODE_BOXES_PER_PAGE))
  const at = state.anchor === null ? -1 : keys.indexOf(state.anchor)
  if (at >= 0) return boxPageOf(at).page
  return Math.min(Math.max(1, Math.floor(state.page) || 1), total)
}

type Named = { name: string; namespace: string }
type Level = 'ok' | 'warn' | 'error'
const RANK: Record<Level, number> = { error: 0, warn: 1, ok: 2 }
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byName = (a: Named, b: Named) => byText(a.name, b.name) || byText(a.namespace, b.namespace)

// A box's cards: errors, then warnings, then the rest, by name within each — never by age, so a pod coming or going
// changes only its own card, a new pod lands at its name and a problem pod comes to the front; the first
// BOX_PREVIEW_CARDS are drawn.
export function previewOrder<T extends Named>(pods: readonly T[], levelOf: (pod: T) => Level): T[] {
  return pods.map((pod) => ({ pod, rank: RANK[levelOf(pod)] })).sort((a, b) => a.rank - b.rank || byName(a.pod, b.pod)).map((x) => x.pod)
}

// The node's own view: its pods by name (then namespace), which a refresh does not reorder.
export function nameOrder<T extends Named>(pods: readonly T[]): T[] {
  return [...pods].sort(byName)
}

// The page (1-based) of the node's own view holding the pod at `index` of the name order.
export const nodePageOf = (index: number): number => Math.floor(Math.max(0, index) / NODE_PODS_PER_PAGE) + 1

// The node's own view's page: [start, end) of `count` pods, the page never past the last.
export function nodePodsPage(count: number, page: number): { page: number; totalPages: number; start: number; end: number } {
  const totalPages = Math.max(1, Math.ceil(count / NODE_PODS_PER_PAGE))
  const at = Math.min(Math.max(1, Math.floor(page) || 1), totalPages)
  const start = (at - 1) * NODE_PODS_PER_PAGE
  return { page: at, totalPages, start, end: Math.min(start + NODE_PODS_PER_PAGE, count) }
}

// The page a search opens the node's own view on: the one holding the first pod (by name) it matches, else the first.
export function firstMatchPage<T extends Named>(ordered: readonly T[], matches: (pod: T) => boolean): number {
  const i = ordered.findIndex(matches)
  return i < 0 ? 1 : nodePageOf(i)
}

export const podKey = (pod: Named): string => `${pod.namespace}/${pod.name}`

// The node's own view's page, live: the page holding the pod a search opened it on (`focus`, namespace/name), which
// follows it when a pod before it comes or goes; that pod gone, the page it was shown on and `gone`; else the page
// asked; else the page of the search's first match (`firstMatch`, its index in the name order, -1 for none); else 1.
export function nodeViewPage(
  keys: readonly string[],
  view: { page: number | null; pod: string | null },
  firstMatch: number,
): { page: number; totalPages: number; start: number; end: number; gone: boolean } {
  const focus = view.pod === null ? -1 : keys.indexOf(view.pod)
  const wanted = focus >= 0 ? nodePageOf(focus) : view.page ?? (firstMatch >= 0 ? nodePageOf(firstMatch) : 1)
  return { ...nodePodsPage(keys.length, wanted), gone: view.pod !== null && focus < 0 }
}

export interface BoxShown {
  node: string
  shown: number
  total: number
}

// What the floating chat is told of the overview: the page of boxes shown of how many, and for each box how many of
// its pods it draws. One page of whole boxes shows what the map's layer names (the search too): no layer of its own.
export function boxPageLayer(page: number, totalPages: number, total: number, boxes: readonly BoxShown[], search: string): AIContextInput | null {
  const cut = boxes.some((b) => b.shown < b.total)
  if (totalPages <= 1 && !cut) return null
  const { start, end } = cellsOfPage(page, total)
  const searched = search ? ` · 검색 '${search}'` : ''
  const each = boxes.map((b) => (b.shown < b.total ? `${b.node} Pod ${b.total}개 중 ${b.shown}개` : `${b.node} Pod ${b.total}개`))
  return {
    source: 'ClusterViewNodeBoxes',
    summary: `클러스터 뷰 노드 박스 ${page}/${totalPages}쪽 — 노드 ${total}개 중 ${start + 1}-${end}번째${searched}: ${each.join(', ')}`,
    data: {
      node_boxes: {
        pagination: { current_page: page, total_pages: totalPages, page_size: NODE_BOXES_PER_PAGE, total_count: total, showing_count: boxes.length },
        nodes: boxes.map((b) => b.node),
        boxes: boxes.map((b) => ({ node: b.node, pods_shown: b.shown, pods_total: b.total })),
        ...(search ? { search } : {}),
      },
    },
  }
}

export interface NodeViewShown {
  node: string
  page: number
  totalPages: number
  start: number
  end: number
  total: number
  problemsOnly: boolean
  search: string
  matches: number
  pods: string[]
  focus: string | null
  gone: boolean
}

// What the floating chat is told of the node's own view: the node, the page, the range of its pods shown, whether only
// problem pods are shown, the search and how many pods it matches there, and the pods on the page.
export function nodeViewLayer(v: NodeViewShown): AIContextInput {
  const only = v.problemsOnly ? ' · 문제 Pod만' : ''
  const searched = v.search ? ` · 검색 '${v.search}' 맞는 Pod ${v.matches}개` : ''
  const range = v.total === 0 ? 'Pod 0개' : `Pod ${v.total}개 중 ${v.start + 1}-${v.end}번째`
  const focus = v.focus === null ? '' : v.gone ? ` · 검색으로 연 Pod ${v.focus}는 이 Node에 더 없음` : ` · 검색으로 연 Pod ${v.focus}`
  return {
    source: 'ClusterViewNodePods',
    summary: `클러스터 뷰 Node ${v.node}만 보기 ${v.page}/${v.totalPages}쪽${only} — ${range}${searched}${focus}`,
    data: {
      node_view: {
        node: v.node,
        pagination: { current_page: v.page, total_pages: v.totalPages, page_size: NODE_PODS_PER_PAGE, total_count: v.total, showing_count: v.end - v.start },
        problems_only: v.problemsOnly,
        ...(v.search ? { search: v.search, matching_pods: v.matches } : {}),
        ...(v.focus !== null ? { opened_on_pod: v.focus, opened_pod_gone: v.gone } : {}),
        pods: v.pods,
      },
    },
  }
}
