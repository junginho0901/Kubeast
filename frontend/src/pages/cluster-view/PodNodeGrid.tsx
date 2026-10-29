import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { Box, Loader2, Search, Server } from 'lucide-react'
import { api, type PodInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { getPodHealth, getHealthIcon } from './podHealth'
import { useClusterView } from './ClusterViewContext'
import { pickMainContainer, podToDetail } from './types'
import { ClusterNodeMap } from './ClusterNodeMap'
import type { NodeEntry } from './hooks/useClusterDerived'

// The node map, then a box per node with its pod cards. The boxes scroll as one page but only those near the screen
// are drawn (TanStack Virtual, window scroll, each box measured once drawn), and a drawn box fetches its node's pods and
// watches them (fieldSelector spec.nodeName) — so the page holds the pods on screen, not the cluster's, and what is on
// screen changes as soon as the cluster does. The search is counted by the server (the map and the boxes listed); a
// box shows its pods the search matches. Click a card → the detail window on Logs; right click → the menu.

interface Props {
  entries: NodeEntry[]
  matched: number
  all: number
  isLoading: boolean
  canDeletePod: boolean
}

const SUBSCRIBE_AFTER_MS = 150 // a box scrolled past does not open a watch

export function PodNodeGrid({ entries, matched, all, isLoading, canDeletePod }: Props) {
  const { tr, searchQuery } = useClusterView()

  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect(() => {
    setScrollMargin(listRef.current?.offsetTop ?? 0)
  }, [searchQuery, entries.length])
  const virtualizer = useWindowVirtualizer({
    count: entries.length,
    // header and padding, then one row of cards per six pods (the server's count); the drawn box is measured
    estimateSize: (i) => 120 + Math.ceil(entries[i].counts.total / 6) * 144,
    overscan: 3,
    scrollMargin,
    getItemKey: (i) => entries[i].node || '~unscheduled',
  })

  return (
    <div className="space-y-6">
      <ClusterNodeMap entries={entries} tr={tr} onSelect={(i) => virtualizer.scrollToIndex(i, { align: 'start' })} />

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
        <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }} data-testid="cluster-view-nodes">
          {virtualizer.getVirtualItems().map((row) => (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className={`absolute left-0 top-0 w-full ${row.index < entries.length - 1 ? 'pb-6' : ''}`}
              style={{ transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }}
            >
              <NodeBox entry={entries[row.index]} canDeletePod={canDeletePod} />
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
    </div>
  )
}

function NodeBox({ entry, canDeletePod }: { entry: NodeEntry; canDeletePod: boolean }) {
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
    return q ? list.filter((pod) => pod.name.toLowerCase().includes(q) || pod.namespace.toLowerCase().includes(q)) : list
  }, [pods, q])

  const handlePodClick = (pod: any) => {
    const detail = podToDetail(pod)
    setSelectedPod(detail)
    setSelectedContainer(pickMainContainer(pod))
    setContainerSearchQuery('')
    selectTab('logs')
  }

  const handlePodContextMenu = (event: React.MouseEvent, pod: PodInfo) => {
    if (!canDeletePod) return
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
                <div className="text-xs text-slate-400 mt-1">{pod.namespace}</div>
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
