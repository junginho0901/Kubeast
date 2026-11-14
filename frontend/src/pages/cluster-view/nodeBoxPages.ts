import type { AIContextInput } from '@/hooks/useAIContext'

// The node boxes under the map are paged by their pod cards, not by nodes: a page takes the nodes in the map's order
// while they fit in POD_CARDS_PER_PAGE cards, and a node that does not fit in what is left starts the next page. A node
// with more pods than a page holds is cut a page at a time, its box drawn again on the next page with the pods that are
// left (the header repeated, "Pods 201–250 of 250"), so no pod is left out of every page and a node no bigger than a
// page is never cut. A page also holds at most NODE_BOXES_PER_PAGE boxes, so a cluster of small nodes does not draw a
// hundred one-pod boxes (and their reads and watches) on one page. The footer has no rows-per-page choice (as GPU's
// boxes). The cut is this one function: a "show more" inside a box would take its place.
export const POD_CARDS_PER_PAGE = 200
export const NODE_BOXES_PER_PAGE = 10

// A node's box on a page: the node at `index` in the map's order and its pods [from, to) of `total`, in the box's order.
export interface BoxPiece {
  index: number
  from: number
  to: number
  total: number
}

// A page of boxes: its pieces and the pod cards it holds, [podStart, podEnd) of every card in the map's order.
export interface BoxPage {
  pieces: BoxPiece[]
  podStart: number
  podEnd: number
}

// The pages of nodes holding `podCounts[i]` pods each, in that order. Always at least one page (empty for no nodes).
export function cutBoxPages(podCounts: readonly number[], budget: number = POD_CARDS_PER_PAGE, maxBoxes: number = NODE_BOXES_PER_PAGE): BoxPage[] {
  const per = Math.max(1, Math.floor(budget))
  const most = Math.max(1, Math.floor(maxBoxes))
  const pages: BoxPage[] = []
  let page: BoxPage = { pieces: [], podStart: 0, podEnd: 0 }
  podCounts.forEach((count, index) => {
    const total = Math.max(0, Math.floor(count) || 0)
    let from = 0
    do {
      const left = per - (page.podEnd - page.podStart)
      if (page.pieces.length > 0 && (page.pieces.length >= most || total - from > left)) {
        pages.push(page)
        page = { pieces: [], podStart: page.podEnd, podEnd: page.podEnd }
      }
      const take = Math.min(total - from, per - (page.podEnd - page.podStart))
      page.pieces.push({ index, from, to: from + take, total })
      from += take
      page.podEnd += take
    } while (from < total)
  })
  if (page.pieces.length > 0 || pages.length === 0) pages.push(page)
  return pages
}

// The page (1-based) holding pod `pod` of the node at `index`, and that box's place on the page; the first page when
// the node is not listed.
export function pageOfPod(pages: readonly BoxPage[], index: number, pod: number = 0): { page: number; at: number } {
  let first: { page: number; at: number } | null = null
  for (let p = 0; p < pages.length; p++) {
    const at = pages[p].pieces.findIndex((piece) => piece.index === index)
    if (at < 0) continue
    const piece = pages[p].pieces[at]
    if (!first) first = { page: p + 1, at }
    if (pod >= piece.from && (pod < piece.to || piece.to === piece.total)) return { page: p + 1, at }
  }
  return first ?? { page: 1, at: 0 }
}

// The page state of the boxes: the view it is for (namespace, search and node filter), the page turned to and the box
// it was turned to, so a refresh that moves the cuts (pods came or went on a node before it) keeps that box on screen.
export interface BoxPageState {
  key: string
  page: number
  anchor: { node: string; pod: number } | null
}

// The state once the view is `key`: kept when it was made for that view (a box to land on, as All nodes sets it before
// the address follows), else the view's first page.
export const stateForView = (state: BoxPageState, key: string): BoxPageState => (state.key === key ? state : { key, page: 1, anchor: null })

// The page shown (1-based): the one holding the box the state names when that node is listed, else its page number,
// never past the last. `indexOf` gives a node's place in the map's order (after the node filter).
export function shownPage(pages: readonly BoxPage[], indexOf: (node: string) => number | undefined, state: BoxPageState): number {
  const at = state.anchor ? indexOf(state.anchor.node) : undefined
  if (state.anchor && at !== undefined) return pageOfPod(pages, at, state.anchor.pod).page
  return Math.min(Math.max(1, Math.floor(state.page) || 1), Math.max(1, pages.length))
}

// The map cells of the boxes on a page: [start, end) in the map's order.
export function cellsOfPage(page: BoxPage | undefined): { start: number; end: number } {
  if (!page || page.pieces.length === 0) return { start: 0, end: 0 }
  return { start: page.pieces[0].index, end: page.pieces[page.pieces.length - 1].index + 1 }
}

// What the floating chat is told of the boxes: the page shown of how many, the pods it holds, each box's node and the
// range of its pods drawn, and the node the boxes are narrowed to. One page of every node, unnarrowed, shows what the
// map's layer names: no layer of its own. `nodes` are the box labels in the map's order (after the node filter).
export function boxPageLayer(
  pages: readonly BoxPage[],
  page: number,
  nodes: readonly string[],
  nodeFilter: string | null,
): AIContextInput | null {
  if (pages.length <= 1 && nodeFilter === null) return null
  const shown = pages[Math.min(Math.max(1, page), pages.length) - 1]
  const total = pages[pages.length - 1]?.podEnd ?? 0
  const pieces = (shown?.pieces ?? []).map((p) => ({ node: nodes[p.index] ?? '', pods_from: p.to > p.from ? p.from + 1 : 0, pods_to: p.to, pods_of: p.total }))
  const only = nodeFilter !== null ? ` · Node ${nodeFilter}만 보기` : ''
  if (pieces.length === 0) {
    return {
      source: 'ClusterViewNodeBoxes',
      summary: `클러스터 뷰 노드 박스${only} — 이 보기에 그 Node의 Pod가 없음`,
      data: { node_boxes: { node_filter: nodeFilter, pieces } },
    }
  }
  const parts = pieces.map((p) => (p.pods_from === 1 && p.pods_to === p.pods_of ? `${p.node} Pod ${p.pods_of}개` : `${p.node} Pod ${p.pods_from}-${p.pods_to}/${p.pods_of}`))
  return {
    source: 'ClusterViewNodeBoxes',
    summary: `클러스터 뷰 노드 박스 ${page}/${pages.length}쪽${only} — Pod ${total}개 중 ${shown.podStart + 1}-${shown.podEnd}번째: ${parts.join(', ')}`,
    data: {
      node_boxes: {
        pagination: { current_page: page, total_pages: pages.length, page_size: POD_CARDS_PER_PAGE, total_count: total, showing_count: shown.podEnd - shown.podStart },
        node_filter: nodeFilter,
        nodes: pieces.map((p) => p.node),
        pieces,
      },
    },
  }
}
