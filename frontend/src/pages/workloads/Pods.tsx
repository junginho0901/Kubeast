import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { CheckCircle, ChevronDown, RefreshCw, Search } from 'lucide-react'

export default function Pods() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedNamespace, setSelectedNamespace] = useState<string>('all')
  const [isNamespaceDropdownOpen, setIsNamespaceDropdownOpen] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const namespaceDropdownRef = useRef<HTMLDivElement>(null)

  const { data: namespaces } = useQuery({
    queryKey: ['namespaces'],
    queryFn: () => api.getNamespaces(),
  })

  const { data: pods } = useQuery({
    queryKey: ['workloads', 'pods', selectedNamespace],
    queryFn: () => {
      if (selectedNamespace === 'all') {
        return api.getAllPods(false)
      }
      return api.getPods(selectedNamespace, undefined, false)
    },
  })

  useEffect(() => {
    if (!isNamespaceDropdownOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (namespaceDropdownRef.current && !namespaceDropdownRef.current.contains(event.target as Node)) {
        setIsNamespaceDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isNamespaceDropdownOpen])

  const filterBySearch = (items: any[] | undefined | null) => {
    if (!Array.isArray(items)) return []
    if (!searchQuery.trim()) return items
    const q = searchQuery.toLowerCase()
    return items.filter((item) =>
      typeof item.name === 'string' && item.name.toLowerCase().includes(q)
    )
  }

  const filteredPods = useMemo(() => filterBySearch(pods), [pods, searchQuery])

  const formatAge = (iso?: string | null) => {
    if (!iso) return '-'
    const createdAt = new Date(iso)
    const createdMs = createdAt.getTime()
    if (Number.isNaN(createdMs)) return '-'

    const diffSec = Math.max(0, Math.floor((Date.now() - createdMs) / 1000))
    const days = Math.floor(diffSec / 86400)
    const hours = Math.floor((diffSec % 86400) / 3600)
    const minutes = Math.floor((diffSec % 3600) / 60)

    if (days > 0) return `${days}d ${hours}h`
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  const getStatusColor = (status: string) => {
    const statusLower = status.toLowerCase()
    if (statusLower.includes('running') || statusLower.includes('healthy') || statusLower.includes('active')) {
      return 'badge-success'
    }
    if (statusLower.includes('pending') || statusLower.includes('degraded')) {
      return 'badge-warning'
    }
    if (statusLower.includes('failed') || statusLower.includes('unavailable') || statusLower.includes('error')) {
      return 'badge-error'
    }
    return 'badge-info'
  }

  const getPodReason = (pod: any) => {
    const phase = (pod?.phase || '').toString()
    if (phase && phase !== 'Running') return phase

    const ready = (pod?.ready || '').toString()
    const m = ready.match(/^(\d+)\/(\d+)$/)
    const isNotReady = (() => {
      if (!m) return false
      const a = Number(m[1])
      const b = Number(m[2])
      if (Number.isNaN(a) || Number.isNaN(b) || b <= 0) return false
      return a !== b
    })()

    const containers = Array.isArray(pod?.containers) ? pod.containers : []
    const reasons: string[] = []

    for (const c of containers) {
      const waitingReason = c?.state?.waiting?.reason
      if (waitingReason) reasons.push(String(waitingReason))
    }
    for (const c of containers) {
      const terminatedReason = c?.state?.terminated?.reason || c?.last_state?.terminated?.reason
      if (terminatedReason) reasons.push(String(terminatedReason))
    }

    if (reasons.length > 0) {
      const priority = [
        'ImagePullBackOff',
        'ErrImagePull',
        'CrashLoopBackOff',
        'CreateContainerConfigError',
        'CreateContainerError',
        'RunContainerError',
        'OOMKilled',
        'Error',
        'ContainerCreating',
        'PodInitializing',
      ]
      const best = reasons
        .slice()
        .sort((a, b) => {
          const ai = priority.indexOf(a)
          const bi = priority.indexOf(b)
          const aa = ai === -1 ? 999 : ai
          const bb = bi === -1 ? 999 : bi
          if (aa !== bb) return aa - bb
          return a.localeCompare(b)
        })[0]
      return best || 'Unknown'
    }

    if (isNotReady) return 'NotReady'
    return 'Running'
  }

  const podTopSummary = useMemo(() => {
    const list = Array.isArray(filteredPods) ? filteredPods : []
    if (list.length === 0) return { total: 0, topReasons: [] as Array<[string, number]>, phaseSummary: '' }

    const reasonCounts = new Map<string, number>()
    const phaseCounts = new Map<string, number>()

    for (const pod of list) {
      const reason = getPodReason(pod)
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1)

      const phase = (pod?.phase || pod?.status || 'Unknown').toString()
      phaseCounts.set(phase, (phaseCounts.get(phase) || 0) + 1)
    }

    const topReasons = Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)

    const phaseSummary = Array.from(phaseCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k}:${v}`)
      .join(' · ')

    return { total: list.length, topReasons, phaseSummary }
  }, [filteredPods])

  const handleRefresh = async () => {
    if (isRefreshing) return
    setIsRefreshing(true)
    try {
      let data: any[] = []
      if (selectedNamespace === 'all') {
        data = await api.getAllPods(true)
      } else {
        data = await api.getPods(selectedNamespace, undefined, true)
      }
      queryClient.removeQueries({ queryKey: ['workloads', 'pods', selectedNamespace] })
      queryClient.setQueryData(['workloads', 'pods', selectedNamespace], data)
    } catch (error) {
      console.error('Pods refresh failed:', error)
    }
    setTimeout(() => setIsRefreshing(false), 500)
  }

  const showNamespaceColumn = selectedNamespace === 'all'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">{t('pods.title')}</h1>
          <p className="mt-2 text-slate-400">{t('pods.subtitle')}</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          title={t('pods.forceRefreshTitle')}
          className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          {t('pods.refresh')}
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="xl:col-span-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder={t('pods.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="relative" ref={namespaceDropdownRef}>
          <button
            type="button"
            onClick={() => setIsNamespaceDropdownOpen(!isNamespaceDropdownOpen)}
            className="w-full py-3 px-3 bg-slate-700 border border-slate-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent flex items-center justify-between gap-2"
          >
            <span className="text-sm font-medium">
              {selectedNamespace === 'all' ? t('pods.allNamespaces') : selectedNamespace}
            </span>
            <ChevronDown
              className={`w-4 h-4 text-slate-400 transition-transform ${isNamespaceDropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {isNamespaceDropdownOpen && (
            <div className="absolute top-full left-0 mt-2 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl z-[100] max-h-[240px] overflow-y-auto">
              <button
                type="button"
                onClick={() => {
                  setSelectedNamespace('all')
                  setIsNamespaceDropdownOpen(false)
                }}
                className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 first:rounded-t-lg"
              >
                {selectedNamespace === 'all' && (
                  <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                )}
                <span className={selectedNamespace === 'all' ? 'font-medium' : ''}>{t('pods.allNamespaces')}</span>
              </button>
              {(namespaces || []).map((ns) => (
                <button
                  key={ns.name}
                  type="button"
                  onClick={() => {
                    setSelectedNamespace(ns.name)
                    setIsNamespaceDropdownOpen(false)
                  }}
                  className="w-full px-4 py-2.5 text-left text-sm text-white hover:bg-slate-600 transition-colors flex items-center gap-2 last:rounded-b-lg"
                >
                  {selectedNamespace === ns.name && (
                    <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                  )}
                  <span className={selectedNamespace === ns.name ? 'font-medium' : ''}>{ns.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {searchQuery && (
        <p className="text-sm text-slate-400">
          {t('pods.matchCount', { count: filteredPods.length, suffix: filteredPods.length === 1 ? '' : 's' })}
        </p>
      )}

      {podTopSummary.total > 0 && searchQuery && (
        <div className="bg-slate-900/40 border border-slate-700 rounded-lg p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm text-white font-semibold">{t('pods.topReasonTitle')}</div>
            <div className="text-xs text-slate-400">{t('pods.podsCount', { count: podTopSummary.total })}</div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {podTopSummary.topReasons.map(([reason, count]) => (
              <span
                key={reason}
                className={`badge font-mono ${
                  reason === 'Running' ? 'badge-success' : reason === 'NotReady' ? 'badge-warning' : 'badge-warning'
                }`}
                title={reason}
              >
                {reason}:{count}
              </span>
            ))}
          </div>
          {podTopSummary.phaseSummary && (
            <div className="mt-2 text-xs text-slate-500 font-mono">phase: {podTopSummary.phaseSummary}</div>
          )}
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[980px]">
          <thead className="text-slate-400">
            <tr>
              {showNamespaceColumn && <th className="text-left py-3 px-4">{t('pods.table.namespace')}</th>}
              <th className="text-left py-3 px-4">{t('pods.table.name')}</th>
              <th className="text-left py-3 px-4">{t('pods.table.ready')}</th>
              <th className="text-left py-3 px-4">{t('pods.table.status')}</th>
              <th className="text-left py-3 px-4">{t('pods.table.restarts')}</th>
              <th className="text-left py-3 px-4">{t('pods.table.age')}</th>
              <th className="text-left py-3 px-4">{t('pods.table.node')}</th>
              <th className="text-left py-3 px-4">{t('pods.table.podIp')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {filteredPods.map((pod) => (
              <tr key={`${pod.namespace}-${pod.name}`} className="text-slate-200">
                {showNamespaceColumn && (
                  <td className="py-3 px-4 font-mono text-xs">{pod.namespace}</td>
                )}
                <td className="py-3 px-4 font-medium text-white">{pod.name}</td>
                <td className="py-3 px-4">{pod.ready || '-'}</td>
                <td className="py-3 px-4">
                  <span className={`badge ${getStatusColor(pod.status || pod.phase || 'Unknown')}`}>
                    {pod.status || pod.phase || 'Unknown'}
                  </span>
                </td>
                <td className="py-3 px-4">{pod.restart_count ?? 0}</td>
                <td className="py-3 px-4 font-mono text-xs">{formatAge(pod.created_at)}</td>
                <td className="py-3 px-4 text-xs font-mono">{pod.node_name || '-'}</td>
                <td className="py-3 px-4 text-xs font-mono">{pod.pod_ip || '-'}</td>
              </tr>
            ))}
            {filteredPods.length === 0 && (
              <tr>
                <td colSpan={showNamespaceColumn ? 8 : 7} className="py-6 px-4 text-slate-400">
                  {t('pods.noResults')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
