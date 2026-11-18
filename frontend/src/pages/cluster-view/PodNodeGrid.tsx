import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { Box, Loader2, Search, Server } from 'lucide-react'
import { api, type NodeBoxRow } from '@/services/api'
import { LIST_GATHER_MS, useKubeWatchList } from '@/services/useKubeWatchList'
import { useWritesRefusedIn } from '@/hooks/useCanCreate'
import { useAIContext } from '@/hooks/useAIContext'
import { ListPager } from '@/components/ListPager'
import { nodeStatusBadge, nodeStatusParts } from '@/utils/nodeStatus'
import { boxPodHealth, getHealthIcon } from './podHealth'
import { useClusterView } from './ClusterViewContext'
import { openPodWindow } from './podDetailRead'
import { ClusterNodeMap } from './ClusterNodeMap'
import {
  BOX_PREVIEW_CARDS, NODE_BOXES_PER_PAGE, NODE_PODS_PER_PAGE, boxPageLayer, boxPageOf, cellsOfPage, followedPage, keptOverview, nameOrder,
  nodeMissingLayer, nodePageOf, nodeViewLayer, nodeViewPage, overviewPage, podKey, previewOrder, searchStart, shownPageAddress, type NodeViewAnswer,
  type OverviewPageState,
} from './nodeBoxPages'
import { UNSCHEDULED, type NodeEntry } from './hooks/useClusterDerived'
import type { ClusterViewNode } from './hooks/useClusterPodsQuery'

// The node map, then the overview: a box per node, NODE_BOXES_PER_PAGE boxes a page in the map's order, each drawing
// at most BOX_PREVIEW_CARDS pod cards (problems first) and "show all" for the rest. A click on a map cell or on "show
// all" opens the node's own view (?node=, ?nodePage=): the map stays with that cell outlined, "All nodes" goes back,
// and the node's pods are paged by name, NODE_PODS_PER_PAGE a page, with "Problem pods only" — so every pod is on a
// page of Cluster View. In the overview only the boxes near the screen are drawn (TanStack Virtual, window scroll,
// each box measured once drawn), and a drawn box fetches its node's pods and watches them (fieldSelector
// spec.nodeName) — so the page holds at most a page of nodes' pods. The search is counted by the server (the map fades
// the nodes with no match, the boxes listed are the nodes it matched, each showing its matching pods); the node's own
// view outlines the matching cards and opens on the page of the first. Click a card → the detail window on Logs;
// right click → the menu.

interface Props {
  entries: NodeEntry[]
  matched: number
  all: number
  isLoading: boolean
  canDeletePod: boolean
  /** the live node list (name, roles, STATUS); undefined while it is not read */
  nodeList?: ClusterViewNode[]
}

const SUBSCRIBE_AFTER_MS = 150 // a box scrolled past does not open a watch

// What ?node= holds for a box: its node's name, or Unscheduled for the pods no node took (a node's name is lower case).
const keyOf = (e: NodeEntry) => e.node || UNSCHEDULED

// The fields the server's search reads (pods_page.go): name, namespace, node and pod IP.
const podMatches = (pod: NodeBoxRow, q: string, node: string) => pod.name.toLowerCase().includes(q) || pod.namespace.toLowerCase().includes(q)
  || String(pod.node_name || node).toLowerCase().includes(q) || String(pod.pod_ip || '').toLowerCase().includes(q)

