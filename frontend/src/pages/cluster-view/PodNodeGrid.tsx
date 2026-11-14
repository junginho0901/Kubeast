import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { Box, Loader2, Search, Server } from 'lucide-react'
import { api, type PodInfo } from '@/services/api'
import { LIST_GATHER_MS, useKubeWatchList } from '@/services/useKubeWatchList'
import { useWritesRefusedIn } from '@/hooks/useCanCreate'
import { useAIContext } from '@/hooks/useAIContext'
import { ListPager } from '@/components/ListPager'
import { getPodHealth, getHealthIcon } from './podHealth'
import { useClusterView } from './ClusterViewContext'
import { pickMainContainer, podToDetail } from './types'
import { ClusterNodeMap } from './ClusterNodeMap'
import { POD_CARDS_PER_PAGE, boxPageLayer, cellsOfPage, cutBoxPages, shownPage, stateForView, type BoxPage, type BoxPageState, type BoxPiece } from './nodeBoxPages'
import { UNSCHEDULED, type NodeEntry } from './hooks/useClusterDerived'

// The node map, then a box per node with its pod cards, paged by the cards (nodeBoxPages.ts): a page holds about
// POD_CARDS_PER_PAGE cards of the nodes in the map's order, and a node with more pods than are left on a page goes on to
// the next with its header again, so every pod is on a page. The map draws every node and outlines the cells of the
// page shown; a click on a cell narrows the boxes to that node (?node=), paged the same way, until "All nodes" brings
// every node back at that node's page. Inside the page only the boxes near the screen are drawn (TanStack Virtual,
// window scroll, each box measured once drawn), and a drawn box fetches its node's pods and watches them
// (fieldSelector spec.nodeName) — so the page holds at most a page of nodes' pods, and what is on screen changes as soon
// as the cluster does. The search is counted by the server (the map and the boxes listed, paged over the pods it
// matched); a box shows its pods the search matches. Click a card → the detail window on Logs; right click → the menu.

interface Props {
  entries: NodeEntry[]
  matched: number
  all: number
  isLoading: boolean
  canDeletePod: boolean
}

const SUBSCRIBE_AFTER_MS = 150 // a box scrolled past does not open a watch

// What ?node= holds for a box: its node's name, or Unscheduled for the pods no node took (a node's name is lower case).
const keyOf = (e: NodeEntry) => e.node || UNSCHEDULED

// The page shown of the boxes: the first page whenever the view (resetKey) changes, else the page holding the box it
// was turned to (nodeBoxPages.ts shownPage). `land` sets the state of the view to come before the address follows.
function useBoxPage(pages: BoxPage[], entries: NodeEntry[], resetKey: string) {
  const [state, setState] = useState<BoxPageState>({ key: resetKey, page: 1, anchor: null })
  const [seen, setSeen] = useState(resetKey)
  if (seen !== resetKey) {
    setSeen(resetKey)
    const next = stateForView(state, resetKey)
    if (next !== state) setState(next)
  }
  const indexOf = useMemo(() => new Map(entries.map((e, i) => [keyOf(e), i])), [entries])
  const page = shownPage(pages, (node) => indexOf.get(node), state)
  const turnTo = (p: number) => {
    const first = pages[p - 1]?.pieces[0]
    setState({ key: resetKey, page: p, anchor: first && entries[first.index] ? { node: keyOf(entries[first.index]), pod: first.from } : null })
  }
  const land = (key: string, node: string) => setState({ key, page: 1, anchor: { node, pod: 0 } })
  return { page, turnTo, land }
}

