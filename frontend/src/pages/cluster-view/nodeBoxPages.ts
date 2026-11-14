// The node boxes under the map are paged at a fixed size: a box holds a node's pod cards and can be taller than the
// screen, so the page scrolls on purpose and the footer offers no rows-per-page choice (as GPU's Node allocation).
// The map draws every node; a page is the boxes of NODE_BOXES_PER_PAGE cells in the map's order.
export const NODE_BOXES_PER_PAGE = 10

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