export function PodNodeGrid({ entries, matched, all, isLoading, canDeletePod, nodeList }: Props) {
  const { tr, searchQuery, selectedNamespace, nodeView, openNodeView, closeNodeView } = useClusterView()

  // the boxes are the nodes with a pod (that the search matched); a faded cell has no box
  const listed = useMemo(() => entries.filter((e) => !e.dim), [entries])
  // a new search or namespace starts at the first page; otherwise the page shown holds the box it was turned to (its
  // first box), so a node added or removed before it does not move the view (overviewPage)
  const resetKey = `${selectedNamespace}\n${searchQuery.trim()}`
  const [overview, setOverview] = useState<OverviewPageState & { key: string }>({ key: resetKey, page: 1, anchor: null })
  if (overview.key !== resetKey) setOverview({ key: resetKey, page: 1, anchor: null })
  const keys = useMemo(() => listed.map(keyOf), [listed])
  const page = overviewPage(keys, overview.key === resetKey ? overview : { page: 1, anchor: null })
  const kept = overview.key === resetKey ? keptOverview(keys, overview, page) : null
  if (kept) setOverview({ key: resetKey, ...kept })
  const total = listed.length
  const totalPages = Math.max(1, Math.ceil(total / NODE_BOXES_PER_PAGE))
  const pageEntries = listed.slice((page - 1) * NODE_BOXES_PER_PAGE, page * NODE_BOXES_PER_PAGE)
  const setPage = (p: number) => setOverview({ key: resetKey, page: p, anchor: keys[(p - 1) * NODE_BOXES_PER_PAGE] ?? null })
  const q = searchQuery.trim()

  const viewAt = nodeView ? entries.findIndex((e) => keyOf(e) === nodeView.node) : -1
  const listedNode = nodeView ? nodeList?.find((n) => n.name === nodeView.node) : undefined
  const viewEntry: NodeEntry | null = !nodeView ? null : viewAt >= 0 ? entries[viewAt] : {
    node: nodeView.node === UNSCHEDULED ? '' : nodeView.node,
    label: nodeView.node,
    counts: { node: nodeView.node, total: 0, ok: 0, warn: 0, error: 0 },
    status: listedNode?.status,
  }
  // a node the cluster does not list (a link of another cluster): said so, nothing read for it
  const missing = !!nodeView && viewAt < 0 && nodeView.node !== UNSCHEDULED && nodeList !== undefined && !listedNode
  // the outlined cells: the node's own view's, else the boxes of the page shown while there is more than one
  const pageCells = cellsOfPage(page, listed.length)
  const outlined = nodeView
    ? (viewAt >= 0 ? { start: viewAt, end: viewAt + 1 } : { start: 0, end: 0 })
    : totalPages > 1 && pageEntries.length > 0
      ? { start: entries.indexOf(listed[pageCells.start]), end: entries.indexOf(listed[pageCells.end - 1]) + 1 }
      : { start: 0, end: 0 }

  // the floating chat is told which page of boxes is shown and how many of each box's pods it draws
  const boxes = pageEntries.map((e) => ({ node: e.node || 'unscheduled', shown: Math.min(e.counts.total, BOX_PREVIEW_CARDS), total: e.counts.total, status: e.status }))
  const layer = missing ? nodeMissingLayer(nodeView!.node) : nodeView ? null : boxPageLayer(page, totalPages, total, boxes, q)
  useAIContext(layer, [JSON.stringify(layer)])

  // the path line comes on screen when a box's "show all" opens a node's own view or one of its pages is turned to
  const navRef = useRef<HTMLElement>(null)
  const [navScroll, setNavScroll] = useState(false)
  useEffect(() => {
    if (!navScroll || !nodeView || !navRef.current) return
    navRef.current.scrollIntoView({ block: 'nearest' })
    setNavScroll(false)
  }, [navScroll, nodeView])

  // the box brought to the top once its page is drawn: back from a node's own view, or the first box of a page turned to
  const [scrollTo, setScrollTo] = useState<{ at: number } | null>(null)
  const goTo = (p: number, at: number) => {
    setPage(p)
    setScrollTo({ at })
  }
  const back = () => {
    const at = viewEntry ? listed.findIndex((e) => keyOf(e) === keyOf(viewEntry)) : -1
    closeNodeView()
    if (at >= 0) {
      const box = boxPageOf(at)
      goTo(box.page, box.at)
    }
  }

  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => {
    setScrollMargin(listRef.current?.offsetTop ?? 0)
  }, [searchQuery, entries.length, nodeView])
  const virtualizer = useWindowVirtualizer({
    count: pageEntries.length,
    // header and padding, then one row of cards per six pods the box draws; the drawn box is measured
    estimateSize: (i) => 120 + Math.ceil(Math.min(pageEntries[i].counts.total, BOX_PREVIEW_CARDS) / 6) * 144,
    overscan: 3,
    scrollMargin,
    getItemKey: (i) => pageEntries[i].node || '~unscheduled',
  })
  useEffect(() => {
    if (!scrollTo || nodeView || pageEntries.length === 0) return
    virtualizer.scrollToIndex(Math.min(scrollTo.at, pageEntries.length - 1), { align: 'start' })
    setScrollTo(null)
  }, [scrollTo, nodeView, virtualizer, pageEntries.length])

  return (
    <div className="space-y-6">
      <ClusterNodeMap
        entries={entries}
        tr={tr}
        pageStart={outlined.start}
        pageEnd={outlined.end}
        nodeList={nodeList}
        onSelect={(i) => openNodeView(keyOf(entries[i]))}
        onOpenNode={(name) => openNodeView(name)}
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

      {viewEntry ? (
        <>
          <nav ref={navRef} className="flex flex-wrap items-center gap-2 text-sm scroll-mt-20" aria-label={tr('clusterView.nodeView.path', 'Cluster View path')} data-testid="cluster-view-node-view">
            <button type="button" className="btn-row" onClick={back} data-testid="cluster-view-all-nodes">
              {tr('clusterView.nodeView.all', 'All Nodes')}
            </button>
            <span className="text-slate-500" aria-hidden="true">/</span>
            <span className="text-ink font-medium" data-testid="cluster-view-node-view-name">{viewEntry.label}</span>
          </nav>
          {missing ? (
            <div className="card text-sm text-slate-300" data-testid="cluster-view-node-missing">
              {tr('clusterView.nodeView.missing', 'Node {{node}} is not in this cluster.', { node: viewEntry.label })}
            </div>
          ) : (
            <NodeBox key={keyOf(viewEntry)} entry={viewEntry} canDeletePod={canDeletePod} mode="all" onNavigate={() => setNavScroll(true)} />
          )}
        </>
      ) : (
        <>
          {searchQuery && matched === 0 && !isLoading && (
            <div className="card text-center py-12">
              <Search className="w-12 h-12 text-slate-600 mx-auto mb-4" />
              <p className="text-slate-400">
                {tr('clusterView.noSearchResults', 'No pods found for "{{query}}"', { query: searchQuery })}
              </p>
            </div>
          )}

          {listed.length > 0 ? (
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
                  className={`absolute left-0 top-0 w-full ${row.index < pageEntries.length - 1 ? 'pb-6' : ''}`}
                  style={{ transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }}
                >
                  <NodeBox entry={pageEntries[row.index]} canDeletePod={canDeletePod} mode="preview" onNavigate={() => setNavScroll(true)} />
                </div>
              ))}
            </div>
          ) : (
            !searchQuery && !isLoading && (
              <div className="card text-center py-12">
                <Box className="w-12 h-12 text-slate-600 mx-auto mb-4" />
                <p className="text-slate-400">{tr('clusterView.noPods', 'No pods found')}</p>
              </div>
            )
          )}

          <ListPager
            currentPage={page}
            totalPages={totalPages}
            total={total}
            rowsPerPage={NODE_BOXES_PER_PAGE}
            onPageChange={(p) => goTo(p, 0)}
            showPageSize={false}
            endsPage
            testId="cluster-view-nodes-pager"
          />
        </>
      )}
    </div>
  )
}