export function PodNodeGrid({ entries, matched, all, isLoading, canDeletePod }: Props) {
  const { tr, searchQuery, selectedNamespace, nodeFilter, setNodeFilter } = useClusterView()

  // the boxes: every node, or the one a map cell narrowed them to
  const boxEntries = useMemo(() => (nodeFilter === null ? entries : entries.filter((e) => keyOf(e) === nodeFilter)), [entries, nodeFilter])
  const pages = useMemo(() => cutBoxPages(boxEntries.map((e) => e.counts.total)), [boxEntries])
  const keyFor = (filter: string | null) => `${selectedNamespace}\n${searchQuery.trim()}\n${filter ?? ''}`
  const resetKey = keyFor(nodeFilter)
  const { page, turnTo, land } = useBoxPage(pages, boxEntries, resetKey)
  const shown = pages[page - 1]
  const pieces = shown.pieces
  const totalPods = pages[pages.length - 1].podEnd
  const filteredAt = nodeFilter === null ? -1 : entries.findIndex((e) => keyOf(e) === nodeFilter)
  const outlined = nodeFilter !== null
    ? (filteredAt >= 0 ? { start: filteredAt, end: filteredAt + 1 } : { start: 0, end: 0 })
    : pages.length > 1 ? cellsOfPage(shown) : { start: 0, end: 0 }

  // the floating chat is told which page of boxes is shown, the pods of each box on it and the node filter
  const layer = boxPageLayer(pages, page, boxEntries.map((e) => e.node || 'unscheduled'), nodeFilter)
  useAIContext(layer, [JSON.stringify(layer)])

  // where to scroll once the page asked for is drawn: a box (by its node; null = the first) or the node filter's line
  const [scrollTo, setScrollTo] = useState<{ key: string; node: string | null; bar?: boolean } | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const paged = pages.length > 1 // the page's line above the boxes
  useLayoutEffect(() => {
    setScrollMargin(listRef.current?.offsetTop ?? 0)
  }, [searchQuery, entries.length, nodeFilter, paged])
  const virtualizer = useWindowVirtualizer({
    count: pieces.length,
    // header and padding, then one row of cards per six pods of the piece; the drawn box is measured
    estimateSize: (i) => 120 + Math.ceil((pieces[i].to - pieces[i].from) / 6) * 144,
    overscan: 3,
    scrollMargin,
    getItemKey: (i) => `${keyOf(boxEntries[pieces[i].index])}#${pieces[i].from}`,
  })
  useEffect(() => {
    if (!scrollTo || scrollTo.key !== resetKey) return
    setScrollTo(null)
    if (scrollTo.bar) {
      barRef.current?.scrollIntoView({ block: 'start' })
      return
    }
    if (pieces.length === 0) return
    const at = scrollTo.node === null ? 0 : Math.max(0, pieces.findIndex((p) => keyOf(boxEntries[p.index]) === scrollTo.node))
    virtualizer.scrollToIndex(at, { align: 'start' })
  }, [scrollTo, resetKey, pieces, boxEntries, virtualizer])

  const showNode = (i: number) => {
    const node = keyOf(entries[i])
    setNodeFilter(node)
    setScrollTo({ key: keyFor(node), node, bar: true })
  }
  const showAll = () => {
    if (nodeFilter === null) return
    const key = keyFor(null)
    land(key, nodeFilter)
    setNodeFilter(null)
    setScrollTo({ key, node: nodeFilter })
  }
  const filteredLabel = nodeFilter === null ? '' : (entries[filteredAt]?.label ?? nodeFilter)

  return (
    <div className="space-y-6">
      <ClusterNodeMap
        entries={entries}
        tr={tr}
        pageStart={outlined.start}
        pageEnd={outlined.end}
        onSelect={showNode}
      />

      {searchQuery && (
        <div className="text-sm text-slate-400" data-testid="cluster-view-search-count">
          {tr('clusterView.searchResults', 'Results')}:{' '}
          <span className="text-ink font-medium">{matched}</span>{' '}
          {tr('clusterView.countSuffix', 'items')}
          {matched !== all && (
            <span className="ml-2">
              {tr('clusterView.searchResultsTotal', '(out of {{count}})', { count: all })}
            </span>
          )}
        </div>
      )}

      {nodeFilter !== null && (
        <div ref={barRef} className="card flex flex-wrap items-center justify-between gap-3 py-3 scroll-mt-20" data-testid="cluster-view-node-filter" data-node={nodeFilter}>
          <span className="text-sm text-ink">
            {filteredAt >= 0
              ? tr('clusterView.nodeFilter.on', 'Showing Node {{node}} only.', { node: filteredLabel })
              : tr('clusterView.nodeFilter.none', 'Node {{node}} has no Pods in this view.', { node: filteredLabel })}
          </span>
          <button type="button" className="btn-row" onClick={showAll} data-testid="cluster-view-node-filter-all">
            {tr('clusterView.nodeFilter.all', 'All nodes')}
          </button>
        </div>
      )}

      {searchQuery && matched === 0 && !isLoading && (
        <div className="card text-center py-12">
          <Search className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400">
            {tr('clusterView.noSearchResults', 'No pods found for "{{query}}"', { query: searchQuery })}
          </p>
        </div>
      )}

      {paged && (
        <div className="text-xs text-slate-400" data-testid="cluster-view-page-nodes">
          {tr('clusterView.pageNodes', 'Page {{page}} of {{pages}}: Nodes {{first}}–{{last}} of {{nodes}}.', {
            page, pages: pages.length, first: pieces[0].index + 1, last: pieces[pieces.length - 1].index + 1, nodes: boxEntries.length,
          })}
        </div>
      )}

      {boxEntries.length > 0 ? (
        <div
          ref={listRef}
          style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          data-testid="cluster-view-nodes"
          data-list="node boxes"
        >
          {virtualizer.getVirtualItems().map((row) => (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className={`absolute left-0 top-0 w-full ${row.index < pieces.length - 1 ? 'pb-6' : ''}`}
              style={{ transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }}
            >
              <NodeBox entry={boxEntries[pieces[row.index].index]} piece={pieces[row.index]} canDeletePod={canDeletePod} />
            </div>
          ))}
        </div>
      ) : (
        !searchQuery && !isLoading && nodeFilter === null && (
          <div className="card text-center py-12">
            <Box className="w-12 h-12 text-slate-600 mx-auto mb-4" />
            <p className="text-slate-400">{tr('clusterView.noPods', 'No pods found')}</p>
          </div>
        )
      )}

      <ListPager
        currentPage={page}
        totalPages={pages.length}
        total={totalPods}
        rowsPerPage={POD_CARDS_PER_PAGE}
        range={{ start: shown.podStart + 1, end: shown.podEnd }}
        onPageChange={(p) => {
          turnTo(p)
          setScrollTo({ key: resetKey, node: null })
        }}
        showPageSize={false}
        testId="cluster-view-nodes-pager"
      />
    </div>
  )
}

