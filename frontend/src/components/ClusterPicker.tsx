import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Server, Check } from 'lucide-react'

import { clustersApi, type ClusterMeta } from '@/services/api/clusters'
import { useCluster } from '@/contexts/ClusterContext'

// Sidebar cluster picker (step 11). Lists only the clusters the user can access
// (accessibleOnly — step 08 filter); selecting one drives ClusterContext, which
// updates ?cluster= and clears cluster-scoped caches (steps 09/10). With no
// accessible cluster it shows guidance; with one it just shows the label.

function healthDotClass(status: string | undefined): string {
  if (status === 'healthy') return 'bg-green-500'
  if (status === 'unhealthy' || status === 'disconnected') return 'bg-red-500'
  return 'bg-slate-500'
}

export default function ClusterPicker() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const { currentCluster, setCurrentCluster } = useCluster()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const { data: clusters = [], isLoading } = useQuery({
    queryKey: ['clusters-accessible'],
    queryFn: () => clustersApi.listClusters(true),
    staleTime: 30_000,
  })

  // Reconcile the selection with what THIS user can access. Besides the initial
  // auto-select, this corrects a selection left over from a previous login: a
  // cluster the current user can't access (or any stale id) must not stay
  // selected, or the axios interceptor keeps sending ?cluster=<it> and the
  // server now 403s every read. Prefer the canonical default (id "default", the
  // server's fallback) over registry order. With no accessible cluster, clear
  // the selection so no ?cluster= is sent at all.
  useEffect(() => {
    if (isLoading) return
    if (clusters.length === 0) {
      if (currentCluster) setCurrentCluster('')
      return
    }
    const accessible = clusters.some((c) => c.id === currentCluster)
    if (!currentCluster || !accessible) {
      const preferred = clusters.find((c) => c.id === 'default') ?? clusters[0]
      if (preferred.id !== currentCluster) setCurrentCluster(preferred.id)
    }
  }, [currentCluster, clusters, isLoading, setCurrentCluster])

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const selected: ClusterMeta | undefined = clusters.find((c) => c.id === currentCluster)

  if (!isLoading && clusters.length === 0) {
    return (
      <div className="px-4 py-2 text-xs text-slate-400">
        {tr('cluster.picker.none', 'No accessible cluster')}
      </div>
    )
  }

  return (
    <div ref={ref} className="relative px-4 py-3 border-b border-slate-700">
      <button
        type="button"
        data-testid="cluster-picker"
        onClick={() => setOpen((v) => !v)}
        disabled={clusters.length <= 1}
        className="w-full flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-left hover:bg-slate-700/30 disabled:cursor-default disabled:hover:bg-slate-900/40"
        title={tr('cluster.picker.label', 'Cluster')}
      >
        <Server className="w-4 h-4 text-slate-400 shrink-0" />
        <span className={`w-2 h-2 rounded-full shrink-0 ${healthDotClass(selected?.health_status)}`} />
        <span className="flex-1 truncate text-sm text-white">
          {selected?.display_name ?? currentCluster ?? tr('cluster.picker.select', 'Select cluster')}
        </span>
        {selected?.is_self_cluster && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 shrink-0">
            self
          </span>
        )}
        {clusters.length > 1 && <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />}
      </button>

      {open && (
        <div className="absolute left-4 right-4 z-30 mt-1 max-h-72 overflow-auto rounded-lg border border-slate-700 bg-slate-800 py-1 shadow-xl">
          {clusters.map((c) => (
            <button
              key={c.id}
              type="button"
              data-testid={`cluster-option-${c.id}`}
              onClick={() => {
                setCurrentCluster(c.id)
                setOpen(false)
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-700/50"
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${healthDotClass(c.health_status)}`} />
              <span className="flex-1 truncate text-white">{c.display_name}</span>
              {c.is_self_cluster && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">self</span>
              )}
              {c.id === currentCluster && <Check className="w-4 h-4 text-primary-400 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