// A node's box. In the overview (`preview`) it draws at most BOX_PREVIEW_CARDS of its pods — those the search matches,
// problems first — and opens the node's own view for the rest; in the node's own view (`all`) it draws a page of its
// pods by name, the search's matches outlined, with "Problem pods only" and the footer under it.
export function NodeBox({ entry, canDeletePod, mode, onNavigate }: { entry: NodeEntry; canDeletePod: boolean; mode: 'preview' | 'all'; onNavigate?: () => void }) {
  const writesRefused = useWritesRefusedIn()
  const {
    tr,
    selectedNamespace,
    searchQuery,
    deletingPods,
    setDeletingPods,
    setSelectedPod,
    setSelectedContainer,
    setExecContainer,
    selectTab,
    setContainerSearchQuery,
    setPodContextMenu,
    nodeView,
    openNodeView,
    setNodeViewPage,
    moveNodeView,
  } = useClusterView()

  const [active, setActive] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setActive(true), SUBSCRIBE_AFTER_MS)
    return () => clearTimeout(id)
  }, [])

  const namespace = selectedNamespace === 'all' ? undefined : selectedNamespace
  const queryKey = useMemo(() => ['cluster-view', 'node-pods', entry.node, namespace ?? 'all'], [entry.node, namespace])
  // the box's rows, which its live frames replace with the pods' full rows as they change
  const { data: pods } = useQuery<NodeBoxRow[]>({
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
  const list = useMemo(() => (Array.isArray(pods) ? pods : []), [pods])
  const matches = (pod: NodeBoxRow) => q !== '' && podMatches(pod, q, entry.node)

  // the overview: the pods the search matches (all without one), problems first, the first BOX_PREVIEW_CARDS drawn
  const found = useMemo(() => (q ? list.filter((pod) => podMatches(pod, q, entry.node)) : list), [list, q, entry.node])
  const preview = useMemo(() => previewOrder(found, (pod) => boxPodHealth(pod).level).slice(0, BOX_PREVIEW_CARDS), [found])

  // the node's own view: every pod by name (problems only when asked), a page of NODE_PODS_PER_PAGE that follows the pod
  // a search opened it on (nodeViewPage); a pod coming or going moves at most a card or two over a page's edge
  const [problemsOnly, setProblemsOnly] = useState(false)
  const ordered = useMemo(() => nameOrder(problemsOnly ? list.filter((pod) => boxPodHealth(pod).level !== 'ok') : list), [list, problemsOnly])
  const orderedKeys = useMemo(() => ordered.map(podKey), [ordered])
  const focus = mode === 'all' && pods ? nodeView?.pod ?? null : null
  const shownPage = nodeViewPage(orderedKeys, { page: nodeView?.page ?? null, pod: focus }, q ? ordered.findIndex((pod) => podMatches(pod, q, entry.node)) : -1)
  // the opened pod not shown: the namespace filter leaves its namespace out, or it left the node
  const focusNamespace = focus?.split('/')[0] ?? ''
  const focusHidden: false | 'gone' | 'filtered' = !shownPage.gone ? false : selectedNamespace !== 'all' && focusNamespace !== selectedNamespace ? 'filtered' : 'gone'
  // the matches among the cards this view can show (Problem pods only counts within the problems)
  const matchCount = q ? ordered.filter((pod) => podMatches(pod, q, entry.node)).length : 0
  const viewLayer = mode === 'all' && pods
    ? nodeViewLayer({
      node: entry.node || 'unscheduled', page: shownPage.page, totalPages: shownPage.totalPages, start: shownPage.start, end: shownPage.end,
      total: ordered.length, problemsOnly, search: searchQuery.trim(), matches: matchCount,
      pods: orderedKeys.slice(shownPage.start, shownPage.end), focus, gone: focusHidden, status: entry.status,
    })
    : null
  useAIContext(viewLayer, [JSON.stringify(viewLayer)])

  // following the opened pod, the address keeps its page, so the page shown last is the one kept if it then goes;
  // following none, a page asked past the last is written as the page shown when the list shrank under it within the
  // same read (lastAnswer: the query key and Problem pods only), not when another namespace or that toggle is chosen
  const read = [...queryKey, problemsOnly ? 'problems' : 'all'].join('\n')
  const lastAnswer = useRef<NodeViewAnswer | null>(null)
  const follow = mode === 'all' && nodeView ? followedPage({ page: nodeView.page, pod: focus }, shownPage) : null
  const kept = follow ?? (mode === 'all' && nodeView && pods ? shownPageAddress(nodeView, shownPage, read, lastAnswer.current) : null)
  const keptPage = kept?.page
  const keptPod = kept?.pod
  useEffect(() => {
    if (keptPage !== undefined) moveNodeView({ page: keptPage, pod: keptPod })
  }, [keptPage, keptPod, moveNodeView])
  const answered = mode === 'all' && !!nodeView && !!pods
  useEffect(() => {
    if (answered) lastAnswer.current = { read, page: shownPage.page }
  }, [answered, read, shownPage.page])

  // a search typed in this view goes to the page of its first match, that pod followed; cleared, it follows nothing
  const searched = useRef(q)
  useEffect(() => {
    if (mode !== 'all' || !pods || searched.current === q) return
    searched.current = q
    const start = q ? searchStart(ordered, (pod) => podMatches(pod, q, entry.node)) : null
    moveNodeView(start ?? { page: shownPage.page })
  }, [mode, pods, q, ordered, entry.node, shownPage.page, moveNodeView])

  // a row without containers (the box's read) opens the window, which reads the pod before Logs opens (podDetailRead)
  const handlePodClick = (pod: NodeBoxRow) => openPodWindow(pod, 'logs', { setSelectedPod, setSelectedContainer, setContainerSearchQuery, setExecContainer, selectTab })

  const handlePodContextMenu = (event: React.MouseEvent, pod: NodeBoxRow) => {
    if (!canDeletePod || writesRefused(pod.namespace)) return
    event.preventDefault()
    setPodContextMenu({ x: event.clientX, y: event.clientY, pod })
  }

  const card = (pod: NodeBoxRow, idx: number) => {
    const key = podKey(pod)
    const isDeleting = deletingPods.has(key)
    const health = boxPodHealth(pod)
    const hit = mode === 'all' && matches(pod)
    const focused = focus !== null && key === focus
    return (
      <button
        key={`${pod.namespace}-${pod.name}-${idx}`}
        data-testid="cluster-view-pod"
        data-match={hit ? 'true' : undefined}
        data-focus={focused ? 'true' : undefined}
        onClick={() => handlePodClick(pod)}
        onContextMenu={(event) => {
          if (!isDeleting) handlePodContextMenu(event, pod)
        }}
        disabled={isDeleting}
        className={`p-3 bg-slate-700 rounded-lg transition-colors text-left ${focused ? 'ring-2 ring-primary-400' : hit ? 'ring-1 ring-primary-400' : ''} ${
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
  }
  const placeholders = (n: number) => Array.from({ length: n }, (_, i) => (
    <div key={i} className="h-[132px] rounded-lg bg-slate-700/50" aria-hidden="true" data-testid="cluster-view-card-placeholder" />
  ))
  const grid = 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3'
  // the node's STATUS parts but Ready, as the Nodes list draws them (NotReady, Unknown, SchedulingDisabled)
  const statusBadges = nodeStatusParts(entry.status).filter((part) => part !== 'Ready').map((part) => (
    <span key={part} className={`badge ${nodeStatusBadge(part)}`} data-testid="cluster-view-node-status">{part}</span>
  ))

  if (mode === 'preview') {
    const count = pods ? found.length : entry.counts.total
    const hidden = count - Math.min(count, BOX_PREVIEW_CARDS)
    // the search opens the node's own view on its first match (by name), which the page then follows
    const openAll = () => {
      const byName = nameOrder(list)
      const first = q && pods ? byName.findIndex((pod) => podMatches(pod, q, entry.node)) : -1
      openNodeView(keyOf(entry), first >= 0 ? { page: nodePageOf(first), pod: podKey(byName[first]) } : undefined)
      onNavigate?.()
    }
    return (
      <div className="card" data-testid="cluster-view-node" data-node={entry.node}>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Server className="w-6 h-6 text-slate-400" />
          <h2 className="text-xl font-semibold text-ink">{entry.label}</h2>
          <span className="badge badge-secondary">
            {tr('clusterView.nodePodsCount', '{{count}} Pods', { count })}
          </span>
          {statusBadges}
          {hidden > 0 && (
            <span className="text-xs text-slate-400" data-testid="cluster-view-node-shown">
              {tr('clusterView.box.shown', 'Showing {{shown}} of {{total}} Pods', { shown: count - hidden, total: count })}
            </span>
          )}
          {(hidden > 0 || q !== '') && (
            <button type="button" className="btn-row ml-auto" onClick={openAll} data-testid="cluster-view-node-more">
              {hidden > 0 && q !== ''
                ? tr('clusterView.box.moreMatching', '+{{count}} matching · show all Pods on this Node', { count: hidden })
                : hidden > 0
                  ? tr('clusterView.box.more', '+{{count}} show all on this Node', { count: hidden })
                  : tr('clusterView.box.open', 'Show all Pods on this Node')}
            </button>
          )}
        </div>
        <div className={grid} data-list-bounded={`at most ${BOX_PREVIEW_CARDS} pod cards; the node's own view pages the rest`}>
          {pods ? preview.map(card) : placeholders(Math.min(count, BOX_PREVIEW_CARDS))}
        </div>
      </div>
    )
  }

  const drawn = ordered.slice(shownPage.start, shownPage.end)
  return (
    <>
      <div className="card" data-testid="cluster-view-node" data-node={entry.node}>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Server className="w-6 h-6 text-slate-400" />
          <h2 className="text-xl font-semibold text-ink">{entry.label}</h2>
          <span className="badge badge-secondary">
            {tr('clusterView.nodePodsCount', '{{count}} Pods', { count: pods ? list.length : entry.counts.total })}
          </span>
          {statusBadges}
          {focusHidden && focus !== null && (
            <span className="text-xs text-amber-300" data-testid="cluster-view-node-pod-gone" data-reason={focusHidden}>
              {focusHidden === 'filtered'
                ? tr('clusterView.nodeView.filtered', 'Pod {{pod}} is outside the namespace filter ({{namespace}}).', { pod: focus, namespace: selectedNamespace })
                : tr('clusterView.nodeView.gone', 'Pod {{pod}} is no longer on this Node; a search finds it if it runs on another.', { pod: focus })}
            </span>
          )}
          {q !== '' && pods && (
            <span className="text-xs text-slate-400" data-testid="cluster-view-node-matches">
              {tr('clusterView.nodeView.matches', 'Pods matching "{{query}}" are outlined: {{count}} on this Node.', { query: searchQuery.trim(), count: matchCount })}
            </span>
          )}
          <label className="ml-auto inline-flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={problemsOnly}
              onChange={(event) => {
                setProblemsOnly(event.target.checked)
                setNodeViewPage(1)
                onNavigate?.()
              }}
              data-testid="cluster-view-problems-only"
            />
            {tr('clusterView.nodeView.problemsOnly', 'Problem Pods only')}
          </label>
        </div>
        {pods && ordered.length === 0 ? (
          <p className="text-sm text-slate-400" data-testid="cluster-view-node-empty">
            {problemsOnly ? tr('common.noSearchResults', 'No results found.') : tr('common.listEmpty', 'No items.')}
          </p>
        ) : (
          <div className={grid} data-list="node pods">
            {pods ? drawn.map(card) : placeholders(Math.min(entry.counts.total, NODE_PODS_PER_PAGE))}
          </div>
        )}
      </div>
      <ListPager
        currentPage={shownPage.page}
        totalPages={shownPage.totalPages}
        total={ordered.length}
        rowsPerPage={NODE_PODS_PER_PAGE}
        onPageChange={(p) => {
          setNodeViewPage(p)
          onNavigate?.()
        }}
        showPageSize={false}
        endsPage
        testId="cluster-view-node-pods-pager"
      />
    </>
  )
}