// A node's box, or its piece on this page: pods [piece.from, piece.to) of the node's pods by namespace and name, the
// last piece taking whatever is left (a pod the watch brought before the map's next count is not left out).
export function NodeBox({ entry, piece, canDeletePod }: { entry: NodeEntry; piece: BoxPiece; canDeletePod: boolean }) {
  const writesRefused = useWritesRefusedIn()
  const {
    tr,
    selectedNamespace,
    searchQuery,
    deletingPods,
    setDeletingPods,
    setSelectedPod,
    setSelectedContainer,
    selectTab,
    setContainerSearchQuery,
    setPodContextMenu,
  } = useClusterView()

  const [active, setActive] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setActive(true), SUBSCRIBE_AFTER_MS)
    return () => clearTimeout(id)
  }, [])

  const namespace = selectedNamespace === 'all' ? undefined : selectedNamespace
  const queryKey = useMemo(() => ['cluster-view', 'node-pods', entry.node, namespace ?? 'all'], [entry.node, namespace])
  const { data: pods } = useQuery({
    queryKey,
    queryFn: () => api.getPodsOnNode(entry.node, namespace),
    enabled: active,
    staleTime: 10_000,
  })
  useKubeWatchList({
    enabled: active,
    queryKey,
    path: namespace ? `/api/v1/namespaces/${namespace}/pods` : '/api/v1/pods',
    query: `watch=1&fieldSelector=${encodeURIComponent(`spec.nodeName=${entry.node}`)}`,
    gatherEveryMs: LIST_GATHER_MS,
  })

  // a pod being deleted keeps its mark until it leaves this node's list
  const prevKeys = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!pods) return
    const keys = new Set(pods.map((p) => `${p.namespace}/${p.name}`))
    const prev = prevKeys.current
    prevKeys.current = keys
    if (!prev) return
    const gone = [...prev].filter((k) => !keys.has(k))
    if (gone.length === 0) return
    setDeletingPods((marks) => {
      if (!gone.some((k) => marks.has(k))) return marks
      const next = new Set(marks)
      gone.forEach((k) => next.delete(k))
      return next
    })
  }, [pods, setDeletingPods])

  const q = searchQuery.trim().toLowerCase()
  const ordered = useMemo(() => {
    const list = Array.isArray(pods) ? pods : []
    // the fields the server's search reads (pods_page.go): name, namespace, node and pod IP — a box found by its node
    // or an IP shows those pods, not none
    const found = q ? list.filter((pod) => pod.name.toLowerCase().includes(q) || pod.namespace.toLowerCase().includes(q)
      || String(pod.node_name || entry.node).toLowerCase().includes(q) || String(pod.pod_ip || '').toLowerCase().includes(q)) : list
    // one order for every piece of the box, whatever order the read and the watch bring them in
    const by = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
    return [...found].sort((a, b) => by(a.namespace, b.namespace) || by(a.name, b.name))
  }, [pods, q, entry.node])
  const last = piece.to >= piece.total
  const drawn = useMemo(() => ordered.slice(piece.from, last ? undefined : piece.to), [ordered, piece.from, piece.to, last])

  const handlePodClick = (pod: any) => {
    const detail = podToDetail(pod)
    setSelectedPod(detail)
    setSelectedContainer(pickMainContainer(pod))
    setContainerSearchQuery('')
    selectTab('logs')
  }

  const handlePodContextMenu = (event: React.MouseEvent, pod: PodInfo) => {
    if (!canDeletePod || writesRefused(pod.namespace)) return
    event.preventDefault()
    setPodContextMenu({ x: event.clientX, y: event.clientY, pod })
  }

  const count = pods ? ordered.length : entry.counts.total
  // a node split over pages says which of its pods this piece holds and whether more follow
  const split = piece.from > 0 || !last
  const partValues = pods
    ? { from: piece.from + 1, to: piece.from + drawn.length, total: ordered.length }
    : { from: piece.from + 1, to: piece.to, total: piece.total }
  const partKey = piece.from === 0 ? 'first' : last ? 'last' : 'middle'
  const partText = {
    first: tr('clusterView.part.first', 'Pods {{from}}–{{to}} of {{total}} · continues on the next page', partValues),
    middle: tr('clusterView.part.middle', 'Continued: Pods {{from}}–{{to}} of {{total}} · continues on the next page', partValues),
    last: tr('clusterView.part.last', 'Continued: Pods {{from}}–{{to}} of {{total}}', partValues),
  }[partKey]
  return (
    <div className="card" data-testid="cluster-view-node" data-node={entry.node} data-pods={split ? `${partValues.from}-${partValues.to}/${partValues.total}` : undefined}>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Server className="w-6 h-6 text-slate-400" />
        <h2 className="text-xl font-semibold text-ink">{entry.label}</h2>
        <span className="badge badge-secondary">
          {tr('clusterView.nodePodsCount', '{{count}} Pods', { count })}
        </span>
        {split && (!pods || drawn.length > 0) && (
          <span className="text-xs text-slate-400" data-testid="cluster-view-node-part">{partText}</span>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
        {pods
          ? drawn.map((pod, idx) => {
            const podKey = `${pod.namespace}/${pod.name}`
            const isDeleting = deletingPods.has(podKey)
            const health = getPodHealth(pod)
            return (
              <button
                key={`${pod.namespace}-${pod.name}-${idx}`}
                onClick={() => handlePodClick(pod)}
                onContextMenu={(event) => {
                  if (!isDeleting) handlePodContextMenu(event, pod)
                }}
                disabled={isDeleting}
                className={`p-3 bg-slate-700 rounded-lg transition-colors text-left ${
                  isDeleting ? 'opacity-60 cursor-not-allowed' : 'hover:bg-slate-600'
                }`}
              >
                <div className="flex items-start justify-between mb-2">
                  <Box className="w-4 h-4 text-slate-400 shrink-0" />
                  {isDeleting ? (
                    <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
                  ) : (
                    getHealthIcon(health.level, health.reason)
                  )}
                </div>
                <div className="text-sm font-medium text-ink truncate" title={pod.name}>
                  {pod.name}
                </div>
                <div title={pod.namespace} className="text-xs text-slate-300 mt-1">{pod.namespace}</div>
                <div className={`text-xs mt-1 min-h-[16px] ${isDeleting ? 'text-amber-400' : 'text-slate-300'}`}>
                  {isDeleting ? tr('clusterView.podDeleting', 'Deleting...') : health.reason}
                </div>
                <div className="text-xs text-yellow-400 mt-1 min-h-[16px]">
                  {pod.restart_count > 0 &&
                    tr('clusterView.restarts', 'Restarts: {{count}}', { count: pod.restart_count })}
                </div>
              </button>
            )
          })
          : Array.from({ length: piece.to - piece.from }, (_, i) => (
            <div key={i} className="h-[132px] rounded-lg bg-slate-700/50" aria-hidden="true" data-testid="cluster-view-card-placeholder" />
          ))}
      </div>
    </div>
  )
}
