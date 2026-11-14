import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { Box, Loader2, Search, Server } from 'lucide-react'
import { api, type PodInfo } from '@/services/api'
import { LIST_GATHER_MS, useKubeWatchList } from '@/services/useKubeWatchList'
import { useWritesRefusedIn } from '@/hooks/useCanCreate'
import { usePagedItems } from '@/hooks/usePagedItems'
import { useAIContext } from '@/hooks/useAIContext'
import { ListPager } from '@/components/ListPager'
import { getPodHealth, getHealthIcon } from './podHealth'
import { useClusterView } from './ClusterViewContext'
import { pickMainContainer, podToDetail } from './types'
import { ClusterNodeMap } from './ClusterNodeMap'
import { NODE_BOXES_PER_PAGE, boxPageLayer, boxPageOf, cellsOfPage } from './nodeBoxPages'
import type { NodeEntry } from './hooks/useClusterDerived'

// The node map, then a box per node with its pod cards, NODE_BOXES_PER_PAGE boxes a page in the map's order (the
// footer has no rows-per-page choice: a box can be taller than the screen). The map draws every node and outlines the
// cells of the page shown; a click on a cell opens that node's page and brings its box to the top. Inside the page only
// the boxes near the screen are drawn (TanStack Virtual, window scroll, each box measured once drawn), and a drawn box
// fetches its node's pods and watches them (fieldSelector spec.nodeName) — so the page holds at most a page of nodes'
// pods, and what is on screen changes as soon as the cluster does. The search is counted by the server (the map and
// the boxes listed, paged over the nodes it matched); a box shows its pods the search matches. Click a card → the detail
// window on Logs; right click → the menu.

interface Props {
  entries: NodeEntry[]
  matched: number
  all: number
  isLoading: boolean
  canDeletePod: boolean
}

const SUBSCRIBE_AFTER_MS = 150 // a box scrolled past does not open a watch

export function PodNodeGrid({ entries, matched, all, isLoading, canDeletePod }: Props) {
  const { tr, searchQuery, selectedNamespace } = useClusterView()

  // a new search or namespace starts at the first page; a refresh of the same nodes keeps the page
  const { items: pageEntries, page, totalPages, total, setPage } = usePagedItems(entries, NODE_BOXES_PER_PAGE, `${selectedNamespace}\n${searchQuery.trim()}`)
  const outlined = totalPages > 1 ? cellsOfPage(page, entries.length) : { start: 0, end: 0 }
  // the floating chat is told which page of boxes is shown, and its nodes
  const boxNodes = pageEntries.map((e) => e.node || 'unscheduled')
  useAIContext(boxPageLayer(page, totalPages, total, boxNodes), [page, totalPages, total, boxNodes.join('\n')])
  // the box brought to the top once its page is drawn: a map cell's node, or the first box of a page turned to
  const [scrollTo, setScrollTo] = useState<{ at: number } | null>(null)
  const goTo = (p: number, at: number) => {
    setPage(p)
    setScrollTo({ at })
  }

  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => {
    setScrollMargin(listRef.current?.offsetTop ?? 0)
  }, [searchQuery, entries.length])
  const virtualizer = useWindowVirtualizer({
    count: pageEntries.length,
    // header and padding, then one row of cards per six pods (the server's count); the drawn box is measured
    estimateSize: (i) => 120 + Math.ceil(pageEntries[i].counts.total / 6) * 144,
    overscan: 3,
    scrollMargin,
    getItemKey: (i) => pageEntries[i].node || '~unscheduled',
  })
  useEffect(() => {
    if (!scrollTo || pageEntries.length === 0) return
    virtualizer.scrollToIndex(Math.min(scrollTo.at, pageEntries.length - 1), { align: 'start' })
    setScrollTo(null)
  }, [scrollTo, virtualizer, pageEntries.length])

  return (
    <div className="space-y-6">
      <ClusterNodeMap
        entries={entries}
        tr={tr}
        pageStart={outlined.start}
        pageEnd={outlined.end}
        onSelect={(i) => {
          const at = boxPageOf(i)
          goTo(at.page, at.at)
        }}
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

      {searchQuery && matched === 0 && !isLoading && (
        <div className="card text-center py-12">
          <Search className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400">
            {tr('clusterView.noSearchResults', 'No pods found for "{{query}}"', { query: searchQuery })}
          </p>
        </div>
      )}

      {entries.length > 0 ? (
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
              <NodeBox entry={pageEntries[row.index]} canDeletePod={canDeletePod} />
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
        testId="cluster-view-nodes-pager"
      />
    </div>
  )
}

function NodeBox({ entry, canDeletePod }: { entry: NodeEntry; canDeletePod: boolean }) {
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
  const shown = useMemo(() => {
    const list = Array.isArray(pods) ? pods : []
    // the fields the server's search reads (pods_page.go): name, namespace, node and pod IP — a box found by its node
    // or an IP shows those pods, not none
    return q ? list.filter((pod) => pod.name.toLowerCase().includes(q) || pod.namespace.toLowerCase().includes(q)
      || String(pod.node_name || entry.node).toLowerCase().includes(q) || String(pod.pod_ip || '').toLowerCase().includes(q)) : list
  }, [pods, q, entry.node])

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

  const count = pods ? shown.length : entry.counts.total
  return (
    <div className="card" data-testid="cluster-view-node" data-node={entry.node}>
      <div className="flex items-center gap-3 mb-4">
        <Server className="w-6 h-6 text-slate-400" />
        <h2 className="text-xl font-semibold text-ink">{entry.label}</h2>
        <span className="badge badge-secondary">
          {tr('clusterView.nodePodsCount', '{{count}} Pods', { count })}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
        {pods
          ? shown.map((pod, idx) => {
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
          : Array.from({ length: entry.counts.total }, (_, i) => (
            <div key={i} className="h-[132px] rounded-lg bg-slate-700/50" aria-hidden="true" data-testid="cluster-view-card-placeholder" />
          ))}
      </div>
    </div>
  )
}
